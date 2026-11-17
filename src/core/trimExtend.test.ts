import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, createDrawing, getEntity, setLayer } from './drawing';
import type { EntityInput } from './drawing';
import { applyOps } from './drawingTools';
import { bulgeArc, polySegments } from './geom2d';
import { diffOps, extendEntity, trimEntity } from './trimExtend';
import type { Drawing, Entity, Pt2 } from './types';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearP = (a: Pt2, b: Pt2, eps = 1e-6) => { near(a[0], b[0], eps); near(a[1], b[1], eps); };
const mk = (inputs: EntityInput[], layers: { name: string }[] = []): Drawing => addEntities(createDrawing('t', { layers }), inputs).drawing;
const ent = (d: Drawing, id: string) => getEntity(d, id) as Entity & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const L = (a: Pt2, b: Pt2): EntityInput => ({ type: 'line', a, b });

// ---------------------------------------------------------------- recortar línea

test('recortar línea: tramo entre dos bordes -> se parte en dos; el primero conserva el id', () => {
  const d = mk([L([0, 0], [100, 0]), L([30, -10], [30, 10]), L([70, -10], [70, 10])]); // e1 objetivo; e2, e3 bordes
  const ops = trimEntity(d, 'e1', [50, 0], ['e2', 'e3']);
  assert.deepEqual(ops.map((o) => o.op), ['update', 'add']);
  const r = applyOps(d, ops);
  assert.equal(r.drawing.entities.length, 4);
  assert.deepEqual(ent(r.drawing, 'e1').a, [0, 0]); nearP(ent(r.drawing, 'e1').b, [30, 0]);
  assert.equal(r.ids.length, 1);
  assert.notEqual(r.ids[0], 'e1');
  nearP(ent(r.drawing, r.ids[0]).a, [70, 0]); nearP(ent(r.drawing, r.ids[0]).b, [100, 0]);
  assert.equal(ent(r.drawing, r.ids[0]).layer, '0');
});

test('recortar línea: solo un lado con corte -> elimina hasta el extremo', () => {
  const d = mk([L([0, 0], [100, 0]), L([30, -10], [30, 10])]);
  let r = applyOps(d, trimEntity(d, 'e1', [80, 0], ['e2'])).drawing;
  assert.equal(r.entities.length, 2);
  nearP(ent(r, 'e1').a, [0, 0]); nearP(ent(r, 'e1').b, [30, 0]);
  r = applyOps(d, trimEntity(d, 'e1', [10, 0], ['e2'])).drawing; // lado izquierdo: queda [30..100]
  nearP(ent(r, 'e1').a, [30, 0]); nearP(ent(r, 'e1').b, [100, 0]);
});

test('recortar: sin intersección da un mensaje claro', () => {
  const d = mk([L([0, 0], [100, 0]), L([0, 10], [100, 10])]);
  assert.throws(() => trimEntity(d, 'e1', [50, 0], ['e2']), /no hay intersección/);
  assert.throws(() => trimEntity(d, 'e1', [50, 0], 'todos'), /no hay intersección/);
});

test('recortar: un borde que solo toca el extremo del objetivo no recorta nada', () => {
  const d = mk([L([0, 0], [100, 0]), L([100, -10], [100, 10])]);
  assert.throws(() => trimEntity(d, 'e1', [50, 0], ['e2']), /no hay intersección/);
});

test('recortar: tangente (línea tangente a un círculo) cuenta como un corte', () => {
  const d = mk([L([-50, 10], [50, 10]), { type: 'circle', c: [0, 0], r: 10 }]); // toca en (0,10)
  const r = applyOps(d, trimEntity(d, 'e1', [30, 10], ['e2'])).drawing;
  nearP(ent(r, 'e1').a, [-50, 10]); nearP(ent(r, 'e1').b, [0, 10]);
});

test('recortar: borde círculo secante corta la línea en dos puntos', () => {
  const d = mk([L([-50, 0], [50, 0]), { type: 'circle', c: [0, 0], r: 20 }]);
  const r = applyOps(d, trimEntity(d, 'e1', [0, 0], 'todos'));
  assert.equal(r.drawing.entities.length, 3);
  nearP(ent(r.drawing, 'e1').b, [-20, 0]);
  nearP(ent(r.drawing, r.ids[0]).a, [20, 0]);
});

test('recortar: borde arco solo corta donde el arco existe', () => {
  const d = mk([L([-50, 0], [50, 0]), { type: 'arc', c: [0, 0], r: 20, a0: 0, a1: 90 }]); // solo corta en (20,0)
  const r = applyOps(d, trimEntity(d, 'e1', [40, 0], ['e2'])).drawing;
  nearP(ent(r, 'e1').a, [-50, 0]); nearP(ent(r, 'e1').b, [20, 0]);
});

test('recortar: el propio objetivo en la lista de bordes se ignora; solo él es error', () => {
  const d = mk([L([0, 0], [100, 0]), L([30, -10], [30, 10])]);
  const r = applyOps(d, trimEntity(d, 'e1', [80, 0], ['e1', 'e2'])).drawing;
  nearP(ent(r, 'e1').b, [30, 0]);
  assert.throws(() => trimEntity(d, 'e1', [80, 0], ['e1']), /propio objeto/);
});

test('recortar: múltiples bordes eligen los cortes vecinos al clic', () => {
  const d = mk([L([0, 0], [100, 0]), L([20, -5], [20, 5]), L([40, -5], [40, 5]), L([60, -5], [60, 5]), L([80, -5], [80, 5])]);
  const r = applyOps(d, trimEntity(d, 'e1', [50, 0], 'todos'));
  nearP(ent(r.drawing, 'e1').b, [40, 0]);
  nearP(ent(r.drawing, r.ids[0]).a, [60, 0]); nearP(ent(r.drawing, r.ids[0]).b, [100, 0]);
});

test('recortar: bordes en "todos" ignoran capas congeladas/apagadas pero usan bloqueadas', () => {
  let d = mk([L([0, 0], [100, 0]), { ...L([30, -10], [30, 10]), layer: 'B' }], [{ name: 'B' }]);
  d = setLayer(d, 'B', { frozen: true });
  assert.throws(() => trimEntity(d, 'e1', [80, 0], 'todos'), /no hay intersección|No hay otros/);
  assert.throws(() => trimEntity(d, 'e1', [80, 0], ['e2']), /congelada/);
  d = setLayer(d, 'B', { frozen: false, locked: true });
  nearP(ent(applyOps(d, trimEntity(d, 'e1', [80, 0], 'todos')).drawing, 'e1').b, [30, 0]);
});

test('recortar/extender: objetivo en capa bloqueada o congelada da error claro', () => {
  let d = mk([{ ...L([0, 0], [100, 0]), layer: 'A' }, L([30, -10], [30, 10])], [{ name: 'A' }]);
  d = setLayer(d, 'A', { locked: true });
  assert.throws(() => trimEntity(d, 'e1', [80, 0], ['e2']), /bloqueada/);
  assert.throws(() => extendEntity(d, 'e1', [80, 0], ['e2']), /bloqueada/);
  d = setLayer(d, 'A', { locked: false, frozen: true });
  assert.throws(() => trimEntity(d, 'e1', [80, 0], ['e2']), /congelada/);
});

test('recortar: tipos y ids inválidos', () => {
  const d = mk([L([0, 0], [100, 0]), { type: 'text', p: [0, 0], h: 10, s: 'hola' }, L([30, -10], [30, 10])]);
  assert.throws(() => trimEntity(d, 'e2', [0, 0], ['e3']), /solo línea, arco, círculo o polilínea/);
  assert.throws(() => trimEntity(d, 'zz', [0, 0], ['e3']), /no existe/);
  assert.throws(() => trimEntity(d, 'e1', [0, 0], ['e2']), /solo sirven línea/);
  assert.throws(() => trimEntity(d, 'e1', [0, 0], ['nope']), /No existe el borde/);
  assert.throws(() => trimEntity(d, 'e1', [0, 0], []), /Indica los bordes/);
});

test('recortar: modo borde extendido usa la prolongación del borde', () => {
  const d = mk([L([0, 0], [100, 0]), L([50, 10], [50, 30])]); // el borde no llega a y=0
  assert.throws(() => trimEntity(d, 'e1', [80, 0], ['e2']), /no hay intersección/);
  const r = applyOps(d, trimEntity(d, 'e1', [80, 0], ['e2'], { edgeMode: 'extendido' })).drawing;
  nearP(ent(r, 'e1').b, [50, 0]);
});

// ---------------------------------------------------------------- recortar círculo y arco

test('recortar círculo -> arco con el mismo id; conserva el lado opuesto al clic', () => {
  const d = mk([{ type: 'circle', c: [0, 0], r: 10 }, L([-20, 0], [20, 0]), L([0, -20], [0, 20])]);
  const ops = trimEntity(d, 'e1', [7, 7], ['e2', 'e3']); // clic en el cuadrante 1 (entre 0° y 90°)
  assert.deepEqual(ops.map((o) => o.op), ['remove', 'add']);
  const r = applyOps(d, ops);
  const arc = ent(r.drawing, 'e1');
  assert.equal(arc.type, 'arc');
  assert.equal(r.ids[0], 'e1');
  near(arc.a0, 90); near(arc.a1, 0); // el arco CCW de 90° a 360° (270° de barrido)
  nearP(arc.c, [0, 0]); near(arc.r, 10);
});

test('recortar círculo con un solo corte no se puede; sin cortes tampoco', () => {
  const d = mk([{ type: 'circle', c: [0, 0], r: 10 }, L([0, 0], [20, 0]), L([100, 100], [200, 100])]);
  assert.throws(() => trimEntity(d, 'e1', [-10, 0], ['e2']), /al menos 2 cortes/);
  assert.throws(() => trimEntity(d, 'e1', [-10, 0], ['e3']), /al menos 2 cortes/);
});

test('recortar círculo entre dos círculos (lente): quita el trozo dentro del otro', () => {
  const d = mk([{ type: 'circle', c: [0, 0], r: 10 }, { type: 'circle', c: [10, 0], r: 10 }]);
  const arc = ent(applyOps(d, trimEntity(d, 'e1', [10, 0], ['e2'])).drawing, 'e1');
  assert.equal(arc.type, 'arc');
  const sweep = ((arc.a1 - arc.a0) % 360 + 360) % 360;
  near(sweep, 360 - 120, 1e-4); // los cruces están a ±60°
  near(arc.a0, 60, 1e-4);
});

test('recortar arco: dos cortes dan dos arcos; un corte da uno', () => {
  const d = mk([{ type: 'arc', c: [0, 0], r: 10, a0: 0, a1: 180 }, L([-20, 5], [20, 5])]);
  // la línea y=5 corta el arco en 30° y 150°; el clic arriba (90°) quita el tramo central
  const r = applyOps(d, trimEntity(d, 'e1', [0, 10], ['e2']));
  assert.equal(r.drawing.entities.length, 3);
  const a = ent(r.drawing, 'e1'), b = ent(r.drawing, r.ids[0]);
  near(a.a0, 0); near(a.a1, 30, 1e-4);
  near(b.a0, 150, 1e-4); near(b.a1, 180);
  const one = applyOps(d, trimEntity(d, 'e1', [9.9, 1], ['e2'])).drawing; // clic cerca de 0°: queda de 30° a 180°
  near(ent(one, 'e1').a0, 30, 1e-4); near(ent(one, 'e1').a1, 180);
  assert.equal(one.entities.length, 2);
});

test('recortar arco que cruza 0°/360° (a0 > a1)', () => {
  const d = mk([{ type: 'arc', c: [0, 0], r: 10, a0: 300, a1: 60 }, L([-5, 0], [20, 0]), L([0, 0], [0, 20])]);
  // arco de 300° a 60° (120° de barrido); cortes: y=0 en 0°; x=0 no lo corta (90° fuera)
  const r = applyOps(d, trimEntity(d, 'e1', [10, 3], ['e2'])).drawing; // clic a ~17°: quita de 0° a 60°
  near(ent(r, 'e1').a0, 300, 1e-4); near(ent(r, 'e1').a1, 0, 1e-4);
});

// ---------------------------------------------------------------- polilíneas

test('recortar polilínea abierta recta: corta en el tramo y reparte vértices', () => {
  const d = mk([{ type: 'poly', pts: [[0, 0], [100, 0], [100, 100]] }, L([50, -10], [50, 10]), L([90, 50], [110, 50])]);
  // e2 corta el primer tramo en (50,0); e3 corta el segundo en (100,50). Clic en la esquina (100,0): quita de (50,0) a (100,50)
  const r = applyOps(d, trimEntity(d, 'e1', [100, 0], ['e2', 'e3']));
  assert.equal(r.drawing.entities.length, 4);
  const a = ent(r.drawing, 'e1'), b = ent(r.drawing, r.ids[0]);
  assert.deepEqual(a.pts.map((v: any) => v.p), [[0, 0], [50, 0]]); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.deepEqual(b.pts.map((v: any) => v.p), [[100, 50], [100, 100]]); // eslint-disable-line @typescript-eslint/no-explicit-any
  assert.ok(!a.closed);
});

test('recortar polilínea con arcos: el arco partido conserva su curvatura (bulge)', () => {
  // semicírculo de (0,0) a (20,0) pasando por arriba (bulge -1 = horario), centro (10,0), radio 10
  const d = mk([{ type: 'poly', pts: [{ p: [0, 0], bulge: -1 }, { p: [20, 0] }, { p: [60, 0] }] }, L([10, -5], [10, 15])]);
  const r = applyOps(d, trimEntity(d, 'e1', [30, 0], ['e2'])); // corta el arco en su cúspide (10,10); recorta hacia el final
  const p = ent(r.drawing, 'e1');
  assert.equal(r.drawing.entities.length, 2);
  nearP(p.pts[0].p, [0, 0]); nearP(p.pts[p.pts.length - 1].p, [10, 10]);
  const seg = polySegments(p as never)[0];
  const arc = bulgeArc(seg.a, seg.b, seg.bulge)!;
  nearP(arc.c, [10, 0]); near(arc.r, 10); near(arc.sweep, 90, 1e-4);
});

test('recortar polilínea con arco en la parte que se conserva y en la que se quita', () => {
  const d = mk([{ type: 'poly', pts: [{ p: [0, 0], bulge: -1 }, { p: [20, 0] }, { p: [60, 0] }] }, L([10, -5], [10, 15]), L([40, -5], [40, 5])]);
  const r = applyOps(d, trimEntity(d, 'e1', [30, 0], ['e2', 'e3']));
  const a = ent(r.drawing, 'e1'), b = ent(r.drawing, r.ids[0]);
  nearP(a.pts[a.pts.length - 1].p, [10, 10]);
  assert.ok(a.pts[0].bulge !== undefined && Math.abs(a.pts[0].bulge) > 0);
  // segundo trozo: de (10,10) ... NO: el clic en (30,0) está entre (10,10) y (40,0), así que el segundo va de (40,0) a (60,0)
  assert.deepEqual(b.pts.map((v: any) => v.p), [[40, 0], [60, 0]]); // eslint-disable-line @typescript-eslint/no-explicit-any
});

test('recortar polilínea cerrada (rectángulo): queda abierta y con ids estables', () => {
  const d = mk([{ type: 'rect', p1: [0, 0], p2: [100, 50] }, L([40, -10], [40, 60]), L([-10, 25], [110, 25])]);
  // clic en el lado inferior: cortes en (40,0) (borde e2) y... el borde horizontal corta los laterales
  const ops = trimEntity(d, 'e1', [70, 0], ['e2', 'e3']);
  const r = applyOps(d, ops);
  assert.equal(r.drawing.entities.length, 3, 'una sola pieza abierta conserva el id');
  const p = ent(r.drawing, 'e1');
  assert.ok(!p.closed);
  assert.equal(p.type, 'poly');
  // el tramo quitado va de (40,0) a (100,25) pasando por (100,0): quedan (100,25)->(100,50)->(0,50)->(0,0)->(40,0)
  const want: Pt2[] = [[100, 25], [100, 50], [0, 50], [0, 0], [40, 0]];
  assert.equal(p.pts.length, 5);
  p.pts.forEach((v: any, i: number) => nearP(v.p, want[i])); // eslint-disable-line @typescript-eslint/no-explicit-any
});

test('recortar polilínea cerrada con un solo corte falla', () => {
  const d = mk([{ type: 'rect', p1: [0, 0], p2: [100, 50] }, L([40, -10], [40, 10])]);
  assert.throws(() => trimEntity(d, 'e1', [70, 0], ['e2']), /al menos 2 cortes/);
});

test('recortar polilínea: corte exacto en un vértice no genera tramos nulos', () => {
  const d = mk([{ type: 'poly', pts: [[0, 0], [50, 0], [50, 50]] }, L([50, -10], [50, 10]).type === 'line' ? L([40, 40], [60, 40]) : L([0, 0], [1, 1]), L([-10, 0], [10, 0])]);
  // e2 corta el segundo tramo en (50,40); e3 toca el extremo inicial (no cuenta)
  const r = applyOps(d, trimEntity(d, 'e1', [50, 45], ['e2', 'e3'])).drawing;
  assert.deepEqual(ent(r, 'e1').pts.map((v: any) => v.p), [[0, 0], [50, 0], [50, 40]]); // eslint-disable-line @typescript-eslint/no-explicit-any
});

// ---------------------------------------------------------------- extender

test('extender línea hasta un borde (extremo más cercano al clic)', () => {
  const d = mk([L([0, 0], [50, 0]), L([100, -20], [100, 20])]);
  const r = applyOps(d, extendEntity(d, 'e1', [45, 0], ['e2'])).drawing;
  nearP(ent(r, 'e1').a, [0, 0]); nearP(ent(r, 'e1').b, [100, 0]);
  // el otro extremo no tiene borde en su prolongación
  assert.throws(() => extendEntity(d, 'e1', [5, 0], ['e2']), /no hay intersección/);
  const d2 = mk([L([0, 0], [50, 0]), L([-30, -20], [-30, 20])]);
  const r2 = applyOps(d2, extendEntity(d2, 'e1', [5, 0], ['e2'])).drawing;
  nearP(ent(r2, 'e1').a, [-30, 0]); nearP(ent(r2, 'e1').b, [50, 0]);
});

test('extender línea: elige el primer borde, no el más lejano', () => {
  const d = mk([L([0, 0], [10, 0]), L([100, -5], [100, 5]), L([40, -5], [40, 5]), L([70, -5], [70, 5])]);
  nearP(ent(applyOps(d, extendEntity(d, 'e1', [9, 0], 'todos')).drawing, 'e1').b, [40, 0]);
});

test('extender línea oblicua hasta un círculo y un arco', () => {
  const d = mk([L([0, 0], [10, 10]), { type: 'circle', c: [50, 50], r: 10 }]);
  const r = applyOps(d, extendEntity(d, 'e1', [9, 9], ['e2'])).drawing;
  const e = Math.hypot(ent(r, 'e1').b[0] - 50, ent(r, 'e1').b[1] - 50);
  near(e, 10, 1e-6);
  nearP(ent(r, 'e1').b, [50 - 10 / Math.SQRT2, 50 - 10 / Math.SQRT2]);
  const d2 = mk([L([0, 0], [10, 0]), { type: 'arc', c: [50, 0], r: 20, a0: 90, a1: 270 }]);
  nearP(ent(applyOps(d2, extendEntity(d2, 'e1', [9, 0], ['e2'])).drawing, 'e1').b, [30, 0]);
});

test('extender: el borde detrás del extremo o fuera del arco no cuenta', () => {
  const d = mk([L([0, 0], [10, 0]), L([-20, -5], [-20, 5]), { type: 'arc', c: [50, 0], r: 20, a0: 10, a1: 90 }]);
  assert.throws(() => extendEntity(d, 'e1', [9, 0], ['e2']), /no hay intersección/); // e2 está detrás
  assert.throws(() => extendEntity(d, 'e1', [9, 0], ['e3']), /no hay intersección/); // el arco no existe en (30,0)
});

test('extender: modo borde extendido alcanza la prolongación del borde', () => {
  const d = mk([L([0, 0], [10, 0]), L([100, 10], [100, 30])]);
  assert.throws(() => extendEntity(d, 'e1', [9, 0], ['e2']), /no hay intersección/);
  nearP(ent(applyOps(d, extendEntity(d, 'e1', [9, 0], ['e2'], { edgeMode: 'extendido' })).drawing, 'e1').b, [100, 0]);
  // un arco como borde se vuelve círculo completo
  const d2 = mk([L([0, 0], [10, 0]), { type: 'arc', c: [50, 20], r: 20, a0: 270, a1: 360 }]); // toca (50,0) en 270°
  nearP(ent(applyOps(d2, extendEntity(d2, 'e1', [9, 0], ['e2'])).drawing, 'e1').b, [50, 0]);
  const d3 = mk([L([0, 0], [10, 0]), { type: 'arc', c: [50, 20], r: 20, a0: 0, a1: 90 }]);
  assert.throws(() => extendEntity(d3, 'e1', [9, 0], ['e2']), /no hay intersección/);
  nearP(ent(applyOps(d3, extendEntity(d3, 'e1', [9, 0], ['e2'], { edgeMode: 'extendido' })).drawing, 'e1').b, [50, 0]);
});

test('extender arco a lo largo de su círculo', () => {
  const d = mk([{ type: 'arc', c: [0, 0], r: 10, a0: 0, a1: 45 }, L([-20, 0], [20, 0]), L([0, -20], [0, 20])]);
  // extremo final (45°) hacia 90° (borde e3); extremo inicial (0°) hacia -> 270°... el primero que encuentre al retroceder
  let r = applyOps(d, extendEntity(d, 'e1', [7.07, 7.07], ['e3'])).drawing;
  near(ent(r, 'e1').a0, 0); near(ent(r, 'e1').a1, 90, 1e-4);
  r = applyOps(d, extendEntity(d, 'e1', [10, 0.1], ['e2', 'e3'])).drawing; // retrocede desde 0°: primer borde a 270° (x=0, y<0)
  near(ent(r, 'e1').a0, 270, 1e-4); near(ent(r, 'e1').a1, 45, 1e-4);
});

test('extender arco: no puede dar más de una vuelta ni cerrarse sobre sí mismo', () => {
  const d = mk([{ type: 'arc', c: [0, 0], r: 10, a0: 0, a1: 270 }, L([5, -20], [5, 20]), L([-5, -20], [-5, 20])]);
  // desde 270° hacia adelante: la recta x=5 corta el círculo en ±60°; 300° es el primero y cabe (270→300)
  const r = applyOps(d, extendEntity(d, 'e1', [0, -10], ['e2'])).drawing;
  near(ent(r, 'e1').a1, 300, 1e-4);
  // x=5 también se alcanza retrocediendo desde 0° (a 300°)
  near(ent(applyOps(d, extendEntity(d, 'e1', [10, 0.1], ['e2'])).drawing, 'e1').a0, 300, 1e-4);
  // x=-5 cae dentro del propio arco (120° y 240°): no cabe sin solaparse
  assert.throws(() => extendEntity(d, 'e1', [0, -10], ['e3']), /no hay intersección/);
  assert.throws(() => extendEntity(d, 'e1', [10, 0.1], ['e3']), /no hay intersección/);
});

test('extender polilínea en su último tramo (recto) y en el primero', () => {
  const d = mk([{ type: 'poly', pts: [[0, 0], [50, 0], [50, 30]] }, L([-20, 100], [120, 100]), L([-40, -5], [-40, 5])]);
  let r = applyOps(d, extendEntity(d, 'e1', [50, 28], ['e2'])).drawing;
  assert.deepEqual(ent(r, 'e1').pts.map((v: any) => v.p), [[0, 0], [50, 0], [50, 100]]); // eslint-disable-line @typescript-eslint/no-explicit-any
  r = applyOps(d, extendEntity(d, 'e1', [2, 0], ['e3'])).drawing;
  assert.deepEqual(ent(r, 'e1').pts.map((v: any) => v.p), [[-40, 0], [50, 0], [50, 30]]); // eslint-disable-line @typescript-eslint/no-explicit-any
});

test('extender polilínea cuyo último tramo es un arco', () => {
  // arco horario de (10,0) a (30,0) por arriba (centro 20,0, r=10); se extiende desde (30,0) hacia abajo hasta el borde y = -5
  const d = mk([{ type: 'poly', pts: [{ p: [0, 0] }, { p: [10, 0], bulge: -1 }, { p: [30, 0] }] }, L([-50, -5], [100, -5])]);
  const r = applyOps(d, extendEntity(d, 'e1', [29, 0], ['e2'])).drawing;
  const p = ent(r, 'e1');
  const last = p.pts[p.pts.length - 1].p as Pt2;
  near(last[1], -5);
  near(Math.hypot(last[0] - 20, last[1]), 10); // sigue sobre la circunferencia
  nearP(last, [20 + Math.sqrt(75), -5]);
  nearP(p.pts[1].p, [10, 0]);
  assert.ok(Math.abs(p.pts[1].bulge) > 1); // el arco ahora barre más de 180°
});

test('extender: círculos y polilíneas cerradas no tienen extremos', () => {
  const d = mk([{ type: 'circle', c: [0, 0], r: 5 }, { type: 'rect', p1: [10, 0], p2: [20, 10] }, L([50, -5], [50, 5])]);
  assert.throws(() => extendEntity(d, 'e1', [5, 0], ['e3']), /círculo/);
  assert.throws(() => extendEntity(d, 'e2', [10, 0], ['e3']), /cerrada/);
});

// ---------------------------------------------------------------- ids, atomicidad y utilidades

test('los ops son compatibles con applyOps y no mutan el dibujo original', () => {
  const d = mk([L([0, 0], [100, 0]), L([30, -10], [30, 10]), L([70, -10], [70, 10])]);
  const snap = JSON.stringify(d);
  const ops = trimEntity(d, 'e1', [50, 0], ['e2', 'e3']);
  assert.equal(JSON.stringify(d), snap);
  assert.doesNotThrow(() => applyOps(d, ops));
});

test('el color propio y la capa se copian al trozo nuevo', () => {
  const d = mk([{ ...L([0, 0], [100, 0]), color: 1, layer: 'A' }, L([30, -10], [30, 10]), L([70, -10], [70, 10])], [{ name: 'A' }]);
  const r = applyOps(d, trimEntity(d, 'e1', [50, 0], ['e2', 'e3']));
  const nuevo = ent(r.drawing, r.ids[0]);
  assert.equal(nuevo.layer, 'A'); assert.equal(nuevo.color, 1);
});

test('diffOps deshace un recorte (línea partida y círculo -> arco)', () => {
  const d = mk([L([0, 0], [100, 0]), L([30, -10], [30, 10]), L([70, -10], [70, 10]), { type: 'circle', c: [0, 50], r: 10 }, L([-20, 50], [20, 50]), L([0, 30], [0, 70])]);
  const d1 = applyOps(d, trimEntity(d, 'e1', [50, 0], ['e2', 'e3'])).drawing;
  const back1 = applyOps(d1, diffOps(d, d1)).drawing;
  assert.deepEqual(back1.entities.map((e) => e.id).sort(), d.entities.map((e) => e.id).sort());
  assert.deepEqual(ent(back1, 'e1'), ent(d, 'e1'));
  const d2 = applyOps(d, trimEntity(d, 'e4', [7, 57], ['e5', 'e6'])).drawing;
  assert.equal(ent(d2, 'e4').type, 'arc');
  const back2 = applyOps(d2, diffOps(d, d2)).drawing;
  assert.deepEqual(ent(back2, 'e4'), ent(d, 'e4'));
});
