/** Techo (ensamble): celdas cerradas que forman las líneas del plano de techo (subdivisión planar). Módulo puro. */

/** Espesor por defecto del panel de techo (mm). */
export const ROOF_THICKNESS = 210;

export interface RoofText { x: number; z: number; t: string; h?: number }
export interface RoofCell {
  /** Contorno (x,z) sin repetir el primer punto, orientado de forma constante. */
  pts: [number, number][];
  /** Área en mm². */
  area: number;
  /** Etiquetas de los textos que caen dentro (H##/T##), en el orden del plano. */
  labels: string[];
}
export interface RoofOptions {
  /** Distancia máxima para unir puntas y apoyar una punta en otra línea (mm). */
  tol?: number;
  /** Las líneas más cortas que esto se ignoran (teselado de arcos, marcas) (mm). */
  minLen?: number;
  /** Las celdas con menos área se descartan (mm²). */
  minArea?: number;
}
export interface RoofResult {
  cells: RoofCell[];
  /** Líneas totales / usadas / ignoradas por cortas / aristas sueltas podadas / caras diminutas / celdas. */
  stats: { lines: number; used: number; tooShort: number; dangling: number; tinyFaces: number; enclosing: number; cells: number };
}

type Seg = [number, number, number, number];

export function roofCells(lines: number[][], texts: RoofText[] = [], opts: RoofOptions = {}): RoofResult {
  const tol = opts.tol ?? 10, minLen = opts.minLen ?? 50, minArea = opts.minArea ?? 10000;
  const segs: Seg[] = [];
  let tooShort = 0;
  for (const l of lines) {
    if (Math.hypot(l[2] - l[0], l[3] - l[1]) < minLen) tooShort++;
    else segs.push([l[0], l[1], l[2], l[3]]);
  }
  // puntos candidatos: puntas e intersecciones (con prolongación de `tol` en las puntas)
  const pts: [number, number][] = [];
  for (const s of segs) pts.push([s[0], s[1]], [s[2], s[3]]);
  const proj = (s: Seg, px: number, pz: number) => {
    const dx = s[2] - s[0], dz = s[3] - s[1], L2 = dx * dx + dz * dz;
    const t = ((px - s[0]) * dx + (pz - s[1]) * dz) / L2;
    return { t, d: Math.hypot(s[0] + t * dx - px, s[1] + t * dz - pz) };
  };
  for (let i = 0; i < segs.length; i++) {
    const a = segs[i];
    for (let j = i + 1; j < segs.length; j++) {
      const b = segs[j];
      if (Math.max(a[0], a[2]) + tol < Math.min(b[0], b[2]) || Math.max(b[0], b[2]) + tol < Math.min(a[0], a[2])) continue;
      if (Math.max(a[1], a[3]) + tol < Math.min(b[1], b[3]) || Math.max(b[1], b[3]) + tol < Math.min(a[1], a[3])) continue;
      const rx = a[2] - a[0], rz = a[3] - a[1], sx = b[2] - b[0], sz = b[3] - b[1];
      const den = rx * sz - rz * sx;
      if (Math.abs(den) < 1e-9 * Math.hypot(rx, rz) * Math.hypot(sx, sz)) continue; // paralelas
      const t = ((b[0] - a[0]) * sz - (b[1] - a[1]) * sx) / den;
      const u = ((b[0] - a[0]) * rz - (b[1] - a[1]) * rx) / den;
      const ta = tol / Math.hypot(rx, rz), tb = tol / Math.hypot(sx, sz);
      if (t >= -ta && t <= 1 + ta && u >= -tb && u <= 1 + tb) pts.push([a[0] + t * rx, a[1] + t * rz]);
    }
  }
  // agrupar puntos cercanos en nodos (hash espacial + unión)
  const parent = pts.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cellOf = (v: number) => Math.floor(v / tol);
  const grid = new Map<string, number[]>();
  pts.forEach((p, i) => {
    const cx = cellOf(p[0]), cz = cellOf(p[1]);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(`${cx + dx},${cz + dz}`) ?? []) if (Math.hypot(pts[j][0] - p[0], pts[j][1] - p[1]) <= tol) parent[find(i)] = find(j);
    }
    const k = `${cx},${cz}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(i);
  });
  const nodeOf = new Map<number, number>();
  const acc: [number, number, number][] = [];
  pts.forEach((p, i) => {
    const r = find(i);
    let n = nodeOf.get(r);
    if (n === undefined) { n = acc.length; nodeOf.set(r, n); acc.push([0, 0, 0]); }
    acc[n][0] += p[0]; acc[n][1] += p[1]; acc[n][2]++;
  });
  const NX = acc.map((n) => n[0] / n[2]), NZ = acc.map((n) => n[1] / n[2]);
  const nodeAt = (i: number) => nodeOf.get(find(i))!;
  // trocear cada línea por los nodos que le caen encima
  const edges = new Set<string>();
  const cs = Math.max(tol * 4, 200);
  const nodeGrid = new Map<string, number[]>();
  NX.forEach((x, n) => {
    const k = `${Math.floor(x / cs)},${Math.floor(NZ[n] / cs)}`;
    if (!nodeGrid.has(k)) nodeGrid.set(k, []);
    nodeGrid.get(k)!.push(n);
  });
  segs.forEach((s, si) => {
    const n0 = nodeAt(si * 2), n1 = nodeAt(si * 2 + 1);
    const on: { t: number; n: number }[] = [{ t: 0, n: n0 }, { t: 1, n: n1 }];
    for (let cx = Math.floor((Math.min(s[0], s[2]) - tol) / cs); cx <= Math.floor((Math.max(s[0], s[2]) + tol) / cs); cx++)
      for (let cz = Math.floor((Math.min(s[1], s[3]) - tol) / cs); cz <= Math.floor((Math.max(s[1], s[3]) + tol) / cs); cz++)
        for (const n of nodeGrid.get(`${cx},${cz}`) ?? []) {
          if (n === n0 || n === n1) continue;
          const q = proj(s, NX[n], NZ[n]);
          if (q.t > 0 && q.t < 1 && q.d <= tol) on.push({ t: q.t, n });
        }
    on.sort((a, b) => a.t - b.t);
    for (let k = 0; k + 1 < on.length; k++) {
      const a = on[k].n, b = on[k + 1].n;
      if (a !== b) edges.add(a < b ? `${a},${b}` : `${b},${a}`);
    }
  });
  // podar puntas sueltas
  const adj: Set<number>[] = NX.map(() => new Set<number>());
  for (const e of edges) { const [a, b] = e.split(',').map(Number); adj[a].add(b); adj[b].add(a); }
  let dangling = 0;
  const stack = adj.map((s, i) => (s.size === 1 ? i : -1)).filter((i) => i >= 0);
  while (stack.length) {
    const n = stack.pop()!;
    if (adj[n].size !== 1) continue;
    const [m] = adj[n];
    adj[n].delete(m); adj[m].delete(n); dangling++;
    if (adj[m].size === 1) stack.push(m);
  }
  // caras: recorrido de medias aristas
  const ang = (n: number, m: number) => Math.atan2(NZ[m] - NZ[n], NX[m] - NX[n]);
  const order: number[][] = adj.map((s, n) => [...s].sort((a, b) => ang(n, a) - ang(n, b)));
  const seen = new Set<string>();
  const cells: RoofCell[] = [];
  let tinyFaces = 0;
  for (let a = 0; a < adj.length; a++) {
    for (const b0 of adj[a]) {
      if (seen.has(`${a},${b0}`)) continue;
      const poly: number[] = [];
      let u = a, v = b0, ok = false;
      for (let guard = 0; guard < 100000; guard++) {
        const key = `${u},${v}`;
        if (seen.has(key)) { ok = u === a && v === b0; break; }
        seen.add(key);
        poly.push(u);
        const o = order[v], i = o.indexOf(u);
        const w = o[(i - 1 + o.length) % o.length];
        u = v; v = w;
      }
      if (!ok || poly.length < 3) continue;
      let ar = 0;
      for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; ar += NX[p] * NZ[q] - NX[q] * NZ[p]; }
      ar /= 2;
      // las caras interiores salen con área positiva y la exterior (de cada componente) con negativa
      if (ar <= 0) continue;
      if (ar < minArea) { tinyFaces++; continue; }
      cells.push({ pts: poly.map((n) => [NX[n], NZ[n]] as [number, number]), area: ar, labels: [] });
    }
  }
  // una cara que rodea a varias otras (p. ej. el contorno exterior con los paneles dentro) no es un panel;
  // si rodea a una sola es el recuadro con su detalle interior: vale el recuadro exterior
  const inside = (c: RoofCell, d: RoofCell) => d !== c && d.area < c.area && d.pts.every((q) => inPoly(c.pts, q[0], q[1]));
  const sorted = [...cells].sort((p, q) => q.area - p.area);
  const leaf: RoofCell[] = [];
  for (const c of sorted) {
    if (sorted.filter((d) => inside(c, d)).length >= 2) continue;
    if (leaf.some((k) => inside(k, c))) continue;
    leaf.push(c);
  }
  const enclosing = cells.length - leaf.length;
  const bySize = [...leaf].sort((p, q) => p.area - q.area);
  for (const t of texts) {
    for (const c of bySize) if (inPoly(c.pts, t.x, t.z)) { c.labels.push(t.t); break; }
  }
  return { cells: leaf, stats: { lines: lines.length, used: segs.length, tooShort, dangling, tinyFaces, enclosing, cells: leaf.length } };
}

export function inPoly(p: [number, number][], x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if ((p[i][1] > z) !== (p[j][1] > z) && x < ((p[j][0] - p[i][0]) * (z - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  }
  return c;
}
