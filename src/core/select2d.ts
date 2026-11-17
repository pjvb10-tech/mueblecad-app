import { blockCtx } from './blocks';
import { dist, distPointEntity, entityBounds, pointInPolygon, textCorners } from './geom2d';
import type { BlockCtx } from './geom2d';
import { hatchPickDistance } from './hatch';
import type { Bounds } from './geom2d';
import { boundsInside, boundsOverlap, buildIndex, entityPrims, intersectPrims, layerVisible } from './prims2d';
import type { IndexItem, Prim, SpatialIndex } from './prims2d';
import { findLayer } from './drawing';
import type { Drawing, Entity, Pt2 } from './types';

/**
 * Selección de entidades del dibujo 2D: clic con tolerancia, ciclado entre solapadas, ventana / cruce / valla y alternar con Mays.
 * Puro: sin DOM. Ignora capas apagadas o congeladas (no se ven) y, salvo `includeLocked`, las bloqueadas (no se pueden editar).
 * Para dibujos grandes (>= 2000 entidades) construye un índice de rejilla; pasa uno propio (buildIndex) para reutilizarlo entre eventos.
 */

export { buildIndex } from './prims2d';
export type { SpatialIndex } from './prims2d';

export interface SelectOptions {
  /** Incluir entidades de capas bloqueadas (solo para resaltar o consultar; no se pueden editar). Por omisión false. */
  includeLocked?: boolean;
  index?: SpatialIndex;
}

const eps = 1e-9;

function candidates(d: Drawing, box: Bounds, o: SelectOptions): IndexItem[] {
  const keep = (it: IndexItem) => o.includeLocked || !it.locked;
  if (o.index) return o.index.query(box).filter(keep);
  if (d.entities.length >= 2000) return buildIndex(d).query(box).filter(keep);
  const out: IndexItem[] = [];
  const bctx = blockCtx(d);
  d.entities.forEach((e, order) => {
    if (!layerVisible(d, e.layer)) return;
    const locked = !!findLayer(d, e.layer)?.locked;
    if (locked && !o.includeLocked) return;
    const b = entityBounds(e, bctx);
    if (b && boundsOverlap(b, box)) out.push({ e, b, locked, order });
  });
  return out;
}

/**
 * Entidades bajo el punto `p` (a menos de `tolerance` mm), ordenadas de la más cercana a la más lejana; a igual distancia, la dibujada
 * más tarde (encima) primero. Úsalo con `cyclePick` para recorrer las solapadas.
 */
export function pickAt(drawing: Drawing, p: Pt2, tolerance: number, opts: SelectOptions = {}): string[] {
  const box: Bounds = { min: [p[0] - tolerance, p[1] - tolerance], max: [p[0] + tolerance, p[1] + tolerance] };
  const ctx = blockCtx(drawing);
  return candidates(drawing, box, opts)
    .map((it) => ({ it, d: it.e.type === 'hatch' ? hatchPickDistance(it.e, p, tolerance) : distPointEntity(p, it.e, ctx) }))
    .filter((x) => x.d <= tolerance + eps)
    .sort((a, b) => (Math.abs(a.d - b.d) > 1e-6 ? a.d - b.d : b.it.order - a.it.order))
    .map((x) => x.it.e.id);
}

/**
 * Elige el siguiente candidato al hacer clic repetido en el mismo sitio: si `current` está en la lista, devuelve el que sigue
 * (vuelve al primero al llegar al final); si no, el primero. Lista vacía: null.
 */
export function cyclePick(cands: string[], current?: string | null): string | null {
  if (!cands.length) return null;
  const i = current ? cands.indexOf(current) : -1;
  return cands[(i + 1) % cands.length];
}

/** Combina una selección con lo recién tocado: sin Mays reemplaza; con Mays alterna cada id (quita los presentes, agrega los nuevos). */
export function applySelection(current: string[], hit: string[], shift = false): string[] {
  if (!shift) return [...new Set(hit)];
  const cur = new Set(current), out = new Set(current);
  for (const id of hit) { if (cur.has(id)) out.delete(id); else out.add(id); }
  return [...out];
}

// ---------------------------------------------------------------- ventana / cruce

export type BoxMode = 'window' | 'crossing';
const rectBounds = (p1: Pt2, p2: Pt2): Bounds => ({ min: [Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1])], max: [Math.max(p1[0], p2[0]), Math.max(p1[1], p2[1])] });
/** Orientación CAD: de izquierda a derecha = ventana (contenidas); de derecha a izquierda = cruce (tocadas). */
export const boxModeOf = (p1: Pt2, p2: Pt2): BoxMode => (p2[0] < p1[0] ? 'crossing' : 'window');

const inRect = (p: Pt2, r: Bounds) => p[0] >= r.min[0] - eps && p[0] <= r.max[0] + eps && p[1] >= r.min[1] - eps && p[1] <= r.max[1] + eps;
const edgesOf = (r: Bounds): Prim[] => {
  const [x0, y0] = r.min, [x1, y1] = r.max;
  return [{ k: 's', a: [x0, y0], b: [x1, y0] }, { k: 's', a: [x1, y0], b: [x1, y1] }, { k: 's', a: [x1, y1], b: [x0, y1] }, { k: 's', a: [x0, y1], b: [x0, y0] }];
};
const primEndsIn = (p: Prim, r: Bounds): boolean => {
  if (p.k === 's') return inRect(p.a, r) || inRect(p.b, r);
  if (p.full) return false;
  const rad = Math.PI / 180;
  return [p.a0, p.a1].some((a) => inRect([p.c[0] + p.r * Math.cos(a * rad), p.c[1] + p.r * Math.sin(a * rad)], r));
};

function touchesRect(e: Entity, b: Bounds, r: Bounds, edges: Prim[], ctx: BlockCtx): boolean {
  if (!boundsOverlap(b, r)) return false;
  if (boundsInside(b, r)) return true;
  if (e.type === 'text' && textCorners(e).length && pointInPolygon(r.min, textCorners(e))) return true; // la ventana cae dentro del texto
  for (const pr of entityPrims(e, ctx)) {
    if (primEndsIn(pr, r)) return true;
    for (const ed of edges) if (intersectPrims(pr, ed).length) return true;
  }
  return false;
}

export interface BoxResult { ids: string[]; mode: BoxMode }
/**
 * Selección por rectángulo entre dos esquinas. `mode` "auto" (por omisión) usa la orientación: derecha→izquierda = cruce.
 * Ventana: solo entidades completamente dentro. Cruce: las que están dentro o tocan el borde.
 */
export function selectBox(drawing: Drawing, p1: Pt2, p2: Pt2, opts: SelectOptions & { mode?: 'auto' | BoxMode } = {}): BoxResult {
  const mode = opts.mode && opts.mode !== 'auto' ? opts.mode : boxModeOf(p1, p2);
  const r = rectBounds(p1, p2), edges = mode === 'crossing' ? edgesOf(r) : [], bctx = blockCtx(drawing);
  const ids: string[] = [];
  for (const it of candidates(drawing, r, opts)) {
    if (mode === 'window' ? boundsInside(it.b, r) : touchesRect(it.e, it.b, r, edges, bctx)) ids.push(it.e.id);
  }
  return { ids, mode };
}

// ---------------------------------------------------------------- valla

/** Selección por valla: entidades que toca la polilínea abierta `fence` (2 o más puntos). */
export function selectFence(drawing: Drawing, fence: Pt2[], opts: SelectOptions = {}): string[] {
  if (fence.length < 2) return [];
  const segs: (Prim & { k: 's' })[] = [];
  for (let i = 0; i + 1 < fence.length; i++) if (dist(fence[i], fence[i + 1]) > eps) segs.push({ k: 's', a: fence[i], b: fence[i + 1] });
  if (!segs.length) return [];
  const xs = fence.map((q) => q[0]), ys = fence.map((q) => q[1]);
  const box: Bounds = { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
  const ids: string[] = [];
  const fctx = blockCtx(drawing);
  for (const it of candidates(drawing, box, opts)) {
    const hit = entityPrims(it.e, fctx).some((pr) => segs.some((s) => intersectPrims(pr, s).length || (pr.k === 's' && distSegSeg0(pr, s))));
    if (hit) ids.push(it.e.id);
  }
  return ids;
}
// segmentos colineales que se solapan (intersectPrims no los reporta): se considera tocado si un extremo de uno cae sobre el otro
function distSegSeg0(a: Prim & { k: 's' }, b: Prim & { k: 's' }): boolean {
  const onSeg = (p: Pt2, s: Prim & { k: 's' }) => Math.abs(dist(s.a, p) + dist(p, s.b) - dist(s.a, s.b)) < 1e-7;
  return onSeg(a.a, b) || onSeg(a.b, b) || onSeg(b.a, a) || onSeg(b.b, a);
}

/** Todas las entidades seleccionables (visibles y editables salvo includeLocked), útil para "Seleccionar todo". */
export function selectAll(drawing: Drawing, opts: SelectOptions = {}): string[] {
  return drawing.entities.filter((e) => layerVisible(drawing, e.layer) && (opts.includeLocked || !findLayer(drawing, e.layer)?.locked)).map((e) => e.id);
}
