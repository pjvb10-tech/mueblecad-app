import type { Project } from './types';
import { partBounds } from './solids';

/** Espacio libre que necesita cada tipo de hueco frente al muro: la puerta necesita lugar para abrir; la ventana, que nada la tape. */
const CLEAR = { door: 800, window: 150 };

/** Avisos de muebles que bloquean una puerta o tapan una ventana del espacio. */
export function openingConflicts(p: Project): string[] {
  const room = p.room;
  if (!room) return [];
  const ops = [...(room.openings ?? [])];
  if (room.window && !ops.some((o) => o.wall === 'back')) ops.push({ wall: 'back', a: room.window.x, b: room.window.x + room.window.w, y: room.window.y, h: room.window.h, kind: 'window' });
  if (!ops.length) return [];
  const groups = new Map<string, { min: number[]; max: number[] }>();
  for (const part of p.parts) {
    const key = part.group ?? part.name;
    const g = groups.get(key) ?? { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const b = partBounds(part); // caja envolvente (con giro); sin giro es position / position + size
    for (let i = 0; i < 3; i++) { g.min[i] = Math.min(g.min[i], b.min[i]); g.max[i] = Math.max(g.max[i], b.max[i]); }
    groups.set(key, g);
  }
  const out: string[] = [];
  for (const [name, g] of groups) {
    for (const o of ops) {
      const d = CLEAR[o.kind];
      const side = o.wall === 'left' || o.wall === 'right';
      // zona frente al hueco: [x0,x1] × [y0,y1] × [z0,z1]
      const along: [number, number] = [o.a, o.b];
      const across: [number, number] = o.wall === 'back' ? [0, d] : o.wall === 'front' ? [room.depth - d, room.depth] : o.wall === 'left' ? [0, d] : [room.width - d, room.width];
      const x: [number, number] = side ? across : along, z: [number, number] = side ? along : across;
      const y: [number, number] = [o.kind === 'door' ? 0 : o.y, o.y + o.h];
      const hit = g.min[0] < x[1] && g.max[0] > x[0] && g.min[1] < y[1] && g.max[1] > y[0] && g.min[2] < z[1] && g.max[2] > z[0];
      if (hit) out.push(`${name} ${o.kind === 'door' ? 'bloquea' : 'tapa'} ${o.kind === 'door' ? 'la puerta' : 'la ventana'}${o.tag ? ' ' + o.tag : ''} del muro ${{ back: 'del fondo', front: 'frontal', left: 'izquierdo', right: 'derecho' }[o.wall]}`);
    }
  }
  return out;
}
