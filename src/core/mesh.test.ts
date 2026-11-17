import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProject, type Part } from './types';
import { addCabinet } from './furniture';
import { cutList } from './nesting';
import { decodeMesh, decimateMesh, encodeMesh, validateMesh } from './mesh';
import { detectUnit, importMesh, importMeshDetailed } from './meshImport';
import { describeSolid, normalizePart, partBounds, partVolume, solidsList, validatePart } from './solids';

const near = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

/** Cubo unitario OBJ (caras como cuadriláteros, 1 unidad de lado). */
const cubeObj = (name = 'Cubo', ox = 0) => `o ${name}
v ${ox} 0 0
v ${ox + 1} 0 0
v ${ox + 1} 1 0
v ${ox} 1 0
v ${ox} 0 1
v ${ox + 1} 0 1
v ${ox + 1} 1 1
v ${ox} 1 1
f 1 4 3 2
f 5 6 7 8
f 1 2 6 5
f 2 3 7 6
f 3 4 8 7
f 4 1 5 8
`;

/** Tetraedro de 10 mm de arista aprox: base en z=0, vértice arriba. */
const TETRA: number[][] = [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]];
const TETRA_FACES = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]];

function stlBinary(): Uint8Array {
  const b = new Uint8Array(84 + 50 * 4);
  const dv = new DataView(b.buffer);
  dv.setUint32(80, 4, true);
  TETRA_FACES.forEach((f, i) => f.forEach((v, j) => TETRA[v].forEach((c, k) => dv.setFloat32(84 + i * 50 + 12 + (j * 3 + k) * 4, c, true))));
  return b;
}
const stlAscii = () => `solid t\n${TETRA_FACES.map((f) => `facet normal 0 0 0\n outer loop\n${f.map((v) => `  vertex ${TETRA[v].join(' ')}`).join('\n')}\n endloop\nendfacet`).join('\n')}\nendsolid t\n`;

test('OBJ: cubo en mm → una pieza form mesh con su caja, volumen y sin datos de más', () => {
  const [p, ...rest] = importMesh(cubeObj(), { formato: 'obj', unidad: 'mm', nombre: 'Cubo' });
  assert.equal(rest.length, 0);
  assert.equal(p.form, 'mesh');
  assert.deepEqual(p.size, [1, 1, 1]);
  assert.equal(p.mesh!.triangles, 12);
  assert.equal(p.mesh!.vertices, 8);
  assert.equal(validatePart(p), null);
  near(partVolume(p), 1);
  assert.match(describeSolid(p), /malla de 12 triángulos/);
});

test('OBJ: unidades (in, m), eje Z arriba y escala', () => {
  const inch = importMesh(cubeObj(), { formato: 'obj', unidad: 'in' })[0];
  near(inch.size[0], 25.4);
  const m = importMesh(cubeObj(), { formato: 'obj', unidad: 'm', escala: 2 })[0];
  near(m.size[1], 2000);
  // caja 1 x 2 x 3 con Z arriba → alto (Y) 3, fondo (Z) 2
  const slab = `v 0 0 0\nv 1 0 0\nv 1 2 0\nv 0 2 0\nv 0 0 3\nv 1 0 3\nv 1 2 3\nv 0 2 3\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n`;
  const z = importMesh(slab, { formato: 'obj', unidad: 'mm', ejeArriba: 'z' })[0];
  assert.deepEqual(z.size, [1, 3, 2]);
  assert.equal(validatePart(z), null);
  const y = importMesh(slab, { formato: 'obj', unidad: 'mm' })[0];
  assert.deepEqual(y.size, [1, 2, 3]);
  // Z arriba conserva la orientación: el volumen sigue siendo el mismo (positivo)
  near(partVolume(z), 6);
});

test('OBJ: objetos separados con su posición relativa, o todo en una pieza; índices negativos', () => {
  const two = cubeObj('A', 0) + cubeObj('B', 5).replace(/f (.*)/g, 'f $1'); // B reusa índices 1..8 → apunta a los de A
  assert.throws(() => importMesh(`v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 9\n`, { formato: 'obj', unidad: 'mm' }), /no existe/);
  void two;
  // dos objetos con vértices propios (índices absolutos seguidos)
  const a = cubeObj('A', 0);
  const b = cubeObj('B', 5).replace(/f ([\d ]+)/g, (_m, g: string) => 'f ' + g.split(' ').map((n) => Number(n) + 8).join(' '));
  const parts = importMesh(a + b, { formato: 'obj', unidad: 'mm', nombre: 'Mesa' });
  assert.equal(parts.length, 2);
  assert.equal(parts[0].name, 'Mesa - A');
  assert.deepEqual(parts[1].position, [5, 0, 0]);
  const one = importMesh(a + b, { formato: 'obj', unidad: 'mm', separar: 'uno' });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].size, [6, 1, 1]);
  assert.equal(one[0].mesh!.triangles, 24);
  const neg = importMesh('v 0 0 0\nv 4 0 0\nv 0 4 0\nv 0 0 4\nf -4 -2 -3\nf -4 -3 -1\nf -4 -1 -2\nf -3 -2 -1\n', { formato: 'obj', unidad: 'mm' })[0];
  assert.equal(neg.mesh!.triangles, 4);
});

test('STL binario y ASCII: tetraedro soldado (4 vértices, 4 triángulos), volumen 10³/6', () => {
  for (const data of [stlBinary(), stlAscii()]) {
    const [p] = importMesh(data, { unidad: 'mm' });
    assert.equal(p.mesh!.vertices, 4);
    assert.equal(p.mesh!.triangles, 4);
    assert.deepEqual(p.size, [10, 10, 10]);
    near(partVolume(p), 1000 / 6, 1e-2);
  }
});

test('GLB: tetraedro con nodo trasladado, en metros', () => {
  const pos = new Float32Array(TETRA.flat().map((v) => v / 10));
  const idx = new Uint16Array(TETRA_FACES.flat());
  const bin = new Uint8Array(pos.byteLength + 24);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Tri', mesh: 0, translation: [0, 0, 2] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 12, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 24 }],
    buffers: [{ byteLength: bin.length }],
  });
  const jb = new TextEncoder().encode(json + ' '.repeat((4 - (json.length % 4)) % 4));
  const out = new Uint8Array(12 + 8 + jb.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
  dv.setUint32(12, jb.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jb, 20);
  const o = 20 + jb.length;
  dv.setUint32(o, bin.length, true); dv.setUint32(o + 4, 0x004e4942, true); out.set(bin, o + 8);
  const [p] = importMesh(out, { formato: 'glb', centrar: false });
  assert.deepEqual(p.size, [1000, 1000, 1000]);
  assert.deepEqual(p.position, [0, 0, 2000]); // la traslación del nodo se aplica (m → mm)
  assert.equal(p.mesh!.triangles, 4);
  assert.equal(importMesh(out, { formato: 'glb' })[0].position[2], 0);
});

test('unidad: sin indicarla se detecta y se avisa', () => {
  assert.equal(detectUnit(3), 'm');
  assert.equal(detectUnit(300), 'cm');
  assert.equal(detectUnit(2400), 'mm');
  const r = importMeshDetailed(stlBinary());
  assert.equal(r.unidadDetectada, true);
  assert.equal(r.unidad, 'm'); // 10 unidades → metros
  assert.ok(r.avisos.length >= 1);
});

test('mesh: validación (índices, tamaños, formas ajenas) y normalización', () => {
  const p = importMesh(cubeObj(), { formato: 'obj', unidad: 'mm' })[0];
  assert.equal(validatePart({ ...p, mesh: undefined }), '"' + p.name + '": falta mesh (los datos de la malla).');
  assert.ok(validatePart({ ...p, wall: 2 })?.includes('no se usa con form'));
  assert.ok(validatePart({ ...p, form: 'box' })?.includes('no se usa con form "box"'));
  assert.ok(validateMesh({ ...p.mesh!, triangles: 5 })?.includes('indices'));
  const raw = decodeMesh(p.mesh!);
  const bad = encodeMesh(Array.from(raw.positions), Array.from(raw.indices)).mesh;
  assert.equal(validateMesh(bad), null);
  assert.throws(() => encodeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 7]), /fuera de rango/);
  assert.throws(() => encodeMesh([0, 0, 0, 1, 0, 0, 0, 1, NaN], [0, 1, 2]), /no finitas/);
  // una caja que arrastra mesh lo pierde al normalizar
  const box = normalizePart({ ...p, form: 'box' } as Part);
  assert.equal(box.mesh, undefined);
  // reescalar la pieza escala la malla (volumen proporcional)
  near(partVolume({ ...p, size: [2, 2, 2] }), 8);
});

test('mesh: tope de triángulos (rechazo con mensaje o decimación)', () => {
  // rejilla de 30x30 cuadros = 1800 triángulos
  const n = 30, pos: number[] = [], idx: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i, j, Math.sin(i / 3) * Math.cos(j / 3));
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; idx.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1); }
  assert.throws(() => encodeMesh(pos, idx, 1000), /máximo/);
  const obj = pos.reduce((s, _v, k) => (k % 3 === 0 ? s + `v ${pos[k]} ${pos[k + 1]} ${pos[k + 2]}\n` : s), '') + idx.reduce((s, _v, k) => (k % 3 === 0 ? s + `f ${idx[k] + 1} ${idx[k + 1] + 1} ${idx[k + 2] + 1}\n` : s), '');
  assert.throws(() => importMesh(obj, { formato: 'obj', unidad: 'mm', maxTriangulos: 500 }), /decimar/);
  const r = importMeshDetailed(obj, { formato: 'obj', unidad: 'mm', maxTriangulos: 500, decimar: true });
  assert.ok(r.parts[0].mesh!.triangles <= 500 && r.parts[0].mesh!.triangles > 20, String(r.parts[0].mesh!.triangles));
  assert.ok(r.avisos.some((a) => a.includes('decimada')));
  assert.equal(validatePart(r.parts[0]), null);
  const d = decimateMesh(pos, idx, 100);
  assert.ok(d.indices.length / 3 <= 100);
});

test('mesh: caja envolvente girada, lista de sólidos y exclusión del despiece', () => {
  const p = importMesh(stlBinary(), { unidad: 'mm' })[0];
  p.position = [100, 0, 0];
  p.rotZ = 90;
  const b = partBounds(p);
  near(b.min[0], 100); near(b.size[0], 10);
  const project = defaultProject();
  addCabinet(project, { name: 'Base', width: 600, height: 700, depth: 500 } as never);
  const before = JSON.stringify(cutList(project));
  project.parts.push({ ...p, id: 'pm1' });
  assert.equal(JSON.stringify(cutList(project)), before);
  const rows = solidsList(project.parts);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].form, 'mesh');
  assert.ok(JSON.stringify(rows).length < 1000);
  // sobrevive a ida y vuelta por JSON (export/import de proyectos)
  const back = JSON.parse(JSON.stringify(project)) as typeof project;
  assert.equal(validatePart(back.parts.find((x) => x.id === 'pm1')!), null);
});
