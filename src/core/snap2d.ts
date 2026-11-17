import { blockCtx } from './blocks';
import { angleInArc, dist, entityBounds, norm360, sweepOf } from './geom2d';
import { boundsOverlap, buildIndex, distPointPrim, entityPrims, intersectPrims, layerVisible, nearestOnPrim, perpFeet, primEnds, tangentFeet } from './prims2d';
import type { Prim, SpatialIndex } from './prims2d';
import type { Drawing, Entity, Pt2 } from './types';

/**
 * Imán (snap) de objetos para el cursor del dibujo 2D. Puro: sin DOM. El llamador calcula `aperture` en unidades de dibujo
 * (píxeles de apertura × unidades por píxel del zoom). Solo cuentan entidades de capas activas y no congeladas (las bloqueadas sí
 * se pueden referenciar). Prioridad de los modos de objeto: end > int > mid > cen > qua > per > tan > nea; después ortho/polar
 * (relativos a `base`) y por último la rejilla. Contrato y ejemplo de cableado: docs/dibujo-2d.md, "Herramientas de ratón".
 */

export type SnapMode = 'end' | 'mid' | 'cen' | 'qua' | 'int' | 'per' | 'tan' | 'nea' | 'grid' | 'ortho' | 'polar';
export type SnapMarker = 'square' | 'triangle' | 'circle' | 'diamond' | 'x' | 'perp' | 'tangent' | 'near' | 'dot' | 'cross';

export interface SnapOptions {
  /** Radio de captura en unidades de dibujo (mm). */
  aperture: number;
  modes: Partial<Record<SnapMode, boolean>>;
  /** Punto anterior: necesario para ortho, polar, perpendicular y tangente. */
  base?: Pt2 | null;
  gridStep?: number;
  /** Incremento polar en grados (45 por omisión). */
  polarInc?: number;
  /** Índice precalculado (buildIndex) para dibujos grandes; se reutiliza mientras el dibujo no cambie. */
  index?: SpatialIndex;
  /** Ids a ignorar (p. ej. la entidad que se está moviendo). */
  exclude?: string[];
}
export interface SnapResult {
  point: Pt2;
  mode: SnapMode | 'none';
  entityId?: string;
  /** Texto para la etiqueta flotante, en español. */
  label: string;
  marker?: SnapMarker;
  /** Línea de rastreo (ortho/polar): del punto base al punto resultante. */
  guide?: [Pt2, Pt2];
}

export const ALL_OBJECT_MODES: SnapMode[] = ['end', 'int', 'mid', 'cen', 'qua', 'per', 'tan', 'nea'];
const LABEL: Record<SnapMode, string> = { end: 'Extremo', mid: 'Punto medio', cen: 'Centro', qua: 'Cuadrante', int: 'Intersección', per: 'Perpendicular', tan: 'Tangente', nea: 'Cercano', grid: 'Cuadrícula', ortho: 'Ortogonal', polar: 'Polar' };
const MARKER: Record<SnapMode, SnapMarker> = { end: 'square', mid: 'triangle', cen: 'circle', qua: 'diamond', int: 'x', per: 'perp', tan: 'tangent', nea: 'near', grid: 'dot', ortho: 'cross', polar: 'cross' };
const RANK: Record<string, number> = { end: 0, int: 1, mid: 2, cen: 3, qua: 4, per: 5, tan: 6, nea: 7 };

/** Apertura en unidades de dibujo a partir de píxeles y unidades por píxel (mm/px). */
export const apertureFromPixels = (px: number, unitsPerPixel: number): number => Math.max(px * unitsPerPixel, 1e-9);

interface Cand { p: Pt2; mode: SnapMode; id?: string; d: number; label?: string }
const polar = (c: Pt2, r: number, deg: number): Pt2 => [c[0] + r * Math.cos((deg * Math.PI) / 180), c[1] + r * Math.sin((deg * Math.PI) / 180)];

/** Puntos característicos de una entidad (end/mid/cen/qua) ya filtrados por modos. */
function featurePoints(e: Entity, prims: Prim[], modes: SnapOptions['modes']): Cand[] {
  const out: Cand[] = [];
  const push = (p: Pt2, mode: SnapMode, label?: string) => out.push({ p, mode, id: e.id, d: 0, label });
  if (modes.end) {
    if (e.type === 'text') push(e.p, 'end', 'Inserción');
    else if (e.type === 'dim') { if (e.kind === 'linear' || e.kind === 'aligned') { push(e.p1, 'end'); push(e.p2, 'end'); } }
    else if (e.type === 'poly') e.pts.forEach((v) => push(v.p, 'end'));
    else for (const pr of prims) { const ends = primEnds(pr); if (ends) { push(ends[0], 'end'); push(ends[1], 'end'); } }
  }
  if (e.type === 'text' || e.type === 'dim') {
    if (modes.cen && e.type === 'dim' && (e.kind === 'radius' || e.kind === 'diameter')) push(e.c, 'cen');
    return out;
  }
  for (const pr of prims) {
    if (pr.k === 's') { if (modes.mid) push([(pr.a[0] + pr.b[0]) / 2, (pr.a[1] + pr.b[1]) / 2], 'mid'); continue; }
    if (modes.cen) push(pr.c, 'cen');
    if (modes.mid && !pr.full) push(polar(pr.c, pr.r, pr.a0 + sweepOf(pr.a0, pr.a1) / 2), 'mid');
    if (modes.qua) for (const q of [0, 90, 180, 270]) if (pr.full || angleInArc(q, pr.a0, pr.a1)) push(polar(pr.c, pr.r, q), 'qua');
  }
  return out;
}

/**
 * Punto imantado más conveniente para `cursor`. Si ningún modo aplica, devuelve el cursor tal cual con mode "none".
 */
export function snapPoint(drawing: Drawing, cursor: Pt2, opts: SnapOptions): SnapResult {
  const ap = opts.aperture, modes = opts.modes, base = opts.base ?? null;
  const objectOn = ALL_OBJECT_MODES.some((m) => modes[m]);
  if (objectOn) {
    const r = objectSnap(drawing, cursor, opts);
    if (r) return r;
  }
  if (base && (modes.ortho || modes.polar)) {
    const r = trackSnap(cursor, base, !!modes.ortho, opts.polarInc ?? 45, ap, modes.grid ? opts.gridStep : undefined);
    if (r) return r;
  }
  if (modes.grid && opts.gridStep && opts.gridStep > 0) {
    const g = opts.gridStep;
    const p: Pt2 = [Math.round(cursor[0] / g) * g, Math.round(cursor[1] / g) * g];
    return { point: clean(p), mode: 'grid', label: LABEL.grid, marker: MARKER.grid };
  }
  return { point: cursor, mode: 'none', label: '' };
}

const clean = (p: Pt2): Pt2 => [Number(p[0].toFixed(9)), Number(p[1].toFixed(9))];

function trackSnap(cursor: Pt2, base: Pt2, ortho: boolean, inc: number, ap: number, gridStep?: number): SnapResult | null {
  const dx = cursor[0] - base[0], dy = cursor[1] - base[1], r = Math.hypot(dx, dy);
  if (r < 1e-12) return null;
  let target: number, len: number, mode: SnapMode;
  if (ortho) {
    const horiz = Math.abs(dx) >= Math.abs(dy);
    target = horiz ? (dx >= 0 ? 0 : 180) : dy >= 0 ? 90 : 270;
    len = horiz ? Math.abs(dx) : Math.abs(dy);
    mode = 'ortho';
  } else {
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    target = norm360(Math.round(ang / inc) * inc);
    const diff = Math.abs(((ang - target + 540) % 360) - 180);
    if (r * Math.sin((Math.min(diff, 90) * Math.PI) / 180) > ap) return null;
    len = r * Math.cos((diff * Math.PI) / 180);
    mode = 'polar';
  }
  if (gridStep && gridStep > 0) len = Math.round(len / gridStep) * gridStep;
  const p = clean(polar(base, len, target));
  const label = mode === 'ortho' ? `Ortogonal ${fmt(len)}` : `Polar ${fmt(len)} < ${fmt(target)}°`;
  return { point: p, mode, label, marker: MARKER[mode], guide: [base, p] };
}
const fmt = (n: number) => String(Number(n.toFixed(2)));

function objectSnap(drawing: Drawing, cursor: Pt2, opts: SnapOptions): SnapResult | null {
  const ap = opts.aperture, modes = opts.modes, base = opts.base ?? null;
  const box = { min: [cursor[0] - ap, cursor[1] - ap] as Pt2, max: [cursor[0] + ap, cursor[1] + ap] as Pt2 };
  const ex = opts.exclude?.length ? new Set(opts.exclude) : null;
  let ents: Entity[];
  const bctx = blockCtx(drawing);
  if (opts.index) ents = opts.index.query(box).map((it) => it.e);
  else ents = buildEntitiesNear(drawing, box);
  // los inserts se imantan por su geometría resuelta; los sombreados no se imantan
  ents = ents.flatMap((e) => (e.type === 'insert' ? bctx.resolveInsert(e) : e.type === 'hatch' ? [] : [e]));
  if (ex) ents = ents.filter((e) => !ex.has(e.id));

  const cands: Cand[] = [];
  const near: { e: Entity; pr: Prim }[] = [];
  for (const e of ents) {
    const prims = entityPrims(e);
    for (const c of featurePoints(e, prims, modes)) { c.d = dist(c.p, cursor); if (c.d <= ap) cands.push(c); }
    if (e.type === 'text' || e.type === 'dim') continue;
    for (const pr of prims) {
      const dn = distPointPrim(cursor, pr);
      if (dn > ap) continue;
      near.push({ e, pr });
      if (modes.nea) { const p = nearestOnPrim(cursor, pr); cands.push({ p, mode: 'nea', id: e.id, d: dist(p, cursor) }); }
      if (base && modes.per) for (const p of perpFeet(base, pr)) { const d = dist(p, cursor); if (d <= ap) cands.push({ p, mode: 'per', id: e.id, d }); }
      if (base && modes.tan) for (const p of tangentFeet(base, pr)) { const d = dist(p, cursor); if (d <= ap) cands.push({ p, mode: 'tan', id: e.id, d }); }
    }
  }
  if (modes.int) {
    for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
      for (const p of intersectPrims(near[i].pr, near[j].pr)) {
        const d = dist(p, cursor);
        if (d <= ap) cands.push({ p, mode: 'int', id: near[i].e.id, d });
      }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => RANK[a.mode] - RANK[b.mode] || a.d - b.d);
  const c = cands[0];
  return { point: c.p, mode: c.mode, entityId: c.id, label: c.label ?? LABEL[c.mode], marker: MARKER[c.mode] };
}

function buildEntitiesNear(d: Drawing, box: { min: Pt2; max: Pt2 }): Entity[] {
  // sin índice: recorrido lineal con rechazo por caja (se construye un índice efímero solo si el dibujo es muy grande)
  if (d.entities.length > 2000) return buildIndex(d).query(box).map((it) => it.e);
  const out: Entity[] = [];
  const bctx = blockCtx(d);
  for (const e of d.entities) {
    if (!layerVisible(d, e.layer)) continue;
    const b = entityBounds(e, bctx);
    if (b && boundsOverlap(b, box)) out.push(e);
  }
  return out;
}
