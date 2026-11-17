import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, createDrawing, getEntity, setLayer } from './drawing';
import type { EntityInput } from './drawing';
import { applyOps, createTool } from './drawingTools';
import type { Drawing, Entity, Pt2 } from './types';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearP = (a: Pt2, b: Pt2, eps = 1e-6) => { near(a[0], b[0], eps); near(a[1], b[1], eps); };
const mk = (inputs: EntityInput[], layers: { name: string }[] = []): Drawing => addEntities(createDrawing('t', { layers }), inputs).drawing;
const ent = (d: Drawing, id: string) => getEntity(d, id) as Entity & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const L = (a: Pt2, b: Pt2): EntityInput => ({ type: 'line', a, b });

test('herramienta recortar: Enter = todos los bordes, clics repetidos, drain y commit', () => {
  const d = mk([L([0, 0], [100, 0]), L([30, -10], [30, 10]), L([70, -10], [70, 10])]);
  const t = createTool('trim', d, { pickTolerance: 2 });
  assert.equal(t.preview().prompt, 'Designe bordes de corte o Enter para todos:');
  t.onKey('Enter');
  assert.equal(t.preview().prompt, 'Designe objeto a recortar [Deshacer]:');
  t.onPoint([50, 0]);
  assert.equal(t.error, null);
  const first = t.drain!();
  assert.deepEqual(first.map((o) => o.op), ['update', 'add']);
  const d1 = applyOps(d, first).drawing;
  assert.equal(d1.entities.length, 4);
  t.onPoint([85, 0]); // trozo [70..100]: el borde solo toca su extremo, no hay corte
  assert.ok(t.error);
  t.onKey('Enter');
  assert.ok(t.done); assert.ok(!t.cancelled);
  assert.deepEqual(t.commit(), []); // ya entregado con drain
});

test('herramienta recortar: sin drain, commit entrega todo; Esc al designar bordes cancela', () => {
  const d = mk([L([0, 0], [100, 0]), L([30, -10], [30, 10]), L([70, -10], [70, 10])]);
  const t = createTool('trim', d, { pickTolerance: 2 });
  t.onSelect(['e2', 'e3']);
  assert.deepEqual(t.selection, ['e2', 'e3']);
  t.onKey('Enter');
  t.onPoint([50, 0]);
  t.onKey('Escape');
  assert.ok(t.done); assert.ok(!t.cancelled);
  const r = applyOps(d, t.commit());
  assert.equal(r.drawing.entities.length, 4);
  const c = createTool('extend', d);
  c.onKey('Escape');
  assert.ok(c.cancelled); assert.deepEqual(c.commit(), []);
});

test('herramienta: Mayús invierte recortar↔extender y U deshace (con drain intermedio)', () => {
  const d = mk([L([0, 0], [50, 0]), L([100, -20], [100, 20])]);
  const t = createTool('trim', d, { pickTolerance: 3, boundaries: ['e2'] });
  assert.equal(t.preview().prompt, 'Designe objeto a recortar [Deshacer]:');
  t.onPoint([45, 0], { shift: true }); // Mayús: extiende
  assert.equal(t.error, null);
  const d1 = applyOps(d, t.drain!()).drawing;
  nearP(ent(d1, 'e1').b, [100, 0]);
  t.onKey('u'); // deshacer lo ya entregado -> operaciones inversas
  const d2 = applyOps(d1, t.drain!()).drawing;
  nearP(ent(d2, 'e1').b, [50, 0]);
  t.onKey('u');
  assert.ok(t.error); // nada más que deshacer
  t.onPoint([45, 0], { shift: true });
  t.onKey('d'); // deshacer antes de entregar: no queda nada pendiente
  assert.deepEqual(t.drain!(), []);
});

test('herramienta extender: modo de bordes extendidos con B y objetos inexistentes', () => {
  const d = mk([L([0, 0], [10, 0]), L([100, 10], [100, 30])]);
  const t = createTool('extend', d, { pickTolerance: 2, boundaries: 'todos' });
  assert.equal(t.preview().prompt, 'Designe objeto a extender [Deshacer]:');
  t.onPoint([9, 0]); assert.ok(t.error && /no hay intersección/.test(t.error));
  t.onKey('b');
  assert.ok(/bordes extendidos/.test(t.preview().prompt));
  t.onPoint([9, 0]); assert.equal(t.error, null);
  nearP(ent(applyOps(d, t.drain!()).drawing, 'e1').b, [100, 0]);
  t.onPoint([500, 500]); assert.ok(/ningún objeto/.test(t.error ?? ''));
});

test('herramienta: los bordes designados deben ser válidos; capa bloqueada da error al recortar', () => {
  let d = mk([{ ...L([0, 0], [100, 0]), layer: 'A' }, L([30, -10], [30, 10]), { type: 'text', p: [0, 5], h: 3, s: 'x' }], [{ name: 'A' }]);
  d = setLayer(d, 'A', { locked: true });
  const t = createTool('trim', d, { pickTolerance: 2 });
  t.onSelect(['e3']); assert.ok(t.error); // el texto no sirve de borde
  t.onSelect(['e2']); assert.equal(t.error, null); assert.deepEqual(t.selection, ['e2']);
  t.onKey('Enter');
  t.onPoint([80, 0]); assert.ok(/bloqueada/.test(t.error ?? ''));
});

test('herramienta recortar: sync(d) ve bordes y objetos que otro agregó con la herramienta activa', () => {
  const d = mk([L([0, 0], [100, 0])]); // solo el objetivo; los bordes llegan después
  const t = createTool('trim', d, { pickTolerance: 2 });
  t.onKey('Enter'); // todos los bordes
  t.onPoint([50, 0]);
  assert.ok(t.error); // sin bordes no hay nada que cortar
  const d2 = addEntities(d, [L([30, -10], [30, 10]), L([70, -10], [70, 10])]).drawing; // el agente los agrega
  t.sync!(d2);
  t.onPoint([50, 0]);
  assert.equal(t.error, null);
  assert.deepEqual(t.drain!().map((o) => o.op), ['update', 'add']);
});

test('herramienta recortar: sync(d) descarta bordes designados que el agente borró', () => {
  const d = mk([L([0, 0], [100, 0]), L([30, -10], [30, 10]), L([70, -10], [70, 10])]);
  const t = createTool('trim', d, { pickTolerance: 2 });
  t.onSelect(['e2', 'e3']);
  t.sync!(mk([L([0, 0], [100, 0]), L([30, -10], [30, 10])])); // e3 ya no existe
  assert.deepEqual(t.selection, ['e2']);
});
