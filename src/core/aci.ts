/**
 * Tabla mínima de colores ACI (AutoCAD Color Index) para las capas y entidades del dibujo 2D.
 * Los índices 1..9 y 250..255 son los oficiales; 10..249 se generan con la estructura del ACI
 * (24 matices de 15° x 10 variantes de saturación/valor) y son una APROXIMACIÓN visual, no exacta al DXF.
 * Índice 7 = blanco/negro: se muestra negro sobre papel claro y blanco sobre fondo oscuro (`aciToHex(7, dark)`).
 */
const BASE: Record<number, string> = {
  1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 7: '#ffffff', 8: '#808080', 9: '#c0c0c0',
  250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe', 255: '#ffffff',
};
const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
function hsv(h: number, s: number, v: number): string {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${hex2((r + m) * 255)}${hex2((g + m) * 255)}${hex2((b + m) * 255)}`;
}
export const isAci = (c: unknown): c is number => typeof c === 'number' && Number.isInteger(c) && c >= 1 && c <= 255;
export const isHexColor = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
export const isDrawingColor = (c: unknown): boolean => isAci(c) || isHexColor(c);

/** Color CSS (#rrggbb) de un índice ACI o de un hexadecimal. `dark` = fondo oscuro (el 7 pasa a blanco; si no, a negro). */
export function aciToHex(c: number | string, dark = false): string {
  if (typeof c === 'string') return c.toLowerCase();
  if (c === 7) return dark ? '#ffffff' : '#000000';
  if (BASE[c]) return BASE[c];
  if (c >= 10 && c <= 249) {
    const k = (c - 10) % 10, hue = Math.floor((c - 10) / 10) * 15;
    const v = [1, 0.65, 0.5, 0.3, 0.15][Math.floor(k / 2)], s = k % 2 === 0 ? 1 : 0.5;
    return hsv(hue, s, v);
  }
  return '#000000';
}
