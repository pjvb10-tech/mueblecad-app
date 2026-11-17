import { PAPER_MM, pdfText, scaleLabel, type TitleBlock } from './pdfDrawing';

/**
 * Exportar vistas: núcleo PURO (sin DOM ni servidor) de tamaños de imagen, vistas estándar, formas vectoriales (SVG/PDF),
 * escritor de PDF con imágenes JPEG/Flate incrustadas y composición de una lámina (título/cajetín + hasta 4 vistas + lista de piezas).
 * Todo el vectorial se coloca en milímetros de papel con el eje y hacia ABAJO (como SVG); el PDF lo voltea al escribir.
 */

// ---------------------------------------------------------------- tamaños de imagen

/** Lado máximo (px) y píxeles totales máximos que se aceptan al exportar (el WebGL de muchos equipos no pasa de 8192 por lado). */
export const MAX_SIDE = 8192;
export const MAX_PIXELS = 50_000_000;

/** Reduce (conservando la proporción) un tamaño que se pasa de los límites. `clamped` indica si hubo ajuste. */
export function clampSize(w: number, h: number, maxSide = MAX_SIDE, maxPixels = MAX_PIXELS): { w: number; h: number; clamped: boolean } {
  if (!(w > 0 && h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) throw new Error('El tamaño de la imagen debe tener ancho y alto mayores que 0.');
  let k = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
  if (k > 1 - 1e-9) k = 1;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), clamped: k < 1 };
}

/**
 * Tamaño final de una exportación: el de la vista actual por un multiplicador (1x, 2x, 4x) o un tamaño a medida.
 * Con solo ancho (o solo alto) a medida se conserva la proporción de la vista.
 */
export function exportSize(base: { w: number; h: number }, o: { mult?: number; custom?: { w?: number; h?: number } } = {}): { w: number; h: number; clamped: boolean } {
  const c = o.custom;
  if (c && (c.w || c.h)) {
    const w = c.w ? c.w : (c.h! * base.w) / base.h;
    const h = c.h ? c.h : (c.w! * base.h) / base.w;
    return clampSize(w, h);
  }
  const m = o.mult ?? 1;
  if (!(m > 0)) throw new Error('El multiplicador de resolución debe ser mayor que 0.');
  return clampSize(base.w * m, base.h * m);
}

// ---------------------------------------------------------------- vistas estándar del 3D

export type StdView = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'persp';
/** `dir` va del objetivo hacia la cámara (x derecha, y arriba, z hacia el frente del mueble). `ortho`: proyección ortográfica por omisión. */
export const STD_VIEWS: Record<StdView, { label: string; dir: [number, number, number]; ortho: boolean }> = {
  iso: { label: 'Isométrica', dir: [1, 1, 1], ortho: true },
  front: { label: 'Frente', dir: [0, 0, 1], ortho: true },
  back: { label: 'Atrás', dir: [0, 0, -1], ortho: true },
  left: { label: 'Izquierda', dir: [-1, 0, 0], ortho: true },
  right: { label: 'Derecha', dir: [1, 0, 0], ortho: true },
  top: { label: 'Superior', dir: [0, 1, 0.0001], ortho: true },
  persp: { label: 'Perspectiva', dir: [0.7, 0.5, 1], ortho: false },
};
export const isStdView = (v: string): v is StdView => v in STD_VIEWS;

// ---------------------------------------------------------------- formas vectoriales

/** Dibujo vectorial neutro. Medidas del modelo en mm, y hacia abajo. `sw` (grosor) y `dash` van SIEMPRE en mm de papel; `size` del texto sigue la escala. */
export type Shape =
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; stroke: string; sw: number; dash?: [number, number] }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; fillOpacity?: number; stroke?: string; sw?: number; dash?: [number, number] }
  | { t: 'poly'; pts: [number, number][]; closed?: boolean; fill?: string; stroke?: string; sw?: number; dash?: [number, number] }
  /** Relleno de varios contornos con la regla par-impar (sombreados con islas), sin trazo. */
  | { t: 'fill'; polys: [number, number][][]; fill: string }
  | { t: 'text'; x: number; y: number; size: number; s: string; anchor?: 'start' | 'middle' | 'end'; color: string; /** grados, sentido horario en pantalla */ rot?: number };

export interface Rect { x: number; y: number; w: number; h: number }

const fx = (n: number): string => { const s = n.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' || s === '' ? '0' : s; };
const escXml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function hexRgb(c: string): [number, number, number] {
  let h = c.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}
/** Color mezclado con blanco (el papel) según la opacidad. */
const mixWhite = (c: string, a: number): [number, number, number] => hexRgb(c).map((v) => v * a + (1 - a)) as [number, number, number];

/** Caja de las formas (el texto se estima con los anchos de Helvetica). null si no hay formas. */
export function shapesBounds(shapes: readonly Shape[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number): void => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const s of shapes) {
    if (s.t === 'line') { add(s.x1, s.y1); add(s.x2, s.y2); }
    else if (s.t === 'rect') { add(s.x, s.y); add(s.x + s.w, s.y + s.h); }
    else if (s.t === 'poly') for (const p of s.pts) add(p[0], p[1]);
    else if (s.t === 'fill') { for (const q of s.polys) for (const p of q) add(p[0], p[1]); }
    else {
      const w = pdfText(s.s).width * s.size, a = s.anchor === 'middle' ? -w / 2 : s.anchor === 'end' ? -w : 0;
      const r = ((s.rot ?? 0) * Math.PI) / 180, c = Math.cos(r), n = Math.sin(r);
      // las cuatro esquinas de la caja del texto (alto = 0,8 del cuerpo), giradas
      for (const [u, v] of [[a, 0], [a + w, 0], [a, -s.size * 0.8], [a + w, -s.size * 0.8]]) add(s.x + u * c - v * n, s.y + u * n + v * c);
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** Escalas normalizadas (papel/modelo) que se usan al ajustar. */
export const STD_SCALES = [1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 25, 1 / 50, 1 / 75, 1 / 100, 1 / 125, 1 / 150, 1 / 200, 1 / 250, 1 / 500, 1 / 1000];

export interface Placed { shapes: Shape[]; scale: number; label: string }

/**
 * Coloca las formas (mm del modelo) dentro de `cell` (mm de papel). `scale`: número (papel/modelo, 0.05 = 1:20), 'fit' = la mayor
 * escala normalizada que cabe, o 'exact' = la mayor que cabe sin redondear. Las formas quedan centradas en la celda.
 */
export function placeShapes(shapes: readonly Shape[], cell: Rect, scale: number | 'fit' | 'exact' = 'fit'): Placed {
  const b = shapesBounds(shapes);
  if (!b) return { shapes: [], scale: 1, label: scaleLabel(1) };
  const bw = Math.max(b.x1 - b.x0, 1e-6), bh = Math.max(b.y1 - b.y0, 1e-6);
  const fit = Math.min(cell.w / bw, cell.h / bh);
  let k: number;
  if (typeof scale === 'number') { if (!(scale > 0)) throw new Error('La escala debe ser mayor que 0 (0.05 = 1:20).'); k = scale; }
  else k = scale === 'exact' ? fit : (STD_SCALES.find((s) => s <= fit * (1 + 1e-9)) ?? fit);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, ox = cell.x + cell.w / 2, oy = cell.y + cell.h / 2;
  const X = (x: number): number => ox + (x - cx) * k, Y = (y: number): number => oy + (y - cy) * k;
  const out = shapes.map((s): Shape => {
    if (s.t === 'line') return { ...s, x1: X(s.x1), y1: Y(s.y1), x2: X(s.x2), y2: Y(s.y2) };
    if (s.t === 'rect') return { ...s, x: X(s.x), y: Y(s.y), w: s.w * k, h: s.h * k };
    if (s.t === 'poly') return { ...s, pts: s.pts.map((p) => [X(p[0]), Y(p[1])] as [number, number]) };
    if (s.t === 'fill') return { ...s, polys: s.polys.map((q) => q.map((p) => [X(p[0]), Y(p[1])] as [number, number])) };
    return { ...s, x: X(s.x), y: Y(s.y), size: s.size * k };
  });
  return { shapes: out, scale: k, label: scaleLabel(k) };
}

const dashAttr = (d?: [number, number]): string => (d ? ` stroke-dasharray="${fx(d[0])} ${fx(d[1])}"` : '');

/** SVG de formas ya colocadas en mm de papel (viewBox 0 0 w h). `px` fija el tamaño en píxeles; `bg` pinta un fondo (null = transparente). */
export function placedToSvg(shapes: readonly Shape[], w: number, h: number, o: { px?: { w: number; h: number }; bg?: string | null } = {}): string {
  const body = shapes.map((s) => {
    if (s.t === 'line') return `<line x1="${fx(s.x1)}" y1="${fx(s.y1)}" x2="${fx(s.x2)}" y2="${fx(s.y2)}" stroke="${s.stroke}" stroke-width="${fx(s.sw)}"${dashAttr(s.dash)} />`;
    if (s.t === 'rect') return `<rect x="${fx(s.x)}" y="${fx(s.y)}" width="${fx(s.w)}" height="${fx(s.h)}" fill="${s.fill ?? 'none'}"${s.fill && s.fillOpacity !== undefined ? ` fill-opacity="${s.fillOpacity}"` : ''} stroke="${s.stroke ?? 'none'}" stroke-width="${fx(s.sw ?? 0.25)}"${dashAttr(s.dash)} />`;
    if (s.t === 'poly') return `<${s.closed ? 'polygon' : 'polyline'} points="${s.pts.map((p) => `${fx(p[0])},${fx(p[1])}`).join(' ')}" fill="${s.fill ?? 'none'}" stroke="${s.stroke ?? 'none'}" stroke-width="${fx(s.sw ?? 0.25)}" stroke-linejoin="round"${dashAttr(s.dash)} />`;
    if (s.t === 'fill') return `<path d="${s.polys.map((q) => `M${q.map((p) => `${fx(p[0])} ${fx(p[1])}`).join('L')}Z`).join('')}" fill="${s.fill}" fill-rule="evenodd" stroke="none" />`;
    const anchor = s.anchor === 'middle' ? 'middle' : s.anchor === 'end' ? 'end' : 'start';
    return `<text transform="translate(${fx(s.x)} ${fx(s.y)})${s.rot ? ` rotate(${fx(s.rot)})` : ''}" font-size="${fx(s.size)}" text-anchor="${anchor}" fill="${s.color}">${escXml(s.s)}</text>`;
  }).join('');
  const size = o.px ? `width="${o.px.w}" height="${o.px.h}"` : `width="${fx(w)}mm" height="${fx(h)}mm"`;
  const bg = o.bg ? `<rect width="${fx(w)}" height="${fx(h)}" fill="${o.bg}" />` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${fx(w)} ${fx(h)}" font-family="Helvetica, Arial, sans-serif" stroke-linecap="round">${bg}${body}</svg>`;
}

const PT = 72 / 25.4;

/** Operadores PDF de formas ya colocadas (mm de papel, y hacia abajo) en una página de alto `pageH` mm. El texto usa la fuente /F1 (Helvetica). */
export function shapesToPdfOps(shapes: readonly Shape[], pageH: number): string[] {
  const X = (x: number): string => fx(x * PT), Y = (y: number): string => fx((pageH - y) * PT);
  const col = (c: [number, number, number], op: 'RG' | 'rg'): string => `${fx(c[0])} ${fx(c[1])} ${fx(c[2])} ${op}`;
  const dash = (d?: [number, number]): string => (d ? `[${fx(d[0] * PT)} ${fx(d[1] * PT)}] 0 d` : '[] 0 d');
  const ops: string[] = ['1 J 1 j']; // extremos y uniones redondos (como el SVG): los puntos de un sombreado son trazos casi nulos
  const paint = (fill: boolean, stroke: boolean, closed: boolean): string => (fill && stroke ? (closed ? 'b' : 'B') : fill ? (closed ? 'f' : 'f') : closed ? 's' : 'S');
  for (const s of shapes) {
    if (s.t === 'line') ops.push(`${col(hexRgb(s.stroke), 'RG')} ${fx(s.sw * PT)} w ${dash(s.dash)} ${X(s.x1)} ${Y(s.y1)} m ${X(s.x2)} ${Y(s.y2)} l S`);
    else if (s.t === 'rect' || s.t === 'poly') {
      const fillC = s.fill ? (s.t === 'rect' && s.fillOpacity !== undefined ? mixWhite(s.fill, s.fillOpacity) : hexRgb(s.fill)) : null;
      const hasStroke = !!s.stroke;
      if (!fillC && !hasStroke) continue;
      let o = '';
      if (fillC) o += `${col(fillC, 'rg')} `;
      if (hasStroke) o += `${col(hexRgb(s.stroke!), 'RG')} ${fx((s.sw ?? 0.25) * PT)} w ${dash(s.dash)} `;
      if (s.t === 'rect') o += `${X(s.x)} ${Y(s.y + s.h)} ${fx(s.w * PT)} ${fx(s.h * PT)} re ${fillC && hasStroke ? 'B' : fillC ? 'f' : 'S'}`;
      else {
        if (s.pts.length < 2) continue;
        o += s.pts.map((p, i) => `${X(p[0])} ${Y(p[1])} ${i ? 'l' : 'm'}`).join(' ') + ` ${paint(!!fillC, hasStroke, !!s.closed)}`;
      }
      ops.push(o);
    } else if (s.t === 'fill') {
      const body = s.polys.filter((q) => q.length > 2).map((q) => q.map((p, i) => `${X(p[0])} ${Y(p[1])} ${i ? 'l' : 'm'}`).join(' ') + ' h').join(' ');
      if (body) ops.push(`${col(hexRgb(s.fill), 'rg')} ${body} f*`);
    } else {
      const { bytes, width } = pdfText(s.s);
      if (!bytes.trim()) continue;
      const w = width * s.size, a = s.anchor === 'middle' ? -w / 2 : s.anchor === 'end' ? -w : 0;
      const r = (-(s.rot ?? 0) * Math.PI) / 180, c = Math.cos(r), n = Math.sin(r);
      ops.push('BT', col(hexRgb(s.color), 'rg'), `/F1 ${fx(s.size * PT)} Tf`, `${fx(c)} ${fx(n)} ${fx(-n)} ${fx(c)} ${fx((s.x + a * c) * PT)} ${fx((pageH - s.y - a * n) * PT)} Tm`, `(${bytes}) Tj`, 'ET');
    }
  }
  return ops;
}

// ---------------------------------------------------------------- PDF con imágenes incrustadas

/**
 * Imagen lista para incrustar. 'DCT' = bytes de un JPEG tal cual (sin dependencias: lo produce canvas.toBlob en el navegador).
 * 'Flate' = datos zlib de muestras de 8 bits (si `predictor` es 15, el IDAT de un PNG tal cual). `alpha` = máscara de 8 bits comprimida con zlib (w·h bytes).
 */
export interface PdfImage { w: number; h: number; colors: 1 | 3; filter: 'DCT' | 'Flate'; data: Uint8Array; predictor?: number; alpha?: Uint8Array }
export interface PdfPageSpec { w: number; h: number; /** operadores de contenido (usan /F1 e /Im0, /Im1… según `images`) */ ops: string[]; images: PdfImage[] }

/** Dimensiones y componentes de un JPEG (marcador SOF). Lanza si no es un JPEG de 1 o 3 componentes. */
export function jpegInfo(b: Uint8Array): { w: number; h: number; colors: 1 | 3 } {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('No es un JPEG (falta la marca FFD8).');
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = (b[i + 5] << 8) | b[i + 6], w = (b[i + 7] << 8) | b[i + 8], n = b[i + 9];
      if (n !== 1 && n !== 3) throw new Error(`JPEG con ${n} componentes: solo se admiten gris y RGB.`);
      return { w, h, colors: n as 1 | 3 };
    }
    i += 2 + len;
  }
  throw new Error('JPEG sin cabecera de imagen (SOF).');
}

/** Imagen PDF a partir de bytes JPEG. */
export const jpegToPdfImage = (bytes: Uint8Array): PdfImage => ({ ...jpegInfo(bytes), filter: 'DCT', data: bytes });

const latin1 = (s: string): Uint8Array => { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff; return b; };

/** Escribe un PDF 1.4 con páginas de contenido vectorial e imágenes. Tamaños de página en mm. */
export function buildPdf(pages: PdfPageSpec[], meta: { title?: string } = {}): Uint8Array {
  if (!pages.length) throw new Error('El PDF necesita al menos una página.');
  const chunks: Uint8Array[] = [];
  let len = 0;
  const push = (c: string | Uint8Array): void => { const b = typeof c === 'string' ? latin1(c) : c; chunks.push(b); len += b.length; };
  const offsets: number[] = [];
  let n = 0; // objetos escritos
  const obj = (id: number, body: string | (() => void)): void => {
    offsets[id] = len;
    push(`${id} 0 obj\n`);
    if (typeof body === 'string') push(body); else body();
    push('\nendobj\n');
    n++;
  };
  const stream = (dict: string, data: Uint8Array): void => { push(`<< ${dict} /Length ${data.length} >>\nstream\n`); push(data); push('\nendstream'); };

  // numeración: 1 catálogo, 2 páginas, 3 fuente, 4 info; luego por página: página, contenido, imágenes (y sus máscaras)
  let next = 5;
  const pageIds: number[] = [];
  const plan = pages.map((p) => {
    const pageId = next++, contentId = next++;
    const imgs = p.images.map((im) => { const id = next++; const mask = im.alpha ? next++ : 0; return { im, id, mask }; });
    pageIds.push(pageId);
    return { p, pageId, contentId, imgs };
  });
  push('%PDF-1.4\n%âãÏÓ\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, `<< /Title (${pdfText(meta.title ?? 'MuebleCAD').bytes}) /Producer (MuebleCAD) /Creator (MuebleCAD) >>`);
  for (const { p, pageId, contentId, imgs } of plan) {
    const xo = imgs.length ? ` /XObject << ${imgs.map((x, i) => `/Im${i} ${x.id} 0 R`).join(' ')} >>` : '';
    obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fx(p.w * PT)} ${fx(p.h * PT)}] /Resources << /Font << /F1 3 0 R >>${xo} >> /Contents ${contentId} 0 R >>`);
    obj(contentId, () => stream('', latin1(p.ops.join('\n'))));
    for (const { im, id, mask } of imgs) {
      const cs = im.colors === 3 ? '/DeviceRGB' : '/DeviceGray';
      const parms = im.filter === 'Flate' && im.predictor ? ` /DecodeParms << /Predictor ${im.predictor} /Colors ${im.colors} /BitsPerComponent 8 /Columns ${im.w} >>` : '';
      obj(id, () => stream(`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /${im.filter === 'DCT' ? 'DCTDecode' : 'FlateDecode'}${parms}${mask ? ` /SMask ${mask} 0 R` : ''}`, im.data));
      if (mask) obj(mask, () => stream(`/Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, im.alpha!));
    }
  }
  const xref = len;
  push(`xref\n0 ${n + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= n; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${n + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---------------------------------------------------------------- cajetín y lámina

export const TB_W = 120, TB_ROW = 6;

/** Filas del cajetín: [etiqueta, valor]. La escala sale de `tb.escala` o de `scaleText` (p. ej. "1:20" o "Según vistas"). */
export function titleBlockRows(tb: TitleBlock, scaleText: string): [string, string][] {
  return [['Título', tb.titulo], ['Autor', tb.autor ?? ''], ['Fecha', `${tb.fecha}   Escala ${tb.escala ?? scaleText}`], ['Hoja', tb.hoja ?? '1/1']];
}

export interface SheetLayout { paper: { w: number; h: number }; margin: number; frame: Rect; /** cajetín (null si no hay) */ tb: Rect | null; area: Rect; cells: Rect[] }

/** Cuadrícula de celdas para `n` vistas (1 a 4): 1 -> 1×1; 2 -> dos columnas (horizontal) o dos filas (vertical); 3 y 4 -> 2×2. */
export function gridFor(n: number, landscape: boolean): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return landscape ? { cols: 2, rows: 1 } : { cols: 1, rows: 2 };
  return { cols: 2, rows: 2 };
}

/** Papel, marco, cajetín y celdas de una lámina. Las celdas dejan 2 mm entre sí. Lanza si pide más de 4 vistas o el papel no existe. */
export function sheetLayout(o: { paper?: string | { w: number; h: number }; orientation?: 'landscape' | 'portrait'; margin?: number; titleBlock?: boolean; count: number }): SheetLayout {
  if (!(o.count >= 1 && o.count <= 4)) throw new Error('Una lámina lleva de 1 a 4 vistas.');
  const margin = o.margin ?? 10;
  let paper: { w: number; h: number };
  const pap = o.paper ?? 'A3';
  if (typeof pap === 'string') {
    const d = PAPER_MM[pap];
    if (!d) throw new Error(`Papel "${pap}" no existe. Usa A4, A3, A2, A1, A0 o { w, h } en mm.`);
    paper = { w: d[0], h: d[1] };
  } else {
    if (!(pap.w > 0 && pap.h > 0)) throw new Error('El papel { w, h } necesita medidas mayores que 0 (mm).');
    paper = { ...pap };
  }
  const ori = o.orientation ?? 'landscape';
  if (ori === 'landscape' && paper.w < paper.h) paper = { w: paper.h, h: paper.w };
  if (ori === 'portrait' && paper.w > paper.h) paper = { w: paper.h, h: paper.w };
  if (!(margin >= 0) || margin * 2 >= Math.min(paper.w, paper.h)) throw new Error('El margen es demasiado grande para el papel.');
  const frame: Rect = { x: margin, y: margin, w: paper.w - 2 * margin, h: paper.h - 2 * margin };
  const tbH = TB_ROW * 4, pad = 2;
  const tb: Rect | null = o.titleBlock ? { x: frame.x + frame.w - Math.min(TB_W, frame.w), y: frame.y + frame.h - tbH, w: Math.min(TB_W, frame.w), h: tbH } : null;
  const reserve = tb ? tbH + pad : 0;
  const area: Rect = { x: frame.x + pad, y: frame.y + pad, w: frame.w - 2 * pad, h: frame.h - 2 * pad - reserve };
  const { cols, rows } = gridFor(o.count, paper.w >= paper.h);
  const gap = 2, cw = (area.w - gap * (cols - 1)) / cols, ch = (area.h - gap * (rows - 1)) / rows;
  const cells: Rect[] = [];
  for (let i = 0; i < o.count; i++) cells.push({ x: area.x + (i % cols) * (cw + gap), y: area.y + Math.floor(i / cols) * (ch + gap), w: cw, h: ch });
  return { paper, margin, frame, tb, area, cells };
}

/** Rectángulo de una imagen `iw × ih` ajustada y centrada en `cell` (sin deformarla). */
export function fitRect(iw: number, ih: number, cell: Rect): Rect {
  const k = Math.min(cell.w / iw, cell.h / ih);
  return { x: cell.x + (cell.w - iw * k) / 2, y: cell.y + (cell.h - ih * k) / 2, w: iw * k, h: ih * k };
}

export type SheetContent = { kind: 'image'; image: PdfImage } | { kind: 'shapes'; shapes: Shape[]; scale?: number | 'fit' | 'exact' };
export interface SheetCell { title: string; content: SheetContent }
export interface SheetOptions {
  paper?: string | { w: number; h: number };
  orientation?: 'landscape' | 'portrait';
  margin?: number;
  title: string;
  titleBlock?: TitleBlock;
  cells: SheetCell[];
  /** Lista de piezas / cortes resumida: va en páginas adicionales con el mismo papel. */
  notes?: { title: string; lines: string[] };
}
export interface SheetResult { pdf: Uint8Array; layout: SheetLayout; /** escala de cada vista ("1:20") o null para las imágenes */ scales: (string | null)[]; pages: number }

const CAPTION_H = 5;

export interface SheetBuild { layout: SheetLayout; scales: (string | null)[]; /** todo lo vectorial, en mm de papel (y hacia abajo) */ shapes: Shape[]; /** imágenes con su rectángulo en mm de papel */ images: { rect: Rect; image: PdfImage }[] }

/** Arma la lámina (marco, cajetín y de 1 a 4 vistas con su título y escala) sin escribir aún ningún formato. */
export function buildSheet(o: SheetOptions): SheetBuild {
  const layout = sheetLayout({ paper: o.paper, orientation: o.orientation, margin: o.margin, titleBlock: !!o.titleBlock, count: o.cells.length });
  const { frame, tb } = layout;
  const shapes: Shape[] = [];
  const images: SheetBuild['images'] = [];
  const scales: (string | null)[] = [];
  o.cells.forEach((c, i) => {
    const cell = layout.cells[i];
    const inner: Rect = { x: cell.x + 2, y: cell.y + CAPTION_H, w: cell.w - 4, h: cell.h - CAPTION_H - 2 };
    let label: string | null = null;
    if (c.content.kind === 'shapes') {
      const placed = placeShapes(c.content.shapes, inner, c.content.scale ?? 'fit');
      label = placed.label;
      shapes.push(...placed.shapes);
    } else images.push({ rect: fitRect(c.content.image.w, c.content.image.h, inner), image: c.content.image });
    scales.push(label);
    shapes.push(
      { t: 'rect', x: cell.x, y: cell.y, w: cell.w, h: cell.h, stroke: '#9ca3af', sw: 0.2 },
      { t: 'text', x: cell.x + 2, y: cell.y + 3.6, size: 3, s: label ? `${c.title}   Esc. ${label}` : c.title, color: '#374151' },
    );
  });
  shapes.push({ t: 'rect', x: frame.x, y: frame.y, w: frame.w, h: frame.h, stroke: '#000000', sw: 0.35 });
  if (tb && o.titleBlock) {
    const uniq = [...new Set(scales.filter((s): s is string => !!s))];
    const rows = titleBlockRows(o.titleBlock, uniq.length === 1 ? uniq[0] : 'según vistas');
    shapes.push({ t: 'rect', x: tb.x, y: tb.y, w: tb.w, h: tb.h, stroke: '#000000', sw: 0.35 });
    rows.forEach(([k, v], i) => {
      const y = tb.y + TB_ROW * i;
      if (i) shapes.push({ t: 'line', x1: tb.x, y1: y, x2: tb.x + tb.w, y2: y, stroke: '#000000', sw: 0.35 });
      shapes.push({ t: 'text', x: tb.x + 1.5, y: y + TB_ROW * 0.68, size: 2.2, s: k, color: '#666666' });
      shapes.push({ t: 'text', x: tb.x + 24, y: y + TB_ROW * 0.68, size: i === 0 ? 3.4 : 2.8, s: v, color: '#000000' });
    });
    shapes.push({ t: 'line', x1: tb.x + 22.5, y1: tb.y, x2: tb.x + 22.5, y2: tb.y + tb.h, stroke: '#000000', sw: 0.35 });
  }
  return { layout, scales, shapes, images };
}

/** Lámina de una página en PDF: vectorial para lo vectorial e imágenes incrustadas (más páginas de lista si hay `notes`). */
export function composeSheet(o: SheetOptions): SheetResult {
  const b = buildSheet(o);
  const { paper } = b.layout;
  const ops = shapesToPdfOps(b.shapes, paper.h);
  b.images.forEach(({ rect: r }, i) => ops.push(`q ${fx(r.w * PT)} 0 0 ${fx(r.h * PT)} ${fx(r.x * PT)} ${fx((paper.h - r.y - r.h) * PT)} cm /Im${i} Do Q`));
  const pages: PdfPageSpec[] = [{ w: paper.w, h: paper.h, ops, images: b.images.map((x) => x.image) }];
  if (o.notes?.lines.length) pages.push(...notesPages(o.notes.title, o.notes.lines, paper, b.layout.margin));
  return { pdf: buildPdf(pages, { title: o.title }), layout: b.layout, scales: b.scales, pages: pages.length };
}

const toBase64 = (u: Uint8Array): string => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };

/** SVG de la lámina (primera página): las imágenes JPEG van incrustadas como data URL; las de tipo Flate no se pueden y se omiten. */
export function sheetSvg(b: SheetBuild, o: { px?: { w: number; h: number }; bg?: string | null } = {}): string {
  const { paper } = b.layout;
  const svg = placedToSvg(b.shapes, paper.w, paper.h, { px: o.px });
  const bg = o.bg ? `<rect width="${fx(paper.w)}" height="${fx(paper.h)}" fill="${o.bg}" />` : '';
  const imgs = b.images.filter((x) => x.image.filter === 'DCT').map(({ rect: r, image }) => `<image x="${fx(r.x)}" y="${fx(r.y)}" width="${fx(r.w)}" height="${fx(r.h)}" href="data:image/jpeg;base64,${toBase64(image.data)}" />`).join('');
  const i = svg.indexOf('>') + 1; // tras la etiqueta <svg ...>: fondo e imágenes al fondo, el vectorial encima
  return svg.slice(0, i) + bg + imgs + svg.slice(i);
}

/** Páginas de texto con una lista (una línea por renglón), con marco y título; se parte en varias páginas si no cabe. */
export function notesPages(title: string, lines: string[], paper: { w: number; h: number }, margin: number): PdfPageSpec[] {
  const lineH = 4.4, top = margin + 14;
  const perPage = Math.max(1, Math.floor((paper.h - margin - top - 4) / lineH));
  const pages: PdfPageSpec[] = [];
  for (let start = 0, pg = 1; start < lines.length || pg === 1; start += perPage, pg++) {
    const sh: Shape[] = [
      { t: 'rect', x: margin, y: margin, w: paper.w - 2 * margin, h: paper.h - 2 * margin, stroke: '#000000', sw: 0.35 },
      { t: 'text', x: margin + 4, y: margin + 9, size: 5, s: `${title}${lines.length > perPage ? ` (${pg}/${Math.ceil(lines.length / perPage)})` : ''}`, color: '#000000' },
    ];
    lines.slice(start, start + perPage).forEach((l, i) => sh.push({ t: 'text', x: margin + 4, y: top + i * lineH, size: 3, s: l, color: '#111827' }));
    pages.push({ w: paper.w, h: paper.h, ops: shapesToPdfOps(sh, paper.h), images: [] });
  }
  return pages;
}

/** PDF de una sola imagen (JPEG) en una página con marco y cajetín opcional: el "guardar vista 3D como PDF". */
export function imagePdf(image: PdfImage, o: { title: string; titleBlock?: TitleBlock; paper?: string | { w: number; h: number }; orientation?: 'landscape' | 'portrait'; caption?: string }): SheetResult {
  const landscape = o.orientation ?? (image.w >= image.h ? 'landscape' : 'portrait');
  return composeSheet({ paper: o.paper, orientation: landscape, title: o.title, titleBlock: o.titleBlock, cells: [{ title: o.caption ?? o.title, content: { kind: 'image', image } }] });
}

/** Líneas de texto de la lista de piezas ("2 × 720 × 560 × 18 mm  Lateral  Melamina"), a partir de filas de cutList. */
export function cutListLines(rows: { qty: number; length: number; width: number; thickness: number; material: string; names: string[] }[], matName: (id: string) => string): string[] {
  const f = (n: number): string => String(Math.round(n * 10) / 10);
  const head = ['Cant.  Largo × Ancho × Espesor (mm)   Material   Piezas'];
  return head.concat(rows.map((r) => {
    const names = [...new Set(r.names)].slice(0, 3).join(', ') + (new Set(r.names).size > 3 ? '…' : '');
    return `${String(r.qty).padStart(3)} ×   ${f(r.length)} × ${f(r.width)} × ${f(r.thickness)}   ${matName(r.material)}   ${names}`;
  }));
}
