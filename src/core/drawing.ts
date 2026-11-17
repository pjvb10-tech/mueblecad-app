import { isDrawingColor } from './aci';
import { PLANES } from './drawingPlane';
import { arcFrom3Points, circleFrom3Points, dedupePoly, dist, intersectLines, norm360 } from './geom2d';
import { validateBlocks } from './blocks';
import { HATCH_PATTERNS } from './types';
import type { ArcEntity, Drawing, DrawingColor, DrawingPlane, Entity, HatchEntity, HatchPattern, InsertEntity, Layer, PolyVertex, Project, Pt2, Vec3 } from './types';

/**
 * Operaciones PURAS e INMUTABLES sobre un dibujo 2D: cada función devuelve un dibujo nuevo (las entidades que no cambian se comparten)
 * y lanza DrawingError con un mensaje accionable en español si la petición no es válida. Sin DOM, sin servidor. Contrato: docs/dibujo-2d.md.
 */

export class DrawingError extends Error {
  constructor(message: string) { super(message); this.name = 'DrawingError'; }
}
const fail = (m: string): never => { throw new DrawingError(m); };

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPt = (p: unknown): p is Pt2 => Array.isArray(p) && p.length === 2 && fin(p[0]) && fin(p[1]);
const isVec3 = (p: unknown): p is Vec3 => Array.isArray(p) && p.length === 3 && p.every(fin);
const clonePt = (p: Pt2): Pt2 => [p[0], p[1]];

// ---------------------------------------------------------------- dibujo y capas

export const LAYER_0 = '0';
export const defaultLayer = (name: string, patch: Partial<Layer> = {}): Layer => ({ name, color: 7, linetype: 'continuous', on: true, frozen: false, locked: false, ...patch });

export interface DrawingOptions { id?: string; plane?: DrawingPlane; origin?: Vec3; sheet?: Drawing['sheet']; layers?: (Partial<Layer> & { name: string })[] }

/** Dibujo nuevo con la capa "0". `id` por omisión "d1" (el proyecto debe garantizar que sea único: ver nextDrawingId). */
export function createDrawing(name: string, opts: DrawingOptions = {}): Drawing {
  if (typeof name !== 'string' || !name.trim()) fail('El dibujo necesita un nombre (texto no vacío).');
  const plane = opts.plane ?? 'xy';
  if (!PLANES.includes(plane)) fail(`plane "${String(plane)}" no existe. Planos: ${PLANES.join(', ')}.`);
  const origin = opts.origin ?? [0, 0, 0];
  if (!isVec3(origin)) fail('origin debe ser [x, y, z] con números finitos (mm).');
  let d: Drawing = { id: opts.id ?? 'd1', name: name.trim(), plane, origin: [...origin] as Vec3, layers: [defaultLayer(LAYER_0)], entities: [] };
  if (opts.sheet) {
    if (!(opts.sheet.w > 0 && opts.sheet.h > 0 && opts.sheet.scale > 0)) fail('sheet debe tener w, h y scale mayores que 0.');
    d.sheet = { ...opts.sheet };
  }
  for (const l of opts.layers ?? []) d = addLayer(d, l);
  return d;
}

/** Id libre para un dibujo nuevo dentro del proyecto ("d1", "d2"…). */
export function nextDrawingId(project: Pick<Project, 'drawings'>): string {
  const used = new Set((project.drawings ?? []).map((x) => x.id));
  for (let i = 1; ; i++) if (!used.has(`d${i}`)) return `d${i}`;
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const findLayer = (d: Drawing, name: string): Layer | undefined => d.layers.find((l) => sameName(l.name, name));
const layerList = (d: Drawing) => d.layers.map((l) => l.name).join(', ');

function checkLayerFields(l: Partial<Layer>, who: string): void {
  if (l.color !== undefined && !isDrawingColor(l.color)) fail(`${who}: color debe ser un índice ACI entero de 1 a 255 o un hexadecimal "#rrggbb".`);
  if (l.linetype !== undefined && !['continuous', 'dashed', 'center'].includes(l.linetype)) fail(`${who}: linetype debe ser continuous, dashed o center.`);
  if (l.lineweight !== undefined && !(fin(l.lineweight) && l.lineweight > 0 && l.lineweight <= 5)) fail(`${who}: lineweight debe ser un número entre 0 y 5 (mm de papel).`);
  for (const k of ['on', 'frozen', 'locked'] as const) if (l[k] !== undefined && typeof l[k] !== 'boolean') fail(`${who}: ${k} debe ser true o false.`);
}

/** layer.new: agrega una capa. Error si ya existe (sin distinguir mayúsculas). */
export function addLayer(d: Drawing, layer: Partial<Layer> & { name: string }): Drawing {
  if (typeof layer.name !== 'string' || !layer.name.trim()) return fail('La capa necesita un nombre (texto no vacío).');
  const name = layer.name.trim();
  if (findLayer(d, name)) return fail(`La capa "${name}" ya existe; cámbiala con setLayer. Capas: ${layerList(d)}.`);
  checkLayerFields(layer, `Capa "${name}"`);
  return { ...d, layers: [...d.layers, defaultLayer(name, { ...layer, name })] };
}

/** layer.set: cambia propiedades de una capa (también `name`, salvo la "0"; renombrar actualiza sus entidades). */
export function setLayer(d: Drawing, name: string, patch: Partial<Layer>): Drawing {
  const cur = findLayer(d, name);
  if (!cur) return fail(`La capa "${name}" no existe. Capas: ${layerList(d)}.`);
  checkLayerFields(patch, `Capa "${cur.name}"`);
  const next: Layer = { ...cur, ...patch };
  if (patch.name !== undefined && patch.name !== cur.name) {
    if (cur.name === LAYER_0) return fail('La capa "0" no se puede renombrar.');
    if (typeof patch.name !== 'string' || !patch.name.trim()) return fail('El nombre de la capa no puede estar vacío.');
    next.name = patch.name.trim();
    if (d.layers.some((l) => l !== cur && sameName(l.name, next.name))) return fail(`Ya existe una capa llamada "${next.name}".`);
  } else next.name = cur.name;
  const entities = next.name === cur.name ? d.entities : d.entities.map((e) => (e.layer === cur.name ? ({ ...e, layer: next.name } as Entity) : e));
  return { ...d, layers: d.layers.map((l) => (l === cur ? next : l)), entities };
}

/** Borra una capa vacía. La "0" no se puede borrar; si tiene entidades, muévelas antes con updateEntity. */
export function removeLayer(d: Drawing, name: string): Drawing {
  const cur = findLayer(d, name);
  if (!cur) return fail(`La capa "${name}" no existe. Capas: ${layerList(d)}.`);
  if (cur.name === LAYER_0) return fail('La capa "0" siempre existe y no se puede borrar.');
  const n = d.entities.filter((e) => e.layer === cur.name).length;
  if (n) return fail(`La capa "${cur.name}" tiene ${n} entidad(es); muévelas a otra capa (updateEntity con layer) o bórralas antes.`);
  return { ...d, layers: d.layers.filter((l) => l !== cur) };
}

/** Color efectivo de una entidad: el suyo o el de su capa (PorCapa). */
export const effectiveColor = (d: Drawing, e: Entity): DrawingColor => e.color ?? findLayer(d, e.layer)?.color ?? 7;

// ---------------------------------------------------------------- validación

/** Valida una entidad ya completa. Devuelve el mensaje de error o null. Con `d`, comprueba además que la capa exista. */
export function validateEntity(e: Entity, d?: Drawing): string | null {
  const who = `Entidad ${e && typeof e === 'object' && (e as Entity).id ? `"${(e as Entity).id}" ` : ''}(${(e as Entity)?.type})`;
  if (!e || typeof e !== 'object') return 'La entidad debe ser un objeto.';
  if (typeof e.id !== 'string' || !e.id) return `${who}: falta id (texto no vacío).`;
  if (typeof e.layer !== 'string' || !e.layer) return `${who}: falta layer (nombre de capa; usa "0" si no sabes cuál).`;
  if (d && !findLayer(d, e.layer)) return `${who}: la capa "${e.layer}" no existe. Capas: ${layerList(d)}.`;
  if (e.color !== undefined && !isDrawingColor(e.color)) return `${who}: color debe ser un índice ACI (1 a 255) o "#rrggbb"; quítalo para usar el de la capa.`;
  switch (e.type) {
    case 'line':
      if (!isPt(e.a) || !isPt(e.b)) return `${who}: a y b deben ser [x, y] con números finitos.`;
      if (dist(e.a, e.b) < 1e-9) return `${who}: los dos extremos son el mismo punto.`;
      return null;
    case 'poly': {
      if (!Array.isArray(e.pts) || e.pts.some((v) => !v || !isPt(v.p) || (v.bulge !== undefined && !fin(v.bulge)))) return `${who}: pts debe ser una lista de { p: [x, y], bulge? } con números finitos.`;
      const min = e.closed ? 3 : 2;
      if (e.pts.length < min) return `${who}: una polilínea ${e.closed ? 'cerrada' : 'abierta'} necesita al menos ${min} puntos (tiene ${e.pts.length}).`;
      return null;
    }
    case 'circle':
      if (!isPt(e.c) || !fin(e.r) || e.r <= 0) return `${who}: c debe ser [x, y] y r un número mayor que 0 (mm).`;
      return null;
    case 'arc':
      if (!isPt(e.c) || !fin(e.r) || e.r <= 0) return `${who}: c debe ser [x, y] y r un número mayor que 0 (mm).`;
      if (!fin(e.a0) || !fin(e.a1)) return `${who}: a0 y a1 deben ser ángulos en GRADOS (números finitos, antihorario).`;
      return null;
    case 'text':
      if (!isPt(e.p) || typeof e.s !== 'string' || !e.s) return `${who}: p debe ser [x, y] y s un texto no vacío.`;
      if (!fin(e.h) || e.h <= 0) return `${who}: h (alto de letra en mm) debe ser mayor que 0.`;
      if (e.rot !== undefined && !fin(e.rot)) return `${who}: rot debe ser un ángulo en grados.`;
      if (e.align !== undefined && !['left', 'center', 'right'].includes(e.align)) return `${who}: align debe ser left, center o right.`;
      return null;
    case 'dim':
      if (e.text !== undefined && typeof e.text !== 'string') return `${who}: text debe ser un texto.`;
      if (e.kind === 'linear' || e.kind === 'aligned') {
        if (!isPt(e.p1) || !isPt(e.p2) || !isPt(e.at)) return `${who}: p1, p2 y at deben ser [x, y] con números finitos.`;
        if (e.kind === 'linear' && e.rot !== undefined && !fin(e.rot)) return `${who}: rot debe ser un ángulo en grados (0 = horizontal, 90 = vertical).`;
        if (dist(e.p1, e.p2) < 1e-9) return `${who}: p1 y p2 son el mismo punto; no hay nada que medir.`;
        return null;
      }
      if (e.kind === 'radius' || e.kind === 'diameter') {
        if (!isPt(e.c) || !fin(e.r) || e.r <= 0) return `${who}: c debe ser [x, y] y r mayor que 0.`;
        if (e.ang !== undefined && !fin(e.ang)) return `${who}: ang debe ser un ángulo en grados.`;
        return null;
      }
      return `${who}: kind debe ser linear, aligned, radius o diameter.`;
    case 'hatch': {
      if (!Array.isArray(e.loops) || !e.loops.length) return `${who}: loops debe ser una lista con al menos un contorno (lista de vértices { p, bulge? }).`;
      for (const [i, l] of e.loops.entries()) {
        if (!Array.isArray(l) || l.length < 2 || l.some((v) => !v || !isPt(v.p) || (v.bulge !== undefined && !fin(v.bulge)))) return `${who}: el contorno ${i + 1} debe ser una lista de al menos 2 vértices { p: [x, y], bulge? } con números finitos.`;
        if (l.length === 2 && !(l[0].bulge && l[1].bulge)) return `${who}: el contorno ${i + 1} con 2 vértices solo es válido si ambos tienen bulge (dos arcos, p. ej. un círculo).`;
      }
      if (!HATCH_PATTERNS.includes(e.pattern)) return `${who}: pattern debe ser ${HATCH_PATTERNS.join(', ')}.`;
      if (e.angle !== undefined && !fin(e.angle)) return `${who}: angle debe ser un ángulo en grados.`;
      if (e.scale !== undefined && !(fin(e.scale) && e.scale > 0)) return `${who}: scale (separación del patrón en mm) debe ser mayor que 0.`;
      if (e.fillColor !== undefined && !isDrawingColor(e.fillColor)) return `${who}: fillColor debe ser un índice ACI (1 a 255) o "#rrggbb".`;
      if (e.source !== undefined && (!Array.isArray(e.source) || e.source.some((s) => typeof s !== 'string'))) return `${who}: source debe ser una lista de ids de entidades.`;
      return null;
    }
    case 'insert': {
      if (typeof e.block !== 'string' || !e.block) return `${who}: block debe ser el nombre de un bloque.`;
      if (d && !(d.blocks ?? []).some((b) => b.name.toLowerCase() === e.block.toLowerCase())) return `${who}: el bloque "${e.block}" no existe. Bloques: ${(d.blocks ?? []).map((b) => b.name).join(', ') || '(ninguno)'}.`;
      if (!isPt(e.p)) return `${who}: p debe ser [x, y] con números finitos.`;
      for (const k of ['sx', 'sy'] as const) if (e[k] !== undefined && (!fin(e[k]) || e[k] === 0)) return `${who}: ${k} debe ser un número distinto de 0 (negativo = espejo).`;
      if (e.rot !== undefined && !fin(e.rot)) return `${who}: rot debe ser un ángulo en grados.`;
      for (const k of ['cols', 'rows'] as const) if (e[k] !== undefined && !(Number.isInteger(e[k]) && e[k]! >= 1 && e[k]! <= 1000)) return `${who}: ${k} debe ser un entero entre 1 y 1000.`;
      if ((e.cols ?? 1) * (e.rows ?? 1) > 10000) return `${who}: el arreglo no puede pasar de 10 000 copias (cols × rows).`;
      for (const k of ['dx', 'dy'] as const) if (e[k] !== undefined && !fin(e[k])) return `${who}: ${k} debe ser un número (separación del arreglo en mm).`;
      return null;
    }
    default:
      return `Entidad ${(e as Entity).id}: type "${String((e as { type?: unknown }).type)}" no existe. Tipos: line, poly, circle, arc, text, dim, hatch, insert (y rect/ejes solo como entrada de addEntity).`;
  }
}

/** Valida un dibujo completo (campos, capas, entidades, ids únicos). Null si es válido. */
export function validateDrawing(d: Drawing): string | null {
  if (!d || typeof d !== 'object') return 'El dibujo debe ser un objeto.';
  const who = `Dibujo "${d.name ?? d.id}"`;
  if (typeof d.id !== 'string' || !d.id) return `${who}: falta id.`;
  if (typeof d.name !== 'string' || !d.name) return `${who}: falta name.`;
  if (!PLANES.includes(d.plane)) return `${who}: plane debe ser ${PLANES.join(', ')}.`;
  if (!isVec3(d.origin)) return `${who}: origin debe ser [x, y, z] con números finitos (mm).`;
  if (!Array.isArray(d.layers) || !Array.isArray(d.entities)) return `${who}: layers y entities deben ser listas.`;
  if (!d.layers.some((l) => l.name === LAYER_0)) return `${who}: falta la capa "0" (siempre debe existir).`;
  const names = new Set<string>();
  for (const l of d.layers) {
    if (typeof l.name !== 'string' || !l.name) return `${who}: hay una capa sin nombre.`;
    if (names.has(l.name.toLowerCase())) return `${who}: la capa "${l.name}" está repetida.`;
    names.add(l.name.toLowerCase());
    if (!isDrawingColor(l.color)) return `${who}: la capa "${l.name}" necesita color (ACI 1 a 255 o "#rrggbb").`;
    for (const k of ['on', 'frozen', 'locked'] as const) if (typeof l[k] !== 'boolean') return `${who}: la capa "${l.name}" necesita ${k} (true/false).`;
    try { checkLayerFields(l, `Capa "${l.name}"`); } catch (err) { return `${who}: ${(err as Error).message}`; }
  }
  const ids = new Set<string>();
  for (const e of d.entities) {
    const m = validateEntity(e, d);
    if (m) return `${who}: ${m}`;
    if (ids.has(e.id)) return `${who}: el id "${e.id}" está repetido; los ids deben ser únicos dentro del dibujo.`;
    ids.add(e.id);
  }
  if (d.sheet && !(d.sheet.w > 0 && d.sheet.h > 0 && d.sheet.scale > 0)) return `${who}: sheet necesita w, h y scale mayores que 0.`;
  return validateBlocks(d);
}

/** Valida todos los dibujos de un proyecto (y que los ids de dibujo sean únicos). Null si todo está bien o no hay dibujos. */
export function validateDrawings(project: Pick<Project, 'drawings'>): string | null {
  if (project.drawings === undefined) return null;
  if (!Array.isArray(project.drawings)) return 'drawings debe ser una lista de dibujos.';
  const ids = new Set<string>();
  for (const d of project.drawings) {
    const m = validateDrawing(d);
    if (m) return m;
    if (ids.has(d.id)) return `Hay dos dibujos con el id "${d.id}"; los ids deben ser únicos en el proyecto.`;
    ids.add(d.id);
  }
  return null;
}

/**
 * Normaliza un dibujo leído de JSON: garantiza la capa "0", completa banderas de capa, quita undefined y valida.
 * Lanza DrawingError si no es recuperable. No modifica la entrada.
 */
export function normalizeDrawing(raw: Drawing): Drawing {
  const d = JSON.parse(JSON.stringify(raw)) as Drawing;
  if (!Array.isArray(d.layers)) d.layers = [];
  if (!d.layers.some((l) => l.name === LAYER_0)) d.layers.unshift(defaultLayer(LAYER_0));
  d.layers = d.layers.map((l) => ({ ...defaultLayer(l.name), ...l }));
  if (!Array.isArray(d.entities)) d.entities = [];
  if (d.origin === undefined) d.origin = [0, 0, 0];
  if (d.plane === undefined) d.plane = 'xy';
  const m = validateDrawing(d);
  if (m) fail(m);
  return d;
}

// ---------------------------------------------------------------- entradas de addEntity

interface Common { layer?: string; color?: DrawingColor | null; id?: string }
export type EntityInput = Common & (
  | { type: 'line'; a: Pt2; b: Pt2 }
  | { type: 'poly'; pts: (Pt2 | PolyVertex)[]; closed?: boolean }
  /** Rectángulo (azúcar): se guarda como poly cerrada de 4 vértices. Por dos esquinas o por origen (esquina) + w + h. */
  | { type: 'rect'; p1: Pt2; p2: Pt2 }
  | { type: 'rect'; origin: Pt2; w: number; h: number }
  | { type: 'circle'; c: Pt2; r: number }
  | { type: 'circle'; c: Pt2; d: number }
  | { type: 'circle'; pts: [Pt2, Pt2, Pt2] }
  | { type: 'arc'; c: Pt2; r: number; a0: number; a1: number }
  /** Arco por 3 puntos: de pts[0] a pts[2] pasando por pts[1]. */
  | { type: 'arc'; pts: [Pt2, Pt2, Pt2] }
  | { type: 'text'; p: Pt2; h: number; s: string; rot?: number; align?: 'left' | 'center' | 'right' }
  /** Sombreado: contornos como listas de vértices [x, y] o { p, bulge }; pattern por omisión "ansi31". */
  | { type: 'hatch'; loops: (Pt2 | PolyVertex)[][]; pattern?: HatchPattern; angle?: number; scale?: number; fillColor?: DrawingColor | null; source?: string[] }
  /** Inserción de un bloque existente. `scale` es un atajo para sx = sy. */
  | { type: 'insert'; block: string; p: Pt2; sx?: number; sy?: number; scale?: number; rot?: number; cols?: number; rows?: number; dx?: number; dy?: number }
  | ({ type: 'dim'; text?: string } & (
    | { kind: 'linear'; p1: Pt2; p2: Pt2; at: Pt2; rot?: number }
    | { kind: 'aligned'; p1: Pt2; p2: Pt2; at: Pt2 }
    | { kind: 'radius' | 'diameter'; c: Pt2; r: number; ang?: number }))
);

const num = (v: unknown, what: string): number => (fin(v) ? v : fail(`${what} debe ser un número finito.`));

/** Convierte una entrada (con azúcar) en la entidad canónica. No valida la capa ni asigna id si falta (lo hace addEntities). */
export function buildEntity(input: EntityInput, id: string, layer: string): Entity {
  const x = input as unknown as Record<string, unknown> & Common;
  const base = { id, layer, ...(x.color !== undefined && x.color !== null ? { color: x.color } : {}) };
  const pt = (p: unknown, what: string): Pt2 => (isPt(p) ? clonePt(p) : fail(`${what} debe ser [x, y] con números finitos (mm).`));
  switch (x.type) {
    case 'line': return { ...base, type: 'line', a: pt(x.a, 'a'), b: pt(x.b, 'b') };
    case 'poly': {
      if (!Array.isArray(x.pts)) return fail('poly necesita pts: lista de [x, y] o { p: [x, y], bulge }.');
      const pts = (x.pts as unknown[]).map((v, i): PolyVertex => {
        if (isPt(v)) return { p: clonePt(v) };
        const o = v as PolyVertex;
        if (o && isPt(o.p)) return o.bulge ? { p: clonePt(o.p), bulge: num(o.bulge, `pts[${i}].bulge`) } : { p: clonePt(o.p) };
        return fail(`pts[${i}] debe ser [x, y] o { p: [x, y], bulge? }.`);
      });
      return { ...base, type: 'poly', pts, ...(x.closed ? { closed: true as const } : {}) };
    }
    case 'rect': {
      let x0: number, y0: number, x1: number, y1: number;
      if ('origin' in x) {
        const o = pt(x.origin, 'origin'); x0 = o[0]; y0 = o[1]; x1 = o[0] + num(x.w, 'w'); y1 = o[1] + num(x.h, 'h');
      } else {
        const a = pt(x.p1, 'p1'), b = pt(x.p2, 'p2'); x0 = a[0]; y0 = a[1]; x1 = b[0]; y1 = b[1];
      }
      const [lx, hx, ly, hy] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
      if (hx - lx < 1e-9 || hy - ly < 1e-9) return fail('El rectángulo tiene ancho o alto 0; da dos esquinas distintas en x e y, o w y h distintos de 0.');
      return { ...base, type: 'poly', closed: true, pts: [{ p: [lx, ly] }, { p: [hx, ly] }, { p: [hx, hy] }, { p: [lx, hy] }] };
    }
    case 'circle': {
      if ('pts' in x) {
        const [a, b, c] = (Array.isArray(x.pts) && x.pts.length === 3 ? x.pts : fail('circle por 3 puntos necesita pts: [p1, p2, p3].')) as Pt2[];
        const k = circleFrom3Points(pt(a, 'pts[0]'), pt(b, 'pts[1]'), pt(c, 'pts[2]'));
        if (!k) return fail('Los 3 puntos del círculo están alineados o repetidos; no definen un círculo.');
        return { ...base, type: 'circle', c: k.c, r: k.r };
      }
      const r = 'd' in x ? num(x.d, 'd') / 2 : num(x.r, 'r');
      return { ...base, type: 'circle', c: pt(x.c, 'c'), r };
    }
    case 'arc': {
      if ('pts' in x) {
        const [a, b, c] = (Array.isArray(x.pts) && x.pts.length === 3 ? x.pts : fail('arc por 3 puntos necesita pts: [inicio, intermedio, fin].')) as Pt2[];
        const k = arcFrom3Points(pt(a, 'pts[0]'), pt(b, 'pts[1]'), pt(c, 'pts[2]'));
        if (!k) return fail('Los 3 puntos del arco están alineados o repetidos; no definen un arco.');
        return { ...base, type: 'arc', c: k.c, r: k.r, a0: k.a0, a1: k.a1 };
      }
      return { ...base, type: 'arc', c: pt(x.c, 'c'), r: num(x.r, 'r'), a0: num(x.a0, 'a0'), a1: num(x.a1, 'a1') };
    }
    case 'text': {
      const e: Entity = { ...base, type: 'text', p: pt(x.p, 'p'), h: num(x.h, 'h'), s: String(x.s ?? '') };
      if (x.rot) e.rot = num(x.rot, 'rot');
      if (x.align && x.align !== 'left') e.align = x.align as 'center' | 'right';
      return e;
    }
    case 'dim': {
      const text = typeof x.text === 'string' && x.text ? { text: x.text } : {};
      if (x.kind === 'linear') return { ...base, type: 'dim', kind: 'linear', p1: pt(x.p1, 'p1'), p2: pt(x.p2, 'p2'), at: pt(x.at, 'at'), ...(x.rot ? { rot: num(x.rot, 'rot') } : {}), ...text };
      if (x.kind === 'aligned') return { ...base, type: 'dim', kind: 'aligned', p1: pt(x.p1, 'p1'), p2: pt(x.p2, 'p2'), at: pt(x.at, 'at'), ...text };
      if (x.kind === 'radius' || x.kind === 'diameter') return { ...base, type: 'dim', kind: x.kind, c: pt(x.c, 'c'), r: num(x.r, 'r'), ...(x.ang !== undefined ? { ang: num(x.ang, 'ang') } : {}), ...text };
      return fail('dim necesita kind: "linear", "aligned", "radius" o "diameter".');
    }
    case 'hatch': {
      if (!Array.isArray(x.loops)) return fail('hatch necesita loops: lista de contornos, cada uno una lista de [x, y] o { p: [x, y], bulge }.');
      const loops = (x.loops as unknown[]).map((l, li) => {
        if (!Array.isArray(l)) return fail(`loops[${li}] debe ser una lista de vértices.`);
        return (l as unknown[]).map((v, i): PolyVertex => {
          if (isPt(v)) return { p: clonePt(v) };
          const o = v as PolyVertex;
          if (o && isPt(o.p)) return o.bulge ? { p: clonePt(o.p), bulge: num(o.bulge, `loops[${li}][${i}].bulge`) } : { p: clonePt(o.p) };
          return fail(`loops[${li}][${i}] debe ser [x, y] o { p: [x, y], bulge? }.`);
        });
      });
      const e: HatchEntity = { ...base, type: 'hatch', loops, pattern: (x.pattern ?? 'ansi31') as HatchPattern };
      if (x.angle) e.angle = num(x.angle, 'angle');
      if (x.scale !== undefined && x.scale !== null) e.scale = num(x.scale, 'scale');
      if (x.fillColor !== undefined && x.fillColor !== null) e.fillColor = x.fillColor as DrawingColor;
      if (Array.isArray(x.source) && x.source.length) e.source = [...(x.source as string[])];
      return e;
    }
    case 'insert': {
      const e: InsertEntity = { ...base, type: 'insert', block: String(x.block ?? ''), p: pt(x.p, 'p') };
      const sx = x.sx ?? x.scale, sy = x.sy ?? x.scale;
      if (sx !== undefined && sx !== 1) e.sx = num(sx, 'sx');
      if (sy !== undefined && sy !== 1) e.sy = num(sy, 'sy');
      if (x.rot) e.rot = num(x.rot, 'rot');
      if (x.cols !== undefined && x.cols !== 1) e.cols = num(x.cols, 'cols');
      if (x.rows !== undefined && x.rows !== 1) e.rows = num(x.rows, 'rows');
      if (e.cols || e.rows) { e.dx = num(x.dx ?? 0, 'dx'); e.dy = num(x.dy ?? 0, 'dy'); } else { if (x.dx) e.dx = num(x.dx, 'dx'); if (x.dy) e.dy = num(x.dy, 'dy'); }
      return e;
    }
    default: return fail(`type "${String(x.type)}" no existe. Tipos: line, poly, rect, circle, arc, text, dim, hatch, insert.`);
  }
}

// ---------------------------------------------------------------- entidades

function nextIdFactory(d: Drawing): () => string {
  let n = 0;
  for (const e of d.entities) { const m = /^e(\d+)$/.exec(e.id); if (m) n = Math.max(n, Number(m[1])); }
  const used = new Set(d.entities.map((e) => e.id));
  return () => { let id: string; do id = `e${++n}`; while (used.has(id)); used.add(id); return id; };
}
/** Id libre para una entidad nueva ("e1", "e2"…). */
export const nextEntityId = (d: Drawing): string => nextIdFactory(d)();

const editable = (d: Drawing, e: Entity, op: string): void => {
  const l = findLayer(d, e.layer);
  if (l?.locked) fail(`No se puede ${op} "${e.id}": su capa "${l.name}" está bloqueada (desbloquéala con setLayer).`);
  if (l?.frozen) fail(`No se puede ${op} "${e.id}": su capa "${l.name}" está congelada (descongélala con setLayer).`);
};

export interface AddResult { drawing: Drawing; ids: string[] }

/** Agrega varias entidades de una vez (todo o nada). Devuelve el dibujo nuevo y los ids asignados, en el mismo orden. */
export function addEntities(d: Drawing, inputs: EntityInput[]): AddResult {
  if (!Array.isArray(inputs)) return fail('addEntities necesita una lista de entidades.');
  const nextId = nextIdFactory(d);
  const made: Entity[] = [];
  inputs.forEach((inp, i) => {
    try {
      const layer = inp.layer === undefined ? LAYER_0 : (findLayer(d, inp.layer)?.name ?? fail(`la capa "${inp.layer}" no existe. Capas: ${layerList(d)}. Créala con addLayer.`));
      const lay = findLayer(d, layer)!;
      if (lay.locked || lay.frozen) fail(`la capa "${layer}" está ${lay.locked ? 'bloqueada' : 'congelada'}; cámbiala con setLayer o usa otra.`);
      if (inp.id !== undefined && (typeof inp.id !== 'string' || !inp.id || d.entities.some((e) => e.id === inp.id) || made.some((e) => e.id === inp.id))) fail(`el id "${String(inp.id)}" ya existe o no es válido.`);
      const e = buildEntity(inp, inp.id ?? nextId(), layer);
      if (e.type === 'insert') { const blk = (d.blocks ?? []).find((b) => b.name.toLowerCase() === e.block.toLowerCase()); if (blk) e.block = blk.name; }
      const msg = validateEntity(e, d);
      if (msg) fail(msg);
      made.push(e);
    } catch (err) {
      if (err instanceof DrawingError) throw new DrawingError(`Entidad #${i + 1} (${(inp as { type?: string })?.type}): ${err.message}`);
      throw err;
    }
  });
  return { drawing: { ...d, entities: [...d.entities, ...made] }, ids: made.map((e) => e.id) };
}
export function addEntity(d: Drawing, input: EntityInput): { drawing: Drawing; id: string } {
  const r = addEntities(d, [input]);
  return { drawing: r.drawing, id: r.ids[0] };
}

export const getEntity = (d: Drawing, id: string): Entity | undefined => d.entities.find((e) => e.id === id);

function pick(d: Drawing, ids: string | string[], op: string): Entity[] {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!list.length) return fail(`${op}: indica al menos un id de entidad.`);
  const out = list.map((id) => getEntity(d, id) ?? fail(`${op}: no existe la entidad "${id}". Ids: ${d.entities.slice(0, 20).map((e) => e.id).join(', ') || '(ninguno)'}${d.entities.length > 20 ? '…' : ''}.`));
  for (const e of out) editable(d, e, op);
  return out;
}
const replaceMany = (d: Drawing, repl: Map<string, Entity>): Drawing => ({ ...d, entities: d.entities.map((e) => repl.get(e.id) ?? e) });

/** Cambia campos de una entidad (no `id` ni `type`). `color: null` vuelve a PorCapa. Valida el resultado. */
export function updateEntity(d: Drawing, id: string, patch: Record<string, unknown>): Drawing {
  const [e] = pick(d, id, 'modificar');
  if ('id' in patch || 'type' in patch) return fail('No se puede cambiar el id ni el type de una entidad; borra y crea otra.');
  const next = { ...e, ...patch } as Record<string, unknown>;
  if (patch.color === null) delete next.color;
  if (typeof patch.layer === 'string') {
    const l = findLayer(d, patch.layer) ?? fail(`la capa "${patch.layer}" no existe. Capas: ${layerList(d)}.`);
    next.layer = l.name;
  }
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const msg = validateEntity(next as unknown as Entity, d);
  if (msg) return fail(msg);
  return replaceMany(d, new Map([[id, next as unknown as Entity]]));
}

export function removeEntity(d: Drawing, ids: string | string[]): Drawing {
  const list = pick(d, ids, 'borrar').map((e) => e.id);
  return { ...d, entities: d.entities.filter((e) => !list.includes(e.id)) };
}

// ---------------------------------------------------------------- transformaciones

interface Sim { dx: number; dy: number; rot: number; scale: number; center: Pt2 }
/** Transformación de semejanza: escala y gira alrededor de `center`, luego traslada (dx, dy). Sin espejos. */
export function transformEntity(e: Entity, m: Partial<Sim>): Entity {
  const s = m.scale ?? 1, rot = m.rot ?? 0, [cx, cy] = m.center ?? [0, 0], dx = m.dx ?? 0, dy = m.dy ?? 0;
  const cs = Math.cos((rot * Math.PI) / 180), sn = Math.sin((rot * Math.PI) / 180);
  const P = (p: Pt2): Pt2 => { const x = (p[0] - cx) * s, y = (p[1] - cy) * s; return [cx + x * cs - y * sn + dx, cy + x * sn + y * cs + dy]; };
  const A = (a: number) => (rot ? a + rot : a);
  switch (e.type) {
    case 'line': return { ...e, a: P(e.a), b: P(e.b) };
    case 'poly': return { ...e, pts: e.pts.map((v) => (v.bulge ? { p: P(v.p), bulge: v.bulge } : { p: P(v.p) })) };
    case 'circle': return { ...e, c: P(e.c), r: e.r * s };
    case 'arc': return { ...e, c: P(e.c), r: e.r * s, a0: rot ? norm360(e.a0 + rot) : e.a0, a1: rot ? norm360(e.a1 + rot) : e.a1 } as ArcEntity;
    case 'text': { const t = { ...e, p: P(e.p), h: e.h * s }; const r = A(e.rot ?? 0); if (r) t.rot = r; else delete t.rot; return t; }
    case 'dim':
      if (e.kind === 'linear') { const t = { ...e, p1: P(e.p1), p2: P(e.p2), at: P(e.at) }; const r = A(e.rot ?? 0); if (r) t.rot = r; else delete t.rot; return t; }
      if (e.kind === 'aligned') return { ...e, p1: P(e.p1), p2: P(e.p2), at: P(e.at) };
      return { ...e, c: P(e.c), r: e.r * s, ...(rot && e.ang !== undefined ? { ang: e.ang + rot } : {}) };
    case 'hatch': {
      const h: HatchEntity = { ...e, loops: e.loops.map((l) => l.map((v) => (v.bulge ? { p: P(v.p), bulge: v.bulge } : { p: P(v.p) }))) };
      const ang = A(e.angle ?? 0);
      if (ang) h.angle = norm360(ang); else delete h.angle;
      if (e.scale !== undefined && s !== 1) h.scale = e.scale * s;
      return h;
    }
    case 'insert': {
      const i: InsertEntity = { ...e, p: P(e.p) };
      const r = A(e.rot ?? 0);
      if (r) i.rot = norm360(r); else delete i.rot;
      if (s !== 1) { i.sx = (e.sx ?? 1) * s; i.sy = (e.sy ?? 1) * s; if (e.dx) i.dx = e.dx * s; if (e.dy) i.dy = e.dy * s; }
      return i;
    }
  }
}
function transformMany(d: Drawing, ids: string | string[], op: string, m: Partial<Sim>): Drawing {
  const repl = new Map<string, Entity>();
  for (const e of pick(d, ids, op)) repl.set(e.id, transformEntity(e, m));
  return replaceMany(d, repl);
}

const vec = (v: unknown, what: string): Pt2 => (isPt(v) ? v : fail(`${what} debe ser [x, y] con números finitos (mm).`));

export function moveEntities(d: Drawing, ids: string | string[], delta: Pt2): Drawing {
  const [dx, dy] = vec(delta, 'El desplazamiento');
  return transformMany(d, ids, 'mover', { dx, dy });
}
/** Gira `angle` grados (antihorario) alrededor de `center`. */
export function rotateEntities(d: Drawing, ids: string | string[], center: Pt2, angle: number): Drawing {
  return transformMany(d, ids, 'girar', { center: vec(center, 'El centro'), rot: num(angle, 'El ángulo (grados)') });
}
/** Escala `factor` (> 0, sin espejos) respecto de `center`. */
export function scaleEntities(d: Drawing, ids: string | string[], center: Pt2, factor: number): Drawing {
  if (!fin(factor) || factor <= 0) return fail('El factor de escala debe ser un número mayor que 0 (los espejos no están soportados).');
  return transformMany(d, ids, 'escalar', { center: vec(center, 'El centro'), scale: factor });
}
/** Copia las entidades `count` veces, cada una desplazada `delta` más que la anterior. Los ids nuevos se devuelven agrupados por copia. */
export function copyEntities(d: Drawing, ids: string | string[], delta: Pt2, count = 1): AddResult {
  const src = pick(d, ids, 'copiar');
  const [dx, dy] = vec(delta, 'El desplazamiento');
  if (!Number.isInteger(count) || count < 1 || count > 1000) return fail('count debe ser un entero entre 1 y 1000.');
  const nextId = nextIdFactory(d);
  const made: Entity[] = [];
  for (let k = 1; k <= count; k++) for (const e of src) made.push({ ...transformEntity(e, { dx: dx * k, dy: dy * k }), id: nextId() });
  return { drawing: { ...d, entities: [...d.entities, ...made] }, ids: made.map((e) => e.id) };
}

// ---------------------------------------------------------------- offset

/**
 * Paralela a una línea, círculo, arco o polilínea SIN arcos (bulge), a `distance` mm. Línea y polilínea: positivo = a la izquierda del
 * sentido de recorrido (negativo, a la derecha); círculo y arco: positivo = hacia afuera (radio mayor). La polilínea usa esquinas a inglete.
 * Agrega la entidad nueva (misma capa y color) y devuelve su id.
 */
export function offsetEntity(d: Drawing, id: string, distance: number): { drawing: Drawing; id: string } {
  const [e] = pick(d, id, 'desfasar');
  if (!fin(distance) || distance === 0) return fail('La distancia de offset debe ser un número distinto de 0 (mm).');
  let made: Entity;
  const nid = nextEntityId(d);
  switch (e.type) {
    case 'line': {
      const L = dist(e.a, e.b), nx = -(e.b[1] - e.a[1]) / L, ny = (e.b[0] - e.a[0]) / L;
      made = { ...e, id: nid, a: [e.a[0] + nx * distance, e.a[1] + ny * distance], b: [e.b[0] + nx * distance, e.b[1] + ny * distance] };
      break;
    }
    case 'circle': case 'arc': {
      const r = e.r + distance;
      if (r <= 1e-9) return fail(`El offset de ${distance} mm deja un radio ${r} ≤ 0 (el radio actual es ${e.r}); usa una distancia mayor que -${e.r}.`);
      made = { ...e, id: nid, r };
      break;
    }
    case 'poly': {
      if (e.pts.some((v) => v.bulge)) return fail('offset de polilíneas con arcos (bulge) no está soportado; descompón la polilínea o desfasa sus tramos por separado.');
      const pts = dedupePoly(e.pts, !!e.closed).map((v) => v.p);
      const n = pts.length, edges = e.closed ? n : n - 1;
      if (edges < 1) return fail('La polilínea no tiene tramos.');
      const lines = Array.from({ length: edges }, (_, i) => {
        const a = pts[i], b = pts[(i + 1) % n], L = dist(a, b), nx = -(b[1] - a[1]) / L, ny = (b[0] - a[0]) / L;
        return [[a[0] + nx * distance, a[1] + ny * distance], [b[0] + nx * distance, b[1] + ny * distance]] as [Pt2, Pt2];
      });
      const out: PolyVertex[] = [];
      for (let i = 0; i < n; i++) {
        const prev = e.closed ? lines[(i - 1 + edges) % edges] : lines[i - 1];
        const next = e.closed ? lines[i % edges] : lines[i];
        if (!prev) out.push({ p: next[0] });
        else if (!next) out.push({ p: prev[1] });
        else out.push({ p: intersectLines(prev[0], prev[1], next[0], next[1])?.p ?? next[0] });
      }
      made = { ...e, id: nid, pts: out };
      break;
    }
    default: return fail(`offset no se aplica a entidades de tipo ${e.type}; usa line, poly, circle o arc.`);
  }
  const msg = validateEntity(made, d);
  if (msg) return fail(msg);
  return { drawing: { ...d, entities: [...d.entities, made] }, id: nid };
}

// ---------------------------------------------------------------- proyecto

/** Dibujo del proyecto por id o por nombre (sin distinguir mayúsculas). */
export const findDrawing = (project: Pick<Project, 'drawings'>, idOrName: string): Drawing | undefined =>
  (project.drawings ?? []).find((x) => x.id === idOrName) ?? (project.drawings ?? []).find((x) => x.name.toLowerCase() === idOrName.toLowerCase());

/** Proyecto nuevo con el dibujo agregado o reemplazado (por id). No toca nada más del proyecto. */
export function withDrawing(project: Project, drawing: Drawing): Project {
  const list = project.drawings ?? [];
  const i = list.findIndex((x) => x.id === drawing.id);
  return { ...project, drawings: i >= 0 ? list.map((x, j) => (j === i ? drawing : x)) : [...list, drawing] };
}
/** Proyecto sin el dibujo `id`. Si era el último deja `drawings` ausente (el JSON queda como antes de existir los dibujos). */
export function withoutDrawing(project: Project, id: string): Project {
  if (!project.drawings?.some((x) => x.id === id)) return fail(`No existe el dibujo "${id}". Dibujos: ${(project.drawings ?? []).map((x) => x.id).join(', ') || '(ninguno)'}.`);
  const { drawings, ...rest } = project;
  const left = drawings!.filter((x) => x.id !== id);
  return left.length ? { ...rest, drawings: left } : rest;
}
