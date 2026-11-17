import type { Bounds } from '../core/geom2d';
import type { Pt2 } from '../core/types';
import { GRID_STEPS, gridStepFor } from '../core/units';

/**
 * Transformación de vista del lienzo 2D (pura, sin DOM): (cx, cy) es el punto del dibujo que cae en el centro del lienzo,
 * `scale` los píxeles por mm y (w, h) el tamaño del lienzo en píxeles. En pantalla y crece hacia abajo; en el dibujo, hacia arriba.
 */
export interface View { cx: number; cy: number; scale: number; w: number; h: number }

export const MIN_SCALE = 0.0005;
export const MAX_SCALE = 200;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** Punto del dibujo -> píxeles del lienzo. */
export const toScreen = (v: View, p: Pt2): Pt2 => [v.w / 2 + (p[0] - v.cx) * v.scale, v.h / 2 - (p[1] - v.cy) * v.scale];
/** Píxeles del lienzo -> punto del dibujo. */
export const toDrawing = (v: View, s: Pt2): Pt2 => [v.cx + (s[0] - v.w / 2) / v.scale, v.cy - (s[1] - v.h / 2) / v.scale];
export const mmPerPixel = (v: View): number => 1 / v.scale;

/** Zoom por `factor` dejando fijo el punto del dibujo que está bajo el cursor (sx, sy en píxeles). */
export function zoomAt(v: View, sx: number, sy: number, factor: number): View {
  const scale = clampScale(v.scale * factor);
  const k = scale / v.scale;
  if (k === 1) return v;
  const p = toDrawing(v, [sx, sy]);
  // tras el zoom, p debe seguir en (sx, sy): cx = px - (sx - w/2)/scale
  return { ...v, scale, cx: p[0] - (sx - v.w / 2) / scale, cy: p[1] + (sy - v.h / 2) / scale };
}

/** Arrastre de `dx, dy` píxeles: el dibujo sigue al cursor. */
export const panBy = (v: View, dx: number, dy: number): View => ({ ...v, cx: v.cx - dx / v.scale, cy: v.cy + dy / v.scale });

/** Vista que encuadra una caja con `margin` píxeles libres; sin caja (o vacía), 6 m de ancho alrededor del origen. */
export function fitView(b: Bounds | null, w: number, h: number, margin = 40): View {
  const W = Math.max(w, 1), H = Math.max(h, 1);
  if (!b) return { cx: 0, cy: 0, scale: clampScale(W / 6000), w: W, h: H };
  const bw = b.max[0] - b.min[0], bh = b.max[1] - b.min[1];
  const m = Math.min(margin, Math.min(W, H) / 4);
  const sx = bw > 1e-9 ? (W - 2 * m) / bw : Infinity, sy = bh > 1e-9 ? (H - 2 * m) / bh : Infinity;
  const s = Math.min(sx, sy);
  const scale = Number.isFinite(s) ? clampScale(s) : clampScale(W / 600); // un punto solo: 600 mm de ancho
  return { cx: (b.min[0] + b.max[0]) / 2, cy: (b.min[1] + b.max[1]) / 2, scale, w: W, h: H };
}

/** Caja visible del dibujo (mm). */
export function visibleBounds(v: View): Bounds {
  const a = toDrawing(v, [0, 0]), b = toDrawing(v, [v.w, v.h]);
  return { min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])], max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])] };
}

/**
 * Paso de la cuadrícula (mm) para el zoom actual: reutiliza gridStepFor (units.ts) y, si el dibujo se aleja tanto que ni el mayor
 * paso fijo (1 m) separa lo suficiente las líneas, sigue con potencias de 10.
 */
export function gridStep2d(mmPerPx: number, minPx = 14): number {
  let s: number = gridStepFor(mmPerPx, minPx);
  const top = GRID_STEPS[GRID_STEPS.length - 1];
  if (s === top) while (s / mmPerPx < minPx) s *= 10;
  return s;
}

export interface GridLine { /** posición en píxeles del lienzo */ px: number; /** valor del dibujo (mm) */ mm: number; major: boolean }
export interface GridLines { step: number; vertical: GridLine[]; horizontal: GridLine[]; /** píxel del eje x=0 / y=0 si es visible */ axisX: number | null; axisY: number | null }

/** Líneas de la cuadrícula visibles (en píxeles), con una línea mayor cada 5 pasos y un tope de líneas por si el paso fuese diminuto. */
export function gridLines(v: View, minPx = 14, maxLines = 400): GridLines {
  const step = gridStep2d(mmPerPixel(v), minPx);
  const vb = visibleBounds(v);
  const make = (lo: number, hi: number, toPx: (mm: number) => number): GridLine[] => {
    const out: GridLine[] = [];
    const first = Math.ceil(lo / step - 1e-9);
    const last = Math.floor(hi / step + 1e-9);
    if (last - first > maxLines) return out;
    for (let i = first; i <= last; i++) out.push({ px: toPx(i * step), mm: Math.round(i * step * 1000) / 1000, major: i % 5 === 0 });
    return out;
  };
  const vertical = make(vb.min[0], vb.max[0], (mm) => toScreen(v, [mm, 0])[0]);
  const horizontal = make(vb.min[1], vb.max[1], (mm) => toScreen(v, [0, mm])[1]);
  const ax = toScreen(v, [0, 0]);
  return { step, vertical, horizontal, axisX: ax[0] >= 0 && ax[0] <= v.w ? ax[0] : null, axisY: ax[1] >= 0 && ax[1] <= v.h ? ax[1] : null };
}

/** Zoom como porcentaje (100 % = 1 píxel por mm). */
export const zoomText = (v: View): string => `${Math.round(v.scale * 1000) / 10}%`;
