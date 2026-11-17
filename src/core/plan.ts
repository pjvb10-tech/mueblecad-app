import DxfParser from 'dxf-parser';
import type { FloorPlan, PlanPanel, RoomOpening } from './types';
import { detectRooms, runsOf } from './ids';

export type Unit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export const UNIT_MM: Record<Unit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

/** Dibujo leído del DXF, todavía en las unidades y ejes del CAD (y hacia arriba). Segmento = [x1, y1, x2, y2, índice de capa]. */
export interface RawPlan {
  layers: string[];
  segs: number[][];
  /** Textos y cotas: posición CAD, contenido, alto de letra e índice de capa. */
  texts: { x: number; y: number; t: string; h: number; layer: number }[];
  /** Paneles de muro (bloques «panel - …PROTEC-MP/MI…»): MP perimetral, MI interior; caja en coordenadas del CAD. */
  blocks: { kind: 'MP' | 'MI'; x0: number; y0: number; x1: number; y1: number; /** Nombre del bloque y cuántas LINE trae: los paneles normales traen 12; los ventanales perimetrales, 6. */ name: string; lines: number;
    /** Caja del sombreado (HATCH) del panel, ya en coordenadas del CAD: en estos planos todo panel con sombreado es una abertura (puerta o ventana). */ hatch?: { x0: number; y0: number; x1: number; y1: number } }[];
  unit: Unit;
  /** false si el archivo no declara unidades y se adivinaron por el tamaño. */
  unitKnown: boolean;
}

interface Pt { x: number; y: number; bulge?: number }
interface Ent {
  type: string; layer?: string; vertices?: Pt[]; shape?: boolean; closed?: boolean;
  center?: Pt; radius?: number; startAngle?: number; endAngle?: number;
  name?: string; position?: Pt; xScale?: number; yScale?: number; rotation?: number;
  text?: string; height?: number; startPoint?: Pt; textHeight?: number; middleOfText?: Pt; actualMeasurement?: number;
}

/** Quita los códigos de formato de MTEXT (\P, {\fArial;...}, \S...;) y deja el texto plano. */
function plainText(s: string): string {
  return s
    .replace(/\\P/g, ' ')
    .replace(/\\[ACFHQTWfcpo][^;]*;/g, '')
    .replace(/\\S([^;^]*)[;^]([^;]*);/g, '$1/$2')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
interface Block { entities?: Ent[]; position?: Pt }

const INSUNITS: Record<number, Unit> = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const MAX_SEGS = 300000;

/**
 * Caja de los sombreados (HATCH) de cada bloque, en coordenadas del bloque. dxf-parser no entrega los HATCH, así que se
 * recorre el texto: dentro de cada BLOCK se toman los vértices (10/20) y extremos (11/21) de sus trayectorias de borde.
 */
function hatchBoxes(text: string): Map<string, { x0: number; y0: number; x1: number; y1: number }> {
  const L = text.split(/\r?\n/);
  const out = new Map<string, { x0: number; y0: number; x1: number; y1: number }>();
  let inBlocks = false, block = '';
  for (let i = 0; i + 1 < L.length; i += 2) {
    const c = L[i].trim(), v = L[i + 1].trim();
    if (c === '0' && v === 'SECTION') { const n = L[i + 3]?.trim(); inBlocks = n === 'BLOCKS'; continue; }
    if (!inBlocks) continue;
    if (c === '0' && v === 'BLOCK') { let j = i + 2; while (j + 1 < L.length && L[j].trim() !== '2' && L[j].trim() !== '0') j += 2; block = L[j].trim() === '2' ? L[j + 1].trim() : ''; continue; }
    if (c === '0' && v === 'ENDBLK') { block = ''; continue; }
    if (c === '0' && v === 'HATCH' && block) {
      let j = i + 2, seen91 = false, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (; j + 1 < L.length; j += 2) {
        const cc = L[j].trim();
        if (cc === '0') break;
        if (cc === '91') seen91 = true;
        else if (cc === '75') break; // estilo del sombreado: terminan las trayectorias
        else if (seen91 && (cc === '10' || cc === '11')) {
          const x = Number(L[j + 1]), y = Number(L[j + 3]);
          if (Number.isFinite(x) && Number.isFinite(y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
      }
      if (x1 > x0 || y1 > y0) {
        const o = out.get(block);
        out.set(block, o ? { x0: Math.min(o.x0, x0), y0: Math.min(o.y0, y0), x1: Math.max(o.x1, x1), y1: Math.max(o.y1, y1) } : { x0, y0, x1, y1 });
      }
    }
  }
  return out;
}

/** Lee un DXF de AutoCAD y devuelve sus líneas, polilíneas, arcos, círculos y bloques como segmentos. */
export function parsePlan(text: string): RawPlan {
  if (/^AC10\d\d/.test(text.slice(0, 8))) throw new Error('Ese archivo es un .dwg. En AutoCAD usa «Guardar como» y elige DXF (o ábrelo en LibreCAD / DWG TrueView y guárdalo como DXF).');
  const dxf = new DxfParser().parseSync(text) as unknown as { entities?: Ent[]; blocks?: Record<string, Block>; header?: Record<string, unknown> } | null;
  if (!dxf) throw new Error('No pude leer el archivo DXF.');
  const layers: string[] = [];
  const layerIdx = (name?: string) => {
    const n = name || '0';
    let i = layers.indexOf(n);
    if (i < 0) { layers.push(n); i = layers.length - 1; }
    return i;
  };
  const segs: number[][] = [];
  const blocks: RawPlan['blocks'] = [];
  const hatches = hatchBoxes(text);
  const texts: RawPlan['texts'] = [];
  const MAX_TEXTS = 20000;
  const add = (a: Pt, b: Pt, layer: number) => {
    if (segs.length < MAX_SEGS && (a.x !== b.x || a.y !== b.y)) segs.push([a.x, a.y, b.x, b.y, layer]);
  };

  const arc = (c: Pt, r: number, a0: number, sweep: number): Pt[] => {
    const n = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 24)));
    return Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + r * Math.cos(a0 + (sweep * i) / n), y: c.y + r * Math.sin(a0 + (sweep * i) / n) }));
  };
  /** Tramo de polilínea con «bulge» (arco entre dos vértices). */
  const bulgeArc = (p: Pt, q: Pt, b: number): Pt[] => {
    const dx = q.x - p.x, dy = q.y - p.y, c = Math.hypot(dx, dy);
    if (!b || c === 0) return [p, q];
    const off = (c * (1 - b * b)) / (4 * b);
    const ctr = { x: (p.x + q.x) / 2 - (dy / c) * off, y: (p.y + q.y) / 2 + (dx / c) * off };
    return arc(ctr, Math.hypot(p.x - ctr.x, p.y - ctr.y), Math.atan2(p.y - ctr.y, p.x - ctr.x), 4 * Math.atan(b));
  };

  const walk = (ents: Ent[], tf: (p: Pt) => Pt, depth: number) => {
    for (const e of ents) {
      const layer = layerIdx(e.layer);
      const line = (pts: Pt[]) => { for (let i = 1; i < pts.length; i++) add(tf(pts[i - 1]), tf(pts[i]), layer); };
      const label = (at: Pt | undefined, raw: string | undefined, h: number | undefined) => {
        const t = plainText(raw ?? '');
        if (!at || !t || texts.length >= MAX_TEXTS) return;
        const o = tf({ x: 0, y: 0 }), u = tf({ x: 1, y: 0 });
        const p = tf(at);
        texts.push({ x: p.x, y: p.y, t, h: (h || 0) * (Math.hypot(u.x - o.x, u.y - o.y) || 1), layer });
      };
      if (e.type === 'MTEXT') label(e.position, e.text, e.height);
      else if (e.type === 'TEXT') label(e.startPoint, e.text, e.textHeight);
      else if (e.type === 'DIMENSION') {
        const shown = e.text && e.text !== '<>' ? e.text : e.actualMeasurement ? String(Math.round(e.actualMeasurement)) : '';
        label(e.middleOfText, shown, undefined);
      }
      if (e.type === 'LINE' && e.vertices?.length === 2) line(e.vertices);
      else if ((e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') && e.vertices && e.vertices.length > 1) {
        const v = e.vertices, closed = !!(e.shape ?? e.closed);
        const n = closed ? v.length : v.length - 1;
        for (let i = 0; i < n; i++) line(bulgeArc(v[i], v[(i + 1) % v.length], v[i].bulge ?? 0));
      } else if (e.type === 'ARC' && e.center && e.radius) {
        const a0 = e.startAngle ?? 0;
        let a1 = e.endAngle ?? 0;
        while (a1 <= a0) a1 += Math.PI * 2;
        line(arc(e.center, e.radius, a0, a1 - a0));
      } else if (e.type === 'CIRCLE' && e.center && e.radius) line(arc(e.center, e.radius, 0, Math.PI * 2));
      else if (e.type === 'INSERT' && e.name && depth < 4) {
        const block = dxf.blocks?.[e.name];
        if (!block?.entities && !hatches.has(e.name)) continue;
        const entities = block?.entities ?? [];
        const sx = e.xScale ?? 1, sy = e.yScale ?? 1, rot = ((e.rotation ?? 0) * Math.PI) / 180;
        const cos = Math.cos(rot), sin = Math.sin(rot), base = block?.position ?? { x: 0, y: 0 }, pos = e.position ?? { x: 0, y: 0 };
        const n0 = segs.length;
        const place = (p: Pt) => {
          const x = (p.x - base.x) * sx, y = (p.y - base.y) * sy;
          return tf({ x: pos.x + x * cos - y * sin, y: pos.y + x * sin + y * cos });
        };
        walk(entities, place, depth + 1);
        const m = /^panel - .*PROTEC-(MP|MI)-/.exec(e.name);
        const hb = hatches.get(e.name);
        if (m && depth === 0 && (segs.length > n0 || hb)) {
          let hatch: RawPlan['blocks'][number]['hatch'];
          if (hb) {
            const cs = [place({ x: hb.x0, y: hb.y0 }), place({ x: hb.x1, y: hb.y0 }), place({ x: hb.x1, y: hb.y1 }), place({ x: hb.x0, y: hb.y1 })];
            hatch = { x0: Math.min(...cs.map((q) => q.x)), x1: Math.max(...cs.map((q) => q.x)), y0: Math.min(...cs.map((q) => q.y)), y1: Math.max(...cs.map((q) => q.y)) };
          }
          // la caja del panel sale de sus líneas; un panel que solo trae sombreado (sin líneas) usa la caja del sombreado
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (let i = n0; i < segs.length; i++) { const s = segs[i]; x0 = Math.min(x0, s[0], s[2]); x1 = Math.max(x1, s[0], s[2]); y0 = Math.min(y0, s[1], s[3]); y1 = Math.max(y1, s[1], s[3]); }
          if (segs.length === n0 && hatch) ({ x0, x1, y0, y1 } = hatch);
          blocks.push({ kind: m[1] as 'MP' | 'MI', x0, y0, x1, y1, name: e.name, lines: entities.filter((q) => q.type === 'LINE').length, ...(hatch && { hatch }) });
        }
      }
    }
  };
  walk(dxf.entities ?? [], (p) => p, 0);
  if (!segs.length) throw new Error('El DXF no tiene líneas ni polilíneas que dibujar.');

  const code = Number(dxf.header?.$INSUNITS ?? 0);
  let unit = INSUNITS[code];
  const known = !!unit;
  if (!unit) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of segs) {
      x0 = Math.min(x0, s[0], s[2]); x1 = Math.max(x1, s[0], s[2]);
      y0 = Math.min(y0, s[1], s[3]); y1 = Math.max(y1, s[1], s[3]);
    }
    const ext = Math.max(x1 - x0, y1 - y0);
    unit = ext <= 60 ? 'm' : ext <= 1500 ? 'cm' : 'mm';
  }
  return { layers, segs, blocks, texts, unit, unitKnown: known };
}

/** Resultado de leer las elevaciones de muros (paneles) y el plano de techo, en coordenadas del CAD. */
export interface PanelInfo {
  /** Huecos con la línea del muro en la planta (unidades del CAD), antepecho y alto en mm. */
  openings: { x1: number; y1: number; x2: number; y2: number; y: number; h: number; kind: 'door' | 'window'; tag?: string }[];
  /** Altura de los paneles de muro en mm. */
  height: number;
  /** Segmentos del plano de techo ya movidos sobre la planta (unidades del CAD) y sus textos. */
  roof?: { segs: number[][]; texts: RawPlan['texts'] };
  panels: number;
  /** Caja de la planta de la casa (unidades del CAD). */
  house: { x0: number; y0: number; x1: number; y1: number };
  /** Dibujo de cada elevación, para mostrarla. */
  elev: PlanPanel[];
}

/**
 * Lee un dibujo de paneles de muro: cada elevación (zona de ~2,4 m de alto) marca sus puertas y ventanas con un
 * rectángulo cruzado por una X; las etiquetas B## de la elevación aparecen también en la planta, lo que ubica el
 * panel sobre su muro. El plano de techo es la otra lámina grande con etiquetas H##/T##.
 */
export function detectPanels(raw: RawPlan, unit: Unit): PanelInfo | null {
  const k = UNIT_MM[unit];
  type Seg = { s: number[]; x0: number; x1: number; y0: number; y1: number };
  const ss: Seg[] = raw.segs.map((s) => ({ s, x0: Math.min(s[0], s[2]) * k, x1: Math.max(s[0], s[2]) * k, y0: Math.min(s[1], s[3]) * k, y1: Math.max(s[1], s[3]) * k })).sort((a, b) => a.x0 - b.x0);
  type Cl = { x0: number; x1: number; y0: number; y1: number; segs: Seg[] };
  const cl: Cl[] = [];
  for (const s of ss) {
    const g = cl[cl.length - 1];
    if (g && s.x0 <= g.x1 + 600) { g.x1 = Math.max(g.x1, s.x1); g.y0 = Math.min(g.y0, s.y0); g.y1 = Math.max(g.y1, s.y1); g.segs.push(s); }
    else cl.push({ x0: s.x0, x1: s.x1, y0: s.y0, y1: s.y1, segs: [s] });
  }
  const inside = (c: Cl, t: { x: number; y: number }, m: number) => t.x * k >= c.x0 - m && t.x * k <= c.x1 + m && t.y * k >= c.y0 - m && t.y * k <= c.y1 + m;
  const tagOf = (re: RegExp, c: Cl, m: number) => raw.texts.filter((t) => re.test(t.t.trim()) && inside(c, t, m));
  const big = cl.filter((c) => c.x1 - c.x0 >= 8000 && c.y1 - c.y0 >= 5000);
  const pick = (re: RegExp) => {
    let best: Cl | null = null, n = 2;
    for (const c of big) { const m = tagOf(re, c, 0).length; if (m > n) { best = c; n = m; } }
    return best;
  };
  const floor = pick(/^B\d+$/);
  if (!floor) return null;
  const roofC = pick(/^[HT]\d+$/);
  const planTag = new Map<string, { x: number; y: number }>();
  for (const t of tagOf(/^B\d+$/, floor, 0)) planTag.set(t.t.trim(), { x: t.x * k, y: t.y * k });

  const med = (a: number[]) => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
  const openings: PanelInfo['openings'] = [];
  const heights: number[] = [];
  let panels = 0;
  const elev: PlanPanel[] = [];
  const rr = (n: number) => Math.round(n * 10) / 10;
  // tramos de muro reales (bloques de panel de la planta), para alinear las elevaciones
  const runs = runsOf(raw.blocks.filter((b) => b.x0 * k >= floor.x0 && b.x1 * k <= floor.x1 && b.y0 * k >= floor.y0 && b.y1 * k <= floor.y1).map((b) => ({ kind: b.kind, x0: b.x0 * k, z0: b.y0 * k, x1: b.x1 * k, z1: b.y1 * k })));
  // tramos de muro y también la suma de tramos seguidos sobre la misma línea (un muro con un paso abierto en medio)
  const spans: { horiz: boolean; lo: number; hi: number; cross: number }[] = [];
  {
    const byLine = new Map<string, typeof runs>();
    for (const r of runs) {
      const key = `${r.horiz}${Math.round((r.horiz ? (r.z0 + r.z1) / 2 : (r.x0 + r.x1) / 2) / 30)}`;
      (byLine.get(key) ?? byLine.set(key, []).get(key)!).push(r);
    }
    for (const rs of byLine.values()) {
      const lo = (r: (typeof runs)[number]) => (r.horiz ? r.x0 : r.z0), hi = (r: (typeof runs)[number]) => (r.horiz ? r.x1 : r.z1);
      rs.sort((a, b) => lo(a) - lo(b));
      for (let i = 0; i < rs.length; i++) for (let j = i; j < rs.length; j++) spans.push({ horiz: rs[i].horiz, lo: lo(rs[i]), hi: hi(rs[j]), cross: rs[i].horiz ? (rs[i].z0 + rs[i].z1) / 2 : (rs[i].x0 + rs[i].x1) / 2 });
    }
  }
  const perim = runs.filter((r) => r.kind === 'MP');
  const axis = floor.segs.filter((q) => Math.min(q.x1 - q.x0, q.y1 - q.y0) <= 0.5 && Math.max(q.x1 - q.x0, q.y1 - q.y0) >= 300);
  for (const c of cl) {
    if (c === floor || c === roofC || c.segs.length > 600) continue;
    const w0 = c.x1 - c.x0, h0 = c.y1 - c.y0;
    const std = h0 >= 2380 && h0 <= 2520 && w0 >= 300;
    // los muros dibujados girados 90° son láminas de 2,4 m de ancho y el largo del muro hacia arriba
    const rot = !std && w0 >= 2380 && w0 <= 2700 && h0 >= 300;
    if (!std && !rot) continue;
    // rectángulos cruzados por una X: dos diagonales con la misma caja
    const diag = c.segs.filter((q) => q.x1 - q.x0 > 100 && q.y1 - q.y0 > 100);
    const up = (q: Seg) => (q.s[2] - q.s[0]) * (q.s[3] - q.s[1]) > 0;
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (let i = 0; i < diag.length; i++) {
      for (let j = i + 1; j < diag.length; j++) {
        const a = diag[i], b = diag[j];
        if (up(a) === up(b)) continue;
        // una X: dos diagonales de pendiente opuesta cuyas cajas casi coinciden (alguna diagonal puede pasarse unos mm); la abertura es la intersección
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox <= 0 || oy <= 0 || ox < 0.85 * Math.min(a.x1 - a.x0, b.x1 - b.x0) || oy < 0.85 * Math.min(a.y1 - a.y0, b.y1 - b.y0)) continue;
        const nb = { x0: Math.max(a.x0, b.x0), x1: Math.min(a.x1, b.x1), y0: Math.max(a.y0, b.y0), y1: Math.min(a.y1, b.y1) };
        if (!boxes.some((q) => Math.abs(q.x0 - nb.x0) < 3 && Math.abs(q.x1 - nb.x1) < 3 && Math.abs(q.y0 - nb.y0) < 3 && Math.abs(q.y1 - nb.y1) < 3)) boxes.push(nb);
      }
    }
    // giro: el piso del muro es el lado donde las puertas llegan al borde de la lámina
    let mode: 'std' | 'ccw' | 'cw' = 'std';
    if (rot) {
      const atX1 = boxes.filter((b) => b.x1 - b.x0 > 1500 && Math.abs(b.x1 - c.x1) < 30).length, atX0 = boxes.filter((b) => b.x1 - b.x0 > 1500 && Math.abs(b.x0 - c.x0) < 30).length;
      mode = atX0 > atX1 ? 'cw' : 'ccw';
    }
    const H = rot ? 2440 : h0;
    const loc0 = (x: number, y: number): [number, number] => (mode === 'std' ? [x - c.x0, y - c.y0] : mode === 'ccw' ? [y - c.y0, c.x1 - x] : [c.y1 - y, x - c.x0]);
    if (std) { panels++; heights.push(h0); } else panels++;
    const tags = tagOf(/^B\d+$/, c, 50);
    const drawn: { a: number; b: number; l: number[] }[] = [];
    for (const q of c.segs) {
      const a = loc0(q.s[0] * k, q.s[1] * k), b = loc0(q.s[2] * k, q.s[3] * k);
      if (rot && (Math.min(a[1], b[1]) < -5 || Math.max(a[1], b[1]) > H + 5)) continue;
      drawn.push({ a: Math.min(a[0], b[0]), b: Math.max(a[0], b[0]), l: [a[0], a[1], b[0], b[1]] });
    }
    // largo útil del panel: un recuadro suelto menor de 150 mm, separado más de 250 mm del resto, no es parte del muro
    const merged: number[][] = [];
    for (const s of [...drawn].sort((p, q) => p.a - q.a)) {
      const last = merged[merged.length - 1];
      if (last && s.a <= last[1] + 250) last[1] = Math.max(last[1], s.b); else merged.push([s.a, s.b]);
    }
    const kept = merged.length > 1 && merged.some((m) => m[1] - m[0] >= 150) ? merged.filter((m) => m[1] - m[0] >= 150) : merged;
    const uLo = Math.min(...kept.map((m) => m[0])), uHi = Math.max(...kept.map((m) => m[1]));
    const W = uHi - uLo;
    const loc = (x: number, y: number): [number, number] => { const p = loc0(x, y); return [p[0] - uLo, p[1]]; };
    const lines = drawn.filter((s) => s.b >= uLo - 1 && s.a <= uHi + 1).map((s) => [rr(s.l[0] - uLo), rr(s.l[1]), rr(s.l[2] - uLo), rr(s.l[3])]);
    const ep: PlanPanel = {
      w: Math.round(W), h: Math.round(H), tags: tags.map((t) => t.t.trim()), lines,
      texts: raw.texts.filter((t) => inside(c, t, 50)).map((t) => { const p = loc(t.x * k, t.y * k); return { x: rr(p[0]), y: rr(p[1]), t: t.t, h: rr(t.h * k) }; }),
      openings: [],
    };
    elev.push(ep);
    const lb = boxes.map((b) => { const p = loc(b.x0, b.y0), q = loc(b.x1, b.y1); return { u0: Math.min(p[0], q[0]), u1: Math.max(p[0], q[0]), v0: Math.min(p[1], q[1]), v1: Math.max(p[1], q[1]) }; });
    for (const b of lb) ep.openings.push({ x0: Math.round(b.u0), x1: Math.round(b.u1), y: Math.round(b.v0), h: Math.round(b.v1 - b.v0), kind: b.v0 <= 50 ? 'door' : 'window' });
    // etiquetas del panel que también están en la planta → línea del muro
    const pairs = tags.map((t) => ({ ex: loc(t.x * k, t.y * k)[0], p: planTag.get(t.t.trim()) })).filter((q) => q.p) as { ex: number; p: { x: number; y: number } }[];
    if (!pairs.length) continue;
    const range = (a: number[]) => Math.max(...a) - Math.min(...a);
    let sign = 1;
    const alongOf = (horiz: boolean, q: { p: { x: number; y: number } }) => (horiz ? q.p.x : q.p.y);
    const offOf = (horiz: boolean) => med(pairs.map((q) => alongOf(horiz, q) - sign * q.ex));
    let horiz = true;
    if (pairs.length >= 2) {
      horiz = range(pairs.map((q) => q.p.x)) >= range(pairs.map((q) => q.p.y));
      const me = pairs.reduce((t, q) => t + q.ex, 0) / pairs.length, mp = pairs.reduce((t, q) => t + alongOf(horiz, q), 0) / pairs.length;
      sign = pairs.reduce((t, q) => t + (q.ex - me) * (alongOf(horiz, q) - mp), 0) >= 0 ? 1 : -1;
    }
    // la línea del muro: la cara de muro del plano más cercana a las etiquetas que cubra el tramo del panel
    const snap = (hz: boolean) => {
      const o = offOf(hz), lo = Math.min(o, o + sign * W), hi = Math.max(o, o + sign * W), at = med(pairs.map((q) => (hz ? q.p.y : q.p.x)));
      let best: number | null = null, bd = 450;
      for (const q of axis) {
        if ((q.y1 - q.y0 <= 0.5) !== hz) continue;
        const cc = hz ? q.y0 : q.x0, a0 = hz ? q.x0 : q.y0, a1 = hz ? q.x1 : q.y1;
        const ov = Math.min(a1, hi) - Math.max(a0, lo);
        if (ov < 0.3 * (hi - lo) && ov < 0.8 * (a1 - a0)) continue;
        if (Math.abs(cc - at) < bd) { bd = Math.abs(cc - at); best = cc; }
      }
      return best;
    };
    let across = med(pairs.map((q) => (horiz ? q.p.y : q.p.x)));
    if (pairs.length < 2 && snap(true) === null && snap(false) !== null) horiz = false;
    const sn = snap(horiz);
    if (sn !== null) across = sn;
    let off = offOf(horiz);
    // los largos de los tramos de muro de la planta coinciden con los de las elevaciones: el panel se alinea al tramo
    let best: (typeof spans)[number] | null = null, bd = 600;
    for (const r of spans) {
      if (r.horiz !== horiz || Math.abs(r.hi - r.lo - W) > 15) continue;
      const d = Math.abs((r.lo + r.hi) / 2 - (off + (sign * W) / 2));
      if (Math.abs(r.cross - across) <= 450 && d < bd) { bd = d; best = r; }
    }
    if (best) {
      off = sign > 0 ? best.lo : best.hi;
      across = best.cross;
    } else {
      // algunas hojas incluyen el espesor del muro perimetral contra el que remata el muro: el panel sobrepasa el tramo por ese lado
      let ov: { r: (typeof spans)[number]; lo: number } | null = null, od = 600;
      for (const r of spans) {
        const t = W - (r.hi - r.lo);
        if (r.horiz !== horiz || t < 60 || t > 160 || Math.abs(r.cross - across) > 450) continue;
        const inMP = (a: number) => perim.some((m) => (horiz ? a >= m.x0 - 5 && a <= m.x1 + 5 && r.cross >= m.z0 - 5 && r.cross <= m.z1 + 5 : a >= m.z0 - 5 && a <= m.z1 + 5 && r.cross >= m.x0 - 5 && r.cross <= m.x1 + 5));
        const atHi = inMP(r.hi + t / 2), atLo = inMP(r.lo - t / 2);
        if (atHi === atLo) continue;
        const lo = atHi ? r.lo : r.lo - t;
        const d = Math.abs(lo + W / 2 - (off + (sign * W) / 2));
        if (d < od) { od = d; ov = { r, lo }; }
      }
      if (ov) {
        off = sign > 0 ? ov.lo : ov.lo + W;
        across = ov.r.cross;
      }
    }
    ep.at = { x1: horiz ? off / k : across / k, y1: horiz ? across / k : off / k, x2: horiz ? (off + sign * W) / k : across / k, y2: horiz ? across / k : (off + sign * W) / k };
    for (const b of lb) {
      const u0 = off + sign * b.u0, u1 = off + sign * b.u1, sill = b.v0, hh = b.v1 - b.v0;
      const tag = tags.find((t) => { const u = loc(t.x * k, t.y * k)[0]; return u >= b.u0 - 10 && u <= b.u1 + 10; })?.t.trim();
      const [p0, p1] = [Math.min(u0, u1) / k, Math.max(u0, u1) / k];
      const cc = across / k;
      openings.push({ x1: horiz ? p0 : cc, y1: horiz ? cc : p0, x2: horiz ? p1 : cc, y2: horiz ? cc : p1, y: Math.round(sill), h: Math.round(hh), kind: sill <= 50 ? 'door' : 'window', ...(tag && { tag }) });
    }
  }
  if (!panels && !raw.blocks.length) return null;
  const out: PanelInfo = { openings, height: Math.round(med(heights) / 10) * 10 || 2440, panels, elev, house: { x0: floor.x0 / k, y0: floor.y0 / k, x1: floor.x1 / k, y1: floor.y1 / k } };
  if (roofC && Math.abs(roofC.x1 - roofC.x0 - (floor.x1 - floor.x0)) < 0.05 * (floor.x1 - floor.x0)) {
    const dx = (floor.x0 - roofC.x0) / k;
    out.roof = {
      segs: roofC.segs.map((q) => [q.s[0] + dx, q.s[1], q.s[2] + dx, q.s[3], q.s[4]]),
      texts: raw.texts.filter((t) => inside(roofC, t, 0)).map((t) => ({ ...t, x: t.x + dx })),
    };
  }
  return out;
}

/** Pasa el dibujo a mm sobre el piso (origen en la esquina superior izquierda de la vista de planta) usando solo las capas elegidas. */
export function toFloorPlan(raw: RawPlan, unit: Unit, layers: string[], name: string): FloorPlan {
  const on = new Set(layers.map((l) => raw.layers.indexOf(l)));
  const segs = raw.segs.filter((s) => on.has(s[4]));
  if (!segs.length) return { name, lines: [] };
  let minX = Infinity, maxY = -Infinity;
  for (const s of segs) {
    minX = Math.min(minX, s[0], s[2]);
    maxY = Math.max(maxY, s[1], s[3]);
  }
  const k = UNIT_MM[unit];
  const r = (n: number) => Math.round(n * 10) / 10;
  const lines = segs
    .map((s) => [r((s[0] - minX) * k), r((maxY - s[1]) * k), r((s[2] - minX) * k), r((maxY - s[3]) * k)])
    .filter((l) => Math.hypot(l[2] - l[0], l[3] - l[1]) >= 1);
  const texts = raw.texts
    .filter((t) => on.has(t.layer))
    .map((t) => ({ x: r((t.x - minX) * k), z: r((maxY - t.y) * k), t: t.t, h: r(t.h * k) }));
  const plan: FloorPlan = texts.length ? { name, lines, texts } : { name, lines };
  const info = detectPanels(raw, unit);
  if (info) {
    const px = (x: number) => r((x - minX) * k), pz = (y: number) => r((maxY - y) * k);
    const openings: NonNullable<FloorPlan['openings']> = info.openings.map((o) => ({ x1: px(o.x1), z1: pz(o.y1), x2: px(o.x2), z2: pz(o.y2), y: o.y, h: o.h, kind: o.kind, ...(o.tag && { tag: o.tag }) }));
    plan.panelH = info.height;
    const inHouse = raw.blocks.filter((b) => b.x0 >= info.house.x0 && b.x1 <= info.house.x1 && b.y0 >= info.house.y0 && b.y1 <= info.house.y1);
    // un panel que solo trae sombreado (sin líneas) usa la caja del sombreado; si ya hay una caja con líneas debajo, es la misma pieza y no se duplica
    const overlap = (a: (typeof inHouse)[number], q: (typeof inHouse)[number]) => Math.max(0, Math.min(a.x1, q.x1) - Math.max(a.x0, q.x0)) * Math.max(0, Math.min(a.y1, q.y1) - Math.max(a.y0, q.y0));
    plan.walls = inHouse
      .filter((b) => b.lines > 0 || !inHouse.some((q) => q !== b && q.lines > 0 && overlap(b, q) > 0.6 * (b.x1 - b.x0) * (b.y1 - b.y0)))
      .map((b) => ({ kind: b.kind, x0: px(b.x0), z0: pz(b.y1), x1: px(b.x1), z1: pz(b.y0) }));
    // aberturas perimetrales: en este plano todo panel perimetral con sombreado (HATCH) es una abertura. Las piezas seguidas se juntan en una.
    // Por la estructura del bloque: 4 líneas = puerta, 6 u 8 líneas y 1,7 m o más = ventanal, solo sombreado (sin líneas) = por confirmar.
    // Alto 2000 y antepecho 0 son supuestos (no están en el plano).
    {
      type Cand = { horiz: boolean; a0: number; a1: number; c: number; lines: number[]; name: string };
      const gap = 43 / k; // un panel solo con sombreado: la abertura es el sombreado menos la holgura de cada lado
      const cands: Cand[] = [];
      for (const b of inHouse) {
        if (b.kind !== 'MP' || !b.hatch) continue;
        const box = b.lines > 0 ? b : b.hatch;
        const horiz = box.x1 - box.x0 >= box.y1 - box.y0;
        const s = b.lines > 0 ? 0 : gap;
        if (((horiz ? box.x1 - box.x0 : box.y1 - box.y0) - 2 * s) * k < 300) continue; // un fragmento de sombreado demasiado pequeño no sirve para ubicar la abertura
        cands.push({ horiz, a0: (horiz ? box.x0 : box.y0) + s, a1: (horiz ? box.x1 : box.y1) - s, c: horiz ? (box.y0 + box.y1) / 2 : (box.x0 + box.x1) / 2, lines: [b.lines], name: b.name });
      }
      // la línea del muro se compara redondeada a 10 mm: diferencias de coma flotante no deben desordenar las piezas
      const lineKey = (c: Cand) => Math.round((c.c * k) / 10);
      cands.sort((p, q) => Number(q.horiz) - Number(p.horiz) || lineKey(p) - lineKey(q) || p.a0 - q.a0);
      const groups: Cand[] = [];
      for (const c of cands) {
        const g = groups[groups.length - 1];
        if (g && g.horiz === c.horiz && Math.abs(g.c - c.c) * k < 30 && Math.abs((c.a0 - g.a1) * k) <= 10) { g.a0 = Math.min(g.a0, c.a0); g.a1 = Math.max(g.a1, c.a1); g.lines.push(...c.lines); } else groups.push({ ...c, lines: [...c.lines] });
      }
      for (const g of groups) {
        const len = (g.a1 - g.a0) * k;
        const tag = /PROTEC-MP-\d+-([^-]+)-/.exec(g.name)?.[1];
        const kind: 'door' | 'window' = len >= 1700 ? 'window' : g.lines.every((n) => n === 4) ? 'door' : 'window';
        const unknown = len < 1700 && !g.lines.every((n) => n === 4);
        const base = { y: 0, h: 2000, kind, fromBlock: true, ...(unknown && { unknown: true }), ...(tag && { tag }) };
        openings.push(g.horiz
          ? { x1: px(g.a0), z1: pz(g.c), x2: px(g.a1), z2: pz(g.c), ...base }
          : { x1: px(g.c), z1: pz(g.a1), x2: px(g.c), z2: pz(g.a0), ...base });
      }
    }
    if (openings.length) plan.openings = openings;
    plan.house = { x0: px(info.house.x0), z0: pz(info.house.y1), x1: px(info.house.x1), z1: pz(info.house.y0) };
    plan.panels = info.elev.map((e) => (e.at ? { ...e, at: { x1: px(e.at.x1), y1: pz(e.at.y1), x2: px(e.at.x2), y2: pz(e.at.y2) } } : e));
    if (info.roof) {
      const rl = info.roof.segs.filter((s) => on.has(s[4])).map((s) => [px(s[0]), pz(s[1]), px(s[2]), pz(s[3])]).filter((l) => Math.hypot(l[2] - l[0], l[3] - l[1]) >= 1);
      const rt = info.roof.texts.filter((t) => on.has(t.layer)).map((t) => ({ x: px(t.x), z: pz(t.y), t: t.t, h: r(t.h * k) }));
      if (rl.length) plan.roof = rt.length ? { lines: rl, texts: rt } : { lines: rl };
    }
  }
  if (plan.walls?.length) { const rooms = detectRooms(plan); if (rooms.length) plan.rooms = rooms; }
  return plan;
}

/** Aplica una transformación de puntos a todo el plano: líneas, textos, huecos y techo. `len` escala longitudes (alto de letra, antepecho, alto de hueco). */
function mapPlan(p: FloorPlan, pt: (x: number, z: number) => [number, number], len = 1): FloorPlan {
  const r = (n: number) => Math.round(n * 10) / 10;
  const ln = (l: number[]) => { const a = pt(l[0], l[1]), b = pt(l[2], l[3]); return [r(a[0]), r(a[1]), r(b[0]), r(b[1])]; };
  const tx = <T extends { x: number; z: number; h: number }>(t: T): T => { const a = pt(t.x, t.z); return { ...t, x: r(a[0]), z: r(a[1]), h: r(t.h * len) }; };
  const out: FloorPlan = { ...p, lines: p.lines.map(ln) };
  if (p.texts) out.texts = p.texts.map(tx);
  if (p.openings) out.openings = p.openings.map((o) => { const a = pt(o.x1, o.z1), b = pt(o.x2, o.z2); return { ...o, x1: r(a[0]), z1: r(a[1]), x2: r(b[0]), z2: r(b[1]), y: Math.round(o.y * len), h: Math.round(o.h * len) }; });
  if (p.roof) out.roof = { lines: p.roof.lines.map(ln), ...(p.roof.texts && { texts: p.roof.texts.map(tx) }) };
  if (p.panelH) out.panelH = Math.round(p.panelH * len);
  if (p.walls) out.walls = p.walls.map((w) => { const a = pt(w.x0, w.z0), b = pt(w.x1, w.z1); return { kind: w.kind, x0: r(Math.min(a[0], b[0])), z0: r(Math.min(a[1], b[1])), x1: r(Math.max(a[0], b[0])), z1: r(Math.max(a[1], b[1])) }; });
  if (p.rooms) out.rooms = p.rooms.map((m) => { const a = pt(m.x0, m.z0), b = pt(m.x1, m.z1), c = pt(m.cx, m.cz); return { ...m, x0: r(Math.min(a[0], b[0])), z0: r(Math.min(a[1], b[1])), x1: r(Math.max(a[0], b[0])), z1: r(Math.max(a[1], b[1])), cx: r(c[0]), cz: r(c[1]) }; });
  if (p.house) { const a = pt(p.house.x0, p.house.z0), b = pt(p.house.x1, p.house.z1); out.house = { x0: r(Math.min(a[0], b[0])), z0: r(Math.min(a[1], b[1])), x1: r(Math.max(a[0], b[0])), z1: r(Math.max(a[1], b[1])) }; }
  if (p.panels) out.panels = p.panels.map((e) => { if (!e.at) return e; const a = pt(e.at.x1, e.at.y1), b = pt(e.at.x2, e.at.y2); return { ...e, at: { x1: r(a[0]), y1: r(a[1]), x2: r(b[0]), y2: r(b[1]) } }; });
  return out;
}

export function planBounds(p: FloorPlan) {
  if (!p.lines.length) return null;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const l of p.lines) {
    minX = Math.min(minX, l[0], l[2]); maxX = Math.max(maxX, l[0], l[2]);
    minZ = Math.min(minZ, l[1], l[3]); maxZ = Math.max(maxZ, l[1], l[3]);
  }
  return { minX, minZ, maxX, maxZ };
}

/** Gira el plano 90° (horario visto desde arriba) para elegir cuál muro queda como «fondo». */
export function rotatePlan(p: FloorPlan): FloorPlan {
  const b = planBounds(p);
  if (!b) return p;
  return mapPlan(p, (x, z) => [b.maxZ - z, x - b.minX]);
}

/** Cambia la escala del plano (para calibrarlo con una medida conocida). */
export function scalePlan(p: FloorPlan, f: number): FloorPlan {
  return mapPlan(p, (x, z) => [x * f, z * f], f);
}

/** Mueve el origen a la esquina superior izquierda del rectángulo marcado (que pasa a ser el espacio). */
export function cropPlan(p: FloorPlan, rect: { x: number; z: number }): FloorPlan {
  return mapPlan(p, (x, z) => [x - rect.x, z - rect.z]);
}

/** Segmentos casi verticales u horizontales del plano con largo suficiente para ser parte de un muro. */
function axisSegments(p: FloorPlan) {
  const v: { c: number; a: number; b: number }[] = [], h: { c: number; a: number; b: number }[] = [];
  for (const l of p.lines) {
    if (Math.abs(l[0] - l[2]) <= 0.5 && Math.abs(l[1] - l[3]) >= 150) v.push({ c: (l[0] + l[2]) / 2, a: Math.min(l[1], l[3]), b: Math.max(l[1], l[3]) });
    else if (Math.abs(l[1] - l[3]) <= 0.5 && Math.abs(l[0] - l[2]) >= 150) h.push({ c: (l[1] + l[3]) / 2, a: Math.min(l[0], l[2]), b: Math.max(l[0], l[2]) });
  }
  return { v, h };
}

/**
 * Encuentra la habitación que contiene el recuadro marcado: lanza rayos desde el interior del recuadro y toma,
 * en cada dirección, la cara de muro que más veces aparece primero (así las puertas y los muebles dibujados no
 * la desvían). Devuelve las caras interiores y el espesor del muro, o null si la habitación está abierta.
 */
export function detectRoom(p: FloorPlan, rect: { x0: number; z0: number; x1: number; z1: number }) {
  const { v, h } = axisSegments(p);
  const N = 7;
  const hits: Map<number, number>[] = [new Map(), new Map(), new Map(), new Map()]; // izq, der, arriba, abajo
  const mark = (i: number, val: number) => { const k = Math.round(val / 10) * 10; hits[i].set(k, (hits[i].get(k) ?? 0) + 1); };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const x = rect.x0 + (rect.x1 - rect.x0) * (0.25 + (0.5 * i) / (N - 1));
      const z = rect.z0 + (rect.z1 - rect.z0) * (0.25 + (0.5 * j) / (N - 1));
      let l = -Infinity, r = Infinity, u = -Infinity, d = Infinity;
      for (const s of v) if (s.a <= z && z <= s.b) { if (s.c < x) l = Math.max(l, s.c); else r = Math.min(r, s.c); }
      for (const s of h) if (s.a <= x && x <= s.b) { if (s.c < z) u = Math.max(u, s.c); else d = Math.min(d, s.c); }
      if (isFinite(l)) mark(0, l);
      if (isFinite(r)) mark(1, r);
      if (isFinite(u)) mark(2, u);
      if (isFinite(d)) mark(3, d);
    }
  }
  const pick = (m: Map<number, number>) => {
    let best: [number, number] | null = null;
    for (const e of m) if (!best || e[1] > best[1]) best = e;
    return best && best[1] >= (N * N) / 3 ? best[0] : null;
  };
  const [x0, x1, z0, z1] = [pick(hits[0]), pick(hits[1]), pick(hits[2]), pick(hits[3])];
  if (x0 === null || x1 === null || z0 === null || z1 === null || x1 - x0 < 500 || z1 - z0 < 500) return null;
  // espesor: línea paralela más cercana hacia afuera de cada cara que cubra buena parte del lado
  const gaps: number[] = [];
  const outward = (segs: typeof v, face: number, dir: 1 | -1, lo: number, hi: number) => {
    let best = Infinity;
    for (const s of segs) {
      const gap = (s.c - face) * dir;
      const overlap = Math.min(s.b, hi) - Math.max(s.a, lo);
      if (gap >= 60 && gap <= 450 && overlap >= 0.4 * (hi - lo)) best = Math.min(best, gap);
    }
    if (isFinite(best)) gaps.push(best);
  };
  outward(v, x0, -1, z0, z1); outward(v, x1, 1, z0, z1); outward(h, z0, -1, x0, x1); outward(h, z1, 1, x0, x1);
  gaps.sort((a, b) => a - b);
  const wall = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : 100;
  return { x0, z0, x1, z1, wall };
}

/**
 * Reparte los huecos del plano en los muros del espacio (el plano ya recortado: la esquina interior del
 * espacio es 0,0 y mide W × D con muros de espesor T). Un hueco pertenece a un muro si su línea cae sobre
 * la cara interior o dentro del espesor del muro, con un margen mayor hacia afuera porque las etiquetas B## quedan junto al muro y no sobre él.
 */
export function assignOpenings(p: FloorPlan, W: number, D: number, T: number): RoomOpening[] {
  const inn = 150, outer = 400, out: RoomOpening[] = [];
  const r = (n: number) => Math.round(n);
  for (const o of p.openings ?? []) {
    const horiz = Math.abs(o.z1 - o.z2) < 1;
    const c = horiz ? o.z1 : o.x1;
    const lo = Math.min(horiz ? o.x1 : o.z1, horiz ? o.x2 : o.z2), hi = Math.max(horiz ? o.x1 : o.z1, horiz ? o.x2 : o.z2);
    const len = horiz ? W : D, cross = horiz ? D : W;
    const wall: RoomOpening['wall'] | null = c >= -T - outer && c <= inn ? (horiz ? 'back' : 'left') : c >= cross - inn && c <= cross + T + outer ? (horiz ? 'front' : 'right') : null;
    if (!wall) continue;
    const a = Math.max(lo, 0), b = Math.min(hi, len);
    if (b - a < 0.6 * (hi - lo) || b - a < 200) continue;
    out.push({ wall, a: r(a), b: r(b), y: o.y, h: o.h, kind: o.kind, ...(o.tag && { tag: o.tag }) });
  }
  return out;
}
