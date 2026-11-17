import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, createDrawing, setLayer } from './drawing';
import type { EntityInput } from './drawing';
import { applySelection, boxModeOf, buildIndex, cyclePick, pickAt, selectAll, selectBox, selectFence } from './select2d';

const mk = (inputs: EntityInput[], layers: { name: string }[] = []) => addEntities(createDrawing('t', { layers }), inputs).drawing;
const ids = (r: string[]) => [...r].sort();

const scene = () => mk([
  { type: 'line', a: [0, 0], b: [100, 0] },                 // e1
  { type: 'circle', c: [300, 300], r: 50 },                 // e2
  { type: 'poly', pts: [[500, 0], [600, 0], [600, 100]], closed: true }, // e3
  { type: 'text', p: [0, 200], h: 20, s: 'Hola' },          // e4
  { type: 'arc', c: [0, 500], r: 100, a0: 0, a1: 90 },      // e5
]);

test('pickAt: tolerancia, orden por distancia, texto por caja', () => {
  const d = scene();
  assert.deepEqual(pickAt(d, [50, 2], 3), ['e1']);
  assert.deepEqual(pickAt(d, [50, 10], 3), []);
  assert.deepEqual(pickAt(d, [300, 350], 1), ['e2']);
  assert.deepEqual(pickAt(d, [10, 210], 1), ['e4']); // dentro de la caja del texto
  assert.deepEqual(pickAt(d, [100, 500], 1), ['e5']); // extremo del arco
  assert.deepEqual(pickAt(d, [-100, 500], 3), []); // la parte del círculo que no es arco
});

test('pickAt: bulge, y solapadas se ordenan (más cercana, luego la de encima)', () => {
  const d = mk([
    { type: 'poly', pts: [{ p: [0, 0], bulge: 1 }, { p: [200, 0] }] }, // semicírculo inferior
    { type: 'line', a: [0, -101], b: [200, -101] },
    { type: 'line', a: [0, -101], b: [200, -101] },
  ]);
  assert.deepEqual(pickAt(d, [100, -99], 5), ['e1', 'e3', 'e2']); // el arco (d=1) primero; las líneas iguales (d=2): la de encima antes
  assert.deepEqual(pickAt(d, [100, -101.5], 5), ['e3', 'e2', 'e1']);
});

test('cyclePick recorre y da la vuelta', () => {
  assert.equal(cyclePick([]), null);
  assert.equal(cyclePick(['a', 'b', 'c'], null), 'a');
  assert.equal(cyclePick(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(cyclePick(['a', 'b', 'c'], 'c'), 'a');
  assert.equal(cyclePick(['a', 'b'], 'zzz'), 'a');
});

test('applySelection: reemplaza o alterna con Mays', () => {
  assert.deepEqual(applySelection(['a', 'b'], ['c']), ['c']);
  assert.deepEqual(ids(applySelection(['a', 'b'], ['b', 'c'], true)), ['a', 'c']);
  assert.deepEqual(applySelection(['a'], [], true), ['a']);
});

test('ventana: solo contenidas; cruce: tocadas; la orientación decide', () => {
  const d = scene();
  assert.equal(boxModeOf([0, 0], [10, 10]), 'window');
  assert.equal(boxModeOf([10, 0], [0, 10]), 'crossing');
  // ventana L→R sobre medio círculo: no selecciona
  assert.deepEqual(selectBox(d, [250, 250], [320, 350]).ids, []);
  // el mismo rectángulo R→L toca el círculo
  const c = selectBox(d, [320, 350], [250, 250]);
  assert.equal(c.mode, 'crossing'); assert.deepEqual(c.ids, ['e2']);
  // ventana que contiene completos línea y círculo, no la poly
  assert.deepEqual(ids(selectBox(d, [-10, -10], [400, 400]).ids), ['e1', 'e2', 'e4']);
  // cruce con un rectángulo contenido dentro de un círculo sin tocar el trazo: no selecciona
  assert.deepEqual(selectBox(d, [310, 310], [295, 295]).ids, []);
  // cruce sobre arco por bulge
  const ar = mk([{ type: 'poly', pts: [{ p: [0, 0], bulge: 1 }, { p: [200, 0] }] }]);
  assert.deepEqual(selectBox(ar, [90, -150], [110, -50], { mode: 'crossing' }).ids, ['e1']);
  assert.deepEqual(selectBox(ar, [90, 150], [110, 50], { mode: 'crossing' }).ids, []); // el hueco superior no toca el arco inferior
  // modo explícito ignora la orientación
  assert.equal(selectBox(d, [0, 0], [10, 10], { mode: 'crossing' }).mode, 'crossing');
});

test('cruce: una ventana dentro de la caja de un texto lo selecciona', () => {
  const d = scene();
  assert.deepEqual(selectBox(d, [12, 205], [10, 203], { mode: 'crossing' }).ids, ['e4']);
});

test('valla: toca las entidades que cruza', () => {
  const d = scene();
  assert.deepEqual(ids(selectFence(d, [[50, -50], [50, 50], [320, 300]])), ['e1', 'e2']);
  assert.deepEqual(selectFence(d, [[1, 1]]), []);
  // valla colineal con la línea
  assert.deepEqual(selectFence(d, [[20, 0], [60, 0]]), ['e1']);
});

test('capas congeladas, apagadas y bloqueadas se ignoran para editar', () => {
  let d = mk([
    { type: 'line', a: [0, 0], b: [100, 0], layer: 'F' }, { type: 'line', a: [0, 10], b: [100, 10], layer: 'L' },
    { type: 'line', a: [0, 20], b: [100, 20], layer: 'O' }, { type: 'line', a: [0, 30], b: [100, 30] },
  ], [{ name: 'F' }, { name: 'L' }, { name: 'O' }]);
  d = setLayer(setLayer(setLayer(d, 'F', { frozen: true }), 'L', { locked: true }), 'O', { on: false });
  assert.deepEqual(pickAt(d, [50, 0], 40), ['e4']);
  assert.deepEqual(pickAt(d, [50, 10], 40, { includeLocked: true }).sort(), ['e2', 'e4']);
  assert.deepEqual(selectBox(d, [-10, -10], [200, 50]).ids, ['e4']);
  assert.deepEqual(selectAll(d), ['e4']);
  assert.deepEqual(selectFence(d, [[50, -10], [50, 40]]), ['e4']);
});

test('rendimiento: 10 000 entidades con índice', () => {
  const inputs: EntityInput[] = [];
  for (let i = 0; i < 10000; i++) {
    const x = (i % 100) * 100, y = Math.floor(i / 100) * 100;
    inputs.push(i % 3 === 0 ? { type: 'circle', c: [x + 20, y + 20], r: 15 } : { type: 'line', a: [x, y], b: [x + 50, y + 50] });
  }
  const d = mk(inputs);
  const index = buildIndex(d);
  assert.equal(index.items.length, 10000);
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) pickAt(d, [5025 + i, 5025], 4, { index });
  const per = (performance.now() - t0) / 200;
  assert.ok(per < 5, `pick: ${per.toFixed(2)} ms`);
  assert.deepEqual(pickAt(d, [5025, 5025], 1, { index }).length, 1);
  const w = selectBox(d, [1000, 1000], [2000, 2000], { index });
  assert.equal(w.mode, 'window');
  assert.ok(w.ids.length > 90 && w.ids.length < 130, `ventana: ${w.ids.length}`);
  // sin índice explícito también funciona (se construye uno efímero)
  assert.equal(pickAt(d, [5025, 5025], 1).length, 1);
  const t1 = performance.now();
  selectBox(d, [0, 0], [10000, 10000], { index, mode: 'crossing' });
  assert.ok(performance.now() - t1 < 2000);
});
