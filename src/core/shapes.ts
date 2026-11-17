import type { PartShape, Vec3 } from './types';

export type Pt = [number, number];

/** Ejes de una pieza plana: u = lado largo, v = lado ancho, t = espesor (índices 0=X, 1=Y, 2=Z). */
export function panelAxes(size: Vec3): { u: number; v: number; t: number } {
  const idx = [0, 1, 2].sort((a, b) => size[b] - size[a] || a - b);
  return { u: idx[0], v: idx[1], t: idx[2] };
}

export interface Outline {
  outer: Pt[];
  holes: Pt[][];
}

/** Contorno de la pieza en su plano (u, v), en sentido antihorario. */
export function outline(size: Vec3, shape?: PartShape): Outline {
  const { u, v } = panelAxes(size);
  const L = size[u];
  const W = size[v];
  let pts: Pt[] = [[0, 0], [L, 0], [L, W], [0, W]];
  const convex = [true, true, true, true];

  if (shape?.notch) {
    const w = Math.min(shape.notch.w, L - 1);
    const h = Math.min(shape.notch.h, W - 1);
    switch (shape.notch.corner) {
      case 0: pts = [[w, 0], [L, 0], [L, W], [0, W], [0, h], [w, h]]; convex.splice(0, 4, true, true, true, true, true, false); break;
      case 1: pts = [[0, 0], [L - w, 0], [L - w, h], [L, h], [L, W], [0, W]]; convex.splice(0, 4, true, true, false, true, true, true); break;
      case 2: pts = [[0, 0], [L, 0], [L, W - h], [L - w, W - h], [L - w, W], [0, W]]; convex.splice(0, 4, true, true, true, false, true, true); break;
      case 3: pts = [[0, 0], [L, 0], [L, W], [w, W], [w, W - h], [0, W - h]]; convex.splice(0, 4, true, true, true, true, false, true); break;
    }
  }

  const r = shape?.radius ?? 0;
  const outer = r > 0 ? roundCorners(pts, convex, r) : pts;

  const holes = (shape?.holes ?? [])
    .map((h): Pt[] => {
      const x0 = Math.max(0, h.x), y0 = Math.max(0, h.y);
      const x1 = Math.min(L, h.x + h.w), y1 = Math.min(W, h.y + h.h);
      return x1 > x0 && y1 > y0 ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : [];
    })
    .filter((p) => p.length);
  return { outer, holes };
}

function roundCorners(pts: Pt[], convex: boolean[], radius: number): Pt[] {
  const out: Pt[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const V = pts[i];
    if (!convex[i]) { out.push(V); continue; }
    const A = pts[(i + n - 1) % n];
    const B = pts[(i + 1) % n];
    const l1 = Math.hypot(V[0] - A[0], V[1] - A[1]);
    const l2 = Math.hypot(B[0] - V[0], B[1] - V[1]);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5) { out.push(V); continue; }
    const d1: Pt = [(V[0] - A[0]) / l1, (V[1] - A[1]) / l1];
    const d2: Pt = [(B[0] - V[0]) / l2, (B[1] - V[1]) / l2];
    const T1: Pt = [V[0] - d1[0] * r, V[1] - d1[1] * r];
    const C: Pt = [T1[0] - d1[1] * r, T1[1] + d1[0] * r]; // centro a la izquierda (interior, sentido antihorario)
    const a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]);
    const T2: Pt = [V[0] + d2[0] * r, V[1] + d2[1] * r];
    const a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]);
    let da = a2 - a1;
    while (da <= 0) da += Math.PI * 2;
    const steps = 6;
    for (let k = 0; k <= steps; k++) {
      const a = a1 + (da * k) / steps;
      out.push([C[0] + Math.cos(a) * r, C[1] + Math.sin(a) * r]);
    }
  }
  return out;
}

export function polygonArea(p: Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}
