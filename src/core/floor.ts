import type { FloorPlan } from './types';

/** Lado de baldosa por defecto (mm): porcelanato de 60×60 cm. Otros formatos habituales: 800, 1200 (o 600×1200 con tileH). */
export const DEFAULT_TILE = 600;

/** Acabado de piso de una habitación (imagen de la carpeta `texturas/` de los datos y lado de la baldosa en mm). */
export interface RoomFloor { image: string; tile: number }

/** Nombre de archivo de textura admitido (sin rutas): letras, números, punto, guion y guion bajo; solo png/jpg/jpeg/webp. */
export function isTextureName(n: unknown): n is string {
  return typeof n === 'string' && n.length <= 80 && /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|webp)$/i.test(n) && !n.includes('..');
}

export interface FloorRect { x0: number; z0: number; x1: number; z1: number }

/**
 * Piso real de una habitación: rasteriza los paneles de muro (celdas de 5 mm), rellena el hueco que contiene el
 * centro de la habitación y lo devuelve como rectángulos sin solaparse (fusiona filas iguales). La caja guardada
 * de la habitación no sirve porque la mayoría no son rectangulares (tabiques, lóbulos).
 */
export function roomFloorRects(plan: FloorPlan, roomId: string): FloorRect[] {
  const ras = roomRaster(plan, roomId);
  if (!ras) return [];
  const { g, nx, nz, X0, Z0, cs } = ras;
  // filas -> rectángulos: una tira por tramo continuo, ampliada hacia abajo mientras el tramo sea idéntico
  const out: FloorRect[] = [];
  let open = new Map<string, FloorRect>();
  for (let j = 0; j <= nz; j++) {
    const next = new Map<string, FloorRect>();
    for (let i = 0; j < nz && i < nx;) {
      if (g[j * nx + i] !== 2) { i++; continue; }
      let e = i;
      while (e < nx && g[j * nx + e] === 2) e++;
      const key = `${i}:${e}`;
      const r = open.get(key);
      if (r) { r.z1 = Z0 + (j + 1) * cs; next.set(key, r); open.delete(key); }
      else { const n = { x0: X0 + i * cs, z0: Z0 + j * cs, x1: X0 + e * cs, z1: Z0 + (j + 1) * cs }; out.push(n); next.set(key, n); }
      i = e;
    }
    open = next;
  }
  return out;
}

/** Cuadrícula de 5 mm de la habitación: 1 = muro, 2 = piso (hueco que contiene el centro de la habitación). */
export interface RoomRaster { g: Uint8Array; nx: number; nz: number; X0: number; Z0: number; cs: number }
export function roomRaster(plan: FloorPlan, roomId: string): RoomRaster | null {
  const room = plan.rooms?.find((r) => r.id === roomId);
  const walls = plan.walls;
  if (!room || !walls?.length) return null;
  const cs = 5, m = 300;
  const X0 = room.x0 - m, Z0 = room.z0 - m;
  const nx = Math.ceil((room.x1 - room.x0 + 2 * m) / cs), nz = Math.ceil((room.z1 - room.z0 + 2 * m) / cs);
  const g = new Uint8Array(nx * nz); // 1 = muro, 2 = piso
  for (const w of walls) {
    const j1 = Math.min(nz - 1, Math.floor((w.z1 - Z0 - 0.01) / cs)), i1 = Math.min(nx - 1, Math.floor((w.x1 - X0 - 0.01) / cs));
    for (let j = Math.max(0, Math.floor((w.z0 - Z0) / cs)); j <= j1; j++) {
      for (let i = Math.max(0, Math.floor((w.x0 - X0) / cs)); i <= i1; i++) g[j * nx + i] = 1;
    }
  }
  const si = Math.floor((room.cx - X0) / cs), sj = Math.floor((room.cz - Z0) / cs);
  const start = sj * nx + si;
  if (si < 0 || sj < 0 || si >= nx || sj >= nz || g[start] !== 0) return null;
  const stack = [start];
  g[start] = 2;
  while (stack.length) {
    const k = stack.pop()!, i = k % nx, j = (k - i) / nx;
    if (i > 0 && g[k - 1] === 0) { g[k - 1] = 2; stack.push(k - 1); }
    if (i < nx - 1 && g[k + 1] === 0) { g[k + 1] = 2; stack.push(k + 1); }
    if (j > 0 && g[k - nx] === 0) { g[k - nx] = 2; stack.push(k - nx); }
    if (j < nz - 1 && g[k + nx] === 0) { g[k + nx] = 2; stack.push(k + nx); }
  }
  return { g, nx, nz, X0, Z0, cs };
}

/** Área (m²) de un conjunto de rectángulos. */
export const rectsArea = (rs: FloorRect[]) => rs.reduce((s, r) => s + (r.x1 - r.x0) * (r.z1 - r.z0), 0) / 1e6;
