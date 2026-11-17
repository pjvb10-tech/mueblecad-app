import type { Project, SavedView, Vec3 } from './types';

/**
 * Vistas guardadas del proyecto (Project.views): cámara 3D o encuadre de un dibujo 2D. Funciones puras e inmutables,
 * con el mismo patrón que los dibujos: validar, agregar, reemplazar, borrar. Contrato en README ("Exportar vistas").
 */

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (p: unknown): p is Vec3 => Array.isArray(p) && p.length === 3 && p.every(fin);

/** Valida una vista guardada; devuelve un mensaje en español o null si es válida. */
export function validateView(v: SavedView): string | null {
  if (!v || typeof v !== 'object') return 'La vista debe ser un objeto.';
  if (typeof v.id !== 'string' || !v.id) return 'Una vista guardada no tiene id.';
  if (typeof v.name !== 'string' || !v.name.trim()) return `Vista "${v.id}": falta el nombre.`;
  if (v.kind === '3d') {
    if (!v.camera || !isVec3(v.camera.position) || !isVec3(v.camera.target)) return `Vista "${v.name}": camera necesita position y target [x, y, z] finitos.`;
    if (v.camera.position.every((c, i) => c === v.camera.target[i])) return `Vista "${v.name}": la cámara y su objetivo no pueden ser el mismo punto.`;
    if (v.camera.ortho !== undefined && typeof v.camera.ortho !== 'boolean') return `Vista "${v.name}": ortho debe ser true o false.`;
    if (v.hiddenLayers !== undefined && (!Array.isArray(v.hiddenLayers) || v.hiddenLayers.some((l) => typeof l !== 'string'))) return `Vista "${v.name}": hiddenLayers debe ser una lista de nombres de capa.`;
    return null;
  }
  if (v.kind === '2d') {
    if (typeof v.drawing !== 'string' || !v.drawing) return `Vista "${v.name}": falta el id del dibujo.`;
    if (!v.view || !fin(v.view.cx) || !fin(v.view.cy) || !fin(v.view.scale) || v.view.scale <= 0) return `Vista "${v.name}": view necesita cx, cy y scale (> 0).`;
    return null;
  }
  return `Vista "${(v as { name?: string }).name}": kind debe ser "3d" o "2d".`;
}

/** Valida todas las vistas del proyecto (y ids únicos). Null si todo está bien o no hay vistas. */
export function validateViews(project: Pick<Project, 'views'>): string | null {
  if (project.views === undefined) return null;
  if (!Array.isArray(project.views)) return 'views debe ser una lista de vistas guardadas.';
  const ids = new Set<string>();
  for (const v of project.views) {
    const m = validateView(v);
    if (m) return m;
    if (ids.has(v.id)) return `Hay dos vistas con el id "${v.id}"; los ids deben ser únicos.`;
    ids.add(v.id);
  }
  return null;
}

/** Id libre para una vista nueva ("v1", "v2"…). */
export function nextViewId(project: Pick<Project, 'views'>): string {
  const used = new Set((project.views ?? []).map((x) => x.id));
  for (let i = 1; ; i++) if (!used.has(`v${i}`)) return `v${i}`;
}

/** Proyecto con la vista agregada (o reemplazada si el id ya existe). Lanza Error si no es válida. */
export function withView(project: Project, view: SavedView): Project {
  const m = validateView(view);
  if (m) throw new Error(m);
  const list = project.views ?? [];
  const i = list.findIndex((x) => x.id === view.id);
  return { ...project, views: i >= 0 ? list.map((x, j) => (j === i ? view : x)) : [...list, view] };
}

/** Proyecto sin la vista `id`. Si era la última, `views` queda ausente (el JSON vuelve a ser el de antes de existir las vistas). */
export function withoutView(project: Project, id: string): Project {
  if (!project.views?.some((x) => x.id === id)) throw new Error(`No existe la vista "${id}". Vistas: ${(project.views ?? []).map((x) => x.id).join(', ') || '(ninguna)'}.`);
  const { views, ...rest } = project;
  const left = views!.filter((x) => x.id !== id);
  return left.length ? { ...rest, views: left } : rest;
}

/** Busca una vista por id o por nombre (sin distinguir mayúsculas). */
export const findView = (project: Pick<Project, 'views'>, idOrName: string): SavedView | undefined =>
  (project.views ?? []).find((x) => x.id === idOrName) ?? (project.views ?? []).find((x) => x.name.toLowerCase() === idOrName.toLowerCase());
