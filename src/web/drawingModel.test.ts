import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, addLayer, createDrawing, removeEntity, setLayer, updateEntity, withDrawing, DrawingError } from '../core/drawing';
import { validatePart } from '../core/solids';
import { defaultProject, type Project } from '../core/types';
import { buildExtrusions, extrusionTargets, isExtrudable, uniqueGroupName } from './drawingExtrude';
import { changeText, diffDrawings, entityWorldBox } from './drawingDiff';
import { drawingLineSets, entityPolylines } from './drawing3d';

const sample = () => {
  let d = createDrawing('Planta', { id: 'd1', plane: 'xz' });
  d = addLayer(d, { name: 'Muros', color: 1 });
  d = addEntities(d, [
    { type: 'rect', p1: [0, 0], p2: [400, 300], layer: 'Muros' },
    { type: 'circle', c: [100, 100], r: 20 },
    { type: 'line', a: [0, 0], b: [10, 10] },
    { type: 'poly', pts: [[0, 0], [10, 0], [10, 10]] }, // abierta
  ]).drawing;
  return d;
};
const proj = (): Project => withDrawing(defaultProject(), sample());

test('extrusionTargets: seleccionadas (error si alguna no sirve) o todas las cerradas visibles', () => {
  const d = sample();
  assert.deepEqual(extrusionTargets(d, ['e1', 'e2']).map((e) => e.id), ['e1', 'e2']);
  assert.throws(() => extrusionTargets(d, ['e1', 'e3']), /no sirven: e3 \(line\)/);
  assert.throws(() => extrusionTargets(d, ['e4']), /e4 \(poly abierta\)/);
  assert.deepEqual(extrusionTargets(d, null).map((e) => e.id), ['e1', 'e2']);
  // una capa apagada deja fuera sus entidades
  assert.deepEqual(extrusionTargets(setLayer(d, 'Muros', { on: false }), null).map((e) => e.id), ['e2']);
  assert.throws(() => extrusionTargets(createDrawing('Vacío'), null), /no tiene polilíneas cerradas/);
  assert.equal(isExtrudable(d.entities[3]), false);
});

test('buildExtrusions: una pieza por entidad, ids únicos, mismo grupo, válida y sin tocar el proyecto', () => {
  const p = proj();
  const d = p.drawings![0];
  const before = JSON.stringify(p);
  const r = buildExtrusions(p, d, { name: 'Base', depth: 18, material: 'mel18', ids: null });
  assert.equal(JSON.stringify(p), before, 'no modifica el proyecto');
  assert.equal(r.parts.length, 2);
  assert.equal(r.group, 'Base');
  assert.deepEqual(r.parts.map((x) => x.name), ['Base 1', 'Base 2']);
  assert.equal(new Set(r.parts.map((x) => x.id)).size, 2);
  assert.ok(r.parts.every((x) => x.group === 'Base' && x.material === 'mel18' && validatePart(x) === null));
  // plano xz = planta: el espesor va hacia +Y y la caja es 400 x 18 x 300
  const rect = r.parts[0];
  assert.deepEqual(rect.size, [400, 18, 300]);
  // una sola entidad: el nombre queda tal cual
  assert.equal(buildExtrusions(p, d, { name: 'Pieza', depth: -10, material: 'mel18', ids: ['e1'] }).parts[0].name, 'Pieza');
});

test('buildExtrusions: errores claros (material, espesor 0, grupo repetido se numera)', () => {
  const p = proj();
  const d = p.drawings![0];
  assert.throws(() => buildExtrusions(p, d, { name: 'X', depth: 18, material: 'nada', ids: null }), /material "nada"/);
  assert.throws(() => buildExtrusions(p, d, { name: 'X', depth: 0, material: 'mel18', ids: null }), DrawingError);
  p.parts.push({ id: 'p1', name: 'Base', size: [1, 1, 1], position: [0, 0, 0], material: 'mel18', group: 'Base' });
  assert.equal(uniqueGroupName(p, 'Base'), 'Base 2');
  assert.equal(buildExtrusions(p, d, { name: 'Base', depth: 18, material: 'mel18', ids: ['e1'] }).group, 'Base 2');
});

test('diffDrawings: entidades nuevas, modificadas y borradas; dibujos nuevos y borrados; movimiento', () => {
  const old = proj();
  const d = old.drawings![0];
  let n = addEntities(d, [{ type: 'line', a: [0, 0], b: [5, 5] }]).drawing;
  n = updateEntity(n, 'e2', { r: 30 });
  n = removeEntity(n, 'e3');
  const cur = withDrawing(old, n);
  const [c] = diffDrawings(old, cur);
  assert.deepEqual(c.added.map((e) => e.id), ['e5']);
  assert.deepEqual(c.changed.map((e) => e.id), ['e2']);
  assert.deepEqual(c.removed.map((e) => e.id), ['e3']);
  assert.equal(changeText([c]), '+1 entidad · 1 modificada · 1 borrada');
  assert.deepEqual(diffDrawings(old, old), []);
  const extra = withDrawing(old, createDrawing('Otro', { id: 'd2' }));
  assert.equal(diffDrawings(old, extra)[0].drawing, 'new');
  assert.equal(diffDrawings(extra, old)[0].drawing, 'del');
  assert.equal(changeText(diffDrawings(old, extra)), '+1 dibujo');
  const moved = withDrawing(old, { ...d, origin: [0, 500, 0] });
  assert.equal(diffDrawings(old, moved)[0].moved, true);
});

test('entityWorldBox lleva la caja del dibujo al mundo según el plano', () => {
  const xz = createDrawing('P', { plane: 'xz', origin: [0, 100, 0] });
  const e = addEntities(xz, [{ type: 'rect', p1: [0, 0], p2: [400, 300] }]).drawing.entities[0];
  // v = -Z: el rectángulo 400 x 300 ocupa z de -300 a 0, a altura y = 100
  assert.deepEqual(entityWorldBox(xz, e), { min: [0, 100, -300], max: [400, 100, 0] });
  const xy = createDrawing('F', { plane: 'xy', origin: [10, 0, 5] });
  const f = addEntities(xy, [{ type: 'line', a: [0, 0], b: [100, 50] }]).drawing.entities[0];
  assert.deepEqual(entityWorldBox(xy, f), { min: [10, 0, 5], max: [110, 50, 5] });
});

test('drawingLineSets: líneas 3D por color, solo dibujos y capas visibles', () => {
  const p = proj();
  const sets = drawingLineSets(p);
  const total = sets.reduce((s, x) => s + x.positions.length / 6, 0);
  assert.ok(total > 0);
  assert.ok(sets.every((s) => s.positions.length % 6 === 0));
  assert.ok(sets.some((s) => s.color === '#ff0000'), 'el color ACI 1 de la capa Muros');
  // rectángulo (4 lados) en planta xz a y = 0: todas sus y son 0
  const red = sets.find((s) => s.color === '#ff0000')!;
  assert.equal(red.positions.length / 6, 4);
  for (let i = 1; i < red.positions.length; i += 3) assert.equal(red.positions[i], 0);
  // dibujo oculto -> nada
  assert.deepEqual(drawingLineSets(withDrawing(p, { ...p.drawings![0], visible: false })), []);
  // capa apagada -> sin sus líneas
  const off = withDrawing(p, setLayer(p.drawings![0], 'Muros', { on: false }));
  assert.ok(!drawingLineSets(off).some((s) => s.color === '#ff0000'));
});

test('entityPolylines: círculo y arco teselados, cota con sus líneas', () => {
  const d = addEntities(createDrawing('T'), [
    { type: 'circle', c: [0, 0], r: 100 }, { type: 'arc', c: [0, 0], r: 100, a0: 0, a1: 90 }, { type: 'dim', kind: 'aligned', p1: [0, 0], p2: [100, 0], at: [0, -20] },
  ]).drawing;
  const [circle] = entityPolylines(d.entities[0]);
  assert.ok(circle.length > 8);
  assert.deepEqual(circle[0], circle[circle.length - 1]); // cerrado
  const [arc] = entityPolylines(d.entities[1]);
  assert.deepEqual(arc[0], [100, 0]);
  assert.ok(Math.abs(arc[arc.length - 1][0]) < 1e-9 && Math.abs(arc[arc.length - 1][1] - 100) < 1e-9);
  assert.ok(entityPolylines(d.entities[2]).length >= 4);
});

test('blockEntityChanges: resalta la entidad dentro del bloque (coordenadas locales), no el insert', async () => {
  const { createBlock, insertBlock, editBlock } = await import('../core/blockOps');
  const { blockEntityChanges } = await import('./drawingDiff');
  let d = createDrawing('P', { id: 'd9' });
  d = addEntities(d, [{ type: 'line', a: [0, 0], b: [10, 0] }, { type: 'line', a: [0, 5], b: [10, 5] }]).drawing;
  d = createBlock(d, { name: 'B', ids: ['e1', 'e2'] }).drawing;
  d = insertBlock(d, { block: 'B', p: [500, 500] }).drawing;
  const old: Project = withDrawing(defaultProject(), d);
  const nd = editBlock(d, 'B', (b) => updateEntity(b, 'e1', { b: [20, 0] } as never));
  const cur: Project = withDrawing(defaultProject(), nd);
  const r = blockEntityChanges(old, cur, 'd9', 'B')!;
  assert.deepEqual(r.change!.changed.map((e) => e.id), ['e1']);
  assert.equal(r.change!.changed[0].type, 'line'); // la entidad del bloque, no el insert
  assert.equal(blockEntityChanges(old, old, 'd9', 'B')!.change, null);
  assert.equal(blockEntityChanges(old, cur, 'd9', 'Nada'), null);
});
