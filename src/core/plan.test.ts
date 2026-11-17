import test from 'node:test';
import assert from 'node:assert/strict';
import { assignOpenings, cropPlan, detectPanels, detectRoom, parsePlan, planBounds, rotatePlan, scalePlan, toFloorPlan } from './plan';

/** Arma un DXF mínimo a partir de pares código/valor. */
const dxf = (header: (string | number)[], blocks: (string | number)[], entities: (string | number)[]) =>
  [0, 'SECTION', 2, 'HEADER', ...header, 0, 'ENDSEC', 0, 'SECTION', 2, 'BLOCKS', ...blocks, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', ...entities, 0, 'ENDSEC', 0, 'EOF'].join('\n');
const line = (layer: string, x1: number, y1: number, x2: number, y2: number) => [0, 'LINE', 8, layer, 10, x1, 20, y1, 30, 0, 11, x2, 21, y2, 31, 0];

test('lee líneas y capas, y pasa metros a mm con el muro del fondo arriba', () => {
  const raw = parsePlan(dxf([9, '$INSUNITS', 70, 6], [], [...line('MUROS', 0, 0, 6, 0), ...line('MUROS', 6, 0, 6, 3), ...line('COTAS', 0, 1, 1, 1)]));
  assert.equal(raw.unit, 'm');
  assert.equal(raw.unitKnown, true);
  assert.deepEqual([...raw.layers].sort(), ['COTAS', 'MUROS']);
  const plan = toFloorPlan(raw, raw.unit, ['MUROS'], 'casa');
  assert.equal(plan.lines.length, 2);
  const b = planBounds(plan)!;
  assert.deepEqual([b.minX, b.minZ, b.maxX, b.maxZ], [0, 0, 6000, 3000]);
  // el lado y=3 del CAD (arriba) queda en z=0 (muro del fondo)
  assert.ok(plan.lines.some((l) => l[1] === 3000 && l[3] === 0) || plan.lines.some((l) => l[1] === 0 && l[3] === 3000));
});

test('sin unidades declaradas las adivina por el tamaño', () => {
  assert.equal(parsePlan(dxf([], [], line('0', 0, 0, 6000, 0))).unit, 'mm');
  assert.equal(parsePlan(dxf([], [], line('0', 0, 0, 600, 0))).unit, 'cm');
  const m = parsePlan(dxf([], [], line('0', 0, 0, 6, 0)));
  assert.equal(m.unit, 'm');
  assert.equal(m.unitKnown, false);
});

test('polilínea cerrada, arco y bloque insertado con giro y escala', () => {
  const poly = [0, 'LWPOLYLINE', 8, 'MUROS', 90, 4, 70, 1, 10, 0, 20, 0, 10, 4000, 20, 0, 10, 4000, 20, 3000, 10, 0, 20, 3000];
  const blk = [0, 'BLOCK', 8, '0', 2, 'PUERTA', 70, 0, 10, 0, 20, 0, 30, 0, ...line('PUERTAS', 0, 0, 900, 0), 0, 'ENDBLK'];
  const ins = [0, 'INSERT', 8, 'PUERTAS', 2, 'PUERTA', 10, 1000, 20, 0, 30, 0, 50, 90];
  const raw = parsePlan(dxf([9, '$INSUNITS', 70, 4], blk, [...poly, ...ins]));
  assert.equal(raw.segs.filter((s) => raw.layers[s[4]] === 'MUROS').length, 4);
  const door = raw.segs.find((s) => raw.layers[s[4]] === 'PUERTAS')!;
  // 900 mm girados 90° desde (1000,0): sube a (1000,900)
  assert.ok(Math.abs(door[2] - 1000) < 1e-6 && Math.abs(door[3] - 900) < 1e-6);
  const arc = parsePlan(dxf([], [], [0, 'ARC', 8, 'A', 10, 0, 20, 0, 30, 0, 40, 900, 50, 0, 51, 90]));
  assert.ok(arc.segs.length >= 12);
});

test('rechaza .dwg y archivos sin dibujo', () => {
  assert.throws(() => parsePlan('AC1027\u0000\u0000binario'), /dwg/);
  assert.throws(() => parsePlan(dxf([], [], [])), /no tiene líneas/);
});

test('girar, escalar y recortar mueven el plano a mm correctos', () => {
  const plan = { name: 'p', lines: [[0, 0, 4000, 0], [4000, 0, 4000, 3000]] };
  const r = rotatePlan(plan);
  const b = planBounds(r)!;
  assert.deepEqual([b.maxX, b.maxZ], [3000, 4000]);
  const s = planBounds(scalePlan(plan, 0.5))!;
  assert.deepEqual([s.maxX, s.maxZ], [2000, 1500]);
  const c = cropPlan(plan, { x: 500, z: 200 });
  assert.deepEqual(c.lines[0], [-500, -200, 3500, -200]);
});

test('lee textos, MTEXT y cotas con su posición en mm', () => {
  const L = line('MUROS', 0, 0, 4, 0);
  const txt = [0, 'MTEXT', 8, 'ROTULOS', 10, 1, 20, 2, 30, 0, 40, 0.1, 1, 'COCINA', 0, 'TEXT', 8, 'ROTULOS', 10, 2, 20, 1, 30, 0, 40, 0.2, 1, 'Sala'];
  const dim = [0, 'DIMENSION', 8, 'COTAS', 2, '*D1', 10, 0, 20, 0, 30, 0, 11, 2, 21, 0.5, 31, 0, 70, 0, 1, '', 42, 4000];
  const raw = parsePlan(dxf([9, '$INSUNITS', 70, 6], [], [...L, ...txt, ...dim]));
  assert.deepEqual(raw.texts.map((t) => t.t).sort(), ['4000', 'COCINA', 'Sala']);
  const plan = toFloorPlan(raw, 'm', raw.layers, 'x');
  const cocina = plan.texts!.find((t) => t.t === 'COCINA')!;
  assert.equal(cocina.h, 100);
  assert.equal(cocina.x, 1000);
  const sinCotas = toFloorPlan(raw, 'm', ['MUROS', 'ROTULOS'], 'x');
  assert.equal(sinCotas.texts!.length, 2);
  assert.deepEqual(planBounds(rotatePlan(plan))!.maxX, planBounds(plan)!.maxZ);
});

test('detecta las caras interiores del muro y su espesor aunque haya una puerta y un mueble dibujados', () => {
  const rectLines = (x0: number, z0: number, x1: number, z1: number) => [[x0, z0, x1, z0], [x1, z0, x1, z1], [x1, z1, x0, z1], [x0, z1, x0, z0]];
  const plan = {
    name: 't',
    lines: [
      ...rectLines(0, 0, 5000, 3000), // cara exterior
      ...rectLines(120, 120, 4880, 2880), // cara interior
      ...rectLines(2000, 1000, 2600, 1400), // mueble dibujado
      [900, 120, 900, 700], // hoja de puerta que sale del muro
    ],
  };
  const r = detectRoom(plan, { x0: 0, z0: 0, x1: 5000, z1: 3000 })!;
  assert.deepEqual([r.x0, r.z0, r.x1, r.z1, r.wall], [120, 120, 4880, 2880, 120]);
  assert.equal(detectRoom({ name: 'a', lines: [[0, 0, 5000, 0]] }, { x0: 0, z0: 0, x1: 5000, z1: 3000 }), null);
});

const text = (x: number, y: number, t: string) => [0, 'TEXT', 8, 'T', 10, x, 20, y, 30, 0, 40, 100, 1, t];
const rect = (x0: number, y0: number, x1: number, y1: number) => [...line('M', x0, y0, x1, y0), ...line('M', x1, y0, x1, y1), ...line('M', x1, y1, x0, y1), ...line('M', x0, y1, x0, y0)];

test('lee puertas de una elevación y las ubica en la planta por las etiquetas B##', () => {
  const ents = [
    ...rect(0, 0, 9000, 6000), ...text(1000, 3000, 'B01'), ...text(3000, 3000, 'B02'), ...text(7000, 3000, 'B03'),
    ...rect(20000, 0, 24000, 2440), ...text(20500, 1000, 'B01'), ...text(22500, 1000, 'B02'),
    ...rect(21000, 0, 21800, 2000), ...line('X', 21000, 0, 21800, 2000), ...line('X', 21000, 2000, 21800, 0),
  ];
  const raw = parsePlan(dxf([9, '$INSUNITS', 70, 4], [], ents));
  const info = detectPanels(raw, 'mm')!;
  assert.equal(info.height, 2440);
  assert.equal(info.openings.length, 1);
  const plan = toFloorPlan(raw, 'mm', raw.layers, 'casa');
  const o = plan.openings![0];
  assert.deepEqual([o.kind, o.y, o.h, o.x1, o.x2, o.z1], ['door', 0, 2000, 1500, 2300, 3000]);
  // el espacio es toda la planta: la puerta cae a 3000 mm del muro del fondo, en el interior → ningún muro
  assert.equal(assignOpenings(plan, 9000, 6000, 100).length, 0);
  // con el espacio acotado a esa franja, la puerta queda en el muro del fondo
  const sub = cropPlan(plan, { x: 0, z: 3000 });
  const got = assignOpenings(sub, 9000, 3000, 100);
  assert.deepEqual(got.map((q) => [q.wall, q.a, q.b, q.kind]), [['back', 1500, 2300, 'door']]);
  // girar y escalar mueven también los huecos
  assert.equal(scalePlan(plan, 2).openings![0].h, 4000);
});

import { openingConflicts } from './clearance';
import { addCabinet } from './furniture';
import { defaultProject, type FloorPlan } from './types';

test('avisa si un mueble bloquea una puerta o tapa una ventana', () => {
  const p = defaultProject();
  p.room = { width: 5000, depth: 3000, height: 2440, openings: [{ wall: 'front', a: 1000, b: 1800, y: 0, h: 2000, kind: 'door', tag: 'B35' }, { wall: 'back', a: 3000, b: 4000, y: 900, h: 1000, kind: 'window' }] };
  addCabinet(p, { name: 'Base 1', kind: 'box', width: 1200, height: 720, depth: 560, x: 3200, y: 0, z: 0 });
  assert.deepEqual(openingConflicts(p), []); // la base llega a 720 < antepecho 900
  addCabinet(p, { name: 'Alto', kind: 'box', width: 600, height: 2000, depth: 400, x: 1200, y: 0, z: 2500 });
  assert.equal(openingConflicts(p).length, 1);
  assert.match(openingConflicts(p)[0], /Alto bloquea la puerta B35 del muro frontal/);
});

test('lee los paneles de muro perimetral e interior como cajas de la planta', () => {
  const blk = (name: string, w: number, t: number) => [0, 'BLOCK', 8, '0', 2, name, 70, 0, 10, 0, 20, 0, 30, 0, 3, name, 1, '', ...rect(0, 0, w, t), 0, 'ENDBLK', 8, '0'];
  const ins = (name: string, x: number, y: number, rot = 0) => [0, 'INSERT', 8, '0', 2, name, 10, x, 20, y, 30, 0, 50, rot];
  const mp = 'panel - 244PROTEC-MP-140-1-Muro Interior', mi = 'panel - 244PROTEC-MI-114-2-Muro Interior';
  const ents = [...ins(mp, 1000, 1000), ...ins(mi, 3000, 2000, 90), ...text(1100, 1100, 'B01'), ...text(2000, 1100, 'B02'), ...text(3000, 1100, 'B03'), ...rect(0, 0, 9000, 6000)];
  const raw = parsePlan(dxf([9, '$INSUNITS', 70, 4], [...blk(mp, 1220, 140), ...blk(mi, 600, 114)], ents));
  assert.deepEqual(raw.blocks.map((b) => [b.kind, Math.round(b.x1 - b.x0), Math.round(b.y1 - b.y0)]), [['MP', 1220, 140], ['MI', 114, 600]]);
  const plan = toFloorPlan(raw, 'mm', raw.layers, 'casa');
  assert.deepEqual(plan.walls?.map((w) => [w.kind, Math.round(w.x1 - w.x0), Math.round(w.z1 - w.z0)]), [['MP', 1220, 140], ['MI', 114, 600]]);
});

import { makeOpening, openingIds } from './ids';

test('pone una puerta o ventana sobre un muro por su clave y la numera después de las leídas', () => {
  const walls = [{ kind: 'MP' as const, x0: 0, z0: 0, x1: 5000, z1: 140 }, { kind: 'MI' as const, x0: 0, z0: 140, x1: 114, z1: 3000 }];
  const plan: FloorPlan = { name: 'x', lines: [], walls, house: { x0: 0, z0: 0, x1: 5000, z1: 3000 }, panelH: 2440, openings: [{ x1: 100, z1: 70, x2: 900, z2: 70, y: 0, h: 2000, kind: 'door' }] };
  const o = makeOpening(plan, 'P1', 'window', 1000, 1200, 900, 1200)!;
  assert.deepEqual([o.x1, o.x2, o.z1, o.y, o.h, o.manual, o.wall], [1000, 2200, 70, 900, 1200, true, 'P1']);
  const v = makeOpening(plan, 'I1', 'door', 200, 900, 0, 2100)!;
  assert.deepEqual([v.x1, v.z1, v.z2], [57, 340, 1240]);
  assert.equal(makeOpening(plan, 'P1', 'door', 4500, 900, 0, 2100), null); // se sale del muro
  assert.equal(makeOpening(plan, 'X9', 'door', 0, 900, 0, 2100), null);
  plan.openings!.push(o);
  assert.deepEqual(openingIds(plan).map((d) => d.id), ['D1', 'V1']);
});

test('detecta una X aunque una diagonal se pase unos mm de la caja', () => {
  const ents = [
    ...rect(0, 0, 9000, 6000), ...text(1000, 3000, 'B01'), ...text(3000, 3000, 'B02'), ...text(7000, 3000, 'B03'),
    ...rect(20000, 0, 24000, 2440), ...text(20500, 1000, 'B01'), ...text(22500, 1000, 'B02'),
    ...line('X', 21000, 0, 21800, 2000), ...line('X', 21000, 2000, 21800, 0),
    ...line('X', 22640, 2000, 23440, 0), ...line('X', 22640, 0, 23483, 2107.5), // la segunda diagonal se pasa 43 mm y 107 mm
  ];
  const raw = parsePlan(dxf([9, '$INSUNITS', 70, 4], [], ents));
  const e = detectPanels(raw, 'mm')!.elev[0];
  assert.deepEqual(e.openings.map((o) => [o.x0, o.x1, o.y, o.h]), [[1000, 1800, 0, 2000], [2640, 3440, 0, 2000]]);
});

test('los paneles perimetrales con sombreado son aberturas: puerta, ventanal juntando piezas y por confirmar', () => {
  const hatch = (x0: number, y0: number, x1: number, y1: number) => [0, 'HATCH', 8, '0', 100, 'AcDbHatch', 10, 0, 20, 0, 30, 0, 210, 0, 220, 0, 230, 1, 2, 'SOLID', 70, 1, 71, 0, 91, 1, 92, 1, 93, 4,
    72, 1, 10, x0, 20, y0, 11, x1, 21, y0, 72, 1, 10, x1, 20, y0, 11, x1, 21, y1, 72, 1, 10, x1, 20, y1, 11, x0, 21, y1, 72, 1, 10, x0, 20, y1, 11, x0, 21, y0, 97, 0, 75, 0, 76, 1, 98, 0];
  const blk = (name: string, w: number, withLines: boolean) => [0, 'BLOCK', 8, '0', 2, name, 70, 0, 10, 0, 20, 0, 30, 0, 3, name, 1, '', ...(withLines ? rect(0, 0, w, 140) : []), ...hatch(0, 0, w, 140), 0, 'ENDBLK', 8, '0'];
  const ins = (name: string, x: number, y: number) => [0, 'INSERT', 8, '0', 2, name, 10, x, 20, y, 30, 0];
  const puerta = 'panel - 244PROTEC-MP-140-1-Muro Interior', v1 = 'panel - 244PROTEC-MP-140-2-Muro Interior', v2 = 'panel - 244PROTEC-MP-140-3-Muro Interior', vacio = 'panel - 244PROTEC-MP-140-4-Muro Interior';
  const ents = [...rect(0, 0, 9000, 6000), ...text(1000, 3000, 'B01'), ...text(3000, 3000, 'B02'), ...text(7000, 3000, 'B03'),
    ...ins(puerta, 1000, 100), ...ins(v1, 3000, 100), ...ins(v2, 4750, 100), ...ins(vacio, 7000, 100)];
  const raw = parsePlan(dxf([9, '$INSUNITS', 70, 4], [...blk(puerta, 1000, true), ...blk(v1, 1750, true), ...blk(v2, 1750, true), ...blk(vacio, 686, false)], ents));
  assert.deepEqual(raw.blocks.map((b) => [b.lines, !!b.hatch]), [[4, true], [4, true], [4, true], [0, true]]);
  const plan = toFloorPlan(raw, 'mm', raw.layers, 'casa');
  const ab = plan.openings!.filter((o) => o.fromBlock).sort((p, q) => p.x1 - q.x1);
  assert.deepEqual(ab.map((o) => [o.kind, Math.round(o.x2 - o.x1), !!o.unknown]), [['door', 1000, false], ['window', 3500, false], ['window', 600, true]]);
  assert.deepEqual(openingIds(plan).filter((d) => d.o.fromBlock).map((d) => d.id), ['D1', 'V1', 'A1']);
});

test('un recuadro suelto menor de 150 mm no cuenta en el largo de la elevación', () => {
  const ents = [
    ...rect(0, 0, 9000, 6000), ...text(1000, 3000, 'B01'), ...text(3000, 3000, 'B02'), ...text(7000, 3000, 'B03'),
    ...rect(20000, 0, 22886, 2440), ...text(20500, 1000, 'B01'), ...text(22500, 1000, 'B02'),
    ...rect(23240, 0, 23332, 600), // recuadro suelto de 92 mm, a 354 mm del dibujo
  ];
  const raw = parsePlan(dxf([9, '$INSUNITS', 70, 4], [], ents));
  const e = detectPanels(raw, 'mm')!.elev[0];
  assert.equal(e.w, 2886);
  assert.ok(e.lines.every((l) => Math.max(l[0], l[2]) <= 2887));
});
