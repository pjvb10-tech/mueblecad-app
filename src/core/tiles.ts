/**
 * Estimación de losas (cerámica / porcelanato) para pisos y muros: módulo puro, sin acceso a archivos ni red.
 * Coloca una grilla de piezas con junta sobre cada región (rectángulos u×y), recorta las piezas de borde y empaqueta
 * los recortes dentro de losas enteras con cortes de guillotina (kerf), como en la lista de cortes de planchas.
 * Unidades: mm. u = x (largo del muro o del piso), y = z (piso) o altura (muro).
 */
import type { FloorPlan } from './types';
import { roomFloorRects } from './floor';
import { claddingRects, faceOpenings, resolveSurface, roomWallFaces } from './finish';
import type { RoomFinish, Side, SurfaceFinish, TextureItem } from './finish';

const EPS = 1e-6;

export interface TileRect { u0: number; u1: number; y0: number; y1: number }
export interface TileRegion { name: string; rects: TileRect[]; /** Origen de la grilla (esquina de la primera pieza). */ ou: number; ov: number }

interface Piece { w: number; h: number; a: number; rect: boolean; region?: string }
interface Layout { full: number; parts: Piece[]; thin: number; cover: number }

/** Piezas de una región: celdas de la grilla (con junta) intersectadas con la región; las filas pares/impares se desfasan medio paso si `stagger`. */
export function layoutPieces(region: TileRect[], tw: number, th: number, ou: number, ov: number, joint: number, minSide: number, stagger = false): Layout {
  const pw = tw + joint, ph = th + joint;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const r of region) { minU = Math.min(minU, r.u0); maxU = Math.max(maxU, r.u1); minV = Math.min(minV, r.y0); maxV = Math.max(maxV, r.y1); }
  const out: Layout = { full: 0, parts: [], thin: 0, cover: 0 };
  if (!region.length) return out;
  const k0 = Math.ceil((minV - ov - th) / ph), k1 = Math.floor((maxV - ov) / ph);
  for (let k = k0; k <= k1; k++) {
    const shift = stagger && ((k % 2) + 2) % 2 === 1 ? pw / 2 : 0;
    const i0 = Math.ceil((minU - ou - shift - tw) / pw), i1 = Math.floor((maxU - ou - shift) / pw);
    for (let i = i0; i <= i1; i++) {
      const cu0 = ou + shift + i * pw, cu1 = cu0 + tw, cv0 = ov + k * ph, cv1 = cv0 + th;
      const ps: { u0: number; u1: number; v0: number; v1: number }[] = [];
      for (const r of region) {
        const u0 = Math.max(cu0, r.u0), u1 = Math.min(cu1, r.u1), v0 = Math.max(cv0, r.y0), v1 = Math.min(cv1, r.y1);
        if (u1 - u0 > 0.5 && v1 - v0 > 0.5) ps.push({ u0, u1, v0, v1 });
      }
      if (!ps.length) continue;
      // trozos de la misma celda que se tocan forman una sola pieza recortada
      const par = ps.map((_, n) => n);
      const find = (n: number): number => (par[n] === n ? n : (par[n] = find(par[n])));
      for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
        const A = ps[a], B = ps[b];
        const ovU = Math.min(A.u1, B.u1) - Math.max(A.u0, B.u0), ovV = Math.min(A.v1, B.v1) - Math.max(A.v0, B.v0);
        if ((Math.abs(A.u1 - B.u0) < 0.5 || Math.abs(B.u1 - A.u0) < 0.5) && ovV > 0.5) par[find(a)] = find(b);
        else if ((Math.abs(A.v1 - B.v0) < 0.5 || Math.abs(B.v1 - A.v0) < 0.5) && ovU > 0.5) par[find(a)] = find(b);
      }
      const comps = new Map<number, typeof ps>();
      ps.forEach((p, n) => { const g = find(n); (comps.get(g) ?? comps.set(g, []).get(g)!).push(p); });
      for (const c of comps.values()) {
        const u0 = Math.min(...c.map((p) => p.u0)), u1 = Math.max(...c.map((p) => p.u1)), v0 = Math.min(...c.map((p) => p.v0)), v1 = Math.max(...c.map((p) => p.v1));
        const a = c.reduce((s, p) => s + (p.u1 - p.u0) * (p.v1 - p.v0), 0);
        const w = u1 - u0, h = v1 - v0;
        out.cover += a;
        if (Math.abs(a - tw * th) < 1) { out.full++; continue; }
        if (Math.min(w, h) < minSide) out.thin++;
        out.parts.push({ w, h, a, rect: Math.abs(a - w * h) < 1 });
      }
    }
  }
  return out;
}

// ---------- Empaquetado guillotina con kerf ----------
interface Free { x: number; y: number; W: number; H: number }
interface Slab { free: Free[]; placed: { id: number; x: number; y: number; w: number; h: number; rot: boolean; a: number }[] }
type FitName = 'BAF' | 'BSSF' | 'BLSF';
type SortName = 'area' | 'maxside' | 'h' | 'w';
type RuleName = 'H' | 'V' | 'maxA' | 'minA';
const FIT: Record<FitName, (W: number, H: number, w: number, h: number) => [number, number]> = {
  BAF: (W, H, w, h) => [W * H - w * h, Math.min(W - w, H - h)],
  BSSF: (W, H, w, h) => [Math.min(W - w, H - h), Math.max(W - w, H - h)],
  BLSF: (W, H, w, h) => [Math.max(W - w, H - h), Math.min(W - w, H - h)],
};
const SORT: Record<SortName, (a: Piece, b: Piece) => number> = {
  area: (a, b) => b.w * b.h - a.w * a.h || b.h - a.h,
  maxside: (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h,
  h: (a, b) => b.h - a.h || b.w - a.w,
  w: (a, b) => b.w - a.w || b.h - a.h,
};

function splitFree(F: Free, w: number, h: number, k: number, rule: RuleName): Free[] {
  const { x, y, W, H } = F;
  const rw = W - w > k + EPS ? W - w - k : 0;
  const bh = H - h > k + EPS ? H - h - k : 0;
  let horizFirst: boolean;
  if (rule === 'H') horizFirst = true;
  else if (rule === 'V') horizFirst = false;
  else {
    const aH = Math.max(rw * h, W * bh), aV = Math.max(rw * H, w * bh);
    horizFirst = rule === 'maxA' ? aH >= aV : aH <= aV;
  }
  const out: Free[] = [];
  if (horizFirst) { if (rw > 0) out.push({ x: x + w + k, y, W: rw, H: h }); if (bh > 0) out.push({ x, y: y + h + k, W, H: bh }); }
  else { if (rw > 0) out.push({ x: x + w + k, y, W: rw, H }); if (bh > 0) out.push({ x, y: y + h + k, W: w, H: bh }); }
  return out;
}

function packOnce(pieces: Piece[], SW: number, SH: number, k: number, rotate: boolean, fit: FitName, sort: SortName, rule: RuleName): Slab[] | null {
  const items = pieces.map((p, id) => ({ ...p, id })).sort(SORT[sort]);
  const slabs: Slab[] = [];
  for (const p of items) {
    let best: { s: number; f: number; w: number; h: number; rot: boolean; sc: [number, number] } | null = null;
    const opts: [number, number, boolean][] = rotate ? [[p.w, p.h, false], [p.h, p.w, true]] : [[p.w, p.h, false]];
    for (let s = 0; s < slabs.length; s++) for (let f = 0; f < slabs[s].free.length; f++) {
      const F = slabs[s].free[f];
      for (const [w, h, rot] of opts) {
        if (w > F.W + EPS || h > F.H + EPS) continue;
        const sc = FIT[fit](F.W, F.H, w, h);
        if (!best || sc[0] < best.sc[0] - EPS || (Math.abs(sc[0] - best.sc[0]) <= EPS && sc[1] < best.sc[1])) best = { s, f, w, h, rot, sc };
      }
    }
    if (!best) {
      let fits: { w: number; h: number; rot: boolean } | null = null;
      for (const [w, h, rot] of opts) if (w <= SW + EPS && h <= SH + EPS) { fits = { w, h, rot }; break; }
      if (!fits) return null;
      slabs.push({ free: [{ x: 0, y: 0, W: SW, H: SH }], placed: [] });
      best = { s: slabs.length - 1, f: 0, ...fits, sc: [0, 0] };
    }
    const slab = slabs[best.s];
    const F = slab.free.splice(best.f, 1)[0];
    slab.placed.push({ id: p.id, x: F.x, y: F.y, w: best.w, h: best.h, rot: best.rot, a: p.a });
    slab.free.push(...splitFree(F, best.w, best.h, k, rule));
  }
  return slabs;
}

/** Prueba varias heurísticas y se queda con la que usa menos losas. */
export function packBest(pieces: Piece[], SW: number, SH: number, k: number, rotate: boolean, full = true): { slabs: Slab[]; n: number; how: string } | null {
  if (!pieces.length) return { slabs: [], n: 0, how: '-' };
  let best: { slabs: Slab[]; n: number; how: string } | null = null;
  const fits = (full ? ['BAF', 'BSSF', 'BLSF'] : ['BAF', 'BSSF']) as FitName[];
  const sorts = (full ? ['area', 'maxside', 'h', 'w'] : ['area', 'maxside']) as SortName[];
  const rules = (full ? ['H', 'V', 'maxA', 'minA'] : ['H', 'V']) as RuleName[];
  for (const f of fits) for (const s of sorts) for (const r of rules) {
    const res = packOnce(pieces, SW, SH, k, rotate, f, s, r);
    if (res && (!best || res.length < best.slabs.length)) best = { slabs: res, n: res.length, how: `${f}/${s}/${r}` };
  }
  return best;
}

/** Comprobación independiente: todo dentro de la losa, separado al menos un kerf y sin perder piezas. Lanza si algo falla. */
export function verifyPacking(slabs: Slab[], SW: number, SH: number, k: number, nPieces: number): true {
  let count = 0;
  for (const s of slabs) {
    for (const p of s.placed) {
      if (p.x < -EPS || p.y < -EPS || p.x + p.w > SW + 1e-3 || p.y + p.h > SH + 1e-3) throw new Error('pieza fuera de la losa');
      count++;
    }
    for (let a = 0; a < s.placed.length; a++) for (let b = a + 1; b < s.placed.length; b++) {
      const A = s.placed[a], B = s.placed[b];
      const gx = Math.max(B.x - (A.x + A.w), A.x - (B.x + B.w)), gy = Math.max(B.y - (A.y + A.h), A.y - (B.y + B.h));
      if (Math.max(gx, gy) < k - 1e-6) throw new Error('piezas a menos de un kerf');
    }
  }
  if (count !== nPieces) throw new Error(`piezas colocadas ${count} != ${nPieces}`);
  return true;
}

// ---------- Estimación ----------
export interface TileOptions {
  /** Tamaño de la pieza (mm) sin la junta. */
  w: number; h: number;
  /** Ancho de la junta (mm). */
  junta: number;
  /** Colocación: trabado = cada fila desfasada medio paso. */
  patron?: 'recto' | 'trabado';
  /** Ancho del corte de la sierra (mm). 3 por omisión. */
  kerf?: number;
  /** Lado mínimo de una pieza recortada (mm); más angosta es difícil de cortar. Solo se evita al optimizar. 50 por omisión. */
  minSide?: number;
  /** Permite girar 90° los recortes dentro de la losa (no usar con veta o dibujo direccional). */
  girar?: boolean;
  /** Barre desfases de la grilla para usar menos losas. */
  optimizar?: boolean;
  /** Pérdida extra por roturas (% de las losas, redondeando hacia arriba). */
  reservaPct?: number;
}

export interface TileEstimate {
  /** Superficie cubierta (m²). */
  areaM2: number;
  /** Superficie de una pieza (m²). */
  piezaM2: number;
  /** Piezas enteras colocadas, piezas recortadas y losas necesarias para obtener los recortes. */
  enteras: number; recortes: number; losasParaRecortes: number;
  /** Total de losas a comprar, sin reserva y con ella. */
  total: number; totalConReserva: number;
  /** Desperdicio sobre lo comprado (%), sin reserva. */
  perdidaPct: number;
  /** Cota inferior teórica (área cubierta / área de pieza). */
  minimoTeorico: number;
  desfase: { u: number; v: number };
  regiones: { nombre: string; areaM2: number; enteras: number; recortes: number }[];
  avisos: string[];
}

interface Eval { full: number; parts: Piece[]; total: number; cut: number; cover: number; thin: number; regs: { nombre: string; full: number; recortes: number; cover: number }[] }

function evaluate(regions: TileRegion[], o: Required<Pick<TileOptions, 'w' | 'h' | 'junta' | 'kerf' | 'minSide'>> & { stagger: boolean; rotate: boolean }, du: number, dv: number, fullPack: boolean): Eval | null {
  let full = 0, cover = 0, thin = 0;
  const parts: Piece[] = [];
  const regs: Eval['regs'] = [];
  for (const R of regions) {
    const L = layoutPieces(R.rects, o.w, o.h, R.ou + du, R.ov + dv, o.junta, o.minSide, o.stagger);
    full += L.full; cover += L.cover; thin += L.thin;
    for (const p of L.parts) parts.push({ ...p, region: R.name });
    regs.push({ nombre: R.name, full: L.full, recortes: L.parts.length, cover: L.cover });
  }
  const pk = packBest(parts, o.w, o.h, o.kerf, o.rotate, fullPack);
  if (!pk) return null;
  verifyPacking(pk.slabs, o.w, o.h, o.kerf, parts.length);
  return { full, parts, total: full + pk.n, cut: pk.n, cover, thin, regs };
}

/** Estima cuántas losas hacen falta para cubrir las regiones. Lanza si una pieza recortada no cabe en la losa. */
export function estimateTiles(regions: TileRegion[], opts: TileOptions): TileEstimate {
  const w = opts.w, h = opts.h, junta = opts.junta;
  if (!(w >= 20 && h >= 20)) throw new Error('El tamaño de la pieza debe ser de al menos 20 mm.');
  const o = { w, h, junta, kerf: opts.kerf ?? 3, minSide: opts.minSide ?? 50, stagger: opts.patron === 'trabado', rotate: !!opts.girar };
  const avisos: string[] = [];
  const pitchU = w + junta, pitchV = h + junta;
  let du = 0, dv = 0;
  let ev: Eval | null;
  if (opts.optimizar) {
    const stepU = Math.max(25, Math.round(pitchU / 12)), stepV = Math.max(25, Math.round(pitchV / 12));
    const span = o.stagger ? pitchU * 2 : pitchU;
    const cands: { du: number; dv: number; e: Eval }[] = [];
    for (let a = 0; a < span - EPS; a += stepU) for (let b = 0; b < pitchV - EPS; b += stepV) {
      const e = evaluate(regions, o, a, b, false);
      if (e) cands.push({ du: a, dv: b, e });
    }
    if (!cands.length) throw new Error('Ninguna colocación es posible: alguna pieza recortada no cabe en una losa.');
    const rank = (c: { e: Eval }) => c.e.total * 1e6 + c.e.thin * 1e3 + c.e.parts.length;
    cands.sort((p, q) => rank(p) - rank(q));
    let best: { du: number; dv: number; e: Eval } | null = null;
    for (const c of cands.slice(0, 8)) {
      const e = evaluate(regions, o, c.du, c.dv, true);
      if (e && (!best || e.total < best.e.total || (e.total === best.e.total && e.thin < best.e.thin))) best = { du: c.du, dv: c.dv, e };
    }
    if (!best) throw new Error('No se pudo empaquetar ninguna colocación.');
    ({ du, dv } = best);
    ev = best.e;
  } else {
    ev = evaluate(regions, o, 0, 0, true);
    if (!ev) throw new Error('Una pieza recortada no cabe en una losa entera; revisa el tamaño de la pieza.');
  }
  if (ev.thin > 0) avisos.push(`${ev.thin} recorte(s) con un lado menor de ${o.minSide} mm (difíciles de cortar); prueba optimizar=true o cambia el desfase.`);
  const tileA = w * h;
  const areaM2 = ev.cover / 1e6;
  const total = ev.total;
  const reserva = Math.max(0, opts.reservaPct ?? 0);
  const totalConReserva = reserva > 0 ? Math.ceil(total * (1 + reserva / 100) - 1e-9) : total;
  if (junta > 0) avisos.push('Las áreas contadas son de pieza más junta: la junta se considera parte del revestimiento y no consume losa.');
  return {
    areaM2: round(areaM2, 3), piezaM2: round(tileA / 1e6, 4),
    enteras: ev.full, recortes: ev.parts.length, losasParaRecortes: ev.cut,
    total, totalConReserva,
    perdidaPct: total ? round((1 - ev.cover / (total * tileA)) * 100, 1) : 0,
    minimoTeorico: Math.ceil(ev.cover / tileA - 1e-9),
    desfase: { u: du, v: dv },
    regiones: ev.regs.map((r) => ({ nombre: r.nombre, areaM2: round(r.cover / 1e6, 3), enteras: r.full, recortes: r.recortes })),
    avisos,
  };
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// ---------- Regiones de una habitación ----------
export type TileSurface = 'floor' | 'walls' | 'both';

export interface RoomTileRequest {
  surface: TileSurface;
  /** Altura del revestimiento de muros desde el piso (mm); sin ella, la del acabado o hasta el cielo. */
  altura?: number;
  /** Solo estos muros (norte/sur/este/oeste); por omisión todos. */
  lados?: Side[];
}

/** Regiones (piso y/o caras de muro sin vanos) que ocupa una habitación. Lanza si la habitación no existe o no tiene geometría. */
export function roomTileRegions(plan: FloorPlan, roomId: string, req: RoomTileRequest): TileRegion[] {
  if (!plan.rooms?.some((r) => r.id === roomId)) throw new Error(`No existe la habitación ${roomId}.`);
  const regions: TileRegion[] = [];
  if (req.surface !== 'walls') {
    const rects = roomFloorRects(plan, roomId);
    if (!rects.length) throw new Error(`${roomId}: no se pudo calcular el piso (¿el plano tiene muros?).`);
    const ou = Math.min(...rects.map((r) => r.x0)), ov = Math.min(...rects.map((r) => r.z0));
    regions.push({ name: 'piso', rects: rects.map((r) => ({ u0: r.x0, u1: r.x1, y0: r.z0, y1: r.z1 })), ou, ov });
  }
  if (req.surface !== 'floor') {
    const H = req.altura ?? plan.panelH ?? 2440;
    const faces = roomWallFaces(plan, roomId).filter((f) => !req.lados || req.lados.includes(f.side));
    for (const f of faces) {
      const spans = claddingRects(f.a0, f.a1, Math.min(plan.panelH ?? 2440, H), faceOpenings(plan, f));
      if (spans.length) regions.push({ name: `muro ${f.side} (${Math.round(f.a0)}–${Math.round(f.a1)})`, rects: spans.map((s) => ({ u0: s.u0, u1: s.u1, y0: s.y0, y1: s.y1 })), ou: f.a0, ov: 0 });
    }
    if (req.surface === 'walls' && !regions.length) throw new Error(`${roomId}: no hay muros que revestir con esos filtros.`);
  }
  return regions;
}

/** Superficie con la que se estima: textura del catálogo + ajustes. `base` = acabado asignado a la habitación (si existe). */
export function resolveTileSpec(catalog: TextureItem[], texId: string | undefined, rf: RoomFinish | undefined, surface: TileSurface, over: Partial<SurfaceFinish>) {
  if (surface === 'both' && !texId && rf?.floor?.tex !== rf?.walls?.tex) throw new Error('Para piso y muros a la vez indica la textura (texture): el piso y los muros tienen acabados distintos.');
  const assigned: SurfaceFinish | undefined | null = surface === 'walls' ? (rf?.walls?.tex ? rf.walls : null) : rf?.floor;
  const tex = texId ?? assigned?.tex;
  if (!tex) throw new Error('Indica una textura (texture) o asigna antes un acabado a esa superficie.');
  const sf: SurfaceFinish = { ...(assigned && assigned.tex === tex ? assigned : { tex }), ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)), tex };
  const r = resolveSurface(sf, catalog);
  if (!r) throw new Error(`La textura "${tex}" no está en la biblioteca.`);
  return r;
}
