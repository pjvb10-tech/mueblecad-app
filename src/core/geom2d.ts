import type { ArcEntity, DimAlignedEntity, DimEntity, DimLinearEntity, Entity, InsertEntity, PolyEntity, PolyVertex, Pt2, TextEntity } from './types';

/**
 * Geometría 2D pura del dibujo (sin DOM ni three.js). Unidades: mm. Ángulos en GRADOS, sentido antihorario (CCW)
 * con x a la derecha e y arriba. Convención de bulge: tan(barrido/4) del tramo que sale de un vértice; positivo = arco CCW
 * (el arco se curva hacia la DERECHA de la dirección de recorrido). Contrato completo en docs/dibujo-2d.md.
 */

export const EPS = 1e-9;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export type Seg = [Pt2, Pt2];
/** Resuelve un `insert` en las entidades transformadas (blocks.ts: `blockCtx(drawing)`). Sin contexto, un insert no tiene caja ni se puede tocar. */
export interface BlockCtx { resolveInsert(e: InsertEntity): Entity[] }
export interface Bounds { min: Pt2; max: Pt2 }
/** Tramo de una polilínea: recto si bulge es 0. */
export interface PolySeg { a: Pt2; b: Pt2; bulge: number }
export interface ArcGeom { c: Pt2; r: number; /** inicio (grados) */ a0: number; /** fin (grados), barrido CCW de a0 a a1 */ a1: number; /** barrido positivo en grados */ sweep: number }

// ---------------------------------------------------------------- ángulos y vectores

/** Ángulo en [0, 360). */
export const norm360 = (a: number): number => ((a % 360) + 360) % 360;
/** Barrido CCW de a0 a a1 en (0, 360]. Si coinciden, es una vuelta completa. */
export const sweepOf = (a0: number, a1: number): number => { const s = norm360(a1 - a0); return s < 1e-9 ? 360 : s; };
export const dist = (a: Pt2, b: Pt2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const polar = (c: Pt2, r: number, deg: number): Pt2 => [c[0] + r * Math.cos(deg * RAD), c[1] + r * Math.sin(deg * RAD)];
const angleOf = (c: Pt2, p: Pt2): number => Math.atan2(p[1] - c[1], p[0] - c[0]) * DEG;
/** ¿El ángulo (grados) cae dentro del arco CCW a0→a1? (con tolerancia en grados) */
export function angleInArc(ang: number, a0: number, a1: number, tol = 1e-7): boolean {
  const s = sweepOf(a0, a1);
  const d = norm360(ang - a0);
  return d <= s + tol || d >= 360 - tol;
}

// ---------------------------------------------------------------- bulge <-> arco

/** Bulge de un arco con barrido firmado en grados (+ = CCW). 180° -> 1; 90° -> tan(22.5°). */
export const bulgeFromSweep = (sweepDeg: number): number => Math.tan((sweepDeg * RAD) / 4);
/** Barrido firmado (grados) de un bulge. */
export const sweepFromBulge = (bulge: number): number => 4 * Math.atan(bulge) * DEG;

/** Arco real (siempre descrito en CCW) que une p0 con p1 con el bulge dado. Devuelve null si el tramo es recto o degenerado. */
export function bulgeArc(p0: Pt2, p1: Pt2, bulge: number): ArcGeom | null {
  const L = dist(p0, p1);
  if (!bulge || L < EPS) return null;
  const theta = 4 * Math.atan(Math.abs(bulge)); // barrido en rad, (0, 2π)
  const r = L / (2 * Math.sin(theta / 2));
  const dx = (p1[0] - p0[0]) / L, dy = (p1[1] - p0[1]) / L;
  const sgn = bulge > 0 ? 1 : -1;
  const off = sgn * r * Math.cos(theta / 2); // distancia firmada del centro al punto medio, hacia la izquierda del recorrido
  const c: Pt2 = [(p0[0] + p1[0]) / 2 - dy * off, (p0[1] + p1[1]) / 2 + dx * off];
  const s = angleOf(c, p0), e = angleOf(c, p1);
  const [a0, a1] = bulge > 0 ? [s, e] : [e, s];
  return { c, r, a0: norm360(a0), a1: norm360(a1), sweep: theta * DEG };
}

/** Bulge del tramo p0→p1 que pasa por el punto intermedio `mid` (arco por 3 puntos). Null si los 3 puntos están alineados. */
export function bulgeFrom3Points(p0: Pt2, mid: Pt2, p1: Pt2): number | null {
  const arc = arcFrom3Points(p0, mid, p1);
  if (!arc) return null;
  return arc.ccw ? bulgeFromSweep(arc.sweep) : -bulgeFromSweep(arc.sweep);
}

/** Círculo por 3 puntos. Null si están alineados o repetidos. */
export function circleFrom3Points(a: Pt2, b: Pt2, c: Pt2): { c: Pt2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const scale = Math.max(dist(a, b), dist(b, c), dist(a, c), 1);
  if (Math.abs(d) < 1e-9 * scale * scale) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { c: [ux, uy], r: Math.hypot(a[0] - ux, a[1] - uy) };
}

/** Arco que va de p0 a p2 pasando por p1. `ccw` indica el sentido real de recorrido; el arco de ArcEntity (a0,a1) siempre es CCW. */
export function arcFrom3Points(p0: Pt2, p1: Pt2, p2: Pt2): (ArcGeom & { ccw: boolean }) | null {
  const circ = circleFrom3Points(p0, p1, p2);
  if (!circ) return null;
  const s = angleOf(circ.c, p0), m = angleOf(circ.c, p1), e = angleOf(circ.c, p2);
  const ccw = sweepOf(s, m) < sweepOf(s, e); // p1 se alcanza antes que p2 yendo en CCW desde p0
  const [a0, a1] = ccw ? [s, e] : [e, s];
  return { c: circ.c, r: circ.r, a0: norm360(a0), a1: norm360(a1), sweep: sweepOf(a0, a1), ccw };
}

// ---------------------------------------------------------------- polilíneas con bulge

export function polySegments(poly: Pick<PolyEntity, 'pts' | 'closed'>): PolySeg[] {
  const n = poly.pts.length, out: PolySeg[] = [];
  const last = poly.closed ? n : n - 1;
  for (let i = 0; i < last; i++) out.push({ a: poly.pts[i].p, b: poly.pts[(i + 1) % n].p, bulge: poly.pts[i].bulge ?? 0 });
  return out;
}

const segLength = (s: PolySeg): number => {
  const arc = bulgeArc(s.a, s.b, s.bulge);
  return arc ? arc.r * arc.sweep * RAD : dist(s.a, s.b);
};
/** Longitud de la polilínea (si es cerrada incluye el tramo de cierre). */
export const polyLength = (poly: Pick<PolyEntity, 'pts' | 'closed'>): number => polySegments(poly).reduce((s, g) => s + segLength(g), 0);
/** Perímetro: la longitud de la polilínea cerrada (aunque `closed` sea falso, cuenta el cierre recto). */
export const polyPerimeter = (poly: Pick<PolyEntity, 'pts' | 'closed'>): number => polyLength({ pts: poly.pts, closed: true });

/** Área de segmento circular (entre la cuerda y el arco) con su centroide, para un tramo con bulge. */
function bulgeSegment(s: PolySeg): { area: number; centroid: Pt2 } | null {
  const arc = bulgeArc(s.a, s.b, s.bulge);
  if (!arc) return null;
  const th = arc.sweep * RAD, r = arc.r;
  const area = (r * r / 2) * (th - Math.sin(th));
  const L = dist(s.a, s.b), sgn = s.bulge > 0 ? 1 : -1;
  const dx = (s.b[0] - s.a[0]) / L, dy = (s.b[1] - s.a[1]) / L;
  // dirección del centro hacia el punto medio del arco: derecha del recorrido si bulge > 0
  const ux = sgn * dy, uy = -sgn * dx;
  const d = (4 * r * Math.sin(th / 2) ** 3) / (3 * (th - Math.sin(th)));
  return { area: sgn * area, centroid: [arc.c[0] + ux * d, arc.c[1] + uy * d] };
}

/** Área firmada de la polilínea tratada como cerrada (+ si es antihoraria), con los arcos incluidos. */
export function polySignedArea(poly: Pick<PolyEntity, 'pts'>): number {
  const segs = polySegments({ pts: poly.pts, closed: true });
  let a = 0;
  for (const s of segs) {
    a += (s.a[0] * s.b[1] - s.b[0] * s.a[1]) / 2;
    const bs = bulgeSegment(s);
    if (bs) a += bs.area;
  }
  return a;
}
export const polyArea = (poly: Pick<PolyEntity, 'pts'>): number => Math.abs(polySignedArea(poly));
/** ¿Antihoraria? */
export const isCCW = (poly: Pick<PolyEntity, 'pts'>): boolean => polySignedArea(poly) > 0;

/** Centroide del área encerrada (cerrando la polilínea). Null si el área es nula. */
export function polyCentroid(poly: Pick<PolyEntity, 'pts'>): Pt2 | null {
  const segs = polySegments({ pts: poly.pts, closed: true });
  let a = 0, cx = 0, cy = 0;
  for (const s of segs) {
    const cr = s.a[0] * s.b[1] - s.b[0] * s.a[1];
    a += cr / 2; cx += (s.a[0] + s.b[0]) * cr; cy += (s.a[1] + s.b[1]) * cr;
  }
  if (Math.abs(a) < EPS) return null;
  let sx = (cx / 6), sy = (cy / 6); // = A_poly * centroide del polígono
  let total = a;
  for (const s of segs) {
    const bs = bulgeSegment(s);
    if (bs) { sx += bs.area * bs.centroid[0]; sy += bs.area * bs.centroid[1]; total += bs.area; }
  }
  if (Math.abs(total) < EPS) return null;
  return [sx / total, sy / total];
}

/** Misma polilínea con el sentido invertido (los bulges se reasignan y cambian de signo). */
export function reversePoly(pts: PolyVertex[], closed: boolean): PolyVertex[] {
  const n = pts.length;
  const out: PolyVertex[] = [];
  for (let i = n - 1; i >= 0; i--) {
    // el tramo que antes salía del vértice j hacia j+1 ahora sale de j+1 hacia j
    const prev = closed ? (i - 1 + n) % n : i - 1;
    const b = prev >= 0 ? pts[prev].bulge ?? 0 : 0;
    const v: PolyVertex = { p: [pts[i].p[0], pts[i].p[1]] };
    if (b) v.bulge = -b;
    out.push(v);
  }
  return out;
}

/** Misma polilínea cerrada en sentido antihorario. */
export const orientCCW = (pts: PolyVertex[]): PolyVertex[] => (polySignedArea({ pts }) < 0 ? reversePoly(pts, true) : pts);

/** Quita vértices consecutivos repetidos (y el último si repite al primero en una cerrada). */
export function dedupePoly(pts: PolyVertex[], closed: boolean, tol = 1e-6): PolyVertex[] {
  const out: PolyVertex[] = [];
  for (const v of pts) {
    const q = out[out.length - 1];
    if (!q || dist(q.p, v.p) > tol) out.push(v);
  }
  if (closed) while (out.length > 1 && dist(out[0].p, out[out.length - 1].p) <= tol) out.pop();
  return out;
}

/** ¿El primer y el último punto coinciden (lazo cerrado)? */
export const isClosedLoop = (pts: Pt2[], tol = 1e-6): boolean => pts.length >= 3 && dist(pts[0], pts[pts.length - 1]) <= tol;

// ---------------------------------------------------------------- teselado

/** Pasos con los que se aproxima un arco de `sweep` grados y radio r para que la flecha no pase de `tol` mm. */
export function arcSteps(r: number, sweepDeg: number, tol = 0.1): number {
  if (!(r > 0)) return 1;
  const step = tol >= r ? 90 : 2 * Math.acos(1 - tol / r) * DEG; // paso angular máximo
  return Math.max(Math.ceil(sweepDeg / Math.max(step, 1e-3)), Math.ceil(sweepDeg / 90), 1);
}

/** Puntos de un arco CCW, incluidos los extremos exactos. */
export function tessellateArc(c: Pt2, r: number, a0: number, a1: number, tol = 0.1): Pt2[] {
  const sweep = sweepOf(a0, a1), n = arcSteps(r, sweep, tol);
  const pts: Pt2[] = [];
  for (let i = 0; i <= n; i++) pts.push(polar(c, r, a0 + (sweep * i) / n));
  return pts;
}

/** Círculo como polígono (sin repetir el primer punto al final). */
export function tessellateCircle(c: Pt2, r: number, tol = 0.1): Pt2[] {
  const n = Math.max(arcSteps(r, 360, tol), 8);
  return Array.from({ length: n }, (_, i) => polar(c, r, (360 * i) / n));
}

/** Polilínea con bulges como lista de puntos (cerrada: sin repetir el primero al final). */
export function tessellatePoly(poly: Pick<PolyEntity, 'pts' | 'closed'>, tol = 0.1): Pt2[] {
  const out: Pt2[] = [];
  const segs = polySegments(poly);
  for (const s of segs) {
    out.push(s.a);
    const arc = bulgeArc(s.a, s.b, s.bulge);
    if (arc) {
      const pts = s.bulge > 0 ? tessellateArc(arc.c, arc.r, arc.a0, arc.a1, tol) : tessellateArc(arc.c, arc.r, arc.a0, arc.a1, tol).reverse();
      out.push(...pts.slice(1, -1));
    }
  }
  if (!poly.closed && poly.pts.length) out.push(poly.pts[poly.pts.length - 1].p);
  return out;
}

// ---------------------------------------------------------------- cajas

const emptyBounds = (): Bounds => ({ min: [Infinity, Infinity], max: [-Infinity, -Infinity] });
function grow(b: Bounds, p: Pt2): void {
  b.min[0] = Math.min(b.min[0], p[0]); b.min[1] = Math.min(b.min[1], p[1]);
  b.max[0] = Math.max(b.max[0], p[0]); b.max[1] = Math.max(b.max[1], p[1]);
}
function growArc(b: Bounds, c: Pt2, r: number, a0: number, a1: number): void {
  grow(b, polar(c, r, a0)); grow(b, polar(c, r, a1));
  for (const q of [0, 90, 180, 270]) if (angleInArc(q, a0, a1)) grow(b, polar(c, r, q));
}
export const mergeBounds = (list: (Bounds | null)[]): Bounds | null => {
  const b = emptyBounds();
  let any = false;
  for (const x of list) if (x) { grow(b, x.min); grow(b, x.max); any = true; }
  return any ? b : null;
};

/** Esquinas (giradas) de la caja aproximada de un texto: ancho ≈ 0.6·h por carácter. */
export function textCorners(t: Pick<TextEntity, 'p' | 'h' | 's' | 'rot' | 'align'>): Pt2[] {
  const w = 0.6 * t.h * Math.max(t.s.length, 1);
  const x0 = t.align === 'center' ? -w / 2 : t.align === 'right' ? -w : 0;
  const cs = Math.cos((t.rot ?? 0) * RAD), sn = Math.sin((t.rot ?? 0) * RAD);
  return ([[x0, 0], [x0 + w, 0], [x0 + w, t.h], [x0, t.h]] as Pt2[]).map(([x, y]) => [t.p[0] + x * cs - y * sn, t.p[1] + x * sn + y * cs] as Pt2);
}

/** Caja envolvente de una entidad. */
export function entityBounds(e: Entity, ctx?: BlockCtx): Bounds | null {
  const b = emptyBounds();
  switch (e.type) {
    case 'line': grow(b, e.a); grow(b, e.b); break;
    case 'poly':
      for (const s of polySegments(e)) {
        grow(b, s.a); grow(b, s.b);
        const arc = bulgeArc(s.a, s.b, s.bulge);
        if (arc) growArc(b, arc.c, arc.r, arc.a0, arc.a1);
      }
      if (e.pts.length === 1) grow(b, e.pts[0].p);
      break;
    case 'circle': grow(b, [e.c[0] - e.r, e.c[1] - e.r]); grow(b, [e.c[0] + e.r, e.c[1] + e.r]); break;
    case 'arc': growArc(b, e.c, e.r, e.a0, e.a1); break;
    case 'text': for (const p of textCorners(e)) grow(b, p); break;
    case 'dim': {
      const g = dimGeometry(e);
      for (const [p, q] of g.lines) { grow(b, p); grow(b, q); }
      for (const t of g.texts) for (const p of textCorners(t)) grow(b, p);
      break;
    }
    case 'hatch':
      for (const loop of e.loops) { const lb = entityBounds({ id: '', layer: '', type: 'poly', pts: loop, closed: true }); if (lb) { grow(b, lb.min); grow(b, lb.max); } }
      break;
    case 'insert': {
      if (!ctx) return null;
      for (const c of ctx.resolveInsert(e)) { const cb = entityBounds(c, ctx); if (cb) { grow(b, cb.min); grow(b, cb.max); } }
      break;
    }
  }
  return b.min[0] === Infinity ? null : b;
}
export const entitiesBounds = (list: Entity[], ctx?: BlockCtx): Bounds | null => mergeBounds(list.map((e) => entityBounds(e, ctx)));

// ---------------------------------------------------------------- cotas

export const fmtNum = (n: number, dec = 2): string => String(Number(n.toFixed(dec)));

export interface DimGeometry {
  /** Líneas sueltas: extensión, línea de cota y flechas. */
  lines: Seg[];
  /** Textos sueltos (la medida). */
  texts: Pick<TextEntity, 'p' | 'h' | 's' | 'rot' | 'align'>[];
  /** Medida calculada (mm). */
  value: number;
}

/** Medida de una cota: lineal = proyección, alineada = distancia, radio = r, diámetro = 2r. */
export function dimMeasure(d: DimEntity): number {
  switch (d.kind) {
    case 'linear': { const a = (d.rot ?? 0) * RAD; return Math.abs((d.p2[0] - d.p1[0]) * Math.cos(a) + (d.p2[1] - d.p1[1]) * Math.sin(a)); }
    case 'aligned': return dist(d.p1, d.p2);
    case 'radius': return d.r;
    case 'diameter': return 2 * d.r;
  }
}
/** Texto que se muestra: `text` si existe, si no la medida (R/Ø delante en radio/diámetro). */
export function dimLabel(d: DimEntity): string {
  if (d.text !== undefined && d.text !== '') return d.text;
  const v = fmtNum(dimMeasure(d));
  return d.kind === 'radius' ? `R${v}` : d.kind === 'diameter' ? `Ø${v}` : v;
}

/**
 * Descompone una cota en líneas y texto sueltos (así se exporta a DXF y se dibuja).
 * `textH` por omisión: un décimo de la medida limitado a 5–60 mm.
 */
export function dimGeometry(d: DimEntity, opts: { textH?: number } = {}): DimGeometry {
  const value = dimMeasure(d);
  const h = opts.textH ?? Math.min(60, Math.max(5, value / 10));
  const lines: Seg[] = [];
  const arrow = (tip: Pt2, ux: number, uy: number) => { // flecha en `tip` apuntando hacia fuera según (ux,uy) (dirección desde la línea hacia la punta)
    const L = h * 0.8, w = h * 0.25;
    const bx = tip[0] - ux * L, by = tip[1] - uy * L;
    lines.push([tip, [bx - uy * w, by + ux * w]], [tip, [bx + uy * w, by - ux * w]]);
  };
  const label = dimLabel(d);
  if (d.kind === 'radius' || d.kind === 'diameter') {
    const ang = d.ang ?? 45;
    const ux = Math.cos(ang * RAD), uy = Math.sin(ang * RAD);
    const tip: Pt2 = [d.c[0] + ux * d.r, d.c[1] + uy * d.r];
    const start: Pt2 = d.kind === 'diameter' ? [d.c[0] - ux * d.r, d.c[1] - uy * d.r] : d.c;
    lines.push([start, tip]);
    arrow(tip, ux, uy);
    if (d.kind === 'diameter') arrow(start, -ux, -uy);
    const tp: Pt2 = [tip[0] + ux * h * 0.5, tip[1] + uy * h * 0.5];
    return { lines, texts: [{ p: tp, h, s: label, rot: 0, align: ux < -0.3 ? 'right' : 'left' }], value };
  }
  const m = d as DimLinearEntity | DimAlignedEntity;
  const ang = m.kind === 'linear' ? (m.rot ?? 0) : angleOf(m.p1, m.p2);
  const ux = Math.cos(ang * RAD), uy = Math.sin(ang * RAD), nx = -uy, ny = ux;
  const off = (q: Pt2) => (m.at[0] - q[0]) * nx + (m.at[1] - q[1]) * ny; // distancia firmada de q a la línea de cota, a lo largo de n
  const q1: Pt2 = [m.p1[0] + nx * off(m.p1), m.p1[1] + ny * off(m.p1)];
  const q2: Pt2 = [m.p2[0] + nx * off(m.p2), m.p2[1] + ny * off(m.p2)];
  const over = h * 0.4;
  for (const [p, q] of [[m.p1, q1], [m.p2, q2]] as [Pt2, Pt2][]) {
    const o = dist(p, q);
    if (o < EPS) continue;
    const k = (o + over) / o;
    lines.push([p, [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k]]);
  }
  lines.push([q1, q2]);
  const along = (q2[0] - q1[0]) * ux + (q2[1] - q1[1]) * uy; // sentido de q1→q2 respecto a u
  const s = along >= 0 ? 1 : -1;
  if (dist(q1, q2) > EPS) { arrow(q1, -ux * s, -uy * s); arrow(q2, ux * s, uy * s); }
  let rot = norm360(ang), side = 1;
  if (rot > 90 && rot <= 270) { rot -= 180; side = -1; } // texto legible: nunca de cabeza
  if (rot > 180) rot -= 360;
  const mp: Pt2 = [(q1[0] + q2[0]) / 2 + nx * h * 0.6 * side, (q1[1] + q2[1]) / 2 + ny * h * 0.6 * side];
  return { lines, texts: [{ p: mp, h, s: label, rot, align: 'center' }], value };
}

// ---------------------------------------------------------------- distancias (hit-test)

/** Distancia de un punto a un segmento. */
export function distPointSeg(p: Pt2, a: Pt2, b: Pt2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  if (l2 < EPS) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return dist(p, [a[0] + t * dx, a[1] + t * dy]);
}
/** Distancia de un punto a un arco CCW (a lo largo del arco, no al círculo completo). */
export function distPointArc(p: Pt2, c: Pt2, r: number, a0: number, a1: number): number {
  if (angleInArc(angleOf(c, p), a0, a1)) return Math.abs(dist(p, c) - r);
  return Math.min(dist(p, polar(c, r, a0)), dist(p, polar(c, r, a1)));
}
export function pointInPolygon(p: Pt2, poly: Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function distPointBox(p: Pt2, corners: Pt2[]): number {
  if (pointInPolygon(p, corners)) return 0;
  let m = Infinity;
  for (let i = 0; i < 4; i++) m = Math.min(m, distPointSeg(p, corners[i], corners[(i + 1) % 4]));
  return m;
}

/** Distancia mínima de un punto a una entidad (para seleccionar con el ratón). Texto: 0 si el punto cae dentro de su caja. */
export function distPointEntity(p: Pt2, e: Entity, ctx?: BlockCtx): number {
  switch (e.type) {
    case 'line': return distPointSeg(p, e.a, e.b);
    case 'circle': return Math.abs(dist(p, e.c) - e.r);
    case 'arc': return distPointArc(p, e.c, e.r, e.a0, e.a1);
    case 'poly': {
      let m = Infinity;
      for (const s of polySegments(e)) {
        const arc = bulgeArc(s.a, s.b, s.bulge);
        m = Math.min(m, arc ? distPointArc(p, arc.c, arc.r, arc.a0, arc.a1) : distPointSeg(p, s.a, s.b));
      }
      return e.pts.length === 1 ? dist(p, e.pts[0].p) : m;
    }
    case 'text': return distPointBox(p, textCorners(e));
    case 'dim': {
      const g = dimGeometry(e);
      return Math.min(...g.lines.map(([a, b]) => distPointSeg(p, a, b)), ...g.texts.map((t) => distPointBox(p, textCorners(t))));
    }
    case 'hatch': return Math.min(Infinity, ...e.loops.map((loop) => distPointEntity(p, { id: '', layer: '', type: 'poly', pts: loop, closed: true })));
    case 'insert': {
      let m = Infinity;
      for (const c of ctx?.resolveInsert(e) ?? []) m = Math.min(m, distPointEntity(p, c, ctx));
      return m;
    }
  }
}

// ---------------------------------------------------------------- intersecciones

/** Intersección de dos rectas infinitas (a-b y c-d). Null si son paralelas. Devuelve el punto y los parámetros t (sobre a-b) y u (sobre c-d). */
export function intersectLines(a: Pt2, b: Pt2, c: Pt2, d: Pt2): { p: Pt2; t: number; u: number } | null {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12 * Math.max(1, Math.hypot(rx, ry) * Math.hypot(sx, sy))) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return { p: [a[0] + t * rx, a[1] + t * ry], t, u };
}
/** Intersección de dos segmentos (0..1 en ambos, con tolerancia). Null si no se cortan o son paralelos. */
export function intersectSegments(a: Pt2, b: Pt2, c: Pt2, d: Pt2, tol = 1e-9): Pt2 | null {
  const r = intersectLines(a, b, c, d);
  if (!r || r.t < -tol || r.t > 1 + tol || r.u < -tol || r.u > 1 + tol) return null;
  return r.p;
}
/** Intersección de una recta (infinita) o segmento con un círculo: 0, 1 (tangente) o 2 puntos. */
export function intersectLineCircle(a: Pt2, b: Pt2, c: Pt2, r: number, opts: { segment?: boolean } = {}): Pt2[] {
  const dx = b[0] - a[0], dy = b[1] - a[1], fx = a[0] - c[0], fy = a[1] - c[1];
  const A = dx * dx + dy * dy;
  if (A < EPS) return [];
  const B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  let disc = B * B - 4 * A * C;
  const tolD = 1e-9 * Math.max(1, B * B);
  if (disc < -tolD) return [];
  if (disc < 0) disc = 0;
  const sq = Math.sqrt(disc);
  const ts = disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  return ts.filter((t) => !opts.segment || (t >= -1e-9 && t <= 1 + 1e-9)).map((t) => [a[0] + t * dx, a[1] + t * dy] as Pt2);
}
/** Intersección de dos círculos: 0, 1 (tangentes) o 2 puntos. Círculos concéntricos o iguales devuelven []. */
export function intersectCircles(c1: Pt2, r1: number, c2: Pt2, r2: number): Pt2[] {
  const d = dist(c1, c2);
  if (d < EPS) return [];
  const tol = 1e-9 * Math.max(1, r1, r2);
  if (d > r1 + r2 + tol || d < Math.abs(r1 - r2) - tol) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h2 = r1 * r1 - a * a;
  const h = h2 <= 0 ? 0 : Math.sqrt(h2);
  const ex = (c2[0] - c1[0]) / d, ey = (c2[1] - c1[1]) / d;
  const mx = c1[0] + a * ex, my = c1[1] + a * ey;
  if (h === 0) return [[mx, my]];
  return [[mx - h * ey, my + h * ex], [mx + h * ey, my - h * ex]];
}
/** Deja solo los puntos que caen dentro de un arco (centro c, a0→a1 CCW). */
export const pointsOnArc = (pts: Pt2[], c: Pt2, a0: number, a1: number): Pt2[] => pts.filter((p) => angleInArc(angleOf(c, p), a0, a1, 1e-6));
export const arcPoints = (a: Pick<ArcEntity, 'c' | 'r' | 'a0' | 'a1'>): { start: Pt2; end: Pt2; mid: Pt2 } => ({
  start: polar(a.c, a.r, a.a0), end: polar(a.c, a.r, a.a1), mid: polar(a.c, a.r, a.a0 + sweepOf(a.a0, a.a1) / 2),
});

// ---------------------------------------------------------------- lazos

/**
 * Une segmentos sueltos por sus extremos (con tolerancia) en cadenas. Devuelve los lazos cerrados y las cadenas abiertas,
 * cada uno como lista de puntos (el lazo cerrado NO repite el primer punto al final).
 */
export function joinSegments(segs: Seg[], tol = 1e-3): { loops: Pt2[][]; open: Pt2[][] } {
  const rest = segs.filter(([a, b]) => dist(a, b) > tol).map(([a, b]) => [a, b] as Seg);
  const loops: Pt2[][] = [], open: Pt2[][] = [];
  while (rest.length) {
    const first = rest.pop()!;
    const chain: Pt2[] = [first[0], first[1]];
    for (let grew = true; grew;) {
      grew = false;
      for (let i = 0; i < rest.length; i++) {
        const [a, b] = rest[i];
        const head = chain[0], tail = chain[chain.length - 1];
        if (dist(tail, a) <= tol) chain.push(b);
        else if (dist(tail, b) <= tol) chain.push(a);
        else if (dist(head, b) <= tol) chain.unshift(a);
        else if (dist(head, a) <= tol) chain.unshift(b);
        else continue;
        rest.splice(i, 1); grew = true; break;
      }
    }
    if (chain.length >= 4 && dist(chain[0], chain[chain.length - 1]) <= tol) loops.push(chain.slice(0, -1));
    else open.push(chain);
  }
  return { loops, open };
}
