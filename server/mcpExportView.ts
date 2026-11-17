import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Kit } from './mcpKit';
import { atomicWrite, type Store } from './store';
import { pickDrawing } from './mcpDrawing';
import { findView } from '../src/core/savedViews';
import { parseScale, drawingToPdf } from '../src/core/pdfDrawing';
import { composeSheet, placeShapes, placedToSvg, sheetLayout, cutListLines, isStdView, type Shape } from '../src/core/viewSheet';
import { drawingShapes, planShapes, PLAN_KEYS, PLAN_TITLES, type PlanViewKey } from '../src/core/viewShapes';
import { cutList } from '../src/core/nesting';
import type { Project } from '../src/core/types';

/**
 * Exportar vistas por MCP. SIN navegador se generan en el servidor los archivos VECTORIALES (SVG y PDF) de los planos acotados
 * (frente, planta, lado), de un dibujo 2D y de la lámina combinada. Todo lo que necesita el render 3D o píxeles (PNG/JPG, vistas
 * 3D) lo hace la app abierta: el agente deja un pedido en <datos>/export/pedidos.json (request_view_export) y la app lo procesa y guarda el archivo en export/.
 * Motivo: no hay render 3D ni rasterizador sin dependencias pesadas o nativas (WebGL/gl/canvas); ver docs/mcp.md.
 */

const safeName = (s: string): string => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 80) || 'vista';
const today = (): string => new Date().toISOString().slice(0, 10);

export const VIEW_CHOICES = ['iso', 'front', 'back', 'left', 'right', 'top', 'persp', 'side', 'sheet', 'drawing'] as const;
export type ViewChoice = (typeof VIEW_CHOICES)[number];

const planKeyOf = (v: string): PlanViewKey | null => (v === 'front' ? 'front' : v === 'top' ? 'top' : v === 'right' || v === 'side' ? 'side' : null);

export interface ExportRequest {
  view?: ViewChoice;
  /** Nombre de una vista guardada del proyecto (reemplaza a `view`). */
  saved?: string;
  drawing?: string;
  format?: 'png' | 'jpg' | 'pdf' | 'svg';
  width?: number;
  height?: number;
  background?: string;
  name?: string;
  paper?: 'A4' | 'A3' | 'A2' | 'A1' | 'A0';
  orientation?: 'landscape' | 'portrait';
  scale?: string | number;
  grid?: boolean;
  labels?: boolean;
  titleBlock?: { titulo?: string; autor?: string; fecha?: string };
  /** Lámina: vistas que lleva (por omisión frente, planta y lado) y si se adjunta la lista de piezas. */
  includeCutlist?: boolean;
}

export interface ExportOrder { id: string; status: 'pending' | 'processing' | 'done' | 'error'; created: string; request: ExportRequest; file?: string; bytes?: number; error?: string; finished?: string }

/** ¿Se puede generar en el servidor, sin navegador? (vectorial: planos, dibujo 2D y lámina, en SVG o PDF.) */
export function serverCanRender(r: ExportRequest): boolean {
  const fmt = r.format ?? 'pdf';
  if (fmt !== 'pdf' && fmt !== 'svg') return false;
  if (r.saved) return false;
  const v = r.view ?? 'sheet';
  if (v === 'sheet') return fmt === 'pdf';
  if (v === 'drawing') return true;
  return planKeyOf(v) !== null;
}

function titleBlockOf(r: ExportRequest, fallback: string) {
  return { titulo: r.titleBlock?.titulo ?? fallback, autor: r.titleBlock?.autor, fecha: r.titleBlock?.fecha ?? today() };
}

/** Genera el archivo vectorial pedido (lanza si el servidor no puede). */
export function renderVector(project: Project, r: ExportRequest): { name: string; bytes: Uint8Array | string; mime: string; note: string } {
  if (!serverCanRender(r)) throw new Error('Esta vista necesita la app abierta (vistas 3D, PNG/JPG y vistas guardadas): usa request_view_export.');
  const fmt = r.format ?? 'pdf';
  const v = r.view ?? 'sheet';
  const base = safeName(r.name ?? `${project.name}-${v}`);
  const orientation = r.orientation ?? 'landscape';
  const scale: number | 'fit' = (r.scale !== undefined ? parseScale(r.scale) : 'fit') ?? 'fit';
  const sc = scale;

  if (v === 'drawing') {
    const d = pickDrawing(project, r.drawing);
    if (fmt === 'pdf') {
      return { name: `${base}.pdf`, mime: 'application/pdf', note: 'PDF vectorial del dibujo.', bytes: drawingToPdf(d, { ...(r.paper ? { paper: r.paper } : {}), orientation, ...(scale !== 'fit' ? { scale } : {}), titleBlock: titleBlockOf(r, d.name) }) };
    }
    const shapes = drawingShapes(d);
    return { name: `${base}.svg`, mime: 'image/svg+xml', note: 'SVG del dibujo.', bytes: svgOf(shapes, r, sc) };
  }
  if (v === 'sheet') {
    const cells = PLAN_KEYS.map((k) => ({ title: PLAN_TITLES[k].split(' (')[0], content: { kind: 'shapes' as const, shapes: planShapes(project, k), scale: sc } })).filter((c) => c.content.shapes.length);
    if (!cells.length) throw new Error('No hay piezas para dibujar los planos de la lámina.');
    if (r.drawing) { const d = pickDrawing(project, r.drawing); if (cells.length < 4) cells.push({ title: d.name, content: { kind: 'shapes' as const, shapes: drawingShapes(d), scale: sc } }); }
    const notes = r.includeCutlist ? { title: 'Lista de piezas', lines: cutListLines(cutList(project), (id) => project.materials.find((m) => m.id === id)?.name ?? id) } : undefined;
    const res = composeSheet({ paper: r.paper ?? 'A3', orientation, title: project.name, titleBlock: titleBlockOf(r, project.name), cells, notes });
    return { name: `${base}.pdf`, mime: 'application/pdf', note: `Lámina de ${cells.length} vistas (${res.scales.join(', ')}), ${res.pages} página(s).`, bytes: res.pdf };
  }
  const key = planKeyOf(v)!;
  const shapes = planShapes(project, key);
  if (!shapes.length) throw new Error('No hay piezas para dibujar el plano.');
  if (fmt === 'svg') return { name: `${base}.svg`, mime: 'image/svg+xml', note: `SVG del plano: ${PLAN_TITLES[key]}.`, bytes: svgOf(shapes, r, sc) };
  const res = composeSheet({ paper: r.paper ?? 'A3', orientation, title: `${project.name} - ${PLAN_TITLES[key]}`, titleBlock: titleBlockOf(r, project.name), cells: [{ title: PLAN_TITLES[key], content: { kind: 'shapes', shapes, scale: sc } }] });
  return { name: `${base}.pdf`, mime: 'application/pdf', note: `PDF vectorial, escala ${res.scales[0]}.`, bytes: res.pdf };
}

function svgOf(shapes: Shape[], r: ExportRequest, scale: number | 'fit'): string {
  const lay = sheetLayout({ paper: r.paper ?? 'A3', orientation: r.orientation ?? 'landscape', titleBlock: false, count: 1 });
  const placed = placeShapes(shapes, lay.area, scale);
  const bg = !r.background || r.background === 'transparent' ? null : r.background === 'white' ? '#ffffff' : r.background;
  const px = r.width ? { w: Math.round(r.width), h: Math.round(r.height ?? (r.width * lay.paper.h) / lay.paper.w) } : undefined;
  return placedToSvg(placed.shapes, lay.paper.w, lay.paper.h, { bg, px });
}

// ---------------------------------------------------------------- pedidos para la app abierta

export function createOrders(dataDir: string) {
  const dir = path.join(dataDir, 'export');
  const file = path.join(dir, 'pedidos.json');
  const read = (): ExportOrder[] => { try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(o.items) ? o.items : []; } catch { return []; } };
  const write = (items: ExportOrder[]): void => { fs.mkdirSync(dir, { recursive: true }); atomicWrite(file, JSON.stringify({ version: 1, items }, null, 2)); };
  return {
    file, read,
    /** Agrega un pedido pendiente (se conservan los últimos 50). */
    enqueue(request: ExportRequest): ExportOrder {
      const order: ExportOrder = { id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, status: 'pending', created: new Date().toISOString(), request };
      write([...read(), order].slice(-50));
      return order;
    },
  };
}

export function registerExportViewTools(kit: Kit, store: Store, dataDir: string): void {
  const orders = createOrders(dataDir);
  const shape = {
    view: z.enum(VIEW_CHOICES).optional().describe("iso, front, back, left, right, top, persp (3D), sheet (lámina de planos), drawing (dibujo 2D). 'side' = lado derecho. Por omisión sheet."),
    saved: z.string().optional().describe('Nombre o id de una vista guardada del proyecto (cámara 3D o encuadre 2D); necesita la app abierta'),
    drawing: z.string().optional().describe('Id o nombre del dibujo 2D (view=drawing; en la lámina se añade como 4ª vista)'),
    format: z.enum(['png', 'jpg', 'pdf', 'svg']).optional().describe('pdf por omisión. PNG/JPG necesitan la app abierta'),
    width: z.number().int().positive().max(8192).optional().describe('Ancho en píxeles (imágenes) o del SVG'),
    height: z.number().int().positive().max(8192).optional(),
    background: z.string().optional().describe('"transparent" (solo PNG/SVG), "white" o un color "#rrggbb"'),
    name: z.string().optional().describe('Nombre del archivo (sin extensión)'),
    paper: z.enum(['A4', 'A3', 'A2', 'A1', 'A0']).optional(),
    orientation: z.enum(['landscape', 'portrait']).optional(),
    scale: z.union([z.string(), z.number().positive()]).optional().describe('"fit" (omisión), "1:20" o un número (0.05 = 1:20)'),
    grid: z.boolean().optional().describe('Cuadrícula del suelo en las vistas 3D (app)'),
    labels: z.boolean().optional().describe('Cotas y etiquetas en las vistas 3D (app)'),
    titleBlock: z.object({ titulo: z.string().optional(), autor: z.string().optional(), fecha: z.string().optional() }).optional(),
    includeCutlist: z.boolean().optional().describe('Lámina: adjunta la lista de piezas en páginas aparte'),
  };
  const validate = (a: ExportRequest, project: Project): void => {
    if (a.view && (isStdView(a.view) || a.view === 'side') === false && a.view !== 'sheet' && a.view !== 'drawing') throw new Error(`Vista "${a.view}" no existe.`);
    if (a.saved && !findView(project, a.saved)) throw new Error(`No existe la vista guardada "${a.saved}". Vistas: ${(project.views ?? []).map((v) => v.name).join(', ') || '(ninguna)'}.`);
    if (a.scale !== undefined) parseScale(a.scale);
    if (a.background === 'transparent' && (a.format === 'jpg' || a.format === 'pdf')) throw new Error('El fondo transparente solo existe en PNG y SVG.');
  };

  kit.files('save_view',
    'Guarda una vista del diseño en export/ de la carpeta de datos. SIN la app abierta genera planos y láminas VECTORIALES: view=front|top|right (plano acotado), view=sheet (lámina PDF con frente, planta y lado, cajetín y escala; includeCutlist añade la lista de piezas) y view=drawing (dibujo 2D), en format pdf o svg. Las vistas 3D (iso, persp…), PNG/JPG y vistas guardadas NO se pueden dibujar sin navegador: en ese caso deja un pedido en export/pedidos.json que la app abierta (pestaña 3D) procesa y guarda; consulta el resultado con list_view_exports. EN: export a view; vector plans/sheets render server-side, 3D/raster are queued for the open app.',
    shape,
    (a) => {
      const project = store.readProject().project;
      validate(a, project);
      if (serverCanRender(a)) {
        const out = renderVector(project, a);
        const dir = path.join(dataDir, 'export');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, out.name);
        fs.writeFileSync(file, out.bytes);
        return { rendered: true, file, note: out.note };
      }
      const order = orders.enqueue(a);
      return { rendered: false, queued: true, order: order.id, ordersFile: orders.file, note: 'No se puede generar sin la app: se dejó el pedido. Abre MuebleCAD (o npm run dev); la app lo procesa en unos segundos y guarda el archivo en export/. Revisa el estado con list_view_exports.' };
    });

  kit.files('request_view_export',
    'Pide a la app abierta que exporte una vista 3D (iso, front, back, left, right, top, persp), una vista guardada o cualquier vista como PNG/JPG/PDF a la resolución indicada. Deja el pedido en export/pedidos.json (la app lo detecta por eventos y escribe el archivo en export/). Si la app no está abierta el pedido queda pendiente hasta que se abra. EN: queue an export for the open app (needs the app).',
    shape,
    (a) => {
      validate(a, store.readProject().project);
      const order = orders.enqueue({ view: 'iso', format: 'png', ...a });
      return { queued: true, order: order.id, ordersFile: orders.file, note: 'Pedido en cola. La app abierta lo procesa y guarda el archivo en export/; usa list_view_exports para ver el estado.' };
    });

  kit.read('list_view_exports', 'Pedidos de exportación de vistas (export/pedidos.json) con su estado: pending, processing, done (con la ruta del archivo) o error. EN: status of queued view exports.', {}, () => orders.read());
}
