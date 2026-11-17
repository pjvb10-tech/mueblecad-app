import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, createDrawing, setLayer } from './drawing';
import type { EntityInput } from './drawing';
import { buildIndex } from './prims2d';
import { apertureFromPixels, snapPoint } from './snap2d';
import type { SnapMode } from './snap2d';
import type { Pt2 } from './types';

const mk = (inputs: EntityInput[]) => addEntities(createDrawing('t'), inputs).drawing;
const on = (...m: SnapMode[]) => Object.fromEntries(m.map((k) => [k, true]));
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearP = (a: Pt2, b: Pt2, eps = 1e-6) => { near(a[0], b[0], eps); near(a[1], b[1], eps); };

test('end: extremos de línea y vértices de polilínea', () => {
  const d = mk([{ type: 'line', a: [0, 0], b: [100, 0] }, { type: 'poly', pts: [[0, 50], [100, 50], [100, 100]] }]);
  const r = snapPoint(d, [98, 2], { aperture: 5, modes: on('end') });
  assert.equal(r.mode, 'end'); nearP(r.point, [100, 0]); assert.equal(r.label, 'Extremo'); assert.equal(r.marker, 'square');
  const v = snapPoint(d, [101, 99], { aperture: 5, modes: on('end') });
  nearP(v.point, [100, 100]);
  assert.equal(snapPoint(d, [50, 20], { aperture: 5, modes: on('end') }).mode, 'none');
});

test('mid, cen, qua', () => {
  const d = mk([{ type: 'line', a: [0, 0], b: [100, 0] }, { type: 'circle', c: [300, 300], r: 50 }, { type: 'arc', c: [0, 500], r: 100, a0: 30, a1: 120 }]);
  nearP(snapPoint(d, [51, 1], { aperture: 5, modes: on('mid') }).point, [50, 0]);
  nearP(snapPoint(d, [302, 301], { aperture: 5, modes: on('cen') }).point, [300, 300]);
  const q = snapPoint(d, [349, 301], { aperture: 5, modes: on('qua') });
  assert.equal(q.mode, 'qua'); nearP(q.point, [350, 300]);
  // el arco 30..120 incluye el cuadrante 90 pero no el 0
  nearP(snapPoint(d, [0, 601], { aperture: 5, modes: on('qua') }).point, [0, 600]);
  assert.equal(snapPoint(d, [101, 500], { aperture: 5, modes: on('qua') }).mode, 'none');
  // punto medio del arco (75°)
  const m = snapPoint(d, [100 * Math.cos(1.309), 500 + 100 * Math.sin(1.309)], { aperture: 5, modes: on('mid') });
  assert.equal(m.mode, 'mid');
});

test('un círculo no tiene extremo ni punto medio', () => {
  const d = mk([{ type: 'circle', c: [0, 0], r: 50 }]);
  assert.equal(snapPoint(d, [50, 0], { aperture: 5, modes: on('end', 'mid') }).mode, 'none');
});

test('int: línea-línea, línea-círculo, círculo-círculo, arco-línea', () => {
  const d = mk([
    { type: 'line', a: [0, 0], b: [100, 100] }, { type: 'line', a: [0, 100], b: [100, 0] },
    { type: 'circle', c: [500, 0], r: 100 }, { type: 'line', a: [400, 50], b: [700, 50] },
    { type: 'circle', c: [1000, 0], r: 100 }, { type: 'circle', c: [1100, 0], r: 100 },
    { type: 'arc', c: [0, 1000], r: 100, a0: 0, a1: 90 }, { type: 'line', a: [-200, 1050], b: [200, 1050] },
  ]);
  nearP(snapPoint(d, [51, 49], { aperture: 5, modes: on('int') }).point, [50, 50]);
  const lc = snapPoint(d, [500 + 86.6, 51], { aperture: 5, modes: on('int') });
  nearP(lc.point, [500 + Math.sqrt(100 * 100 - 50 * 50), 50], 1e-6); assert.equal(lc.label, 'Intersección');
  nearP(snapPoint(d, [1050, 87], { aperture: 5, modes: on('int') }).point, [1050, Math.sqrt(100 * 100 - 50 * 50)], 1e-6);
  nearP(snapPoint(d, [87, 1049], { aperture: 5, modes: on('int') }).point, [Math.sqrt(100 * 100 - 50 * 50), 1050], 1e-6);
  // intersección con el lado del arco que NO existe (x negativa): no hay punto
  assert.equal(snapPoint(d, [-87, 1049], { aperture: 5, modes: on('int') }).mode, 'none');
});

test('int: intersección tangente (línea que toca un círculo) y círculos tangentes', () => {
  const d = mk([{ type: 'circle', c: [0, 0], r: 100 }, { type: 'line', a: [-200, 100], b: [200, 100] }, { type: 'circle', c: [200, 0], r: 100 }]);
  const t = snapPoint(d, [1, 99], { aperture: 5, modes: on('int') });
  assert.equal(t.mode, 'int'); nearP(t.point, [0, 100]);
  const cc = snapPoint(d, [101, 1], { aperture: 5, modes: on('int') });
  assert.equal(cc.mode, 'int'); nearP(cc.point, [100, 0]);
});

test('int: poly con arco por bulge contra una línea', () => {
  // semicírculo (bulge 1) de (0,0) a (200,0) pasando por debajo (CCW): centro (100,0), radio 100
  const d = mk([{ type: 'poly', pts: [{ p: [0, 0], bulge: 1 }, { p: [200, 0] }] }, { type: 'line', a: [100, -200], b: [100, 200] }]);
  const r = snapPoint(d, [100, -99], { aperture: 5, modes: on('int') });
  assert.equal(r.mode, 'int'); nearP(r.point, [100, -100]);
  assert.equal(snapPoint(d, [100, 99], { aperture: 5, modes: on('int') }).mode, 'none');
});

test('per y tan requieren punto base', () => {
  const d = mk([{ type: 'line', a: [0, 0], b: [100, 0] }, { type: 'circle', c: [500, 0], r: 100 }]);
  assert.equal(snapPoint(d, [40, 0], { aperture: 5, modes: on('per') }).mode, 'none');
  const p = snapPoint(d, [40, 1], { aperture: 5, modes: on('per'), base: [40, 80] });
  assert.equal(p.mode, 'per'); nearP(p.point, [40, 0]);
  // la perpendicular cae fuera del segmento: no hay
  assert.equal(snapPoint(d, [120, 0], { aperture: 5, modes: on('per'), base: [120, 80] }).mode, 'none');
  // tangente desde (500,200) al círculo r=100: d=200 → puntos a ±acos(.5)=60° de la dirección al base (90°)
  const t = snapPoint(d, [500 + 86.6, 50], { aperture: 5, modes: on('tan'), base: [500, 200] });
  assert.equal(t.mode, 'tan'); nearP(t.point, [500 + 100 * Math.cos(Math.PI / 6), 100 * Math.sin(Math.PI / 6)], 1e-6);
  // base dentro del círculo: sin tangentes
  assert.equal(snapPoint(d, [550, 0], { aperture: 60, modes: on('tan'), base: [500, 10] }).mode, 'none');
});

test('nea: punto más cercano sobre la entidad', () => {
  const d = mk([{ type: 'line', a: [0, 0], b: [100, 0] }, { type: 'circle', c: [0, 200], r: 50 }]);
  const r = snapPoint(d, [33, 3], { aperture: 5, modes: on('nea') });
  assert.equal(r.mode, 'nea'); nearP(r.point, [33, 0]);
  const c = snapPoint(d, [0, 252], { aperture: 5, modes: on('nea') });
  nearP(c.point, [0, 250]);
});

test('prioridad: end gana a nea aunque nea esté más cerca; int gana a mid', () => {
  const d = mk([{ type: 'line', a: [0, 0], b: [100, 0] }]);
  const r = snapPoint(d, [3, 0], { aperture: 5, modes: on('end', 'mid', 'nea') });
  assert.equal(r.mode, 'end'); nearP(r.point, [0, 0]);
  const d2 = mk([{ type: 'line', a: [0, 0], b: [100, 0] }, { type: 'line', a: [52, -50], b: [52, 50] }]);
  assert.equal(snapPoint(d2, [51, 0], { aperture: 5, modes: on('int', 'mid') }).mode, 'int');
});

test('ortho y polar relativos a la base', () => {
  const d = createDrawing('v');
  const o = snapPoint(d, [100, 12], { aperture: 5, modes: on('ortho'), base: [0, 0] });
  assert.equal(o.mode, 'ortho'); nearP(o.point, [100, 0]); assert.deepEqual(o.guide, [[0, 0], [100, 0]]);
  nearP(snapPoint(d, [-5, 80], { aperture: 5, modes: on('ortho'), base: [0, 0] }).point, [0, 80]);
  // polar 45: cursor casi sobre la diagonal
  const p = snapPoint(d, [100, 98], { aperture: 5, modes: on('polar'), base: [0, 0], polarInc: 45 });
  assert.equal(p.mode, 'polar'); nearP(p.point, [99, 99], 1e-6);
  // lejos de cualquier ángulo múltiplo: sin imán
  assert.equal(snapPoint(d, [100, 30], { aperture: 5, modes: on('polar'), base: [0, 0], polarInc: 45 }).mode, 'none');
  // sin base no hay ortho
  assert.equal(snapPoint(d, [100, 12], { aperture: 5, modes: on('ortho') }).mode, 'none');
  // ortho + rejilla redondea la longitud
  nearP(snapPoint(d, [103, 4], { aperture: 5, modes: on('ortho', 'grid'), gridStep: 10, base: [0, 0] }).point, [100, 0]);
});

test('un imán de objeto gana a ortho', () => {
  const d = mk([{ type: 'line', a: [100, 20], b: [100, 80] }]);
  const r = snapPoint(d, [99, 19], { aperture: 5, modes: on('end', 'ortho'), base: [0, 0] });
  assert.equal(r.mode, 'end'); nearP(r.point, [100, 20]);
});

test('grid redondea al paso', () => {
  const d = createDrawing('v');
  const r = snapPoint(d, [123.4, -48], { aperture: 5, modes: on('grid'), gridStep: 50 });
  assert.equal(r.mode, 'grid'); nearP(r.point, [100, -50]);
  assert.equal(snapPoint(d, [3, 4], { aperture: 5, modes: {} }).mode, 'none');
});

test('capas apagadas o congeladas no se imantan; las bloqueadas sí; exclude', () => {
  let d = createDrawing('c', { layers: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
  d = addEntities(d, [{ type: 'line', a: [0, 0], b: [100, 0], layer: 'A' }, { type: 'line', a: [0, 10], b: [100, 10], layer: 'B' }, { type: 'line', a: [0, 20], b: [100, 20], layer: 'C' }]).drawing;
  const cur: Pt2 = [0, 10];
  assert.equal(snapPoint(d, cur, { aperture: 30, modes: on('end') }).mode, 'end');
  d = setLayer(d, 'A', { frozen: true }); d = setLayer(d, 'C', { on: false });
  const r = snapPoint(d, [0, 5], { aperture: 30, modes: on('end') });
  nearP(r.point, [0, 10]); // solo B
  d = setLayer(d, 'B', { locked: true });
  nearP(snapPoint(d, [0, 5], { aperture: 30, modes: on('end') }).point, [0, 10]); // bloqueada: se puede referenciar
  const only = snapPoint(d, [0, 5], { aperture: 30, modes: on('end'), exclude: [d.entities[1].id] });
  assert.equal(only.mode, 'none');
});

test('apertureFromPixels y rendimiento con 10 000 entidades con índice', () => {
  near(apertureFromPixels(10, 0.5), 5);
  const inputs: EntityInput[] = [];
  for (let i = 0; i < 10000; i++) { const x = (i % 100) * 100, y = Math.floor(i / 100) * 100; inputs.push({ type: 'line', a: [x, y], b: [x + 50, y + 50] }); }
  const d = mk(inputs);
  const index = buildIndex(d);
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) snapPoint(d, [5000 + i * 0.01, 5000], { aperture: 8, modes: on('end', 'int', 'mid', 'nea'), index });
  const per = (performance.now() - t0) / 200;
  assert.ok(per < 5, `snap con índice: ${per.toFixed(2)} ms por llamada`);
  nearP(snapPoint(d, [5001, 5001], { aperture: 8, modes: on('end'), index }).point, [5000, 5000]);
  // sin índice en un dibujo grande construye uno efímero y da el mismo resultado
  nearP(snapPoint(d, [5001, 5001], { aperture: 8, modes: on('end') }).point, [5000, 5000]);
});
