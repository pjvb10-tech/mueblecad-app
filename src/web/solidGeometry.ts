import * as THREE from 'three';
import { localAxes, type SolidSpec } from '../core/solids';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { decodeMesh } from '../core/mesh';
import type { MeshData, Pt2 } from '../core/types';

/** Ángulo máximo entre dos lados contiguos para suavizar la normal entre ellos (curvas); por encima es una arista viva. */
const SMOOTH_COS = Math.cos((35 * Math.PI) / 180);

/** Normales exteriores unitarias de cada lado (i -> i+1) de un anillo cuyo "exterior del sólido" queda a la derecha del recorrido. */
function edgeNormals(ring: Pt2[]): Pt2[] {
  return ring.map((p, i) => {
    const q = ring[(i + 1) % ring.length];
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
    return [dy / len, -dx / len] as Pt2;
  });
}

/** Normal de cada extremo de cada lado: promedio con el vecino si la arista es suave, o la propia del lado si es viva. `skip[i]` = lado que no se dibuja. */
function cornerNormals(ring: Pt2[], skip: boolean[] = []): { start: Pt2[]; end: Pt2[] } {
  const n = ring.length, en = edgeNormals(ring);
  const blend = (a: Pt2, b: Pt2): Pt2 => {
    if (a[0] * b[0] + a[1] * b[1] < SMOOTH_COS) return a;
    const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  };
  const start: Pt2[] = [], end: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i + n - 1) % n, next = (i + 1) % n;
    start.push(skip[prev] ? en[i] : blend(en[i], en[prev]));
    end.push(skip[next] ? en[i] : blend(en[i], en[next]));
  }
  return { start, end };
}

/**
 * Malla de un sólido (SolidSpec) con las curvas suavizadas y las aristas vivas marcadas, en coordenadas del MUNDO
 * relativas al CENTRO de la caja envolvente (sin giro). Las coordenadas locales (a, b, c) se pasan a (X, Y, Z) con
 * una permutación cíclica, que conserva la orientación de las caras.
 */
export function buildSolidGeometry(spec: SolidSpec): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  const [ia, ib, ic] = localAxes(spec.axis);
  const half = [0, 0, 0];
  half[ia] = spec.sa / 2; half[ib] = spec.sb / 2; half[ic] = spec.sc / 2;
  /** Agrega un vértice en coordenadas locales (a, b, c) con su normal local. */
  const vtx = (a: number, b: number, c: number, na: number, nb: number, nc: number) => {
    const p = [0, 0, 0], n = [0, 0, 0];
    p[ia] = a; p[ib] = b; p[ic] = c;
    n[ia] = na; n[ib] = nb; n[ic] = nc;
    pos.push(p[0] - half[0], p[1] - half[1], p[2] - half[2]);
    nrm.push(n[0], n[1], n[2]);
    return pos.length / 3 - 1;
  };

  if (spec.kind === 'extrude') {
    const rings = [spec.outer, ...spec.holes.map((h) => orient(h, false))];
    const L = spec.sc;
    for (const ring of rings) {
      const cn = cornerNormals(ring);
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const s = cn.start[i], e = cn.end[i];
        const a0 = vtx(p[0], p[1], 0, s[0], s[1], 0), b0 = vtx(q[0], q[1], 0, e[0], e[1], 0);
        const b1 = vtx(q[0], q[1], L, e[0], e[1], 0), a1 = vtx(p[0], p[1], L, s[0], s[1], 0);
        idx.push(a0, b0, b1, a0, b1, a1);
      }
    }
    // tapas: triangulación con huecos; cada triángulo se orienta hacia afuera de la tapa
    const all = [...spec.outer, ...spec.holes.flatMap((h) => orient(h, false))];
    const tris = THREE.ShapeUtils.triangulateShape(spec.outer.map(([x, y]) => new THREE.Vector2(x, y)), spec.holes.map((h) => orient(h, false).map(([x, y]) => new THREE.Vector2(x, y))));
    for (const top of [false, true]) {
      const base = new Map<number, number>();
      const at = (k: number) => {
        let v = base.get(k);
        if (v === undefined) { v = vtx(all[k][0], all[k][1], top ? L : 0, 0, 0, top ? 1 : -1); base.set(k, v); }
        return v;
      };
      for (const [i, j, k] of tris) {
        const cross = (all[j][0] - all[i][0]) * (all[k][1] - all[i][1]) - (all[j][1] - all[i][1]) * (all[k][0] - all[i][0]);
        const ccw = cross > 0;
        if (top === ccw) idx.push(at(i), at(j), at(k)); else idx.push(at(i), at(k), at(j));
      }
    }
  } else {
    const pr = spec.profile, n = pr.length, N = spec.segments;
    const onAxis = (p: Pt2) => Math.abs(p[0]) < 1e-9;
    const skip = pr.map((p, i) => onAxis(p) && onAxis(pr[(i + 1) % n]));
    const cn = cornerNormals(pr, skip);
    const cx = spec.sa / 2, cy = spec.sb / 2;
    for (let i = 0; i < n; i++) {
      if (skip[i]) continue;
      const P = pr[i], Q = pr[(i + 1) % n], s = cn.start[i], e = cn.end[i];
      const ps: number[] = [], qs: number[] = [];
      for (let k = 0; k <= N; k++) {
        const t = (2 * Math.PI * k) / N, c = Math.cos(t), sn = Math.sin(t);
        ps.push(vtx(cx + P[0] * c, cy + P[0] * sn, P[1], s[0] * c, s[0] * sn, s[1]));
        qs.push(vtx(cx + Q[0] * c, cy + Q[0] * sn, Q[1], e[0] * c, e[0] * sn, e[1]));
      }
      for (let k = 0; k < N; k++) {
        if (!onAxis(P)) idx.push(ps[k], ps[k + 1], qs[k]);
        if (!onAxis(Q)) idx.push(ps[k + 1], qs[k + 1], qs[k]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/**
 * Geometría de una malla importada (form 'mesh'): vértices centrados en el centro de su caja NATIVA (mesh.bbox) y normales con
 * aristas vivas por encima de 35° (suave en curvas). Si la pieza tiene otro `size`, el visor la escala con mesh.scale = size / bbox.
 */
export function buildMeshGeometry(m: MeshData): THREE.BufferGeometry {
  const { positions, indices } = decodeMesh(m);
  const p = new Float32Array(positions.length);
  for (let i = 0; i < p.length; i += 3) { p[i] = positions[i] - m.bbox[0] / 2; p[i + 1] = positions[i + 1] - m.bbox[1] / 2; p[i + 2] = positions[i + 2] - m.bbox[2] / 2; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setIndex(new THREE.BufferAttribute(indices.slice(), 1));
  const out = toCreasedNormals(g, (35 * Math.PI) / 180);
  g.dispose();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** Anillo en el sentido pedido (antihorario o no). */
function orient(ring: Pt2[], counterClockwise: boolean): Pt2[] {
  let s = 0;
  for (let i = 0; i < ring.length; i++) { const q = ring[(i + 1) % ring.length]; s += ring[i][0] * q[1] - q[0] * ring[i][1]; }
  return (s > 0) === counterClockwise ? ring : [...ring].reverse();
}
