import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arcFrom3Points, bulgeArc, bulgeFrom3Points, bulgeFromSweep, circleFrom3Points, dimGeometry, dimLabel, dimMeasure, distPointEntity, entityBounds, intersectCircles, intersectLineCircle,
  intersectLines, intersectSegments, isCCW, joinSegments, orientCCW, polyArea, polyCentroid, polyLength, polyPerimeter, polySignedArea, reversePoly, sweepOf, tessellateArc, tessellatePoly,
} from './geom2d';
import type { DimEntity, Entity, Pt2 } from './types';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearP = (a: Pt2, b: Pt2, eps = 1e-6) => { near(a[0], b[0], eps); near(a[1], b[1], eps); };
const base = { id: 'e1', layer: '0' };

test('bulge: semicírculo, cuarto de círculo y signo', () => {
  near(bulgeFromSweep(180), 1);
  const a = bulgeArc([0, 0], [10, 0], 1)!; // semicírculo CCW por debajo de la cuerda (se curva a la derecha)
  nearP(a.c, [5, 0]); near(a.r, 5); near(a.sweep, 180);
  near(a.a0, 180); near(a.a1, 0); // CCW de 180° a 360°: pasa por 270° (abajo)
  const b = bulgeArc([0, 0], [10, 0], -1)!; // CW: se curva a la izquierda (arriba)
  nearP(b.c, [5, 0]); near(b.a0, 0); near(b.a1, 180);
  const q = bulgeArc([1, 0], [0, 1], bulgeFromSweep(90))!; // cuarto CCW centrado en el origen
  nearP(q.c, [0, 0]); near(q.r, 1); near(q.a0, 0); near(q.a1, 90);
  assert.equal(bulgeArc([0, 0], [1, 0], 0), null);
});

test('arco y círculo por 3 puntos', () => {
  const c = circleFrom3Points([1, 0], [0, 1], [-1, 0])!;
  nearP(c.c, [0, 0]); near(c.r, 1);
  assert.equal(circleFrom3Points([0, 0], [1, 1], [2, 2]), null);
  const ccw = arcFrom3Points([1, 0], [0, 1], [-1, 0])!;
  assert.ok(ccw.ccw); near(ccw.a0, 0); near(ccw.a1, 180);
  const cw = arcFrom3Points([1, 0], [0, -1], [-1, 0])!; // por abajo, de (1,0) a (-1,0): CW
  assert.ok(!cw.ccw); near(cw.a0, 180); near(cw.a1, 0); near(cw.sweep, 180);
  near(bulgeFrom3Points([1, 0], [0, 1], [-1, 0])!, 1);
  near(bulgeFrom3Points([1, 0], [0, -1], [-1, 0])!, -1);
});

test('poly con bulge: longitud, área, perímetro y centroide (cuadrado 10 + semicírculo exterior)', () => {
  // cuadrado CCW de lado 10; el lado de arriba (de (10,10) a (0,10)) abombado hacia afuera: bulge +1 (a la derecha del recorrido)
  const poly = { pts: [{ p: [0, 0] as Pt2 }, { p: [10, 0] as Pt2 }, { p: [10, 10] as Pt2, bulge: 1 }, { p: [0, 10] as Pt2 }], closed: true };
  near(polyArea(poly), 100 + (Math.PI * 25) / 2);
  near(polyLength(poly), 30 + Math.PI * 5);
  near(polyPerimeter(poly), 30 + Math.PI * 5);
  const c = polyCentroid(poly)!;
  near(c[0], 5);
  const semi = (4 * 5) / (3 * Math.PI);
  near(c[1], (100 * 5 + ((Math.PI * 25) / 2) * (10 + semi)) / (100 + (Math.PI * 25) / 2));
  assert.ok(isCCW(poly));
  // un bulge hacia adentro resta área
  const dent = { pts: [{ p: [0, 0] as Pt2 }, { p: [10, 0] as Pt2 }, { p: [10, 10] as Pt2, bulge: -1 }, { p: [0, 10] as Pt2 }] };
  near(polyArea(dent), 100 - (Math.PI * 25) / 2);
  // abierta: sin el cierre
  near(polyLength({ pts: poly.pts, closed: false }), 20 + Math.PI * 5);
});

test('orientación e inversión conservan el área y la geometría', () => {
  const cw = [{ p: [0, 0] as Pt2 }, { p: [0, 10] as Pt2, bulge: 0.5 }, { p: [10, 10] as Pt2 }, { p: [10, 0] as Pt2 }];
  assert.ok(polySignedArea({ pts: cw }) < 0);
  const ccw = orientCCW(cw);
  assert.ok(isCCW({ pts: ccw }));
  near(polyArea({ pts: ccw }), polyArea({ pts: cw }));
  assert.deepEqual(reversePoly(reversePoly(cw, true), true), cw);
});

test('teselado: extremos exactos, tolerancia respetada', () => {
  const pts = tessellateArc([0, 0], 100, 0, 90, 0.1);
  nearP(pts[0], [100, 0]); nearP(pts[pts.length - 1], [0, 100]);
  for (let i = 0; i + 1 < pts.length; i++) {
    const m: Pt2 = [(pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2];
    assert.ok(100 - Math.hypot(m[0], m[1]) <= 0.1 + 1e-9);
  }
  assert.equal(sweepOf(350, 10), 20);
  const t = tessellatePoly({ pts: [{ p: [0, 0] }, { p: [10, 0], bulge: -1 }, { p: [0, 10] }], closed: true }, 0.05);
  assert.ok(t.length > 6);
  nearP(t[0], [0, 0]); nearP(t[1], [10, 0]);
  // los puntos del arco del tramo (10,0)->(0,10) siguen el recorrido de inicio a fin
  assert.ok(Math.hypot(t[2][0] - 10, t[2][1]) < Math.hypot(t[t.length - 2][0] - 10, t[t.length - 2][1]));
});

test('caja envolvente: arco con cruces de eje, círculo y poly con bulge', () => {
  const arc: Entity = { ...base, type: 'arc', c: [0, 0], r: 10, a0: 300, a1: 60 }; // cruza 0°
  const b = entityBounds(arc)!;
  near(b.max[0], 10); near(b.max[1], Math.sin(Math.PI / 3) * 10); near(b.min[0], 5); near(b.min[1], -Math.sin(Math.PI / 3) * 10);
  const c = entityBounds({ ...base, type: 'circle', c: [5, 5], r: 2 })!;
  assert.deepEqual([c.min, c.max], [[3, 3], [7, 7]]);
  const p = entityBounds({ ...base, type: 'poly', pts: [{ p: [0, 0], bulge: 1 }, { p: [10, 0] }] })!;
  near(p.min[1], -5); near(p.max[1], 0);
});

test('intersecciones', () => {
  nearP(intersectLines([0, 0], [1, 1], [0, 2], [2, 0])!.p, [1, 1]);
  assert.equal(intersectLines([0, 0], [1, 0], [0, 1], [1, 1]), null);
  assert.equal(intersectSegments([0, 0], [1, 1], [3, 0], [2, 0]), null);
  nearP(intersectSegments([0, 0], [2, 2], [0, 2], [2, 0])!, [1, 1]);
  const lc = intersectLineCircle([-10, 0], [10, 0], [0, 0], 5);
  assert.equal(lc.length, 2); nearP(lc[0], [-5, 0]); nearP(lc[1], [5, 0]);
  assert.equal(intersectLineCircle([-10, 5], [10, 5], [0, 0], 5).length, 1, 'tangente');
  assert.equal(intersectLineCircle([-10, 6], [10, 6], [0, 0], 5).length, 0);
  assert.equal(intersectLineCircle([0, 0], [1, 0], [0, 0], 5, { segment: true }).length, 0, 'fuera del segmento');
  const cc = intersectCircles([0, 0], 5, [6, 0], 5);
  assert.equal(cc.length, 2); nearP(cc[0], [3, 4]); nearP(cc[1], [3, -4]);
  assert.equal(intersectCircles([0, 0], 5, [10, 0], 5).length, 1);
  assert.equal(intersectCircles([0, 0], 5, [0, 0], 5).length, 0);
  assert.equal(intersectCircles([0, 0], 1, [10, 0], 1).length, 0);
});

test('distancia punto-entidad (hit-test)', () => {
  near(distPointEntity([5, 3], { ...base, type: 'line', a: [0, 0], b: [10, 0] }), 3);
  near(distPointEntity([13, 0], { ...base, type: 'line', a: [0, 0], b: [10, 0] }), 3);
  near(distPointEntity([0, 8], { ...base, type: 'circle', c: [0, 0], r: 5 }), 3);
  const arc: Entity = { ...base, type: 'arc', c: [0, 0], r: 5, a0: 0, a1: 90 };
  near(distPointEntity([-5, 0], arc), Math.hypot(5, 5)); // fuera del arco: va al extremo (0,5)
  near(distPointEntity([3, 3], arc), Math.abs(Math.hypot(3, 3) - 5));
  const poly: Entity = { ...base, type: 'poly', pts: [{ p: [0, 0] }, { p: [10, 0], bulge: 1 }, { p: [10, 10] }] };
  near(distPointEntity([15, 5], poly), 0); // sobre el semicírculo
  const text: Entity = { ...base, type: 'text', p: [0, 0], h: 10, s: 'AB' };
  near(distPointEntity([3, 5], text), 0);
  assert.ok(distPointEntity([50, 5], text) > 30);
});

test('cotas: medida calculada y descomposición en líneas + texto', () => {
  const lin: DimEntity = { ...base, type: 'dim', kind: 'linear', p1: [0, 0], p2: [100, 30], at: [0, 50] };
  near(dimMeasure(lin), 100); assert.equal(dimLabel(lin), '100');
  near(dimMeasure({ ...lin, rot: 90 }), 30);
  near(dimMeasure({ ...base, type: 'dim', kind: 'aligned', p1: [0, 0], p2: [30, 40], at: [0, 0] }), 50);
  const g = dimGeometry(lin);
  near(g.value, 100); assert.equal(g.texts[0].s, '100');
  assert.ok(g.lines.length >= 7); // 2 extensión + línea + 4 de flechas
  assert.ok(g.lines.some(([a, b]) => a[1] === 50 && b[1] === 50), 'la línea de cota queda sobre y = 50');
  assert.equal(dimLabel({ ...lin, text: '1 m' }), '1 m');
  assert.equal(dimLabel({ ...base, type: 'dim', kind: 'diameter', c: [0, 0], r: 12.5 }), 'Ø25');
  assert.equal(dimLabel({ ...base, type: 'dim', kind: 'radius', c: [0, 0], r: 12.5 }), 'R12.5');
  assert.ok(entityBounds(lin)!.max[1] >= 50);
});

test('unir segmentos en lazos cerrados y cadenas abiertas', () => {
  const r = joinSegments([[[0, 0], [10, 0]], [[10, 10], [10, 0]], [[10, 10], [0, 10]], [[0, 10], [0, 0]], [[50, 50], [60, 50]]]);
  assert.equal(r.loops.length, 1); assert.equal(r.loops[0].length, 4);
  assert.equal(r.open.length, 1);
});
