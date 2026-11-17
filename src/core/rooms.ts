/** Lectura del plano de la casa para agentes: habitaciones (H#), su piso real, sus muros interiores y las aberturas (D#/V#/A#). Solo lectura. */
import type { FloorPlan, Project } from './types';
import { roomFloorRects, rectsArea } from './floor';
import { faceOpenings, roomWallFaces } from './finish';
import { openingIds } from './ids';
import { ROOF_THICKNESS, roofCells } from './roof';


const r0 = (n: number) => Math.round(n);

export interface RoomSummary {
  id: string; name: string; areaM2: number;
  caja: { x0: number; z0: number; x1: number; z1: number; ancho: number; fondo: number };
  centro: { x: number; z: number };
  conAcabado: boolean;
}

/** Habitaciones del plano con su caja y área (rápido: no rasteriza). */
export function listRooms(project: Project): RoomSummary[] {
  return (project.plan?.rooms ?? []).map((r) => ({
    id: r.id, name: r.name, areaM2: r.area,
    caja: { x0: r0(r.x0), z0: r0(r.z0), x1: r0(r.x1), z1: r0(r.z1), ancho: r0(r.x1 - r.x0), fondo: r0(r.z1 - r.z0) },
    centro: { x: r.cx, z: r.cz },
    conAcabado: !!(project.finishes?.[r.id] ?? project.roomFloors?.[r.id]),
  }));
}

export interface OpeningInfo {
  id: string; tipo: 'puerta' | 'ventana' | 'por confirmar'; etiqueta?: string;
  /** Posición a lo largo del muro (mm, mismas coordenadas del plano) y ancho. */
  desde: number; hasta: number; ancho: number;
  /** Antepecho (altura del borde inferior) y alto, en mm. */
  antepecho: number; alto: number;
  manual?: true;
}

const kindName = (o: { kind: string; unknown?: boolean }, id: string): OpeningInfo['tipo'] => (id.startsWith('A') ? 'por confirmar' : o.kind === 'door' ? 'puerta' : 'ventana');

/** Todas las aberturas del plano con su clave. */
export function listOpenings(plan: FloorPlan | undefined): (OpeningInfo & { x1: number; z1: number; x2: number; z2: number })[] {
  if (!plan) return [];
  return openingIds(plan).map(({ o, id }) => {
    const horiz = Math.abs(o.z1 - o.z2) < 1;
    const a = horiz ? Math.min(o.x1, o.x2) : Math.min(o.z1, o.z2), b = horiz ? Math.max(o.x1, o.x2) : Math.max(o.z1, o.z2);
    return { id, tipo: kindName(o, id), ...(o.tag ? { etiqueta: o.tag } : {}), desde: r0(a), hasta: r0(b), ancho: r0(b - a), antepecho: r0(o.y), alto: r0(o.h), ...(o.manual ? { manual: true as const } : {}), x1: r0(o.x1), z1: r0(o.z1), x2: r0(o.x2), z2: r0(o.z2) };
  });
}

/** Panel de techo (ensamble): solo informativo. Calcula las celdas del plano de techo (puede tardar un poco en planos grandes). */
export function roofInfo(plan: FloorPlan | undefined): { paneles: number; espesor: number; altura: number; nota: string } | null {
  if (!plan?.roof?.lines?.length) return null;
  const paneles = roofCells(plan.roof.lines, plan.roof.texts ?? []).cells.length;
  return { paneles, espesor: plan.roof.thickness ?? ROOF_THICKNESS, altura: plan.panelH ?? 2440, nota: 'Solo visual: el techo no entra en cortes ni presupuesto y no se puede modificar desde el agente.' };
}

const SIDE_HELP = 'norte = muro en el borde de z menor (arriba en el plano), sur = z mayor, oeste = x menor, este = x mayor. Cada cara es la superficie interior del muro.';

/** Descripción completa de una habitación para diseñar muebles o calcular revestimientos. Lanza si no existe. */
export function describeRoom(project: Project, id: string) {
  const plan = project.plan;
  const room = plan?.rooms?.find((r) => r.id === id);
  if (!plan || !room) {
    const ids = (plan?.rooms ?? []).map((r) => r.id);
    throw new Error(`No existe la habitación ${id}. ${ids.length ? `Habitaciones: ${ids.join(', ')}.` : 'El proyecto no tiene plano con habitaciones.'}`);
  }
  const rects = roomFloorRects(plan, id);
  const faces = roomWallFaces(plan, id);
  const ops = listOpenings(plan);
  const withIds = openingIds(plan);
  const panelH = plan.panelH ?? 2440;
  const muros = faces.map((f) => {
    const aberturas = withIds
      .filter((q) => faceOpenings({ ...plan, openings: [q.o] }, f).length)
      .map((q) => ops.find((x) => x.id === q.id)!)
      .map(({ x1: _a, z1: _b, x2: _c, z2: _d, ...rest }) => rest);
    return {
      lado: f.side, eje: f.axis === 'z' ? 'horizontal (z fijo)' : 'vertical (x fijo)',
      coordenada: r0(f.c), desde: r0(f.a0), hasta: r0(f.a1), largo: r0(f.a1 - f.a0),
      normalInterior: f.axis === 'z' ? { x: 0, z: f.n } : { x: f.n, z: 0 },
      aberturas,
    };
  });
  return {
    id, name: room.name, areaPlanoM2: room.area,
    areaPisoM2: Math.round(rectsArea(rects) * 100) / 100,
    caja: { x0: r0(room.x0), z0: r0(room.z0), x1: r0(room.x1), z1: r0(room.z1) },
    alturaMuros: panelH,
    convenciones: `Medidas en mm; x a la derecha, z hacia el frente (abajo en el plano), y hacia arriba. ${SIDE_HELP}`,
    piso: { rectangulos: rects.map((q) => ({ x0: r0(q.x0), z0: r0(q.z0), x1: r0(q.x1), z1: r0(q.z1) })), nota: 'Unión de rectángulos sin solaparse que forma el contorno real del piso (puede ser en L).' },
    muros,
    acabado: project.finishes?.[id] ?? null,
    techo: roofInfo(plan),
  };
}

/** Cambia el nombre de una habitación (se guarda en el plano). */
export function setRoomName(project: Project, id: string, name: string): string {
  const room = project.plan?.rooms?.find((r) => r.id === id);
  if (!room) throw new Error(`No existe la habitación ${id}. Habitaciones: ${(project.plan?.rooms ?? []).map((r) => r.id).join(', ') || '(ninguna)'}.`);
  const clean = name.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 60);
  room.name = clean;
  return clean ? `${id} ahora se llama "${clean}".` : `${id} quedó sin nombre.`;
}

/** Resumen del plano para get_project (sin las líneas ni paneles, que pesan megabytes). */
export function planSummary(plan: FloorPlan | undefined) {
  if (!plan) return null;
  return {
    name: plan.name, lineas: plan.lines.length, habitaciones: plan.rooms?.length ?? 0, murosPanel: plan.walls?.length ?? 0,
    aberturas: plan.openings?.length ?? 0, alturaPanel: plan.panelH ?? null, techo: plan.roof?.lines?.length ? { lineas: plan.roof.lines.length, espesor: plan.roof.thickness ?? ROOF_THICKNESS } : null,
    nota: 'Usa list_rooms, describe_room y list_openings para leer el plano; get_project con full=true devuelve todo el contenido.',
  };
}
