import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, createDrawing, getEntity, setLayer } from './drawing';
import type { EntityInput } from './drawing';
import { applyOps, createTool, mirrorEntity, parseInput, parseLength, polyEndTangent, tangentArcBulge, TOOL_NAMES } from './drawingTools';
import type { DrawOp, Tool } from './drawingTools';
import { bulgeArc, polyLength } from './geom2d';
import type { Drawing, Entity, Pt2 } from './types';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearP = (a: Pt2, b: Pt2, eps = 1e-6) => { near(a[0], b[0], eps); near(a[1], b[1], eps); };
const mk = (inputs: EntityInput[] = [], layers: { name: string }[] = []) => addEntities(createDrawing('t', { layers }), inputs).drawing;
const run = (t: Tool, d: Drawing): Drawing => applyOps(d, t.commit()).drawing;
const click = (t: Tool, ...ps: Pt2[]) => ps.forEach((p) => t.onPoint(p));
const ent = (d: Drawing, id: string) => getEntity(d, id) as Entity & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------- parser

test('parseLength con unidades', () => {
  assert.equal(parseLength('250'), 250); assert.equal(parseLength('2.5m'), 2500); assert.equal(parseLength('30 cm'), 300);
  assert.equal(parseLength('-4mm'), -4); assert.equal(parseLength('1e3'), 1000); assert.equal(parseLength('.5'), 0.5);
  assert.equal(parseLength('abc'), null); assert.equal(parseLength(''), null); assert.equal(parseLength('1,5'), null);
});

test('parseInput: absoluta, relativa, polar, número, ángulo y errores', () => {
  assert.deepEqual(parseInput('10,20'), { type: 'point', p: [10, 20], relative: false });
  assert.deepEqual(parseInput('#10, -20'), { type: 'point', p: [10, -20], relative: false });
  assert.deepEqual(parseInput('@5,6', [100, 100]), { type: 'point', p: [105, 106], relative: true });
  const p = parseInput('@100<90', [10, 10]);
  assert.equal(p.type, 'point'); if (p.type === 'point') nearP(p.p, [10, 110]);
  const q = parseInput('200<180');
  if (q.type === 'point') nearP(q.p, [-200, 0]); else assert.fail('esperaba punto');
  assert.deepEqual(parseInput('350'), { type: 'number', value: 350 });
  assert.deepEqual(parseInput('1m'), { type: 'number', value: 1000 });
  assert.deepEqual(parseInput('<45'), { type: 'angle', value: 45 });
  assert.equal(parseInput('@5,6').type, 'error'); // sin punto anterior
  assert.equal(parseInput('@50', [0, 0]).type, 'error');
  assert.equal(parseInput('').type, 'error');
  assert.equal(parseInput('1,2,3').type, 'error');
  assert.equal(parseInput('hola').type, 'error');
  assert.equal(parseInput('10<').type, 'error');
  const e = parseInput('@x,1', [0, 0]); assert.ok(e.type === 'error' && /Coordenadas/.test(e.message));
});

// ---------------------------------------------------------------- línea

test('línea: cadena, prompts, cerrar, deshacer y commit atómico', () => {
  const d = mk();
  const t = createTool('line', d);
  assert.equal(t.preview().prompt, 'Primer punto:');
  click(t, [0, 0]);
  assert.equal(t.preview().prompt, 'Siguiente punto o [deshacer]:');
  t.onMove([50, 5]);
  assert.equal(t.preview().ghosts.length, 1); // goma elástica
  click(t, [100, 0], [100, 100]);
  assert.equal(t.preview().prompt, 'Siguiente punto o [Cerrar/deshacer]:');
  assert.deepEqual(t.commit(), []); // aún no termina
  t.onKey('u'); // quita (100,100)
  click(t, [100, 50]);
  t.onKey('c');
  assert.ok(t.done);
  const ops = t.commit();
  assert.equal(ops.length, 3);
  assert.deepEqual(t.commit(), []); // una sola vez
  const r = applyOps(d, ops);
  assert.equal(r.drawing.entities.length, 3); assert.deepEqual(r.ids, ['e1', 'e2', 'e3']);
  const last = ent(r.drawing, 'e3'); assert.deepEqual(last.b, [0, 0]);
});

test('línea: Esc conserva lo dibujado; cancel() descarta; un solo punto no crea nada', () => {
  const d = mk();
  const a = createTool('line', d); click(a, [0, 0], [10, 0]); a.onKey('Escape');
  assert.equal(run(a, d).entities.length, 1);
  const b = createTool('line', d); click(b, [0, 0], [10, 0]); b.cancel();
  assert.ok(b.done && b.cancelled); assert.deepEqual(b.commit(), []);
  const c = createTool('line', d); click(c, [0, 0]); c.onKey('Enter');
  assert.deepEqual(c.commit(), []); assert.ok(c.cancelled);
  // después de cancelar ignora eventos
  b.onPoint([5, 5]); assert.deepEqual(b.commit(), []);
});

test('línea: entrada relativa, polar y distancia con la dirección del cursor', () => {
  const d = mk();
  const t = createTool('line', d, { layer: '0', color: 3 });
  t.onText('100,100');
  t.onText('@50,0');
  t.onText('@100<90');
  t.onMove([150, 100]); // cursor hacia +x desde (150,100+...)
  t.onText('<0');
  t.onText('25'); // 25 mm a 0°
  t.onKey('Enter');
  const r = run(t, d);
  assert.equal(r.entities.length, 3);
  nearP(ent(r, 'e1').b, [150, 100]); nearP(ent(r, 'e2').b, [150, 200]); nearP(ent(r, 'e3').b, [175, 200]);
  assert.equal(ent(r, 'e1').color, 3);
  // errores no tiran: quedan en preview().error
  const u = createTool('line', d);
  u.onText('@5,5'); assert.match(u.preview().error ?? '', /punto anterior/);
  u.onText('20'); assert.ok(u.error);
  u.onText('zzz'); assert.ok(u.error);
  click(u, [1, 1]); assert.equal(u.error, null);
});

test('línea: punto repetido y cerrar con pocos puntos son errores recuperables', () => {
  const t = createTool('line', mk());
  click(t, [0, 0], [0, 0]); assert.match(t.error ?? '', /coincide/);
  t.onKey('c'); assert.match(t.error ?? '', /3 puntos/);
  assert.equal(t.done, false);
});

// ---------------------------------------------------------------- polilínea

test('polilínea: modo arco tangente con bulge y cierre', () => {
  const d = mk();
  const t = createTool('polyline', d);
  click(t, [0, 0], [100, 0]); // recto
  t.onKey('a');
  assert.match(t.preview().prompt, /arco/);
  // arco tangente (sale hacia +x) que llega a (200,100): semicírculo-cuarto: centro (100,100), barrido 90°
  click(t, [200, 100]);
  t.onKey('l');
  click(t, [200, 300]);
  t.onKey('Enter');
  const r = run(t, d);
  const poly = ent(r, 'e1');
  assert.equal(poly.pts.length, 4);
  assert.equal(poly.pts[0].bulge, undefined);
  near(poly.pts[1].bulge, Math.tan(Math.PI / 8), 1e-9); // cuarto de círculo
  const arc = bulgeArc(poly.pts[1].p, poly.pts[2].p, poly.pts[1].bulge)!;
  nearP(arc.c, [100, 100], 1e-6); near(arc.r, 100, 1e-6);
  // tangencia: el tramo recto anterior llega con dirección 0°
  near(polyEndTangent([{ p: [0, 0] }, { p: [100, 0] }]), 0);
  near(polyEndTangent(poly.pts.slice(0, 3)), 90, 1e-6); // tras el cuarto de círculo apunta a +y
  assert.ok(polyLength(poly as never) > 100 + 150 + 200 - 1);
});

test('polilínea: arco hacia atrás es error; cerrar con arco; deshacer quita bulge', () => {
  assert.equal(tangentArcBulge([0, 0], [-100, 0], 0), null);
  assert.equal(tangentArcBulge([0, 0], [100, 0], 0), 0);
  const d = mk();
  const t = createTool('polyline', d);
  click(t, [0, 0], [100, 0]);
  t.onKey('a');
  click(t, [-50, 0]); assert.match(t.error ?? '', /atrás/);
  click(t, [200, 100]);
  t.onKey('u'); // quita (200,100)
  t.onKey('l'); click(t, [100, 100]);
  t.onKey('c');
  const r = run(t, d);
  const poly = ent(r, 'e1');
  assert.ok(poly.closed); assert.equal(poly.pts.length, 3);
  assert.equal(poly.pts[1].bulge, undefined); // el bulge del vértice quitado no sobrevive
  // cerrar con pocos vértices
  const u = createTool('polyline', d); click(u, [0, 0], [1, 0]); u.onKey('c'); assert.ok(u.error); assert.ok(!u.done);
  // 'a' sin punto inicial
  const v = createTool('polyline', d); v.onKey('a'); assert.ok(v.error);
});

test('polilínea: bulge negativo (arco horario) cuando el punto queda a la derecha de la tangente', () => {
  const b = tangentArcBulge([0, 0], [100, -100], 0)!;
  assert.ok(b < 0); near(b, -Math.tan(Math.PI / 8), 1e-9);
  const t = createTool('polyline', mk());
  click(t, [0, 0]);
  t.onKey('a'); click(t, [100, -100]);
  t.onMove([200, -100]);
  assert.equal(t.preview().ghosts.length, 1);
});

// ---------------------------------------------------------------- rectángulo

test('rectángulo: dos esquinas, relativa @w,h y esquinas degeneradas', () => {
  const d = mk();
  const t = createTool('rect', d);
  click(t, [0, 0]);
  assert.equal(t.preview().prompt, 'Otra esquina o [Dimensiones]:');
  click(t, [100, 0]); assert.match(t.error ?? '', /ancho o alto 0/); assert.ok(!t.done);
  t.onText('@400,300');
  const r = run(t, d);
  const p = ent(r, 'e1'); assert.ok(p.closed); assert.equal(p.pts.length, 4);
  nearP(p.pts[2].p, [400, 300]);
});

test('rectángulo: opción Dimensiones con el cursor eligiendo el cuadrante', () => {
  const d = mk();
  const t = createTool('rect', d);
  click(t, [1000, 1000]); t.onKey('d');
  assert.equal(t.preview().prompt, 'Ancho (o ancho,alto):');
  t.onMove([900, 900]);
  t.onText('400');
  assert.equal(t.preview().prompt, 'Alto:');
  t.onText('300');
  const p = ent(run(t, d), 'e1');
  assert.deepEqual([p.pts[0].p, p.pts[2].p], [[600, 700], [1000, 1000]]);
  // forma "w,h" y signo negativo fuerza el lado
  const u = createTool('rect', d); click(u, [0, 0]); u.onKey('d'); u.onText('200,-100');
  const q = ent(run(u, d), 'e1'); assert.deepEqual([q.pts[0].p, q.pts[2].p], [[0, -100], [200, 0]]);
  // medidas 0 y número fuera de la opción
  const v = createTool('rect', d); click(v, [0, 0]); v.onText('50'); assert.match(v.error ?? '', /Dimensiones/);
  v.onKey('d'); v.onText('0'); assert.ok(v.error);
  v.onText('abc'); assert.ok(v.error);
  // deshacer: sale de Dimensiones, luego de la primera esquina
  v.onKey('Backspace'); v.onKey('Backspace'); assert.equal(v.preview().prompt, 'Primera esquina del rectángulo:');
});

// ---------------------------------------------------------------- círculo

test('círculo: centro-radio, centro-diámetro con número y con punto', () => {
  const d = mk();
  const a = createTool('circle', d); click(a, [10, 10]); a.onText('50');
  near(ent(run(a, d), 'e1').r, 50);
  const b = createTool('circle', d, { mode: 'cd' }); click(b, [0, 0]); b.onText('50');
  near(ent(run(b, d), 'e1').r, 25);
  const c = createTool('circle', d, { mode: 'cd' }); click(c, [0, 0], [0, 80]);
  near(ent(run(c, d), 'e1').r, 40);
  const e = createTool('circle', d); click(e, [0, 0]); e.onKey('d'); assert.match(e.preview().prompt, /Diámetro/); e.onText('2m');
  near(ent(run(e, d), 'e1').r, 1000);
  const f = createTool('circle', d); click(f, [0, 0]); f.onText('-5'); assert.ok(f.error); f.onText('0'); assert.ok(f.error);
  click(f, [0, 0]); assert.ok(f.error && !f.done);
});

test('círculo: 2 puntos y 3 puntos (alineados es error)', () => {
  const d = mk();
  const a = createTool('circle', d); a.onKey('2'); assert.equal(a.preview().prompt, 'Primer extremo del diámetro:');
  click(a, [0, 0], [100, 0]);
  const c = ent(run(a, d), 'e1'); nearP(c.c, [50, 0]); near(c.r, 50);
  const b = createTool('circle', d); b.onKey('3'); click(b, [0, 0], [100, 0], [200, 0]);
  assert.match(b.error ?? '', /alineados/); assert.ok(!b.done);
  b.onMove([100, 100]); assert.equal(b.preview().ghosts[0].type, 'circle');
  click(b, [100, 100]);
  const k = ent(run(b, d), 'e1'); nearP(k.c, [50, 50], 1e-6); near(k.r, Math.hypot(50, 50), 1e-6);
  // la opción 2/3 no vale a mitad
  const m = createTool('circle', d); click(m, [0, 0]); m.onKey('3'); assert.ok(m.error);
});

// ---------------------------------------------------------------- arco

test('arco: 3 puntos (alineados es error) y centro-inicio-fin', () => {
  const d = mk();
  const a = createTool('arc', d); click(a, [100, 0], [0, 100], [-100, 0]);
  const r = ent(run(a, d), 'e1'); nearP(r.c, [0, 0]); near(r.r, 100); near(r.a0, 0); near(r.a1, 180);
  const b = createTool('arc', d); click(b, [0, 0], [50, 0], [100, 0]); assert.match(b.error ?? '', /alineados/); assert.ok(!b.done);
  const c = createTool('arc', d); c.onKey('c');
  assert.equal(c.preview().prompt, 'Centro del arco [3 puntos]:');
  click(c, [0, 0], [100, 0]); c.onMove([0, 100]); assert.equal(c.preview().ghosts.length, 2);
  click(c, [0, 300]); // el fin define solo el ángulo (90°)
  const k = ent(run(c, d), 'e1'); nearP(k.c, [0, 0]); near(k.r, 100); near(k.a0, 0); near(k.a1, 90);
  // fin en el mismo ángulo: error; ángulo incluido escrito (negativo = horario)
  const e = createTool('arc', d, { mode: 'cse' }); click(e, [0, 0], [100, 0], [500, 0]); assert.ok(e.error && !e.done);
  e.onText('-90');
  const h = ent(run(e, d), 'e1'); near(h.a0, 270); near(h.a1, 0);
  const g = createTool('arc', d, { mode: 'cse' }); click(g, [0, 0], [100, 0]); g.onText('360'); assert.ok(g.error);
});

// ---------------------------------------------------------------- texto

test('texto: punto y contenido; el contenido no se interpreta como coordenadas', () => {
  const d = mk();
  const t = createTool('text', d, { textHeight: 80, layer: '0' });
  assert.equal(t.preview().prompt, 'Punto de inserción del texto:');
  t.onText('10,20'); // sí es un punto
  assert.equal(t.preview().prompt, 'Texto:');
  t.onText('   '); assert.ok(t.error);
  t.onText('1,2');
  const e = ent(run(t, d), 'e1'); assert.equal(e.s, '1,2'); assert.deepEqual(e.p, [10, 20]); assert.equal(e.h, 80);
  const u = createTool('text', d); click(u, [0, 0]); u.onKey('c'); u.onKey('Enter');
  assert.ok(u.cancelled); // Enter sin contenido cancela
  const v = createTool('text', d); v.onText('12'); assert.ok(v.error);
});

// ---------------------------------------------------------------- cota

test('cota lineal: orientación automática según dónde se ponga la línea, H/V y distancia', () => {
  const d = mk();
  const t = createTool('dim', d, { layer: '0' });
  click(t, [0, 0], [1000, 0]);
  assert.match(t.preview().prompt, /\[Horizontal\/Vertical\]/);
  click(t, [500, -200]);
  const e = ent(run(t, d), 'e1'); assert.equal(e.kind, 'linear'); assert.equal(e.rot ?? 0, 0); assert.deepEqual(e.at, [500, -200]);
  const v = createTool('dim', d); click(v, [0, 0], [0, 1000], [300, 500]);
  assert.equal(ent(run(v, d), 'e1').rot, 90);
  const f = createTool('dim', d); click(f, [0, 0], [1000, 500]); f.onKey('v'); click(f, [500, 800]);
  assert.equal(ent(run(f, d), 'e1').rot, 90);
  const n = createTool('dim', d); click(n, [0, 0], [1000, 0]); n.onText('150');
  assert.deepEqual(ent(run(n, d), 'e1').at, [500, 150]);
  const bad = createTool('dim', d); click(bad, [5, 5], [5, 5]); assert.ok(bad.error);
});

test('cota alineada: la distancia va por la normal izquierda', () => {
  const d = mk();
  const t = createTool('dim', d, { kind: 'aligned' }); click(t, [0, 0], [1000, 0]); t.onText('100');
  const e = ent(run(t, d), 'e1'); assert.equal(e.kind, 'aligned'); nearP(e.at, [500, 100]);
  assert.equal(e.rot, undefined);
});

// ---------------------------------------------------------------- edición

const base = () => mk([{ type: 'line', a: [0, 0], b: [100, 0] }, { type: 'circle', c: [200, 0], r: 20 }]);

test('mover: selección previa, ghost, desplazamiento relativo y capa bloqueada', () => {
  const d = base();
  const t = createTool('move', d, { selection: ['e1', 'e2'] });
  assert.equal(t.preview().prompt, 'Punto base o [Desplazamiento]:');
  click(t, [0, 0]); t.onMove([10, 5]);
  assert.equal(t.preview().ghosts.length, 2); nearP((t.preview().ghosts[0] as any).a, [10, 5]); // eslint-disable-line @typescript-eslint/no-explicit-any
  t.onText('@30,40');
  const r = run(t, d);
  nearP(ent(r, 'e1').a, [30, 40]); nearP(ent(r, 'e2').c, [230, 40]); assert.equal(ent(r, 'e1').id, 'e1');
  // sin selección previa: onSelect + Enter
  const u = createTool('move', d);
  assert.equal(u.preview().prompt, 'Designe objetos:');
  click(u, [0, 0]); assert.ok(u.error);
  u.onSelect(['e2']); u.onKey('Enter'); click(u, [0, 0], [0, 7]);
  nearP(ent(run(u, d), 'e2').c, [200, 7]);
  // desplazamiento 0 y opción D
  const v = createTool('move', d, { selection: ['e1'] }); click(v, [5, 5], [5, 5]); assert.match(v.error ?? '', /es 0/);
  const w = createTool('move', d, { selection: ['e1'] }); w.onKey('d'); w.onText('10,0'); nearP(ent(run(w, d), 'e1').a, [10, 0]);
  // capas bloqueadas / congeladas no entran a la selección
  const l = setLayer(addEntities(setLayer(createDrawing('c', { layers: [{ name: 'X' }] }), 'X', {}), [{ type: 'line', a: [0, 0], b: [1, 1], layer: 'X' }]).drawing, 'X', { locked: true });
  const m = createTool('move', l, { selection: ['e1'] });
  assert.equal(m.preview().prompt, 'Designe objetos:'); // la selección previa se descartó
  m.onSelect(['e1']); assert.match(m.error ?? '', /bloqueadas/);
  assert.deepEqual(m.selection, []);
  m.onKey('Enter'); assert.ok(m.cancelled); // Enter sin selección cancela
});

test('mover: cancelar a mitad no produce operaciones', () => {
  const t = createTool('move', base(), { selection: ['e1'] });
  click(t, [0, 0]); t.onMove([50, 50]); t.cancel();
  assert.deepEqual(t.commit(), []); assert.equal(t.preview().prompt, '');
});

test('copiar: múltiples copias, deshacer la última, once', () => {
  const d = base();
  const t = createTool('copy', d, { selection: ['e1'] });
  click(t, [0, 0], [0, 100], [0, 200], [0, 300]);
  t.onKey('u');
  assert.equal(t.preview().ghosts.length, 3); // 2 copias + la que sigue al cursor
  t.onKey('Enter');
  const r = run(t, d);
  assert.equal(r.entities.length, 2 + 2);
  nearP(ent(r, 'e3').a, [0, 100]); nearP(ent(r, 'e4').a, [0, 200]);
  const o = createTool('copy', d, { selection: ['e2'], once: true }); click(o, [0, 0], [10, 0]); assert.ok(o.done);
  assert.equal(run(o, d).entities.length, 3);
  const n = createTool('copy', d, { selection: ['e2'] }); click(n, [0, 0]); n.onKey('Escape'); assert.ok(n.cancelled);
});

test('girar: punto, número, referencia y copia', () => {
  const d = mk([{ type: 'line', a: [100, 0], b: [200, 0] }, { type: 'text', p: [100, 0], h: 10, s: 'x' }]);
  const a = createTool('rotate', d, { selection: ['e1'] });
  click(a, [0, 0]); a.onText('90');
  const r = run(a, d); nearP(ent(r, 'e1').a, [0, 100]); nearP(ent(r, 'e1').b, [0, 200]);
  const b = createTool('rotate', d, { selection: ['e1'] }); click(b, [0, 0], [0, 50]); // punto a 90°
  nearP(ent(run(b, d), 'e1').b, [0, 200], 1e-6);
  const c = createTool('rotate', d, { selection: ['e1'] }); click(c, [0, 0]); c.onKey('r'); c.onText('30'); assert.equal(c.preview().prompt.startsWith('Ángulo de giro'), true); c.onText('75');
  nearP(ent(run(c, d), 'e1').b, [200 * Math.cos(Math.PI / 4), 200 * Math.sin(Math.PI / 4)], 1e-6);
  const e = createTool('rotate', d, { selection: ['e1', 'e2'], copy: true }); click(e, [0, 0]); e.onText('<90');
  const k = run(e, d); assert.equal(k.entities.length, 4); near(ent(k, 'e4').rot, 90); nearP(ent(k, 'e1').a, [100, 0]);
  const z = createTool('rotate', d, { selection: ['e1'] }); click(z, [0, 0]); z.onText('0'); assert.ok(z.error);
  const y = createTool('rotate', d, { selection: ['e1'] }); y.onText('45'); assert.ok(y.error); // sin base
});

test('escalar: factor, referencia con puntos, errores', () => {
  const d = mk([{ type: 'circle', c: [100, 0], r: 10 }, { type: 'line', a: [0, 0], b: [100, 0] }]);
  const a = createTool('scale', d, { selection: ['e1'] }); click(a, [0, 0]); a.onText('2');
  const r = run(a, d); nearP(ent(r, 'e1').c, [200, 0]); near(ent(r, 'e1').r, 20);
  const b = createTool('scale', d, { selection: ['e1'] }); click(b, [0, 0]); click(b, [5, 5]); assert.ok(b.error); b.onKey('r'); click(b, [100, 0]); b.onText('300');
  near(ent(run(b, d), 'e1').r, 30);
  const c = createTool('scale', d, { selection: ['e1'] }); click(c, [0, 0]); c.onText('-2'); assert.ok(c.error); c.onText('0'); assert.ok(c.error); c.onText('1'); assert.match(c.error ?? '', /1 no cambia/);
  const e = createTool('scale', d, { selection: ['e1'], copy: true }); click(e, [0, 0]); e.onText('3'); assert.equal(run(e, d).entities.length, 3);
});

test('simetría: líneas, polilíneas con bulge, arcos, texto; borrar origen', () => {
  const d = mk([
    { type: 'poly', pts: [{ p: [10, 0], bulge: 0.5 }, { p: [10, 100] }] },
    { type: 'arc', c: [50, 0], r: 20, a0: 0, a1: 90 },
    { type: 'text', p: [30, 5], h: 10, s: 'T', rot: 15 },
    { type: 'line', a: [0, -10], b: [0, 10] },
  ]);
  const t = createTool('mirror', d, { selection: ['e1', 'e2', 'e3'] });
  click(t, [0, 0]); t.onMove([0, 100]); assert.ok(t.preview().ghosts.length >= 4);
  click(t, [0, 100]);
  assert.match(t.preview().prompt, /Borrar los objetos de origen/);
  t.onKey('Enter');
  const r = run(t, d);
  assert.equal(r.entities.length, 4 + 3);
  const p = ent(r, 'e5'); nearP(p.pts[0].p, [-10, 0]); assert.equal(p.pts[0].bulge, -0.5);
  const a = ent(r, 'e6'); nearP(a.c, [-50, 0]); near(a.a0, 90); near(a.a1, 180); // 0..90 reflejado en x → 90..180
  const x = ent(r, 'e7'); nearP(x.p, [-30, 5]); assert.equal(x.s, 'T'); assert.equal(x.rot, 15);
  const u = createTool('mirror', d, { selection: ['e4'] }); click(u, [-5, 0], [5, 0]); u.onKey('s');
  const k = run(u, d); assert.equal(k.entities.length, 4); assert.equal(getEntity(k, 'e4'), undefined);
  nearP(ent(k, 'e5').a, [0, 10]);
  const same = createTool('mirror', d, { selection: ['e4'] }); click(same, [1, 1], [1, 1]); assert.ok(same.error);
});

test('mirrorEntity: eje diagonal sobre arco y cota lineal', () => {
  const m = mirrorEntity({ id: 'a', layer: '0', type: 'arc', c: [10, 0], r: 5, a0: 0, a1: 90 }, [0, 0], [1, 1]) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  nearP(m.c, [0, 10]); near(m.a0, 0); near(m.a1, 90); // 2·45−90=0 ; 2·45−0=90
  const d = mirrorEntity({ id: 'd', layer: '0', type: 'dim', kind: 'linear', p1: [0, 0], p2: [10, 0], at: [5, 3] }, [0, 0], [1, 1]) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  near(d.rot, 90); nearP(d.at, [3, 5]);
  assert.throws(() => mirrorEntity({ id: 'a', layer: '0', type: 'circle', c: [0, 0], r: 1 }, [1, 1], [1, 1]), /dos puntos distintos/);
});

test('desfasar: distancia → objeto → lado; repite; círculo y errores', () => {
  const d = mk([{ type: 'line', a: [0, 0], b: [100, 0] }, { type: 'circle', c: [300, 0], r: 50 }, { type: 'text', p: [0, 300], h: 10, s: 'a' }, { type: 'poly', pts: [{ p: [0, 500], bulge: 1 }, { p: [100, 500] }] }]);
  const t = createTool('offset', d);
  assert.equal(t.preview().prompt, 'Distancia de desfase:');
  t.onText('-5'); assert.ok(t.error); t.onText('abc'); assert.ok(t.error);
  t.onText('20');
  t.onSelect(['e1']); t.onMove([50, 30]);
  assert.equal(t.preview().ghosts.length, 1);
  click(t, [50, 30]); // arriba → izquierda de la línea: +20
  click(t, [300, 0]); assert.ok(t.error);
  t.onSelect(['e2']); click(t, [300, 100]); // fuera del círculo → radio 70
  t.onSelect(['e3']); assert.match(t.error ?? '', /no se aplica a text/);
  t.onSelect(['e4']); click(t, [50, 400]); assert.match(t.error ?? '', /bulge|arcos/);
  t.onKey('Enter');
  const r = run(t, d);
  assert.equal(r.entities.length, 4 + 2);
  nearP(ent(r, 'e5').a, [0, 20]); near(ent(r, 'e6').r, 70);
  // lado hacia dentro del círculo: radio menor; y una distancia que lo anula es error
  const u = createTool('offset', d, { distance: 60 }); u.onSelect(['e2']); click(u, [300, 0]); assert.match(u.error ?? '', /radio/);
  // por clic con pickTolerance
  const v = createTool('offset', d, { distance: 10, pickTolerance: 2 });
  click(v, [50, 1]); assert.equal(v.preview().prompt, 'Punto del lado donde desfasar:');
  click(v, [50, -30]); v.onKey('Escape');
  nearP(ent(run(v, d), 'e5').a, [0, -10]);
  const w = createTool('offset', d, { distance: 10 }); click(w, [999, 999]); assert.match(w.error ?? '', /ningún objeto/);
  w.onKey('Escape'); assert.ok(w.cancelled);
});

test('borrar: con selección previa es inmediato; si no, onSelect + Enter', () => {
  const d = base();
  const a = createTool('erase', d, { selection: ['e1', 'e9'] });
  assert.ok(a.done);
  const r = run(a, d); assert.equal(r.entities.length, 1);
  const b = createTool('erase', d);
  assert.ok(!b.done);
  b.onSelect(['e1']); b.onSelect(['e2', 'e1'], 'toggle'); b.onKey('Enter'); // e1 alterna fuera, queda e2
  assert.deepEqual(run(b, d).entities.map((e) => e.id), ['e1']);
  const c = createTool('erase', d); c.onKey('Enter'); assert.ok(c.cancelled);
  const l = setLayer(addEntities(createDrawing('c', { layers: [{ name: 'X' }] }), [{ type: 'line', a: [0, 0], b: [1, 1], layer: 'X' }]).drawing, 'X', { frozen: true });
  const e = createTool('erase', l, { selection: ['e1'] });
  assert.ok(!e.done);
});

test('applyOps es atómico: si una operación falla no queda nada a medias', () => {
  const d = base();
  const ops: DrawOp[] = [{ op: 'add', entity: { type: 'line', a: [0, 0], b: [5, 5] } }, { op: 'update', id: 'nope', patch: { a: [1, 1] } }];
  assert.throws(() => applyOps(d, ops), /no existe/);
  assert.equal(d.entities.length, 2);
  assert.throws(() => applyOps(d, [{ op: 'remove', ids: ['e1'] }, { op: 'remove', ids: ['e1'] }]), /no existe/);
});

test('todas las herramientas: fábrica, preview inicial y cancel', () => {
  const d = base();
  for (const n of TOOL_NAMES) {
    const t = createTool(n, d);
    assert.equal(t.name, n === 'polyline' ? 'polyline' : n);
    const p = t.preview(); assert.ok(p.prompt.length > 0, n); assert.deepEqual(p.ghosts, []);
    t.onMove([1, 1]); t.cancel();
    assert.deepEqual(t.commit(), []); assert.equal(t.preview().prompt, '');
  }
});

test('las operaciones son compatibles con drawing.ts y respetan la capa de la herramienta', () => {
  const d = mk([], [{ name: 'Muros' }]);
  const t = createTool('rect', d, { layer: 'Muros', color: '#ff0000' }); click(t, [0, 0], [10, 10]);
  const op = t.commit()[0];
  assert.equal(op.op, 'add');
  const r = applyOps(d, [op]).drawing; assert.equal(ent(r, 'e1').layer, 'Muros'); assert.equal(ent(r, 'e1').color, '#ff0000');
  // capa inexistente: applyOps lanza un error accionable
  const bad = createTool('line', d, { layer: 'Nada' }); click(bad, [0, 0], [1, 1]); bad.onKey('Enter');
  assert.throws(() => applyOps(d, bad.commit()), /capa "Nada"/);
});
