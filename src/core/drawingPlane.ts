import type { Drawing, DrawingPlane, Pt2, Vec3 } from './types';

/**
 * Ubicación del plano de un dibujo en el 3D (x derecha, y arriba, z hacia el frente; mano derecha). Un punto (u, v) del dibujo va a
 *   mundo = origin + u·U + v·V
 *   xy: U = +X, V = +Y, normal +Z  (alzado frontal visto desde +Z)
 *   xz: U = +X, V = -Z, normal +Y  (PLANTA vista desde arriba: "arriba" del papel = hacia el muro del fondo, z menor)
 *   yz: U = -Z, V = +Y, normal +X  (alzado lateral visto desde +X)
 * En los tres casos U × V = normal, así que no hay espejos y extruir con profundidad positiva va hacia +normal.
 */
export const PLANE_BASIS: Record<DrawingPlane, { U: Vec3; V: Vec3; N: Vec3; /** índice del eje (0=X,1=Y,2=Z) de la normal */ normalAxis: 0 | 1 | 2 }> = {
  xy: { U: [1, 0, 0], V: [0, 1, 0], N: [0, 0, 1], normalAxis: 2 },
  xz: { U: [1, 0, 0], V: [0, 0, -1], N: [0, 1, 0], normalAxis: 1 },
  yz: { U: [0, 0, -1], V: [0, 1, 0], N: [1, 0, 0], normalAxis: 0 },
};
export const PLANES: DrawingPlane[] = ['xy', 'xz', 'yz'];

/** Punto (u, v) del dibujo -> punto 3D del mundo (mm). */
export function drawingToWorld(d: Pick<Drawing, 'plane' | 'origin'>, p: Pt2): Vec3 {
  const { U, V } = PLANE_BASIS[d.plane];
  return [0, 1, 2].map((i) => d.origin[i] + p[0] * U[i] + p[1] * V[i]) as Vec3;
}

/** Punto 3D del mundo -> (u, v) del dibujo (se ignora la componente fuera del plano). */
export function worldToDrawing(d: Pick<Drawing, 'plane' | 'origin'>, w: Vec3): Pt2 {
  const { U, V } = PLANE_BASIS[d.plane];
  const r = [w[0] - d.origin[0], w[1] - d.origin[1], w[2] - d.origin[2]];
  return [r[0] * U[0] + r[1] * U[1] + r[2] * U[2], r[0] * V[0] + r[1] * V[1] + r[2] * V[2]];
}
