import type { CabinetSpec, Part, Project, Rebate, Vec3 } from './types';
import { autoEdges } from './edges';
import { panelAxes } from './shapes';

export interface CabinetOptions extends CabinetSpec {
  name?: string;
  /** Posición del mueble (esquina mínima). */
  x?: number;
  y?: number;
  z?: number;
}

export function nextId(project: Project, prefix = 'p'): string {
  let n = project.parts.length + 1;
  while (project.parts.some((p) => p.id === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

const SECTION_WORDS = /\s+(lateral|base|tapa|entrepaño|fondo|puerta|travesaño|cajón)\b/i;

/** Grupo de una pieza: el campo `group` o, si falta, se deduce del nombre ("Base 1 lateral izq" -> "Base 1"). */
export function groupOf(part: Part): string {
  if (part.group) return part.group;
  const m = SECTION_WORDS.exec(part.name);
  if (m) return part.name.slice(0, m.index);
  return part.name.split(' ')[0];
}

/** Capa de una pieza, para mostrar u ocultar por categoría. */
export function layerOf(project: Project, part: Part): string {
  if (part.layer) return part.layer;
  const name = part.name.toLowerCase();
  if (project.materials.find((m) => m.id === part.material)?.purchased) return 'Referencia';
  if (name.includes('puerta')) return 'Puertas';
  if (name.includes('cajón')) return 'Cajones';
  if (name.includes('fondo') && Math.min(...part.size) <= 6) return 'Fondos';
  return 'Estructura';
}

/** Profundidad del rebaje donde se embute el fondo. */
export const REBATE_DEPTH = 8;

/** Rebaje en el canto trasero (el que mira a -Z) de una pieza plana. */
export function rearRebate(size: Vec3, width: number, depth = REBATE_DEPTH): Rebate {
  const { u, v } = panelAxes(size);
  return { edge: v === 2 ? 0 : u === 2 ? 3 : 0, width, depth };
}

type Draft = Omit<Part, 'id'>;

/** Mueble en caja: 2 laterales, base, tapa, entrepaños; fondo, puertas o cajones opcionales. */
function boxParts(project: Project, o: CabinetOptions, name: string): Draft[] {
  const thick = (id: string | undefined, fallback: number) => project.materials.find((m) => m.id === id)?.thickness ?? fallback;
  const matId = o.material ?? project.materials[0].id;
  const t = thick(matId, 18);
  const backT = o.backMaterial ? thick(o.backMaterial, 3) : 0;
  const frontMat = o.doorMaterial ?? matId;
  const frontT = thick(frontMat, 18);
  const [x0, y0, z0] = [o.x ?? 0, o.y ?? 0, o.z ?? 0];
  const innerW = o.width - 2 * t;
  const rebate = !!o.rebateBack && !!o.backMaterial && !o.faceBack;
  const usable = o.depth - backT; // fondo útil delante del respaldo
  const carcassDepth = rebate ? o.depth : usable;
  const carcassZ = rebate ? z0 : z0 + backT;
  const withRebate = (size: Vec3): Rebate[] | undefined => (rebate ? [rearRebate(size, backT)] : undefined);
  const piece = (label: string, size: Vec3, position: Vec3, material: string, rebates?: Rebate[]): Draft => ({ name: `${name} ${label}`, size, position, material, ...(rebates ? { rebates } : {}) });

  const side: Vec3 = [t, o.height, carcassDepth];
  const flat: Vec3 = [innerW, t, carcassDepth];
  const parts: Draft[] = [
    piece('lateral izq', side, [x0, y0, carcassZ], matId, withRebate(side)),
    piece('lateral der', side, [x0 + o.width - t, y0, carcassZ], matId, withRebate(side)),
    piece('base', flat, [x0 + t, y0, carcassZ], matId, withRebate(flat)),
    piece('tapa', flat, [x0 + t, y0 + o.height - t, carcassZ], matId, withRebate(flat)),
  ];
  const n = o.shelves ?? 0;
  const gap = (o.height - 2 * t - n * t) / (n + 1);
  const shelfZ = z0 + backT + 10;
  if (o.shelfAt?.length) {
    o.shelfAt.forEach((h, i) => parts.push(piece(`entrepaño ${i + 1}`, [innerW, t, z0 + o.depth - shelfZ], [x0 + t, y0 + h, shelfZ], matId)));
  } else {
    for (let i = 1; i <= n; i++) {
      parts.push(piece(`entrepaño ${i}`, [innerW, t, z0 + o.depth - shelfZ], [x0 + t, y0 + t + i * gap + (i - 1) * t, shelfZ], matId));
    }
  }
  if (o.rods?.length) {
    const rodMat = o.rodMaterial ?? matId;
    const rz = shelfZ + (z0 + o.depth - shelfZ) / 2 - 12.5;
    o.rods.forEach((h, i) => parts.push(piece(o.rods!.length > 1 ? `barra de colgar ${i + 1}` : 'barra de colgar', [innerW, 25, 25], [x0 + t, y0 + h, rz], rodMat)));
  }
  if (o.backMaterial) {
    const back: [Vec3, Vec3] = rebate
      ? [[innerW + 2 * REBATE_DEPTH, o.height - 2 * t + 2 * REBATE_DEPTH, backT], [x0 + t - REBATE_DEPTH, y0 + t - REBATE_DEPTH, z0]]
      : [[o.width, o.height, backT], [x0, y0, z0]];
    parts.push(piece('fondo', back[0], back[1], o.backMaterial));
  }

  const drawers = Math.max(0, Math.floor(o.drawers ?? 0));
  if (drawers > 0) {
    const fh = (o.height - 4 - (drawers - 1) * 3) / drawers;
    const boxW = innerW - 26; // 13 mm de holgura por lado para las correderas
    const boxD = Math.max(100, Math.min(usable - 20, 500));
    const boxH = Math.max(60, fh - 50);
    const bottomMat = o.backMaterial ?? matId;
    const bottomT = o.backMaterial ? backT : t;
    for (let i = 0; i < drawers; i++) {
      const fy = y0 + 2 + i * (fh + 3);
      const by = fy + 20;
      const bx = x0 + t + 13;
      const label = `cajón ${i + 1}`;
      parts.push(
        piece(`${label} frente`, [o.width - 4, fh, frontT], [x0 + 2, fy, z0 + o.depth], frontMat),
        piece(`${label} lado izq`, [t, boxH, boxD], [bx, by, shelfZ], matId),
        piece(`${label} lado der`, [t, boxH, boxD], [bx + boxW - t, by, shelfZ], matId),
        piece(`${label} trasero`, [boxW - 2 * t, boxH, t], [bx + t, by, shelfZ + boxD - t], matId),
        piece(`${label} fondo`, [boxW, bottomT, boxD], [bx, by + 8, shelfZ], bottomMat),
      );
    }
  } else if (o.doorMaterial) {
    const count = o.doors && o.doors > 0 ? Math.floor(o.doors) : Math.max(1, Math.round(o.width / 500));
    const w = (o.width - (count + 1) * 2) / count;
    for (let i = 0; i < count; i++) {
      parts.push(piece(`puerta ${i + 1}`, [w, o.height - 4, frontT], [x0 + 2 + i * (w + 2), y0 + 2, z0 + o.depth], frontMat));
    }
  }
  if (o.faceBack) {
    // Espejo en Z dentro de la caja del mueble: el frente pasa a mirar a -Z y el fondo queda en z0 + extensión.
    const ext = Math.max(...parts.map((q) => q.position[2] + q.size[2])) - z0;
    for (const q of parts) q.position = [q.position[0], q.position[1], z0 + ext - (q.position[2] - z0) - q.size[2]];
  }
  return parts;
}

/** Esquinero en L: un brazo de `width` a lo largo de X y otro de `wingB` a lo largo de Z, ambos de `depth` de fondo. */
function cornerParts(project: Project, o: CabinetOptions, name: string): Draft[] {
  const thick = (id: string | undefined, fallback: number) => project.materials.find((m) => m.id === id)?.thickness ?? fallback;
  const matId = o.material ?? project.materials[0].id;
  const t = thick(matId, 18);
  const backT = o.backMaterial ? thick(o.backMaterial, 3) : 0;
  const frontMat = o.doorMaterial ?? matId;
  const frontT = thick(frontMat, 18);
  const [x0, y0, z0] = [o.x ?? 0, o.y ?? 0, o.z ?? 0];
  const A = o.width;
  const B = o.wingB ?? o.width;
  const d = o.depth;
  const H = o.height;
  if (A <= d + 100 || B <= d + 100) throw new Error(`Cada brazo del esquinero debe medir más que el fondo (${d}) más 100 mm.`);

  const flat: Vec3 = [A, t, B];
  const { u } = panelAxes(flat);
  // El hueco del frente es la esquina (u máx, v máx) del plano; w va a lo largo de u.
  const notch = u === 0 ? { w: A - d, h: B - d, corner: 2 as const } : { w: B - d, h: A - d, corner: 2 as const };
  const lShape = (label: string, y: number): Draft => ({ name: `${name} ${label}`, size: flat, position: [x0, y, z0], material: matId, shape: { notch }, edges: { largo: 0, ancho: 0 } });

  const parts: Draft[] = [
    { name: `${name} lateral extremo A`, size: [t, H, d], position: [x0 + A - t, y0, z0], material: matId },
    { name: `${name} lateral extremo B`, size: [d, H, t], position: [x0, y0, z0 + B - t], material: matId },
    lShape('base', y0),
    lShape('tapa', y0 + H - t),
  ];
  const n = o.shelves ?? 0;
  const gap = (H - 2 * t - n * t) / (n + 1);
  for (let i = 1; i <= n; i++) parts.push(lShape(`entrepaño ${i}`, y0 + t + i * gap + (i - 1) * t));
  if (o.backMaterial) {
    parts.push(
      { name: `${name} fondo A`, size: [A, H, backT], position: [x0, y0, z0], material: o.backMaterial },
      { name: `${name} fondo B`, size: [backT, H, B], position: [x0, y0, z0], material: o.backMaterial },
    );
  }
  if (o.doorMaterial) {
    const split = (len: number) => {
      const count = o.doors && o.doors > 0 ? Math.max(1, Math.floor(o.doors / 2)) : Math.max(1, Math.round(len / 500));
      return { count, w: (len - (count + 1) * 2) / count };
    };
    const a = split(A - d);
    for (let i = 0; i < a.count; i++) parts.push({ name: `${name} puerta A${i + 1}`, size: [a.w, H - 4, frontT], position: [x0 + d + 2 + i * (a.w + 2), y0 + 2, z0 + d], material: frontMat });
    const b = split(B - d);
    for (let i = 0; i < b.count; i++) parts.push({ name: `${name} puerta B${i + 1}`, size: [frontT, H - 4, b.w], position: [x0 + d, y0 + 2, z0 + d + 2 + i * (b.w + 2)], material: frontMat });
  }
  return parts;
}

export function buildCabinet(project: Project, o: CabinetOptions): Part[] {
  const name = o.name ?? 'Gabinete';
  const drafts = o.kind === 'corner' ? cornerParts(project, o, name) : boxParts(project, o, name);
  // Los ids se asignan sobre un proyecto temporal para no repetirse dentro del lote.
  const tmp: Project = { ...project, parts: [...project.parts] };
  return drafts.map((p) => {
    const part: Part = { ...p, group: name, id: nextId(tmp) };
    if (o.edging !== false && !part.edges) part.edges = autoEdges(part);
    tmp.parts.push(part);
    return part;
  });
}

/** Genera el mueble, lo agrega al proyecto y guarda sus parámetros para poder regenerarlo después. */
export function addCabinet(project: Project, o: CabinetOptions): Part[] {
  const parts = buildCabinet(project, o);
  project.parts.push(...parts);
  const { name, x, y, z, ...spec } = o;
  void x; void y; void z;
  (project.cabinets ??= {})[name ?? 'Gabinete'] = spec;
  return parts;
}

/** Vuelve a generar un mueble con otras medidas u opciones, en la misma posición. Pierde las ediciones manuales de sus piezas. */
export function rebuildCabinet(project: Project, group: string, patch: Partial<CabinetSpec>, position?: Vec3): Part[] | null {
  const spec = project.cabinets?.[group];
  if (!spec) return null;
  const old = project.parts.filter((p) => groupOf(p) === group);
  if (!old.length) return null;
  const min = [0, 1, 2].map((i) => Math.min(...old.map((p) => p.position[i]))) as Vec3;
  const merged: CabinetSpec = { ...spec, ...patch };
  const at = position ?? min;
  const parts = buildCabinet(project, { ...merged, name: group, x: at[0], y: at[1], z: at[2] });
  project.parts = project.parts.filter((p) => groupOf(p) !== group);
  project.parts.push(...parts);
  project.cabinets![group] = merged;
  return parts;
}
