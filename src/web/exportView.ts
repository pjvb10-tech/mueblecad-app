import { entitiesBounds } from '../core/geom2d';
import { drawingToPdf, parseScale, PAPER_MM, type PdfOptions } from '../core/pdfDrawing';
import { cutList } from '../core/nesting';
import type { Drawing, Part, Project, SavedView } from '../core/types';
import { buildSheet, composeSheet, cutListLines, exportSize, imagePdf, isStdView, jpegToPdfImage, sheetSvg, STD_VIEWS, type SheetCell, type StdView } from '../core/viewSheet';
import { blockCtx } from '../core/blocks';
import { drawingShapes, planShapes, PLAN_KEYS, PLAN_TITLES } from '../core/viewShapes';
import { contentTransform, entityShapeSvg, entityStyle, entityVisible, esc, type StyleOpts } from './drawingRender';
import type { DrawingsUi } from './drawingUi';
import type { Viewer } from './viewer';

/**
 * Exportar una vista del diseño como imagen o PDF desde el navegador: 3D del visor (PNG/JPG/PDF con imagen incrustada), dibujo 2D activo
 * (PNG/JPG/SVG/PDF) y hoja de planos o lámina combinada (PDF/PNG/JPG/SVG). Lo puro (tamaños, cajetín, composición, PDF) está en src/core/viewSheet.ts.
 */

export type Format = 'png' | 'jpg' | 'svg' | 'pdf';
export type Source = '3d' | '2d' | 'sheet';
export type SheetPart = '3d' | 'front' | 'top' | 'side' | 'draw';

export interface ExportOpts {
  source: Source;
  format: Format;
  // 3D
  view: 'current' | StdView;
  proj: 'auto' | 'persp' | 'ortho';
  res: '1' | '2' | '4' | 'custom';
  cw: number;
  ch: number;
  bg: 'viewer' | 'white' | 'transparent' | 'color';
  color: string;
  grid: boolean;
  labels: boolean;
  // 2D
  area: 'all' | 'window' | 'selection';
  px: number;
  mono: boolean;
  // PDF y lámina
  paper: string;
  orientation: 'landscape' | 'portrait';
  scale: string;
  tb: boolean;
  titulo: string;
  autor: string;
  fecha: string;
  parts: SheetPart[];
  cutlist: boolean;
}

export const defaultOpts = (): ExportOpts => ({
  source: '3d', format: 'png', view: 'current', proj: 'auto', res: '2', cw: 0, ch: 0, bg: 'white', color: '#ffffff', grid: false, labels: false,
  area: 'all', px: 2400, mono: false, paper: 'A3', orientation: 'landscape', scale: 'fit', tb: true, titulo: '', autor: '', fecha: new Date().toISOString().slice(0, 10),
  parts: ['3d', 'front', 'top', 'side'], cutlist: false,
});

export const FORMATS_BY_SOURCE: Record<Source, Format[]> = { '3d': ['png', 'jpg', 'pdf'], '2d': ['png', 'jpg', 'svg', 'pdf'], sheet: ['pdf', 'png', 'jpg', 'svg'] };

export interface ExportEnv {
  viewer: Viewer;
  project(): Project;
  isHidden(p: Part): boolean;
  drawings: DrawingsUi;
}

export interface ExportResult { name: string; mime: string; data: Blob; info: string }

const safeName = (s: string): string => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 80) || 'vista';
export const MIME: Record<Format, string> = { png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', pdf: 'application/pdf' };

// ---------------------------------------------------------------- utilidades de imagen

function canvasBlob(c: HTMLCanvasElement, format: 'png' | 'jpg'): Promise<Blob> {
  let src = c;
  if (format === 'jpg') { // el JPEG no tiene transparencia: se compone sobre blanco
    src = document.createElement('canvas');
    src.width = c.width; src.height = c.height;
    const g = src.getContext('2d')!;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, src.width, src.height); g.drawImage(c, 0, 0);
  }
  return new Promise((res, rej) => src.toBlob((b) => (b ? res(b) : rej(new Error('El navegador no pudo codificar la imagen (¿tamaño demasiado grande?).'))), format === 'png' ? 'image/png' : 'image/jpeg', 0.92));
}

/** Rasteriza un SVG (cadena) a un canvas de `w × h` px. */
export function rasterizeSvg(svg: string, w: number, h: number): Promise<HTMLCanvasElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d')!.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      res(c);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se pudo rasterizar el SVG (¿tamaño demasiado grande?).')); };
    img.src = url;
  });
}

const textBlob = (s: string, mime: string): Blob => new Blob([s], { type: mime });
const bytesBlob = (b: Uint8Array, mime: string): Blob => new Blob([b as BlobPart], { type: mime });

// ---------------------------------------------------------------- 3D

/** Proporción base del visor; si está oculto (modo 2D, otra pestaña) se usa 16:10. */
function baseSize(env: ExportEnv): { w: number; h: number } {
  const s = env.viewer.viewSize();
  return s.w < 50 || s.h < 50 ? { w: 1600, h: 1000 } : s;
}

export interface Render3d { view: ExportOpts['view']; proj: ExportOpts['proj']; w: number; h: number; bg: string | null; grid: boolean; labels: boolean }

/** Dibuja el 3D con la vista pedida a `w × h` px. */
export function render3d(env: ExportEnv, r: Render3d, saved?: { position: [number, number, number]; target: [number, number, number]; ortho?: boolean }): HTMLCanvasElement {
  let position, target, ortho = r.proj === 'ortho';
  if (saved) { position = saved.position; target = saved.target; ortho = r.proj === 'auto' ? !!saved.ortho : ortho; }
  else if (r.view !== 'current') {
    const sv = STD_VIEWS[r.view];
    const fr = env.viewer.framing(sv.dir, r.w / r.h);
    position = fr.position; target = fr.target;
    ortho = r.proj === 'auto' ? sv.ortho : r.proj === 'ortho';
  }
  return env.viewer.exportRender({ w: r.w, h: r.h, position, target, ortho, background: r.bg, grid: r.grid, labels: r.labels });
}

const bgColor = (o: ExportOpts, transparentOk: boolean): string | null =>
  o.bg === 'transparent' ? (transparentOk ? null : '#ffffff') : o.bg === 'white' ? '#ffffff' : o.bg === 'color' ? o.color : '#eef1f5';

async function jpegBytes(c: HTMLCanvasElement): Promise<Uint8Array> {
  return new Uint8Array(await (await canvasBlob(c, 'jpg')).arrayBuffer());
}

// ---------------------------------------------------------------- 2D

function pdfOptions(o: ExportOpts, d: Drawing): PdfOptions {
  return {
    paper: o.paper as PdfOptions['paper'], orientation: o.orientation, scale: parseScale(o.scale.trim() || 'fit'), colors: o.mono ? 'mono' : 'layer', title: o.titulo || d.name,
    ...(o.tb ? { titleBlock: { titulo: o.titulo || d.name, autor: o.autor || undefined, fecha: o.fecha || new Date().toISOString().slice(0, 10) } } : {}),
  };
}

/** SVG del dibujo activo para el área pedida (todo, ventana actual o selección) con `px` px de ancho. Los grosores crecen con la resolución. */
export function drawingSvg(env: ExportEnv, o: ExportOpts, bg: string | null): { svg: string; w: number; h: number } {
  const d = env.drawings.realDrawing();
  if (!d) throw new Error('No hay un dibujo 2D activo para exportar.');
  const cv = env.drawings.view.currentView;
  const sel = o.area === 'selection' ? new Set(env.drawings.view.selectedIds()) : null;
  if (sel && env.drawings.editingBlock()) throw new Error('Estás editando un bloque: sal de la edición del bloque para exportar la selección del dibujo.');
  if (sel && !sel.size) throw new Error('No hay nada seleccionado en el dibujo: elige entidades o cambia el área.');
  const list = d.entities.filter((e) => entityVisible(d, e) && (!sel || sel.has(e.id)));
  const W = Math.round(o.px);
  let H: number, S: number, cx: number, cy: number, f: number;
  if (o.area === 'window') {
    H = Math.round((W * cv.h) / cv.w); S = (cv.scale * W) / cv.w; cx = cv.cx; cy = cv.cy; f = W / cv.w;
  } else {
    const b = entitiesBounds(list, blockCtx(d));
    if (!b) throw new Error('El dibujo está vacío: no hay nada que exportar.');
    const bw = Math.max(b.max[0] - b.min[0], 1e-6) * 1.08, bh = Math.max(b.max[1] - b.min[1], 1e-6) * 1.08;
    S = W / bw; H = Math.max(50, Math.round(bh * S)); cx = (b.min[0] + b.max[0]) / 2; cy = (b.min[1] + b.max[1]) / 2; f = Math.max(1, W / 1200);
  }
  const body = list.map((e) => {
    const restyle = (st: StyleOpts): StyleOpts => ({ color: o.mono ? '#000000' : st.color, width: (st.width * f) / S, dotWidth: (2.2 * f) / S, dash: st.dash ? st.dash.split(' ').map((n) => (Number(n) * f) / S).join(' ') : '' });
    const style = { ...restyle(entityStyle(d, e)), restyle };
    return entityShapeSvg(e, style, d).replace(/ vector-effect="non-scaling-stroke"/g, '');
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif" stroke-linecap="round">${bg ? `<rect width="${W}" height="${H}" fill="${bg}" />` : ''}<g transform="${contentTransform({ cx, cy, scale: S, w: W, h: H })}">${body}</g></svg>`;
  return { svg, w: W, h: H };
}

// ---------------------------------------------------------------- hoja de planos / lámina

async function sheetCells(env: ExportEnv, o: ExportOpts): Promise<SheetCell[]> {
  const project = env.project();
  if (!o.parts.length) throw new Error('Elige al menos una vista para la lámina.');
  if (o.parts.length > 4) throw new Error('Una lámina lleva como máximo 4 vistas.');
  const cells: SheetCell[] = [];
  for (const p of o.parts) {
    if (p === '3d') {
      const base = baseSize(env);
      const w = 1600, h = Math.round((1600 * base.h) / base.w);
      const view = o.view === 'current' ? 'current' : o.view;
      const c = render3d(env, { view: view === 'current' ? 'iso' : view, proj: o.proj, w, h, bg: '#ffffff', grid: false, labels: false });
      cells.push({ title: STD_VIEWS[view === 'current' ? 'iso' : view].label + ' (3D)', content: { kind: 'image', image: jpegToPdfImage(await jpegBytes(c)) } });
    } else if (p === 'draw') {
      const d = env.drawings.realDrawing();
      if (!d) throw new Error('No hay un dibujo 2D activo para la lámina.');
      cells.push({ title: d.name, content: { kind: 'shapes', shapes: drawingShapes(d, { mono: o.mono }), scale: scaleOf(o) } });
    } else {
      const shapes = planShapes(project, p, env.isHidden);
      if (!shapes.length) throw new Error('No hay piezas para dibujar los planos.');
      cells.push({ title: PLAN_TITLES[p].split(' (')[0], content: { kind: 'shapes', shapes, scale: scaleOf(o) } });
    }
  }
  return cells;
}
const scaleOf = (o: ExportOpts): number | 'fit' => parseScale(o.scale.trim() || 'fit') ?? 'fit';

// ---------------------------------------------------------------- punto de entrada

/** Genera el archivo pedido. Lanza Error con un mensaje en español si algo no se puede (sin selección, sin dibujo, tamaño excesivo...). */
export async function buildExport(env: ExportEnv, o: ExportOpts): Promise<ExportResult> {
  const project = env.project();
  if (!FORMATS_BY_SOURCE[o.source].includes(o.format)) throw new Error(`El formato ${o.format.toUpperCase()} no existe para este origen.`);
  const title = o.titulo.trim() || project.name;
  if (o.source === '3d') {
    const size = exportSize(baseSize(env), { mult: o.res === 'custom' ? undefined : Number(o.res), custom: o.res === 'custom' ? { w: o.cw || undefined, h: o.ch || undefined } : undefined });
    const canvas = render3d(env, { view: o.view, proj: o.proj, w: size.w, h: size.h, bg: bgColor(o, o.format === 'png'), grid: o.grid, labels: o.labels });
    const vname = o.view === 'current' ? 'vista' : o.view;
    const base = safeName(`${title}-${vname}`);
    const note = size.clamped ? ' (tamaño reducido al máximo admitido)' : '';
    if (o.format === 'pdf') {
      const r = imagePdf(jpegToPdfImage(await jpegBytes(canvas)), {
        title, paper: o.paper, orientation: canvas.width >= canvas.height ? 'landscape' : 'portrait', caption: `${title} · ${o.view === 'current' ? 'vista actual' : STD_VIEWS[o.view].label} (3D)`,
        titleBlock: o.tb ? { titulo: title, autor: o.autor || undefined, fecha: o.fecha, escala: 'no aplica (3D)' } : undefined,
      });
      return { name: `${base}.pdf`, mime: MIME.pdf, data: bytesBlob(r.pdf, MIME.pdf), info: `PDF ${o.paper}, imagen de ${size.w}×${size.h} px incrustada${note}.` };
    }
    return { name: `${base}.${o.format}`, mime: MIME[o.format], data: await canvasBlob(canvas, o.format as 'png' | 'jpg'), info: `${o.format.toUpperCase()} ${size.w}×${size.h} px${note}.` };
  }
  if (o.source === '2d') {
    const d = env.drawings.realDrawing();
    if (!d) throw new Error('No hay un dibujo 2D activo para exportar.');
    const base = safeName(d.name);
    if (o.format === 'pdf') {
      const opts = pdfOptions(o, d);
      return { name: `${base}.pdf`, mime: MIME.pdf, data: bytesBlob(drawingToPdf(d, opts), MIME.pdf), info: `PDF vectorial ${o.paper}.` };
    }
    const bg = o.format === 'png' && o.bg === 'transparent' ? null : o.bg === 'color' ? o.color : '#ffffff';
    const s = drawingSvg(env, o, bg);
    if (o.format === 'svg') return { name: `${base}.svg`, mime: MIME.svg, data: textBlob(s.svg, MIME.svg), info: 'SVG del dibujo.' };
    const size = exportSize({ w: s.w, h: s.h });
    const canvas = await rasterizeSvg(size.clamped ? s.svg.replace(/width="\d+" height="\d+"/, `width="${size.w}" height="${size.h}"`) : s.svg, size.w, size.h);
    return { name: `${base}.${o.format}`, mime: MIME[o.format], data: await canvasBlob(canvas, o.format), info: `${o.format.toUpperCase()} ${size.w}×${size.h} px.` };
  }
  // hoja de planos / lámina
  const cells = await sheetCells(env, o);
  const sheetOpts = { paper: o.paper, orientation: o.orientation, title, cells, titleBlock: o.tb ? { titulo: title, autor: o.autor || undefined, fecha: o.fecha } : undefined };
  const base = safeName(`${title}-lamina`);
  if (o.format === 'pdf') {
    const notes = o.cutlist ? { title: `${title}: lista de piezas`, lines: cutListLines(cutList(project), (id) => project.materials.find((m) => m.id === id)?.name ?? id) } : undefined;
    const r = composeSheet({ ...sheetOpts, notes });
    return { name: `${base}.pdf`, mime: MIME.pdf, data: bytesBlob(r.pdf, MIME.pdf), info: `Lámina ${o.paper} con ${cells.length} vista(s) (${r.scales.map((s) => s ?? 'sin escala').join(', ')})${r.pages > 1 ? `, ${r.pages} páginas` : ''}.` };
  }
  const b = buildSheet(sheetOpts);
  const px = exportSize({ w: b.layout.paper.w, h: b.layout.paper.h }, { custom: { w: Math.round(o.px) } });
  const svg = sheetSvg(b, { bg: '#ffffff', px: { w: px.w, h: px.h } });
  if (o.format === 'svg') return { name: `${base}.svg`, mime: MIME.svg, data: textBlob(svg, MIME.svg), info: 'SVG de la lámina.' };
  return { name: `${base}.${o.format}`, mime: MIME[o.format], data: await canvasBlob(await rasterizeSvg(svg, px.w, px.h), o.format), info: `${o.format.toUpperCase()} ${px.w}×${px.h} px.` };
}

// ---------------------------------------------------------------- pedidos del agente (MCP)

/** Pedido que deja el agente en export/pedidos.json (server/mcpExportView.ts). */
export interface OrderRequest {
  view?: string; saved?: string; drawing?: string; format?: Format; width?: number; height?: number; background?: string; name?: string;
  paper?: string; orientation?: 'landscape' | 'portrait'; scale?: string | number; grid?: boolean; labels?: boolean;
  titleBlock?: { titulo?: string; autor?: string; fecha?: string }; includeCutlist?: boolean;
}

/** Traduce un pedido del MCP a opciones del exportador; `savedView` es la vista guardada si el pedido la nombra. */
export function orderToOpts(req: OrderRequest): { opts: ExportOpts; saved: string | null } {
  const o = defaultOpts();
  o.format = req.format ?? 'png';
  if (req.paper) o.paper = req.paper;
  if (req.orientation) o.orientation = req.orientation;
  if (req.scale !== undefined) o.scale = String(req.scale);
  if (req.titleBlock) { o.titulo = req.titleBlock.titulo ?? ''; o.autor = req.titleBlock.autor ?? ''; o.fecha = req.titleBlock.fecha ?? o.fecha; }
  o.grid = !!req.grid; o.labels = !!req.labels;
  if (req.background === 'transparent') o.bg = 'transparent';
  else if (req.background && /^#[0-9a-f]{6}$/i.test(req.background)) { o.bg = 'color'; o.color = req.background; }
  else o.bg = 'white';
  if (req.width || req.height) { o.res = 'custom'; o.cw = req.width ?? 0; o.ch = req.height ?? 0; o.px = req.width ?? o.px; } else o.res = '2';
  const v = req.view === 'side' ? 'right' : req.view;
  if (v === 'sheet') { o.source = 'sheet'; o.cutlist = !!req.includeCutlist; o.parts = ['front', 'top', 'side']; if (req.drawing) o.parts.push('draw'); }
  else if (v === 'drawing') o.source = '2d';
  else { o.source = '3d'; if (v && isStdView(v)) o.view = v; }
  if (req.saved) o.source = '3d';
  return { opts: o, saved: req.saved ?? null };
}

export const viewsOf = (p: Project): SavedView[] => p.views ?? [];
export { PAPER_MM, esc, PLAN_KEYS };
