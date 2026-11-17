import type { Edges, Part, Project } from './types';
import { panelAxes } from './shapes';
import { isSolid } from './solids';

const NONE: Edges = { largo: 0, ancho: 0 };

const isPurchased = (project: Project, part: Part) => !!project.materials.find((m) => m.id === part.material)?.purchased;

/** Tapacanto sugerido: puertas y frentes de cajón por los 4 cantos; el resto, solo el canto que mira al frente (+Z). */
export function autoEdges(part: Part): Edges {
  const name = part.name.toLowerCase();
  if (name.includes('cajón') && !name.includes('frente')) return NONE; // interior del cajón
  const { u, v, t } = panelAxes(part.size);
  if (part.size[t] <= 6) return NONE; // fondos delgados
  if (name.includes('puerta') || name.includes('frente')) return { largo: 2, ancho: 2 };
  if (t === 2) return NONE; // pieza plana mirando al frente: no tiene canto frontal
  if (u === 2) return { largo: 0, ancho: 1 };
  if (v === 2) return { largo: 1, ancho: 0 };
  return NONE;
}

export function applyAutoEdges(project: Project, group?: string): number {
  let n = 0;
  for (const part of project.parts) {
    if (group && part.group !== group) continue;
    if (isPurchased(project, part) || isSolid(part)) continue;
    part.edges = autoEdges(part);
    n++;
  }
  return n;
}

/** Metros lineales de tapacanto de una pieza. */
export function edgeMeters(part: Part): number {
  const e = part.edges;
  if (!e || isSolid(part)) return 0;
  const { u, v } = panelAxes(part.size);
  return (e.largo * part.size[u] + e.ancho * part.size[v]) / 1000;
}
