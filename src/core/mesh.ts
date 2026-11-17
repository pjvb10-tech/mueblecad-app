import type { MeshData, Vec3 } from './types';

/**
 * Mallas de triángulos como datos de una pieza (form 'mesh'). Matemática pura, sin three.js ni Buffer: funciona igual en Node y en el navegador.
 * Almacenamiento: Float32 + Uint32 en base64 DENTRO de la pieza (project.json). Ver docs/formas.md, sección Mallas.
 */

/** Tope de triángulos por pieza. Por encima se rechaza o se decima (ver decimateMesh). */
export const MAX_MESH_TRIANGLES = 200_000;
const FIT_TOL = 0.01;

// ---------------------------------------------------------------- base64

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_REV = (() => { const t = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i; return t; })();

export function bytesToBase64(b: Uint8Array): string {
  const out: string[] = [];
  let chunk = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    chunk += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < b.length ? B64[n & 63] : '=');
    if (chunk.length >= 32768) { out.push(chunk); chunk = ''; }
  }
  out.push(chunk);
  return out.join('');
}

/** Bytes que codifica una cadena base64 (sin decodificar), o -1 si la longitud no es válida. */
export function base64ByteLength(s: string): number {
  if (s.length % 4 !== 0) return -1;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return (s.length / 4) * 3 - pad;
}

export function base64ToBytes(s: string): Uint8Array {
  const len = base64ByteLength(s);
  if (len < 0) throw new Error('base64 inválido (longitud).');
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => (s[i + k] === '=' ? 0 : (s.charCodeAt(i + k) < 128 ? B64_REV[s.charCodeAt(i + k)] : -1)));
    if (v.some((x) => x < 0)) throw new Error('base64 inválido (caracteres).');
    const n = (v[0] << 18) | (v[1] << 12) | (v[2] << 6) | v[3];
    if (o < len) out[o++] = (n >> 16) & 255;
    if (o < len) out[o++] = (n >> 8) & 255;
    if (o < len) out[o++] = n & 255;
  }
  return out;
}

function fnv(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}
const hashOf = (positions: string, indices: string) => fnv(fnv(2166136261, positions), indices).toString(16).padStart(8, '0');

// ---------------------------------------------------------------- codificación

export interface RawMesh { positions: Float32Array; indices: Uint32Array }

/** Caja mínima/máxima de un arreglo xyz. */
export function bboxOf(pos: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < pos.length; i += 3) for (let k = 0; k < 3; k++) { const v = pos[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  return { min, max };
}

/**
 * Codifica una malla (vértices en mm, cualquier origen) como MeshData: traslada para que la caja quede en [0, bbox].
 * Devuelve también el desplazamiento aplicado (esquina mínima original). Lanza si está vacía, tiene valores no finitos,
 * índices fuera de rango o pasa del tope de triángulos.
 */
export function encodeMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, maxTriangles = MAX_MESH_TRIANGLES): { mesh: MeshData; min: Vec3 } {
  if (positions.length % 3 !== 0 || indices.length % 3 !== 0) throw new Error('Malla inválida: positions e indices deben ser múltiplos de 3.');
  const nv = positions.length / 3, nt = indices.length / 3;
  if (nv < 3 || nt < 1) throw new Error('La malla no tiene triángulos.');
  if (nt > maxTriangles) throw new Error(`La malla tiene ${nt} triángulos y el máximo es ${maxTriangles}; usa la opción de decimar o exporta una versión más liviana.`);
  for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new Error('La malla tiene coordenadas no finitas (NaN/Infinity).');
  for (let i = 0; i < indices.length; i++) if (!(indices[i] >= 0 && indices[i] < nv && Number.isInteger(indices[i]))) throw new Error(`La malla tiene un índice fuera de rango (${indices[i]}; hay ${nv} vértices).`);
  const { min, max } = bboxOf(positions);
  const bbox = [0, 1, 2].map((k) => Math.round((max[k] - min[k]) * 1e4) / 1e4) as Vec3;
  if (bbox.some((v) => !(v > 0))) throw new Error('La malla es plana o degenerada (alguna dimensión de su caja es 0).');
  const f = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) f[i + k] = positions[i + k] - min[k];
  const u = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) u[i] = indices[i];
  const p64 = bytesToBase64(new Uint8Array(f.buffer)), i64 = bytesToBase64(new Uint8Array(u.buffer));
  return { mesh: { vertices: nv, triangles: nt, bbox, positions: p64, indices: i64, hash: hashOf(p64, i64) }, min };
}

const decoded = new Map<string, RawMesh>();
/** Decodifica una malla (con caché pequeña por huella: el visor y las validaciones la piden muchas veces). */
export function decodeMesh(m: MeshData): RawMesh {
  const key = `${m.hash}:${m.positions.length}:${m.indices.length}`;
  const hit = decoded.get(key);
  if (hit) return hit;
  const pb = base64ToBytes(m.positions), ib = base64ToBytes(m.indices);
  // copia a buffers alineados
  const positions = new Float32Array(pb.buffer.slice(pb.byteOffset, pb.byteOffset + pb.byteLength));
  const indices = new Uint32Array(ib.buffer.slice(ib.byteOffset, ib.byteOffset + ib.byteLength));
  if (decoded.size >= 6) decoded.delete(decoded.keys().next().value as string);
  const r = { positions, indices };
  decoded.set(key, r);
  return r;
}

// ---------------------------------------------------------------- validación

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const deepOk = new Set<string>();

/** Valida un MeshData (estructura, tamaños, índices, finitud y que la caja nativa coincida). Mensaje de error en español o null. */
export function validateMesh(m: unknown, who = 'la malla'): string | null {
  const x = m as MeshData | undefined;
  if (!x || typeof x !== 'object') return `${who}: falta mesh (los datos de la malla).`;
  if (!Number.isInteger(x.vertices) || !Number.isInteger(x.triangles) || x.vertices < 3 || x.triangles < 1) return `${who}: mesh.vertices y mesh.triangles deben ser enteros positivos.`;
  if (x.triangles > MAX_MESH_TRIANGLES) return `${who}: la malla tiene ${x.triangles} triángulos; el máximo es ${MAX_MESH_TRIANGLES} (decímala al importar).`;
  if (!Array.isArray(x.bbox) || x.bbox.length !== 3 || x.bbox.some((v) => !fin(v) || v <= 0)) return `${who}: mesh.bbox debe ser [x, y, z] mayores que 0.`;
  if (typeof x.positions !== 'string' || typeof x.indices !== 'string' || typeof x.hash !== 'string') return `${who}: mesh.positions, mesh.indices y mesh.hash deben ser texto (base64).`;
  if (base64ByteLength(x.positions) !== x.vertices * 12) return `${who}: mesh.positions no coincide con ${x.vertices} vértices (Float32 xyz).`;
  if (base64ByteLength(x.indices) !== x.triangles * 12) return `${who}: mesh.indices no coincide con ${x.triangles} triángulos (Uint32 x3).`;
  const key = `${x.hash}:${x.positions.length}:${x.indices.length}`;
  if (deepOk.has(key)) return null;
  let raw: RawMesh;
  try { raw = decodeMesh(x); } catch (e) { return `${who}: ${(e as Error).message}`; }
  for (let i = 0; i < raw.positions.length; i++) if (!Number.isFinite(raw.positions[i])) return `${who}: hay coordenadas no finitas en la malla.`;
  for (let i = 0; i < raw.indices.length; i++) if (raw.indices[i] >= x.vertices) return `${who}: un índice de triángulo (${raw.indices[i]}) apunta fuera de los ${x.vertices} vértices.`;
  const { min, max } = bboxOf(raw.positions);
  for (let k = 0; k < 3; k++) if (min[k] < -FIT_TOL || max[k] > x.bbox[k] + FIT_TOL) return `${who}: los vértices se salen de mesh.bbox (deben quedar entre 0 y bbox).`;
  if (deepOk.size > 200) deepOk.clear();
  deepOk.add(key);
  return null;
}

// ---------------------------------------------------------------- volumen y resumen

/** Volumen firmado (mm³) de la malla nativa, en valor absoluto. Exacto si es cerrada; aproximado si tiene huecos. */
export function meshVolume(m: MeshData): number {
  const { positions: p, indices: t } = decodeMesh(m);
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return Math.abs(v / 6);
}

/** Resumen para listas y el MCP: sin datos de vértices. */
export function meshSummary(m: MeshData): { vertices: number; triangles: number; bbox: Vec3; hash: string; kb: number } {
  return { vertices: m.vertices, triangles: m.triangles, bbox: m.bbox, hash: m.hash, kb: Math.round((m.positions.length + m.indices.length) / 1024) };
}

// ---------------------------------------------------------------- limpieza y decimación

/** Quita triángulos degenerados (dos índices iguales o área 0) y compacta los vértices sin uso. */
export function cleanMesh(positions: ArrayLike<number>, indices: ArrayLike<number>): { positions: number[]; indices: number[] } {
  const remap = new Int32Array(positions.length / 3).fill(-1);
  const pos: number[] = [], idx: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    if (a === b || b === c || a === c) continue;
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-12) continue;
    for (const v of [a, b, c]) {
      if (remap[v] < 0) { remap[v] = pos.length / 3; pos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]); }
      idx.push(remap[v]);
    }
  }
  return { positions: pos, indices: idx };
}

/** Suelda vértices coincidentes (redondeados a `tol` mm). Mantiene los triángulos; luego conviene cleanMesh. */
export function weldMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, tol = 1e-3): { positions: number[]; indices: number[] } {
  const map = new Map<string, number>();
  const pos: number[] = [], rem = new Int32Array(positions.length / 3);
  for (let i = 0; i < rem.length; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const key = `${Math.round(x / tol)},${Math.round(y / tol)},${Math.round(z / tol)}`;
    let id = map.get(key);
    if (id === undefined) { id = pos.length / 3; map.set(key, id); pos.push(x, y, z); }
    rem[i] = id;
  }
  const idx: number[] = new Array(indices.length);
  for (let i = 0; i < indices.length; i++) idx[i] = rem[indices[i]];
  return { positions: pos, indices: idx };
}

/**
 * Decimación simple por agrupación de vértices en una rejilla (vertex clustering): busca la rejilla más fina cuyo resultado
 * tenga como máximo `target` triángulos. Es burda (pierde detalle fino y puede cerrar huecos) pero estable, rápida y sin dependencias.
 */
export function decimateMesh(positions: ArrayLike<number>, indices: ArrayLike<number>, target: number): { positions: number[]; indices: number[] } {
  const { min, max } = bboxOf(positions);
  const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const run = (n: number) => {
    const cell = ext / n, map = new Map<number, number>();
    const sum: number[] = [], cnt: number[] = [];
    const rem = new Int32Array(positions.length / 3);
    for (let i = 0; i < rem.length; i++) {
      const ix = Math.min(n - 1, Math.floor((positions[i * 3] - min[0]) / cell)), iy = Math.min(n - 1, Math.floor((positions[i * 3 + 1] - min[1]) / cell)), iz = Math.min(n - 1, Math.floor((positions[i * 3 + 2] - min[2]) / cell));
      const key = (ix * n + iy) * n + iz;
      let id = map.get(key);
      if (id === undefined) { id = cnt.length; map.set(key, id); cnt.push(0); sum.push(0, 0, 0); }
      cnt[id]++; sum[id * 3] += positions[i * 3]; sum[id * 3 + 1] += positions[i * 3 + 1]; sum[id * 3 + 2] += positions[i * 3 + 2];
      rem[i] = id;
    }
    const pos = cnt.flatMap((c, i) => [sum[i * 3] / c, sum[i * 3 + 1] / c, sum[i * 3 + 2] / c]);
    const idx: number[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < indices.length; i += 3) {
      const a = rem[indices[i]], b = rem[indices[i + 1]], c = rem[indices[i + 2]];
      if (a === b || b === c || a === c) continue;
      const k = [a, b, c].sort((x, y) => x - y).join(',');
      if (seen.has(k)) continue;
      seen.add(k);
      idx.push(a, b, c);
    }
    return { positions: pos, indices: idx };
  };
  let lo = 1, hi = 2048, best = run(1);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const r = run(mid);
    if (r.indices.length / 3 <= target) { lo = mid; best = r; } else hi = mid - 1;
  }
  return cleanMesh(best.positions, best.indices);
}
