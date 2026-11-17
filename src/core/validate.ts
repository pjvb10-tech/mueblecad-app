import type { CabinetSpec, Part, Project, Vec3 } from './types';

/** Radio máximo del canto redondeado: la mitad del espesor de la pieza (su dimensión más pequeña). */
export const edgeRoundLimit = (size: Vec3) => Math.min(...size) / 2;

/** Valida el redondeo de canto de una pieza. Devuelve el mensaje de error o null si es válido. */
export function validateEdgeRound(part: Pick<Part, 'size' | 'name'>, edge: number, radius: number): string | null {
  if (edge !== 0 && edge !== 2) return 'El canto debe ser 0 (v mínimo) o 2 (v máximo).';
  if (!(radius > 0) || !Number.isFinite(radius)) return 'El radio debe ser un número mayor que 0 (usa quitar=true para eliminar el redondeo).';
  const max = edgeRoundLimit(part.size);
  if (radius > max + 1e-9) return `El radio máximo de "${part.name}" es ${max} mm (la mitad de su espesor de ${Math.min(...part.size)} mm).`;
  return null;
}

type CabinetInput = Partial<CabinetSpec> & { width?: number; height?: number; depth?: number };

/**
 * Valida las opciones de un mueble antes de generarlo (materiales existentes, alturas dentro del mueble, combinaciones
 * que no se pueden). `final` es el conjunto completo ya fusionado (spec guardada + cambios). Devuelve el error o null.
 */
export function validateCabinetOptions(project: Project, final: CabinetInput): string | null {
  const { width, height, depth } = final;
  for (const [k, v] of Object.entries({ width, height, depth })) {
    if (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v)) return `${k} debe ser un número mayor que 0.`;
  }
  const matIds = project.materials.map((m) => m.id);
  for (const k of ['material', 'backMaterial', 'doorMaterial', 'rodMaterial'] as const) {
    const id = final[k];
    if (id !== undefined && !matIds.includes(id)) return `Material desconocido en ${k}: "${id}". Materiales: ${matIds.join(', ') || '(ninguno)'}.`;
  }
  const corner = final.kind === 'corner';
  const t = project.materials.find((m) => m.id === (final.material ?? project.materials[0]?.id))?.thickness ?? 18;
  if (corner && (final.rods?.length || final.shelfAt?.length || final.faceBack)) return 'rods, shelfAt y faceBack solo existen en muebles rectos (kind=box).';
  if (final.faceBack && final.rebateBack) return 'faceBack no se combina con rebateBack (el fondo embutido): usa uno solo.';
  const h = height as number;
  for (const [k, list, lo, hi] of [
    ['shelfAt', final.shelfAt, 0, h - t],
    ['rods', final.rods, 0, h - 25],
  ] as const) {
    if (!list) continue;
    if (!Array.isArray(list) || list.some((v) => typeof v !== 'number' || !Number.isFinite(v))) return `${k} debe ser una lista de números (mm).`;
    const bad = list.find((v) => v < lo || v > hi);
    if (bad !== undefined) return `${k}: ${bad} mm está fuera del mueble (permitido ${lo}–${Math.round(hi)} mm medidos desde la base del mueble, alto ${h}).`;
  }
  if (final.rods?.length && !final.rodMaterial && project.materials.length === 0) return 'Hace falta un material para la barra de colgar.';
  for (const k of ['shelves', 'drawers', 'doors'] as const) {
    const v = final[k];
    if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 50)) return `${k} debe ser un entero entre 0 y 50.`;
  }
  return null;
}
