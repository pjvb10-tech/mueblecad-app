/** Edición de acabados (project.finishes) para agentes: validación y cambios puros sobre el proyecto, con las mismas reglas que el panel «Acabados». */
import type { Project } from './types';
import { SIDES, effectiveFinishes, migrateRoomFloors, resolveSurface } from './finish';
import type { RoomFinish, Side, SurfaceFinish, TextureItem } from './finish';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Ajustes opcionales de una superficie (reemplazan los de la textura). */
export interface FinishAdjust {
  w?: number; h?: number; junta?: number; colorJunta?: string; veta?: 0 | 90; patron?: 'recto' | 'trabado'; dx?: number; dy?: number; altura?: number;
}
/** Ajuste de un muro: `texture` '' = sin revestir ese muro; omitida = conserva/copia el general; null = quita el ajuste propio (vuelve al general). */
export type SideSpec = (FinishAdjust & { texture?: string }) | null;

const range = (name: string, v: unknown, lo: number, hi: number) => {
  if (v === undefined) return;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} debe estar entre ${lo} y ${hi} (recibido: ${String(v)}).`);
};

/** Valida los ajustes numéricos y de texto; lanza con un mensaje claro. */
export function checkAdjust(a: FinishAdjust, where = ''): void {
  const p = where ? `${where}: ` : '';
  try {
    range('w', a.w, 20, 3000); range('h', a.h, 20, 3000); range('junta', a.junta, 0, 30);
    range('dx', a.dx, -100000, 100000); range('dy', a.dy, -100000, 100000); range('altura', a.altura, 100, 10000);
    if (a.colorJunta !== undefined && !HEX.test(a.colorJunta)) throw new Error('colorJunta debe ser #rrggbb.');
    if (a.veta !== undefined && a.veta !== 0 && a.veta !== 90) throw new Error('veta debe ser 0 o 90.');
    if (a.patron !== undefined && a.patron !== 'recto' && a.patron !== 'trabado') throw new Error("patron debe ser 'recto' o 'trabado'.");
  } catch (e) { throw new Error(p + (e as Error).message); }
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const checkTex = (catalog: TextureItem[], id: string) => {
  if (!catalog.some((c) => c.id === id)) throw new Error(`La textura "${id}" no está en la biblioteca. Disponibles: ${catalog.map((c) => c.id).join(', ') || '(vacía)'}.`);
};
export function checkRoom(project: Project, room: string): void {
  const rooms = project.plan?.rooms ?? [];
  if (!rooms.some((r) => r.id === room)) throw new Error(`No existe la habitación ${room}. ${rooms.length ? `Habitaciones: ${rooms.map((r) => r.id).join(', ')}.` : 'El proyecto no tiene plano con habitaciones.'}`);
}

function tidy(project: Project, room: string) {
  const rf = project.finishes?.[room];
  if (!rf) return;
  if (rf.walls) {
    if (rf.walls.lados && !Object.keys(rf.walls.lados).length) delete rf.walls.lados;
    if (!rf.walls.tex && !rf.walls.lados) delete rf.walls;
  }
  if (!rf.floor && !rf.walls) delete project.finishes![room];
  if (project.finishes && !Object.keys(project.finishes).length) delete project.finishes;
}

export interface SetFinishArgs {
  room: string;
  surface: 'floor' | 'walls';
  /** Id de textura. En muros, '' deja el muro general sin revestir (útil si solo se definen `sides`). Si falta, se ajusta el acabado ya asignado. */
  texture?: string;
  adjust?: FinishAdjust;
  /** Solo muros: acabados propios por lado. */
  sides?: Partial<Record<Side, SideSpec>>;
}

/** Asigna o ajusta el acabado de una superficie de una habitación. Devuelve un resumen. Lanza (sin tocar nada a medias) si los datos no son válidos. */
export function setFinish(project: Project, catalog: TextureItem[], a: SetFinishArgs): string {
  checkRoom(project, a.room);
  const adj = defined(a.adjust ?? {});
  checkAdjust(adj);
  if (a.surface === 'floor' && (adj.altura !== undefined || a.sides)) throw new Error('altura y sides solo aplican a surface="walls".');
  if (a.texture === undefined && !Object.keys(adj).length && !a.sides) throw new Error('No hay nada que cambiar: indica texture, ajustes o sides.');
  if (a.texture) checkTex(catalog, a.texture);
  for (const [s, v] of Object.entries(a.sides ?? {})) {
    if (!(SIDES as string[]).includes(s)) throw new Error(`Lado no válido: ${s} (usa norte, sur, este u oeste).`);
    if (v) { checkAdjust(defined(v), `sides.${s}`); if (v.texture) checkTex(catalog, v.texture); }
  }
  // todo validado: ahora sí se modifica (primero se migra el antiguo roomFloors, como hace la app)
  migrateRoomFloors(project, catalog);
  project.finishes ??= {};
  const rf: RoomFinish = (project.finishes[a.room] ??= {});
  if (a.surface === 'floor') {
    if (a.texture) rf.floor = { tex: a.texture, ...adj };
    else if (rf.floor) rf.floor = { ...rf.floor, ...adj };
    else { tidy(project, a.room); throw new Error(`${a.room} no tiene piso asignado: indica texture.`); }
  } else {
    const keep = { ...(rf.walls?.lados ? { lados: rf.walls.lados } : {}) };
    if (a.texture !== undefined) rf.walls = { tex: a.texture, ...keep, ...(rf.walls?.altura && adj.altura === undefined ? { altura: rf.walls.altura } : {}), ...adj };
    else if (rf.walls) rf.walls = { ...rf.walls, ...adj };
    else if (a.sides) rf.walls = { tex: '', ...adj };
    else { tidy(project, a.room); throw new Error(`${a.room} no tiene muros asignados: indica texture.`); }
    for (const [s, v] of Object.entries(a.sides ?? {}) as [Side, SideSpec][]) {
      const w = rf.walls;
      if (v === null) { if (w.lados) delete w.lados[s]; continue; }
      const own = w.lados?.[s];
      let next: SurfaceFinish;
      if (v.texture !== undefined) next = { tex: v.texture, ...(own?.altura && v.altura === undefined ? { altura: own.altura } : {}), ...defined({ ...v, texture: undefined }) };
      else {
        const { lados: _l, altura: _h, ...general } = w;
        next = { ...(own ?? general), ...defined({ ...v, texture: undefined }) };
      }
      (w.lados ??= {})[s] = next;
    }
  }
  tidy(project, a.room);
  const eff = effectiveFinishes(project, catalog).finishes[a.room];
  return `${a.room}: acabado actualizado. ${JSON.stringify(eff)}`;
}

/** Quita acabados de una habitación: superficie 'floor' | 'walls' | 'all' (por omisión) o un solo muro (`side`). Devuelve lo que se quitó. */
export function clearFinish(project: Project, catalog: TextureItem[], room: string, surface: 'floor' | 'walls' | 'all' = 'all', side?: Side): string {
  checkRoom(project, room);
  if (side && !(SIDES as string[]).includes(side)) throw new Error(`Lado no válido: ${side}.`);
  migrateRoomFloors(project, catalog);
  const rf = project.finishes?.[room];
  if (!rf) return `${room} no tenía acabados.`;
  let what = '';
  if (side) {
    if (rf.walls?.lados?.[side]) { delete rf.walls.lados[side]; what = `muro ${side} (vuelve al general)`; }
  } else {
    if ((surface === 'floor' || surface === 'all') && rf.floor) { delete rf.floor; what = 'piso'; }
    if ((surface === 'walls' || surface === 'all') && rf.walls) { delete rf.walls; what += `${what ? ' y ' : ''}muros`; }
  }
  tidy(project, room);
  return what ? `${room}: se quitó ${what}.` : `${room}: no había nada que quitar.`;
}

export interface FinishReport {
  room: string; name: string;
  floor?: ReportSurface; walls?: ReportSurface & { altura?: number; lados?: Record<string, ReportSurface | { sinRevestir: true }> };
}
interface ReportSurface { textura: string; nombre?: string; faltaEnBiblioteca?: true; pieza?: string; junta?: number; colorJunta?: string; veta?: number; patron?: string; desfase?: [number, number]; altura?: number }

/** Acabados vigentes (incluye los del antiguo roomFloors) con los valores ya resueltos y avisos de texturas que faltan en la biblioteca. */
export function describeFinishes(project: Project, catalog: TextureItem[]): { acabados: FinishReport[]; avisos: string[] } {
  const eff = effectiveFinishes(project, catalog);
  const avisos: string[] = [];
  const rooms = project.plan?.rooms ?? [];
  const surf = (sf: SurfaceFinish, room: string): ReportSurface => {
    const r = resolveSurface(sf, eff.catalog);
    if (!r) { avisos.push(`${room}: la textura "${sf.tex}" no está en la biblioteca (no se ve).`); return { textura: sf.tex, faltaEnBiblioteca: true }; }
    return {
      textura: sf.tex, nombre: eff.catalog.find((c) => c.id === sf.tex)?.nombre, pieza: `${r.w}x${r.h} mm`, junta: r.junta, colorJunta: r.colorJunta, veta: r.veta, patron: r.patron,
      ...(r.dx || r.dy ? { desfase: [r.dx, r.dy] as [number, number] } : {}), ...(r.altura ? { altura: r.altura } : {}),
    };
  };
  const acabados = Object.entries(eff.finishes).map(([room, f]): FinishReport => {
    const out: FinishReport = { room, name: rooms.find((r) => r.id === room)?.name ?? '' };
    if (!rooms.some((r) => r.id === room)) avisos.push(`${room}: tiene acabado pero la habitación ya no existe en el plano.`);
    if (f.floor) out.floor = surf(f.floor, room);
    if (f.walls) {
      const w = f.walls;
      out.walls = { ...(w.tex ? surf(w, room) : { textura: '' }), ...(w.altura ? { altura: w.altura } : {}) };
      if (w.lados) out.walls.lados = Object.fromEntries(Object.entries(w.lados).map(([s, v]) => [s, v!.tex ? surf(v!, `${room}/${s}`) : { sinRevestir: true as const }]));
    }
    return out;
  });
  return { acabados, avisos };
}
