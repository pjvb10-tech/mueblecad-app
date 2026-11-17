import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, createDrawing, DrawingError } from './drawing';
import { createBlock, insertBlock, editBlock } from './blockOps';
import { drawingShapes } from './viewShapes';
import { buildSheet, placedToSvg, shapesToPdfOps, shapesBounds, placeShapes } from './viewSheet';
import { drawingToPdf } from './pdfDrawing';
import { trimEntity, extendEntity } from './trimExtend';
import { syncHatches } from './hatch';
import { diffDrawings, changeText } from '../web/drawingDiff';
import type { Drawing, HatchEntity } from './types';

/** Placa 1000×500 con un hueco central sombreado (ansi31), y un bloque "Silla" insertado dos veces. */
function plano(): Drawing {
  let d = createDrawing('p');
  d = addEntities(d, [
    { type: 'rect', p1: [0, 0], p2: [1000, 500] },
    { type: 'hatch', loops: [[[0, 0], [1000, 0], [1000, 500], [0, 500]], [[300, 100], [700, 100], [700, 400], [300, 400]]], pattern: 'ansi31', scale: 50 },
    { type: 'line', a: [2000, 0], b: [2100, 0] },
  ]).drawing;
  d = addEntities(d, [{ type: 'line', a: [0, 600], b: [50, 650] }, { type: 'circle', c: [25, 625], r: 10 }]).drawing;
  d = createBlock(d, { name: 'Silla', ids: ['e4', 'e5'], replace: true }).drawing;
  d = insertBlock(d, { block: 'Silla', p: [500, 700] }).drawing;
  return d;
}

test('viewShapes: el dibujo exportado incluye sombreados (relleno par-impar + trazos) e inserts resueltos', () => {
  const d = plano();
  const shapes = drawingShapes(d);
  const n = (t: string) => shapes.filter((s) => s.t === t).length;
  assert.ok(n('line') > 10, 'trazos del patrón + las líneas del bloque');
  // el insert (1 línea + 1 círculo) y el original en (0,600) tras reemplazar: 2 inserts → 2 círculos como poly cerrada
  assert.equal(shapes.filter((s) => s.t === 'poly' && s.closed).length, 2 + 1, 'rect + 2 círculos de los inserts');
  const sd = createDrawing('s');
  const solid = addEntities(sd, [{ type: 'hatch', loops: [[[0, 0], [100, 0], [100, 100], [0, 100]], [[20, 20], [80, 20], [80, 80], [20, 80]]], pattern: 'solid', color: 1 }]).drawing;
  const fills = drawingShapes(solid).filter((s) => s.t === 'fill');
  assert.equal(fills.length, 1);
  const f = fills[0] as Extract<(typeof fills)[number], { t: 'fill' }>;
  assert.equal(f.polys.length, 2, 'contorno e isla');
  const b = shapesBounds(drawingShapes(solid))!;
  assert.deepEqual([b.x0, b.y0, b.x1, b.y1 + 0], [0, -100, 100, 0]);
  const placed = placeShapes(drawingShapes(solid), { x: 0, y: 0, w: 100, h: 100 }, 'exact');
  const svg = placedToSvg(placed.shapes, 100, 100);
  assert.match(svg, /fill-rule="evenodd"/);
  assert.ok(shapesToPdfOps(placed.shapes, 100).some((o) => o.endsWith('f*')), 'PDF con relleno par-impar');
  const sheet = buildSheet({ title: 't', cells: [{ title: 'plano', content: { kind: 'shapes', shapes: drawingShapes(d) } }] });
  assert.ok(sheet.shapes.length > 10);
});

test('capa apagada: sombreados e inserts de esa capa no se exportan', () => {
  let d = plano();
  d = { ...d, layers: d.layers.map((l) => (l.name === '0' ? { ...l, on: false } : l)) };
  assert.equal(drawingShapes(d).length, 0);
  assert.ok(drawingToPdf(plano()).length > 500);
});

test('recortar y extender: un insert no es objetivo ni borde (mensaje claro); sombreado asociativo se recalcula', () => {
  const d = plano();
  const ins = d.entities.find((e) => e.type === 'insert')!;
  assert.throws(() => trimEntity(d, ins.id, [500, 700], 'todos'), (e: Error) => e instanceof DrawingError && /bloque insertado/.test(e.message));
  assert.throws(() => extendEntity(d, 'e3', [2100, 0], [ins.id]), (e: Error) => e instanceof DrawingError && /bloque insertado/.test(e.message));
  // asociativo: contorno = polilínea cerrada; se recorta/extiende una línea y el sombreado la sigue
  let a = createDrawing('a');
  a = addEntities(a, [{ type: 'rect', p1: [0, 0], p2: [100, 100] }]).drawing;
  a = addEntities(a, [{ type: 'hatch', loops: [[[0, 0], [100, 0], [100, 100], [0, 100]]], pattern: 'lines', source: ['e1'] }]).drawing;
  const moved = syncHatches(a, { ...a, entities: a.entities.map((e) => (e.id === 'e1' && e.type === 'poly' ? { ...e, pts: e.pts.map((v) => ({ ...v, p: [v.p[0] * 2, v.p[1]] as [number, number] })) } : e)) });
  const h = moved.entities.find((e) => e.type === 'hatch') as HatchEntity;
  assert.equal(h.loops[0][1].p[0], 200);
});

test('resaltado en vivo: editar la definición de un bloque marca todos sus inserts', () => {
  let d = plano();
  d = insertBlock(d, { block: 'Silla', p: [900, 700] }).drawing;
  const edited = editBlock(d, 'Silla', (b) => addEntities(b, [{ type: 'line', a: [0, 0], b: [5, 5] }]).drawing);
  const [c] = diffDrawings({ drawings: [d] }, { drawings: [edited] });
  assert.deepEqual(c.blocks, ['silla']);
  assert.equal(c.changed.filter((e) => e.type === 'insert').length, 3);
  assert.match(changeText([c]), /1 bloque editado/);
  assert.deepEqual(diffDrawings({ drawings: [d] }, { drawings: [d] }), []);
});
