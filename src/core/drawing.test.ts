import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aciToHex } from './aci';
import {
  DrawingError, addEntities, addEntity, addLayer, copyEntities, createDrawing, findDrawing, getEntity, moveEntities, nextDrawingId, normalizeDrawing, offsetEntity, removeEntity,
  removeLayer, rotateEntities, scaleEntities, setLayer, updateEntity, validateDrawing, validateDrawings, withDrawing, withoutDrawing,
} from './drawing';
import { DrawingHistory } from './drawingHistory';
import { drawingToWorld, worldToDrawing } from './drawingPlane';
import { extrudeProfile, partToOutline } from './extrude';
import { addCabinet } from './furniture';
import { entityBounds, polyArea } from './geom2d';
import { partBounds, validatePart } from './solids';
import { defaultProject, type Drawing, type Entity, type Part, type PolyEntity, type Project, type Vec3 } from './types';
import { createStore } from '../../server/store';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const throwsMsg = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof DrawingError && re.test(e.message), `esperaba un DrawingError que coincida con ${re}`);

test('dibujo nuevo: capa 0, plano y origen; ids estables', () => {
  let d = createDrawing('Planta', { plane: 'xz', origin: [100, 0, 50] });
  assert.equal(d.layers.length, 1); assert.equal(d.layers[0].name, '0');
  const r = addEntities(d, [{ type: 'line', a: [0, 0], b: [10, 0] }, { type: 'circle', c: [5, 5], r: 2 }]);
  assert.deepEqual(r.ids, ['e1', 'e2']);
  d = removeEntity(r.drawing, 'e1');
  const r2 = addEntity(d, { type: 'line', a: [0, 0], b: [0, 10] });
  assert.equal(r2.id, 'e3', 'no reutiliza ids existentes ni baja del máximo restante');
  assert.equal(validateDrawing(r2.drawing), null);
});

test('formas de entrada: círculo (c-r, c-d, 3 puntos), arco (3 puntos, c-r-ángulos), rect (2 esquinas, origen+w+h)', () => {
  const r = addEntities(createDrawing('x'), [
    { type: 'circle', c: [0, 0], r: 5 }, { type: 'circle', c: [0, 0], d: 10 }, { type: 'circle', pts: [[5, 0], [0, 5], [-5, 0]] },
    { type: 'arc', pts: [[1, 0], [0, 1], [-1, 0]] }, { type: 'arc', c: [0, 0], r: 1, a0: 0, a1: 180 },
    { type: 'rect', p1: [10, 10], p2: [0, 0] }, { type: 'rect', origin: [0, 0], w: 4, h: 3 },
  ]);
  const d = r.drawing;
  const [c1, c2, c3, a1, a2, r1, r2] = r.ids.map((id) => getEntity(d, id)!);
  for (const c of [c1, c2, c3]) { assert.equal(c.type, 'circle'); near((c as { r: number }).r, 5); }
  near((c3 as { c: [number, number] }).c[0], 0);
  assert.deepEqual([a1, a2].map((a) => [(a as { a0: number }).a0, (a as { a1: number }).a1]), [[0, 180], [0, 180]]);
  assert.equal(r1.type, 'poly'); assert.ok((r1 as PolyEntity).closed);
  near(polyArea(r1 as PolyEntity), 100); near(polyArea(r2 as PolyEntity), 12);
});

test('validación con mensajes accionables en español', () => {
  const d = createDrawing('x');
  throwsMsg(() => addEntity(d, { type: 'circle', c: [0, 0], r: -1 }), /r un número mayor que 0/);
  throwsMsg(() => addEntity(d, { type: 'line', a: [0, 0], b: [0, 0] }), /mismo punto/);
  throwsMsg(() => addEntity(d, { type: 'line', a: [0, 0], b: [1, 1], layer: 'Muros' }), /capa "Muros" no existe.*Capas: 0/);
  throwsMsg(() => addEntity(d, { type: 'rect', p1: [0, 0], p2: [5, 0] }), /ancho o alto 0/);
  throwsMsg(() => addEntity(d, { type: 'circle', pts: [[0, 0], [1, 1], [2, 2]] }), /alineados/);
  throwsMsg(() => addEntity(d, { type: 'poly', pts: [[0, 0]] }), /al menos 2 puntos/);
  throwsMsg(() => addEntity(d, { type: 'text', p: [0, 0], h: 0, s: 'a' }), /alto de letra/);
  throwsMsg(() => addEntity(d, { type: 'line', a: [0, 0], b: [1, 1], color: 999 }), /ACI/);
  throwsMsg(() => addEntity(d, { type: 'blob' } as never), /no existe/);
  throwsMsg(() => addEntity(d, { type: 'dim', kind: 'linear', p1: [0, 0], p2: [0, 0], at: [0, 5] }), /mismo punto/);
  // todo o nada
  assert.throws(() => addEntities(d, [{ type: 'line', a: [0, 0], b: [1, 1] }, { type: 'circle', c: [0, 0], r: 0 }]));
  assert.equal(d.entities.length, 0);
});

test('capas: nueva, cambiar, renombrar actualiza entidades, borrar; la 0 es intocable; bloqueo y congelado', () => {
  let d = createDrawing('x');
  d = addLayer(d, { name: 'Muros', color: 1, linetype: 'dashed' });
  throwsMsg(() => addLayer(d, { name: 'muros' }), /ya existe/);
  d = addEntity(d, { type: 'line', a: [0, 0], b: [5, 0], layer: 'muros' }).drawing;
  assert.equal(d.entities[0].layer, 'Muros', 'usa el nombre canónico');
  d = setLayer(d, 'Muros', { name: 'Paredes', color: '#00ff00' });
  assert.equal(d.entities[0].layer, 'Paredes');
  throwsMsg(() => removeLayer(d, 'Paredes'), /tiene 1 entidad/);
  throwsMsg(() => removeLayer(d, '0'), /no se puede borrar/);
  throwsMsg(() => setLayer(d, '0', { name: 'otra' }), /no se puede renombrar/);
  d = setLayer(d, 'Paredes', { locked: true });
  throwsMsg(() => moveEntities(d, 'e1', [1, 1]), /bloqueada/);
  throwsMsg(() => addEntity(d, { type: 'line', a: [0, 0], b: [1, 1], layer: 'Paredes' }), /bloqueada/);
  d = setLayer(d, 'Paredes', { locked: false, frozen: true });
  throwsMsg(() => removeEntity(d, 'e1'), /congelada/);
  d = setLayer(d, 'Paredes', { frozen: false });
  d = removeLayer(updateEntity(d, 'e1', { layer: '0' }), 'Paredes');
  assert.deepEqual(d.layers.map((l) => l.name), ['0']);
});

test('updateEntity, color por capa, mover/copiar/girar/escalar', () => {
  let d = createDrawing('x');
  d = addEntities(d, [{ type: 'line', a: [0, 0], b: [10, 0], color: 3 }, { type: 'circle', c: [5, 5], r: 2 }, { type: 'text', p: [0, 0], h: 10, s: 'Hola' }]).drawing;
  d = updateEntity(d, 'e1', { b: [20, 0] });
  assert.deepEqual((getEntity(d, 'e1') as { b: number[] }).b, [20, 0]);
  d = updateEntity(d, 'e1', { color: null });
  assert.equal(getEntity(d, 'e1')!.color, undefined);
  throwsMsg(() => updateEntity(d, 'e1', { type: 'circle' }), /id ni el type/);
  throwsMsg(() => updateEntity(d, 'e2', { r: 0 }), /mayor que 0/);
  throwsMsg(() => updateEntity(d, 'zzz', {}), /no existe la entidad "zzz"/);
  const before = d;
  d = moveEntities(d, ['e1', 'e2'], [10, -5]);
  assert.deepEqual((getEntity(before, 'e2') as { c: number[] }).c, [5, 5], 'inmutable');
  assert.deepEqual((getEntity(d, 'e2') as { c: number[] }).c, [15, 0]);
  const cp = copyEntities(d, ['e2'], [100, 0], 2);
  assert.deepEqual(cp.ids, ['e4', 'e5']);
  assert.deepEqual((getEntity(cp.drawing, 'e5') as { c: number[] }).c, [215, 0]);
  d = rotateEntities(d, ['e1'], [0, 0], 90);
  const l = getEntity(d, 'e1') as { a: number[]; b: number[] };
  near(l.a[0], 5); near(l.a[1], 10); near(l.b[0], 5); near(l.b[1], 30);
  d = rotateEntities(d, 'e3', [0, 0], 30);
  assert.equal((getEntity(d, 'e3') as { rot: number }).rot, 30);
  d = scaleEntities(d, ['e2'], [15, 0], 2);
  near((getEntity(d, 'e2') as { r: number }).r, 4);
  throwsMsg(() => scaleEntities(d, 'e2', [0, 0], -1), /mayor que 0/);
  // el arco gira sus ángulos
  const a = addEntity(createDrawing('a'), { type: 'arc', c: [0, 0], r: 1, a0: 350, a1: 20 });
  const ar = getEntity(rotateEntities(a.drawing, a.id, [0, 0], 20), a.id) as { a0: number; a1: number };
  near(ar.a0, 10); near(ar.a1, 40);
});

test('offset: línea, círculo y polilínea cerrada (inglete)', () => {
  let d = createDrawing('x');
  d = addEntities(d, [{ type: 'line', a: [0, 0], b: [10, 0] }, { type: 'circle', c: [0, 0], r: 5 }, { type: 'rect', p1: [0, 0], p2: [10, 10] }]).drawing;
  const l = offsetEntity(d, 'e1', 3);
  assert.deepEqual((getEntity(l.drawing, l.id) as { a: number[] }).a, [0, 3]);
  const c = offsetEntity(d, 'e2', -2);
  near((getEntity(c.drawing, c.id) as { r: number }).r, 3);
  throwsMsg(() => offsetEntity(d, 'e2', -5), /radio/);
  const p = offsetEntity(d, 'e3', 2); // rect CCW: izquierda = adentro -> 6x6
  near(polyArea(getEntity(p.drawing, p.id) as PolyEntity), 36);
  const out = offsetEntity(d, 'e3', -2); // afuera -> 14x14
  near(polyArea(getEntity(out.drawing, out.id) as PolyEntity), 196);
  throwsMsg(() => offsetEntity(addEntity(d, { type: 'text', p: [0, 0], h: 5, s: 't' }).drawing, 'e4', 1), /no se aplica/);
});

test('plano del dibujo en el 3D: ida y vuelta y orientación', () => {
  const xy = { plane: 'xy' as const, origin: [10, 20, 30] as Vec3 };
  assert.deepEqual(drawingToWorld(xy, [1, 2]), [11, 22, 30]);
  const xz = { plane: 'xz' as const, origin: [0, 5, 100] as Vec3 };
  assert.deepEqual(drawingToWorld(xz, [1, 2]), [1, 5, 98], 'v positiva va hacia el muro del fondo (z menor)');
  const yz = { plane: 'yz' as const, origin: [7, 0, 0] as Vec3 };
  assert.deepEqual(drawingToWorld(yz, [1, 2]), [7, 2, -1]);
  for (const p of [xy, xz, yz]) assert.deepEqual(worldToDrawing(p, drawingToWorld(p, [3, 4])), [3, 4]);
});

test('extrudir: rect -> prisma, cóncavo en L, arcos, círculo -> cilindro, en los 3 planos', () => {
  let d = createDrawing('Perfil', { plane: 'xy', origin: [100, 200, 300] });
  d = addEntities(d, [
    { type: 'rect', origin: [0, 0], w: 40, h: 20 },
    { type: 'poly', closed: true, pts: [[0, 0], [40, 0], [40, 3], [3, 3], [3, 40], [0, 40]] },
    { type: 'poly', closed: true, pts: [{ p: [0, 0] }, { p: [10, 0], bulge: 1 }, { p: [10, 10] }] },
    { type: 'circle', c: [50, 50], r: 10 },
    { type: 'line', a: [0, 0], b: [1, 1] },
    { type: 'poly', pts: [[0, 0], [1, 0], [1, 1]] },
    { type: 'poly', closed: true, pts: [[0, 0], [10, 10], [10, 0], [0, 10]] }, // corbatín: se cruza
  ]).drawing;
  const p1 = extrudeProfile(d, getEntity(d, 'e1')!, 18, { material: 'mel18' });
  assert.equal(p1.form, 'prism'); assert.equal(p1.axis, 'z');
  assert.deepEqual(p1.size, [40, 20, 18]); assert.deepEqual(p1.position, [100, 200, 300]);
  assert.equal(validatePart({ ...p1, id: 'x' }), null);
  assert.deepEqual(extrudeProfile(d, getEntity(d, 'e1')!, -18).position, [100, 200, 282], 'profundidad negativa va hacia -normal');
  const L = extrudeProfile(d, getEntity(d, 'e2')!, 600);
  assert.equal(L.profile!.length, 6); assert.deepEqual(L.size, [40, 40, 600]);
  assert.equal(validatePart({ ...L, id: 'x' }), null, 'el perfil cóncavo es válido');
  const arcs = extrudeProfile(d, getEntity(d, 'e3')!, 5);
  assert.ok(arcs.profile!.length > 8);
  const cyl = extrudeProfile(d, getEntity(d, 'e4')!, 30);
  assert.equal(cyl.form, 'cylinder'); assert.deepEqual(cyl.size, [20, 20, 30]); assert.deepEqual(cyl.position, [140, 240, 300]);
  throwsMsg(() => extrudeProfile(d, getEntity(d, 'e5')!, 5), /Solo se extruyen/);
  throwsMsg(() => extrudeProfile(d, getEntity(d, 'e6')!, 5), /abierta/);
  throwsMsg(() => extrudeProfile(d, getEntity(d, 'e7')!, 5), /se cruza/);
  throwsMsg(() => extrudeProfile(d, getEntity(d, 'e1')!, 0), /distinto de 0/);

  // planta (xz): el sólido sube por +Y y v -> -z
  const plan = createDrawing('Planta', { plane: 'xz', origin: [0, 100, 1000] });
  const e = addEntity(plan, { type: 'rect', p1: [0, 0], p2: [300, 200] });
  const up = extrudeProfile(e.drawing, getEntity(e.drawing, e.id)!, 50);
  assert.equal(up.axis, 'y'); assert.deepEqual(up.size, [300, 50, 200]); assert.deepEqual(up.position, [0, 100, 800]);
  const b = partBounds(up);
  assert.deepEqual([b.min, b.max], [[0, 100, 800], [300, 150, 1000]]);
  // alzado lateral (yz)
  const side = createDrawing('Lateral', { plane: 'yz', origin: [10, 0, 500] });
  const f = addEntity(side, { type: 'rect', p1: [0, 0], p2: [100, 400] });
  const sx = extrudeProfile(f.drawing, getEntity(f.drawing, f.id)!, 20);
  assert.equal(sx.axis, 'x'); assert.deepEqual(sx.size, [20, 400, 100]); assert.deepEqual(sx.position, [10, 0, 400]);
});

test('partToOutline: ida y vuelta con extrudeProfile', () => {
  const part: Part = { id: 'p1', name: 'Pilar', size: [400, 400, 1800], position: [10, 20, 30], material: 'x', form: 'prism', axis: 'z', profile: [[0, 0], [400, 0], [270, 400], [0, 400]] };
  const o = partToOutline(part)!;
  assert.equal(o.plane, 'xy'); assert.deepEqual(o.origin, [0, 0, 30]);
  let d = createDrawing('o', { plane: o.plane, origin: o.origin });
  const r = addEntity(d, o.input); d = r.drawing;
  const back = extrudeProfile(d, getEntity(d, r.id)!, 1800);
  assert.deepEqual(back.size, [400, 400, 1800]); assert.deepEqual(back.position, [10, 20, 30]);
  const bb = entityBounds(getEntity(d, r.id)!)!; assert.deepEqual([bb.min, bb.max], [[10, 20], [410, 420]]);
  const box = partToOutline({ id: 'b', name: 'b', size: [100, 200, 18], position: [0, 0, 0], material: 'x' })!;
  assert.equal(box.input.type, 'rect');
  assert.equal(partToOutline({ id: 'r', name: 'r', size: [1, 1, 1], position: [0, 0, 0], material: 'x', rotZ: 10 }), null);
});

test('historial de dibujo: deshacer y rehacer', () => {
  const h = new DrawingHistory();
  let d = createDrawing('x');
  h.push(d); d = addEntity(d, { type: 'line', a: [0, 0], b: [1, 1] }).drawing;
  h.push(d); d = addEntity(d, { type: 'circle', c: [0, 0], r: 1 }).drawing;
  assert.ok(h.canUndo && !h.canRedo);
  const u1 = h.undo(d)!; assert.equal(u1.entities.length, 1);
  const u2 = h.undo(u1)!; assert.equal(u2.entities.length, 0);
  assert.equal(h.undo(u2), null);
  const r = h.redo(u2)!; assert.equal(r.entities.length, 1);
  h.push(r); assert.ok(!h.canRedo, 'un cambio nuevo borra el rehacer');
});

test('ACI: tabla mínima', () => {
  assert.equal(aciToHex(1), '#ff0000'); assert.equal(aciToHex(7), '#000000'); assert.equal(aciToHex(7, true), '#ffffff');
  assert.equal(aciToHex('#AABBCC'), '#aabbcc'); assert.match(aciToHex(100), /^#[0-9a-f]{6}$/);
});

// ---------------------------------------------------------------- persistencia

function sample(): Project {
  let d = createDrawing('Planta baja', { id: 'd1', plane: 'xz', origin: [0, 0, 0], sheet: { w: 420, h: 297, scale: 0.02 } });
  d = addLayer(d, { name: 'Cotas', color: 3, linetype: 'center' });
  d = addEntities(d, [
    { type: 'rect', p1: [0, 0], p2: [4000, 3000], color: '#ff8800' },
    { type: 'poly', pts: [{ p: [0, 0], bulge: 0.4 }, { p: [100, 0] }, { p: [100, 50] }] },
    { type: 'dim', kind: 'linear', p1: [0, 0], p2: [4000, 0], at: [0, -300], layer: 'Cotas' },
    { type: 'text', p: [10, 10], h: 50, s: 'Sala Ø', rot: 15, align: 'center' },
    { type: 'arc', pts: [[1, 0], [0, 1], [-1, 0]] },
  ]).drawing;
  const p = defaultProject();
  addCabinet(p, { name: 'Base', width: 600, height: 700, depth: 500 });
  return { ...p, drawings: [d] };
}

test('proyecto: normalizar no pierde datos; sin drawings sigue válido y sin cambios', () => {
  const p = sample();
  assert.equal(validateDrawings(p), null);
  assert.deepEqual(normalizeDrawing(p.drawings![0]), p.drawings![0]);
  assert.equal(validateDrawings(defaultProject()), null);
  assert.equal('drawings' in defaultProject(), false);
  assert.equal('drawings' in withoutDrawing(p, 'd1'), false, 'sin dibujos el JSON queda como antes');
  // capa 0 faltante se repone al leer; datos rotos dan mensajes claros
  const raw = JSON.parse(JSON.stringify(p.drawings![0])) as Drawing;
  raw.layers = raw.layers.filter((l) => l.name !== '0');
  assert.equal(normalizeDrawing(raw).layers[0].name, '0');
  const dup = JSON.parse(JSON.stringify(p.drawings![0])) as Drawing;
  dup.entities.push({ ...(dup.entities[0] as Entity) });
  assert.match(validateDrawing(dup)!, /id "e1" está repetido/);
  const lost = JSON.parse(JSON.stringify(p.drawings![0])) as Drawing;
  lost.entities[0].layer = 'Fantasma';
  assert.match(validateDrawing(lost)!, /capa "Fantasma" no existe/);
  assert.match(validateDrawings({ drawings: [p.drawings![0], p.drawings![0]] })!, /dos dibujos con el id "d1"/);
});

test('proyecto: helpers withDrawing / findDrawing / nextDrawingId', () => {
  let p = defaultProject();
  assert.equal(nextDrawingId(p), 'd1');
  p = withDrawing(p, createDrawing('A', { id: nextDrawingId(p) }));
  p = withDrawing(p, createDrawing('B', { id: nextDrawingId(p) }));
  assert.deepEqual(p.drawings!.map((d) => d.id), ['d1', 'd2']);
  assert.equal(findDrawing(p, 'b')!.id, 'd2');
  const renamed = withDrawing(p, { ...p.drawings![0], name: 'A2' });
  assert.equal(renamed.drawings!.length, 2); assert.equal(renamed.drawings![0].name, 'A2');
  assert.equal(p.drawings![0].name, 'A', 'inmutable');
});

test('almacén: los dibujos sobreviven a escribir, leer, updateProject y copias de respaldo', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-dib-'));
  try {
    const s = createStore(dir);
    const p = sample();
    s.writeProject(p);
    assert.deepEqual(s.readProject().project.drawings, p.drawings);
    // una operación que toca solo las piezas (como clear_parts) no pierde los dibujos
    s.updateProject((x) => { x.parts = []; x.cabinets = {}; });
    assert.deepEqual(s.readProject().project.drawings, p.drawings);
    // restaurar una copia trae los dibujos
    s.writeProject({ ...p, name: 'otro' });
    const back = s.listBackups().find((b) => b.name.startsWith('sesion-') || b.name.startsWith('project-'));
    assert.ok(back);
    s.restoreBackup(back!.name);
    assert.ok(Array.isArray(s.readProject().project.drawings));
    // drawings mal formado se rechaza con un mensaje claro y sin tocar nada
    fs.writeFileSync(s.projectFile, JSON.stringify({ ...p, drawings: 5 }));
    assert.throws(() => s.readProject(), /drawings debe ser una lista/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
