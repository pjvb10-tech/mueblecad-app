import { flattenEntities } from './blocks';
import { dist, distPointEntity, intersectLines, joinSegments, norm360, pointInPolygon, polyArea, tessellateArc, tessellateCircle, tessellatePoly } from './geom2d';
import type { Seg } from './geom2d';
import { layerVisible } from './prims2d';
import type { Drawing, Entity, HatchEntity, HatchPattern, PolyVertex, Pt2 } from './types';

/**
 * Sombreados (hatch): relleno por patrones calculado recortando familias de líneas paralelas contra los contornos (regla par-impar),
 * detección de contorno por punto interior (`findBoundary`) y recálculo asociativo simple (`syncHatches`). Núcleo puro, sin DOM.
 * Contrato: docs/dibujo-2d.md, sección Sombreados. Ángulos en grados antihorario; el patrón se ancla en el origen del dibujo (como en CAD),
 * así dos sombreados contiguos con el mismo patrón se alinean.
 */

export const DEFAULT_SPACING = 50;
const RAD = Math.PI / 180;

export interface HatchLike { loops: PolyVertex[][]; pattern: HatchPattern; angle?: number; scale?: number }

export interface HatchGeometry {
  /** Contornos teselados (polígonos); relleno par-impar. */
  polygons: Pt2[][];
  /** Trazos del patrón, ya recortados (mundo). */
  segments: Seg[];
  /** Puntos del patrón de puntos / concreto (mundo). */
  dots: Pt2[];
  /** Separación efectiva (mm); mayor que `scale` si hubo que ralear el patrón para no pasar del tope. */
  spacing: number;
  /** Se ensanchó la separación por superar el tope de trazos. */
  capped: boolean;
}

export interface HatchGeomOptions {
  /** Flecha máxima al teselar arcos (mm). 0.1 por omisión, y no menor que 1/20 000 del tamaño del contorno. */
  tol?: number;
  /** Tope de trazos + puntos. 60 000 por omisión. */
  maxSegments?: number;
}

/** Contornos del sombreado como polígonos (arcos teselados con tolerancia `tol`). */
export function hatchPolygons(loops: PolyVertex[][], tol = 0.1): Pt2[][] {
  return loops.map((l) => tessellatePoly({ pts: l, closed: true }, tol)).filter((p) => p.length >= 3);
}

// ---------------------------------------------------------------- recorte

const rot = (p: Pt2, c: number, s: number): Pt2 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
const rotAll = (polys: Pt2[][], deg: number): Pt2[][] => { const c = Math.cos(-deg * RAD), s = Math.sin(-deg * RAD); return polys.map((pl) => pl.map((p) => rot(p, c, s))); };
const unrot = (p: Pt2, deg: number): Pt2 => rot(p, Math.cos(deg * RAD), Math.sin(deg * RAD));

function extent(polys: Pt2[][]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const pl of polys) for (const p of pl) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
  return { x0, y0, x1, y1 };
}

/** ¿(x, y) está dentro (par-impar)? */
export function insideEvenOdd(polys: Pt2[][], x: number, y: number): boolean {
  let inside = false;
  for (const pl of polys) {
    for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) {
      const [xi, yi] = pl[i], [xj, yj] = pl[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Intersecciones de las filas y = (k + phase)·s con los polígonos (regla par-impar): devuelve, por fila, los intervalos [x0, x1] interiores.
 * Cada borde cuenta en el semiintervalo [ymin, ymax): un vértice exacto sobre la fila se cuenta una sola vez.
 */
function scanRows(polys: Pt2[][], s: number, phase = 0): { y: number; iv: [number, number][] }[] {
  const rows = new Map<number, number[]>();
  for (const pl of polys) {
    for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) {
      const [x0, y0] = pl[j], [x1, y1] = pl[i];
      if (y0 === y1) continue;
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
      const k0 = Math.ceil(lo / s - phase), k1 = Math.ceil(hi / s - phase) - 1;
      for (let k = k0; k <= k1; k++) {
        const y = (k + phase) * s;
        const x = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
        const a = rows.get(k);
        if (a) a.push(x); else rows.set(k, [x]);
      }
    }
  }
  const out: { y: number; iv: [number, number][] }[] = [];
  for (const [k, xs] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b);
    const iv: [number, number][] = [];
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 1e-9) iv.push([xs[i], xs[i + 1]]);
    if (iv.length) out.push({ y: (k + phase) * s, iv });
  }
  return out;
}

/** Recorta el segmento a→b contra los polígonos (par-impar) y devuelve los trozos interiores. */
function clipSegment(a: Pt2, b: Pt2, polys: Pt2[][]): Seg[] {
  const ts: number[] = [0, 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const pl of polys) {
    for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) {
      const c = pl[j], d = pl[i];
      const ex = d[0] - c[0], ey = d[1] - c[1];
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den, u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
      if (t > 0 && t < 1 && u >= 0 && u < 1) ts.push(t);
    }
  }
  ts.sort((p, q) => p - q);
  const out: Seg[] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    if (ts[i + 1] - ts[i] < 1e-9) continue;
    const m = (ts[i] + ts[i + 1]) / 2;
    if (!insideEvenOdd(polys, a[0] + dx * m, a[1] + dy * m)) continue;
    const seg: Seg = [[a[0] + dx * ts[i], a[1] + dy * ts[i]], [a[0] + dx * ts[i + 1], a[1] + dy * ts[i + 1]]];
    const last = out[out.length - 1];
    if (last && dist(last[1], seg[0]) < 1e-9) last[1] = seg[1]; else out.push(seg);
  }
  return out;
}

/** Hash determinista en [0, 1) de dos enteros y una semilla (sin Math.random: el patrón no cambia entre repintados). */
function hash(i: number, j: number, k: number): number {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(k | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

interface Acc { segments: Seg[]; dots: Pt2[]; count: number }

/** Familia de líneas paralelas de dirección `deg` y separación `s`, recortada. */
function lineFamily(polys: Pt2[][], deg: number, s: number, acc: Acc, dashed = false, seed = 0): void {
  const rp = rotAll(polys, deg);
  for (const { y, iv } of scanRows(rp, s)) {
    const k = Math.round(y / s);
    for (const [x0, x1] of iv) {
      if (!dashed) { acc.segments.push([unrot([x0, y], deg), unrot([x1, y], deg)]); acc.count++; continue; }
      // veta de madera: trazos con huecos de largo variable
      let x = x0 + hash(k, seed, 1) * s * 4;
      if (x > x1) { acc.segments.push([unrot([x0, y], deg), unrot([x1, y], deg)]); acc.count++; continue; }
      let n = 0;
      let cur = x0;
      while (cur < x1 && n++ < 100000) {
        const len = s * (3 + hash(k, n, seed + 2) * 9), gap = s * (0.4 + hash(k, n, seed + 3) * 1.2);
        const e = Math.min(cur + len, x1);
        if (e - cur > 1e-9) { acc.segments.push([unrot([cur, y], deg), unrot([e, y], deg)]); acc.count++; }
        cur = e + gap;
      }
    }
  }
}

function dotLattice(polys: Pt2[][], deg: number, s: number, acc: Acc): void {
  const rp = rotAll(polys, deg);
  for (const { y, iv } of scanRows(rp, s)) {
    for (const [x0, x1] of iv) {
      for (let m = Math.ceil(x0 / s); m * s <= x1; m++) { acc.dots.push(unrot([m * s, y], deg)); acc.count++; }
    }
  }
}

function brick(polys: Pt2[][], deg: number, s: number, acc: Acc): void {
  const rp = rotAll(polys, deg);
  const rows = scanRows(rp, s);
  for (const { y, iv } of rows) for (const [x0, x1] of iv) { acc.segments.push([unrot([x0, y], deg), unrot([x1, y], deg)]); acc.count++; }
  const e = extent(rp);
  const k0 = Math.floor(e.y0 / s), k1 = Math.ceil(e.y1 / s);
  for (let k = k0; k < k1; k++) {
    const off = (((k % 2) + 2) % 2) * s;
    for (let j = Math.ceil((e.x0 - off) / (2 * s)); j * 2 * s + off <= e.x1; j++) {
      const x = j * 2 * s + off;
      for (const [p, q] of clipSegment([x, k * s], [x, (k + 1) * s], rp)) { acc.segments.push([unrot(p, deg), unrot(q, deg)]); acc.count++; }
      if (acc.count > 4e6) return;
    }
  }
}

function concrete(polys: Pt2[][], deg: number, s: number, acc: Acc): void {
  const rp = rotAll(polys, deg);
  const e = extent(rp);
  const i0 = Math.floor(e.x0 / s), i1 = Math.ceil(e.x1 / s), j0 = Math.floor(e.y0 / s), j1 = Math.ceil(e.y1 / s);
  for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
    for (let n = 0; n < 2; n++) {
      const x = (i + hash(i, j, 11 + n)) * s, y = (j + hash(i, j, 21 + n)) * s;
      if (insideEvenOdd(rp, x, y)) { acc.dots.push(unrot([x, y], deg)); acc.count++; }
    }
    if (hash(i, j, 31) < 0.3) { // piedrita triangular
      const cx = (i + hash(i, j, 32)) * s, cy = (j + hash(i, j, 33)) * s, r = s * 0.28, a0 = hash(i, j, 34) * 360;
      const tri: Pt2[] = [0, 120, 240].map((a) => [cx + r * Math.cos((a0 + a) * RAD), cy + r * Math.sin((a0 + a) * RAD)] as Pt2);
      if (tri.every((p) => insideEvenOdd(rp, p[0], p[1]))) for (let q = 0; q < 3; q++) { acc.segments.push([unrot(tri[q], deg), unrot(tri[(q + 1) % 3], deg)]); acc.count++; }
    }
  }
}

function build(pattern: HatchPattern, polys: Pt2[][], angle: number, s: number): Acc {
  const acc: Acc = { segments: [], dots: [], count: 0 };
  switch (pattern) {
    case 'solid': break;
    case 'lines': lineFamily(polys, angle, s, acc); break;
    case 'ansi31': lineFamily(polys, angle + 45, s, acc); break;
    case 'cross': lineFamily(polys, angle, s, acc); lineFamily(polys, angle + 90, s, acc); break;
    case 'dots': dotLattice(polys, angle, s, acc); break;
    case 'brick': brick(polys, angle, s, acc); break;
    case 'concrete': concrete(polys, angle, s, acc); break;
    case 'wood': lineFamily(polys, angle, s, acc, true, 7); break;
  }
  return acc;
}

const memo = new WeakMap<object, Map<string, HatchGeometry>>();

/**
 * Geometría del sombreado para dibujar o exportar: polígonos de los contornos, trazos recortados y puntos. Se memoiza por objeto de entidad
 * (las entidades son inmutables). Si el patrón pasaría del tope de trazos, se ensancha la separación y `capped` queda en true.
 */
export function hatchGeometry(h: HatchLike, opts: HatchGeomOptions = {}): HatchGeometry {
  const key = `${opts.tol ?? ''}|${opts.maxSegments ?? ''}`;
  let per = memo.get(h);
  if (!per) memo.set(h, (per = new Map()));
  const hit = per.get(key);
  if (hit) return hit;
  const first = hatchPolygons(h.loops, opts.tol ?? 0.1);
  const e0 = extent(first);
  const size = Number.isFinite(e0.x0) ? Math.max(e0.x1 - e0.x0, e0.y1 - e0.y0) : 0;
  const polygons = size > 2000 ? hatchPolygons(h.loops, Math.max(opts.tol ?? 0.1, size / 20000)) : first;
  const max = opts.maxSegments ?? 60000;
  const base = h.scale ?? DEFAULT_SPACING;
  let s = base, capped = false, acc: Acc = { segments: [], dots: [], count: 0 };
  if (h.pattern !== 'solid' && polygons.length) {
    // estimación previa de filas para no generar millones de trazos antes de descubrir que sobran
    const e = extent(polygons);
    const w = e.x1 - e.x0, hh = e.y1 - e.y0;
    const areaLike = h.pattern === 'dots' || h.pattern === 'concrete' || h.pattern === 'brick';
    const est = areaLike ? (w * hh) / (s * s) : (w + hh) / s;
    if (est > max * 2) { s = areaLike ? Math.sqrt((w * hh) / (max * 2)) : (w + hh) / (max * 1.5); capped = true; }
    for (let it = 0; it < 8; it++) {
      acc = build(h.pattern, polygons, norm360(h.angle ?? 0), s);
      if (acc.count <= max) break;
      s *= Math.max(1.25, Math.sqrt(acc.count / max)); capped = true;
    }
  }
  const g: HatchGeometry = { polygons, segments: acc.segments, dots: acc.dots, spacing: s, capped };
  per.set(key, g);
  return g;
}

/** ¿El punto cae dentro del sombreado (regla par-impar)? */
export function hatchContains(h: HatchLike, p: Pt2, tol = 0.1): boolean {
  return insideEvenOdd(hatchPolygons(h.loops, tol), p[0], p[1]);
}

/** Distancia de selección de un sombreado: al contorno; dentro de él vale justo la tolerancia (se elige solo si nada más cerca). */
export function hatchPickDistance(h: HatchEntity, p: Pt2, tolerance: number): number {
  const edge = distPointEntity(p, h);
  return hatchContains(h, p, Math.max(0.1, tolerance / 4)) ? Math.min(edge, tolerance * 0.999) : edge;
}

// ---------------------------------------------------------------- lazos desde entidades

/** Lazo (vértices con bulge) de una entidad cerrada: poly cerrada o círculo (dos semicírculos). Null si no es cerrada. */
export function closedEntityLoop(e: Entity): PolyVertex[] | null {
  if (e.type === 'poly' && e.closed) return e.pts.map((v) => (v.bulge ? { p: [v.p[0], v.p[1]] as Pt2, bulge: v.bulge } : { p: [v.p[0], v.p[1]] as Pt2 }));
  if (e.type === 'circle') return [{ p: [e.c[0] + e.r, e.c[1]], bulge: 1 }, { p: [e.c[0] - e.r, e.c[1]], bulge: 1 }];
  if (e.type === 'arc' && Math.abs(norm360(e.a1 - e.a0)) < 1e-9) return closedEntityLoop({ ...e, type: 'circle' } as unknown as Entity);
  return null;
}

/** Quita vértices repetidos o alineados de un lazo sin arcos. */
export function simplifyLoop(pts: Pt2[], tol = 1e-6): Pt2[] {
  let cur = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > tol);
  while (cur.length > 1 && dist(cur[0], cur[cur.length - 1]) <= tol) cur.pop();
  let changed = true;
  while (changed && cur.length > 3) {
    changed = false;
    const next: Pt2[] = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[(i - 1 + cur.length) % cur.length], b = cur[i], c = cur[(i + 1) % cur.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const L = Math.max(dist(a, b), dist(b, c), 1e-12);
      if (Math.abs(cross) / L < 1e-6 && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) > 0) { changed = true; continue; }
      next.push(b);
    }
    if (next.length < 3) break;
    cur = next;
  }
  return cur;
}

export interface BoundaryResult {
  /** Contornos: el exterior y las islas (huecos), todos cerrados; par-impar. */
  loops: PolyVertex[][];
  /** Ids de entidades cuyo contorno exacto forma TODOS los lazos (asociativo); ausente si algún lazo se armó con tramos sueltos. */
  source?: string[];
  /** Ids de todas las entidades que aportan tramos al contorno. */
  entityIds: string[];
}

/** Lazos desde entidades elegidas: cerradas tal cual y las abiertas (líneas, arcos, polilíneas) unidas por sus extremos. Lanza Error con el motivo si no cierran. */
export function loopsFromEntities(d: Drawing, ids: string[]): BoundaryResult {
  const loops: PolyVertex[][] = [], loose: Seg[] = [], entityIds: string[] = [], exact: string[] = [];
  let allExact = true;
  for (const id of ids) {
    const e = d.entities.find((x) => x.id === id);
    if (!e) throw new Error(`No existe la entidad "${id}".`);
    const l = closedEntityLoop(e);
    if (l) { loops.push(l); exact.push(id); entityIds.push(id); continue; }
    allExact = false;
    const pts = e.type === 'line' ? [e.a, e.b] : e.type === 'poly' ? tessellatePoly(e, 0.1) : e.type === 'arc' ? tessellateArc(e.c, e.r, e.a0, e.a1, 0.1) : null;
    if (!pts) throw new Error(`La entidad "${id}" (${e.type}) no sirve de contorno; usa líneas, arcos, polilíneas o círculos.`);
    for (let i = 0; i + 1 < pts.length; i++) loose.push([pts[i], pts[i + 1]]);
    entityIds.push(id);
  }
  if (loose.length) {
    const j = joinSegments(loose, 1e-3);
    if (j.open.length) throw new Error(`Los contornos elegidos no cierran (${j.open.length} cadena(s) abierta(s)); cierra los extremos o elige un punto interior.`);
    for (const l of j.loops) loops.push(simplifyLoop(l).map((p): PolyVertex => ({ p })));
  }
  if (!loops.length) throw new Error('No hay ningún contorno cerrado en las entidades elegidas.');
  return { loops, entityIds, ...(allExact && exact.length ? { source: exact } : {}) };
}

// ---------------------------------------------------------------- contorno por punto interior

interface Piece { a: Pt2; b: Pt2; src: string }
interface Edge { u: number; v: number; src: string; mixed: boolean }
const TOLN = 1e-3;

/**
 * Contorno cerrado más pequeño que contiene `point`, a partir de las entidades visibles (líneas, arcos, círculos, polilíneas y los inserts resueltos).
 * Divide los tramos en sus cruces y empalmes (T), poda los cabos sueltos, recorre las caras del grafo plano y elige la menor que contiene el punto.
 * Las islas son las componentes conexas que quedan dentro de esa cara (se agrega su contorno exterior). Devuelve null si el punto no está encerrado.
 * Lanza Error si hay más de `maxSegments` (60 000) tramos.
 */
export function findBoundary(d: Drawing, point: Pt2, opts: { tol?: number; maxSegments?: number } = {}): BoundaryResult | null {
  const tol = opts.tol ?? 0.1, max = opts.maxSegments ?? 60000;
  // 1) tramos
  const pieces: Piece[] = [];
  const closedInfo = new Map<string, { n: number }>();
  const addChain = (pts: Pt2[], closed: boolean, src: string): void => {
    const n = pts.length;
    for (let i = 0; i + (closed ? 0 : 1) < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; if (dist(a, b) > TOLN) pieces.push({ a, b, src }); }
  };
  for (const e of flattenEntities(d, { visibleOnly: true })) {
    if (!layerVisible(d, e.layer)) continue;
    switch (e.type) {
      case 'line': addChain([e.a, e.b], false, e.id); break;
      case 'arc': {
        const full = Math.abs(norm360(e.a1 - e.a0)) < 1e-9;
        if (full) { const p = tessellateCircle(e.c, e.r, tol); addChain(p, true, e.id); closedInfo.set(e.id, { n: p.length }); } else addChain(tessellateArc(e.c, e.r, e.a0, e.a1, tol), false, e.id);
        break;
      }
      case 'circle': { const p = tessellateCircle(e.c, e.r, tol); addChain(p, true, e.id); closedInfo.set(e.id, { n: p.length }); break; }
      case 'poly': { const p = tessellatePoly(e, tol); addChain(p, !!e.closed, e.id); if (e.closed) closedInfo.set(e.id, { n: p.length }); break; }
      default: break;
    }
    if (pieces.length > max) throw new Error(`El dibujo tiene demasiados tramos (${pieces.length}) para buscar un contorno; oculta capas o usa «Seleccionar objetos».`);
  }
  if (!pieces.length) return null;

  // 2) partir en cruces y empalmes
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of pieces) for (const p of [s.a, s.b]) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
  const gn = Math.max(1, Math.min(400, Math.ceil(Math.sqrt(pieces.length))));
  const cw = Math.max((maxX - minX) / gn, 1e-6), ch = Math.max((maxY - minY) / gn, 1e-6);
  const cell = new Map<number, number[]>();
  const cl = (v: number) => Math.max(0, Math.min(gn - 1, v));
  pieces.forEach((s, idx) => {
    const i0 = cl(Math.floor((Math.min(s.a[0], s.b[0]) - minX) / cw)), i1 = cl(Math.floor((Math.max(s.a[0], s.b[0]) - minX) / cw));
    const j0 = cl(Math.floor((Math.min(s.a[1], s.b[1]) - minY) / ch)), j1 = cl(Math.floor((Math.max(s.a[1], s.b[1]) - minY) / ch));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = i * 1000 + j; const c = cell.get(k); if (c) c.push(idx); else cell.set(k, [idx]); }
  });
  const nodes: Pt2[] = [];
  const nodeMap = new Map<string, number[]>();
  const nodeOf = (p: Pt2): number => {
    const cx = Math.round(p[0] / TOLN), cy = Math.round(p[1] / TOLN);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const c = nodeMap.get(`${cx + dx},${cy + dy}`);
      if (c) for (const id of c) if (dist(nodes[id], p) <= TOLN) return id;
    }
    const id = nodes.length;
    nodes.push([p[0], p[1]]);
    const key = `${cx},${cy}`;
    const c = nodeMap.get(key);
    if (c) c.push(id); else nodeMap.set(key, [id]);
    return id;
  };
  const edgeMap = new Map<string, Edge>();
  const addEdge = (a: Pt2, b: Pt2, src: string): void => {
    const u = nodeOf(a), v = nodeOf(b);
    if (u === v) return;
    const key = u < v ? `${u}_${v}` : `${v}_${u}`;
    const ex = edgeMap.get(key);
    if (ex) { if (ex.src !== src) ex.mixed = true; } else edgeMap.set(key, { u, v, src, mixed: false });
  };
  const seen = new Set<number>();
  pieces.forEach((s, idx) => {
    const ts = [0, 1];
    const L = dist(s.a, s.b);
    const cand = new Set<number>();
    const i0 = cl(Math.floor((Math.min(s.a[0], s.b[0]) - minX) / cw)), i1 = cl(Math.floor((Math.max(s.a[0], s.b[0]) - minX) / cw));
    const j0 = cl(Math.floor((Math.min(s.a[1], s.b[1]) - minY) / ch)), j1 = cl(Math.floor((Math.max(s.a[1], s.b[1]) - minY) / ch));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (const o of cell.get(i * 1000 + j) ?? []) if (o !== idx) cand.add(o);
    seen.clear();
    for (const o of cand) {
      const q = pieces[o];
      const x = intersectLines(s.a, s.b, q.a, q.b);
      if (x && x.t > -1e-9 && x.t < 1 + 1e-9 && x.u > -1e-9 && x.u < 1 + 1e-9 && x.t * L > TOLN && (1 - x.t) * L > TOLN) ts.push(x.t);
      for (const e of [q.a, q.b]) { // extremo del otro sobre este tramo (empalme en T o solape)
        const t = ((e[0] - s.a[0]) * (s.b[0] - s.a[0]) + (e[1] - s.a[1]) * (s.b[1] - s.a[1])) / (L * L);
        if (t * L <= TOLN || (1 - t) * L <= TOLN || t > 1) continue;
        const px = s.a[0] + (s.b[0] - s.a[0]) * t, py = s.a[1] + (s.b[1] - s.a[1]) * t;
        if (Math.hypot(px - e[0], py - e[1]) <= TOLN) ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    let prev = s.a;
    for (let i = 1; i < ts.length; i++) {
      if (ts[i] - ts[i - 1] < 1e-12) continue;
      const p: Pt2 = ts[i] === 1 ? s.b : [s.a[0] + (s.b[0] - s.a[0]) * ts[i], s.a[1] + (s.b[1] - s.a[1]) * ts[i]];
      addEdge(prev, p, s.src);
      prev = p;
    }
  });

  // 3) poda de cabos sueltos
  const edges = [...edgeMap.values()];
  const deg = new Map<number, number>();
  const bump = (n: number, v: number) => deg.set(n, (deg.get(n) ?? 0) + v);
  edges.forEach((e) => { bump(e.u, 1); bump(e.v, 1); });
  const adjEdges = new Map<number, Edge[]>();
  edges.forEach((e) => { (adjEdges.get(e.u) ?? adjEdges.set(e.u, []).get(e.u)!).push(e); (adjEdges.get(e.v) ?? adjEdges.set(e.v, []).get(e.v)!).push(e); });
  const dead = new Set<Edge>();
  const stack = [...deg.entries()].filter(([, v]) => v === 1).map(([n]) => n);
  while (stack.length) {
    const n = stack.pop()!;
    if ((deg.get(n) ?? 0) !== 1) continue;
    const e = adjEdges.get(n)!.find((x) => !dead.has(x));
    if (!e) continue;
    dead.add(e);
    deg.set(n, 0);
    const o = e.u === n ? e.v : e.u;
    deg.set(o, (deg.get(o) ?? 1) - 1);
    if (deg.get(o) === 1) stack.push(o);
  }
  const live = edges.filter((e) => !dead.has(e));
  if (!live.length) return null;

  // 4) caras: media arista (u→v) con la cara a su izquierda
  const out = new Map<number, { to: number; ang: number; e: Edge }[]>();
  const add = (u: number, v: number, e: Edge) => {
    const ang = Math.atan2(nodes[v][1] - nodes[u][1], nodes[v][0] - nodes[u][0]);
    (out.get(u) ?? out.set(u, []).get(u)!).push({ to: v, ang, e });
  };
  live.forEach((e) => { add(e.u, e.v, e); add(e.v, e.u, e); });
  for (const l of out.values()) l.sort((a, b) => a.ang - b.ang);
  const visited = new Set<string>();
  interface Face { nodes: number[]; edges: Edge[]; area: number; poly: Pt2[] }
  const faces: Face[] = [];
  for (const [u0, list] of out) {
    for (const h0 of list) {
      const k0 = `${u0}>${h0.to}`;
      if (visited.has(k0)) continue;
      const fn: number[] = [], fe: Edge[] = [];
      let u = u0, h = h0, guard = 0;
      for (;;) {
        visited.add(`${u}>${h.to}`);
        fn.push(u); fe.push(h.e);
        const v = h.to, vl = out.get(v)!;
        const ti = vl.findIndex((x) => x.to === u && x.e === h.e);
        const nx = vl[(ti - 1 + vl.length) % vl.length]; // el anterior en sentido antihorario = giro más a la izquierda... (cara a la izquierda)
        u = v; h = nx;
        if (u === u0 && h === h0) break;
        if (++guard > live.length * 2 + 4) break;
      }
      const poly = fn.map((n) => nodes[n]);
      let a = 0;
      for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += (p[0] * q[1] - q[0] * p[1]) / 2; }
      faces.push({ nodes: fn, edges: fe, area: a, poly });
    }
  }

  // 5) cara más pequeña que contiene el punto
  let best: Face | null = null;
  for (const f of faces) if (f.area > 1e-9 && (!best || f.area < best.area) && pointInPolygon(point, f.poly)) best = f;
  if (!best) return null;

  // 6) islas: componentes conexas dentro de la cara cuyo contorno exterior es una cara de área negativa
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while ((parent.get(r) ?? r) !== r) r = parent.get(r)!; let c = x; while (c !== r) { const n = parent.get(c) ?? c; parent.set(c, r); c = n; } return r; };
  for (const e of live) { const a = find(e.u), b = find(e.v); if (a !== b) parent.set(a, b); }
  const mine = find(best.nodes[0]);
  const loopsPoly: { poly: Pt2[]; face: Face }[] = [{ poly: best.poly, face: best }];
  const doneComp = new Set<number>([mine]);
  for (const f of faces) {
    if (f.area >= -1e-9) continue;
    const c = find(f.nodes[0]);
    if (doneComp.has(c)) continue;
    if (f.nodes.some((n) => !pointInPolygon(nodes[n], best!.poly))) continue;
    // no debe estar dentro de otra isla ya tomada con un hueco intermedio: par-impar lo resuelve al sombrear
    doneComp.add(c);
    loopsPoly.push({ poly: f.poly, face: f });
  }

  // 7) a vértices con bulge (exacto si el lazo es una entidad cerrada completa)
  const loops: PolyVertex[][] = [];
  const entityIds = new Set<string>();
  const exact: string[] = [];
  let allExact = true;
  for (const { poly, face } of loopsPoly) {
    face.edges.forEach((e) => entityIds.add(e.src));
    const srcs = new Set(face.edges.map((e) => e.src));
    if (srcs.size === 1) {
      const id = [...srcs][0];
      const ent = d.entities.find((x) => x.id === id);
      const info = closedInfo.get(id);
      if (ent && info && info.n === face.nodes.length && !face.edges.some((e) => e.mixed)) {
        const l = closedEntityLoop(ent);
        if (l) { loops.push(l); exact.push(id); continue; }
      }
    }
    allExact = false;
    loops.push(simplifyLoop(poly).map((p): PolyVertex => ({ p: [p[0], p[1]] })));
  }
  return { loops, entityIds: [...entityIds], ...(allExact ? { source: exact } : {}) };
}

// ---------------------------------------------------------------- asociatividad simple

/**
 * Recalcula los contornos de los sombreados asociativos (`source`) cuyas entidades de origen cambiaron entre `before` y `after`
 * (y que no se tocaron ellos mismos). Si un origen ya no existe o dejó de ser cerrado, el sombreado conserva sus lazos y pierde `source`.
 */
export function syncHatches(before: Drawing, after: Drawing): Drawing {
  if (!after.entities.some((e) => e.type === 'hatch' && e.source)) return after;
  const prev = new Map(before.entities.map((e) => [e.id, e]));
  const cur = new Map(after.entities.map((e) => [e.id, e]));
  let changed = false;
  const entities = after.entities.map((e) => {
    if (e.type !== 'hatch' || !e.source || prev.get(e.id) !== e) return e;
    if (!e.source.some((id) => prev.get(id) !== cur.get(id))) return e;
    const loops: PolyVertex[][] = [];
    for (const id of e.source) { const s = cur.get(id), l = s && closedEntityLoop(s); if (!l) { changed = true; const { source: _s, ...rest } = e; return rest as HatchEntity; } loops.push(l); }
    changed = true;
    return { ...e, loops };
  });
  return changed ? { ...after, entities } : after;
}

/** Área (mm²) del sombreado con la regla par-impar: los lazos a profundidad impar restan. Los arcos cuentan exactos. */
export function hatchArea(h: Pick<HatchLike, 'loops'>): number {
  const polys = h.loops.map((l) => tessellatePoly({ pts: l, closed: true }, 0.1));
  let total = 0;
  h.loops.forEach((l, i) => {
    let depth = 0;
    const probe = polys[i][0];
    if (probe) polys.forEach((q, j) => { if (j !== i && q.length >= 3 && pointInPolygon(probe, q)) depth++; });
    total += (depth % 2 === 0 ? 1 : -1) * polyArea({ pts: l });
  });
  return total;
}

/** `syncHatches` sobre todos los dibujos de una lista (comparando con la versión anterior por id). Devuelve la misma lista si nada cambió. */
export function syncAllHatches(before: Drawing[] | undefined, after: Drawing[] | undefined): Drawing[] | undefined {
  if (!after || !before) return after;
  const prev = new Map(before.map((d) => [d.id, d]));
  let changed = false;
  const out = after.map((d) => { const b = prev.get(d.id); const s = b && b !== d ? syncHatches(b, d) : d; if (s !== d) changed = true; return s; });
  return changed ? out : after;
}
