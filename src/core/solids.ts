import type { Axis, Part, Pt2, SolidForm, Vec3 } from './types';
import { meshVolume, validateMesh } from './mesh';

/**
 * Formas sólidas y giros de las piezas (cilindro, tubo, prisma, revolución). Todo es matemática pura (sin three.js):
 * el visor arma la malla a partir de `solidSpec`, y el resto del programa usa `partBounds`, `partVolume`, etc.
 *
 * Convenciones:
 *  - `size` / `position` son SIEMPRE la caja envolvente nominal sin girar (esquina mínima + medidas), también en formas que no son caja.
 *  - El giro (rotX, rotY, rotZ, en grados) es alrededor del centro de esa caja: R = Rz·Ry·Rx (primero X, luego Y, luego Z, ejes fijos del mundo).
 *  - Marco local de un sólido: (a, b, c) con c = eje del largo/giro; (a, b, c) = (X, Y, Z) si axis=z, (Y, Z, X) si axis=x, (Z, X, Y) si axis=y.
 *    Son permutaciones cíclicas, así que conservan la orientación (sin espejos).
 */

export const FORMS: SolidForm[] = ['box', 'cylinder', 'prism', 'tube', 'revolve', 'mesh'];
export const DEFAULT_SEGMENTS = 48;
export const MAX_PROFILE_POINTS = 500;
const EPS = 1e-6;
/** Tolerancia (mm) para decidir que un perfil cabe en su caja envolvente. */
const FIT_TOL = 0.01;

/** Parámetros de forma que admite cada form (los demás se rechazan al validar y se sueltan al cambiar de forma). */
export const FORM_FIELDS: Record<SolidForm, ('axis' | 'wall' | 'cornerRadius' | 'profile' | 'segments' | 'mesh')[]> = {
  box: [],
  cylinder: ['axis', 'wall', 'segments'],
  tube: ['axis', 'wall', 'cornerRadius', 'segments'],
  prism: ['axis', 'profile'],
  revolve: ['axis', 'profile', 'segments'],
  mesh: ['mesh'],
};

export const FORM_NAMES: Record<SolidForm, string> = { box: 'caja', cylinder: 'cilindro', prism: 'prisma', tube: 'tubo', revolve: 'revolución', mesh: 'malla' };

export const formOf = (part: Pick<Part, 'form'>): SolidForm => part.form ?? 'box';
/** Pieza con forma sólida distinta de la caja: no entra al despiece de planchas (ver docs/formas.md). */
export const isSolid = (part: Pick<Part, 'form'>): boolean => !!part.form && part.form !== 'box';
export const isRotated = (part: Pick<Part, 'rotX' | 'rotY' | 'rotZ'>): boolean => !!(part.rotX || part.rotY || part.rotZ);

const AXES: Axis[] = ['x', 'y', 'z'];
const axisIndex = (a: Axis): 0 | 1 | 2 => AXES.indexOf(a) as 0 | 1 | 2;
export const axisName = (i: number): Axis => AXES[i];

/** Índices del mundo (X=0, Y=1, Z=2) de los ejes locales (a, b, c) de un sólido cuyo eje del largo es `axis`. */
export function localAxes(axis: number): [number, number, number] {
  return axis === 0 ? [1, 2, 0] : axis === 1 ? [2, 0, 1] : [0, 1, 2];
}

/** Eje (0=X, 1=Y, 2=Z) del largo / giro de un sólido, con los valores por omisión documentados en Part.axis. */
export function resolveAxis(part: Pick<Part, 'form' | 'axis' | 'size'>): 0 | 1 | 2 {
  if (part.axis) return axisIndex(part.axis);
  const f = formOf(part);
  if (f === 'prism') return 2;
  if (f === 'revolve') return 1;
  const s = part.size;
  const eq = (i: number, j: number) => Math.abs(s[i] - s[j]) < EPS;
  if (eq(0, 1) && eq(1, 2)) return 1;
  if (eq(0, 1)) return 2;
  if (eq(0, 2)) return 1;
  if (eq(1, 2)) return 0;
  return s.indexOf(Math.max(...s)) as 0 | 1 | 2;
}

// ---------------------------------------------------------------- giro

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Matriz de giro 3×3 por filas [m00,m01,m02,m10,...] = Rz·Ry·Rx de la pieza (identidad si no gira). */
export function rotationMatrix(part: Pick<Part, 'rotX' | 'rotY' | 'rotZ'>): number[] {
  const [cx, sx] = [Math.cos(rad(part.rotX ?? 0)), Math.sin(rad(part.rotX ?? 0))];
  const [cy, sy] = [Math.cos(rad(part.rotY ?? 0)), Math.sin(rad(part.rotY ?? 0))];
  const [cz, sz] = [Math.cos(rad(part.rotZ ?? 0)), Math.sin(rad(part.rotZ ?? 0))];
  // Rz·Ry·Rx
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
    -sy, cy * sx, cy * cx,
  ];
}

/** Centro de la caja envolvente (punto fijo del giro). */
export const partCenter = (part: Pick<Part, 'position' | 'size'>): Vec3 => [0, 1, 2].map((i) => part.position[i] + part.size[i] / 2) as Vec3;

/** Lleva un punto del marco de la caja (origen en su esquina mínima, sin girar) al mundo: gira alrededor del centro y suma la posición. */
export function toWorld(part: Pick<Part, 'position' | 'size' | 'rotX' | 'rotY' | 'rotZ'>, p: Vec3): Vec3 {
  const c = partCenter(part);
  const d = [0, 1, 2].map((i) => part.position[i] + p[i] - c[i]);
  if (!isRotated(part)) return [part.position[0] + p[0], part.position[1] + p[1], part.position[2] + p[2]];
  const m = rotationMatrix(part);
  return [0, 1, 2].map((r) => c[r] + m[r * 3] * d[0] + m[r * 3 + 1] * d[1] + m[r * 3 + 2] * d[2]) as Vec3;
}

const clean6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * Caja alineada a los ejes que contiene a la pieza en el mundo. Sin giro es exactamente position / position+size.
 * Con giro es la caja de las 8 esquinas de la caja envolvente nominal girada: para formas que no son caja (o piezas giradas)
 * es una cota CONSERVADORA (puede ser algo mayor que la geometría real). Se usa en colisiones, muebles, vistas y medidas.
 */
export function partBounds(part: Pick<Part, 'position' | 'size' | 'rotX' | 'rotY' | 'rotZ'>): { min: Vec3; max: Vec3; size: Vec3 } {
  if (!isRotated(part)) {
    const min = [...part.position] as Vec3, max = [0, 1, 2].map((i) => part.position[i] + part.size[i]) as Vec3;
    return { min, max, size: [...part.size] as Vec3 };
  }
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [0, part.size[0]]) for (const y of [0, part.size[1]]) for (const z of [0, part.size[2]]) {
    const w = toWorld(part, [x, y, z]);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], w[i]); max[i] = Math.max(max[i], w[i]); }
  }
  const mn = min.map(clean6) as Vec3, mx = max.map(clean6) as Vec3;
  return { min: mn, max: mx, size: [0, 1, 2].map((i) => clean6(mx[i] - mn[i])) as Vec3 };
}

/** Caja envolvente de varias piezas (con sus giros). */
export function boundsOf(parts: Pick<Part, 'position' | 'size' | 'rotX' | 'rotY' | 'rotZ'>[]): { min: Vec3; max: Vec3; size: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const b = partBounds(p);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); }
  }
  return { min, max, size: [0, 1, 2].map((i) => max[i] - min[i]) as Vec3 };
}

// ---------------------------------------------------------------- polígonos

export function signedArea(p: Pt2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s += p[i][0] * q[1] - q[0] * p[i][1]; }
  return s / 2;
}

/** Quita vértices repetidos seguidos y el que cierra el polígono repitiendo el primero. */
export function cleanProfile(profile: Pt2[]): Pt2[] {
  const out: Pt2[] = [];
  for (const p of profile) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > EPS) out.push([p[0], p[1]]);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= EPS) out.pop();
  return out;
}

/** Mismo polígono en sentido antihorario. */
export const ccw = (p: Pt2[]): Pt2[] => (signedArea(p) < 0 ? [...p].reverse() : p);

const orient = (a: Pt2, b: Pt2, c: Pt2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const onSeg = (a: Pt2, b: Pt2, p: Pt2) => Math.min(a[0], b[0]) - EPS <= p[0] && p[0] <= Math.max(a[0], b[0]) + EPS && Math.min(a[1], b[1]) - EPS <= p[1] && p[1] <= Math.max(a[1], b[1]) + EPS;
function segmentsCross(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
  const o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
  if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true;
  if (Math.abs(o1) <= EPS && onSeg(a, b, c)) return true;
  if (Math.abs(o2) <= EPS && onSeg(a, b, d)) return true;
  if (Math.abs(o3) <= EPS && onSeg(c, d, a)) return true;
  if (Math.abs(o4) <= EPS && onSeg(c, d, b)) return true;
  return false;
}

/** Índices (i, j) de dos lados que se cruzan o se tocan sin ser contiguos, o null si el polígono es simple. */
export function selfIntersection(p: Pt2[]): [number, number] | null {
  const n = p.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue; // lados contiguos comparten un vértice
      if (segmentsCross(p[i], p[(i + 1) % n], p[j], p[(j + 1) % n])) return [i, j];
    }
  }
  return null;
}

// ---------------------------------------------------------------- validación

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Valida una pieza (medidas, giro y parámetros de su forma). Devuelve el mensaje de error (en español, con el nombre de la pieza)
 * o null si es válida. Una pieza sin campos nuevos (caja sin giro) siempre es válida mientras sus medidas sean positivas.
 */
export function validatePart(part: Part): string | null {
  const who = `"${part.name}"`;
  if (!Array.isArray(part.size) || part.size.length !== 3 || part.size.some((v) => !fin(v) || v <= 0)) return `${who}: size debe ser [x, y, z] con números mayores que 0 (mm).`;
  if (!Array.isArray(part.position) || part.position.length !== 3 || part.position.some((v) => !fin(v))) return `${who}: position debe ser [x, y, z] con números finitos (mm).`;
  for (const k of ['rotX', 'rotY', 'rotZ'] as const) if (part[k] !== undefined && !fin(part[k])) return `${who}: ${k} debe ser un número finito (grados).`;
  const form = part.form ?? 'box';
  if (!FORMS.includes(form)) return `${who}: form "${String(part.form)}" no existe. Formas: ${FORMS.join(', ')}.`;
  if (part.axis !== undefined && !AXES.includes(part.axis)) return `${who}: axis debe ser "x", "y" o "z".`;
  if (part.segments !== undefined && (!Number.isInteger(part.segments) || part.segments < 8 || part.segments > 256)) return `${who}: segments debe ser un entero entre 8 y 256.`;
  if (part.wall !== undefined && (!fin(part.wall) || part.wall <= 0)) return `${who}: wall (espesor de pared) debe ser un número mayor que 0 (mm).`;
  if (part.cornerRadius !== undefined && (!fin(part.cornerRadius) || part.cornerRadius < 0)) return `${who}: cornerRadius debe ser un número mayor o igual que 0 (mm).`;

  for (const field of ['axis', 'wall', 'cornerRadius', 'profile', 'segments', 'mesh'] as const) {
    if (part[field] !== undefined && !FORM_FIELDS[form].includes(field)) {
      const forms = FORMS.filter((f) => FORM_FIELDS[f].includes(field));
      return `${who}: ${field} no se usa con form "${form}" (solo con: ${forms.join(', ')}).`;
    }
  }
  if (form !== 'box' && (part.shape || part.rebates?.length)) return `${who}: shape (recortes de pieza plana) y rebates solo existen en cajas; con form "${form}" quítalos.`;
  if (form === 'box') return null;
  if (form === 'mesh') return validateMesh(part.mesh, who);

  const axis = resolveAxis(part);
  const [ia, ib, ic] = localAxes(axis);
  const sa = part.size[ia], sb = part.size[ib], sc = part.size[ic];
  const minSide = Math.min(sa, sb);

  if (form === 'cylinder' || form === 'tube') {
    const w = part.wall;
    if (form === 'tube' && w === undefined) return `${who}: un tubo necesita wall (espesor de pared en mm), por ejemplo wall=3 para un perfil 50x50x3.`;
    if (w !== undefined && !(2 * w < minSide - EPS)) return `${who}: el espesor de pared (${w} mm) debe ser menor que la mitad del lado menor de la sección (${minSide / 2} mm); si no, no queda hueco.`;
    if (form === 'tube' && part.cornerRadius !== undefined && part.cornerRadius > minSide / 2 + EPS) return `${who}: cornerRadius (${part.cornerRadius} mm) no puede pasar de la mitad del lado menor (${minSide / 2} mm).`;
    return null;
  }

  // prism y revolve llevan perfil
  if (!Array.isArray(part.profile)) return `${who}: form "${form}" necesita profile: lista de puntos [x, y] en mm (mínimo 3), por ejemplo [[0,0],[400,0],[270,1800],[0,1800]].`;
  if (part.profile.length > MAX_PROFILE_POINTS) return `${who}: profile tiene ${part.profile.length} puntos; el máximo es ${MAX_PROFILE_POINTS}.`;
  if (part.profile.some((p) => !Array.isArray(p) || p.length !== 2 || !fin(p[0]) || !fin(p[1]))) return `${who}: cada punto de profile debe ser [x, y] con números finitos.`;
  const pr = cleanProfile(part.profile);
  if (pr.length < 3) return `${who}: profile necesita al menos 3 vértices distintos (tiene ${pr.length}).`;
  const cross = selfIntersection(pr);
  if (cross) return `${who}: profile se cruza o se toca a sí mismo (lados ${cross[0] + 1} y ${cross[1] + 1}); el polígono debe ser simple, sin autointersecciones.`;
  if (Math.abs(signedArea(pr)) < 1e-6) return `${who}: profile no encierra área (todos los puntos están alineados).`;
  const xs = pr.map((p) => p[0]), ys = pr.map((p) => p[1]);
  const eps = FIT_TOL;
  if (form === 'prism') {
    const mx = Math.max(...xs), my = Math.max(...ys);
    if (Math.min(...xs) < -eps || Math.min(...ys) < -eps) return `${who}: profile tiene coordenadas negativas; el origen del perfil es la esquina mínima de la caja (0,0).`;
    if (mx > sa + eps || my > sb + eps) return `${who}: profile mide hasta ${clean6(mx)}×${clean6(my)} mm y se sale de la caja envolvente (${sa}×${sb} mm en las direcciones ${AXES[ia]}, ${AXES[ib]}); agranda size o corrige el perfil.`;
    return null;
  }
  // revolve: x = r (≥ 0), y = h a lo largo del eje
  if (Math.min(...xs) < -eps) return `${who}: en revolve cada punto es [r, h] y r (distancia al eje) no puede ser negativa.`;
  if (Math.min(...ys) < -eps || Math.max(...ys) > sc + eps) return `${who}: profile tiene h entre ${clean6(Math.min(...ys))} y ${clean6(Math.max(...ys))} mm pero el largo sobre el eje ${AXES[axis]} es ${sc} mm; h debe estar entre 0 y ${sc}.`;
  if (2 * Math.max(...xs) > minSide + eps) return `${who}: el radio máximo del perfil es ${clean6(Math.max(...xs))} mm (diámetro ${clean6(2 * Math.max(...xs))}) y no cabe en la sección de la caja (${sa}×${sb} mm); agranda size.`;
  return null;
}

// ---------------------------------------------------------------- normalización

/**
 * Deja la pieza en su forma canónica: sin giros en 0, sin form "box", sin parámetros que no corresponden a su forma y con el perfil limpio.
 * Una caja sin giro queda con exactamente los mismos campos que tenía antes de existir las formas (así los proyectos viejos no cambian al guardarse).
 */
export function normalizePart(part: Part): Part {
  for (const k of ['rotX', 'rotY', 'rotZ'] as const) if (!part[k]) delete part[k];
  if (part.form === 'box' || part.form === undefined) {
    for (const k of ['form', 'axis', 'wall', 'cornerRadius', 'profile', 'segments', 'mesh'] as const) delete part[k];
    return part;
  }
  if (part.profile) part.profile = cleanProfile(part.profile);
  if (part.cornerRadius === 0) delete part.cornerRadius;
  if (part.segments === DEFAULT_SEGMENTS) delete part.segments;
  return part;
}

// ---------------------------------------------------------------- geometría de los sólidos

/** Describe la geometría de un sólido para el visor: sección extruida (cilindro, tubo, prisma) o perfil de revolución. */
export type SolidSpec =
  | { kind: 'extrude'; axis: 0 | 1 | 2; sa: number; sb: number; sc: number; outer: Pt2[]; holes: Pt2[][] }
  | { kind: 'revolve'; axis: 0 | 1 | 2; sa: number; sb: number; sc: number; profile: Pt2[]; segments: number };

const segs = (part: Pick<Part, 'segments'>) => Math.max(8, Math.min(256, part.segments ?? DEFAULT_SEGMENTS));

/** Elipse (círculo si sa = sb) centrada en la caja, antihoraria, con n lados. */
export function ellipseRing(cx: number, cy: number, ra: number, rb: number, n: number): Pt2[] {
  return Array.from({ length: n }, (_, k) => { const t = (2 * Math.PI * k) / n; return [cx + ra * Math.cos(t), cy + rb * Math.sin(t)] as Pt2; });
}

/** Rectángulo (x0,y0)-(x0+w, y0+h) con esquinas de radio r, antihorario; n pasos por esquina. */
export function roundedRect(x0: number, y0: number, w: number, h: number, r: number, n: number): Pt2[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rr < 1e-9) return [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
  const out: Pt2[] = [];
  const corners: [number, number, number][] = [[x0 + rr, y0 + rr, Math.PI], [x0 + w - rr, y0 + rr, 1.5 * Math.PI], [x0 + w - rr, y0 + h - rr, 0], [x0 + rr, y0 + h - rr, 0.5 * Math.PI]];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= n; k++) { const a = a0 + (Math.PI / 2) * (k / n); out.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); }
  }
  return out;
}

/** Geometría de un sólido (nunca para cajas). Supone que la pieza ya pasó validatePart. */
export function solidSpec(part: Part): SolidSpec | null {
  const form = formOf(part);
  if (form === 'box' || form === 'mesh') return null; // la malla se arma aparte (buildMeshGeometry)
  const axis = resolveAxis(part);
  const [ia, ib, ic] = localAxes(axis);
  const sa = part.size[ia], sb = part.size[ib], sc = part.size[ic];
  const n = segs(part);
  if (form === 'revolve') return { kind: 'revolve', axis, sa, sb, sc, profile: ccw(cleanProfile(part.profile ?? [])), segments: n };
  let outer: Pt2[], holes: Pt2[][] = [];
  if (form === 'cylinder') {
    outer = ellipseRing(sa / 2, sb / 2, sa / 2, sb / 2, n);
    if (part.wall) holes = [ellipseRing(sa / 2, sb / 2, sa / 2 - part.wall, sb / 2 - part.wall, n)];
  } else if (form === 'tube') {
    const r = part.cornerRadius ?? 0, w = part.wall ?? 1, steps = Math.max(2, Math.round(n / 8));
    outer = roundedRect(0, 0, sa, sb, r, steps);
    holes = [roundedRect(w, w, sa - 2 * w, sb - 2 * w, Math.max(0, r - w), steps)];
  } else outer = ccw(cleanProfile(part.profile ?? []));
  return { kind: 'extrude', axis, sa, sb, sc, outer, holes };
}

// ---------------------------------------------------------------- volumen y descripción

/** Volumen real de la pieza en mm³ (analítico, no el de la malla). Una caja: size[0]·size[1]·size[2]. */
export function partVolume(part: Part): number {
  const form = formOf(part);
  if (form === 'box') return part.size[0] * part.size[1] * part.size[2];
  if (form === 'mesh') return part.mesh ? meshVolume(part.mesh) * (part.size[0] / part.mesh.bbox[0]) * (part.size[1] / part.mesh.bbox[1]) * (part.size[2] / part.mesh.bbox[2]) : 0;
  const [ia, ib, ic] = localAxes(resolveAxis(part));
  const sa = part.size[ia], sb = part.size[ib], sc = part.size[ic];
  const w = part.wall ?? 0;
  if (form === 'cylinder') return (Math.PI / 4) * (sa * sb - (w ? (sa - 2 * w) * (sb - 2 * w) : 0)) * sc;
  if (form === 'tube') {
    const r = Math.max(0, Math.min(part.cornerRadius ?? 0, sa / 2, sb / 2));
    const ri = Math.max(0, r - w);
    const area = sa * sb - (4 - Math.PI) * r * r - ((sa - 2 * w) * (sb - 2 * w) - (4 - Math.PI) * ri * ri);
    return area * sc;
  }
  const pr = cleanProfile(part.profile ?? []);
  if (form === 'prism') return Math.abs(signedArea(pr)) * sc;
  // revolve: teorema de Pappus, V = 2π · (∫ r dA)
  let ir = 0;
  for (let i = 0; i < pr.length; i++) { const p = pr[i], q = pr[(i + 1) % pr.length]; ir += (p[0] + q[0]) * (p[0] * q[1] - q[0] * p[1]); }
  return 2 * Math.PI * Math.abs(ir / 6);
}

const n1 = (v: number) => String(Math.round(v * 100) / 100);

/** Texto corto de la forma: "tubo 50×50×3, largo 1000", "cilindro Ø120 × 20"... Las cajas devuelven "caja". */
export function describeSolid(part: Part): string {
  const form = formOf(part);
  if (form === 'box') return 'caja';
  if (form === 'mesh') return part.mesh ? `malla de ${part.mesh.triangles} triángulos (${part.mesh.vertices} vértices), caja ${n1(part.size[0])}×${n1(part.size[1])}×${n1(part.size[2])}` : 'malla vacía';
  const [ia, ib, ic] = localAxes(resolveAxis(part));
  const sa = part.size[ia], sb = part.size[ib], sc = part.size[ic];
  if (form === 'tube') return `tubo ${n1(sa)}×${n1(sb)}×${n1(part.wall ?? 0)}${part.cornerRadius ? ` (R${n1(part.cornerRadius)})` : ''}, largo ${n1(sc)}`;
  if (form === 'cylinder') return `${part.wall ? 'tubo redondo' : 'cilindro'} ${sa === sb ? `Ø${n1(sa)}` : `${n1(sa)}×${n1(sb)}`}${part.wall ? `×${n1(part.wall)}` : ''}, largo ${n1(sc)}`;
  if (form === 'prism') return `prisma de ${part.profile?.length ?? 0} vértices, caja ${n1(sa)}×${n1(sb)}, largo ${n1(sc)}`;
  return `revolución de ${part.profile?.length ?? 0} puntos, Ø${n1(Math.max(...(part.profile ?? [[0, 0]]).map((p) => p[0])) * 2)}, largo ${n1(sc)}`;
}

export interface SolidRow {
  form: SolidForm;
  material: string;
  description: string;
  /** Medidas de la caja envolvente (ordenadas de mayor a menor) en mm. */
  box: Vec3;
  qty: number;
  names: string[];
  /** Volumen real de una unidad en cm³. */
  volumeCm3: number;
  /** Volumen real total en cm³. */
  totalCm3: number;
}

/** Lista de sólidos (piezas con form distinta de caja) agrupados por material y forma. No entran al despiece de planchas. */
export function solidsList(parts: Part[]): SolidRow[] {
  const rows = new Map<string, SolidRow>();
  for (const p of parts) {
    if (!isSolid(p)) continue;
    const description = describeSolid(p);
    const box = [...p.size].sort((a, b) => b - a) as Vec3;
    const key = `${p.material}|${description}|${box.join('x')}|${p.profile ? JSON.stringify(p.profile) : ''}|${p.mesh?.hash ?? ''}`;
    const vol = partVolume(p) / 1000;
    const row = rows.get(key) ?? { form: formOf(p), material: p.material, description, box, qty: 0, names: [], volumeCm3: Math.round(vol * 100) / 100, totalCm3: 0 };
    row.qty++;
    row.names.push(p.name);
    row.totalCm3 = Math.round(vol * row.qty * 100) / 100;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.material.localeCompare(b.material) || a.description.localeCompare(b.description));
}
