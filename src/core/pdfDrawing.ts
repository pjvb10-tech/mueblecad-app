import { aciToHex, isHexColor } from './aci';
import { flattenEntities } from './blocks';
import { hatchGeometry } from './hatch';
import { bulgeArc, dimGeometry, entitiesBounds, mergeBounds, norm360, sweepFromBulge, sweepOf, textCorners, type Bounds } from './geom2d';
import type { Drawing, DrawingColor, Entity, Layer, Pt2 } from './types';

/**
 * PDF vectorial de un dibujo 2D, escrito a mano (PDF 1.4, sin dependencias): trazos con grosor, color y trama por capa, arcos como curvas
 * Bézier y texto en Helvetica estándar (WinAnsi). Sin DOM ni servidor. Contrato: docs/dibujo-2d.md, "Importar y exportar".
 */

export const PAPER_MM: Record<string, [number, number]> = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420], A4: [210, 297] };

export interface TitleBlock { titulo: string; autor?: string; fecha: string; /** Si falta, se usa la escala real ("1:50"). */ escala?: string; hoja?: string }

export interface PdfOptions {
  /** Papel: A4/A3/A2/A1/A0 o { w, h } en mm. Por omisión el de `drawing.sheet` o A3. */
  paper?: 'A4' | 'A3' | 'A2' | 'A1' | 'A0' | { w: number; h: number };
  /** Por omisión 'landscape' para los papeles con nombre; un { w, h } a medida se respeta tal cual si no se indica. */
  orientation?: 'landscape' | 'portrait';
  /** Escala papel/dibujo (0.02 = 1:50) o 'fit' (la mayor escala normalizada que cabe). Por omisión `drawing.sheet.scale` o 'fit'. */
  scale?: number | 'fit';
  /** Con 'fit', ajusta exacto en lugar de redondear a escala normalizada. Por omisión false. */
  exactFit?: boolean;
  /** Margen del papel (mm). Por omisión 10. */
  margin?: number;
  titleBlock?: TitleBlock;
  /** 'layer' (por omisión): color de cada capa; 'mono': todo en negro. El 7 y los casi blancos van negros sobre papel. */
  colors?: 'layer' | 'mono';
  /** Grosor por omisión de las capas sin lineweight (mm). Por omisión 0.25. */
  defaultLineweight?: number;
  /** Alto del texto de las cotas (mm de dibujo); por omisión el de dimGeometry. */
  dimTextH?: number;
  /** Título del documento. Por omisión el nombre del dibujo. */
  title?: string;
}

export interface PdfLayout {
  paper: { w: number; h: number };
  scale: number;
  scaleLabel: string;
  margin: number;
  /** Área libre para el dibujo (mm de papel, origen abajo-izquierda). */
  area: { x: number; y: number; w: number; h: number };
}

const STD_SCALES = [1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 25, 1 / 50, 1 / 75, 1 / 100, 1 / 125, 1 / 150, 1 / 200, 1 / 250, 1 / 500, 1 / 750, 1 / 1000, 1 / 1500, 1 / 2000, 1 / 5000, 1 / 10000];
const TB_W = 120, TB_ROW = 6; // cajetín: ancho (mm) y alto de cada fila

/** "fit", un número (papel/dibujo: 0.02) o "1:50" (también "1/50"). */
export function parseScale(v: string | number | undefined): number | 'fit' | undefined {
  if (v === undefined || v === 'fit') return v as 'fit' | undefined;
  if (typeof v === 'number') return v;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*[:/]\s*(\d+(?:[.,]\d+)?)\s*$/.exec(v);
  if (m) return Number(m[1].replace(',', '.')) / Number(m[2].replace(',', '.'));
  const n = Number(v.replace(',', '.'));
  if (Number.isFinite(n) && n > 0) return n;
  throw new Error(`Escala no válida: "${v}". Usa "fit", "1:50" o un número (0.02 = 1:50).`);
}

export const scaleLabel = (scale: number): string => (scale >= 1 ? `${Number((scale).toFixed(3))}:1` : `1:${Number((1 / scale).toFixed(1))}`);

const visibleLayer = (d: Drawing, name: string): Layer | undefined => d.layers.find((l) => l.name === name);

/** Entidades dibujadas: capas encendidas y no congeladas. */
function drawable(d: Drawing): Entity[] {
  const ok = new Set(d.layers.filter((l) => l.on && !l.frozen).map((l) => l.name));
  return flattenEntities(d, { visibleOnly: true }).filter((e) => ok.has(e.layer)); // los inserts se resuelven a su geometría
}

function boundsOf(list: Entity[], dimTextH?: number): Bounds | null {
  const parts: (Bounds | null)[] = [];
  const plain = list.filter((e) => e.type !== 'dim');
  parts.push(entitiesBounds(plain));
  for (const e of list) {
    if (e.type !== 'dim') continue;
    const g = dimGeometry(e, dimTextH ? { textH: dimTextH } : {});
    const b: Bounds = { min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
    for (const [p, q] of g.lines) for (const r of [p, q]) { b.min = [Math.min(b.min[0], r[0]), Math.min(b.min[1], r[1])]; b.max = [Math.max(b.max[0], r[0]), Math.max(b.max[1], r[1])]; }
    for (const t of g.texts) for (const r of textCorners(t)) { b.min = [Math.min(b.min[0], r[0]), Math.min(b.min[1], r[1])]; b.max = [Math.max(b.max[0], r[0]), Math.max(b.max[1], r[1])]; }
    if (Number.isFinite(b.min[0])) parts.push(b);
  }
  return mergeBounds(parts);
}

/** Papel, escala y área libre que usará `drawingToPdf` (para mostrar la escala resultante en la interfaz). */
export function pdfLayout(drawing: Drawing, opts: PdfOptions = {}): PdfLayout {
  const margin = opts.margin ?? 10;
  let paper: { w: number; h: number };
  const pap = opts.paper ?? (drawing.sheet ? { w: drawing.sheet.w, h: drawing.sheet.h } : 'A3');
  if (typeof pap === 'string') {
    const dims = PAPER_MM[pap];
    if (!dims) throw new Error(`Papel "${pap}" no existe. Usa A4, A3, A2, A1, A0 o { w, h } en mm.`);
    paper = { w: dims[0], h: dims[1] };
    if ((opts.orientation ?? 'landscape') === 'landscape') paper = { w: Math.max(paper.w, paper.h), h: Math.min(paper.w, paper.h) };
  } else {
    if (!(pap.w > 0 && pap.h > 0)) throw new Error('El papel { w, h } necesita medidas mayores que 0 (mm).');
    paper = { ...pap };
    if (opts.orientation === 'landscape' && paper.w < paper.h) paper = { w: paper.h, h: paper.w };
    if (opts.orientation === 'portrait' && paper.w > paper.h) paper = { w: paper.h, h: paper.w };
  }
  if (!(margin >= 0) || margin * 2 >= Math.min(paper.w, paper.h)) throw new Error('El margen es demasiado grande para el papel.');
  const tbH = opts.titleBlock ? TB_ROW * 4 : 0;
  const pad = 2; // aire entre dibujo y marco
  const area = { x: margin + pad, y: margin + pad + (opts.titleBlock ? tbH + pad : 0), w: paper.w - 2 * margin - 2 * pad, h: paper.h - 2 * margin - 2 * pad - (opts.titleBlock ? tbH + pad : 0) };
  const b = boundsOf(drawable(drawing), opts.dimTextH);
  const want = opts.scale ?? drawing.sheet?.scale ?? 'fit';
  let scale: number;
  if (typeof want === 'number') {
    if (!(want > 0)) throw new Error('scale debe ser mayor que 0 (0.02 = 1:50) o "fit".');
    scale = want;
  } else if (!b) scale = 0.01;
  else {
    const w = Math.max(b.max[0] - b.min[0], 1e-6), h = Math.max(b.max[1] - b.min[1], 1e-6);
    const fit = Math.min(area.w / w, area.h / h);
    scale = opts.exactFit ? fit : (STD_SCALES.find((s) => s <= fit * (1 + 1e-9)) ?? fit);
  }
  return { paper, scale, scaleLabel: scaleLabel(scale), margin, area };
}

// ---------------------------------------------------------------- texto (Helvetica, WinAnsi)

// Anchos de Helvetica (AFM) para 32..126, en milésimas de em.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

/** Código WinAnsi (cp1252) de un carácter, o null si no existe. */
function winAnsi(ch: string): number | null {
  const c = ch.codePointAt(0)!;
  if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) return c;
  const map: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e,
    0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
  return map[c] ?? null;
}
export function pdfText(s: string): { bytes: string; width: number } {
  let bytes = '', width = 0;
  for (const ch of s.replace(/[\r\n\t]+/g, ' ')) {
    const code = winAnsi(ch) ?? 0x3f;
    const base = code >= 32 && code < 127 ? code : (ch.normalize('NFD')[0]?.codePointAt(0) ?? 63);
    width += base >= 32 && base < 127 ? HELV[base - 32] : 556;
    const c = String.fromCharCode(code);
    bytes += c === '(' || c === ')' || c === '\\' ? `\\${c}` : code < 32 ? ' ' : c;
  }
  return { bytes, width: width / 1000 };
}

const CAP = 0.72; // altura de mayúscula de Helvetica por em: el alto de letra del dibujo es la altura de mayúscula (como en DXF)

// ---------------------------------------------------------------- PDF

const f = (n: number): string => { const s = n.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' || s === '' ? '0' : s; };
const PT = 72 / 25.4;

function paperColor(c: DrawingColor, mono: boolean): [number, number, number] {
  if (mono) return [0, 0, 0];
  const hex = isHexColor(c) ? c.toLowerCase() : aciToHex(c, false);
  const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  if (r > 0.95 && g > 0.95 && b > 0.95) return [0, 0, 0]; // blanco sobre papel claro = negro
  return [r, g, b];
}

/** PDF (1 página) de un dibujo. Devuelve los bytes (cadena latin1 convertida a Uint8Array). */
export function drawingToPdf(drawing: Drawing, opts: PdfOptions = {}): Uint8Array {
  const lay = pdfLayout(drawing, opts);
  const { paper, scale, area } = lay;
  const mono = opts.colors === 'mono';
  const defLw = opts.defaultLineweight ?? 0.25;
  const ents = drawable(drawing);
  const b = boundsOf(ents, opts.dimTextH);
  // el centro del dibujo va al centro del área libre
  const cx = b ? (b.min[0] + b.max[0]) / 2 : 0, cy = b ? (b.min[1] + b.max[1]) / 2 : 0;
  const ox = area.x + area.w / 2 - cx * scale, oy = area.y + area.h / 2 - cy * scale;
  const X = (x: number): number => (ox + x * scale) * PT;
  const Y = (y: number): number => (oy + y * scale) * PT;

  const c: string[] = [];
  let state = '';
  const stroke = (col: [number, number, number], lw: number, lt: Layer['linetype']): void => {
    const key = `${col}|${lw}|${lt}`;
    if (key === state) return;
    state = key;
    const dash = lt === 'dashed' ? `[${f(3 * PT)} ${f(1.5 * PT)}] 0 d` : lt === 'center' ? `[${f(8 * PT)} ${f(1.5 * PT)} ${f(1.5 * PT)} ${f(1.5 * PT)}] 0 d` : '[] 0 d';
    c.push(`${f(col[0])} ${f(col[1])} ${f(col[2])} RG ${f(lw * PT)} w ${dash}`);
  };
  /** Segmento de arco (|barrido| <= 90) como Bézier cúbica; añade solo el "c" (el punto inicial ya está en el trazo). */
  const arcTo = (cc: Pt2, r: number, t0: number, delta: number): void => {
    const nseg = Math.max(1, Math.ceil(Math.abs(delta) / 90 - 1e-9)), d = delta / nseg;
    for (let i = 0; i < nseg; i++) {
      const a0 = ((t0 + d * i) * Math.PI) / 180, a1 = ((t0 + d * (i + 1)) * Math.PI) / 180;
      const k = (4 / 3) * Math.tan((a1 - a0) / 4);
      const p1: Pt2 = [cc[0] + r * (Math.cos(a0) - k * Math.sin(a0)), cc[1] + r * (Math.sin(a0) + k * Math.cos(a0))];
      const p2: Pt2 = [cc[0] + r * (Math.cos(a1) + k * Math.sin(a1)), cc[1] + r * (Math.sin(a1) - k * Math.cos(a1))];
      const p3: Pt2 = [cc[0] + r * Math.cos(a1), cc[1] + r * Math.sin(a1)];
      c.push(`${f(X(p1[0]))} ${f(Y(p1[1]))} ${f(X(p2[0]))} ${f(Y(p2[1]))} ${f(X(p3[0]))} ${f(Y(p3[1]))} c`);
    }
  };
  const move = (p: Pt2): void => { c.push(`${f(X(p[0]))} ${f(Y(p[1]))} m`); };
  const lineTo = (p: Pt2): void => { c.push(`${f(X(p[0]))} ${f(Y(p[1]))} l`); };

  const drawText = (t: { p: Pt2; h: number; s: string; rot?: number; align?: string }, col: [number, number, number]): void => {
    const { bytes, width } = pdfText(t.s);
    if (!bytes.trim()) return;
    const size = (t.h * scale * PT) / CAP;
    const w = width * size;
    const sx = t.align === 'center' ? -w / 2 : t.align === 'right' ? -w : 0;
    const r = ((t.rot ?? 0) * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
    c.push('BT', `${f(col[0])} ${f(col[1])} ${f(col[2])} rg`, `/F1 ${f(size)} Tf`, `${f(cs)} ${f(sn)} ${f(-sn)} ${f(cs)} ${f(X(t.p[0]) + sx * cs)} ${f(Y(t.p[1]) + sx * sn)} Tm`, `(${bytes}) Tj`, 'ET');
    state = ''; // BT/ET no tocan el trazo, pero rg sí el relleno; el trazo se conserva. Se reinicia por prudencia.
  };

  // clip al área libre para que lo que se sale de escala fija no pise el cajetín ni el margen
  c.push('q', `${f(area.x * PT)} ${f(area.y * PT)} ${f(area.w * PT)} ${f(area.h * PT)} re W n`, '1 J 1 j');
  for (const e of ents) {
    const layer = visibleLayer(drawing, e.layer);
    const col = paperColor(e.color ?? layer?.color ?? 7, mono);
    const lw = layer?.lineweight ?? defLw, lt = layer?.linetype ?? 'continuous';
    if (e.type === 'text') { drawText(e, col); continue; }
    stroke(col, lw, lt);
    switch (e.type) {
      case 'line': move(e.a); lineTo(e.b); c.push('S'); break;
      case 'poly': {
        move(e.pts[0].p);
        const n = e.pts.length, last = e.closed ? n : n - 1;
        for (let i = 0; i < last; i++) {
          const a = e.pts[i], bb = e.pts[(i + 1) % n];
          const arc = a.bulge ? bulgeArc(a.p, bb.p, a.bulge) : null;
          if (arc) arcTo(arc.c, arc.r, Math.atan2(a.p[1] - arc.c[1], a.p[0] - arc.c[0]) * 180 / Math.PI, sweepFromBulge(a.bulge!));
          else lineTo(bb.p);
        }
        c.push(e.closed ? 's' : 'S');
        break;
      }
      case 'circle': move([e.c[0] + e.r, e.c[1]]); arcTo(e.c, e.r, 0, 360); c.push('s'); break;
      case 'arc': {
        const sw = sweepOf(e.a0, e.a1), a0 = norm360(e.a0);
        move([e.c[0] + e.r * Math.cos((a0 * Math.PI) / 180), e.c[1] + e.r * Math.sin((a0 * Math.PI) / 180)]);
        arcTo(e.c, e.r, a0, sw);
        c.push('S');
        break;
      }
      case 'dim': {
        const g = dimGeometry(e, opts.dimTextH ? { textH: opts.dimTextH } : {});
        for (const [p, q] of g.lines) { move(p); lineTo(q); c.push('S'); }
        for (const t of g.texts) drawText(t, col);
        break;
      }
      case 'hatch': {
        // relleno (sólido o fondo) con la regla par-impar; luego los trazos del patrón con línea fina; los puntos como trazos casi nulos con extremo redondo
        const fill = e.fillColor !== undefined ? paperColor(e.fillColor, mono) : e.pattern === 'solid' ? col : null;
        if (fill) {
          c.push(`${f(fill[0])} ${f(fill[1])} ${f(fill[2])} rg`);
          for (const l of e.loops) {
            move(l[0].p);
            const n = l.length;
            for (let i = 0; i < n; i++) {
              const a = l[i], bb = l[(i + 1) % n], arc = a.bulge ? bulgeArc(a.p, bb.p, a.bulge) : null;
              if (arc) arcTo(arc.c, arc.r, Math.atan2(a.p[1] - arc.c[1], a.p[0] - arc.c[0]) * 180 / Math.PI, sweepFromBulge(a.bulge!));
              else lineTo(bb.p);
            }
            c.push('h');
          }
          c.push('f*');
        }
        if (e.pattern === 'solid') break;
        const g = hatchGeometry(e);
        if (g.segments.length) { stroke(col, Math.min(lw, 0.18), 'continuous'); for (const [p, q] of g.segments) { move(p); lineTo(q); } c.push('S'); }
        if (g.dots.length) { stroke(col, 0.45, 'continuous'); for (const p of g.dots) { move(p); lineTo([p[0] + 0.02 / scale, p[1]]); } c.push('S'); }
        break;
      }
    }
  }
  c.push('Q');

  // marco y cajetín
  c.push('q', '0 0 0 RG', `${f(0.35 * PT)} w`, '[] 0 d');
  c.push(`${f(lay.margin * PT)} ${f(lay.margin * PT)} ${f((paper.w - 2 * lay.margin) * PT)} ${f((paper.h - 2 * lay.margin) * PT)} re S`);
  const tb = opts.titleBlock;
  if (tb) {
    const x1 = paper.w - lay.margin, y0 = lay.margin, w = Math.min(TB_W, paper.w - 2 * lay.margin), x0 = x1 - w;
    const rows: [string, string][] = [['Título', tb.titulo], ['Autor', tb.autor ?? ''], ['Fecha / Escala', `${tb.fecha}   Escala ${tb.escala ?? lay.scaleLabel}`], ['Hoja', tb.hoja ?? '1/1']];
    const H = TB_ROW * rows.length;
    c.push(`${f(x0 * PT)} ${f(y0 * PT)} ${f(w * PT)} ${f(H * PT)} re S`);
    rows.forEach(([k, v], i) => {
      const yTop = y0 + H - TB_ROW * i;
      if (i) c.push(`${f(x0 * PT)} ${f(yTop * PT)} m ${f(x1 * PT)} ${f(yTop * PT)} l S`);
      const ty = (yTop - TB_ROW * 0.68) * PT;
      const label = pdfText(k.split(' / ')[0]), val = pdfText(i === 2 ? v : v);
      c.push('BT', '0.4 0.4 0.4 rg', `/F1 ${f(2.2 * PT)} Tf`, `1 0 0 1 ${f((x0 + 1.5) * PT)} ${f(ty)} Tm`, `(${label.bytes}) Tj`, 'ET');
      c.push('BT', '0 0 0 rg', `/F1 ${f((i === 0 ? 3.4 : 2.8) * PT)} Tf`, `1 0 0 1 ${f((x0 + 24) * PT)} ${f(ty)} Tm`, `(${val.bytes}) Tj`, 'ET');
    });
    c.push(`${f((x0 + 22.5) * PT)} ${f(y0 * PT)} m ${f((x0 + 22.5) * PT)} ${f((y0 + H) * PT)} l S`);
  }
  c.push('Q');

  const content = c.join('\n');
  const title = pdfText(opts.title ?? drawing.name).bytes;
  const objs: string[] = [];
  const W = (pt: number): string => f(pt * PT);
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W(paper.w)} ${W(paper.h)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`);
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  objs.push(`<< /Title (${title}) /Producer (MuebleCAD) /Creator (MuebleCAD) >>`);

  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}
