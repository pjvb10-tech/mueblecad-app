import type { Part, Project, Vec3 } from './types';
import { groupOf, rebuildCabinet } from './furniture';
import { partBounds } from './solids';
import { cleanMm } from './units';

export type FitMode = 'back' | 'left' | 'right' | 'center' | 'fill';

const movable = (project: Project): Part[] => project.parts.filter((p) => !project.materials.find((m) => m.id === p.material)?.purchased);

function shift(parts: Part[], axis: number, delta: number) {
  for (const p of parts) p.position[axis] = cleanMm(p.position[axis] + delta);
}

/**
 * Acomoda los muebles en el espacio del proyecto.
 * back = pega cada mueble al muro del fondo; left/right/center = mueve todo el conjunto;
 * fill = estira los muebles generados (con parámetros guardados) para llenar el ancho del muro.
 */
export function fitToRoom(project: Project, mode: FitMode): string {
  const room = project.room;
  if (!room) return 'Primero define el espacio.';
  const parts = movable(project);
  if (!parts.length) return 'No hay muebles.';
  const minX = Math.min(...parts.map((p) => partBounds(p).min[0]));
  const maxX = Math.max(...parts.map((p) => partBounds(p).max[0]));

  if (mode === 'back') {
    const groups = new Map<string, Part[]>();
    for (const p of parts) groups.set(groupOf(p), [...(groups.get(groupOf(p)) ?? []), p]);
    for (const g of groups.values()) shift(g, 2, -Math.min(...g.map((p) => partBounds(p).min[2])));
    return `${groups.size} muebles pegados al muro del fondo.`;
  }
  if (mode === 'left') { shift(parts, 0, -minX); return 'Conjunto pegado al muro izquierdo.'; }
  if (mode === 'right') { shift(parts, 0, room.width - maxX); return 'Conjunto pegado al muro derecho.'; }
  if (mode === 'center') { shift(parts, 0, (room.width - (maxX - minX)) / 2 - minX); return 'Conjunto centrado en el muro.'; }

  // fill: solo muebles con parámetros guardados (los creados con el generador, no esquineros)
  const mods = [...new Set(parts.map(groupOf))]
    .filter((g) => project.cabinets?.[g] && project.cabinets[g].kind !== 'corner')
    .map((g) => {
      const gp = parts.filter((p) => groupOf(p) === g);
      return { name: g, x: Math.min(...gp.map((p) => p.position[0])), width: project.cabinets![g].width, pos: [0, 1, 2].map((i) => Math.min(...gp.map((p) => p.position[i]))) as Vec3 };
    });
  if (!mods.length) return 'No hay muebles generados que se puedan estirar.';
  const lo = Math.min(...mods.map((m) => m.x));
  const hi = Math.max(...mods.map((m) => m.x + m.width));
  const factor = room.width / (hi - lo);
  for (const m of mods) {
    const x0 = Math.round((m.x - lo) * factor);
    const x1 = Math.round((m.x + m.width - lo) * factor);
    rebuildCabinet(project, m.name, { width: x1 - x0 }, [x0, m.pos[1], m.pos[2]]);
  }
  return `${mods.length} muebles estirados a ${room.width} mm de ancho (x${factor.toFixed(3)}).`;
}
