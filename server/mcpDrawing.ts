import fs from 'node:fs';
import path from 'node:path';
import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import type { Kit } from './mcpKit';
import type { Store } from './store';
import { aciToHex } from '../src/core/aci';
import {
  DrawingError, addEntities, addLayer, copyEntities, createDrawing, effectiveColor, findDrawing, findLayer, getEntity, moveEntities, nextDrawingId,
  offsetEntity, removeEntity, removeLayer, rotateEntities, scaleEntities, setLayer, updateEntity, validateDrawings, withDrawing, withoutDrawing,
  type EntityInput,
} from '../src/core/drawing';
import { drawingToWorld } from '../src/core/drawingPlane';
import { blockCtx, flattenEntities } from '../src/core/blocks';
import { extrudeProfile, partToOutline } from '../src/core/extrude';
import { hatchArea, hatchGeometry, syncAllHatches } from '../src/core/hatch';
import {
  dimGeometry, dimLabel, entitiesBounds, entityBounds, polyArea, polyCentroid, polyLength, polyPerimeter, sweepOf, tessellateArc, tessellatePoly,
  type Bounds,
} from '../src/core/geom2d';
import { nextId } from '../src/core/furniture';
import { normalizePart } from '../src/core/solids';
import { defaultHardware, type Drawing, type Entity, type Project, type Pt2 } from '../src/core/types';

/**
 * Herramientas MCP del dibujo 2D libre (contrato: docs/dibujo-2d.md). Cada herramienta es una entrada de COMMANDS (esquema zod, modo y
 * función sobre el proyecto); se registran una por una y también quedan disponibles por drawing_execute / drawing_list_commands.
 * Las funciones de escritura MUTAN el proyecto recibido: el envoltorio decide si se guarda (updateProject, con respaldo y reintento
 * por rev) o se descarta (dryRun). Antes de guardar siempre se llama a validateDrawings.
 */

// ---------------------------------------------------------------- esquemas

const num = z.number().finite();
const pt = z.tuple([num, num]).describe('[x, y] en mm, en el plano del dibujo (x derecha, y arriba)');
const vec3 = z.tuple([num, num, num]);
const color = z.union([z.number().int().min(1).max(255), z.string().regex(/^#[0-9a-fA-F]{6}$/)]).describe('Color: índice ACI 1..255 o "#rrggbb". Sin color = el de la capa');
const dref = z.string().optional().describe('Id (d1) o nombre del dibujo. Se puede omitir si el proyecto tiene un solo dibujo');
const ids = z.union([z.string(), z.array(z.string()).min(1).max(5000)]).describe('Id de entidad o lista de ids');
const layerName = z.string().min(1).describe('Capa (debe existir; créala con layer_new). Sin capa usa "0"');
const layerFields = {
  color: color.optional(),
  linetype: z.enum(['continuous', 'dashed', 'center']).optional(),
  lineweight: z.number().positive().max(5).optional().describe('Grosor en mm de papel (0 a 5)'),
  on: z.boolean().optional().describe('Visible'),
  frozen: z.boolean().optional().describe('Congelada: no se dibuja ni se edita'),
  locked: z.boolean().optional().describe('Bloqueada: se ve pero no se edita'),
};

interface Command {
  name: string;
  mode: 'read' | 'write' | 'files';
  desc: string;
  shape: ZodRawShape;
  /** `write` muta `project`; `read` y `files` no deben cambiarlo. Los errores se lanzan como Error con mensaje en español. */
  run: (project: Project, args: any, ctx: { store: Store }) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const clean = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** Dibujo pedido (id o nombre; si se omite y hay uno solo, ese). */
export function pickDrawing(project: Project, ref?: string): Drawing {
  const list = project.drawings ?? [];
  if (ref !== undefined) {
    const d = findDrawing(project, ref);
    if (!d) throw new Error(`No existe el dibujo "${ref}". Dibujos: ${list.map((x) => `${x.id} (${x.name})`).join(', ') || '(ninguno; crea uno con new_drawing)'}.`);
    return d;
  }
  if (list.length === 1) return list[0];
  throw new Error(list.length ? `Indica "drawing" (id o nombre): hay ${list.length} dibujos: ${list.map((x) => `${x.id} (${x.name})`).join(', ')}.` : 'El proyecto no tiene dibujos; crea uno con new_drawing.');
}
const put = (project: Project, d: Drawing): void => { project.drawings = withDrawing(project, d).drawings; };

const idList = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);

// ---------------------------------------------------------------- dibujar

const DRAW_COMMON = { drawing: dref, layer: layerName.optional(), color: color.optional() };

function drawCommand(name: string, type: EntityInput['type'], desc: string, fields: ZodRawShape): Command {
  const itemShape = { ...fields, layer: layerName.optional(), color: color.optional() };
  const keys = Object.keys(fields);
  return {
    name, mode: 'write',
    desc: `${desc} Todo en mm y grados (antihorario). Para varias de golpe usa items (lista de objetos con los mismos campos): se agregan todo-o-nada. Devuelve los ids. dryRun=true solo valida.`,
    shape: { ...DRAW_COMMON, ...fields, items: z.array(z.object(itemShape).strict()).min(1).max(2000).optional().describe('Varias entidades de este tipo (campos sueltos o items, no ambos)') },
    run: (project, a) => {
      const d = pickDrawing(project, a.drawing);
      const single = keys.some((k) => a[k] !== undefined);
      if (single && a.items) throw new Error('Usa los campos sueltos o items, no los dos a la vez.');
      if (!single && !a.items) throw new Error(`${name} necesita sus campos (${keys.join(', ')}) o una lista items.`);
      const rows: Record<string, unknown>[] = a.items ?? [Object.fromEntries(keys.map((k) => [k, a[k]]))];
      const inputs = rows.map((r) => ({ ...clean({ layer: a.layer, color: a.color }), ...clean(r), type }) as unknown as EntityInput);
      const r = addEntities(d, inputs);
      put(project, r.drawing);
      return { drawing: d.id, count: r.ids.length, ids: r.ids };
    },
  };
}

const polyVertex = z.union([pt, z.object({ p: pt, bulge: num.optional().describe('tan(barrido/4): + arco antihorario, - horario, 1 = semicírculo') })]);

// ---------------------------------------------------------------- lectura y medidas

const entityRow = (e: Entity, d?: Drawing) => { const b = entityBounds(e, d && blockCtx(d)); return { ...e, ...(b ? { bounds: [...b.min, ...b.max] } : {}) }; };
const fmt = (n: number) => Math.round(n * 1000) / 1000;

function boundsOf(d: Drawing): [number, number, number, number] | null {
  const b = entitiesBounds(d.entities, blockCtx(d));
  return b ? [fmt(b.min[0]), fmt(b.min[1]), fmt(b.max[0]), fmt(b.max[1])] : null;
}

export function matchWindow(e: Entity, w: [number, number, number, number], crossing: boolean, d?: Drawing): boolean {
  const b = entityBounds(e, d && blockCtx(d));
  if (!b) return false;
  const [x0, y0, x1, y1] = [Math.min(w[0], w[2]), Math.min(w[1], w[3]), Math.max(w[0], w[2]), Math.max(w[1], w[3])];
  return crossing
    ? b.max[0] >= x0 && b.min[0] <= x1 && b.max[1] >= y0 && b.min[1] <= y1
    : b.min[0] >= x0 && b.max[0] <= x1 && b.min[1] >= y0 && b.max[1] <= y1;
}

/** Área, perímetro/longitud y centroide de una entidad (en mm y mm²). */
export function measureEntity(e: Entity): Record<string, unknown> | null {
  const base = { id: e.id, type: e.type, layer: e.layer };
  switch (e.type) {
    case 'line': return { ...base, length: fmt(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1])), centroid: [fmt((e.a[0] + e.b[0]) / 2), fmt((e.a[1] + e.b[1]) / 2)] };
    case 'arc': return { ...base, length: fmt(e.r * sweepOf(e.a0, e.a1) * Math.PI / 180) };
    case 'circle': return { ...base, closed: true, area: fmt(Math.PI * e.r * e.r), areaM2: fmt(Math.PI * e.r * e.r / 1e6), perimeter: fmt(2 * Math.PI * e.r), centroid: [fmt(e.c[0]), fmt(e.c[1])] };
    case 'poly': {
      if (!e.closed) return { ...base, closed: false, length: fmt(polyLength(e)) };
      const c = polyCentroid(e), a = polyArea(e);
      return { ...base, closed: true, area: fmt(a), areaM2: fmt(a / 1e6), perimeter: fmt(polyPerimeter(e)), centroid: c ? [fmt(c[0]), fmt(c[1])] : null };
    }
    case 'hatch': { const a = hatchArea(e); return { ...base, closed: true, pattern: e.pattern, area: fmt(a), areaM2: fmt(a / 1e6) }; }
    default: return null;
  }
}

// ---------------------------------------------------------------- SVG

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const n2 = (v: number) => String(Math.round(v * 100) / 100);

/** Dibujo como SVG (y hacia arriba, sin capas apagadas o congeladas). `window` = [x0,y0,x1,y1] opcional; `width` = ancho en px. */
export function drawingToSvg(d: Drawing, opts: { window?: [number, number, number, number]; width?: number; background?: string } = {}): string {
  const shown = flattenEntities(d, { visibleOnly: true }).filter((e) => { const l = findLayer(d, e.layer); return l ? l.on && !l.frozen : true; }); // los inserts se dibujan resueltos
  let b: Bounds | null = opts.window ? { min: [Math.min(opts.window[0], opts.window[2]), Math.min(opts.window[1], opts.window[3])], max: [Math.max(opts.window[0], opts.window[2]), Math.max(opts.window[1], opts.window[3])] } : entitiesBounds(shown);
  if (!b) b = { min: [0, 0], max: [100, 100] };
  const ext = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], 1);
  const margin = ext * 0.04;
  const x0 = b.min[0] - margin, y1 = b.max[1] + margin;
  const W = b.max[0] - b.min[0] + 2 * margin, H = b.max[1] - b.min[1] + 2 * margin;
  const px = Math.max(100, Math.min(opts.width ?? 1000, 4000));
  const X = (x: number) => n2(x - x0), Y = (y: number) => n2(y1 - y);
  const P = (p: Pt2) => `${X(p[0])},${Y(p[1])}`;
  const tol = Math.max(ext / 5000, 0.01);
  const base = ext / 700;
  const out: string[] = [];
  const textEl = (t: { p: Pt2; h: number; s: string; rot?: number; align?: string }, stroke: string) => {
    const anchor = t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start';
    const rot = t.rot ? ` transform="rotate(${n2(-t.rot)} ${X(t.p[0])} ${Y(t.p[1])})"` : '';
    return `<text x="${X(t.p[0])}" y="${Y(t.p[1])}" font-size="${n2(t.h)}" font-family="sans-serif" text-anchor="${anchor}" fill="${stroke}" stroke="none"${rot}>${esc(t.s)}</text>`;
  };
  for (const e of shown) {
    const stroke = aciToHex(effectiveColor(d, e), false);
    const lay = findLayer(d, e.layer);
    const sw = n2(base * (lay?.lineweight ? Math.max(0.5, lay.lineweight / 0.25) : 1));
    const dash = lay?.linetype === 'dashed' ? ` stroke-dasharray="${n2(ext / 100)} ${n2(ext / 200)}"` : lay?.linetype === 'center' ? ` stroke-dasharray="${n2(ext / 60)} ${n2(ext / 300)} ${n2(ext / 300)} ${n2(ext / 300)}"` : '';
    const attrs = `fill="none" stroke="${stroke}" stroke-width="${sw}"${dash} data-id="${esc(e.id)}"`;
    switch (e.type) {
      case 'line': out.push(`<line x1="${X(e.a[0])}" y1="${Y(e.a[1])}" x2="${X(e.b[0])}" y2="${Y(e.b[1])}" ${attrs}/>`); break;
      case 'poly': out.push(`<${e.closed ? 'polygon' : 'polyline'} points="${tessellatePoly(e, tol).map(P).join(' ')}" ${attrs}/>`); break;
      case 'circle': out.push(`<circle cx="${X(e.c[0])}" cy="${Y(e.c[1])}" r="${n2(e.r)}" ${attrs}/>`); break;
      case 'arc': out.push(`<polyline points="${tessellateArc(e.c, e.r, e.a0, e.a1, tol).map(P).join(' ')}" ${attrs}/>`); break;
      case 'text': out.push(textEl(e, stroke)); break;
      case 'insert': break; // ya resuelto por flattenEntities
      case 'hatch': {
        const g = hatchGeometry(e, { tol });
        const fillC = e.fillColor !== undefined ? aciToHex(e.fillColor, false) : e.pattern === 'solid' ? stroke : null;
        if (fillC) out.push(`<path d="${g.polygons.map((pl) => `M${pl.map(P).join('L')}Z`).join('')}" fill="${fillC}" fill-rule="evenodd" stroke="none" data-id="${esc(e.id)}"/>`);
        if (g.segments.length) out.push(`<path d="${g.segments.map(([p, q]) => `M${P(p)}L${P(q)}`).join('')}" fill="none" stroke="${stroke}" stroke-width="${n2(base * 0.6)}" data-id="${esc(e.id)}"/>`);
        if (g.dots.length) out.push(`<path d="${g.dots.map((q) => `M${P(q)}h0`).join('')}" fill="none" stroke="${stroke}" stroke-width="${n2(base * 2)}" stroke-linecap="round" data-id="${esc(e.id)}"/>`);
        break;
      }
      case 'dim': {
        const g = dimGeometry(e);
        out.push(`<g ${attrs}>${g.lines.map(([p, q]) => `<line x1="${X(p[0])}" y1="${Y(p[1])}" x2="${X(q[0])}" y2="${Y(q[1])}"/>`).join('')}</g>`);
        for (const t of g.texts) out.push(textEl({ ...t, s: dimLabel(e) }, stroke));
      }
    }
  }
  const bg = opts.background ?? '#ffffff';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${Math.max(1, Math.round(px * H / W))}" viewBox="0 0 ${n2(W)} ${n2(H)}"><title>${esc(d.name)}</title><rect width="${n2(W)}" height="${n2(H)}" fill="${bg}"/>${out.join('')}</svg>`;
}

// ---------------------------------------------------------------- lote

export interface DrawingBatch { remove?: string[]; update?: ({ id: string } & Record<string, unknown>)[]; add?: Record<string, unknown>[] }

/** Lote sobre un dibujo: primero borra, luego actualiza y por último agrega. Todo o nada (un solo error con la lista de problemas). */
export function applyDrawingBatch(d: Drawing, b: DrawingBatch): { drawing: Drawing; removed: string[]; updated: string[]; added: string[] } {
  const errors: string[] = [];
  const res = { removed: [] as string[], updated: [] as string[], added: [] as string[] };
  const attempt = (label: string, fn: () => void) => { try { fn(); } catch (e) { errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); } };
  (b.remove ?? []).forEach((id, i) => attempt(`remove[${i}] ${id}`, () => { d = removeEntity(d, id); res.removed.push(id); }));
  (b.update ?? []).forEach(({ id, ...patch }, i) => attempt(`update[${i}] ${id}`, () => { d = updateEntity(d, id, patch); res.updated.push(id); }));
  (b.add ?? []).forEach((a, i) => attempt(`add[${i}] ${String(a.type)}`, () => { const r = addEntities(d, [a as unknown as EntityInput]); d = r.drawing; res.added.push(...r.ids); }));
  if (errors.length) throw new Error(`El lote no se aplicó (no se cambió nada). ${errors.length} problema(s):\n${errors.join('\n')}`);
  return { drawing: d, ...res };
}

// ---------------------------------------------------------------- comandos

const sheet = z.object({ w: z.number().positive(), h: z.number().positive(), scale: z.number().positive() }).describe('Papel en mm; scale 0.02 = 1:50');

export const COMMANDS: Command[] = [
  // ---- dibujos
  {
    name: 'list_drawings', mode: 'read', desc: 'Lista los dibujos 2D del proyecto: id, nombre, plano (xy alzado frontal, xz planta, yz alzado lateral), origen, cantidad de entidades y capas, y caja envolvente [x0,y0,x1,y1]. EN: list 2D drawings.',
    shape: {},
    run: (p) => (p.drawings ?? []).map((d) => ({ id: d.id, name: d.name, plane: d.plane, origin: d.origin, entities: d.entities.length, layers: d.layers.length, bounds: boundsOf(d) })),
  },
  {
    name: 'new_drawing', mode: 'write', desc: 'Crea un dibujo 2D (con la capa "0"). plane: xy = alzado frontal, xz = PLANTA vista desde arriba (arriba del papel = muro del fondo), yz = alzado lateral. origin = dónde está su (0,0) en el mundo 3D (mm). El nombre debe ser único. Devuelve el id (d1, d2…). EN: create a 2D drawing.',
    shape: { name: z.string().min(1), plane: z.enum(['xy', 'xz', 'yz']).optional().describe('Por omisión xy'), origin: vec3.optional().describe('[x,y,z] mundo; por omisión [0,0,0]'), sheet: sheet.optional(), layers: z.array(z.object({ name: z.string().min(1), ...layerFields }).strict()).max(200).optional().describe('Capas iniciales (además de "0")') },
    run: (p, a) => {
      if ((p.drawings ?? []).some((d) => d.name.toLowerCase() === a.name.trim().toLowerCase())) throw new Error(`Ya existe un dibujo llamado "${a.name}"; elige otro nombre o usa get_drawing.`);
      const d = createDrawing(a.name, clean({ id: nextDrawingId(p), plane: a.plane, origin: a.origin, sheet: a.sheet, layers: a.layers }) as never);
      put(p, d);
      return { id: d.id, name: d.name, plane: d.plane, origin: d.origin };
    },
  },
  {
    name: 'remove_drawing', mode: 'write', desc: 'Borra un dibujo completo (queda copia en respaldos/). No toca las piezas 3D ya extruidas de él. EN: delete a drawing.',
    shape: { drawing: z.string().describe('Id o nombre') },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); const r = withoutDrawing(p, d.id); if (r.drawings) p.drawings = r.drawings; else delete p.drawings; return `Dibujo ${d.id} "${d.name}" eliminado (${d.entities.length} entidades).`; },
  },
  {
    name: 'get_drawing', mode: 'read', desc: 'Devuelve el dibujo completo en JSON (capas y todas las entidades). Para dibujos grandes usa inspect_drawing o query_entities. EN: full drawing JSON.',
    shape: { drawing: dref },
    run: (p, a) => pickDrawing(p, a.drawing),
  },
  {
    name: 'inspect_drawing', mode: 'read', desc: 'Resumen de un dibujo: plano, origen, caja envolvente, capas (con cantidad de entidades) y conteo por tipo. entities=true agrega las primeras `limit` entidades (50 por omisión). EN: drawing summary.',
    shape: { drawing: dref, entities: z.boolean().optional().describe('Incluir la lista de entidades'), limit: z.number().int().min(1).max(1000).optional() },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      const types: Record<string, number> = {};
      for (const e of d.entities) types[e.type] = (types[e.type] ?? 0) + 1;
      return {
        ...(d.blocks?.length ? { blocks: d.blocks.map((b) => b.name) } : {}),
        id: d.id, name: d.name, plane: d.plane, origin: d.origin, sheet: d.sheet, bounds: boundsOf(d), total: d.entities.length, types,
        layers: d.layers.map((l) => ({ ...l, entities: d.entities.filter((e) => e.layer === l.name).length })),
        ...(a.entities ? { entities: d.entities.slice(0, a.limit ?? 50).map((e) => entityRow(e, d)), truncated: d.entities.length > (a.limit ?? 50) } : {}),
      };
    },
  },

  // ---- dibujar
  drawCommand('draw_line', 'line', 'Dibuja una línea de a a b.', { a: pt.optional(), b: pt.optional() }),
  drawCommand('draw_poly', 'poly', 'Dibuja una polilínea: pts = lista de [x,y] o {p:[x,y], bulge} (bulge = tan(barrido/4) del tramo que sale de ese vértice: + arco antihorario, - horario, 1 = semicírculo). closed=true la cierra (el último vértice también puede llevar bulge).', { pts: z.array(polyVertex).min(2).max(5000).optional(), closed: z.boolean().optional() }),
  drawCommand('draw_rect', 'rect', 'Dibuja un rectángulo (se guarda como polilínea cerrada de 4 vértices) por dos esquinas (p1, p2) o por esquina + ancho + alto (origin, w, h).', { p1: pt.optional(), p2: pt.optional(), origin: pt.optional(), w: num.optional(), h: num.optional() }),
  drawCommand('draw_circle', 'circle', 'Dibuja un círculo por centro + radio (c, r), centro + diámetro (c, d) o 3 puntos (pts).', { c: pt.optional(), r: z.number().positive().optional(), d: z.number().positive().optional(), pts: z.tuple([pt, pt, pt]).optional() }),
  drawCommand('draw_arc', 'arc', 'Dibuja un arco por 3 puntos (pts: inicio, intermedio, fin) o por centro + radio + ángulos (c, r, a0, a1 en grados, antihorario de a0 a a1).', { pts: z.tuple([pt, pt, pt]).optional(), c: pt.optional(), r: z.number().positive().optional(), a0: num.optional(), a1: num.optional() }),
  drawCommand('draw_text', 'text', 'Escribe un texto: p = punto base, h = alto de letra (mm), s = texto, rot en grados, align left|center|right.', { p: pt.optional(), h: z.number().positive().optional(), s: z.string().optional(), rot: num.optional(), align: z.enum(['left', 'center', 'right']).optional() }),
  drawCommand('draw_dim', 'dim', 'Dibuja una cota; la medida se calcula (no se guarda) salvo que pongas text. kind linear: p1, p2, at (punto por donde pasa la línea de cota), rot 0 = horizontal, 90 = vertical; aligned: p1, p2, at; radius | diameter: c, r, ang (dirección de la guía, 45 por omisión).',
    { kind: z.enum(['linear', 'aligned', 'radius', 'diameter']).optional(), p1: pt.optional(), p2: pt.optional(), at: pt.optional(), rot: num.optional(), c: pt.optional(), r: z.number().positive().optional(), ang: num.optional(), text: z.string().optional().describe('Texto que reemplaza a la medida') }),
  {
    name: 'drawing_batch', mode: 'write',
    desc: 'Crea, modifica y borra MUCHAS entidades de un dibujo en una sola llamada, todo-o-nada (si algo falla no se cambia nada y el mensaje lista cada problema: add[3], update[0]…). Orden: remove, update, add. add[] lleva objetos con type = line|poly|rect|circle|arc|text|dim y los campos de draw_* (más layer y color); update[] lleva {id, …campos a cambiar; color:null vuelve a PorCapa}; remove[] ids. Ejemplo: {drawing:"d1", add:[{type:"rect", p1:[0,0], p2:[4000,3000]}, {type:"circle", c:[500,500], d:300, layer:"Muebles"}, {type:"dim", kind:"linear", p1:[0,0], p2:[4000,0], at:[0,-300]}], update:[{id:"e1", color:1}], remove:["e7"]}. dryRun=true solo valida. EN: batch add/update/remove entities atomically.',
    shape: {
      drawing: dref,
      add: z.array(z.object({ type: z.enum(['line', 'poly', 'rect', 'circle', 'arc', 'text', 'dim', 'hatch', 'insert']) }).passthrough()).max(5000).optional(),
      update: z.array(z.object({ id: z.string() }).passthrough()).max(5000).optional(),
      remove: z.array(z.string()).max(5000).optional(),
    },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      const r = applyDrawingBatch(d, { add: a.add, update: a.update, remove: a.remove });
      put(p, r.drawing);
      return { drawing: d.id, removed: r.removed, updated: r.updated, added: r.added, total: r.drawing.entities.length };
    },
  },

  // ---- editar
  {
    name: 'update_entity', mode: 'write', desc: 'Cambia campos de una entidad (no id ni type): patch = {a, b, pts, r, s, h, layer, color…}; color:null vuelve a PorCapa. Se valida el resultado. EN: edit an entity.',
    shape: { drawing: dref, id: z.string(), patch: z.record(z.unknown()).describe('Campos a cambiar, p. ej. {"r": 250} o {"layer":"Cotas","color":null}') },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); put(p, updateEntity(d, a.id, a.patch)); return getEntity(pickDrawing(p, d.id), a.id); },
  },
  {
    name: 'remove_entity', mode: 'write', desc: 'Borra una o varias entidades por id (no las de capas bloqueadas o congeladas). EN: delete entities.',
    shape: { drawing: dref, id: ids.optional(), ids: ids.optional() },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); const l = idList(a.ids ?? a.id ?? []); put(p, removeEntity(d, l)); return `Se borraron ${l.length} entidad(es). Quedan ${d.entities.length - l.length}.`; },
  },
  {
    name: 'move_entities', mode: 'write', desc: 'Mueve entidades por el vector delta [dx, dy] (mm). Conservan sus ids. EN: move.',
    shape: { drawing: dref, ids, delta: pt },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); put(p, moveEntities(d, a.ids, a.delta)); return `Movidas ${idList(a.ids).length} entidad(es) ${a.delta[0]}, ${a.delta[1]} mm.`; },
  },
  {
    name: 'copy_entities', mode: 'write', desc: 'Copia entidades `count` veces (1 por omisión), cada copia desplazada delta·k. Devuelve los ids nuevos agrupados por copia. EN: copy / array.',
    shape: { drawing: dref, ids, delta: pt, count: z.number().int().min(1).max(1000).optional() },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); const r = copyEntities(d, a.ids, a.delta, a.count ?? 1); put(p, r.drawing); return { drawing: d.id, count: r.ids.length, ids: r.ids }; },
  },
  {
    name: 'rotate_entities', mode: 'write', desc: 'Gira entidades `angle` grados (antihorario) alrededor de center [x,y]. EN: rotate.',
    shape: { drawing: dref, ids, center: pt, angle: num },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); put(p, rotateEntities(d, a.ids, a.center, a.angle)); return `Giradas ${idList(a.ids).length} entidad(es) ${a.angle}°.`; },
  },
  {
    name: 'scale_entities', mode: 'write', desc: 'Escala entidades por factor (> 0, sin espejos) respecto de center [x,y]. EN: scale.',
    shape: { drawing: dref, ids, center: pt, factor: z.number().positive() },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); put(p, scaleEntities(d, a.ids, a.center, a.factor)); return `Escaladas ${idList(a.ids).length} entidad(es) ×${a.factor}.`; },
  },
  {
    name: 'offset_entity', mode: 'write', desc: 'Paralela a una línea, círculo, arco o polilínea SIN arcos a `distance` mm (≠ 0). Línea/polilínea: + = a la izquierda del recorrido; círculo/arco: + = radio mayor. Crea una entidad nueva y devuelve su id. EN: offset.',
    shape: { drawing: dref, id: z.string(), distance: num },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); const r = offsetEntity(d, a.id, a.distance); put(p, r.drawing); return { drawing: d.id, id: r.id }; },
  },

  // ---- capas
  {
    name: 'layer_new', mode: 'write', desc: 'Crea una capa (nombre único sin distinguir mayúsculas). color ACI o "#rrggbb", linetype continuous|dashed|center, lineweight en mm de papel. EN: new layer.',
    shape: { drawing: dref, name: z.string().min(1), ...layerFields },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); const { drawing: _d, ...l } = a; put(p, addLayer(d, clean(l) as never)); return `Capa "${a.name}" creada en ${d.id}.`; },
  },
  {
    name: 'layer_set', mode: 'write', desc: 'Cambia propiedades de una capa: color, linetype, lineweight, on (visible), frozen, locked; rename = nombre nuevo (actualiza sus entidades; la "0" no se renombra). EN: edit layer.',
    shape: { drawing: dref, name: z.string().min(1), rename: z.string().min(1).optional(), ...layerFields },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      const { drawing: _d, name, rename, ...rest } = a;
      put(p, setLayer(d, name, clean({ ...rest, name: rename }) as never));
      return `Capa "${name}" actualizada.`;
    },
  },
  {
    name: 'layer_remove', mode: 'write', desc: 'Borra una capa VACÍA (la "0" no se puede borrar). EN: delete layer.',
    shape: { drawing: dref, name: z.string().min(1) },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); put(p, removeLayer(d, a.name)); return `Capa "${a.name}" eliminada.`; },
  },

  // ---- consultar
  {
    name: 'query_entities', mode: 'read', desc: 'Busca entidades por type (line, poly, circle, arc, text, dim), layer y/o ventana [x0,y0,x1,y1]: window sin crossing = entidades totalmente dentro; crossing=true = las que tocan o cruzan la ventana (por su caja envolvente). Paginado: limit (100 por omisión, máx. 1000) y offset. Cada fila lleva sus campos y bounds [x0,y0,x1,y1]. EN: query entities.',
    shape: { drawing: dref, type: z.enum(['line', 'poly', 'circle', 'arc', 'text', 'dim', 'hatch', 'insert']).optional(), layer: z.string().optional(), window: z.tuple([num, num, num, num]).optional(), crossing: z.boolean().optional(), limit: z.number().int().min(1).max(1000).optional(), offset: z.number().int().min(0).optional() },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      if (a.layer && !findLayer(d, a.layer)) throw new Error(`La capa "${a.layer}" no existe. Capas: ${d.layers.map((l) => l.name).join(', ')}.`);
      const layer = a.layer ? findLayer(d, a.layer)!.name : undefined;
      const all = d.entities.filter((e) => (!a.type || e.type === a.type) && (!layer || e.layer === layer) && (!a.window || matchWindow(e, a.window, !!a.crossing, d)));
      const from = a.offset ?? 0, n = a.limit ?? 100;
      return { drawing: d.id, total: all.length, offset: from, entities: all.slice(from, from + n).map((e) => entityRow(e, d)) };
    },
  },
  {
    name: 'find_text', mode: 'read', desc: 'Busca textos (y etiquetas de cotas) que contengan `contains` (sin distinguir mayúsculas salvo caseSensitive) en un dibujo o en todos si omites drawing. EN: find text.',
    shape: { contains: z.string().min(1), drawing: dref, caseSensitive: z.boolean().optional() },
    run: (p, a) => {
      const list = a.drawing !== undefined ? [pickDrawing(p, a.drawing)] : (p.drawings ?? []);
      const norm = (s: string) => (a.caseSensitive ? s : s.toLowerCase());
      const rows: unknown[] = [];
      for (const d of list) for (const e of d.entities) {
        const s = e.type === 'text' ? e.s : e.type === 'dim' ? dimLabel(e) : null;
        if (s !== null && norm(s).includes(norm(a.contains))) rows.push({ drawing: d.id, id: e.id, type: e.type, layer: e.layer, text: s, at: e.type === 'text' ? e.p : undefined });
      }
      return { total: rows.length, matches: rows };
    },
  },
  {
    name: 'measure_shapes', mode: 'read', desc: 'Mide entidades (todas las de líneas, arcos, polilíneas y círculos, o las de `ids`): longitud, y para formas cerradas área (mm² y m²), perímetro y centroide [x,y]. Los arcos de las polilíneas cuentan. Devuelve además el área total de las cerradas. EN: area/perimeter/centroid.',
    shape: { drawing: dref, ids: ids.optional(), layer: z.string().optional() },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      let list = d.entities;
      if (a.ids) list = idList(a.ids).map((id) => getEntity(d, id) ?? (() => { throw new Error(`No existe la entidad "${id}".`); })());
      if (a.layer) list = list.filter((e) => e.layer.toLowerCase() === a.layer.toLowerCase());
      const rows = list.map(measureEntity).filter((r): r is Record<string, unknown> => !!r);
      const closed = rows.filter((r) => r.closed);
      const total = closed.reduce((s, r) => s + (r.area as number), 0);
      return { drawing: d.id, shapes: rows, closed: closed.length, totalArea: fmt(total), totalAreaM2: fmt(total / 1e6) };
    },
  },
  {
    name: 'render_drawing', mode: 'files', desc: 'Dibuja el dibujo como SVG (capas apagadas o congeladas no salen; y hacia arriba). Devuelve el SVG como texto (returnSvg=false para no devolverlo) y, con save=true, lo guarda en la carpeta export/ de los datos (nombre sugerido con `filename`; solo SVG: para PNG abre el SVG en un visor o usa la app). window [x0,y0,x1,y1] recorta la vista; width = ancho en px (1000 por omisión). EN: render to SVG.',
    shape: { drawing: dref, window: z.tuple([num, num, num, num]).optional(), width: z.number().int().min(100).max(4000).optional(), background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), save: z.boolean().optional(), filename: z.string().max(80).optional(), returnSvg: z.boolean().optional() },
    run: (p, a, ctx) => {
      const d = pickDrawing(p, a.drawing);
      const svg = drawingToSvg(d, clean({ window: a.window, width: a.width, background: a.background }) as never);
      const res: Record<string, unknown> = { drawing: d.id, entities: d.entities.length, chars: svg.length };
      if (a.save) {
        const dir = path.join(ctx.store.dataDir, 'export');
        fs.mkdirSync(dir, { recursive: true });
        const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').replace(/\.svg$/i, '').slice(0, 80);
        const file = `${safe(a.filename ?? `${p.name}-${d.name}`) || 'dibujo'}.svg`;
        fs.writeFileSync(path.join(dir, file), svg);
        res.file = path.join(dir, file);
      }
      if (a.returnSvg !== false) res.svg = svg;
      return res;
    },
  },

  // ---- del dibujo al sólido y de vuelta
  {
    name: 'extrude_entity', mode: 'write', desc: 'Extruye entidades CERRADAS (polilínea cerrada, rectángulo o círculo) a piezas sólidas del proyecto: polilínea → prism, círculo → cylinder. La profundidad va a lo largo de la normal del plano del dibujo (xy→+Z, xz→+Y, yz→+X); negativa va al otro lado. Se ubica según plane y origin del dibujo. material por omisión mel18 (o el primero del proyecto); si la polilínea se cruza a sí misma se rechaza. Devuelve las piezas (id, name, form, size, position). EN: extrude closed shapes to solid parts.',
    shape: { drawing: dref, entity: z.string().optional(), entities: z.array(z.string()).min(1).max(500).optional(), depth: num.describe('mm, ≠ 0'), material: z.string().optional(), name: z.string().min(1).optional().describe('Nombre de la pieza (con varias se le agrega 1, 2…)'), group: z.string().optional() },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      const list = [...(a.entity ? [a.entity] : []), ...(a.entities ?? [])];
      if (!list.length) throw new Error('Indica entity (un id) o entities (lista de ids) a extruir.');
      const material = a.material ?? (p.materials.some((m) => m.id === 'mel18') ? 'mel18' : p.materials[0]?.id);
      if (!material || !p.materials.some((m) => m.id === material)) throw new Error(`Material desconocido: ${material ?? '(ninguno)'}. Materiales: ${p.materials.map((m) => m.id).join(', ') || '(ninguno; crea uno con add_material)'}.`);
      const made = list.map((id, i) => {
        const e = getEntity(d, id);
        if (!e) throw new Error(`No existe la entidad "${id}" en ${d.id}.`);
        let def;
        try { def = extrudeProfile(d, e, a.depth, clean({ name: a.name ? (list.length > 1 ? `${a.name} ${i + 1}` : a.name) : undefined, material, group: a.group }) as never); } catch (err) { throw new Error(`${id}: ${(err as Error).message}`); }
        const part = normalizePart({ id: nextId(p), ...def });
        p.parts.push(part);
        return { id: part.id, name: part.name, form: part.form, size: part.size, position: part.position };
      });
      return { drawing: d.id, parts: made };
    },
  },
  {
    name: 'part_to_drawing', mode: 'write', desc: 'Dibuja el contorno de una pieza (prisma → polilínea, cilindro → círculo, caja → rectángulo) en un dibujo: con `drawing` lo agrega a ese dibujo (debe estar en el mismo plano y a la misma altura de origen); sin drawing crea uno nuevo (new_name opcional) en el plano de la pieza. No soporta piezas giradas, tubos ni revoluciones. EN: outline of a part as 2D entities.',
    shape: { part: z.string().describe('Id de la pieza'), drawing: z.string().optional(), new_name: z.string().min(1).optional(), layer: layerName.optional() },
    run: (p, a) => {
      const part = p.parts.find((x) => x.id === a.part);
      if (!part) throw new Error(`No existe la pieza ${a.part}.`);
      const o = partToOutline(part);
      if (!o) throw new Error(`La pieza ${part.id} "${part.name}" no tiene contorno 2D simple (piezas giradas, tubos y revoluciones no se soportan).`);
      let d: Drawing;
      if (a.drawing !== undefined) {
        d = pickDrawing(p, a.drawing);
        const same = d.plane === o.plane && [0, 1, 2].every((i) => Math.abs(d.origin[i] - o.origin[i]) < 1e-6);
        if (!same) throw new Error(`El dibujo ${d.id} está en el plano ${d.plane} con origen [${d.origin.join(', ')}], pero el contorno de la pieza cae en ${o.plane} con origen [${o.origin.join(', ')}]. Omite drawing para crear uno nuevo.`);
      } else {
        const name = a.new_name ?? `Contorno ${part.name}`;
        if ((p.drawings ?? []).some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`Ya existe un dibujo llamado "${name}"; usa new_name.`);
        d = createDrawing(name, { id: nextDrawingId(p), plane: o.plane, origin: o.origin });
      }
      const r = addEntities(d, [{ ...o.input, ...(a.layer ? { layer: a.layer } : {}) } as EntityInput]);
      put(p, r.drawing);
      const c = o.input.type === 'circle' && 'c' in o.input ? o.input.c : undefined;
      return { drawing: d.id, id: r.ids[0], plane: o.plane, origin: o.origin, world: c ? drawingToWorld(d, c) : undefined };
    },
  },
];

// ---------------------------------------------------------------- ejecución

const byName = new Map(COMMANDS.map((c) => [c.name, c]));
const EXTRA: Command[] = [];
const allCommands = (): Command[] => [...COMMANDS, ...EXTRA];
/** Comandos de otros módulos (recortar/extender, sombreados, bloques): quedan disponibles por drawing_execute y drawing_list_commands; cada módulo registra sus propias herramientas MCP. */
export function addDrawingCommands(list: { name: string; mode: 'read' | 'write'; desc: string; shape: ZodRawShape; run: (project: Project, args: any) => unknown }[]): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const c of list) if (!byName.has(c.name)) { const cmd = c as Command; EXTRA.push(cmd); byName.set(c.name, cmd); }
}
const dryShape = { dryRun: z.boolean().optional().describe('Solo validar: no guarda nada') };
const shapeOf = (c: Command): ZodRawShape => (c.mode === 'write' ? { ...c.shape, ...dryShape } : c.shape);

const zmsg = (err: z.ZodError) => err.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');

/** Ejecuta un comando sobre el almacén. Lectura y archivos usan una copia fresca; escritura guarda (con respaldo y reintento por rev) salvo dryRun. */
export function runCommand(store: Store, name: string, args: Record<string, unknown>): unknown {
  const c = byName.get(name);
  if (!c) throw new Error(`No existe el comando "${name}". Comandos: ${allCommands().map((x) => x.name).join(', ')} (drawing_list_commands los describe).`);
  const parsed = z.object(shapeOf(c)).strict().safeParse(args);
  if (!parsed.success) throw new Error(`${name}: parámetros no válidos. ${zmsg(parsed.error)}`);
  return runParsed(store, c, parsed.data);
}

function runParsed(store: Store, c: Command, a: Record<string, unknown>): unknown {
  const ctx = { store };
  const fresh = () => { const { project } = store.readProject(); project.hardware ??= defaultHardware(); return project; };
  const checked = (p: Project) => { const m = validateDrawings(p); if (m) throw new Error(m); };
  try {
    if (c.mode !== 'write') return c.run(fresh(), a, ctx);
    if (a.dryRun) {
      const p = structuredClone(fresh());
      const r = c.run(p, a, ctx);
      checked(p);
      return { dryRun: true, nota: 'Validado: no se guardó nada.', resultado: r };
    }
    return store.updateProject((p) => { p.hardware ??= defaultHardware(); const before = p.drawings; const r = c.run(p, a, ctx); const sy = syncAllHatches(before, p.drawings); if (sy !== p.drawings) p.drawings = sy; checked(p); return r; }); // los sombreados asociativos siguen a su contorno
  } catch (e) {
    if (e instanceof DrawingError) throw new Error(e.message);
    throw e;
  }
}

/** Descripción autodescriptiva de un comando para drawing_list_commands. */
function describe(c: Command) {
  const params: Record<string, { obligatorio: boolean; descripcion?: string }> = {};
  for (const [k, v] of Object.entries(shapeOf(c)) as [string, ZodTypeAny][]) params[k] = { obligatorio: !v.isOptional(), ...(v.description ? { descripcion: v.description } : {}) };
  return { command: c.name, modo: c.mode === 'read' ? 'lectura' : c.mode === 'write' ? 'escribe project.json' : 'escribe archivos', descripcion: c.desc, parametros: params };
}

/** Lo que devuelve drawing_list_commands (también los comandos añadidos por otros módulos). */
export function listCommands(command?: string): ReturnType<typeof describe>[] {
  const list = command ? allCommands().filter((c) => c.name === command) : allCommands();
  if (command && !list.length) throw new Error(`No existe el comando "${command}". Comandos: ${allCommands().map((x) => x.name).join(', ')}.`);
  return list.map(describe);
}

export function registerDrawingTools(kit: Kit, store: Store): void {
  for (const c of COMMANDS) {
    const reg = kit[c.mode] as (n: string, d: string, s: ZodRawShape, f: (a: Record<string, unknown>) => unknown) => void;
    reg(c.name, c.desc, shapeOf(c), (a) => runParsed(store, c, a));
  }
  kit.read('drawing_list_commands', 'Lista los comandos del dibujo 2D con su modo, descripción y parámetros (qué es obligatorio). Úsala con drawing_execute: {command, params}. EN: self-describing list of drawing commands.',
    { command: z.string().optional().describe('Solo este comando') },
    ({ command }) => listCommands(command as string | undefined));
  kit.write('drawing_execute', 'Ejecuta cualquier comando del dibujo 2D por nombre: {command:"draw_circle", params:{drawing:"d1", c:[0,0], r:50}}. Equivale a llamar a esa herramienta (los comandos de escritura respaldan y validan igual; dryRun va dentro de params). Para ver los comandos y sus parámetros usa drawing_list_commands. EN: run any drawing command by name.',
    { command: z.string(), params: z.record(z.unknown()).optional() },
    ({ command, params }) => runCommand(store, command, params ?? {}));
}
