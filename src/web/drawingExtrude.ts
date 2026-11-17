import { DrawingError, findLayer } from '../core/drawing';
import { extrudeProfile, type PartDef } from '../core/extrude';
import { nextId } from '../core/furniture';
import type { Drawing, Entity, Part, Project } from '../core/types';

/** Lo que se puede extruir: polilíneas cerradas (incluye rectángulos) y círculos. */
export const isExtrudable = (e: Entity): boolean => e.type === 'circle' || (e.type === 'poly' && !!e.closed);

/**
 * Entidades a extruir: las `ids` indicadas (si hay) o, sin selección, todas las cerradas de capas visibles.
 * Lanza DrawingError si no queda ninguna o si entre las elegidas hay alguna que no se puede extruir.
 */
export function extrusionTargets(d: Drawing, ids: readonly string[] | null): Entity[] {
  if (ids && ids.length) {
    const list = ids.map((id) => d.entities.find((e) => e.id === id)).filter((e): e is Entity => !!e);
    const bad = list.filter((e) => !isExtrudable(e));
    if (bad.length) throw new DrawingError(`Solo se extruyen polilíneas cerradas, rectángulos y círculos; no sirven: ${bad.map((e) => `${e.id} (${e.type}${e.type === 'poly' ? ' abierta' : ''})`).join(', ')}.`);
    return list;
  }
  const all = d.entities.filter((e) => isExtrudable(e) && (() => { const l = findLayer(d, e.layer); return !!l && l.on && !l.frozen; })());
  if (!all.length) throw new DrawingError(`El dibujo "${d.name}" no tiene polilíneas cerradas, rectángulos ni círculos que extruir (ni capas visibles con ellos).`);
  return all;
}

export interface ExtrudeRequest { name: string; depth: number; material: string; ids: readonly string[] | null }

/** Nombre de mueble que no choca con los grupos de piezas existentes ("Base", "Base 2"…). */
export function uniqueGroupName(project: Pick<Project, 'parts'>, base: string): string {
  const used = new Set(project.parts.map((p) => p.group));
  let name = base, i = 1;
  while (used.has(name)) name = `${base} ${++i}`;
  return name;
}

/**
 * Piezas sólidas (con id nuevo) para agregar al proyecto: una por entidad, todas en el grupo `req.name`. No modifica el proyecto.
 * Las piezas van en la normal del plano del dibujo (ver docs/dibujo-2d.md). Todo o nada: si una falla, el mensaje dice cuál.
 */
export function buildExtrusions(project: Project, d: Drawing, req: ExtrudeRequest): { parts: Part[]; group: string } {
  const name = req.name.trim() || `Extrusión ${d.name}`;
  if (!project.materials.some((m) => m.id === req.material)) throw new DrawingError(`El material "${req.material}" no existe en el proyecto.`);
  const targets = extrusionTargets(d, req.ids);
  const group = uniqueGroupName(project, name);
  const scratch: Project = { ...project, parts: [...project.parts] };
  const parts: Part[] = [];
  targets.forEach((e, i) => {
    const def: PartDef = extrudeProfile(d, e, req.depth, { name: targets.length > 1 ? `${name} ${i + 1}` : name, material: req.material, group });
    const part: Part = { ...def, id: nextId(scratch) };
    scratch.parts.push(part);
    parts.push(part);
  });
  return { parts, group };
}
