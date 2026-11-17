import { addEntity, buildEntity, DrawingError, findLayer, getEntity, offsetEntity, removeEntity, transformEntity, updateEntity } from './drawing';
import type { EntityInput } from './drawing';
import { arcFrom3Points, circleFrom3Points, dist, norm360, polySegments, sweepFromBulge } from './geom2d';
import { pickAt } from './select2d';
import { diffOps, extendEntity, trimEntity } from './trimExtend';
import type { Drawing, DrawingColor, Entity, PolyVertex, Pt2 } from './types';

/**
 * Herramientas de dibujo y edición como MÁQUINAS DE ESTADOS PURAS (sin DOM). La interfaz les pasa eventos ya imantados
 * (onPoint / onMove / onKey / onText / onSelect) y consume `preview()` (entidades fantasma + mensaje de prompt en español) y
 * `commit()` (lista de operaciones add/update/remove, compatibles con drawing.ts, para aplicar de forma atómica con `applyOps`).
 * Contrato y ejemplo de cableado: docs/dibujo-2d.md, "Herramientas de ratón".
 */

// ---------------------------------------------------------------- operaciones

export type DrawOp =
  | { op: 'add'; entity: EntityInput }
  | { op: 'update'; id: string; patch: Record<string, unknown> }
  | { op: 'remove'; ids: string[] };

/**
 * Aplica las operaciones en orden sobre el dibujo (todo o nada: si una falla lanza DrawingError y no se devuelve nada).
 * `ids` son los ids de las entidades agregadas, en orden.
 */
export function applyOps(d: Drawing, ops: DrawOp[]): { drawing: Drawing; ids: string[] } {
  let cur = d;
  const ids: string[] = [];
  for (const o of ops) {
    if (o.op === 'add') { const r = addEntity(cur, o.entity); cur = r.drawing; ids.push(r.id); }
    else if (o.op === 'update') cur = updateEntity(cur, o.id, o.patch);
    else cur = removeEntity(cur, o.ids);
  }
  return { drawing: cur, ids };
}

// ---------------------------------------------------------------- entrada numérica

export type ParsedInput =
  | { type: 'point'; p: Pt2; relative: boolean }
  | { type: 'number'; value: number }
  /** "<45": fija la dirección del próximo número. */
  | { type: 'angle'; value: number }
  | { type: 'error'; message: string };

const NUM_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(mm|cm|m)?$/;
/** Número con unidad opcional (mm por omisión, cm, m) → mm. Null si no es un número. */
export function parseLength(tok: string): number | null {
  const m = NUM_RE.exec(tok.trim().toLowerCase());
  if (!m) return null;
  const v = Number(m[1]) * (m[2] === 'm' ? 1000 : m[2] === 'cm' ? 10 : 1);
  return Number.isFinite(v) ? v : null;
}
const polarOf = (o: Pt2, d: number, deg: number): Pt2 => [o[0] + d * Math.cos((deg * Math.PI) / 180), o[1] + d * Math.sin((deg * Math.PI) / 180)];

/**
 * Parser de la línea de comandos / entrada dinámica:
 *   "x,y" absoluta · "@dx,dy" relativa a `base` · "@d<a" y "d<a" polares (a en grados, antihorario) · "#x,y" absoluta explícita
 *   "d" distancia (número; la herramienta la aplica en la dirección actual) · "<a" fija la dirección. Unidades: mm (por omisión), cm, m.
 */
export function parseInput(raw: string, base?: Pt2 | null): ParsedInput {
  let s = (raw ?? '').trim();
  const err = (message: string): ParsedInput => ({ type: 'error', message });
  if (!s) return err('Escribe una distancia, "x,y", "@dx,dy" o "@distancia<ángulo".');
  let rel = false;
  if (s[0] === '@') { rel = true; s = s.slice(1).trim(); } else if (s[0] === '#') s = s.slice(1).trim();
  if (rel && !base) return err('Las coordenadas relativas (@) necesitan un punto anterior; da el primer punto con "x,y" o con el ratón.');
  const o: Pt2 = rel ? base! : [0, 0];
  if (s.startsWith('<')) { const a = parseLength(s.slice(1)); return a === null ? err(`Ángulo no válido: "${raw}". Ejemplo: <45.`) : { type: 'angle', value: a }; }
  if (s.includes('<')) {
    const [d, a, ...extra] = s.split('<');
    const dv = parseLength(d), av = parseLength(a ?? '');
    if (extra.length || dv === null || av === null) return err(`Entrada polar no válida: "${raw}". Ejemplo: @100<45 (distancia<ángulo en grados).`);
    return { type: 'point', p: polarOf(o, dv, av), relative: rel };
  }
  if (s.includes(',')) {
    const parts = s.split(',');
    const x = parts.length === 2 ? parseLength(parts[0]) : null, y = parts.length === 2 ? parseLength(parts[1]) : null;
    if (x === null || y === null) return err(`Coordenadas no válidas: "${raw}". Ejemplo: 100,50 o @100,50 (usa punto para decimales).`);
    return { type: 'point', p: [o[0] + x, o[1] + y], relative: rel };
  }
  const v = parseLength(s);
  if (v === null) return err(`No entiendo "${raw}". Usa una distancia (500, 2m), "x,y", "@dx,dy" o "@distancia<ángulo".`);
  if (rel) return err('Tras @ usa "dx,dy" o "distancia<ángulo"; para una distancia suelta escribe solo el número.');
  return { type: 'number', value: v };
}

// ---------------------------------------------------------------- utilidades geométricas

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const EPS = 1e-9;
const angleOf = (a: Pt2, b: Pt2): number => Math.atan2(b[1] - a[1], b[0] - a[0]) * DEG;
const wrap180 = (a: number): number => { const r = norm360(a); return r > 180 ? r - 360 : r; };
const same = (a: Pt2, b: Pt2): boolean => dist(a, b) < 1e-9;
const stripId = (e: Entity): EntityInput => { const { id: _id, ...rest } = e as Entity & { id: string }; return JSON.parse(JSON.stringify(rest)) as EntityInput; };

/** Refleja una entidad respecto del eje a→b (no es una transformación de drawing.ts: allí no hay espejos). El texto no se espeja, solo se mueve. */
export function mirrorEntity(e: Entity, a: Pt2, b: Pt2): Entity {
  const L = dist(a, b);
  if (L < EPS) throw new DrawingError('El eje de simetría necesita dos puntos distintos.');
  const dx = (b[0] - a[0]) / L, dy = (b[1] - a[1]) / L, phi = angleOf(a, b);
  const P = (p: Pt2): Pt2 => { const vx = p[0] - a[0], vy = p[1] - a[1], t = vx * dx + vy * dy; return [a[0] + 2 * t * dx - vx, a[1] + 2 * t * dy - vy]; };
  switch (e.type) {
    case 'line': return { ...e, a: P(e.a), b: P(e.b) };
    case 'poly': return { ...e, pts: e.pts.map((v): PolyVertex => (v.bulge ? { p: P(v.p), bulge: -v.bulge } : { p: P(v.p) })) };
    case 'circle': return { ...e, c: P(e.c) };
    case 'arc': return { ...e, c: P(e.c), a0: norm360(2 * phi - e.a1), a1: norm360(2 * phi - e.a0) };
    case 'hatch': return { ...e, loops: e.loops.map((l) => l.map((v): PolyVertex => (v.bulge ? { p: P(v.p), bulge: -v.bulge } : { p: P(v.p) }))), angle: norm360(2 * phi - (e.angle ?? 0)) };
    case 'insert': { const i = { ...e, p: P(e.p), rot: norm360(2 * phi - (e.rot ?? 0)), sy: -(e.sy ?? 1) }; if (!i.rot) delete (i as { rot?: number }).rot; return i; }
    case 'text': return { ...e, p: P(e.p) };
    case 'dim': {
      if (e.kind === 'linear') { const r = (((2 * phi - (e.rot ?? 0)) % 180) + 180) % 180; const t = { ...e, p1: P(e.p1), p2: P(e.p2), at: P(e.at) }; if (r > 1e-9 && r < 180 - 1e-9) t.rot = r; else delete t.rot; return t; }
      if (e.kind === 'aligned') return { ...e, p1: P(e.p1), p2: P(e.p2), at: P(e.at) };
      return { ...e, c: P(e.c), ...(e.ang !== undefined ? { ang: 2 * phi - e.ang } : {}) };
    }
  }
}

/** Parche (solo los campos que cambian) para convertir `a` en `b`; los campos que desaparecen van como undefined. */
function diffPatch(a: Entity, b: Entity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const A = a as unknown as Record<string, unknown>, B = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (k === 'id' || k === 'type') continue;
    if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) out[k] = B[k];
  }
  return out;
}

// ---------------------------------------------------------------- interfaz de herramienta

export interface ToolOptions {
  /** Capa de las entidades nuevas ("0" por omisión). */
  layer?: string;
  /** Color propio de las nuevas; sin él, PorCapa. */
  color?: DrawingColor;
  /** Selección previa (herramientas de edición). Se descartan ids inexistentes y de capas bloqueadas/congeladas. */
  selection?: string[];
  /** Alto de letra del texto (mm). */
  textHeight?: number;
  /** Tolerancia (mm de dibujo) para elegir con onPoint en "desfasar"; si no, la interfaz usa onSelect. */
  pickTolerance?: number;
}

export interface ToolPreview {
  /** Entidades fantasma (ids "ghost1"…) a pintar atenuadas. */
  ghosts: Entity[];
  /** Mensaje de la línea de comandos, en español. Vacío cuando la herramienta terminó. */
  prompt: string;
  /** Ids a resaltar como seleccionados. */
  selection: string[];
  /** Último error de entrada (se limpia con el siguiente evento válido). */
  error: string | null;
  /** Punto base del que parten ortho/polar y la entrada relativa (@). */
  base: Pt2 | null;
}

export interface Tool {
  readonly name: string;
  /** La herramienta terminó (por completar, Enter/Esc o cancel). Tras `commit()` la interfaz la reinicia o crea otra. */
  readonly done: boolean;
  readonly cancelled: boolean;
  readonly error: string | null;
  readonly selection: string[];
  /** `mods`: Shift (invierte recortar↔extender) y `tol` (mm) para elegir objetos con un clic; solo los usa recortar/extender. */
  onPoint(p: Pt2, mods?: { shift?: boolean; tol?: number }): void;
  onMove(p: Pt2): void;
  /** "Enter", "Escape", "Backspace", " " o una letra de opción (c, u, a, l, d, r, s, n…; no distingue mayúsculas). */
  onKey(k: string): void;
  /** Texto escrito: coordenadas, distancia, ángulo o contenido de texto (según el estado). */
  onText(s: string): void;
  /** La interfaz elige entidades (clic, ventana, cruce) y las entrega; solo las herramientas de edición lo usan. */
  onSelect(ids: string[], mode?: 'add' | 'replace' | 'toggle'): void;
  /** Aborta sin dejar nada: commit() devolverá []. */
  cancel(): void;
  preview(): ToolPreview;
  /** Operaciones listas (solo si `done` y no cancelada; una sola vez). */
  commit(): DrawOp[];
  /** Opcional (recortar/extender): entrega y vacía las operaciones pendientes para aplicarlas ya, sin esperar a que la herramienta termine. */
  drain?(): DrawOp[];
  /** Opcional (recortar/extender): la interfaz entrega el dibujo actual (p. ej. tras cambios de un agente) para que la herramienta vea entidades nuevas o cambiadas. */
  sync?(d: Drawing): void;
}

abstract class BaseTool implements Tool {
  abstract readonly name: string;
  protected cursor: Pt2 | null = null;
  protected ops: DrawOp[] = [];
  protected _done = false;
  protected _cancelled = false;
  protected _committed = false;
  protected _error: string | null = null;
  protected angleLock: number | null = null;
  protected sel: string[] = [];
  protected stage = 'start';
  constructor(protected d: Drawing, protected o: ToolOptions = {}) {}

  get done(): boolean { return this._done; }
  get cancelled(): boolean { return this._cancelled; }
  get error(): string | null { return this._error; }
  get selection(): string[] { return [...this.sel]; }
  protected get layer(): string { return this.o.layer ?? '0'; }
  protected fail(msg: string): void { this._error = msg; }
  protected finish(ops: DrawOp[]): void { this.ops = ops; this._done = true; }

  /** Entidad nueva con la capa y el color de la herramienta. */
  protected mk(input: EntityInput): EntityInput { return { ...input, layer: this.layer, ...(this.o.color !== undefined ? { color: this.o.color } : {}) } as EntityInput; }
  protected add(input: EntityInput): DrawOp { return { op: 'add', entity: this.mk(input) }; }

  // eventos
  onMove(p: Pt2): void { this.cursor = p; }
  onPoint(p: Pt2): void { if (this._done) return; this._error = null; this.angleLock = null; this.cursor = p; this.point(p); }
  onText(s: string): void { if (this._done) return; this._error = null; this.text(s); }
  onSelect(ids: string[], mode: 'add' | 'replace' | 'toggle' = 'add'): void { if (this._done) return; this._error = null; this.select(ids, mode); }
  onKey(k: string): void {
    if (this._done) return;
    this._error = null;
    if (k === 'Escape') this.escape();
    else if (k === 'Enter' || k === ' ') this.enter();
    else if (k === 'Backspace') this.undo();
    else if (k.length === 1) { const c = k.toLowerCase(); if (c === 'u') this.undo(); else this.option(c); }
  }
  cancel(): void { this.ops = []; this._cancelled = true; this._done = true; }
  commit(): DrawOp[] {
    if (!this._done || this._cancelled || this._committed) return [];
    this._committed = true;
    return this.ops;
  }

  // a sobrescribir
  protected abstract point(p: Pt2): void;
  protected base(): Pt2 | null { return null; }
  protected enter(): void { this.cancel(); }
  protected escape(): void { this.cancel(); }
  protected option(_k: string): void { /* sin opciones */ }
  protected undo(): void { this.fail('No hay nada que deshacer.'); }
  protected select(_ids: string[], _mode: 'add' | 'replace' | 'toggle'): void { this.fail('Esta herramienta no usa selección.'); }
  protected abstract prompt(): string;
  protected ghostInputs(): EntityInput[] { return []; }
  protected angleInput(a: number): void { this.angleLock = a; }

  protected cursorAngle(from: Pt2): number { return this.cursor && !same(this.cursor, from) ? angleOf(from, this.cursor) : 0; }
  /** Número escrito: por omisión, distancia desde el punto base en la dirección del cursor (o la fijada con "<a"). */
  protected number(v: number): void {
    const b = this.base();
    if (!b) { this.fail('Primero da un punto (x,y o con el ratón); luego podrás escribir distancias.'); return; }
    const ang = this.angleLock ?? this.cursorAngle(b);
    this.angleLock = null;
    this.point(polarOf(b, v, ang));
  }
  protected text(s: string): void {
    const r = parseInput(s, this.base());
    if (r.type === 'error') this.fail(r.message);
    else if (r.type === 'angle') this.angleInput(r.value);
    else if (r.type === 'number') this.number(r.value);
    else { this.angleLock = null; this.cursor = r.p; this.point(r.p); }
  }

  preview(): ToolPreview {
    const ghosts: Entity[] = [];
    if (!this._done) {
      let n = 0;
      for (const g of this.ghostInputs()) {
        try { ghosts.push(buildEntity(g, `ghost${++n}`, (g as { layer?: string }).layer ?? this.layer)); } catch { /* fantasma no válido todavía */ }
      }
    }
    return { ghosts, prompt: this._done ? '' : this.prompt(), selection: [...this.sel], error: this._error, base: this._done ? null : this.base() };
  }
}

// ---------------------------------------------------------------- línea

/** Cadena de segmentos: clic a clic. Enter/Esc termina conservando lo dibujado; C cierra; U (o Retroceso) quita el último punto. */
export class LineTool extends BaseTool {
  readonly name = 'line';
  private pts: Pt2[] = [];
  protected base(): Pt2 | null { return this.pts.length ? this.pts[this.pts.length - 1] : null; }
  protected point(p: Pt2): void {
    if (this.pts.length && same(this.pts[this.pts.length - 1], p)) { this.fail('El punto coincide con el anterior; elige otro.'); return; }
    this.pts.push(p);
  }
  protected undo(): void { if (this.pts.length) this.pts.pop(); else this.fail('No hay nada que deshacer.'); }
  protected option(k: string): void {
    if (k !== 'c') return;
    if (this.pts.length < 3) { this.fail('Para cerrar se necesitan al menos 3 puntos.'); return; }
    this.pts.push(this.pts[0]);
    this.enter();
  }
  protected enter(): void {
    if (this.pts.length < 2) { this.cancel(); return; }
    this.finish(this.pts.slice(1).map((b, i) => this.add({ type: 'line', a: this.pts[i], b })));
  }
  protected escape(): void { this.enter(); }
  protected prompt(): string {
    return !this.pts.length ? 'Primer punto:' : this.pts.length < 3 ? 'Siguiente punto o [deshacer]:' : 'Siguiente punto o [Cerrar/deshacer]:';
  }
  protected ghostInputs(): EntityInput[] {
    const all = this.cursor && this.pts.length && !same(this.cursor, this.pts[this.pts.length - 1]) ? [...this.pts, this.cursor] : this.pts;
    return all.slice(1).map((b, i) => ({ type: 'line', a: all[i], b }) as EntityInput);
  }
}

// ---------------------------------------------------------------- polilínea

/** Dirección (grados) con la que termina el último tramo de una polilínea (tangente de salida); 0 si hay un solo vértice. */
export function polyEndTangent(verts: PolyVertex[]): number {
  const n = verts.length;
  if (n < 2) return 0;
  const a = verts[n - 2], b = verts[n - 1];
  return angleOf(a.p, b.p) + (a.bulge ? sweepFromBulge(a.bulge) / 2 : 0);
}
/** Bulge del arco que sale de `from` con tangente `tan` (grados) y llega a `to`. 0 si coincide con la tangente; null si es imposible (hacia atrás). */
export function tangentArcBulge(from: Pt2, to: Pt2, tan: number): number | null {
  const theta = wrap180(angleOf(from, to) - tan);
  if (Math.abs(theta) < 1e-7) return 0;
  if (Math.abs(theta) > 179.5) return null;
  return Math.tan((theta * RAD) / 2);
}

/**
 * Polilínea con arcos por bulge. Modo línea (L) o arco (A): el arco sale tangente al tramo anterior (en el primero, hacia +x).
 * C cierra (con tramo recto o, en modo arco, con arco tangente); U quita el último vértice; Enter/Esc termina.
 */
export class PolyTool extends BaseTool {
  readonly name = 'polyline';
  private verts: PolyVertex[] = [];
  private arc = false;
  private closed = false;
  protected base(): Pt2 | null { return this.verts.length ? this.verts[this.verts.length - 1].p : null; }
  protected point(p: Pt2): void {
    const n = this.verts.length;
    if (n && same(this.verts[n - 1].p, p)) { this.fail('El punto coincide con el anterior; elige otro.'); return; }
    if (n && this.arc) {
      const b = tangentArcBulge(this.verts[n - 1].p, p, polyEndTangent(this.verts));
      if (b === null) { this.fail('Ese punto queda hacia atrás de la tangente: un arco tangente no puede girar más de 179°. Pon un punto delante o cambia a Línea (L).'); return; }
      if (b) this.verts[n - 1] = { p: this.verts[n - 1].p, bulge: b };
    }
    this.verts.push({ p });
  }
  protected option(k: string): void {
    if (k === 'a') { if (!this.verts.length) this.fail('Da primero el punto inicial.'); else this.arc = true; }
    else if (k === 'l') this.arc = false;
    else if (k === 'c') {
      if (this.verts.length < 3) { this.fail('Para cerrar se necesitan al menos 3 vértices.'); return; }
      const n = this.verts.length;
      if (this.arc) {
        const b = tangentArcBulge(this.verts[n - 1].p, this.verts[0].p, polyEndTangent(this.verts));
        if (b === null) { this.fail('No se puede cerrar con un arco tangente desde aquí; usa Línea (L) y cierra.'); return; }
        if (b) this.verts[n - 1] = { p: this.verts[n - 1].p, bulge: b };
      }
      this.closed = true;
      this.enter();
    }
  }
  protected undo(): void {
    if (!this.verts.length) { this.fail('No hay nada que deshacer.'); return; }
    this.verts.pop();
    if (this.verts.length) this.verts[this.verts.length - 1] = { p: this.verts[this.verts.length - 1].p };
  }
  protected enter(): void {
    if (this.verts.length < 2) { this.cancel(); return; }
    this.finish([this.add({ type: 'poly', pts: this.verts.map((v) => (v.bulge ? { p: v.p, bulge: v.bulge } : { p: v.p })), ...(this.closed ? { closed: true } : {}) })]);
  }
  protected escape(): void { this.enter(); }
  protected prompt(): string {
    if (!this.verts.length) return 'Punto inicial de la polilínea:';
    return this.arc ? 'Siguiente punto del arco o [Línea/Cerrar/deshacer]:' : 'Siguiente punto o [Arco/Cerrar/deshacer]:';
  }
  protected ghostInputs(): EntityInput[] {
    const n = this.verts.length;
    if (!n) return [];
    const pts: PolyVertex[] = this.verts.map((v) => ({ ...v }));
    if (this.cursor && !same(this.cursor, pts[n - 1].p)) {
      if (this.arc) { const b = tangentArcBulge(pts[n - 1].p, this.cursor, polyEndTangent(this.verts)); if (b) pts[n - 1] = { p: pts[n - 1].p, bulge: b }; }
      pts.push({ p: this.cursor });
    }
    return pts.length >= 2 ? [{ type: 'poly', pts } as EntityInput] : [];
  }
}

// ---------------------------------------------------------------- rectángulo

/** Rectángulo por dos esquinas, o con la opción D (dimensiones): ancho y alto escritos (el cursor elige el cuadrante; un valor negativo lo fuerza). */
export class RectTool extends BaseTool {
  readonly name = 'rect';
  private c1: Pt2 | null = null;
  private dimMode = false;
  private w: number | null = null;
  protected base(): Pt2 | null { return this.c1; }
  private side(axis: 0 | 1, v: number): number { return v < 0 ? -1 : this.cursor && this.c1 && this.cursor[axis] < this.c1[axis] ? -1 : 1; }
  private corner(w: number, h: number): Pt2 { return [this.c1![0] + this.side(0, w) * Math.abs(w), this.c1![1] + this.side(1, h) * Math.abs(h)]; }
  private make(c2: Pt2): void {
    const c1 = this.c1!;
    if (Math.abs(c2[0] - c1[0]) < EPS || Math.abs(c2[1] - c1[1]) < EPS) { this.fail('El rectángulo tiene ancho o alto 0; elige una esquina que difiera en x e y.'); return; }
    this.finish([this.add({ type: 'rect', p1: c1, p2: c2 })]);
  }
  protected point(p: Pt2): void {
    if (!this.c1) { this.c1 = p; return; }
    if (this.dimMode) { this.fail(this.w === null ? 'Escribe el ancho (número).' : 'Escribe el alto (número).'); return; }
    this.make(p);
  }
  protected number(v: number): void {
    if (!this.c1) { this.fail('Primero da la primera esquina.'); return; }
    if (!this.dimMode) { this.fail('Escribe @ancho,alto, o pulsa D para dar las Dimensiones.'); return; }
    if (Math.abs(v) < EPS) { this.fail('La medida no puede ser 0.'); return; }
    if (this.w === null) this.w = v; else this.make(this.corner(this.w, v));
  }
  protected text(s: string): void {
    if (this.dimMode && this.c1 && this.w === null && !/^[@#]/.test(s.trim()) && s.includes(',')) {
      const [a, b, ...x] = s.split(',').map(parseLength);
      if (a === null || b === null || x.length || Math.abs(a ?? 0) < EPS || Math.abs(b ?? 0) < EPS) { this.fail(`Dimensiones no válidas: "${s}". Escribe ancho,alto (ejemplo 400,300).`); return; }
      this.make(this.corner(a, b));
      return;
    }
    super.text(s);
  }
  protected option(k: string): void {
    if (k !== 'd') return;
    if (!this.c1) this.fail('Da primero la primera esquina; luego usa D.'); else { this.dimMode = true; this.w = null; }
  }
  protected undo(): void {
    if (this.dimMode && this.w !== null) this.w = null;
    else if (this.dimMode) this.dimMode = false;
    else if (this.c1) this.c1 = null;
    else this.fail('No hay nada que deshacer.');
  }
  protected prompt(): string {
    if (!this.c1) return 'Primera esquina del rectángulo:';
    if (this.dimMode) return this.w === null ? 'Ancho (o ancho,alto):' : 'Alto:';
    return 'Otra esquina o [Dimensiones]:';
  }
  protected ghostInputs(): EntityInput[] {
    if (!this.c1 || !this.cursor) return [];
    const c2: Pt2 = this.dimMode ? (this.w === null ? this.cursor : this.corner(this.w, this.cursor[1] - this.c1[1])) : this.cursor;
    if (this.dimMode && this.w === null) return [];
    if (Math.abs(c2[0] - this.c1[0]) < EPS || Math.abs(c2[1] - this.c1[1]) < EPS) return [];
    return [{ type: 'rect', p1: this.c1, p2: c2 } as EntityInput];
  }
}

// ---------------------------------------------------------------- círculo

export type CircleMode = 'cr' | 'cd' | '2p' | '3p';
/**
 * Círculo: centro-radio (CR, por omisión), centro-diámetro (CD: la distancia o el número es el DIÁMETRO), 2 puntos (diámetro) o 3 puntos.
 * Opciones: R, D, 2, 3 (los modos de dos y tres puntos solo antes del primer punto).
 */
export class CircleTool extends BaseTool {
  readonly name = 'circle';
  private pts: Pt2[] = [];
  constructor(d: Drawing, o: ToolOptions & { mode?: CircleMode } = {}) { super(d, o); this.mode = o.mode ?? 'cr'; }
  private mode: CircleMode;
  protected base(): Pt2 | null { return this.pts.length ? this.pts[this.pts.length - 1] : null; }
  private circ(p: Pt2): { c: Pt2; r: number } | null {
    const k = this.pts[0];
    if (this.mode === 'cr') return dist(k, p) > EPS ? { c: k, r: dist(k, p) } : null;
    if (this.mode === 'cd') return dist(k, p) > EPS ? { c: k, r: dist(k, p) / 2 } : null;
    if (this.mode === '2p') return dist(k, p) > EPS ? { c: [(k[0] + p[0]) / 2, (k[1] + p[1]) / 2], r: dist(k, p) / 2 } : null;
    return this.pts.length === 2 ? circleFrom3Points(this.pts[0], this.pts[1], p) : null;
  }
  protected point(p: Pt2): void {
    if (!this.pts.length) { this.pts.push(p); return; }
    if (this.mode === '3p' && this.pts.length === 1) { if (same(this.pts[0], p)) this.fail('El punto coincide con el anterior.'); else this.pts.push(p); return; }
    const k = this.circ(p);
    if (!k) { this.fail(this.mode === '3p' ? 'Los 3 puntos están alineados o repetidos; no definen un círculo. Elige otro tercer punto.' : 'El radio no puede ser 0; elige un punto distinto del centro.'); return; }
    this.finish([this.add({ type: 'circle', c: k.c, r: k.r })]);
  }
  protected number(v: number): void {
    if (!this.pts.length) { this.fail('Primero da el centro (o el primer punto).'); return; }
    if (v <= 0) { this.fail('El valor debe ser mayor que 0.'); return; }
    if (this.pts.length === 1 && (this.mode === 'cr' || this.mode === 'cd')) {
      this.finish([this.add({ type: 'circle', c: this.pts[0], r: this.mode === 'cr' ? v : v / 2 })]);
      return;
    }
    super.number(v);
  }
  protected option(k: string): void {
    if ((k === 'r' || k === 'd') && (this.mode === 'cr' || this.mode === 'cd') && this.pts.length <= 1) this.mode = k === 'r' ? 'cr' : 'cd';
    else if (k === '2' || k === '3') { if (this.pts.length) this.fail('Esa opción solo está disponible antes del primer punto.'); else this.mode = k === '2' ? '2p' : '3p'; }
    else if ((k === 'r' || k === 'd') && !this.pts.length) this.mode = k === 'r' ? 'cr' : 'cd';
  }
  protected undo(): void { if (this.pts.length) this.pts.pop(); else this.fail('No hay nada que deshacer.'); }
  protected prompt(): string {
    const n = this.pts.length;
    switch (this.mode) {
      case 'cr': return n ? 'Radio [Diámetro]:' : 'Centro del círculo [3P/2P/Diámetro]:';
      case 'cd': return n ? 'Diámetro [Radio]:' : 'Centro del círculo [3P/2P/Radio]:';
      case '2p': return n ? 'Segundo extremo del diámetro:' : 'Primer extremo del diámetro:';
      case '3p': return n === 0 ? 'Primer punto del círculo:' : n === 1 ? 'Segundo punto del círculo:' : 'Tercer punto del círculo:';
    }
  }
  protected ghostInputs(): EntityInput[] {
    if (!this.pts.length || !this.cursor) return [];
    if (this.mode === '3p' && this.pts.length === 1) return same(this.pts[0], this.cursor) ? [] : [{ type: 'line', a: this.pts[0], b: this.cursor } as EntityInput];
    const k = this.circ(this.cursor);
    if (!k) return this.mode === '3p' && this.pts.length === 2 ? [{ type: 'line', a: this.pts[0], b: this.pts[1] } as EntityInput] : [];
    return [{ type: 'circle', c: k.c, r: k.r } as EntityInput];
  }
}

// ---------------------------------------------------------------- arco

export type ArcMode = '3p' | 'cse';
/**
 * Arco por 3 puntos (inicio, intermedio, fin) o Centro-Inicio-Fin (opción C; el fin fija el ángulo final, antihorario desde el inicio;
 * un número en el último paso es el ángulo incluido en grados, negativo = horario).
 */
export class ArcTool extends BaseTool {
  readonly name = 'arc';
  private pts: Pt2[] = [];
  private mode: ArcMode;
  constructor(d: Drawing, o: ToolOptions & { mode?: ArcMode } = {}) { super(d, o); this.mode = o.mode ?? '3p'; }
  protected base(): Pt2 | null { return this.pts.length ? this.pts[this.pts.length - 1] : null; }
  private cse(end: Pt2): EntityInput | null {
    const [c, s] = this.pts;
    const r = dist(c, s), a0 = angleOf(c, s), a1 = angleOf(c, end);
    if (r < EPS || dist(c, end) < EPS || Math.abs(wrap180(a1 - a0)) < 1e-7) return null;
    return { type: 'arc', c, r, a0: norm360(a0), a1: norm360(a1) };
  }
  protected point(p: Pt2): void {
    const n = this.pts.length;
    if (n && same(this.pts[n - 1], p)) { this.fail('El punto coincide con el anterior.'); return; }
    if (this.mode === '3p' || n < 2) { if (this.mode === '3p' && n === 2) return this.end3(p); this.pts.push(p); return; }
    const a = this.cse(p);
    if (!a) { this.fail('El punto final está en el mismo ángulo que el inicial; elige otro.'); return; }
    this.finish([this.add(a)]);
  }
  private end3(p: Pt2): void {
    if (!arcFrom3Points(this.pts[0], this.pts[1], p)) { this.fail('Los 3 puntos están alineados o repetidos; no definen un arco. Elige otro punto final.'); return; }
    this.finish([this.add({ type: 'arc', pts: [this.pts[0], this.pts[1], p] })]);
  }
  protected number(v: number): void {
    if (this.mode === 'cse' && this.pts.length === 1) { // radio: inicio a esa distancia en la dirección del cursor
      if (v <= 0) { this.fail('El radio debe ser mayor que 0.'); return; }
      return super.number(v);
    }
    if (this.mode === 'cse' && this.pts.length === 2) {
      const [c, s] = this.pts, r = dist(c, s), a0 = angleOf(c, s);
      if (Math.abs(v) < 1e-7 || Math.abs(v) >= 360) { this.fail('El ángulo incluido debe estar entre 0 y 360 (grados; negativo = horario).'); return; }
      this.finish([this.add(v > 0 ? { type: 'arc', c, r, a0: norm360(a0), a1: norm360(a0 + v) } : { type: 'arc', c, r, a0: norm360(a0 + v), a1: norm360(a0) })]);
      return;
    }
    super.number(v);
  }
  protected angleInput(a: number): void { if (this.mode === 'cse' && this.pts.length === 2) this.number(a); else super.angleInput(a); }
  protected option(k: string): void {
    if (k === 'c' || k === '3') { if (this.pts.length) this.fail('Esa opción solo está disponible antes del primer punto.'); else this.mode = k === 'c' ? 'cse' : '3p'; }
  }
  protected undo(): void { if (this.pts.length) this.pts.pop(); else this.fail('No hay nada que deshacer.'); }
  protected prompt(): string {
    const n = this.pts.length;
    if (this.mode === '3p') return n === 0 ? 'Punto inicial del arco [Centro]:' : n === 1 ? 'Segundo punto del arco:' : 'Punto final del arco:';
    return n === 0 ? 'Centro del arco [3 puntos]:' : n === 1 ? 'Punto inicial del arco (define el radio):' : 'Punto final (ángulo) o ángulo incluido:';
  }
  protected ghostInputs(): EntityInput[] {
    const n = this.pts.length, cur = this.cursor;
    if (!n || !cur) return [];
    if (n === 1) return same(this.pts[0], cur) ? [] : [{ type: 'line', a: this.pts[0], b: cur } as EntityInput];
    if (this.mode === '3p') return arcFrom3Points(this.pts[0], this.pts[1], cur) ? [{ type: 'arc', pts: [this.pts[0], this.pts[1], cur] } as EntityInput] : [{ type: 'line', a: this.pts[0], b: this.pts[1] } as EntityInput];
    const a = this.cse(cur);
    return [{ type: 'line', a: this.pts[0], b: this.pts[1] } as EntityInput, ...(a ? [a] : [])];
  }
}

// ---------------------------------------------------------------- texto

/** Texto: punto de inserción y luego el contenido con `onText` (no se interpreta como coordenadas). Enter con el contenido vacío cancela. */
export class TextTool extends BaseTool {
  readonly name = 'text';
  private p: Pt2 | null = null;
  constructor(d: Drawing, o: ToolOptions & { rot?: number; align?: 'left' | 'center' | 'right' } = {}) { super(d, o); this.extra = { rot: o.rot, align: o.align }; }
  private extra: { rot?: number; align?: 'left' | 'center' | 'right' };
  protected point(p: Pt2): void { if (!this.p) this.p = p; else this.fail('Escribe el texto y pulsa Enter (o Esc para cancelar).'); }
  protected text(s: string): void {
    if (!this.p) { super.text(s); return; }
    if (!s.trim()) { this.fail('El texto no puede estar vacío.'); return; }
    const h = this.o.textHeight ?? 100;
    if (!(h > 0)) { this.fail('El alto de letra debe ser mayor que 0.'); return; }
    this.finish([this.add({ type: 'text', p: this.p, h, s, ...(this.extra.rot ? { rot: this.extra.rot } : {}), ...(this.extra.align ? { align: this.extra.align } : {}) })]);
  }
  protected number(v: number): void { this.fail(this.p ? 'Escribe el texto (no una distancia).' : `Da el punto de inserción con x,y o con el ratón (${v} solo no basta).`); }
  protected option(_k: string): void { /* el contenido llega por onText */ }
  protected undo(): void { if (this.p) this.p = null; else this.fail('No hay nada que deshacer.'); }
  protected prompt(): string { return this.p ? 'Texto:' : 'Punto de inserción del texto:'; }
  protected ghostInputs(): EntityInput[] { return []; }
}

// ---------------------------------------------------------------- cota

/**
 * Cota lineal (horizontal/vertical según dónde pongas la línea de cota; H y V fuerzan) o alineada: p1, p2 y posición.
 * Un número en el último paso es la distancia de la línea de cota a la medida.
 */
export class DimTool extends BaseTool {
  readonly name = 'dim';
  private pts: Pt2[] = [];
  private orient: 'auto' | 'h' | 'v' = 'auto';
  private kind: 'linear' | 'aligned';
  constructor(d: Drawing, o: ToolOptions & { kind?: 'linear' | 'aligned' } = {}) { super(d, o); this.kind = o.kind ?? 'linear'; }
  protected base(): Pt2 | null { return this.pts.length ? this.pts[this.pts.length - 1] : null; }
  private rotFor(at: Pt2): number {
    if (this.orient !== 'auto') return this.orient === 'h' ? 0 : 90;
    const [p1, p2] = this.pts;
    const ex = Math.max(0, Math.min(p1[0], p2[0]) - at[0], at[0] - Math.max(p1[0], p2[0]));
    const ey = Math.max(0, Math.min(p1[1], p2[1]) - at[1], at[1] - Math.max(p1[1], p2[1]));
    return ex > ey ? 90 : 0;
  }
  private dim(at: Pt2): EntityInput {
    const [p1, p2] = this.pts;
    return this.kind === 'aligned' ? { type: 'dim', kind: 'aligned', p1, p2, at } : { type: 'dim', kind: 'linear', p1, p2, at, rot: this.rotFor(at) };
  }
  protected point(p: Pt2): void {
    const n = this.pts.length;
    if (n < 2) {
      if (n === 1 && same(this.pts[0], p)) { this.fail('Los dos puntos de origen son el mismo; no hay nada que medir.'); return; }
      this.pts.push(p);
      return;
    }
    this.finish([this.add(this.dim(p))]);
  }
  protected number(v: number): void {
    if (this.pts.length < 2) return super.number(v);
    const [p1, p2] = this.pts, m: Pt2 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    let at: Pt2;
    if (this.kind === 'aligned') { const L = dist(p1, p2), nx = -(p2[1] - p1[1]) / L, ny = (p2[0] - p1[0]) / L; at = [m[0] + nx * v, m[1] + ny * v]; }
    else at = this.orient === 'v' ? [m[0] + v, m[1]] : [m[0], m[1] + v];
    this.finish([this.add(this.dim(at))]);
  }
  protected text(s: string): void { if (this.pts.length === 2 && parseLength(s) !== null) this.number(parseLength(s)!); else super.text(s); }
  protected option(k: string): void {
    if (this.kind !== 'linear') return;
    if (k === 'h') this.orient = 'h'; else if (k === 'v') this.orient = 'v'; else if (k === 'a') this.orient = 'auto';
  }
  protected undo(): void { if (this.pts.length) this.pts.pop(); else this.fail('No hay nada que deshacer.'); }
  protected prompt(): string {
    const n = this.pts.length;
    return n === 0 ? 'Primer punto de origen de la cota:' : n === 1 ? 'Segundo punto de origen de la cota:' : this.kind === 'linear' ? 'Posición de la línea de cota [Horizontal/Vertical]:' : 'Posición de la línea de cota:';
  }
  protected ghostInputs(): EntityInput[] {
    const n = this.pts.length, cur = this.cursor;
    if (!n || !cur) return [];
    if (n === 1) return same(this.pts[0], cur) ? [] : [{ type: 'line', a: this.pts[0], b: cur } as EntityInput];
    return [this.dim(cur)];
  }
}

// ---------------------------------------------------------------- herramientas de edición (con selección previa)

abstract class EditTool extends BaseTool {
  /** `first`: estado tras la selección. Con selección previa válida se salta el estado "select". */
  constructor(d: Drawing, o: ToolOptions, first: string) {
    super(d, o);
    this.sel = this.editable(o.selection ?? []);
    this.afterSelect = first;
    this.stage = this.sel.length ? first : 'select';
  }
  protected afterSelect: string;

  protected editable(ids: string[]): string[] {
    const out: string[] = [];
    for (const id of new Set(ids)) {
      const e = getEntity(this.d, id);
      if (!e) continue;
      const l = findLayer(this.d, e.layer);
      if (l && (l.locked || l.frozen)) continue;
      out.push(id);
    }
    return out;
  }
  protected ents(): Entity[] { return this.sel.map((id) => getEntity(this.d, id)!).filter(Boolean); }
  protected select(ids: string[], mode: 'add' | 'replace' | 'toggle'): void {
    if (this.stage !== 'select') { this.fail('La selección ya está confirmada; cancela (Esc) y empieza de nuevo para cambiarla.'); return; }
    const ok = this.editable(ids);
    if (ids.length && !ok.length) { this.fail('Esos objetos están en capas bloqueadas o congeladas (o no existen); no se pueden editar.'); return; }
    if (mode === 'replace') this.sel = ok;
    else if (mode === 'toggle') { const cur = new Set(this.sel); for (const id of ok) { if (cur.has(id)) cur.delete(id); else cur.add(id); } this.sel = [...cur]; }
    else this.sel = [...new Set([...this.sel, ...ok])];
  }
  protected enter(): void {
    if (this.stage === 'select') { if (this.sel.length) this.stage = this.afterSelect; else this.cancel(); return; }
    this.enterLater();
  }
  protected enterLater(): void { this.cancel(); }
  protected selectPrompt(): string { return this.sel.length ? `${this.sel.length} objeto(s) designado(s). Designe más objetos o pulse Enter:` : 'Designe objetos:'; }
  protected point(p: Pt2): void { if (this.stage === 'select') this.fail('Designa objetos (clic, ventana o cruce) y pulsa Enter.'); else this.pointLater(p); }
  protected abstract pointLater(p: Pt2): void;
  protected text(s: string): void { if (this.stage === 'select') this.fail('Primero designa objetos y pulsa Enter.'); else super.text(s); }
  protected moved(f: (e: Entity) => Entity): EntityInput[] { return this.ents().map((e) => stripId(f(e))); }
  protected updates(f: (e: Entity) => Entity): DrawOp[] { return this.ents().map((e) => ({ op: 'update', id: e.id, patch: diffPatch(e, f(e)) })); }
  protected copies(f: (e: Entity) => Entity): DrawOp[] { return this.ents().map((e) => ({ op: 'add', entity: stripId(f(e)) })); }
}

/** Mover: base → destino (o D: desplazamiento escrito). Entrada relativa @dx,dy respecto de la base. */
export class MoveTool extends EditTool {
  readonly name = 'move';
  private b: Pt2 | null = null;
  constructor(d: Drawing, o: ToolOptions = {}) { super(d, o, 'base'); }
  protected base(): Pt2 | null { return this.stage === 'dest' ? this.b : this.stage === 'disp' ? [0, 0] : null; }
  protected pointLater(p: Pt2): void {
    if (this.stage === 'base') { this.b = p; this.stage = 'dest'; return; }
    const delta: Pt2 = this.stage === 'disp' ? p : [p[0] - this.b![0], p[1] - this.b![1]];
    if (Math.hypot(delta[0], delta[1]) < EPS) { this.fail('El desplazamiento es 0.'); return; }
    this.finish(this.updates((e) => transformEntity(e, { dx: delta[0], dy: delta[1] })));
  }
  protected number(v: number): void { if (this.stage === 'dest') super.number(v); else this.fail(this.stage === 'disp' ? 'Escribe el desplazamiento como dx,dy o distancia<ángulo.' : 'Da primero el punto base.'); }
  protected option(k: string): void { if (k === 'd' && this.stage === 'base') this.stage = 'disp'; }
  protected undo(): void { if (this.stage === 'dest') { this.stage = 'base'; this.b = null; } else if (this.stage === 'disp') this.stage = 'base'; else this.fail('No hay nada que deshacer.'); }
  protected prompt(): string { return this.stage === 'select' ? this.selectPrompt() : this.stage === 'base' ? 'Punto base o [Desplazamiento]:' : this.stage === 'disp' ? 'Desplazamiento (dx,dy):' : 'Segundo punto o <usar primer punto como desplazamiento>:'; }
  protected ghostInputs(): EntityInput[] {
    if (this.stage !== 'dest' || !this.cursor) return [];
    const dx = this.cursor[0] - this.b![0], dy = this.cursor[1] - this.b![1];
    return this.moved((e) => transformEntity(e, { dx, dy }));
  }
}

/** Copiar: base → varios destinos (repite hasta Enter/Esc). `once: true` copia una sola vez. U quita la última copia. */
export class CopyTool extends EditTool {
  readonly name = 'copy';
  private b: Pt2 | null = null;
  private deltas: Pt2[] = [];
  private once: boolean;
  constructor(d: Drawing, o: ToolOptions & { once?: boolean } = {}) { super(d, o, 'base'); this.once = !!o.once; }
  protected base(): Pt2 | null { return this.stage === 'dest' ? this.b : this.stage === 'disp' ? [0, 0] : null; }
  private build(): DrawOp[] { return this.deltas.flatMap((dl) => this.copies((e) => transformEntity(e, { dx: dl[0], dy: dl[1] }))); }
  protected pointLater(p: Pt2): void {
    if (this.stage === 'base') { this.b = p; this.stage = 'dest'; return; }
    const delta: Pt2 = this.stage === 'disp' ? p : [p[0] - this.b![0], p[1] - this.b![1]];
    if (Math.hypot(delta[0], delta[1]) < EPS) { this.fail('El desplazamiento es 0.'); return; }
    this.deltas.push(delta);
    if (this.once || this.stage === 'disp') this.finish(this.build());
  }
  protected number(v: number): void { if (this.stage === 'dest') super.number(v); else this.fail(this.stage === 'disp' ? 'Escribe el desplazamiento como dx,dy o distancia<ángulo.' : 'Da primero el punto base.'); }
  protected option(k: string): void { if (k === 'd' && this.stage === 'base') this.stage = 'disp'; }
  protected enterLater(): void { if (this.deltas.length) this.finish(this.build()); else this.cancel(); }
  protected escape(): void { if (this.stage === 'select') this.cancel(); else this.enterLater(); }
  protected undo(): void {
    if (this.deltas.length) this.deltas.pop();
    else if (this.stage === 'dest') { this.stage = 'base'; this.b = null; } else if (this.stage === 'disp') this.stage = 'base';
    else this.fail('No hay nada que deshacer.');
  }
  protected prompt(): string { return this.stage === 'select' ? this.selectPrompt() : this.stage === 'base' ? 'Punto base o [Desplazamiento]:' : this.stage === 'disp' ? 'Desplazamiento (dx,dy):' : 'Segundo punto o <salir>:'; }
  protected ghostInputs(): EntityInput[] {
    const all = this.deltas.slice();
    if (this.stage === 'dest' && this.cursor) all.push([this.cursor[0] - this.b![0], this.cursor[1] - this.b![1]]);
    return all.flatMap((dl) => this.moved((e) => transformEntity(e, { dx: dl[0], dy: dl[1] })));
  }
}

/** Girar: base → ángulo (punto, o número en grados). R: referencia (ángulo actual y nuevo). C: conserva el original. */
export class RotateTool extends EditTool {
  readonly name = 'rotate';
  private b: Pt2 | null = null;
  private ref = 0;
  private copy: boolean;
  constructor(d: Drawing, o: ToolOptions & { copy?: boolean } = {}) { super(d, o, 'base'); this.copy = !!o.copy; }
  protected base(): Pt2 | null { return this.stage === 'base' || this.stage === 'select' ? null : this.b; }
  private apply(deg: number): void {
    if (Math.abs(deg) < 1e-9) { this.fail('El ángulo de giro es 0.'); return; }
    const f = (e: Entity) => transformEntity(e, { center: this.b!, rot: deg });
    this.finish(this.copy ? this.copies(f) : this.updates(f));
  }
  protected pointLater(p: Pt2): void {
    if (this.stage === 'base') { this.b = p; this.stage = 'angle'; return; }
    if (same(this.b!, p)) { this.fail('El punto coincide con el centro de giro; elige otro.'); return; }
    const a = angleOf(this.b!, p);
    if (this.stage === 'ref') { this.ref = a; this.stage = 'angle'; return; }
    this.apply(a - this.ref);
  }
  protected number(v: number): void {
    if (this.stage === 'base') { this.fail('Da primero el punto base.'); return; }
    if (this.stage === 'ref') { this.ref = v; this.stage = 'angle'; return; }
    this.apply(v - this.ref);
  }
  protected angleInput(a: number): void { if (this.stage === 'angle' || this.stage === 'ref') this.number(a); }
  protected option(k: string): void {
    if (k === 'c') this.copy = !this.copy;
    else if (k === 'r' && this.stage === 'angle') { this.stage = 'ref'; this.ref = 0; }
  }
  protected undo(): void { if (this.stage === 'ref') this.stage = 'angle'; else if (this.stage === 'angle') { this.stage = 'base'; this.b = null; this.ref = 0; } else this.fail('No hay nada que deshacer.'); }
  protected prompt(): string {
    if (this.stage === 'select') return this.selectPrompt();
    const c = this.copy ? ' (copia)' : '';
    return this.stage === 'base' ? 'Punto base:' : this.stage === 'ref' ? 'Ángulo de referencia <0>:' : `Ángulo de giro${c} o [Copiar/Referencia]:`;
  }
  protected ghostInputs(): EntityInput[] {
    if (this.stage !== 'angle' || !this.cursor || same(this.b!, this.cursor)) return [];
    const deg = angleOf(this.b!, this.cursor) - this.ref;
    return this.moved((e) => transformEntity(e, { center: this.b!, rot: deg }));
  }
}

/** Escalar: base → factor escrito (>0, sin espejos), o R: longitud de referencia y nueva longitud (números o puntos). C: conserva el original. */
export class ScaleTool extends EditTool {
  readonly name = 'scale';
  private b: Pt2 | null = null;
  private refLen = 0;
  private copy: boolean;
  constructor(d: Drawing, o: ToolOptions & { copy?: boolean } = {}) { super(d, o, 'base'); this.copy = !!o.copy; }
  protected base(): Pt2 | null { return this.stage === 'base' || this.stage === 'select' ? null : this.b; }
  private apply(f: number): void {
    if (!(f > 0) || !Number.isFinite(f)) { this.fail('El factor de escala debe ser mayor que 0 (no hay espejos con escala).'); return; }
    if (Math.abs(f - 1) < 1e-12) { this.fail('El factor 1 no cambia nada.'); return; }
    const t = (e: Entity) => transformEntity(e, { center: this.b!, scale: f });
    this.finish(this.copy ? this.copies(t) : this.updates(t));
  }
  private len(v: number): void {
    if (!(v > 0)) { this.fail('La longitud debe ser mayor que 0.'); return; }
    if (this.stage === 'ref1') { this.refLen = v; this.stage = 'ref2'; } else this.apply(v / this.refLen);
  }
  protected pointLater(p: Pt2): void {
    if (this.stage === 'base') { this.b = p; this.stage = 'factor'; return; }
    if (this.stage === 'factor') { this.fail('Escribe el factor (por ejemplo 2 o 0.5) o pulsa R para usar una referencia.'); return; }
    this.len(dist(this.b!, p));
  }
  protected number(v: number): void {
    if (this.stage === 'base') { this.fail('Da primero el punto base.'); return; }
    if (this.stage === 'factor') this.apply(v); else this.len(v);
  }
  protected angleInput(_a: number): void { this.fail('Aquí no se usan ángulos: escribe un factor o una longitud.'); }
  protected option(k: string): void {
    if (k === 'c') this.copy = !this.copy;
    else if (k === 'r' && this.stage === 'factor') this.stage = 'ref1';
  }
  protected undo(): void { if (this.stage === 'ref2') this.stage = 'ref1'; else if (this.stage === 'ref1') this.stage = 'factor'; else if (this.stage === 'factor') { this.stage = 'base'; this.b = null; } else this.fail('No hay nada que deshacer.'); }
  protected prompt(): string {
    return this.stage === 'select' ? this.selectPrompt() : this.stage === 'base' ? 'Punto base:' : this.stage === 'factor' ? 'Factor de escala o [Copiar/Referencia]:' : this.stage === 'ref1' ? 'Longitud de referencia <1>:' : 'Nueva longitud:';
  }
  protected ghostInputs(): EntityInput[] {
    if (this.stage !== 'ref2' || !this.cursor) return [];
    const f = dist(this.b!, this.cursor) / this.refLen;
    return f > 0 && Number.isFinite(f) ? this.moved((e) => transformEntity(e, { center: this.b!, scale: f })) : [];
  }
}

/** Simetría: dos puntos del eje; luego S (borrar originales) o N / Enter (conservarlos). El texto no se espeja. */
export class MirrorTool extends EditTool {
  readonly name = 'mirror';
  private a: Pt2 | null = null;
  private b: Pt2 | null = null;
  constructor(d: Drawing, o: ToolOptions = {}) { super(d, o, 'axis1'); }
  protected base(): Pt2 | null { return this.stage === 'axis2' ? this.a : null; }
  protected pointLater(p: Pt2): void {
    if (this.stage === 'axis1') { this.a = p; this.stage = 'axis2'; return; }
    if (this.stage === 'axis2') {
      if (same(this.a!, p)) { this.fail('El segundo punto del eje coincide con el primero.'); return; }
      this.b = p; this.stage = 'del'; return;
    }
    this.fail('Responde S (sí) o N (no) / Enter.');
  }
  private done2(del: boolean): void {
    const m = (e: Entity) => mirrorEntity(e, this.a!, this.b!);
    this.finish([...this.copies(m), ...(del ? [{ op: 'remove', ids: [...this.sel] } as DrawOp] : [])]);
  }
  protected option(k: string): void { if (this.stage === 'del') { if (k === 's') this.done2(true); else if (k === 'n') this.done2(false); } }
  protected enterLater(): void { if (this.stage === 'del') this.done2(false); else this.cancel(); }
  protected number(v: number): void { if (this.stage === 'axis2') super.number(v); else this.fail('Da los dos puntos del eje de simetría.'); }
  protected undo(): void { if (this.stage === 'del') { this.stage = 'axis2'; this.b = null; } else if (this.stage === 'axis2') { this.stage = 'axis1'; this.a = null; } else this.fail('No hay nada que deshacer.'); }
  protected prompt(): string {
    return this.stage === 'select' ? this.selectPrompt() : this.stage === 'axis1' ? 'Primer punto del eje de simetría:' : this.stage === 'axis2' ? 'Segundo punto del eje de simetría:' : '¿Borrar los objetos de origen? [Sí/No] <No>:';
  }
  protected ghostInputs(): EntityInput[] {
    if (this.stage === 'axis2' && this.cursor && !same(this.a!, this.cursor)) return [{ type: 'line', a: this.a!, b: this.cursor } as EntityInput, ...this.moved((e) => mirrorEntity(e, this.a!, this.cursor!))];
    if (this.stage === 'del') return this.moved((e) => mirrorEntity(e, this.a!, this.b!));
    return [];
  }
}

/** Desfasar (offset): distancia → objeto → lado; se repite hasta Enter/Esc. Línea, polilínea sin arcos, círculo y arco. */
export class OffsetTool extends BaseTool {
  readonly name = 'offset';
  private dist: number | null;
  private target: string | null = null;
  constructor(d: Drawing, o: ToolOptions & { distance?: number } = {}) { super(d, o); this.dist = o.distance && o.distance > 0 ? o.distance : null; this.stage = this.dist ? 'object' : 'dist'; }
  protected base(): Pt2 | null { return null; }
  private sideSign(e: Entity, p: Pt2): number {
    if (e.type === 'circle' || e.type === 'arc') return dist(p, e.c) > e.r ? 1 : -1;
    if (e.type === 'line') return (e.b[0] - e.a[0]) * (p[1] - e.a[1]) - (e.b[1] - e.a[1]) * (p[0] - e.a[0]) >= 0 ? 1 : -1;
    if (e.type === 'poly') {
      let best = Infinity, sign = 1;
      for (const s of polySegments(e)) {
        const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p[0] - s.a[0]) * dx + (p[1] - s.a[1]) * dy) / l2));
        const dd = Math.hypot(p[0] - (s.a[0] + t * dx), p[1] - (s.a[1] + t * dy));
        if (dd < best) { best = dd; sign = dx * (p[1] - s.a[1]) - dy * (p[0] - s.a[0]) >= 0 ? 1 : -1; }
      }
      return sign;
    }
    return 1;
  }
  private offsetFor(p: Pt2): EntityInput {
    const e = getEntity(this.d, this.target!)!;
    const r = offsetEntity(this.d, this.target!, this.sideSign(e, p) * this.dist!);
    return stripId(getEntity(r.drawing, r.id)!);
  }
  protected point(p: Pt2): void {
    if (this.stage === 'object') {
      const hit = pickAt(this.d, p, this.o.pickTolerance ?? 1);
      if (hit.length) this.select(hit.slice(0, 1)); else this.fail('No hay ningún objeto ahí. Designa la línea, polilínea, círculo o arco a desfasar.');
      return;
    }
    if (this.stage === 'dist') { this.fail('Escribe primero la distancia de desfase (número).'); return; }
    try { this.ops.push({ op: 'add', entity: this.offsetFor(p) }); this.stage = 'object'; this.target = null; this.sel = []; } catch (err) { if (err instanceof DrawingError) this.fail(err.message); else throw err; }
  }
  protected number(v: number): void {
    if (this.stage !== 'dist') { this.fail('La distancia de desfase ya está fijada; elige el objeto o el lado.'); return; }
    if (!(v > 0)) { this.fail('La distancia debe ser mayor que 0.'); return; }
    this.dist = v; this.stage = 'object';
  }
  protected text(s: string): void { const v = parseLength(s); if (v !== null) this.number(v); else this.fail(this.stage === 'dist' ? `Distancia no válida: "${s}". Escribe un número (ejemplo 50 o 5cm).` : 'Aquí solo se espera un punto del lado o un objeto.'); }
  protected select(ids: string[]): void {
    if (this.stage !== 'object') { this.fail(this.stage === 'dist' ? 'Escribe primero la distancia de desfase.' : 'Ya hay un objeto; elige el lado con un punto.'); return; }
    for (const id of ids) {
      const e = getEntity(this.d, id);
      const l = e && findLayer(this.d, e.layer);
      if (!e) continue;
      if (l && (l.locked || l.frozen)) { this.fail(`La capa "${l.name}" está bloqueada o congelada; no se puede desfasar "${id}".`); return; }
      if (!['line', 'poly', 'circle', 'arc'].includes(e.type)) { this.fail(`El desfase no se aplica a ${e.type}; usa línea, polilínea, círculo o arco.`); return; }
      this.target = id; this.sel = [id]; this.stage = 'side';
      return;
    }
    this.fail('No existe ese objeto.');
  }
  protected enter(): void { if (this.ops.length) this.finish(this.ops); else this.cancel(); }
  protected escape(): void { this.enter(); }
  protected undo(): void {
    if (this.stage === 'side') { this.stage = 'object'; this.target = null; this.sel = []; }
    else if (this.ops.length) this.ops.pop();
    else this.fail('No hay nada que deshacer.');
  }
  protected prompt(): string {
    return this.stage === 'dist' ? 'Distancia de desfase:' : this.stage === 'object' ? `Designe el objeto a desfasar (${this.dist} mm) o <salir>:` : 'Punto del lado donde desfasar:';
  }
  protected ghostInputs(): EntityInput[] {
    const done = this.ops.filter((o): o is Extract<DrawOp, { op: 'add' }> => o.op === 'add').map((o) => o.entity);
    if (this.stage === 'side' && this.cursor) { try { return [...done, this.offsetFor(this.cursor)]; } catch { /* aún no válido */ } }
    return done;
  }
}

/** Borrar: con selección previa borra de inmediato; si no, designa con onSelect y Enter. */
export class EraseTool extends EditTool {
  readonly name = 'erase';
  constructor(d: Drawing, o: ToolOptions = {}) { super(d, o, 'confirm'); if (this.stage === 'confirm') this.confirm(); }
  private confirm(): void { this.finish([{ op: 'remove', ids: [...this.sel] }]); }
  protected pointLater(_p: Pt2): void { /* nada */ }
  protected enter(): void { if (this.sel.length) this.confirm(); else this.cancel(); }
  protected number(_v: number): void { this.fail('Designa objetos y pulsa Enter.'); }
  protected prompt(): string { return this.selectPrompt(); }
}

// ---------------------------------------------------------------- recortar / extender

/**
 * Recortar (trim) y Extender (extend), estilo CAD. Primero se designan los bordes (clic, ventana, o Enter = todos) y luego se hace clic
 * sobre los objetos a recortar/extender, una y otra vez, hasta Enter/Esc. Mayús invierte la acción (recortar ↔ extender). B alterna
 * el modo de bordes extendidos; U / D (o Retroceso) deshacen el último. Cada clic es una operación que la interfaz puede aplicar ya con
 * `drain()`; quien no lo use recibe todas las operaciones en `commit()`. Núcleo: trimExtend.ts.
 */
export class TrimExtendTool extends BaseTool {
  readonly name: string;
  private mode: 'trim' | 'extend';
  private edgeMode: 'normal' | 'extendido';
  private bnd: string[] | 'todos' = 'todos';
  private cur: Drawing;
  private mods: { shift?: boolean; tol?: number } = {};
  private stack: { before: Drawing; undo: DrawOp[]; entry: DrawOp[] }[] = [];
  private queue: DrawOp[][] = [];
  constructor(d: Drawing, o: ToolOptions & { mode?: 'trim' | 'extend'; edgeMode?: 'normal' | 'extendido'; boundaries?: string[] | 'todos' } = {}) {
    super(d, o);
    this.mode = o.mode ?? 'trim'; this.name = this.mode;
    this.edgeMode = o.edgeMode ?? 'normal';
    this.cur = d;
    if (o.boundaries) { this.bnd = o.boundaries; this.stage = 'object'; } else this.stage = 'edges';
  }
  protected base(): Pt2 | null { return null; }
  private validEdge(id: string): boolean {
    const e = getEntity(this.cur, id);
    const l = e && findLayer(this.cur, e.layer);
    return !!e && ['line', 'poly', 'circle', 'arc'].includes(e.type) && !(l && (l.frozen || !l.on));
  }
  protected select(ids: string[], mode: 'add' | 'replace' | 'toggle'): void {
    if (this.stage !== 'edges') { this.fail('Los bordes ya están fijados; pulsa Esc y empieza de nuevo para cambiarlos.'); return; }
    const ok = ids.filter((id) => this.validEdge(id));
    if (ids.length && !ok.length) { this.fail(ids.some((id) => getEntity(this.cur, id)?.type === 'insert') ? 'Los bloques insertados no sirven de borde (explótalos primero); solo línea, polilínea, círculo o arco visibles.' : 'Esos objetos no sirven de borde (solo línea, polilínea, círculo o arco visibles).'); return; }
    if (mode === 'replace') this.sel = [...new Set(ok)];
    else if (mode === 'toggle') { const c = new Set(this.sel); for (const id of ok) { if (c.has(id)) c.delete(id); else c.add(id); } this.sel = [...c]; }
    else this.sel = [...new Set([...this.sel, ...ok])];
  }
  onPoint(p: Pt2, mods?: { shift?: boolean; tol?: number }): void { this.mods = mods ?? {}; super.onPoint(p); }
  private hitsInsert(p: Pt2): boolean { return pickAt(this.cur, p, this.tol(), { includeLocked: true }).some((x) => getEntity(this.cur, x)?.type === 'insert'); }
  private tol(): number { return this.mods.tol ?? this.o.pickTolerance ?? 1; }
  protected point(p: Pt2): void {
    if (this.stage === 'edges') {
      const id = pickAt(this.cur, p, this.tol(), { includeLocked: true }).find((x) => this.validEdge(x));
      if (id) this.select([id], 'toggle'); else if (this.hitsInsert(p)) this.fail('Los bloques insertados no sirven de borde (explótalos primero).'); else this.fail('No hay ningún borde ahí. Designa líneas, polilíneas, círculos o arcos, y pulsa Enter (o Enter solo para usar todos).');
      return;
    }
    const m = this.mods.shift ? (this.mode === 'trim' ? 'extend' : 'trim') : this.mode;
    const id = pickAt(this.cur, p, this.tol(), { includeLocked: true }).find((x) => ['line', 'arc', 'circle', 'poly'].includes(getEntity(this.cur, x)?.type ?? ''));
    if (!id && this.hitsInsert(p)) { this.fail(`Un bloque insertado no se puede ${m === 'trim' ? 'recortar' : 'extender'}: explótalo primero o edita el bloque.`); return; }
    if (!id) { this.fail(`No hay ningún objeto ahí para ${m === 'trim' ? 'recortar' : 'extender'}.`); return; }
    try {
      const ops = (m === 'trim' ? trimEntity : extendEntity)(this.cur, id, p, this.bnd, { edgeMode: this.edgeMode });
      const next = applyOps(this.cur, ops).drawing;
      this.stack.push({ before: this.cur, undo: diffOps(this.cur, next), entry: ops });
      this.queue.push(ops);
      this.cur = next;
    } catch (err) { if (err instanceof DrawingError) this.fail(err.message); else throw err; }
  }
  protected number(_v: number): void { this.fail('Designa los objetos con un clic; aquí no se usan distancias.'); }
  protected option(k: string): void {
    if (k === 'b') this.edgeMode = this.edgeMode === 'normal' ? 'extendido' : 'normal';
    else if (k === 'd') this.undo();
  }
  protected enter(): void {
    if (this.stage === 'edges') { this.bnd = this.sel.length ? [...this.sel] : 'todos'; this.stage = 'object'; return; }
    this.finish([]);
  }
  protected escape(): void { if (this.stage === 'edges') this.cancel(); else this.finish([]); }
  protected undo(): void {
    const g = this.stack.pop();
    if (!g) { this.fail('No hay nada que deshacer.'); return; }
    const i = this.queue.indexOf(g.entry);
    if (i >= 0) this.queue.splice(i, 1); else this.queue.push(g.undo);
    this.cur = g.before;
  }
  drain(): DrawOp[] { const out = this.queue.flat(); this.queue = []; return out; }
  /** Adopta el dibujo real actual: lo que otro (agente MCP) agregó o cambió se ve sin reiniciar. Los bordes designados que ya no existen se descartan. */
  sync(d: Drawing): void {
    if (d === this.cur) return;
    this.cur = d;
    this.sel = this.sel.filter((id) => !!getEntity(d, id));
    if (Array.isArray(this.bnd)) { const ok = this.bnd.filter((id) => !!getEntity(d, id)); this.bnd = ok.length ? ok : 'todos'; }
  }
  commit(): DrawOp[] { if (!this._done || this._cancelled || this._committed) return []; this._committed = true; return this.drain(); }
  protected prompt(): string {
    if (this.stage === 'edges') return this.sel.length ? `${this.sel.length} borde(s) designado(s). Designe más bordes o pulse Enter:` : 'Designe bordes de corte o Enter para todos:';
    return `Designe objeto a ${this.mode === 'trim' ? 'recortar' : 'extender'} [Deshacer]:${this.edgeMode === 'extendido' ? ' (bordes extendidos)' : ''}`;
  }
}

// ---------------------------------------------------------------- fábrica

export const TOOL_NAMES = ['line', 'polyline', 'rect', 'circle', 'arc', 'text', 'dim', 'move', 'copy', 'rotate', 'scale', 'mirror', 'offset', 'erase', 'trim', 'extend'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Crea una herramienta por nombre. `opts` extra (mode, kind, copy, once, distance…) según la herramienta; ver cada clase. */
export function createTool(name: ToolName, drawing: Drawing, opts: ToolOptions & Record<string, unknown> = {}): Tool {
  switch (name) {
    case 'line': return new LineTool(drawing, opts as never);
    case 'polyline': return new PolyTool(drawing, opts as never);
    case 'rect': return new RectTool(drawing, opts as never);
    case 'circle': return new CircleTool(drawing, opts as never);
    case 'arc': return new ArcTool(drawing, opts as never);
    case 'text': return new TextTool(drawing, opts as never);
    case 'dim': return new DimTool(drawing, opts as never);
    case 'move': return new MoveTool(drawing, opts as never);
    case 'copy': return new CopyTool(drawing, opts as never);
    case 'rotate': return new RotateTool(drawing, opts as never);
    case 'scale': return new ScaleTool(drawing, opts as never);
    case 'mirror': return new MirrorTool(drawing, opts as never);
    case 'offset': return new OffsetTool(drawing, opts as never);
    case 'erase': return new EraseTool(drawing, opts as never);
    case 'trim': return new TrimExtendTool(drawing, { ...opts, mode: 'trim' } as never);
    case 'extend': return new TrimExtendTool(drawing, { ...opts, mode: 'extend' } as never);
  }
}
