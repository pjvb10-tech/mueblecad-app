import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSolidGeometry } from './solidGeometry';
import { partVolume, solidSpec } from '../core/solids';
import type { Part } from '../core/types';

const part = (o: Partial<Part>): Part => ({ id: 'p1', name: 'Pieza', size: [100, 100, 100], position: [0, 0, 0], material: 'm', ...o });

/** Volumen firmado de la malla (suma de tetraedros con el origen): positivo si las caras miran hacia afuera. */
function meshVolume(part: Part) {
  const g = buildSolidGeometry(solidSpec(part)!);
  const pos = g.getAttribute('position'), nrm = g.getAttribute('normal'), idx = g.getIndex()!;
  let vol = 0, bad = 0;
  for (let t = 0; t < idx.count; t += 3) {
    const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
    const P = [a, b, c].map((i) => [pos.getX(i), pos.getY(i), pos.getZ(i)]);
    const u = P[1].map((v, k) => v - P[0][k]), w = P[2].map((v, k) => v - P[0][k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    vol += (P[0][0] * n[0] + P[0][1] * n[1] + P[0][2] * n[2]) / 6;
    // la normal del vértice no debe llevar la contraria de la cara (salvo triángulos degenerados)
    const len = Math.hypot(...n);
    if (len > 1e-9) for (const i of [a, b, c]) if ((nrm.getX(i) * n[0] + nrm.getY(i) * n[1] + nrm.getZ(i) * n[2]) / len < -1e-6) bad++;
  }
  g.computeBoundingBox();
  return { vol, bad, box: g.boundingBox!, g };
}

const cases: [string, Part, number][] = [
  ['cilindro macizo', part({ form: 'cylinder', axis: 'x', size: [80, 12, 12] }), 0.003],
  ['tubo redondo', part({ form: 'cylinder', size: [100, 200, 100], wall: 5 }), 0.004],
  ['tubo 50x50x3', part({ form: 'tube', size: [50, 1000, 50], axis: 'y', wall: 3 }), 1e-9],
  ['tubo con esquinas', part({ form: 'tube', size: [100, 50, 800], wall: 3, cornerRadius: 6, axis: 'z' }), 0.01],
  ['cuña de pilar', part({ form: 'prism', axis: 'z', size: [400, 1800, 400], profile: [[0, 0], [400, 0], [270, 1800], [0, 1800]] }), 1e-9],
  ['ángulo L (eje x)', part({ form: 'prism', axis: 'x', size: [1000, 40, 40], profile: [[0, 0], [40, 0], [40, 3], [3, 3], [3, 40], [0, 40]] }), 1e-9],
  ['rueda con ranura en V', part({ form: 'revolve', axis: 'y', size: [120, 20, 120], profile: [[0, 0], [60, 0], [60, 8], [52, 10], [60, 12], [60, 20], [0, 20]] }), 0.004],
  ['perno con cabeza (eje z)', part({ form: 'revolve', axis: 'z', size: [20, 20, 70], profile: [[0, 0], [10, 0], [10, 6], [5, 6], [5, 70], [0, 70]] }), 0.004],
];

for (const [name, p, tol] of cases) {
  test(`malla de sólido: ${name} (volumen, normales y caja envolvente)`, () => {
    const { vol, bad, box } = meshVolume(p);
    const real = partVolume(p);
    assert.ok(vol > 0, 'las caras miran hacia afuera');
    assert.ok(Math.abs(vol - real) / real <= tol, `volumen de la malla ${vol} vs real ${real}`);
    assert.equal(bad, 0, 'normales coherentes con las caras');
    // centrada en el centro de la caja envolvente y con sus medidas (los círculos teselados llegan a la caja)
    for (let i = 0; i < 3; i++) {
      assert.ok(box.max.getComponent(i) <= p.size[i] / 2 + 1e-4 && box.min.getComponent(i) >= -p.size[i] / 2 - 1e-4, `eje ${i} dentro de la caja`);
      assert.ok(box.max.getComponent(i) - box.min.getComponent(i) >= p.size[i] * 0.99, `eje ${i} llena la caja`);
    }
  });
}

test('malla de sólido: curvas suaves y aristas vivas', () => {
  const { g } = meshVolume(part({ form: 'cylinder', size: [100, 200, 100] }));
  const nrm = g.getAttribute('normal');
  // en el lateral del cilindro las normales son radiales (sin componente en el eje y)
  const radial = new Set<number>();
  for (let i = 0; i < nrm.count; i++) if (Math.abs(nrm.getY(i)) < 1e-6) radial.add(Math.round(Math.atan2(nrm.getZ(i), nrm.getX(i)) * 1000));
  assert.ok(radial.size >= 48, 'una normal distinta por cada lado de la teselación (suave)');
  // la cuña tiene aristas vivas: ninguna normal de lado se mezcla con la del vecino
  const w = meshVolume(part({ form: 'prism', axis: 'z', size: [400, 1800, 400], profile: [[0, 0], [400, 0], [270, 1800], [0, 1800]] })).g.getAttribute('normal');
  const axes = new Set<string>();
  for (let i = 0; i < w.count; i++) axes.add([w.getX(i), w.getY(i), w.getZ(i)].map((v) => v.toFixed(3)).join(','));
  assert.equal(axes.size, 6, 'cuatro lados + dos tapas, cada uno con su normal plana');
});

test('malla importada: geometría centrada en su caja nativa y normales unitarias', async () => {
  const { importMesh } = await import('../core/meshImport');
  const { buildMeshGeometry } = await import('./solidGeometry');
  const cube = 'v 0 0 0\nv 2 0 0\nv 2 4 0\nv 0 4 0\nv 0 0 6\nv 2 0 6\nv 2 4 6\nv 0 4 6\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n';
  const p = importMesh(cube, { formato: 'obj', unidad: 'mm' })[0];
  const g = buildMeshGeometry(p.mesh!);
  assert.equal(g.getAttribute('position').count, 36); // aristas vivas: sin compartir vértices
  g.computeBoundingBox();
  assert.deepEqual([g.boundingBox!.min.x, g.boundingBox!.min.y, g.boundingBox!.min.z], [-1, -2, -3]);
  const n = g.getAttribute('normal');
  for (let i = 0; i < n.count; i++) assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-5);
});
