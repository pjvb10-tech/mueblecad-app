import test from 'node:test';
import assert from 'node:assert/strict';
import DxfParser from 'dxf-parser';
import { defaultProject, type Part, type Project } from './types';
import { addCabinet, buildCabinet, groupOf, layerOf, rebuildCabinet } from './furniture';
import { cutList, nest } from './nesting';
import { outline, polygonArea } from './shapes';
import { fitToRoom } from './layout';
import { dxf, gcode, offsetPolygon, piecesCsv } from './export';

const project = (): Project => defaultProject();
const bboxX = (parts: Part[]) => [Math.min(...parts.map((p) => p.position[0])), Math.max(...parts.map((p) => p.position[0] + p.size[0]))];

test('fondo embutido: rebajes en laterales, base y tapa; el fondo queda dentro', () => {
  const p = project();
  const parts = buildCabinet(p, { name: 'R', width: 800, height: 1000, depth: 400, shelves: 1, backMaterial: 'mdf3', rebateBack: true });
  const by = (s: string) => parts.find((x) => x.name === `R ${s}`)!;
  for (const n of ['lateral izq', 'lateral der', 'base', 'tapa']) {
    assert.equal(by(n).rebates?.length, 1, n);
    assert.equal(by(n).rebates![0].width, 3);
    assert.equal(by(n).rebates![0].depth, 8);
  }
  assert.equal(by('entrepaño 1').rebates, undefined);
  assert.equal(by('lateral izq').size[2], 400); // el lateral ocupa todo el fondo
  assert.deepEqual(by('fondo').size, [764 + 16, 1000 - 36 + 16, 3]);
  p.parts = parts;
  const r = nest(p);
  assert.equal(r.warnings.length, 0);
  assert.ok(cutList(p).some((row) => row.rebates.includes('rebaje 3×8')));
});

test('el canto del rebaje es el trasero (z mínimo) en laterales y tapas', () => {
  const p = project();
  const parts = buildCabinet(p, { name: 'R', width: 800, height: 1000, depth: 400, backMaterial: 'mdf3', rebateBack: true });
  // lateral: u = alto (Y), v = fondo (Z) -> canto 0 (v mínimo = z mínimo)
  assert.equal(parts.find((x) => x.name === 'R lateral izq')!.rebates![0].edge, 0);
  // tapa 764x18x400: u = X, v = Z -> canto 0
  assert.equal(parts.find((x) => x.name === 'R tapa')!.rebates![0].edge, 0);
  // una tapa más fondo que ancha: u = Z -> canto 3 (u mínimo)
  const deep = buildCabinet(p, { name: 'D', width: 400, height: 1000, depth: 700, backMaterial: 'mdf3', rebateBack: true });
  assert.equal(deep.find((x) => x.name === 'D tapa')!.rebates![0].edge, 3);
});

test('esquinero en L: base con muesca, brazos y puertas por brazo', () => {
  const p = project();
  const parts = buildCabinet(p, { name: 'E', kind: 'corner', width: 1000, wingB: 900, depth: 560, height: 760, shelves: 1, backMaterial: 'mdf3', doorMaterial: 'frente' });
  const base = parts.find((x) => x.name === 'E base')!;
  assert.deepEqual(base.size, [1000, 18, 900]);
  assert.equal(polygonArea(outline(base.size, base.shape).outer), 1000 * 900 - 440 * 340);
  assert.ok(parts.some((x) => x.name === 'E puerta A1') && parts.some((x) => x.name === 'E puerta B1'));
  p.parts = parts;
  const r = nest(p);
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.warnings.length, 0);
  assert.ok(cutList(p).some((row) => row.shaped));
  // brazo B más largo que A: la muesca sigue el eje largo
  const tall = buildCabinet(p, { name: 'T', kind: 'corner', width: 800, wingB: 1200, depth: 560, height: 760 });
  const b2 = tall.find((x) => x.name === 'T base')!;
  assert.equal(polygonArea(outline(b2.size, b2.shape).outer), 800 * 1200 - 240 * 640);
  assert.throws(() => buildCabinet(p, { kind: 'corner', width: 600, wingB: 900, depth: 560, height: 760 }));
});

test('número de puertas configurable', () => {
  const p = project();
  assert.equal(buildCabinet(p, { name: 'A', width: 1000, height: 700, depth: 300, doorMaterial: 'frente' }).filter((x) => x.name.includes('puerta')).length, 2);
  assert.equal(buildCabinet(p, { name: 'B', width: 1000, height: 700, depth: 300, doorMaterial: 'frente', doors: 3 }).filter((x) => x.name.includes('puerta')).length, 3);
  assert.equal(buildCabinet(p, { name: 'C', width: 400, height: 700, depth: 300, doorMaterial: 'frente', doors: 1 }).filter((x) => x.name.includes('puerta')).length, 1);
});

test('rebuildCabinet cambia las medidas y conserva la posición', () => {
  const p = project();
  addCabinet(p, { name: 'M', width: 600, height: 760, depth: 560, shelves: 1, doorMaterial: 'frente', x: 1200, y: 100, z: 50 });
  assert.equal(p.cabinets!.M.width, 600);
  rebuildCabinet(p, 'M', { width: 900, shelves: 2 });
  assert.equal(p.cabinets!.M.width, 900);
  assert.equal(p.parts.filter((x) => x.name.includes('entrepaño')).length, 2);
  assert.equal(p.parts.filter((x) => x.name.includes('puerta')).length, 2); // 900 mm = 2 puertas
  const mine = p.parts.filter((x) => groupOf(x) === 'M');
  assert.deepEqual([Math.min(...mine.map((x) => x.position[0])), Math.min(...mine.map((x) => x.position[1])), Math.min(...mine.map((x) => x.position[2]))], [1200, 100, 50]);
  assert.equal(Math.max(...mine.map((x) => x.position[0] + x.size[0])) - 1200, 900);
  assert.equal(rebuildCabinet(p, 'no existe', { width: 1 }), null);
});

test('ajustar al espacio: llenar el ancho del muro sin huecos', () => {
  const p = project();
  p.room = { width: 3000, depth: 2500, height: 2400 };
  addCabinet(p, { name: 'A', width: 600, height: 760, depth: 560, x: 0 });
  addCabinet(p, { name: 'B', width: 800, height: 760, depth: 560, x: 600 });
  addCabinet(p, { name: 'C', width: 600, height: 760, depth: 560, x: 1400 });
  fitToRoom(p, 'fill');
  const widths = ['A', 'B', 'C'].map((g) => p.cabinets![g].width);
  assert.equal(widths.reduce((s, w) => s + w, 0), 3000);
  const [lo, hi] = bboxX(p.parts);
  assert.equal(lo, 0);
  assert.equal(hi, 3000);
  const starts = ['A', 'B', 'C'].map((g) => Math.min(...p.parts.filter((x) => groupOf(x) === g).map((x) => x.position[0])));
  assert.deepEqual(starts, [0, widths[0], widths[0] + widths[1]]);
});

test('ajustar al espacio: pegar al fondo, izquierda, derecha y centrar', () => {
  const p = project();
  p.room = { width: 3000, depth: 2500, height: 2400 };
  addCabinet(p, { name: 'A', width: 600, height: 760, depth: 560, x: 500, z: 300 });
  fitToRoom(p, 'back');
  assert.equal(Math.min(...p.parts.map((x) => x.position[2])), 0);
  fitToRoom(p, 'left');
  assert.equal(bboxX(p.parts)[0], 0);
  fitToRoom(p, 'right');
  assert.equal(bboxX(p.parts)[1], 3000);
  fitToRoom(p, 'center');
  assert.deepEqual(bboxX(p.parts), [1200, 1800]);
  delete p.room;
  assert.match(fitToRoom(p, 'back'), /espacio/);
});

test('capa propia reemplaza a la automática', () => {
  const p = project();
  const [door] = buildCabinet(p, { name: 'A', width: 500, height: 700, depth: 300, doorMaterial: 'frente' }).filter((x) => x.name.includes('puerta'));
  assert.equal(layerOf(p, door), 'Puertas');
  assert.equal(layerOf(p, { ...door, layer: 'Presentación' }), 'Presentación');
});

test('DXF válido con capas CORTE, HUECOS, REBAJE y SECUENCIA', () => {
  const p = project();
  p.parts = buildCabinet(p, { name: 'R', width: 800, height: 1000, depth: 400, shelves: 1, backMaterial: 'mdf3', rebateBack: true });
  p.parts.push({ id: 'h', name: 'con hueco', size: [500, 18, 300], position: [0, 0, 0], material: 'mel18', shape: { holes: [{ x: 100, y: 100, w: 100, h: 80 }] } });
  const r = nest(p);
  const parsed = new DxfParser().parseSync(dxf(p, r));
  assert.ok(parsed);
  const layers = new Set(parsed.entities.map((e) => e.layer));
  for (const l of ['PLANCHA', 'CORTE', 'HUECOS', 'REBAJE', 'SECUENCIA', 'ETIQUETA']) assert.ok(layers.has(l), `falta ${l}`);
  assert.ok(parsed.entities.length > 40);
  assert.ok(parsed.entities.every((e) => e.type === 'LINE' || e.type === 'TEXT'));
});

test('CSV incluye rebajes y posición en plancha', () => {
  const p = project();
  p.parts = buildCabinet(p, { name: 'R', width: 800, height: 1000, depth: 400, backMaterial: 'mdf3', rebateBack: true });
  const csv = piecesCsv(p, nest(p));
  assert.ok(csv.includes('Rebajes') && csv.includes('rebaje 3×8 mm en canto largo'));
});

test('offsetPolygon agranda y achica sin importar la orientación', () => {
  const ccw: [number, number][] = [[0, 0], [100, 0], [100, 50], [0, 50]];
  const cw = [...ccw].reverse();
  for (const sq of [ccw, cw]) {
    assert.equal(Math.round(polygonArea(offsetPolygon(sq, 3))), 106 * 56);
    assert.equal(Math.round(polygonArea(offsetPolygon(sq, -3))), 94 * 44);
  }
});

test('G-code: compensa el radio de la fresa, hace huecos y rebajes primero', () => {
  const p = project();
  p.parts = [{ id: 'a', name: 'tablero', size: [600, 18, 400], position: [0, 0, 0], material: 'mel18', shape: { holes: [{ x: 100, y: 100, w: 100, h: 100 }] }, rebates: [{ edge: 0, width: 6, depth: 8 }] }];
  const r = nest(p);
  const g = gcode(p, r, { toolDiameter: 6, passDepth: 6 });
  assert.match(g, /^\( MuebleCAD/);
  assert.ok(g.includes('G21 G90 G17') && g.includes('M3 S18000') && g.trimEnd().endsWith('M30'));
  const pl = r.sheets[0].placements[0];
  const xs = [...g.matchAll(/G1 X(-?[\d.]+) Y/g)].map((m) => Number(m[1]));
  assert.equal(Math.min(...xs), pl.x - 3); // contorno exterior desplazado el radio
  assert.equal(Math.max(...xs), pl.x + 600 + 3);
  assert.ok(xs.includes(pl.x + 100 + 3) && xs.includes(pl.x + 200 - 3)); // hueco achicado
  assert.ok(g.indexOf('rebaje') < g.lastIndexOf('( tablero )') + 1000);
  assert.ok(g.indexOf('G1 Z-6.100') > 0 || g.includes('Z-'), 'baja en pasadas');
  const zs = new Set([...g.matchAll(/G1 Z(-[\d.]+)/g)].map((m) => m[1]));
  assert.ok([...zs].some((z) => Number(z) <= -18.2)); // atraviesa el espesor
});

test('G-code omite lo que la fresa no puede hacer', () => {
  const p = project();
  p.parts = [{ id: 'a', name: 'chico', size: [300, 18, 200], position: [0, 0, 0], material: 'mel18', shape: { holes: [{ x: 50, y: 50, w: 4, h: 4 }] }, rebates: [{ edge: 0, width: 20, depth: 8 }] }];
  const g = gcode(p, nest(p), { toolDiameter: 6 });
  assert.ok(g.includes('hueco omitido') && g.includes('omitido: necesita más de 2 pasadas'));
});
