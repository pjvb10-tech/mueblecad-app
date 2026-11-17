import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, createDrawing, updateEntity, DrawingError, addLayer } from '../core/drawing';
import type { Entity } from '../core/types';
import { entityFields, entitySummary, fieldPatch, numText, parseEntityInput, parseNum, parsePts, ptsText } from './drawingFields';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);

test('numText: sin ruido de coma flotante y con punto decimal', () => {
  assert.equal(numText(12.0000001), '12');
  assert.equal(numText(0.1 + 0.2), '0.3');
  assert.equal(numText(-0), '0');
});

test('parseNum acepta coma decimal y rechaza lo que no es número', () => {
  assert.equal(parseNum('12,5'), 12.5);
  assert.equal(parseNum(' -3 '), -3);
  assert.throws(() => parseNum('abc', 'r'), DrawingError);
  assert.throws(() => parseNum(''), DrawingError);
});

test('entityFields: campos de cada tipo y ida y vuelta con fieldPatch + updateEntity', () => {
  let d = createDrawing('T');
  d = addEntities(d, [
    { type: 'line', a: [0, 0], b: [100, 0] }, { type: 'circle', c: [10, 20], r: 5 }, { type: 'arc', c: [0, 0], r: 10, a0: 0, a1: 90 },
    { type: 'poly', pts: [[0, 0], [10, 0], { p: [10, 10], bulge: 0.5 }], closed: true }, { type: 'text', p: [1, 2], h: 50, s: 'Hola' },
    { type: 'dim', kind: 'linear', p1: [0, 0], p2: [100, 0], at: [0, -30] }, { type: 'dim', kind: 'radius', c: [0, 0], r: 10 },
  ]).drawing;
  assert.deepEqual(entityFields(d.entities[0]).map((f) => f.key), ['a.0', 'a.1', 'b.0', 'b.1']);
  assert.deepEqual(entityFields(d.entities[1]).map((f) => f.key), ['c.0', 'c.1', 'r']);
  assert.deepEqual(entityFields(d.entities[2]).map((f) => f.key), ['c.0', 'c.1', 'r', 'a0', 'a1']);
  assert.deepEqual(entityFields(d.entities[3]).map((f) => f.key), ['pts', 'closed']);
  assert.ok(entityFields(d.entities[4]).some((f) => f.key === 'align'));
  assert.ok(entityFields(d.entities[5]).some((f) => f.key === 'rot'));
  // línea: cambiar la x de b
  const line = d.entities[0];
  const d2 = updateEntity(d, line.id, fieldPatch(line, 'b.0', '250,5'));
  assert.deepEqual((d2.entities[0] as { b: number[] }).b, [250.5, 0]);
  // círculo: radio
  assert.equal((updateEntity(d, d.entities[1].id, fieldPatch(d.entities[1], 'r', '7')).entities[1] as { r: number }).r, 7);
  // radio inválido: la validación del núcleo lo rechaza
  assert.throws(() => updateEntity(d, d.entities[1].id, fieldPatch(d.entities[1], 'r', '-1')), DrawingError);
  // texto vacío en una cota vuelve a la medida calculada
  const dim = d.entities[5];
  const withText = updateEntity(d, dim.id, fieldPatch(dim, 'text', 'A'));
  assert.equal((withText.entities[5] as { text?: string }).text, 'A');
  assert.equal('text' in updateEntity(withText, dim.id, fieldPatch(withText.entities[5], 'text', '')).entities[5], false);
  // rot 0 se quita
  const t = d.entities[4];
  const rotated = updateEntity(d, t.id, fieldPatch(t, 'rot', '30'));
  assert.equal((rotated.entities[4] as { rot?: number }).rot, 30);
  assert.equal('rot' in updateEntity(rotated, t.id, fieldPatch(rotated.entities[4], 'rot', '0')).entities[4], false);
});

test('polilíneas: ptsText y parsePts van y vienen con bulges', () => {
  const pts = [{ p: [0, 0] as [number, number] }, { p: [10, 0] as [number, number], bulge: 0.5 }, { p: [10, 10] as [number, number] }];
  assert.equal(ptsText(pts), '0,0; 10,0,0.5; 10,10');
  assert.deepEqual(parsePts('0,0; 10,0,0.5; 10,10'), pts);
  assert.throws(() => parsePts('1;2,3'), DrawingError);
  assert.throws(() => parsePts('1,2,3,4'), DrawingError);
  // cambiar vértices y cerrar desde los campos
  let d = createDrawing('T');
  d = addEntities(d, [{ type: 'poly', pts: [[0, 0], [10, 0], [10, 10]] }]).drawing;
  const e = d.entities[0];
  const d2 = updateEntity(updateEntity(d, e.id, fieldPatch(e, 'pts', '0,0; 20,0; 20,20; 0,20')), e.id, fieldPatch(e, 'closed', true));
  const p = d2.entities[0] as Extract<Entity, { type: 'poly' }>;
  assert.equal(p.pts.length, 4);
  assert.equal(p.closed, true);
  assert.equal(entitySummary(p), '4 vért. · largo 80 · área 400 mm²');
});

test('parseEntityInput: línea, rect, círculo, arco, polilínea, texto y cotas', () => {
  assert.deepEqual(parseEntityInput('line 0,0 100,0'), { type: 'line', a: [0, 0], b: [100, 0] });
  assert.deepEqual(parseEntityInput('LINEA 0,0 @50,25'), { type: 'line', a: [0, 0], b: [50, 25] });
  assert.deepEqual(parseEntityInput('rect 10,10 @400,300'), { type: 'rect', p1: [10, 10], p2: [410, 310] });
  assert.deepEqual(parseEntityInput('circle 50,50 20'), { type: 'circle', c: [50, 50], r: 20 });
  assert.deepEqual(parseEntityInput('circle 50,50 d40'), { type: 'circle', c: [50, 50], d: 40 });
  assert.deepEqual(parseEntityInput('arc 0,0 100 0 90'), { type: 'arc', c: [0, 0], r: 100, a0: 0, a1: 90 });
  assert.deepEqual(parseEntityInput('arc 1,0 0,1 -1,0'), { type: 'arc', pts: [[1, 0], [0, 1], [-1, 0]] });
  assert.deepEqual(parseEntityInput('poly 0,0 100,0 100,50 c'), { type: 'poly', pts: [{ p: [0, 0] }, { p: [100, 0] }, { p: [100, 50] }], closed: true });
  assert.deepEqual(parseEntityInput('poly 0,0 100,0,0.5'), { type: 'poly', pts: [{ p: [0, 0] }, { p: [100, 0], bulge: 0.5 }] });
  assert.deepEqual(parseEntityInput('text 10,10 50 Sala de estar'), { type: 'text', p: [10, 10], h: 50, s: 'Sala de estar' });
  assert.deepEqual(parseEntityInput('dim linear 0,0 4000,0 0,-300'), { type: 'dim', kind: 'linear', p1: [0, 0], p2: [4000, 0], at: [0, -300] });
  assert.deepEqual(parseEntityInput('dim radius 5,5 20'), { type: 'dim', kind: 'radius', c: [5, 5], r: 20 });
  // polar: @distancia<ángulo
  const polar = parseEntityInput('line 0,0 @100<90') as { b: [number, number] };
  near(polar.b[0], 0, 1e-9); near(polar.b[1], 100, 1e-9);
});

test('parseEntityInput: errores claros', () => {
  assert.throws(() => parseEntityInput(''), /Escribe una entidad/);
  assert.throws(() => parseEntityInput('hexagono 1,1 2'), /no es un tipo de entidad/);
  assert.throws(() => parseEntityInput('line 0,0'), /faltan datos/);
  assert.throws(() => parseEntityInput('line @1,1 2,2'), /relativo/);
  assert.throws(() => parseEntityInput('circle 5,5 abc'), /no es un número/);
  assert.throws(() => parseEntityInput('dim raro 0,0 1,1 0,0'), /linear, aligned, radius o diameter/);
});

test('lo que escribe parseEntityInput lo acepta addEntities (con capa)', () => {
  let d = addLayer(createDrawing('T'), { name: 'Muros', color: 1 });
  for (const line of ['line 0,0 100,0', 'rect 0,0 400,300', 'circle 5,5 d4', 'arc 0,0 10 0 90', 'poly 0,0 1,0 1,1 c', 'text 0,0 10 hola', 'dim aligned 0,0 100,0 0,-20']) {
    d = addEntities(d, [{ ...parseEntityInput(line), layer: 'Muros' }]).drawing;
  }
  assert.equal(d.entities.length, 7);
  assert.ok(d.entities.every((e) => e.layer === 'Muros'));
});
