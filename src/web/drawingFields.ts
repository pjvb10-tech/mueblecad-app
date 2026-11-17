import { DrawingError, type EntityInput } from '../core/drawing';
import { polyArea, polyLength } from '../core/geom2d';
import { HATCH_PATTERNS } from '../core/types';
import type { Entity, PolyVertex, Pt2 } from '../core/types';
import { cleanMm, fmtMm } from '../core/units';

/**
 * Campos editables de las entidades para la tabla (puro, sin DOM): `entityFields` los describe, `fieldPatch` convierte lo que el usuario
 * escribió en un parche para `updateEntity`, y `parseEntityInput` entiende la línea de comandos para agregar entidades escribiendo coordenadas.
 */

export interface FieldDef {
  /** Ruta del campo: "r", "a.0" (x del punto a), "a.1" (y), "pts", "closed"… */
  key: string;
  label: string;
  kind: 'num' | 'text' | 'select' | 'bool';
  /** Valor para el control (los números van con punto decimal, como pide <input type=number>). */
  value: string | boolean;
  options?: string[];
  title?: string;
}

/** Número como texto para un <input type=number>: sin ruido de coma flotante y con punto decimal. */
export const numText = (n: number): string => String(cleanMm(n));

const pt = (label: string, key: string, p: Pt2): FieldDef[] => [
  { key: `${key}.0`, label: `${label}x`, kind: 'num', value: numText(p[0]) },
  { key: `${key}.1`, label: `${label}y`, kind: 'num', value: numText(p[1]) },
];
const num = (key: string, label: string, v: number, title?: string): FieldDef => ({ key, label, kind: 'num', value: numText(v), title });

/** Contornos de un sombreado: lazos separados por " | ", cada uno como `ptsText`. */
export const loopsText = (loops: PolyVertex[][]): string => loops.map((l) => ptsText(l)).join(' | ');

/** Texto de los vértices de una polilínea: "x,y; x,y,bulge; …". */
export const ptsText = (pts: PolyVertex[]): string => pts.map((v) => `${numText(v.p[0])},${numText(v.p[1])}${v.bulge ? `,${numText(v.bulge)}` : ''}`).join('; ');

export function entityFields(e: Entity): FieldDef[] {
  switch (e.type) {
    case 'line': return [...pt('a', 'a', e.a), ...pt('b', 'b', e.b)];
    case 'circle': return [...pt('c', 'c', e.c), num('r', 'r', e.r, 'Radio (mm)')];
    case 'arc': return [...pt('c', 'c', e.c), num('r', 'r', e.r, 'Radio (mm)'), num('a0', 'a0', e.a0, 'Ángulo inicial (grados, antihorario)'), num('a1', 'a1', e.a1, 'Ángulo final (grados, antihorario)')];
    case 'poly': return [
      { key: 'pts', label: 'puntos', kind: 'text', value: ptsText(e.pts), title: 'Vértices "x,y" separados por ";". Un tercer número es el bulge del tramo que sale de ese vértice (+ antihorario).' },
      { key: 'closed', label: 'cerrada', kind: 'bool', value: !!e.closed },
    ];
    case 'text': return [
      ...pt('p', 'p', e.p), num('h', 'h', e.h, 'Alto de letra (mm)'),
      { key: 's', label: 'texto', kind: 'text', value: e.s },
      num('rot', 'rot', e.rot ?? 0, 'Giro (grados, antihorario)'),
      { key: 'align', label: 'alinear', kind: 'select', value: e.align ?? 'left', options: ['left', 'center', 'right'] },
    ];
    case 'hatch': return [
      { key: 'pattern', label: 'patrón', kind: 'select', value: e.pattern, options: [...HATCH_PATTERNS] },
      num('angle', 'ángulo', e.angle ?? 0, 'Giro del patrón (grados, antihorario)'),
      num('scale', 'separación', e.scale ?? 50, 'Separación entre las líneas del patrón (mm)'),
      { key: 'fillColor', label: 'fondo', kind: 'text', value: e.fillColor === undefined ? '' : String(e.fillColor), title: 'Color de fondo: índice ACI o #rrggbb; vacío = sin fondo' },
      { key: 'loops', label: 'contornos', kind: 'text', value: loopsText(e.loops), title: 'Lazos cerrados separados por " | "; cada uno son vértices "x,y" separados por ";" (x,y,bulge para un arco). Par-impar: un lazo dentro de otro es un hueco.' },
    ];
    case 'insert': return [
      { key: 'block', label: 'bloque', kind: 'text', value: e.block, title: 'Nombre del bloque (debe existir)' },
      ...pt('p', 'p', e.p), num('sx', 'sx', e.sx ?? 1, 'Escala X (negativo = espejo)'), num('sy', 'sy', e.sy ?? 1, 'Escala Y (negativo = espejo)'), num('rot', 'rot', e.rot ?? 0, 'Giro (grados, antihorario)'),
      num('cols', 'cols', e.cols ?? 1, 'Columnas del arreglo'), num('rows', 'filas', e.rows ?? 1, 'Filas del arreglo'), num('dx', 'dx', e.dx ?? 0, 'Separación entre columnas (mm)'), num('dy', 'dy', e.dy ?? 0, 'Separación entre filas (mm)'),
    ];
    case 'dim': {
      const text: FieldDef = { key: 'text', label: 'texto', kind: 'text', value: e.text ?? '', title: 'Vacío = la medida calculada' };
      if (e.kind === 'linear') return [...pt('p1', 'p1', e.p1), ...pt('p2', 'p2', e.p2), ...pt('at', 'at', e.at), num('rot', 'rot', e.rot ?? 0, '0 = horizontal, 90 = vertical'), text];
      if (e.kind === 'aligned') return [...pt('p1', 'p1', e.p1), ...pt('p2', 'p2', e.p2), ...pt('at', 'at', e.at), text];
      return [...pt('c', 'c', e.c), num('r', 'r', e.r), num('ang', 'ang', e.ang ?? 45, 'Dirección de la guía (grados)'), text];
    }
  }
}

/** Resumen de solo lectura de una entidad (medidas derivadas), formateado con fmtMm. */
export function entitySummary(e: Entity): string {
  switch (e.type) {
    case 'line': return `largo ${fmtMm(Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]))}`;
    case 'poly': return `${e.pts.length} vért. · largo ${fmtMm(polyLength(e))}${e.closed ? ` · área ${polyArea(e) < 1e6 ? `${fmtMm(polyArea(e))} mm²` : `${fmtMm(polyArea(e) / 1e6, 0, 3)} m²`}` : ''}`;
    case 'circle': return `Ø ${fmtMm(e.r * 2)}`;
    case 'arc': return `barrido ${fmtMm(((e.a1 - e.a0) % 360 + 360) % 360 || 360)}°`;
    case 'text': return '';
    case 'dim': return `cota ${e.kind}`;
    case 'hatch': return `${e.loops.length} contorno${e.loops.length > 1 ? 's' : ''}${e.source ? ' · asociativo' : ''}`;
    case 'insert': return `bloque ${e.block}${(e.cols ?? 1) * (e.rows ?? 1) > 1 ? ` · ${(e.cols ?? 1) * (e.rows ?? 1)} copias` : ''}`;
  }
}

/** Número escrito por el usuario; acepta coma decimal. */
export function parseNum(raw: string, what = 'El valor'): number {
  const s = String(raw).trim().replace(',', '.');
  const n = s === '' ? NaN : Number(s);
  if (!Number.isFinite(n)) throw new DrawingError(`${what} "${raw}" no es un número.`);
  return n;
}

/** Vértices desde el texto "x,y; x,y,bulge; …" (también se admite separar con saltos de línea). */
export function parsePts(raw: string): PolyVertex[] {
  const parts = raw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
  return parts.map((part, i) => {
    const nums = part.split(/[,\s]+/).filter(Boolean).map((n) => parseNum(n, `Vértice ${i + 1}:`));
    if (nums.length < 2 || nums.length > 3) throw new DrawingError(`Vértice ${i + 1}: escribe "x,y" o "x,y,bulge" (recibí "${part}").`);
    return nums[2] ? { p: [nums[0], nums[1]] as Pt2, bulge: nums[2] } : { p: [nums[0], nums[1]] as Pt2 };
  });
}

/** Parche para `updateEntity` a partir de lo que el usuario escribió en el campo `key`. Lanza DrawingError si no se entiende. */
export function fieldPatch(e: Entity, key: string, raw: string | boolean): Record<string, unknown> {
  if (key === 'closed') return { closed: raw === true || raw === 'true' ? true : undefined };
  if (key === 'pts') return { pts: parsePts(String(raw)) };
  if (key === 'align') return { align: raw === 'left' ? undefined : raw };
  if (key === 'loops') return { loops: String(raw).split('|').map((s) => parsePts(s)), source: undefined };
  if (key === 'pattern' || key === 'block') return { [key]: String(raw).trim() };
  if (key === 'fillColor') { const s = String(raw).trim(); return { fillColor: s === '' ? undefined : /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : parseNum(s, 'El color de fondo') }; }
  if (key === 's') return { s: String(raw) };
  if (key === 'text') return { text: String(raw).trim() === '' ? undefined : String(raw) };
  const m = /^(\w+)\.([01])$/.exec(key);
  if (m) {
    const cur = (e as unknown as Record<string, Pt2>)[m[1]];
    if (!Array.isArray(cur)) throw new DrawingError(`La entidad no tiene el campo "${m[1]}".`);
    const next: Pt2 = [cur[0], cur[1]];
    next[Number(m[2])] = parseNum(String(raw), `${m[1]}${m[2] === '0' ? 'x' : 'y'}`);
    return { [m[1]]: next };
  }
  const v = parseNum(String(raw), key === 'rows' ? 'filas' : key);
  // valores por omisión: se quitan para dejar el JSON limpio
  if (key === 'rot' && v === 0) return { rot: undefined };
  if (key === 'ang' && v === 45) return { ang: undefined };
  if ((key === 'angle' || key === 'dx' || key === 'dy') && v === 0) return { [key]: undefined };
  if ((key === 'sx' || key === 'sy' || key === 'cols' || key === 'rows') && v === 1) return { [key]: undefined };
  return { [key]: v };
}

// ---------------------------------------------------------------- línea de comandos para agregar entidades

const COMMANDS: Record<string, 'line' | 'rect' | 'circle' | 'arc' | 'poly' | 'text' | 'dim'> = {
  line: 'line', l: 'line', linea: 'line', línea: 'line',
  rect: 'rect', rectang: 'rect', rectangulo: 'rect', rectángulo: 'rect', r: 'rect',
  circle: 'circle', c: 'circle', circulo: 'circle', círculo: 'circle',
  arc: 'arc', a: 'arc', arco: 'arc',
  poly: 'poly', pl: 'poly', pline: 'poly', polilinea: 'poly', polilínea: 'poly',
  text: 'text', t: 'text', texto: 'text',
  dim: 'dim', cota: 'dim',
};

export const ENTITY_SYNTAX = [
  'line 0,0 100,0',
  'rect 0,0 400,300  (dos esquinas)',
  'circle 50,50 20  (centro y radio; d40 = diámetro)',
  'arc 0,0 100 0 90  (centro, radio, ángulo inicial y final)  |  arc p1 p2 p3',
  'poly 0,0 100,0 100,50 c  (c = cerrada; x,y,bulge para un arco)',
  'text 10,10 50 Hola  (punto, alto y texto)',
  'dim linear 0,0 4000,0 0,-300  |  dim aligned p1 p2 at  |  dim radius 50,50 20',
  'Un punto puede ser relativo al anterior: @dx,dy o @distancia<ángulo (ej. line 0,0 @100,0)',
].join('\n');

/** Punto "x,y", "@dx,dy" o "@d<ang" (relativo al punto anterior); admite "x,y,b" (bulge, solo en poly). */
function parsePoint(tok: string, prev: Pt2 | null, what: string): { p: Pt2; bulge?: number } {
  let t = tok, rel = false;
  if (t.startsWith('@')) { rel = true; t = t.slice(1); }
  if (rel && !prev) throw new DrawingError(`${what}: "${tok}" es relativo pero no hay un punto anterior.`);
  const base: Pt2 = rel ? prev! : [0, 0];
  if (t.includes('<')) {
    const [d, a] = t.split('<');
    const r = parseNum(d, what), ang = (parseNum(a, what) * Math.PI) / 180;
    return { p: [base[0] + r * Math.cos(ang), base[1] + r * Math.sin(ang)] };
  }
  const nums = t.split(',').map((n) => parseNum(n, what));
  if (nums.length < 2 || nums.length > 3) throw new DrawingError(`${what}: escribe el punto como x,y (recibí "${tok}").`);
  const p: Pt2 = [base[0] + nums[0], base[1] + nums[1]];
  return nums[2] ? { p, bulge: nums[2] } : { p };
}
const isPointTok = (t: string): boolean => /^@?-?[\d.]+(,-?[\d.]+){1,2}$|^@?-?[\d.]+<-?[\d.]+$/.test(t);

/**
 * Interpreta una línea como "line 0,0 100,0" y devuelve la entrada para `addEntity` (sin capa: la pone quien llama).
 * Los números llevan punto decimal; un punto es "x,y". Lanza DrawingError con la sintaxis correcta si no se entiende.
 */
export function parseEntityInput(line: string): EntityInput {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) throw new DrawingError('Escribe una entidad, por ejemplo: line 0,0 100,0');
  const cmd = COMMANDS[toks[0].toLowerCase()];
  if (!cmd) throw new DrawingError(`"${toks[0]}" no es un tipo de entidad. Usa line, rect, circle, arc, poly, text o dim. Ejemplos:\n${ENTITY_SYNTAX}`);
  const args = toks.slice(1);
  const need = (n: number, usage: string) => { if (args.length < n) throw new DrawingError(`${toks[0]}: faltan datos. Uso: ${usage}`); };
  // lee puntos encadenando los relativos
  const points = (list: string[], what: string): { p: Pt2; bulge?: number }[] => {
    const out: { p: Pt2; bulge?: number }[] = [];
    list.forEach((t, i) => out.push(parsePoint(t, out.length ? out[out.length - 1].p : null, `${what} ${i + 1}`)));
    return out;
  };
  switch (cmd) {
    case 'line': {
      need(2, 'line x,y x,y');
      const [a, b] = points(args.slice(0, 2), 'Punto');
      return { type: 'line', a: a.p, b: b.p };
    }
    case 'rect': {
      need(2, 'rect x,y x,y   (o rect x,y @ancho,alto)');
      const [a, b] = points(args.slice(0, 2), 'Esquina');
      return { type: 'rect', p1: a.p, p2: b.p };
    }
    case 'circle': {
      need(2, 'circle x,y radio   (o circle x,y d40 para el diámetro)');
      if (args.length >= 3 && args.slice(0, 3).every(isPointTok)) { const [a, b, c] = points(args.slice(0, 3), 'Punto'); return { type: 'circle', pts: [a.p, b.p, c.p] }; }
      const c = parsePoint(args[0], null, 'Centro').p;
      if (/^d/i.test(args[1])) return { type: 'circle', c, d: parseNum(args[1].slice(1), 'El diámetro') };
      return { type: 'circle', c, r: parseNum(args[1], 'El radio') };
    }
    case 'arc': {
      if (args.length >= 3 && args.slice(0, 3).every(isPointTok)) { const [a, b, c] = points(args.slice(0, 3), 'Punto'); return { type: 'arc', pts: [a.p, b.p, c.p] }; }
      need(4, 'arc cx,cy radio a0 a1   (ángulos en grados, antihorario)   |   arc p1 p2 p3');
      return { type: 'arc', c: parsePoint(args[0], null, 'Centro').p, r: parseNum(args[1], 'El radio'), a0: parseNum(args[2], 'El ángulo inicial'), a1: parseNum(args[3], 'El ángulo final') };
    }
    case 'poly': {
      const closed = /^(c|cerrar|close|closed)$/i.test(args[args.length - 1] ?? '');
      const list = closed ? args.slice(0, -1) : args;
      if (list.length < 2) throw new DrawingError('poly: da al menos 2 puntos. Uso: poly x,y x,y x,y [c]');
      return { type: 'poly', pts: points(list, 'Punto').map((v) => (v.bulge ? { p: v.p, bulge: v.bulge } : { p: v.p })), ...(closed ? { closed: true } : {}) };
    }
    case 'text': {
      need(3, 'text x,y alto texto…');
      return { type: 'text', p: parsePoint(args[0], null, 'Punto').p, h: parseNum(args[1], 'El alto'), s: args.slice(2).join(' ') };
    }
    case 'dim': {
      const kind = (args[0] ?? '').toLowerCase();
      if (kind === 'linear' || kind === 'aligned') {
        need(4, `dim ${kind} p1 p2 at`);
        const [p1, p2, at] = points(args.slice(1, 4), 'Punto');
        return { type: 'dim', kind, p1: p1.p, p2: p2.p, at: at.p };
      }
      if (kind === 'radius' || kind === 'diameter') {
        need(3, `dim ${kind} x,y radio`);
        return { type: 'dim', kind, c: parsePoint(args[1], null, 'Centro').p, r: parseNum(args[2], 'El radio') };
      }
      throw new DrawingError('dim: el tipo debe ser linear, aligned, radius o diameter. Uso: dim linear p1 p2 at');
    }
  }
}
