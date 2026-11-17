import test from 'node:test';
import assert from 'node:assert/strict';
import { clearFinish, describeFinishes, setFinish } from './finishEdit';
import { projectWithRoom, testCatalog } from './testPlan';

test('set_finish: piso con ajustes y limpieza al quitarlo', () => {
  const p = projectWithRoom();
  setFinish(p, testCatalog(), { room: 'H1', surface: 'floor', texture: 'trav', adjust: { junta: 5, patron: 'trabado' } });
  assert.deepEqual(structuredClone(p.finishes), { H1: { floor: { tex: 'trav', junta: 5, patron: 'trabado' } } });
  // sin texture: ajusta el acabado ya asignado
  setFinish(p, testCatalog(), { room: 'H1', surface: 'floor', adjust: { w: 800 } });
  assert.equal(p.finishes!.H1.floor!.w, 800);
  assert.equal(p.finishes!.H1.floor!.junta, 5);
  assert.match(clearFinish(p, testCatalog(), 'H1', 'floor'), /piso/);
  assert.equal(p.finishes, undefined);
});

test('set_finish: muros con altura y acabado propio por lado', () => {
  const p = projectWithRoom();
  const cat = testCatalog();
  setFinish(p, cat, { room: 'H1', surface: 'walls', texture: 'trav', adjust: { altura: 1200 } });
  assert.deepEqual(structuredClone(p.finishes)!.H1.walls, { tex: 'trav', altura: 1200 });
  setFinish(p, cat, { room: 'H1', surface: 'walls', sides: { norte: { texture: 'blanco' }, sur: { texture: '' }, este: { junta: 8 } } });
  const w = p.finishes!.H1.walls!;
  assert.deepEqual(w.lados!.norte, { tex: 'blanco' });
  assert.deepEqual(w.lados!.sur, { tex: '' });
  assert.equal(w.lados!.este!.tex, 'trav'); // copia del general
  assert.equal(w.lados!.este!.junta, 8);
  assert.equal(w.altura, 1200);
  // cambiar la textura general conserva los lados
  setFinish(p, cat, { room: 'H1', surface: 'walls', texture: 'blanco' });
  assert.ok(p.finishes!.H1.walls!.lados!.norte);
  assert.equal(p.finishes!.H1.walls!.altura, 1200);
  // quitar un lado vuelve al general
  clearFinish(p, cat, 'H1', 'walls', 'norte');
  assert.equal(p.finishes!.H1.walls!.lados!.norte, undefined);
  clearFinish(p, cat, 'H1');
  assert.equal(p.finishes, undefined);
});

test('set_finish: validaciones con mensajes claros y sin modificar el proyecto', () => {
  const p = projectWithRoom();
  const cat = testCatalog();
  const before = JSON.stringify(p);
  assert.throws(() => setFinish(p, cat, { room: 'H9', surface: 'floor', texture: 'trav' }), /No existe la habitación H9.*H1/);
  assert.throws(() => setFinish(p, cat, { room: 'H1', surface: 'floor', texture: 'nada' }), /no está en la biblioteca.*trav/);
  assert.throws(() => setFinish(p, cat, { room: 'H1', surface: 'floor', texture: 'trav', adjust: { junta: 99 } }), /junta/);
  assert.throws(() => setFinish(p, cat, { room: 'H1', surface: 'floor', texture: 'trav', adjust: { colorJunta: 'rojo' } }), /colorJunta/);
  assert.throws(() => setFinish(p, cat, { room: 'H1', surface: 'floor', texture: 'trav', adjust: { altura: 1000 } }), /walls/);
  assert.throws(() => setFinish(p, cat, { room: 'H1', surface: 'floor', adjust: { w: 800 } }), /no tiene piso/);
  assert.throws(() => setFinish(p, cat, { room: 'H1', surface: 'walls' }), /nada que cambiar/);
  assert.throws(() => setFinish(p, cat, { room: 'H1', surface: 'walls', texture: 'trav', sides: { arriba: { texture: 'trav' } } as never }), /Lado no válido/);
  assert.equal(JSON.stringify(p), before);
});

test('set_finish migra el roomFloors antiguo sin perderlo', () => {
  const p = projectWithRoom();
  p.roomFloors = { H1: { image: 'trav.png', tile: 600 } };
  setFinish(p, testCatalog(), { room: 'H1', surface: 'walls', texture: 'blanco' });
  assert.equal(p.roomFloors, undefined);
  assert.deepEqual(structuredClone(p.finishes)!.H1.floor, { tex: 'trav' });
  assert.equal(p.finishes!.H1.walls!.tex, 'blanco');
});

test('get_finishes: valores resueltos y avisos de texturas que faltan', () => {
  const p = projectWithRoom();
  p.finishes = { H1: { floor: { tex: 'trav', junta: 5 }, walls: { tex: 'fantasma', altura: 1200 } }, H7: { floor: { tex: 'trav' } } };
  const d = describeFinishes(p, testCatalog());
  const h1 = d.acabados.find((a) => a.room === 'H1')!;
  assert.equal(h1.name, 'Sala');
  assert.equal(h1.floor!.pieza, '600x600 mm');
  assert.equal(h1.floor!.junta, 5);
  assert.equal(h1.walls!.faltaEnBiblioteca, true);
  assert.ok(d.avisos.some((a) => a.includes('fantasma')));
  assert.ok(d.avisos.some((a) => a.includes('H7')));
});
