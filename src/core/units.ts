/**
 * Medidas: limpieza de ruido de coma flotante, formato para pantalla, paso de movimiento y puntos de imán.
 * Todo el modelo guarda milímetros en coma flotante (sin cuadrícula): estas funciones solo limpian y muestran.
 */

/** Quita el ruido de coma flotante (12.0000001 -> 12) conservando hasta 3 decimales (micras). */
export const cleanMm = (n: number): number => {
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Texto de una medida en mm con coma decimal (es): sin decimales de más ("12", "12,5", "12,25").
 * `min` fuerza un mínimo de decimales (la herramienta Medir usa 1); `max` es el máximo (2 por omisión).
 */
export function fmtMm(n: number, min = 0, max = 2): string {
  if (!Number.isFinite(n)) return '–';
  const v = cleanMm(n);
  let s = v.toFixed(max);
  if (s.includes('.')) {
    let [int, dec] = s.split('.');
    while (dec.length > min && dec.endsWith('0')) dec = dec.slice(0, -1);
    s = dec ? `${int}.${dec}` : int;
  }
  if (/^-0(\.0+)?$/.test(s)) s = s.slice(1);
  return s.replace('.', ',');
}

/** Pasos de movimiento disponibles en la barra; 0 = libre (sin redondeo). */
export const MOVE_STEPS = [0, 0.1, 1, 5, 10, 50] as const;
export const DEFAULT_MOVE_STEP = 1;

/** Redondea al múltiplo de `step`; con paso 0 (libre) solo limpia el ruido. */
export const stepRound = (v: number, step: number): number => cleanMm(step > 0 ? Math.round(v / step) * step : v);

/** Interpreta un paso guardado (texto): solo valores permitidos, si no el de omisión. */
export function parseMoveStep(raw: string | null | undefined): number {
  const n = raw === null || raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return (MOVE_STEPS as readonly number[]).includes(n) ? n : DEFAULT_MOVE_STEP;
}

/**
 * Alcance del imán a bordes de otras piezas, en mm, para `px` píxeles de pantalla a esa distancia de cámara:
 * al acercar el zoom el alcance se reduce (precisión), al alejarlo crece. Acotado a [1, 60] mm.
 */
export function snapRangeMm(mmPerPixel: number, px = 10): number {
  return Math.min(60, Math.max(1, mmPerPixel * px));
}

export type P3 = [number, number, number];
export interface SnapCandidate { p: P3; kind: 'vertice' | 'medio' | 'centro' | 'arista' }

/**
 * Elige el punto de imán más cercano a `ref` dentro de `maxDist` (mm). Prioridad: vértice > punto medio / centro > punto cualquiera de una arista, con una ventana del 30 %
 * del alcance, de modo que una esquina no se pierda por un punto medio o una arista cercanos.
 */
export function pickSnapPoint(cands: SnapCandidate[], ref: P3, maxDist: number): SnapCandidate | null {
  const rank = { vertice: 0, medio: 1, centro: 1, arista: 2 } as const;
  const tol = maxDist * 0.3; // ventana de preferencia: un vértice puede estar hasta 30 % del alcance más lejos que un punto medio o una arista
  let best: SnapCandidate | null = null, bd = Infinity;
  for (const c of cands) {
    const d = Math.hypot(c.p[0] - ref[0], c.p[1] - ref[1], c.p[2] - ref[2]);
    if (d > maxDist) continue;
    const better = best === null
      || (rank[c.kind] < rank[best.kind] ? d <= bd + tol : rank[c.kind] > rank[best.kind] ? d < bd - tol : d < bd);
    if (better) { best = c; bd = d; }
  }
  return best;
}

/** Componentes y total de la distancia entre dos puntos (mm). */
export function measureBetween(a: P3, b: P3) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  return { dx, dy, dz, total: Math.hypot(dx, dy, dz) };
}

/** Texto de una medida entre dos puntos: distancia total y ΔX/ΔY/ΔZ con al menos 1 decimal (0,1 mm). */
export function measureText(a: P3, b: P3): { total: string; detail: string; copy: string } {
  const m = measureBetween(a, b);
  const t = fmtMm(m.total, 1), x = fmtMm(Math.abs(m.dx), 1), y = fmtMm(Math.abs(m.dy), 1), z = fmtMm(Math.abs(m.dz), 1);
  return { total: `${t} mm`, detail: `ΔX ${x} · ΔY ${y} · ΔZ ${z}`, copy: `${t} mm (ΔX ${x}, ΔY ${y}, ΔZ ${z})` };
}

/** Espaciado automático de la cuadrícula visual: el menor paso de la lista cuya separación en pantalla es >= `minPx`. */
export const GRID_STEPS = [1, 5, 10, 50, 100, 200, 1000] as const;
export function gridStepFor(mmPerPixel: number, minPx = 14): number {
  for (const s of GRID_STEPS) if (s / mmPerPixel >= minPx) return s;
  return GRID_STEPS[GRID_STEPS.length - 1];
}

/**
 * Divisiones de la cuadrícula para cubrir "extent" mm con ese paso, con un tope de líneas TOTALES (las dos direcciones, "maxLines").
 * Si no cabe, windowed = true: se dibuja solo una ventana (de "divisions" pasos) alrededor de la vista, nunca más líneas.
 */
export function gridLayout(extent: number, step: number, maxLines = 500): { divisions: number; windowed: boolean } {
  const cap = Math.max(2, Math.floor(maxLines / 2) - 1);
  const need = Math.max(1, Math.ceil(extent / step));
  return need > cap ? { divisions: cap - (cap % 2), windowed: true } : { divisions: need, windowed: false };
}
