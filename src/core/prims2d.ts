import { angleInArc, bulgeArc, dimGeometry, dist, entityBounds, intersectCircles, intersectLineCircle, intersectSegments, pointsOnArc, polySegments, textCorners } from './geom2d';
import type { BlockCtx, Bounds } from './geom2d';
import { blockCtx } from './blocks';
import { findLayer } from './drawing';
import type { Drawing, Entity, Pt2 } from './types';

/**
 * Primitivas geométricas (segmentos y arcos) y un índice espacial de rejilla. Base común de snap2d y select2d. Puro: sin DOM.
 * Ángulos en grados, antihorario. Un círculo es un arco `full` (a0 = a1 = 0).
 */

export type Prim = { k: 's'; a: Pt2; b: Pt2 } | { k: 'a'; c: Pt2; r: number; a0: number; a1: number; full: boolean };

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const polarPt = (c: Pt2, r: number, deg: number): Pt2 => [c[0] + r * Math.cos(deg * RAD), c[1] + r * Math.sin(deg * RAD)];
const angleTo = (c: Pt2, p: Pt2): number => Math.atan2(p[1] - c[1], p[0] - c[0]) * DEG;

/** Descompone una entidad en segmentos y arcos (poly con bulge incluida; texto = su caja; cota = sus líneas). */
export function entityPrims(e: Entity, ctx?: BlockCtx): Prim[] {
  switch (e.type) {
    case 'line': return [{ k: 's', a: e.a, b: e.b }];
    case 'circle': return [{ k: 'a', c: e.c, r: e.r, a0: 0, a1: 0, full: true }];
    case 'arc': return [{ k: 'a', c: e.c, r: e.r, a0: e.a0, a1: e.a1, full: Math.abs((((e.a1 - e.a0) % 360) + 360) % 360) < 1e-9 }];
    case 'poly': return polySegments(e).map((s): Prim => { const arc = bulgeArc(s.a, s.b, s.bulge); return arc ? { k: 'a', c: arc.c, r: arc.r, a0: arc.a0, a1: arc.a1, full: false } : { k: 's', a: s.a, b: s.b }; });
    case 'text': { const q = textCorners(e); return q.map((p, i): Prim => ({ k: 's', a: p, b: q[(i + 1) % 4] })); }
    case 'dim': return dimGeometry(e).lines.map(([a, b]): Prim => ({ k: 's', a, b }));
    case 'hatch': return e.loops.flatMap((l) => entityPrims({ id: e.id, layer: e.layer, type: 'poly', pts: l, closed: true }));
    case 'insert': return (ctx?.resolveInsert(e) ?? []).flatMap((c) => entityPrims(c, ctx));
  }
}

export const primEnds = (p: Prim): [Pt2, Pt2] | null => (p.k === 's' ? [p.a, p.b] : p.full ? null : [polarPt(p.c, p.r, p.a0), polarPt(p.c, p.r, p.a1)]);
const onPrimArc = (p: Prim & { k: 'a' }, pts: Pt2[]): Pt2[] => (p.full ? pts : pointsOnArc(pts, p.c, p.a0, p.a1));

/** Puntos de intersección de dos primitivas (0, 1 o 2; la tangencia da 1). Segmentos colineales o círculos iguales no devuelven nada. */
export function intersectPrims(p: Prim, q: Prim): Pt2[] {
  if (p.k === 's' && q.k === 's') { const r = intersectSegments(p.a, p.b, q.a, q.b, 1e-9); return r ? [r] : []; }
  if (p.k === 's' && q.k === 'a') return onPrimArc(q, intersectLineCircle(p.a, p.b, q.c, q.r, { segment: true }));
  if (p.k === 'a' && q.k === 's') return intersectPrims(q, p);
  if (p.k === 'a' && q.k === 'a') return onPrimArc(p, onPrimArc(q, intersectCircles(p.c, p.r, q.c, q.r)));
  return [];
}

/** Punto de la primitiva más cercano a `pt`. */
export function nearestOnPrim(pt: Pt2, p: Prim): Pt2 {
  if (p.k === 's') {
    const dx = p.b[0] - p.a[0], dy = p.b[1] - p.a[1], l2 = dx * dx + dy * dy;
    if (l2 < 1e-18) return p.a;
    const t = Math.max(0, Math.min(1, ((pt[0] - p.a[0]) * dx + (pt[1] - p.a[1]) * dy) / l2));
    return [p.a[0] + t * dx, p.a[1] + t * dy];
  }
  const a = dist(pt, p.c) < 1e-12 ? p.a0 : angleTo(p.c, pt);
  if (p.full || angleInArc(a, p.a0, p.a1)) return polarPt(p.c, p.r, a);
  const [s, e] = primEnds(p)!;
  return dist(pt, s) <= dist(pt, e) ? s : e;
}
export const distPointPrim = (pt: Pt2, p: Prim): number => dist(pt, nearestOnPrim(pt, p));

/** Pies de perpendicular desde `from` a la primitiva (solo los que caen sobre ella). Arco: los dos puntos radiales. */
export function perpFeet(from: Pt2, p: Prim): Pt2[] {
  if (p.k === 's') {
    const dx = p.b[0] - p.a[0], dy = p.b[1] - p.a[1], l2 = dx * dx + dy * dy;
    if (l2 < 1e-18) return [];
    const t = ((from[0] - p.a[0]) * dx + (from[1] - p.a[1]) * dy) / l2;
    return t >= -1e-9 && t <= 1 + 1e-9 ? [[p.a[0] + t * dx, p.a[1] + t * dy]] : [];
  }
  if (dist(from, p.c) < 1e-12) return [];
  const a = angleTo(p.c, from);
  return onPrimArc(p, [polarPt(p.c, p.r, a), polarPt(p.c, p.r, a + 180)]);
}

/** Puntos de tangencia de las rectas que salen de `from` y tocan el arco/círculo. Vacío para segmentos o si `from` está dentro. */
export function tangentFeet(from: Pt2, p: Prim): Pt2[] {
  if (p.k !== 'a') return [];
  const d = dist(from, p.c);
  if (d < p.r - 1e-9) return [];
  if (d <= p.r + 1e-9) return onPrimArc(p, [from]);
  const phi = angleTo(p.c, from), off = Math.acos(p.r / d) * DEG;
  return onPrimArc(p, [polarPt(p.c, p.r, phi + off), polarPt(p.c, p.r, phi - off)]);
}

// ---------------------------------------------------------------- visibilidad e índice espacial

/** ¿La capa de la entidad se ve (activa y no congelada)? */
export const layerVisible = (d: Drawing, layerName: string): boolean => { const l = findLayer(d, layerName); return !l || (l.on && !l.frozen); };

export interface IndexItem { e: Entity; b: Bounds; /** capa bloqueada: visible y se puede referenciar, pero no editar */ locked: boolean; /** posición en el dibujo (orden de apilado) */ order: number; _q?: number }

export const boundsOverlap = (a: Bounds, b: Bounds): boolean => a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1];
export const boundsInside = (inner: Bounds, outer: Bounds): boolean => inner.min[0] >= outer.min[0] && inner.max[0] <= outer.max[0] && inner.min[1] >= outer.min[1] && inner.max[1] <= outer.max[1];

/** Índice de rejilla uniforme sobre las cajas de las entidades visibles (capas activas y no congeladas). */
export class SpatialIndex {
  readonly items: IndexItem[] = [];
  private cells = new Map<number, IndexItem[]>();
  private big: IndexItem[] = [];
  private n = 1;
  private x0 = 0; private y0 = 0; private cw = 1; private ch = 1;
  private q = 0;

  constructor(d: Drawing) {
    const lay = new Map<string, { vis: boolean; locked: boolean }>();
    for (const l of d.layers) lay.set(l.name, { vis: l.on && !l.frozen, locked: l.locked });
    const bctx = blockCtx(d);
    for (const e of d.entities) {
      const s = lay.get(e.layer) ?? { vis: true, locked: false };
      if (!s.vis) continue;
      const b = entityBounds(e, bctx);
      if (b) this.items.push({ e, b, locked: s.locked, order: this.items.length });
    }
    if (!this.items.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const it of this.items) { minX = Math.min(minX, it.b.min[0]); minY = Math.min(minY, it.b.min[1]); maxX = Math.max(maxX, it.b.max[0]); maxY = Math.max(maxY, it.b.max[1]); }
    this.n = Math.max(1, Math.min(512, Math.ceil(Math.sqrt(this.items.length))));
    this.x0 = minX; this.y0 = minY;
    this.cw = Math.max((maxX - minX) / this.n, 1e-6); this.ch = Math.max((maxY - minY) / this.n, 1e-6);
    for (const it of this.items) {
      const [i0, i1, j0, j1] = this.range(it.b);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 256) { this.big.push(it); continue; }
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = i * 100000 + j;
        const cell = this.cells.get(k);
        if (cell) cell.push(it); else this.cells.set(k, [it]);
      }
    }
  }
  private range(b: Bounds): [number, number, number, number] {
    const cl = (v: number) => Math.max(0, Math.min(this.n - 1, v));
    return [cl(Math.floor((b.min[0] - this.x0) / this.cw)), cl(Math.floor((b.max[0] - this.x0) / this.cw)), cl(Math.floor((b.min[1] - this.y0) / this.ch)), cl(Math.floor((b.max[1] - this.y0) / this.ch))];
  }
  /** Items cuya caja toca `box` (sin repetidos, en orden de dibujo). */
  query(box: Bounds): IndexItem[] {
    if (!this.items.length) return [];
    const [i0, i1, j0, j1] = this.range(box);
    const qid = ++this.q, out: IndexItem[] = [];
    const take = (it: IndexItem) => { if (it._q !== qid) { it._q = qid; if (boundsOverlap(it.b, box)) out.push(it); } };
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const c = this.cells.get(i * 100000 + j); if (c) c.forEach(take); }
    this.big.forEach(take);
    return out.sort((a, b) => a.order - b.order);
  }
}
export const buildIndex = (d: Drawing): SpatialIndex => new SpatialIndex(d);
