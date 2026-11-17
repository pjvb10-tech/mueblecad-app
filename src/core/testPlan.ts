import { defaultProject } from './types';
import type { FloorPlan, Project } from './types';
import type { TextureItem } from './finish';

/** Proyecto de prueba con una habitación H1 de 2000 × 1000 mm (muros de 100 mm) y una puerta en el muro norte. */
export function projectWithRoom(): Project {
  const w = (x0: number, z0: number, x1: number, z1: number) => ({ kind: 'MI' as const, x0, z0, x1, z1 });
  const plan: FloorPlan = {
    name: 'prueba', lines: [], panelH: 2440,
    walls: [w(-100, -100, 2100, 0), w(-100, 1000, 2100, 1100), w(-100, 0, 0, 1000), w(2000, 0, 2100, 1000)],
    rooms: [{ id: 'H1', name: 'Sala', x0: 0, z0: 0, x1: 2000, z1: 1000, cx: 1000, cz: 500, area: 2 }],
    openings: [{ x1: 500, z1: -50, x2: 1400, z2: -50, y: 0, h: 2100, kind: 'door' }],
  };
  return { ...defaultProject(), plan };
}

export const testCatalog = (): TextureItem[] => [
  { id: 'trav', nombre: 'Travertino', categoria: 'ceramica', archivo: 'trav.png', w: 600, h: 600, junta: 3, colorJunta: '#c9c7c1', veta: 0, patron: 'recto' },
  { id: 'blanco', nombre: 'Blanco', categoria: 'pintura', color: '#ffffff', w: 300, h: 300, junta: 0, colorJunta: '#ffffff', veta: 0, patron: 'recto' },
];

/** PNG mínimo válido (1×1 píxel). */
export const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
