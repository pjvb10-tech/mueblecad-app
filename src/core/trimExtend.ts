import { DrawingError, findLayer, getEntity } from './drawing';
import type { EntityInput } from './drawing';
import type { DrawOp } from './drawingTools';
import { bulgeArc, bulgeFromSweep, dist, intersectCircles, intersectLineCircle, intersectLines, norm360, pointsOnArc, polySegments, sweepFromBulge, sweepOf } from './geom2d';
import { layerVisible } from './prims2d';
import type { Drawing, Entity, PolyVertex, Pt2 } from './types';

/**
 * RECORTAR y EXTENDER al estilo CAD, como funciones puras (sin DOM) sobre un dibujo. Devuelven una lista de `DrawOp` (compatible con
 * `applyOps` de drawingTools.ts) o lanzan DrawingError con un mensaje en español.
 *
 * Objetivos: línea, arco, círculo (recortar lo convierte en arco) y polilínea abierta o cerrada (con bulge).
 * Bordes: línea, polilínea, círculo y arco (o 'todos' = todo lo visible salvo el propio objetivo).
 * Ids estables: el trozo que se conserva mantiene el id del objetivo; si el recorte lo parte en dos, el segundo trozo es una entidad
 * nueva (id nuevo al aplicar). Un círculo recortado se reemplaza por un arco con el MISMO id (remove + add con id).
 * Límites: las auto-intersecciones de una polilínea no cuentan como borde; en modo `extendido` solo se prolongan los bordes rectos
 * (línea completa; extremos rectos de una polilínea abierta) y los arcos como círculo completo.
 */

export type BoundarySpec = string[] | 'todos';
export interface TrimExtendOptions {
  /** 'normal' (por omisión): los bordes son los objetos tal cual. 'extendido': se prolongan virtualmente (rectas infinitas, arcos como círculo completo). */
  edgeMode?: 'normal' | 'extendido';
}

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const TOL_U = 1e-9;     // tolerancia de parámetro (fracción de tramo)
const TOL_D = 1e-7;     // tolerancia de distancia (mm)
const TOL_A = 1e-6;     // tolerancia angular (grados)
const fail = (m: string): never => { throw new DrawingError(m); };

const polar = (c: Pt2, r: number, deg: number): Pt2 => [c[0] + r * Math.cos(deg * RAD), c[1] + r * Math.sin(deg * RAD)];
const angleOf = (c: Pt2, p: Pt2): number => Math.atan2(p[1] - c[1], p[0] - c[0]) * DEG;
const norm = (a: number): number => norm360(a);

// ---------------------------------------------------------------- recorrido del objetivo

type Seg =
  | { k: 's'; p0: Pt2; p1: Pt2 }
  | { k: 'a'; p0: Pt2; p1: Pt2; c: Pt2; r: number; a0: number; sw: number; bulge?: number };
interface Path { segs: Seg[]; cyclic: boolean }

const arcSeg = (c: Pt2, r: number, a0: number, sw: number, p0?: Pt2, p1?: Pt2): Seg => ({ k: 'a', c, r, a0, sw, p0: p0 ?? polar(c, r, a0), p1: p1 ?? polar(c, r, a0 + sw) });

function buildPath(e: Entity): Path {
  switch (e.type) {
    case 'line': return { segs: [{ k: 's', p0: e.a, p1: e.b }], cyclic: false };
    case 'arc': {
      const sw = sweepOf(e.a0, e.a1);
      if (sw >= 360 - TOL_A) return { segs: [arcSeg(e.c, e.r, e.a0, 180), arcSeg(e.c, e.r, e.a0 + 180, 180)], cyclic: false };
      return { segs: [arcSeg(e.c, e.r, e.a0, sw)], cyclic: false };
    }
    case 'circle': return { segs: [arcSeg(e.c, e.r, 0, 180), arcSeg(e.c, e.r, 180, 180)], cyclic: true };
    case 'poly': {
      const segs = polySegments(e).map((s): Seg => {
        const arc = s.bulge ? bulgeArc(s.a, s.b, s.bulge) : null;
        if (!arc) return { k: 's', p0: s.a, p1: s.b };
        return arcSeg(arc.c, arc.r, angleOf(arc.c, s.a), sweepFromBulge(s.bulge), s.a, s.b);
      });
      return { segs, cyclic: !!e.closed };
    }
    default: return fail(`Este comando no se aplica a ${e.type}.`);
  }
}

const segLen = (s: Seg): number => (s.k === 's' ? dist(s.p0, s.p1) : s.r * Math.abs(s.sw) * RAD);
const pathLen = (segs: Seg[]): number => segs.reduce((a, s) => a + segLen(s), 0);
const segPoint = (s: Seg, t: number): Pt2 => {
  if (t <= 0) return s.p0;
  if (t >= 1) return s.p1;
  return s.k === 's' ? [s.p0[0] + t * (s.p1[0] - s.p0[0]), s.p0[1] + t * (s.p1[1] - s.p0[1])] : polar(s.c, s.r, s.a0 + s.sw * t);
};
function subSeg(s: Seg, t0: number, t1: number): Seg {
  const p0 = segPoint(s, t0), p1 = segPoint(s, t1);
  if (s.k === 's') return { k: 's', p0, p1 };
  return { k: 'a', p0, p1, c: s.c, r: s.r, a0: s.a0 + s.sw * t0, sw: s.sw * (t1 - t0), ...(t0 <= 0 && t1 >= 1 && s.bulge !== undefined ? { bulge: s.bulge } : {}) };
}
const reverseSeg = (s: Seg): Seg => (s.k === 's' ? { k: 's', p0: s.p1, p1: s.p0 } : { k: 'a', p0: s.p1, p1: s.p0, c: s.c, r: s.r, a0: s.a0 + s.sw, sw: -s.sw, ...(s.bulge !== undefined ? { bulge: -s.bulge } : {}) });

/** Parámetro (0..1) de un punto de la portadora dentro del tramo, o null si queda fuera del tramo. */
function paramOn(s: Seg, p: Pt2): number | null {
  if (s.k === 's') {
    const dx = s.p1[0] - s.p0[0], dy = s.p1[1] - s.p0[1], l2 = dx * dx + dy * dy;
    if (l2 < 1e-18) return null;
    const t = ((p[0] - s.p0[0]) * dx + (p[1] - s.p0[1]) * dy) / l2;
    return t < -TOL_U || t > 1 + TOL_U ? null : Math.min(1, Math.max(0, t));
  }
  const sg = s.sw < 0 ? -1 : 1, aw = Math.abs(s.sw);
  const adv = norm(sg * (angleOf(s.c, p) - s.a0));
  if (adv > aw + TOL_A) return adv > 360 - TOL_A ? 0 : null;
  return Math.min(1, adv / aw);
}

/** Parámetro del punto del recorrido más cercano a `p`. */
function nearestU(path: Path, p: Pt2): number {
  let best = Infinity, bu = 0;
  path.segs.forEach((s, i) => {
    let t: number;
    if (s.k === 's') {
      const dx = s.p1[0] - s.p0[0], dy = s.p1[1] - s.p0[1], l2 = dx * dx + dy * dy || 1;
      t = Math.max(0, Math.min(1, ((p[0] - s.p0[0]) * dx + (p[1] - s.p0[1]) * dy) / l2));
    } else {
      const sg = s.sw < 0 ? -1 : 1, aw = Math.abs(s.sw);
      const adv = norm(sg * (angleOf(s.c, p) - s.a0));
      t = adv <= aw ? adv / aw : (adv - aw < 360 - adv ? 1 : 0);
    }
    const q = segPoint(s, t), d = dist(p, q);
    if (d < best - 1e-12) { best = d; bu = i + t; }
  });
  return bu;
}

// ---------------------------------------------------------------- bordes

type Bnd = { k: 's'; a: Pt2; b: Pt2; exA: boolean; exB: boolean } | { k: 'a'; c: Pt2; r: number; a0: number; a1: number; full: boolean };

function boundsOfEntity(e: Entity, ext: boolean): Bnd[] {
  switch (e.type) {
    case 'line': return [{ k: 's', a: e.a, b: e.b, exA: ext, exB: ext }];
    case 'circle': return [{ k: 'a', c: e.c, r: e.r, a0: 0, a1: 0, full: true }];
    case 'arc': return [{ k: 'a', c: e.c, r: e.r, a0: e.a0, a1: e.a1, full: ext || sweepOf(e.a0, e.a1) >= 360 - TOL_A }];
    case 'poly': {
      const segs = polySegments(e);
      return segs.map((s, i): Bnd => {
        const arc = s.bulge ? bulgeArc(s.a, s.b, s.bulge) : null;
        if (arc) return { k: 'a', c: arc.c, r: arc.r, a0: arc.a0, a1: arc.a1, full: false };
        const open = !e.closed;
        return { k: 's', a: s.a, b: s.b, exA: ext && open && i === 0, exB: ext && open && i === segs.length - 1 };
      });
    }
    default: return [];
  }
}

const BOUNDARY_TYPES = ['line', 'poly', 'circle', 'arc'];

function resolveBoundaries(d: Drawing, target: Entity, spec: BoundarySpec, ext: boolean): Bnd[] {
  let list: Entity[];
  if (spec === 'todos') {
    list = d.entities.filter((e) => e.id !== target.id && BOUNDARY_TYPES.includes(e.type) && layerVisible(d, e.layer));
    if (!list.length) fail('No hay otros objetos visibles (línea, polilínea, círculo o arco) que sirvan de borde.');
  } else {
    if (!Array.isArray(spec) || !spec.length) return fail('Indica los bordes (lista de ids) o "todos".');
    list = [];
    for (const id of spec) {
      if (id === target.id) continue; // el propio objetivo no es borde de sí mismo
      const e = getEntity(d, id) ?? fail(`No existe el borde "${id}".`);
      if (e.type === 'insert') fail(`El borde "${id}" es un bloque insertado (${e.block}): los inserts no sirven de borde. Explótalo primero o elige las entidades sueltas.`);
      if (!BOUNDARY_TYPES.includes(e.type)) fail(`El borde "${id}" es ${e.type}: solo sirven línea, polilínea, círculo o arco.`);
      const l = findLayer(d, e.layer);
      if (l && (l.frozen || !l.on)) fail(`El borde "${id}" está en la capa "${l.name}", que está ${l.frozen ? 'congelada' : 'apagada'}; no se puede usar como borde.`);
      list.push(e);
    }
    if (!list.length) fail(`El borde no puede ser el propio objeto "${target.id}"; elige otros bordes o "todos".`);
  }
  return list.flatMap((e) => boundsOfEntity(e, ext));
}

/** Puntos donde la recta infinita a-b corta el borde. */
function lineVsBnd(a: Pt2, b: Pt2, q: Bnd): Pt2[] {
  if (q.k === 's') {
    const r = intersectLines(a, b, q.a, q.b);
    if (!r) return [];
    return r.u >= (q.exA ? -Infinity : -TOL_U) && r.u <= (q.exB ? Infinity : 1 + TOL_U) ? [r.p] : [];
  }
  const pts = intersectLineCircle(a, b, q.c, q.r);
  return q.full ? pts : pointsOnArc(pts, q.c, q.a0, q.a1);
}
/** Puntos donde el círculo (c, r) corta el borde. */
function circleVsBnd(c: Pt2, r: number, q: Bnd): Pt2[] {
  if (q.k === 's') {
    const dx = q.b[0] - q.a[0], dy = q.b[1] - q.a[1], l2 = dx * dx + dy * dy;
    if (l2 < 1e-18) return [];
    return intersectLineCircle(q.a, q.b, c, r).filter((p) => {
      const u = ((p[0] - q.a[0]) * dx + (p[1] - q.a[1]) * dy) / l2;
      return u >= (q.exA ? -Infinity : -TOL_U) && u <= (q.exB ? Infinity : 1 + TOL_U);
    });
  }
  const pts = intersectCircles(c, r, q.c, q.r);
  return q.full ? pts : pointsOnArc(pts, q.c, q.a0, q.a1);
}
const carrierHits = (s: Seg, q: Bnd): Pt2[] => (s.k === 's' ? lineVsBnd(s.p0, s.p1, q) : circleVsBnd(s.c, s.r, q));

/** Parámetros globales (índice de tramo + fracción) de los cortes del recorrido con los bordes, ordenados y sin repetidos. */
function hitParams(path: Path, bnds: Bnd[]): number[] {
  const out: number[] = [];
  path.segs.forEach((s, i) => { for (const q of bnds) for (const p of carrierHits(s, q)) { const t = paramOn(s, p); if (t !== null) out.push(i + t); } });
  return dedupe(out.sort((a, b) => a - b));
}
const dedupe = (xs: number[]): number[] => xs.filter((x, i) => i === 0 || x - xs[i - 1] > 1e-7);

// ---------------------------------------------------------------- comprobaciones comunes

function context(d: Drawing, id: string, verb: 'recortar' | 'extender'): Entity {
  const e = getEntity(d, id) ?? fail(`${verb}: no existe la entidad "${id}".`);
  const l = findLayer(d, e.layer);
  if (l?.locked) fail(`No se puede ${verb} "${e.id}": su capa "${l.name}" está bloqueada (desbloquéala con setLayer).`);
  if (l?.frozen) fail(`No se puede ${verb} "${e.id}": su capa "${l.name}" está congelada (descongélala con setLayer).`);
  if (e.type === 'insert') fail(`No se puede ${verb} el bloque insertado "${e.id}" (${e.block}): los inserts no se recortan ni se extienden. Explótalo primero (explode_insert / herramienta Explotar) o edita el bloque.`);
  if (!['line', 'arc', 'circle', 'poly'].includes(e.type)) fail(`No se puede ${verb} ${e.type} "${e.id}": solo línea, arco, círculo o polilínea.`);
  return e;
}

// ---------------------------------------------------------------- recortar

function subpath(segs: Seg[], u0: number, u1: number): Seg[] {
  const n = segs.length, out: Seg[] = [];
  for (let i = Math.floor(u0 + 1e-12); i < u1 - 1e-12; i++) {
    const t0 = Math.max(u0, i) - i, t1 = Math.min(u1, i + 1) - i;
    if (t1 - t0 > 1e-9) out.push(subSeg(segs[i % n], t0, t1));
  }
  return out;
}

/** Une tramos de arco consecutivos de la misma circunferencia (círculos y arcos partidos en mitades). */
function mergeArcs(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const l = out[out.length - 1];
    if (l && l.k === 'a' && s.k === 'a' && Math.sign(l.sw) === Math.sign(s.sw) && dist(l.p1, s.p0) < TOL_D && dist(l.c, s.c) < TOL_D) {
      out[out.length - 1] = { k: 'a', p0: l.p0, p1: s.p1, c: l.c, r: l.r, a0: l.a0, sw: l.sw + s.sw };
    } else out.push(s);
  }
  return out;
}

const keepStyle = (e: Entity) => ({ layer: e.layer, ...(e.color !== undefined ? { color: e.color } : {}) });

function polyVerts(segs: Seg[]): PolyVertex[] {
  const v: PolyVertex[] = segs.map((s) => {
    const b = s.k === 'a' ? (s.bulge ?? bulgeFromSweep(s.sw)) : 0;
    return b ? { p: s.p0, bulge: b } : { p: s.p0 };
  });
  v.push({ p: segs[segs.length - 1].p1 });
  return v;
}

/** Entrada (sin id) de un trozo del objetivo. */
function pieceInput(e: Entity, segs: Seg[]): EntityInput {
  const st = keepStyle(e);
  if (e.type === 'line') return { type: 'line', a: segs[0].p0, b: segs[segs.length - 1].p1, ...st };
  if (e.type === 'poly') return { type: 'poly', pts: polyVerts(segs), ...st };
  const merged = mergeArcs(segs);
  const s = merged[0];
  if (merged.length !== 1 || s.k !== 'a') return fail('No se pudo formar el arco resultante.');
  return { type: 'arc', c: s.c, r: s.r, a0: norm(s.a0), a1: norm(s.a0 + s.sw), ...st };
}

function opsForPieces(e: Entity, pieces: Seg[][]): DrawOp[] {
  const inputs = pieces.filter((p) => p.length && pathLen(p) > TOL_D).map((p) => pieceInput(e, p));
  if (!inputs.length) return fail(`El recorte dejaría "${e.id}" sin nada; usa borrar.`);
  const ops: DrawOp[] = [];
  const [first, ...rest] = inputs;
  if (e.type === 'circle') ops.push({ op: 'remove', ids: [e.id] }, { op: 'add', entity: { ...first, id: e.id } as EntityInput });
  else {
    const f = first as unknown as Record<string, unknown>;
    const patch: Record<string, unknown> = e.type === 'line' ? { a: f.a, b: f.b } : e.type === 'arc' ? { c: f.c, r: f.r, a0: f.a0, a1: f.a1 } : { pts: f.pts, closed: undefined };
    ops.push({ op: 'update', id: e.id, patch });
  }
  for (const r of rest) ops.push({ op: 'add', entity: r });
  return ops;
}

/**
 * Recorta `targetId` quitando el tramo que contiene `pickPoint`, entre los cortes vecinos con los bordes (si solo hay corte de un lado,
 * hasta el extremo). Cerrados (círculo, polilínea cerrada) necesitan al menos 2 cortes; el círculo pasa a arco. Tangencias cuentan como corte.
 */
export function trimEntity(d: Drawing, targetId: string, pickPoint: Pt2, boundaries: BoundarySpec, opts: TrimExtendOptions = {}): DrawOp[] {
  const e = context(d, targetId, 'recortar');
  const bnds = resolveBoundaries(d, e, boundaries, opts.edgeMode === 'extendido');
  const path = buildPath(e), n = path.segs.length;
  const up = nearestU(path, pickPoint);
  let hits = hitParams(path, bnds);
  const none = () => fail(`El borde no corta a "${e.id}" (o no hay corte a ambos lados que permita recortar): no hay intersección donde recortar.${opts.edgeMode === 'extendido' ? '' : ' Prueba con el modo de borde extendido.'}`);
  if (!path.cyclic) {
    hits = hits.filter((h) => h > TOL_U && h < n - TOL_U);
    if (!hits.length) return none();
    const prev = [...hits].reverse().find((h) => h < up - 1e-9), next = hits.find((h) => h >= up - 1e-9);
    const pieces: Seg[][] = [];
    if (prev !== undefined) pieces.push(subpath(path.segs, 0, prev));
    if (next !== undefined) pieces.push(subpath(path.segs, next, n));
    return opsForPieces(e, pieces);
  }
  hits = dedupe(hits.map((h) => (h >= n - 1e-7 ? 0 : h)).sort((a, b) => a - b));
  if (hits.length < 2) return fail(`Una figura cerrada ("${e.id}") necesita al menos 2 cortes con los bordes para recortar un tramo; ${hits.length ? 'solo hay 1' : 'no hay ninguno'}.`);
  const prevC = [...hits].reverse().find((h) => h <= up), nextC = hits.find((h) => h > up);
  const prev = prevC ?? hits[hits.length - 1] - n, next = nextC ?? hits[0] + n;
  return opsForPieces(e, [subpath(path.segs, next, prev + n)]);
}

// ---------------------------------------------------------------- extender

/**
 * Alarga el extremo de `targetId` más cercano a `pickPoint` hasta el primer borde: la línea sigue recta, el arco a lo largo de su
 * círculo y la polilínea abierta en su primer o último tramo (recto o arco). Círculos y polilíneas cerradas no se extienden.
 */
export function extendEntity(d: Drawing, targetId: string, pickPoint: Pt2, boundaries: BoundarySpec, opts: TrimExtendOptions = {}): DrawOp[] {
  const e = context(d, targetId, 'extender');
  if (e.type === 'circle') return fail(`Un círculo ("${e.id}") no tiene extremos que extender.`);
  if (e.type === 'poly' && e.closed) return fail(`La polilínea cerrada "${e.id}" no tiene extremos que extender.`);
  const bnds = resolveBoundaries(d, e, boundaries, opts.edgeMode === 'extendido');
  const path = buildPath(e);
  const total = pathLen(path.segs), up = nearestU(path, pickPoint);
  let before = 0;
  path.segs.forEach((s, i) => { if (i < Math.floor(up)) before += segLen(s); });
  const i0 = Math.min(Math.floor(up), path.segs.length - 1);
  before += segLen(path.segs[i0]) * (up - i0);
  const atStart = before < total / 2;
  const segs = atStart ? path.segs.map(reverseSeg).reverse() : path.segs.slice();
  const last = segs[segs.length - 1];
  const where = atStart ? 'inicial' : 'final';
  const miss = (): never => fail(`Ningún borde queda en la prolongación del extremo ${where} de "${e.id}": no hay intersección donde extender.${opts.edgeMode === 'extendido' ? '' : ' Prueba con el modo de borde extendido.'}`);
  let grown: Seg;
  if (last.k === 's') {
    const L = dist(last.p0, last.p1), ux = (last.p1[0] - last.p0[0]) / L, uy = (last.p1[1] - last.p0[1]) / L;
    let best = Infinity;
    for (const q of bnds) for (const p of lineVsBnd(last.p0, last.p1, q)) { const t = (p[0] - last.p1[0]) * ux + (p[1] - last.p1[1]) * uy; if (t > TOL_D && t < best) best = t; }
    if (!Number.isFinite(best)) return miss();
    grown = { k: 's', p0: last.p0, p1: [last.p1[0] + best * ux, last.p1[1] + best * uy] };
  } else {
    const sg = last.sw < 0 ? -1 : 1, endA = last.a0 + last.sw, room = 360 - Math.abs(last.sw);
    let best = Infinity;
    for (const q of bnds) for (const p of circleVsBnd(last.c, last.r, q)) { const adv = norm(sg * (angleOf(last.c, p) - endA)); if (adv > TOL_A && adv < room - TOL_A && adv < best) best = adv; }
    if (!Number.isFinite(best)) return miss();
    grown = arcSeg(last.c, last.r, last.a0, last.sw + sg * best, last.p0, polar(last.c, last.r, endA + sg * best));
  }
  const out = [...segs.slice(0, -1), grown];
  const fin = atStart ? out.map(reverseSeg).reverse() : out;
  const f = pieceInputFor(e, fin);
  const patch: Record<string, unknown> = e.type === 'line' ? { a: f.a, b: f.b } : e.type === 'arc' ? { a0: f.a0, a1: f.a1 } : { pts: f.pts };
  return [{ op: 'update', id: e.id, patch }];
}

const pieceInputFor = (e: Entity, segs: Seg[]): Record<string, unknown> => {
  if (e.type === 'line') {
    // conserva el orden a→b del original
    return { a: segs[0].p0, b: segs[0].p1 };
  }
  return pieceInput(e, segs) as unknown as Record<string, unknown>;
};

// ---------------------------------------------------------------- utilidad: deshacer una operación

/** Operaciones que llevan el dibujo `after` de vuelta a `before` (para "Deshacer" dentro de una herramienta). Las entidades borradas se reponen con su id. */
export function diffOps(before: Drawing, after: Drawing): DrawOp[] {
  const ops: DrawOp[] = [];
  const b = new Map(before.entities.map((e) => [e.id, e])), a = new Map(after.entities.map((e) => [e.id, e]));
  const added = after.entities.filter((e) => !b.has(e.id)).map((e) => e.id);
  if (added.length) ops.push({ op: 'remove', ids: added });
  for (const e of before.entities) {
    const x = a.get(e.id);
    const { id: _i, ...rest } = e as Entity & { id: string };
    if (!x || x.type !== e.type) {
      if (x) ops.push({ op: 'remove', ids: [e.id] }); // cambió de tipo (círculo → arco): se repone el original con su id
      ops.push({ op: 'add', entity: JSON.parse(JSON.stringify({ ...rest, id: e.id })) as EntityInput });
      continue;
    }
    const patch: Record<string, unknown> = {};
    const A = e as unknown as Record<string, unknown>, B = x as unknown as Record<string, unknown>;
    for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) if (k !== 'id' && k !== 'type' && JSON.stringify(A[k]) !== JSON.stringify(B[k])) patch[k] = A[k];
    if (Object.keys(patch).length) ops.push({ op: 'update', id: e.id, patch });
  }
  return ops;
}
