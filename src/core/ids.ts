import type { FloorPlan, PlanRoom } from './types';

/** Tramo recto de muro: varios paneles seguidos sobre la misma línea y del mismo tipo. */
export interface WallRun {
  id: string;
  kind: 'MP' | 'MI';
  x0: number; z0: number; x1: number; z1: number;
  /** Largo del tramo (mm). */
  len: number;
  horiz: boolean;
}

/**
 * Habitaciones de la casa: zonas cerradas por los paneles de muro de la planta (rasteriza los muros y rellena
 * los huecos que no se conectan con el exterior). Devuelve cada una con caja, centro y área; ids H1, H2… en
 * orden de lectura (de arriba a abajo, de izquierda a derecha).
 */
export function detectRooms(plan: FloorPlan): PlanRoom[] {
  const h = plan.house, walls = plan.walls;
  if (!h || !walls?.length) return [];
  const cs = 25, pad = 2;
  const nx = Math.ceil((h.x1 - h.x0) / cs) + pad * 2, nz = Math.ceil((h.z1 - h.z0) / cs) + pad * 2;
  const grid = new Uint8Array(nx * nz); // 1 = muro, 2 = exterior
  const cx = (x: number) => Math.floor((x - h.x0) / cs) + pad, cz = (z: number) => Math.floor((z - h.z0) / cs) + pad;
  for (const w of walls) {
    for (let j = Math.max(0, cz(w.z0 - 12)); j <= Math.min(nz - 1, cz(w.z1 + 12)); j++) {
      for (let i = Math.max(0, cx(w.x0 - 12)); i <= Math.min(nx - 1, cx(w.x1 + 12)); i++) grid[j * nx + i] = 1;
    }
  }
  const queue = new Int32Array(nx * nz);
  const fill = (start: number, mark: number) => {
    let qh = 0, qt = 0, n = 0, sx = 0, sz = 0, i0 = Infinity, i1 = -1, j0 = Infinity, j1 = -1;
    queue[qt++] = start; grid[start] = mark;
    while (qh < qt) {
      const p = queue[qh++], i = p % nx, j = (p - i) / nx;
      n++; sx += i; sz += j; i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      for (const q of [i > 0 ? p - 1 : -1, i < nx - 1 ? p + 1 : -1, j > 0 ? p - nx : -1, j < nz - 1 ? p + nx : -1]) {
        if (q >= 0 && grid[q] === 0) { grid[q] = mark; queue[qt++] = q; }
      }
    }
    return { n, sx, sz, i0, i1, j0, j1 };
  };
  fill(0, 2);
  const out: PlanRoom[] = [];
  for (let p = 0; p < grid.length; p++) {
    if (grid[p] !== 0) continue;
    const c = fill(p, 3);
    const area = (c.n * cs * cs) / 1e6;
    if (area < 0.5) continue;
    // centro: el promedio, o la celda de la zona más cercana si el promedio cae en un muro
    let ci = Math.round(c.sx / c.n), cj = Math.round(c.sz / c.n);
    if (grid[cj * nx + ci] !== 3) {
      let best = Infinity;
      for (let q = 0; q < grid.length; q++) {
        if (grid[q] !== 3) continue;
        const i = q % nx, j = (q - i) / nx, d = (i - ci) ** 2 + (j - cj) ** 2;
        if (d < best) { best = d; ci = i; cj = j; }
      }
    }
    out.push({
      id: '', name: '', area: Math.round(area * 10) / 10,
      x0: h.x0 + (c.i0 - pad) * cs, x1: h.x0 + (c.i1 - pad + 1) * cs, z0: h.z0 + (c.j0 - pad) * cs, z1: h.z0 + (c.j1 - pad + 1) * cs,
      cx: Math.round(h.x0 + (ci - pad + 0.5) * cs), cz: Math.round(h.z0 + (cj - pad + 0.5) * cs),
    });
  }
  // las filas se miden desde la esquina de la casa: así las claves no cambian si se recorta o se mueve el plano
  out.sort((a, b) => Math.round((a.cz - h.z0) / 1500) - Math.round((b.cz - h.z0) / 1500) || a.cx - b.cx);
  out.forEach((r, i) => { r.id = `H${i + 1}`; });
  return out;
}

/** Tramos de muro con clave: P1… perimetrales (en sentido horario desde arriba) e I1… interiores (en orden de lectura). */
export function wallRuns(plan: FloorPlan): WallRun[] {
  const runs = runsOf(plan.walls ?? []);
  const h = plan.house;
  const mx = h ? (h.x0 + h.x1) / 2 : 0, mz = h ? (h.z0 + h.z1) / 2 : 0;
  const ang = (r: WallRun) => (Math.atan2((r.z0 + r.z1) / 2 - mz, (r.x0 + r.x1) / 2 - mx) + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI);
  const mp = runs.filter((r) => r.kind === 'MP').sort((a, b) => ang(a) - ang(b));
  const mi = runs.filter((r) => r.kind === 'MI').sort((a, b) => Math.round((a.z0 - (h?.z0 ?? 0)) / 1500) - Math.round((b.z0 - (h?.z0 ?? 0)) / 1500) || a.x0 - b.x0);
  mp.forEach((r, i) => { r.id = `P${i + 1}`; });
  mi.forEach((r, i) => { r.id = `I${i + 1}`; });
  return [...mp, ...mi];
}

/** Junta los paneles de muro que están seguidos sobre la misma línea y son del mismo tipo (sin claves). */
export function runsOf(walls: NonNullable<FloorPlan['walls']>): WallRun[] {
  const runs: WallRun[] = [];
  const groups = new Map<string, NonNullable<FloorPlan['walls']>>();
  for (const w of walls) {
    const horiz = w.x1 - w.x0 >= w.z1 - w.z0;
    const c = horiz ? (w.z0 + w.z1) / 2 : (w.x0 + w.x1) / 2;
    const key = `${w.kind}${horiz ? 'h' : 'v'}${Math.round(c / 20)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(w);
  }
  for (const [key, ws] of groups) {
    const horiz = key[2] === 'h', kind = key.slice(0, 2) as 'MP' | 'MI';
    const lo = (w: (typeof ws)[number]) => (horiz ? w.x0 : w.z0), hi = (w: (typeof ws)[number]) => (horiz ? w.x1 : w.z1);
    ws.sort((a, b) => lo(a) - lo(b));
    let cur: (typeof ws) = [];
    const flush = () => {
      if (!cur.length) return;
      const x0 = Math.min(...cur.map((w) => w.x0)), x1 = Math.max(...cur.map((w) => w.x1)), z0 = Math.min(...cur.map((w) => w.z0)), z1 = Math.max(...cur.map((w) => w.z1));
      runs.push({ id: '', kind, x0, z0, x1, z1, len: Math.round(horiz ? x1 - x0 : z1 - z0), horiz });
      cur = [];
    };
    for (const w of ws) {
      if (cur.length && lo(w) > Math.max(...cur.map(hi)) + 60) flush();
      cur.push(w);
    }
    flush();
  }
  return runs;
}

/** Claves de puertas (D1…), ventanas (V1…) y aberturas por confirmar (A1…): primero las leídas del plano, en orden de lectura, y después las agregadas a mano, en el orden en que se agregaron. */
export function openingIds(plan: FloorPlan) {
  const all = (plan.openings ?? []).map((o, i) => ({ o, i, x: (o.x1 + o.x2) / 2, z: (o.z1 + o.z2) / 2 }));
  const list = all.filter((q) => !q.o.manual), manual = all.filter((q) => q.o.manual);
  const oz = plan.house?.z0 ?? 0;
  list.sort((a, b) => Math.round((a.z - oz) / 1500) - Math.round((b.z - oz) / 1500) || a.x - b.x);
  let d = 0, v = 0, a = 0;
  return [...list, ...manual].map((q) => ({ ...q, id: q.o.unknown ? `A${++a}` : q.o.kind === 'door' ? `D${++d}` : `V${++v}` }));
}

/**
 * Abertura puesta sobre un muro por su clave: `start` es la distancia desde el extremo izquierdo (muros horizontales)
 * o superior (verticales) del tramo hasta el borde de la abertura. Devuelve null si la clave no existe o no cabe.
 */
export function makeOpening(plan: FloorPlan, wallId: string, kind: 'door' | 'window', start: number, width: number, sill: number, height: number): NonNullable<FloorPlan['openings']>[number] | null {
  const w = wallRuns(plan).find((r) => r.id === wallId);
  if (!w || width < 200 || height < 200 || start < 0 || start + width > w.len + 1) return null;
  const H = plan.panelH ?? 2440;
  if (sill + height > H) return null;
  const r = (n: number) => Math.round(n * 10) / 10;
  const base = { y: Math.round(sill), h: Math.round(height), kind, manual: true, wall: wallId };
  return w.horiz
    ? { x1: r(w.x0 + start), z1: r((w.z0 + w.z1) / 2), x2: r(w.x0 + start + width), z2: r((w.z0 + w.z1) / 2), ...base }
    : { x1: r((w.x0 + w.x1) / 2), z1: r(w.z0 + start), x2: r((w.x0 + w.x1) / 2), z2: r(w.z0 + start + width), ...base };
}
