import test from 'node:test';
import assert from 'node:assert/strict';
import { roofCells } from './roof';

test('una cuadrícula de 2x1 recuadros con un contorno en varias líneas da 2 celdas', () => {
  const lines = [
    [0, 0, 1000, 0], [1000, 0, 2000, 0], [2000, 0, 2000, 1000], [2000, 1000, 0, 1000], [0, 1000, 0, 0],
    [1000, -300, 1000, 1000], // divisoria que se pasa del borde (punta suelta)
    [500, 500, 520, 510], // marca corta
  ];
  const r = roofCells(lines, [{ x: 500, z: 500, t: 'H01' }, { x: 1500, z: 500, t: 'T01' }]);
  assert.equal(r.cells.length, 2);
  assert.deepEqual(r.cells.map((c) => c.labels[0]).sort(), ['H01', 'T01']);
  for (const c of r.cells) assert.ok(Math.abs(c.area - 1e6) < 1e3);
  assert.equal(r.stats.tooShort, 1);
});

test('tolera huecos pequeños en las esquinas y descarta líneas sin cerrar', () => {
  const r = roofCells([[0, 0, 995, 0], [1000, 4, 1000, 1000], [1004, 1000, 0, 1000], [0, 998, 0, 3], [2000, 0, 3000, 0]]);
  assert.equal(r.cells.length, 1);
  assert.equal(r.stats.dangling, 1);
});
