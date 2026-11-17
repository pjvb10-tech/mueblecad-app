import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, addLayer, createDrawing, setLayer } from '../core/drawing';
import { arcPathData, contentTransform, entitiesInBox, entitiesSvg, entityColor, entityStyle, layerVisible, pickEntity, polyPathData, strokePx, DASH } from './drawingRender';

const build = () => {
  let d = createDrawing('T');
  d = addLayer(d, { name: 'Ejes', color: 1, linetype: 'center' });
  d = addLayer(d, { name: 'Cotas', color: '#00aa00', linetype: 'dashed', lineweight: 0.5 });
  return addEntities(d, [
    { type: 'line', a: [0, 0], b: [100, 0] },
    { type: 'circle', c: [200, 50], r: 20, layer: 'Ejes' },
    { type: 'rect', p1: [300, 0], p2: [400, 100], color: '#ff8800' },
    { type: 'text', p: [0, 200], h: 30, s: 'A<B', layer: 'Cotas' },
    { type: 'dim', kind: 'linear', p1: [0, 0], p2: [100, 0], at: [0, -40], layer: 'Cotas' },
  ]);
};

test('colores y estilos: por capa, propio, ACI 7 negro, tipo de línea y grosor', () => {
  const { drawing: d } = build();
  assert.equal(entityColor(d, d.entities[0]), '#000000'); // capa 0, ACI 7 sobre papel claro
  assert.equal(entityColor(d, d.entities[1]), '#ff0000'); // ACI 1 de la capa Ejes
  assert.equal(entityColor(d, d.entities[2]), '#ff8800'); // color propio
  assert.equal(entityStyle(d, d.entities[1]).dash, DASH.center);
  assert.equal(entityStyle(d, d.entities[3]).dash, DASH.dashed);
  assert.equal(strokePx(), 1);
  assert.ok(strokePx(0.5) > strokePx(0.25));
  assert.equal(strokePx(100), 6);
});

test('capas apagadas o congeladas no se dibujan; las bloqueadas sí', () => {
  let { drawing: d } = build();
  assert.ok(entitiesSvg(d, new Set()).includes('data-id="e2"'));
  d = setLayer(d, 'Ejes', { on: false });
  assert.ok(!entitiesSvg(d, new Set()).includes('data-id="e2"'));
  d = setLayer(setLayer(d, 'Ejes', { on: true }), 'Ejes', { frozen: true });
  assert.ok(!entitiesSvg(d, new Set()).includes('data-id="e2"'));
  d = setLayer(setLayer(d, 'Ejes', { frozen: false }), 'Ejes', { locked: true });
  const svg = entitiesSvg(d, new Set());
  assert.ok(svg.includes('data-id="e2"') && svg.includes('locked'));
  assert.equal(layerVisible(undefined), false);
});

test('entitiesSvg: texto escapado, cota con líneas y texto, selección resaltada', () => {
  const { drawing: d } = build();
  const svg = entitiesSvg(d, new Set(['e1']));
  assert.ok(svg.includes('A&lt;B'));
  assert.ok(/data-id="e5"[^>]*><path d="M[^"]*"[^>]*\/><text/.test(svg), 'la cota se dibuja como líneas + texto');
  assert.ok(svg.includes('class="sel"') && svg.includes('#2f6fed'));
  assert.ok(svg.includes('vector-effect="non-scaling-stroke"'));
});

test('trazos SVG: arco por bulge y arco CCW; el barrido antihorario es sweep-flag 1', () => {
  // semicírculo CCW de (0,0) a (10,0) con bulge +1: radio 5, large-arc 0 (180° no pasa de 180), sweep 1
  assert.equal(polyPathData([{ p: [0, 0], bulge: 1 }, { p: [10, 0] }], false), 'M0 0A5 5 0 0 1 10 0');
  // bulge negativo = horario
  assert.equal(polyPathData([{ p: [0, 0], bulge: -1 }, { p: [10, 0] }], false), 'M0 0A5 5 0 0 0 10 0');
  assert.equal(polyPathData([{ p: [0, 0] }, { p: [10, 0] }, { p: [10, 10] }], true), 'M0 0L10 0L10 10L0 0Z');
  assert.equal(arcPathData([0, 0], 10, 0, 90), 'M10 0A10 10 0 0 1 0 10');
  assert.equal(arcPathData([0, 0], 10, 0, 270), 'M10 0A10 10 0 1 1 0 -10');
  assert.ok(arcPathData([0, 0], 10, 30, 30).endsWith('Z'), 'a0 == a1 es la vuelta completa');
});

test('contentTransform lleva el dibujo a píxeles con y invertida', () => {
  const t = contentTransform({ cx: 100, cy: 50, scale: 2, w: 800, h: 600 });
  assert.equal(t, 'matrix(2 0 0 -2 200 400)'); // (100,50) -> (400,300)
});

test('pickEntity: el más cercano dentro de la tolerancia; ignora capas apagadas', () => {
  let { drawing: d } = build();
  assert.equal(pickEntity(d, [50, 3], 5), 'e1');
  assert.equal(pickEntity(d, [50, 30], 5), null);
  assert.equal(pickEntity(d, [220, 50], 5), 'e2'); // borde del círculo
  assert.equal(pickEntity(d, [200, 50], 5), null); // el centro del círculo no es borde
  d = setLayer(d, 'Ejes', { on: false });
  assert.equal(pickEntity(d, [220, 50], 5), null);
});

test('entitiesInBox: ventana (dentro) y cruce (toca)', () => {
  const { drawing: d } = build();
  assert.deepEqual(entitiesInBox(d, [-10, -10], [110, 10]), ['e1']);
  assert.deepEqual(entitiesInBox(d, [-10, -10], [110, 10], true).sort(), ['e1', 'e5']);
  assert.deepEqual(entitiesInBox(d, [150, -10], [250, 100]), ['e2']);
  assert.deepEqual(entitiesInBox(d, [350, -10], [450, 20]), []); // el rectángulo no cabe entero
  assert.deepEqual(entitiesInBox(d, [350, -10], [450, 20], true), ['e3']);
});
