import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRoom, listOpenings, listRooms, planSummary, roofInfo, setRoomName } from './rooms';
import { projectWithRoom } from './testPlan';

test('list_rooms: claves, nombres, área y caja', () => {
  const p = projectWithRoom();
  const [r] = listRooms(p);
  assert.equal(r.id, 'H1'); assert.equal(r.name, 'Sala'); assert.equal(r.areaM2, 2);
  assert.deepEqual(r.caja, { x0: 0, z0: 0, x1: 2000, z1: 1000, ancho: 2000, fondo: 1000 });
  assert.equal(r.conAcabado, false);
  p.finishes = { H1: { floor: { tex: 'a' } } };
  assert.equal(listRooms(p)[0].conAcabado, true);
  assert.deepEqual(listRooms({ ...p, plan: undefined }), []);
});

test('describe_room: piso real, muros con sus aberturas y techo informativo', () => {
  const p = projectWithRoom();
  const d = describeRoom(p, 'H1');
  assert.equal(d.areaPisoM2, 2);
  assert.equal(d.alturaMuros, 2440);
  assert.equal(d.muros.length, 4);
  const norte = d.muros.find((m) => m.lado === 'norte')!;
  assert.equal(norte.largo, 2000);
  assert.equal(norte.aberturas.length, 1);
  assert.deepEqual(norte.aberturas[0], { id: 'D1', tipo: 'puerta', desde: 500, hasta: 1400, ancho: 900, antepecho: 0, alto: 2100 });
  assert.equal(d.muros.filter((m) => m.aberturas.length).length, 1);
  assert.equal(d.techo, null);
  assert.throws(() => describeRoom(p, 'H8'), /No existe la habitación H8.*H1/);
});

test('techo: cantidad de paneles, espesor y altura (solo informativo)', () => {
  const p = projectWithRoom();
  // dos recuadros de 1000 × 1000 que comparten un lado
  const sq = (x: number) => [[x, 0, x + 1000, 0], [x + 1000, 0, x + 1000, 1000], [x + 1000, 1000, x, 1000], [x, 1000, x, 0]];
  p.plan!.roof = { lines: [...sq(0), ...sq(1000)], thickness: 200 };
  const info = roofInfo(p.plan)!;
  assert.equal(info.paneles, 2); assert.equal(info.espesor, 200); assert.equal(info.altura, 2440);
  assert.equal(describeRoom(p, 'H1').techo!.paneles, 2);
  assert.equal(roofInfo(undefined), null);
});

test('list_openings y resumen del plano', () => {
  const p = projectWithRoom();
  const o = listOpenings(p.plan);
  assert.equal(o.length, 1); assert.equal(o[0].id, 'D1');
  const s = planSummary(p.plan)!;
  assert.equal(s.habitaciones, 1); assert.equal(s.aberturas, 1);
  assert.equal(planSummary(undefined), null);
});

test('set_room_name: renombra, limpia y valida', () => {
  const p = projectWithRoom();
  assert.match(setRoomName(p, 'H1', '  Cocina\n'), /Cocina/);
  assert.equal(p.plan!.rooms![0].name, 'Cocina');
  setRoomName(p, 'H1', '');
  assert.equal(p.plan!.rooms![0].name, '');
  assert.throws(() => setRoomName(p, 'H2', 'x'), /No existe/);
});
