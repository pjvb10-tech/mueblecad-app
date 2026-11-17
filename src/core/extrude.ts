import { DrawingError, type EntityInput } from './drawing';
import { PLANE_BASIS, drawingToWorld, worldToDrawing } from './drawingPlane';
import { tessellatePoly } from './geom2d';
import { MAX_PROFILE_POINTS, cleanProfile, localAxes, validatePart } from './solids';
import type { Axis, Drawing, DrawingPlane, Entity, Part, Pt2, Vec3 } from './types';

/**
 * Del dibujo 2D al sólido y de vuelta (solo matemática; no toca el proyecto). Contrato: docs/dibujo-2d.md.
 * La extrusión va a lo largo de la NORMAL del plano del dibujo (xy→+Z, xz→+Y, yz→+X) con profundidad positiva; negativa va en sentido contrario.
 */

export type PartDef = Omit<Part, 'id'>;
export interface ExtrudeOptions { name?: string; material?: string; group?: string; /** flecha máxima (mm) al aproximar arcos; 0.1 por omisión (sube sola si el perfil pasaría de MAX_PROFILE_POINTS) */ tolerance?: number }

const AXIS: Axis[] = ['x', 'y', 'z'];
const bad = (m: string): never => { throw new DrawingError(m); };

/**
 * Convierte una entidad CERRADA en la definición de una pieza:
 *  - poly cerrada (incluye rect y arcos por bulge; cóncavas permitidas, deben ser simples) -> form 'prism' con `profile`;
 *  - circle -> form 'cylinder' (exacto, sin aproximar).
 * Lanza DrawingError con un mensaje claro si la entidad no es cerrada, se cruza a sí misma o la profundidad es 0.
 * La pieza queda sin `id`: asígnale uno al agregarla al proyecto.
 */
export function extrudeProfile(drawing: Pick<Drawing, 'plane' | 'origin' | 'name'>, entity: Entity, depth: number, opts: ExtrudeOptions = {}): PartDef {
  if (!Number.isFinite(depth) || depth === 0) bad('La profundidad de extrusión debe ser un número distinto de 0 (mm); negativa extruye hacia el otro lado.');
  const { normalAxis } = PLANE_BASIS[drawing.plane];
  const [ia, ib, ic] = localAxes(normalAxis);
  const material = opts.material ?? 'mel18';
  const name = opts.name ?? `Extrusión ${drawing.name}`;
  const L = Math.abs(depth);
  const cpos = drawing.origin[ic] + Math.min(0, depth); // posición mínima sobre el eje de extrusión

  if (entity.type === 'circle') {
    const w = drawingToWorld(drawing, entity.c);
    const size: Vec3 = [0, 0, 0], position: Vec3 = [0, 0, 0];
    size[ia] = size[ib] = 2 * entity.r; size[ic] = L;
    position[ia] = w[ia] - entity.r; position[ib] = w[ib] - entity.r; position[ic] = cpos;
    return { name, size, position, material, ...(opts.group ? { group: opts.group } : {}), form: 'cylinder', axis: AXIS[ic] };
  }
  if (entity.type !== 'poly') return bad(`Solo se extruyen polilíneas cerradas, rectángulos y círculos (la entidad "${entity.id}" es ${entity.type}).`);
  if (!entity.closed) bad(`La polilínea "${entity.id}" está abierta; ciérrala (closed: true) o únela en un lazo antes de extruir.`);

  let tol = opts.tolerance ?? 0.1, pts: Pt2[] = tessellatePoly(entity, tol);
  while (pts.length > MAX_PROFILE_POINTS - 4 && tol < 50) { tol *= 2; pts = tessellatePoly(entity, tol); }
  pts = cleanProfile(pts);
  const world = pts.map((p) => drawingToWorld(drawing, p));
  const min = [0, 1, 2].map((i) => Math.min(...world.map((w) => w[i])));
  const max = [0, 1, 2].map((i) => Math.max(...world.map((w) => w[i])));
  const size: Vec3 = [0, 0, 0], position: Vec3 = [0, 0, 0];
  size[ia] = max[ia] - min[ia]; size[ib] = max[ib] - min[ib]; size[ic] = L;
  position[ia] = min[ia]; position[ib] = min[ib]; position[ic] = cpos;
  const clean6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const profile = world.map((w) => [clean6(w[ia] - min[ia]), clean6(w[ib] - min[ib])] as Pt2);
  const part: PartDef = { name, size: size.map(clean6) as Vec3, position: position.map(clean6) as Vec3, material, ...(opts.group ? { group: opts.group } : {}), form: 'prism', axis: AXIS[ic], profile };
  const err = validatePart({ ...part, id: 'tmp' });
  if (err) bad(`No se puede extruir "${entity.id}": ${err.replace(/^"[^"]*": /, '')}`);
  return part;
}

/** Contorno 2D de una pieza sin girar: el plano y origen donde dibujarlo y la entrada para addEntity. */
export interface Outline { plane: DrawingPlane; origin: Vec3; input: EntityInput }

/**
 * Inversa de extrudeProfile: contorno de la pieza visto a lo largo de su eje (prisma -> poly con su perfil; cilindro -> circle;
 * caja -> rect en el plano xy, visto de frente). El plano pasa por la cara mínima de la pieza sobre su eje. Piezas giradas, tubos y
 * revoluciones no se soportan (devuelve null).
 */
export function partToOutline(part: Part): Outline | null {
  if (part.rotX || part.rotY || part.rotZ) return null;
  const form = part.form ?? 'box';
  if (form === 'tube' || form === 'revolve') return null;
  let ic: 0 | 1 | 2 = 2;
  if (form !== 'box') ic = part.axis ? (AXIS.indexOf(part.axis) as 0 | 1 | 2) : form === 'prism' ? 2 : ([0, 1, 2].find((i) => part.size[i] === Math.max(...part.size)) as 0 | 1 | 2);
  const plane = (['yz', 'xz', 'xy'] as DrawingPlane[])[ic];
  const origin: Vec3 = [0, 0, 0];
  origin[ic] = part.position[ic];
  const dr = { plane, origin };
  const [ia, ib] = localAxes(ic);
  const toUV = (a: number, b: number): Pt2 => { const w: Vec3 = [0, 0, 0]; w[ia] = part.position[ia] + a; w[ib] = part.position[ib] + b; w[ic] = part.position[ic]; return worldToDrawing(dr, w); };
  if (form === 'prism') return { plane, origin, input: { type: 'poly', closed: true, pts: (part.profile ?? []).map(([a, b]) => toUV(a, b)) } };
  if (form === 'cylinder') {
    if (part.wall) return null;
    return { plane, origin, input: { type: 'circle', c: toUV(part.size[ia] / 2, part.size[ib] / 2), r: Math.min(part.size[ia], part.size[ib]) / 2 } };
  }
  const p1 = toUV(0, 0), p2 = toUV(part.size[ia], part.size[ib]);
  return { plane, origin, input: { type: 'rect', p1, p2 } };
}
