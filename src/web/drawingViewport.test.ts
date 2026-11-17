import test from 'node:test';
import assert from 'node:assert/strict';
import { fitView, gridLines, gridStep2d, panBy, toDrawing, toScreen, visibleBounds, zoomAt, zoomText, MAX_SCALE, MIN_SCALE, type View } from './drawingViewport';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const V: View = { cx: 100, cy: 50, scale: 2, w: 800, h: 600 };

test('toScreen y toDrawing son inversas; y crece hacia arriba en el dibujo', () => {
  const s = toScreen(V, [100, 50]);
  assert.deepEqual(s, [400, 300]); // el centro de la vista cae en el centro del lienzo
  const up = toScreen(V, [100, 60]);
  assert.ok(up[1] < 300, 'un punto más arriba en el dibujo queda más arriba en pantalla');
  const p = toDrawing(V, toScreen(V, [-37.5, 412]));
  near(p[0], -37.5); near(p[1], 412);
});

test('zoomAt deja fijo el punto del dibujo bajo el cursor', () => {
  const cursor: [number, number] = [123, 456];
  const before = toDrawing(V, cursor);
  for (const k of [0.5, 1.7, 8]) {
    const z = zoomAt(V, cursor[0], cursor[1], k);
    near(z.scale, V.scale * k);
    const after = toDrawing(z, cursor);
    near(after[0], before[0], 1e-7); near(after[1], before[1], 1e-7);
  }
});

test('zoomAt respeta los límites de escala', () => {
  assert.equal(zoomAt(V, 0, 0, 1e9).scale, MAX_SCALE);
  assert.equal(zoomAt(V, 0, 0, 1e-9).scale, MIN_SCALE);
  const maxed = { ...V, scale: MAX_SCALE };
  assert.deepEqual(zoomAt(maxed, 5, 5, 2), maxed); // ya está en el límite: no cambia nada
});

test('panBy: el dibujo sigue al cursor', () => {
  const p: [number, number] = [130, 20];
  const s0 = toScreen(V, p);
  const moved = panBy(V, 25, -40);
  const s1 = toScreen(moved, p);
  near(s1[0], s0[0] + 25); near(s1[1], s0[1] - 40);
});

test('fitView encuadra la caja con margen y la centra', () => {
  const v = fitView({ min: [0, 0], max: [4000, 3000] }, 800, 600, 40);
  const a = toScreen(v, [0, 0]), b = toScreen(v, [4000, 3000]);
  assert.ok(a[0] >= 39.999 && b[0] <= 760.001 && b[1] >= 39.999 && a[1] <= 560.001);
  near((a[0] + b[0]) / 2, 400); near((a[1] + b[1]) / 2, 300);
  // dibujo vacío: 6 m de ancho alrededor del origen
  const e = fitView(null, 600, 400);
  near(e.cx, 0); near(e.scale, 600 / 6000);
  // un solo punto o una línea horizontal no dan escala infinita
  assert.ok(Number.isFinite(fitView({ min: [5, 5], max: [5, 5] }, 800, 600).scale));
  assert.ok(Number.isFinite(fitView({ min: [0, 5], max: [100, 5] }, 800, 600).scale));
});

test('gridStep2d reutiliza los pasos de units.ts y sigue con potencias de 10 al alejarse', () => {
  assert.equal(gridStep2d(1), 50); // 1 mm/px: el menor paso con >= 14 px es 50
  assert.equal(gridStep2d(0.1), 5);
  assert.equal(gridStep2d(100), 10000);
  const px = (mm: number) => gridStep2d(mm) / mm;
  for (const mm of [0.05, 0.3, 2, 17, 400, 9000]) assert.ok(px(mm) >= 14, `${mm} mm/px`);
});

test('gridLines: cuadrícula adaptativa, líneas mayores cada 5 pasos y ejes visibles', () => {
  const g = gridLines({ cx: 0, cy: 0, scale: 0.1, w: 800, h: 600 }); // 10 mm/px -> paso 200 (>= 14 px)
  assert.equal(g.step, 200);
  assert.ok(g.vertical.length > 10 && g.vertical.length < 60);
  const zero = g.vertical.find((l) => l.mm === 0)!;
  assert.ok(zero.major);
  near(zero.px, 400);
  assert.equal(g.axisX, 400);
  assert.equal(g.axisY, 300);
  // con el origen fuera de la vista no hay ejes
  assert.equal(gridLines({ cx: 1e6, cy: 1e6, scale: 0.1, w: 800, h: 600 }).axisX, null);
  // a menor zoom, menos líneas y paso mayor
  assert.ok(gridLines({ cx: 0, cy: 0, scale: 0.01, w: 800, h: 600 }).step > g.step);
});

test('visibleBounds y zoomText', () => {
  const b = visibleBounds(V);
  near(b.min[0], 100 - 200); near(b.max[0], 100 + 200); near(b.min[1], 50 - 150); near(b.max[1], 50 + 150);
  assert.equal(zoomText({ ...V, scale: 0.05 }), '5%');
});
