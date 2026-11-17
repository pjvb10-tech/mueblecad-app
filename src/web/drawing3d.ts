import { drawingToWorld } from '../core/drawingPlane';
import { resolveInsert } from '../core/blocks';
import { dimGeometry, tessellateArc, tessellateCircle, tessellatePoly, textCorners } from '../core/geom2d';
import type { Drawing, Entity, Project, Pt2 } from '../core/types';
import { entityColor, entityVisible } from './drawingRender';

/** Segmentos 3D (mundo, mm) de los dibujos visibles, agrupados por color: x1,y1,z1,x2,y2,z2 seguidos (como pide LineSegments). */
export interface DrawingLineSet { color: string; positions: number[] }

/** ¿Un dibujo se muestra en el 3D? (`visible` ausente = sí) */
export const drawingShownIn3d = (d: Drawing): boolean => d.visible !== false;

/** Polilíneas (en coordenadas del dibujo) de una entidad: arcos y círculos teselados con flecha máxima `tol` mm. */
export function entityPolylines(e: Entity, tol = 0.5): Pt2[][] {
  switch (e.type) {
    case 'line': return [[e.a, e.b]];
    case 'poly': { const pts = tessellatePoly(e, tol); return [e.closed ? [...pts, pts[0]] : pts]; }
    case 'circle': { const pts = tessellateCircle(e.c, e.r, tol); return [[...pts, pts[0]]]; }
    case 'arc': return [tessellateArc(e.c, e.r, e.a0, e.a1, tol)];
    case 'text': { const c = textCorners(e); return [[...c, c[0]]]; } // el texto se marca con su caja
    case 'dim': {
      const g = dimGeometry(e);
      return [...g.lines.map((l) => [l[0], l[1]]), ...g.texts.map((t) => { const c = textCorners(t); return [...c, c[0]]; })];
    }
    case 'hatch': return e.loops.map((l) => { const pts = tessellatePoly({ pts: l, closed: true }, tol); return [...pts, pts[0]]; }); // en 3D solo el contorno
    case 'insert': return []; // se resuelve en drawingLineSets (cada hijo con su color)
  }
}

export function drawingLineSets(project: Pick<Project, 'drawings'>): DrawingLineSet[] {
  const sets = new Map<string, number[]>();
  for (const d of project.drawings ?? []) {
    if (!drawingShownIn3d(d)) continue;
    const flat: Entity[] = [];
    for (const e of d.entities) {
      if (!entityVisible(d, e)) continue;
      if (e.type === 'insert') flat.push(...resolveInsert(e, d).filter((c) => entityVisible(d, c))); else flat.push(e);
    }
    for (const e of flat) {
      const color = entityColor(d, e);
      let arr = sets.get(color);
      if (!arr) sets.set(color, (arr = []));
      for (const line of entityPolylines(e)) {
        for (let i = 0; i + 1 < line.length; i++) arr.push(...drawingToWorld(d, line[i]), ...drawingToWorld(d, line[i + 1]));
      }
    }
  }
  return [...sets].map(([color, positions]) => ({ color, positions }));
}
