import type { FloorPlan, Project } from './types';
import { isTextureName, roomFloorRects, roomRaster } from './floor';
import type { FloorRect } from './floor';

/** Categorías de la biblioteca de texturas. */
export const CATEGORIES = ['ceramica', 'porcelanato', 'madera', 'pintura', 'otro'] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = { ceramica: 'Cerámica', porcelanato: 'Porcelanato', madera: 'Madera', pintura: 'Pintura / color liso', otro: 'Otro' };

/** Entrada de la biblioteca (texturas/catalogo.json): una imagen de baldosa o un color liso, con su formato y junta por omisión. */
export interface TextureItem {
  id: string;
  nombre: string;
  categoria: Category;
  /** Archivo en la carpeta texturas/ (imagen de una baldosa); falta si es color liso. */
  archivo?: string;
  /** Color liso (#rrggbb), si no hay imagen. */
  color?: string;
  /** Ancho y alto de la baldosa/pieza (mm). */
  w: number;
  h: number;
  /** Ancho de la junta (mm) y su color. */
  junta: number;
  colorJunta: string;
  /** Giro de la imagen dentro de la baldosa (veta): 0 o 90°. */
  veta: 0 | 90;
  /** Colocación: recto (juntas continuas) o trabado (cada fila desfasada 50 %). */
  patron: 'recto' | 'trabado';
}

/** Acabado de una superficie: textura de la biblioteca más ajustes que reemplazan los valores de la textura. */
export interface SurfaceFinish {
  tex: string;
  w?: number; h?: number; junta?: number; colorJunta?: string; veta?: 0 | 90; patron?: 'recto' | 'trabado';
  /** Desplazamiento de la baldosa (mm) para alinear las juntas. */
  dx?: number; dy?: number;
  /** Solo muros: altura del revestimiento desde el piso (mm); sin ella, hasta el cielo (alto del panel). */
  altura?: number;
}
export type Side = 'norte' | 'sur' | 'este' | 'oeste';
export const SIDES: Side[] = ['norte', 'sur', 'este', 'oeste'];
export interface WallsFinish extends SurfaceFinish {
  /** Muros distintos del general (tex '' = sin revestir ese lado). */
  lados?: Partial<Record<Side, SurfaceFinish>>;
}
export interface RoomFinish { floor?: SurfaceFinish; walls?: WallsFinish }

export const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

/** Lee el catálogo (objeto {items} o lista) descartando entradas inválidas y corrigiendo valores fuera de rango. */
export function parseCatalog(raw: unknown): TextureItem[] {
  const list: unknown[] = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : [];
  const out: TextureItem[] = [];
  const seen = new Set<string>();
  for (const q of list) {
    const o = q as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !ID.test(o.id) || seen.has(o.id)) continue;
    const archivo = isTextureName(o.archivo) ? o.archivo : undefined;
    const color = typeof o.color === 'string' && HEX.test(o.color) ? o.color : undefined;
    if (!archivo && !color) continue;
    seen.add(o.id);
    out.push({
      id: o.id,
      nombre: typeof o.nombre === 'string' && o.nombre.trim() ? o.nombre.trim().slice(0, 80) : o.id,
      categoria: (CATEGORIES as readonly unknown[]).includes(o.categoria) ? (o.categoria as Category) : 'otro',
      ...(archivo ? { archivo } : { color }),
      w: clamp(o.w, 20, 3000, 600), h: clamp(o.h, 20, 3000, 600),
      junta: clamp(o.junta, 0, 30, 3),
      colorJunta: typeof o.colorJunta === 'string' && HEX.test(o.colorJunta) ? o.colorJunta : '#c9c7c1',
      veta: o.veta === 90 ? 90 : 0,
      patron: o.patron === 'trabado' ? 'trabado' : 'recto',
    });
  }
  return out;
}

/**
 * Acabados vigentes: `project.finishes` y, para las habitaciones que no tienen entrada ahí, el antiguo
 * `project.roomFloors` (imagen + lado de baldosa). Si la imagen no está en el catálogo se agrega una textura virtual.
 * No modifica el proyecto.
 */
export function effectiveFinishes(project: Pick<Project, 'finishes' | 'roomFloors'>, catalog: TextureItem[]): { finishes: Record<string, RoomFinish>; catalog: TextureItem[] } {
  const finishes: Record<string, RoomFinish> = { ...(project.finishes ?? {}) };
  const cat = [...catalog];
  for (const [id, f] of Object.entries(project.roomFloors ?? {})) {
    if (finishes[id] || !f || !isTextureName(f.image)) continue;
    const tile = clamp(f.tile, 50, 3000, 600);
    let it = cat.find((c) => c.archivo === f.image);
    if (!it) {
      it = { id: `legacy-${f.image.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 30)}`, nombre: f.image, categoria: 'ceramica', archivo: f.image, w: tile, h: tile, junta: 3, colorJunta: '#c9c7c1', veta: 0, patron: 'recto' };
      cat.push(it);
    }
    finishes[id] = { floor: it.w === tile && it.h === tile ? { tex: it.id } : { tex: it.id, w: tile, h: tile } };
  }
  return { finishes, catalog: cat };
}

/** Pasa `roomFloors` a `finishes` dentro del proyecto (y lo borra). Devuelve true si cambió algo. */
export function migrateRoomFloors(project: Project, catalog: TextureItem[]): boolean {
  if (!project.roomFloors) return false;
  const { finishes } = effectiveFinishes(project, catalog);
  project.finishes = { ...(project.finishes ?? {}) };
  for (const [id, f] of Object.entries(finishes)) if (!project.finishes[id]) project.finishes[id] = f;
  delete project.roomFloors;
  return true;
}

/** Superficie con todos los valores resueltos (textura + ajustes). */
export interface Resolved {
  key: string;
  archivo?: string; color?: string;
  w: number; h: number; junta: number; colorJunta: string; veta: 0 | 90; patron: 'recto' | 'trabado'; dx: number; dy: number;
  altura?: number;
}

export function resolveSurface(sf: SurfaceFinish | undefined | null, catalog: TextureItem[]): Resolved | null {
  if (!sf || !sf.tex) return null;
  const it = catalog.find((c) => c.id === sf.tex);
  if (!it) return null;
  const r = {
    archivo: it.archivo, color: it.color,
    w: clamp(sf.w, 20, 3000, it.w), h: clamp(sf.h, 20, 3000, it.h),
    junta: clamp(sf.junta, 0, 30, it.junta),
    colorJunta: typeof sf.colorJunta === 'string' && HEX.test(sf.colorJunta) ? sf.colorJunta : it.colorJunta,
    veta: sf.veta === 90 ? 90 as const : sf.veta === 0 ? 0 as const : it.veta,
    patron: sf.patron === 'trabado' || sf.patron === 'recto' ? sf.patron : it.patron,
    dx: clamp(sf.dx, -100000, 100000, 0), dy: clamp(sf.dy, -100000, 100000, 0),
  };
  const altura = typeof sf.altura === 'number' && sf.altura >= 100 ? sf.altura : undefined;
  // la clave solo incluye lo que define el aspecto del material (no la altura ni el desplazamiento), para fusionar geometrías iguales
  return { key: JSON.stringify([r.archivo ?? r.color, r.w, r.h, r.junta, r.colorJunta, r.veta, r.patron]), ...r, altura };
}

/** Período repetido del patrón (mm): una baldosa en recto; dos filas en trabado. */
export const patternPeriod = (r: Pick<Resolved, 'w' | 'h' | 'patron'>) => ({ pw: r.w, ph: r.patron === 'trabado' ? r.h * 2 : r.h });

// ---------- Muros ----------

export interface WallFace {
  /** Eje que queda fijo: 'z' = muro horizontal en el plano (cara norte/sur), 'x' = muro vertical (cara este/oeste). */
  axis: 'x' | 'z';
  /** Coordenada fija (mm) de la cara y rango a lo largo de ella. */
  c: number; a0: number; a1: number;
  /** Sentido hacia el interior de la habitación (+1 / -1 sobre el eje fijo). */
  n: 1 | -1;
  side: Side;
}

/** Caras interiores de los muros que rodean una habitación (borde del hueco real), ajustadas al canto del panel. */
export function roomWallFaces(plan: FloorPlan, roomId: string): WallFace[] {
  const ras = roomRaster(plan, roomId);
  if (!ras) return [];
  const { g, nx, nz, X0, Z0, cs } = ras;
  const floor = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < nz && g[j * nx + i] === 2;
  const out: WallFace[] = [];
  const walls = plan.walls ?? [];
  // canto real del panel más cercano a la cara de la cuadrícula
  const snap = (axis: 'x' | 'z', c: number, a0: number, a1: number, n: 1 | -1) => {
    let best = c, bd = cs + 0.5;
    for (const w of walls) {
      const lo = axis === 'z' ? w.x0 : w.z0, hi = axis === 'z' ? w.x1 : w.z1;
      if (Math.min(hi, a1) - Math.max(lo, a0) <= 0) continue;
      const e = axis === 'z' ? (n === 1 ? w.z1 : w.z0) : (n === 1 ? w.x1 : w.x0);
      if (Math.abs(e - c) < bd) { bd = Math.abs(e - c); best = e; }
    }
    return best;
  };
  const push = (axis: 'x' | 'z', c: number, a0: number, a1: number, n: 1 | -1) => {
    const side: Side = axis === 'z' ? (n === 1 ? 'norte' : 'sur') : (n === 1 ? 'oeste' : 'este');
    out.push({ axis, c: snap(axis, c, a0, a1, n), a0, a1, n, side });
  };
  // caras horizontales (entre filas) y verticales (entre columnas); se funden los tramos continuos
  for (let j = 0; j <= nz; j++) {
    for (const n of [1, -1] as const) {
      let start = -1;
      for (let i = 0; i <= nx; i++) {
        const on = floor(i, n === 1 ? j : j - 1) && !floor(i, n === 1 ? j - 1 : j);
        if (on && start < 0) start = i;
        if (!on && start >= 0) { push('z', Z0 + j * cs, X0 + start * cs, X0 + i * cs, n); start = -1; }
      }
    }
  }
  for (let i = 0; i <= nx; i++) {
    for (const n of [1, -1] as const) {
      let start = -1;
      for (let j = 0; j <= nz; j++) {
        const on = floor(n === 1 ? i : i - 1, j) && !floor(n === 1 ? i - 1 : i, j);
        if (on && start < 0) start = j;
        if (!on && start >= 0) { push('x', X0 + i * cs, Z0 + start * cs, Z0 + j * cs, n); start = -1; }
      }
    }
  }
  return out;
}

export interface Span { u0: number; u1: number; y0: number; y1: number }

/**
 * Rectángulos del revestimiento de una cara: franja [a0,a1] × [0,H] menos los vanos (que la cruzan en `ops`).
 * Parte la cara en columnas por los bordes de los vanos y fusiona las contiguas iguales: queda encima, debajo y a los lados.
 */
export function claddingRects(a0: number, a1: number, H: number, ops: Span[]): Span[] {
  const clip = ops.map((o) => ({ u0: Math.max(a0, o.u0), u1: Math.min(a1, o.u1), y0: Math.max(0, o.y0), y1: Math.min(H, o.y1) })).filter((o) => o.u1 - o.u0 > 0.5 && o.y1 - o.y0 > 0.5);
  const cuts = [...new Set([a0, a1, ...clip.flatMap((o) => [o.u0, o.u1])])].sort((p, q) => p - q);
  const out: Span[] = [];
  let open: Span[] = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const u0 = cuts[k], u1 = cuts[k + 1];
    if (u1 - u0 < 0.5) continue;
    const mid = (u0 + u1) / 2;
    const blocked = clip.filter((o) => o.u0 < mid && o.u1 > mid).sort((p, q) => p.y0 - q.y0);
    const free: [number, number][] = [];
    let y = 0;
    for (const b of blocked) { if (b.y0 > y + 0.5) free.push([y, b.y0]); y = Math.max(y, b.y1); }
    if (y < H - 0.5) free.push([y, H]);
    const next: Span[] = [];
    for (const [y0, y1] of free) {
      const prev = open.find((s) => s.y0 === y0 && s.y1 === y1 && Math.abs(s.u1 - u0) < 0.01);
      if (prev) { prev.u1 = u1; next.push(prev); } else { const s = { u0, u1, y0, y1 }; out.push(s); next.push(s); }
    }
    open = next;
  }
  return out;
}

/** Vanos (puertas, ventanas, por confirmar) que cruzan una cara, como rangos a lo largo de la cara y en altura. */
export function faceOpenings(plan: FloorPlan, f: WallFace): Span[] {
  const out: Span[] = [];
  for (const o of plan.openings ?? []) {
    const horiz = Math.abs(o.z1 - o.z2) < 1, vert = Math.abs(o.x1 - o.x2) < 1;
    if (f.axis === 'z' ? !horiz : !vert) continue;
    const fixed = f.axis === 'z' ? (o.z1 + o.z2) / 2 : (o.x1 + o.x2) / 2;
    if (Math.abs(fixed - f.c) > 100) continue;
    const u0 = f.axis === 'z' ? Math.min(o.x1, o.x2) : Math.min(o.z1, o.z2), u1 = f.axis === 'z' ? Math.max(o.x1, o.x2) : Math.max(o.z1, o.z2);
    if (Math.min(u1, f.a1) - Math.max(u0, f.a0) <= 0) continue;
    out.push({ u0, u1, y0: o.y, y1: o.y + o.h });
  }
  return out;
}

/** Geometría plana: posiciones, normales y UV (en baldosas, con el patrón ya repetido). */
export interface QuadSet { pos: number[]; nrm: number[]; uv: number[] }
export const emptyQuads = (): QuadSet => ({ pos: [], nrm: [], uv: [] });

/** Retranqueo (mm) del revestimiento hacia el interior para evitar parpadeo con la cara del panel. */
export const CLAD_OFFSET = 1.5;
/** Altura (mm) del piso acabado sobre el nivel 0. */
export const FLOOR_Y = 1;

/** Piso: un cuadrilátero por rectángulo, UV = mm reales / período del patrón. */
export function floorQuads(rects: FloorRect[], r: Resolved, out: QuadSet = emptyQuads()): QuadSet {
  const { pw, ph } = patternPeriod(r);
  for (const q of rects) {
    const p = [[q.x0, q.z0], [q.x1, q.z0], [q.x1, q.z1], [q.x0, q.z1]];
    for (const k of [0, 3, 2, 0, 2, 1]) {
      out.pos.push(p[k][0], FLOOR_Y, p[k][1]);
      out.nrm.push(0, 1, 0);
      out.uv.push((p[k][0] - r.dx) / pw, (p[k][1] - r.dy) / ph);
    }
  }
  return out;
}

/** Muros: rectángulos de una cara (a lo largo de `a`, en altura `y`) con UV = mm reales / período, normal hacia la habitación. */
export function wallQuads(f: WallFace, spans: Span[], r: Resolved, out: QuadSet = emptyQuads()): QuadSet {
  const { pw, ph } = patternPeriod(r);
  // con la tangente creciente, la normal geométrica de (a0,y0)(a1,y0)(a1,y1) es +z en caras 'z' y -x en caras 'x'
  const geo = f.axis === 'z' ? 1 : -1;
  const flip = geo !== f.n;
  const off = f.c + f.n * CLAD_OFFSET;
  const pt = (a: number, y: number): [number, number, number] => (f.axis === 'z' ? [a, y, off] : [off, y, a]);
  const nrm = f.axis === 'z' ? [0, 0, f.n] : [f.n, 0, 0];
  for (const s of spans) {
    const c = [[s.u0, s.y0], [s.u1, s.y0], [s.u1, s.y1], [s.u0, s.y1]];
    const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    for (const k of order) {
      out.pos.push(...pt(c[k][0], c[k][1]));
      out.nrm.push(...nrm);
      out.uv.push((c[k][0] - r.dx) / pw, (c[k][1] - r.dy) / ph);
    }
  }
  return out;
}

/** Superficie de muros que corresponde a un lado de la habitación (general o específica). */
export function wallSurface(rf: RoomFinish | undefined, side: Side): SurfaceFinish | null {
  const w = rf?.walls;
  if (!w) return null;
  const s = w.lados?.[side];
  if (s) return s.tex ? { ...s, altura: s.altura ?? w.altura } : null;
  return w.tex ? w : null;
}

export type Buckets = Map<string, { r: Resolved; q: QuadSet }>;
const bucket = (b: Buckets, r: Resolved) => {
  let x = b.get(r.key);
  if (!x) b.set(r.key, (x = { r, q: emptyQuads() }));
  return x.q;
};

/** Revestimiento de muros de una habitación, agrupado por material (clave de la superficie resuelta). */
export function roomWallGeometry(plan: FloorPlan, roomId: string, rf: RoomFinish | undefined, catalog: TextureItem[], buckets: Buckets) {
  if (!rf?.walls) return;
  const panelH = plan.panelH ?? 2440;
  for (const f of roomWallFaces(plan, roomId)) {
    const r = resolveSurface(wallSurface(rf, f.side), catalog);
    if (!r) continue;
    const spans = claddingRects(f.a0, f.a1, Math.min(panelH, r.altura ?? panelH), faceOpenings(plan, f));
    if (spans.length) wallQuads(f, spans, r, bucket(buckets, r));
  }
}

/** Piso de una habitación, agrupado por material. */
export function roomFloorGeometry(plan: FloorPlan, roomId: string, rf: RoomFinish | undefined, catalog: TextureItem[], buckets: Buckets) {
  const r = resolveSurface(rf?.floor, catalog);
  if (!r) return;
  const rects = roomFloorRects(plan, roomId);
  if (rects.length) floorQuads(rects, r, bucket(buckets, r));
}
