import type { Part, Vec3 } from './types';
import { MAX_MESH_TRIANGLES, bboxOf, cleanMesh, decimateMesh, encodeMesh, weldMesh } from './mesh';

/**
 * Importación de modelos 3D (OBJ, STL binario/ASCII, glTF/GLB) como piezas form 'mesh'. Capa pura: sin DOM, sin three.js,
 * sin dependencias (parsers propios), así funciona igual en Node (MCP, tests) y en el navegador (diálogo "Importar modelo 3D").
 *
 * SketchUp (.skp es propietario y no se lee): Archivo > Exportar > Modelo 3D > OBJ / STL / glTF / COLLADA (COLLADA no está soportado; usa OBJ).
 * SketchUp suele exportar en pulgadas (OBJ/STL según la opción "Unidades") o metros (glTF), con Z arriba.
 */

export type MeshFormat = 'obj' | 'stl' | 'gltf' | 'glb';
export type MeshUnit = 'mm' | 'cm' | 'm' | 'in' | 'ft';
export const MESH_UNITS: Record<MeshUnit, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

export interface ImportMeshOptions {
  /** Si falta se deduce de la cabecera/nombre del archivo (`nombreArchivo`) o del contenido. */
  formato?: MeshFormat;
  /** Nombre del archivo original, solo para deducir el formato por extensión. */
  nombreArchivo?: string;
  /** Unidad de los números del archivo. Si falta: glTF = m; OBJ/STL se deduce por tamaño (ver detectUnit) y se avisa. */
  unidad?: MeshUnit;
  /** Eje que apunta hacia arriba en el archivo (por omisión 'y'; glTF siempre es 'y'). 'z' (SketchUp, CAD) se gira a nuestro Y arriba. */
  ejeArriba?: 'y' | 'z';
  /** Factor extra de escala (1 por omisión), después de la unidad. */
  escala?: number;
  /** Nombre de la pieza (si hay varias: "nombre - objeto"). Por omisión el nombre del archivo o "Modelo". */
  nombre?: string;
  /** Material de las piezas (id). Por omisión 'mel18'; el llamador debe comprobar que exista. */
  material?: string;
  /** 'objetos' (por omisión): una pieza por objeto/grupo del archivo. 'uno': todo en una sola pieza. */
  separar?: 'objetos' | 'uno';
  /** Soldar vértices coincidentes (por omisión true en STL, que viene "suelto"; false en OBJ/glTF). */
  soldar?: boolean;
  /** Mueve el conjunto para que su esquina mínima quede en `posicion` (por omisión true). Si false se conservan las coordenadas del archivo. */
  centrar?: boolean;
  /** Dónde queda la esquina mínima del conjunto (mm). Por omisión [0, 0, 0]. */
  posicion?: Vec3;
  /** Si una pieza pasa del tope de triángulos: true la decima (burda), false (omisión) lanza error. */
  decimar?: boolean;
  /** Tope de triángulos por pieza (por omisión MAX_MESH_TRIANGLES = 200 000). */
  maxTriangulos?: number;
  /** Grupo (mueble) al que pertenecen las piezas. */
  grupo?: string;
}

export interface ImportMeshResult {
  /** Piezas listas para agregar al proyecto: `id` es provisorio ("mesh1"...); el llamador asigna los reales. */
  parts: Part[];
  unidad: MeshUnit;
  unidadDetectada: boolean;
  avisos: string[];
}

interface RawObject { name: string; pos: number[]; idx: number[] }

/** Unidad probable según la dimensión mayor del archivo (si el usuario no la da): <=20 m, <=500 cm, si no mm. Solo una heurística: se avisa. */
export function detectUnit(maxDim: number): MeshUnit {
  return maxDim <= 20 ? 'm' : maxDim <= 500 ? 'cm' : 'mm';
}

// ---------------------------------------------------------------- formato

const dec = (b: Uint8Array, from = 0, to = b.length) => new TextDecoder('utf-8').decode(b.subarray(from, to));

export function detectFormat(data: Uint8Array, fileName?: string): MeshFormat {
  const ext = fileName?.toLowerCase().match(/\.(obj|stl|gltf|glb)$/)?.[1] as MeshFormat | undefined;
  if (ext) return ext;
  if (data.length >= 4 && dec(data, 0, 4) === 'glTF') return 'glb';
  const head = dec(data, 0, Math.min(data.length, 400)).trimStart();
  if (head.startsWith('{')) return 'gltf';
  if (data.length >= 84) {
    const n = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(80, true);
    if (84 + n * 50 === data.length) return 'stl';
  }
  if (head.startsWith('solid')) return 'stl';
  if (/^\s*(#|v |vn |o |g |mtllib)/m.test(head)) return 'obj';
  throw new Error('No se reconoce el formato del modelo (admitidos: .obj, .stl, .gltf, .glb). Indica formato.');
}

// ---------------------------------------------------------------- OBJ

export function parseObj(text: string, split = true): RawObject[] {
  const v: number[] = [];
  const objs: RawObject[] = [];
  let pendingName = '';
  const faces: Map<object, number[]> = new Map();
  const open = (name: string) => { const o = { name, pos: [] as number[], idx: [] as number[] }; objs.push(o); faces.set(o, []); return o; };
  let obj: RawObject | null = null;
  const nv = () => v.length / 3;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const t = line.split(/\s+/);
    const k = t[0];
    if (k === 'v') {
      const x = parseFloat(t[1]), y = parseFloat(t[2]), z = parseFloat(t[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('OBJ: vértice con números inválidos: ' + line.slice(0, 60));
      v.push(x, y, z);
    } else if (k === 'o' || k === 'g') {
      pendingName = t.slice(1).join(' ') || pendingName;
      if (split) obj = null;
    } else if (k === 'f') {
      if (!obj) obj = open(split ? pendingName || `Objeto ${objs.length + 1}` : 'Modelo');
      const ids = t.slice(1).map((s) => {
        const i = parseInt(s.split('/')[0], 10);
        const r = i < 0 ? nv() + i : i - 1;
        if (!(r >= 0 && r < nv())) throw new Error(`OBJ: la cara apunta al vértice ${i} que no existe.`);
        return r;
      });
      const f = faces.get(obj)!;
      for (let j = 1; j + 1 < ids.length; j++) f.push(ids[0], ids[j], ids[j + 1]);
    }
  }
  // cada objeto se queda con los vértices que usa
  for (const o of objs) {
    const f = faces.get(o)!;
    const remap = new Map<number, number>();
    for (const i of f) {
      let n = remap.get(i);
      if (n === undefined) { n = o.pos.length / 3; remap.set(i, n); o.pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]); }
      o.idx.push(n);
    }
  }
  return objs.filter((o) => o.idx.length);
}

// ---------------------------------------------------------------- STL

export function parseStl(data: Uint8Array): RawObject[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pos: number[] = [], idx: number[] = [];
  const binary = data.length >= 84 && 84 + dv.getUint32(80, true) * 50 === data.length;
  if (binary) {
    const n = dv.getUint32(80, true);
    for (let i = 0; i < n; i++) {
      const o = 84 + i * 50 + 12;
      for (let k = 0; k < 9; k++) pos.push(dv.getFloat32(o + k * 4, true));
      idx.push(i * 3, i * 3 + 1, i * 3 + 2);
    }
  } else {
    const text = dec(data);
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) pos.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    if (!pos.length || pos.length % 9 !== 0) throw new Error('STL ASCII inválido: no se encontraron triángulos completos (facet / vertex).');
    for (let i = 0; i < pos.length / 3; i++) idx.push(i);
  }
  if (pos.some((x) => !Number.isFinite(x))) throw new Error('STL con coordenadas no finitas.');
  return [{ name: 'Modelo', pos, idx }];
}

// ---------------------------------------------------------------- glTF / GLB

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const mmul = (a: number[], b: number[]): number[] => {
  const o = new Array(16).fill(0); // columnas (formato glTF)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
function nodeMatrix(n: Json): number[] {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

export function parseGltf(data: Uint8Array, glb: boolean): RawObject[] {
  let json: Json, bin: Uint8Array | undefined;
  if (glb) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('GLB inválido (cabecera).');
    let o = 12, j: Json | undefined;
    while (o + 8 <= data.length) {
      const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
      const body = data.subarray(o + 8, o + 8 + len);
      if (type === 0x4e4f534a) j = JSON.parse(dec(body)); else if (type === 0x004e4942 && !bin) bin = body;
      o += 8 + len;
    }
    if (!j) throw new Error('GLB sin bloque JSON.');
    json = j;
  } else json = JSON.parse(dec(data));
  if (json.extensionsRequired?.some((e: string) => /draco|meshopt|quantization/i.test(e))) throw new Error(`glTF con extensión no soportada (${json.extensionsRequired.join(', ')}): reexporta sin compresión.`);
  const buffers: Uint8Array[] = (json.buffers ?? []).map((b: Json, i: number) => {
    if (b.uri === undefined) { if (i === 0 && bin) return bin; throw new Error('glTF: buffer sin datos.'); }
    const m = /^data:[^,]*;base64,(.*)$/.exec(b.uri);
    if (!m) throw new Error('glTF con buffer externo (.bin): usa GLB o un glTF con los datos incrustados (base64).');
    return Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  });
  const read = (acc: number): number[] => {
    const a = (json.accessors ?? [])[acc];
    if (!a || a.sparse) throw new Error('glTF: accessor ausente o disperso (sparse) no soportado.');
    const bv = (json.bufferViews ?? [])[a.bufferView];
    const buf = buffers[bv.buffer];
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type as 'SCALAR'] ?? 1;
    const csize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType as 5126];
    if (!csize) throw new Error('glTF: tipo de componente no soportado.');
    const stride = bv.byteStride || comps * csize;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const out: number[] = [];
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) {
      const o = base + i * stride + c * csize;
      out.push(a.componentType === 5126 ? dv.getFloat32(o, true) : a.componentType === 5125 ? dv.getUint32(o, true) : a.componentType === 5123 ? dv.getUint16(o, true) : a.componentType === 5122 ? dv.getInt16(o, true) : a.componentType === 5121 ? dv.getUint8(o) : dv.getInt8(o));
    }
    return out;
  };
  const nodes: Json[] = json.nodes ?? [];
  const children = new Set<number>(nodes.flatMap((n) => n.children ?? []));
  const sceneRoots: number[] = json.scenes?.[json.scene ?? 0]?.nodes ?? nodes.map((_, i) => i).filter((i) => !children.has(i));
  const objs: RawObject[] = [];
  const walk = (i: number, parent: number[], depth: number) => {
    if (depth > 64) throw new Error('glTF: jerarquía de nodos demasiado profunda.');
    const n = nodes[i];
    const m = mmul(parent, nodeMatrix(n));
    if (n.mesh !== undefined) {
      const mesh = json.meshes[n.mesh];
      const o: RawObject = { name: n.name || mesh.name || `Objeto ${objs.length + 1}`, pos: [], idx: [] };
      for (const p of mesh.primitives ?? []) {
        if ((p.mode ?? 4) !== 4) throw new Error('glTF: solo se admiten primitivas de triángulos (modo 4).');
        const P = read(p.attributes.POSITION);
        const base = o.pos.length / 3;
        for (let k = 0; k < P.length; k += 3) {
          const x = P[k], y = P[k + 1], z = P[k + 2];
          o.pos.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        }
        const I = p.indices !== undefined ? read(p.indices) : Array.from({ length: P.length / 3 }, (_, k) => k);
        for (const k of I) o.idx.push(base + k);
      }
      if (o.idx.length) objs.push(o);
    }
    for (const c of n.children ?? []) walk(c, m, depth + 1);
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const r of sceneRoots) walk(r, I, 0);
  return objs;
}

// ---------------------------------------------------------------- punto de entrada

const toBytes = (d: Uint8Array | ArrayBuffer | string): Uint8Array => (typeof d === 'string' ? new TextEncoder().encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d));

/**
 * Importa un modelo y devuelve el detalle (piezas, unidad usada y avisos). Lanza con mensajes en español si el archivo no sirve.
 * Convierte a nuestro sistema: mm, Y arriba, mano derecha (un modelo Z-arriba se gira -90° alrededor de X: (x, y, z) -> (x, z, -y)).
 */
export function importMeshDetailed(data: Uint8Array | ArrayBuffer | string, opts: ImportMeshOptions = {}): ImportMeshResult {
  const bytes = toBytes(data);
  const format = opts.formato ?? detectFormat(bytes, opts.nombreArchivo);
  const avisos: string[] = [];
  const separar = opts.separar ?? 'objetos';
  let objs: RawObject[];
  if (format === 'obj') objs = parseObj(dec(bytes), separar === 'objetos');
  else if (format === 'stl') objs = parseStl(bytes);
  else if (format === 'gltf' || format === 'glb') objs = parseGltf(bytes, format === 'glb');
  else throw new Error(`Formato "${String(format)}" no soportado (obj, stl, gltf, glb). COLLADA (.dae): exporta a OBJ.`);
  if (!objs.length) throw new Error('El archivo no contiene triángulos.');

  // unidad
  let unidad = opts.unidad, unidadDetectada = false;
  if (!unidad) {
    if (format === 'gltf' || format === 'glb') unidad = 'm';
    else {
      const b = bboxOf(objs.flatMap((o) => o.pos));
      unidad = detectUnit(Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]));
      unidadDetectada = true;
      avisos.push(`Unidad no indicada: se supuso "${unidad}" por el tamaño del modelo; si no es correcta, repite con unidad (mm, cm, m, in, ft).`);
    }
  }
  const up = format === 'gltf' || format === 'glb' ? 'y' : opts.ejeArriba ?? 'y';
  const k = MESH_UNITS[unidad] * (opts.escala ?? 1);
  if (!(k > 0) || !Number.isFinite(k)) throw new Error('escala inválida (debe ser un número mayor que 0).');

  // a nuestro sistema (mm, Y arriba)
  for (const o of objs) {
    for (let i = 0; i < o.pos.length; i += 3) {
      const x = o.pos[i] * k, y = o.pos[i + 1] * k, z = o.pos[i + 2] * k;
      if (up === 'z') { o.pos[i] = x; o.pos[i + 1] = z; o.pos[i + 2] = -y; } else { o.pos[i] = x; o.pos[i + 1] = y; o.pos[i + 2] = z; }
    }
  }
  if (separar === 'uno' && objs.length > 1) {
    const all: RawObject = { name: 'Modelo', pos: [], idx: [] };
    for (const o of objs) { const base = all.pos.length / 3; all.pos.push(...o.pos); for (const i of o.idx) all.idx.push(base + i); }
    objs = [all];
  }

  const weld = opts.soldar ?? format === 'stl';
  const max = opts.maxTriangulos ?? MAX_MESH_TRIANGLES;
  const cleaned = objs.map((o) => {
    let r = weld ? weldMesh(o.pos, o.idx) : { positions: o.pos, indices: o.idx };
    r = cleanMesh(r.positions, r.indices);
    if (r.indices.length / 3 > max) {
      if (!opts.decimar) throw new Error(`"${o.name}" tiene ${r.indices.length / 3} triángulos y el máximo por pieza es ${max}. Reintenta con decimar=true (simplifica la malla) o exporta una versión más liviana.`);
      const n0 = r.indices.length / 3;
      r = decimateMesh(r.positions, r.indices, max);
      avisos.push(`"${o.name}": decimada de ${n0} a ${r.indices.length / 3} triángulos.`);
    }
    return { name: o.name, ...r };
  }).filter((o) => o.indices.length);
  if (!cleaned.length) throw new Error('Tras limpiar triángulos degenerados no queda geometría.');

  const gmin = bboxOf(cleaned.flatMap((o) => o.positions)).min;
  const origin = opts.centrar === false ? ([0, 0, 0] as Vec3) : gmin;
  const place = opts.centrar === false ? ([0, 0, 0] as Vec3) : opts.posicion ?? ([0, 0, 0] as Vec3);
  const base = opts.nombre ?? opts.nombreArchivo?.replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, '') ?? 'Modelo';
  const parts: Part[] = cleaned.map((o, i) => {
    const { mesh, min } = encodeMesh(o.positions, o.indices, max);
    const part: Part = {
      id: `mesh${i + 1}`,
      name: cleaned.length > 1 ? `${base} - ${o.name}` : base,
      size: [...mesh.bbox] as Vec3,
      position: [0, 1, 2].map((a) => Math.round((min[a] - origin[a] + place[a]) * 1e4) / 1e4) as Vec3,
      material: opts.material ?? 'mel18',
      form: 'mesh',
      mesh,
    };
    if (opts.grupo) part.group = opts.grupo;
    return part;
  });
  if (parts.length > 500) avisos.push(`El modelo trae ${parts.length} objetos; considera separar='uno'.`);
  return { parts, unidad, unidadDetectada, avisos };
}

/** Importa un modelo 3D y devuelve las piezas (ids provisorios "mesh1"...). Ver ImportMeshOptions e importMeshDetailed. */
export function importMesh(data: Uint8Array | ArrayBuffer | string, opts: ImportMeshOptions = {}): Part[] {
  return importMeshDetailed(data, opts).parts;
}
