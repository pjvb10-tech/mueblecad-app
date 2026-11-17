import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProject, type Part, type Project } from './types';
import { addCabinet } from './furniture';
import { cutList, nest } from './nesting';
import { budget, hardwareCounts } from './budget';
import { applyAutoEdges, edgeMeters } from './edges';
import { piecesCsv } from './export';
import { openingConflicts } from './clearance';
import {
  boundsOf, cleanProfile, describeSolid, normalizePart, partBounds, partVolume, resolveAxis, rotationMatrix, selfIntersection, solidSpec, solidsList, toWorld, validatePart,
} from './solids';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const nearV = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => near(v, b[i], eps));
const part = (o: Partial<Part>): Part => ({ id: 'p1', name: 'Pieza', size: [100, 100, 100], position: [0, 0, 0], material: 'mel18', ...o });

// ---------------------------------------------------------------- giro

test('giro: orden X, Y, Z sobre ejes fijos (R = Rz·Ry·Rx) alrededor del centro de la caja', () => {
  const p = part({ size: [2, 2, 2], position: [-1, -1, -1] }); // centro en el origen
  // sin giro, toWorld es position + p exacto
  assert.deepEqual(toWorld(p, [2, 1, 1]), [1, 0, 0]);
  // rotZ=90: +X pasa a +Y
  nearV(toWorld({ ...p, rotZ: 90 }, [2, 1, 1]), [0, 1, 0]);
  // rotX=90 y luego rotZ=90: +X -> +X -> +Y; +Y -> +Z -> +Z (con el orden contrario daría +Z y -X)
  const both = { ...p, rotX: 90, rotZ: 90 };
  nearV(toWorld(both, [2, 1, 1]), [0, 1, 0]);
  nearV(toWorld(both, [1, 2, 1]), [0, 0, 1]);
  // regla de la mano derecha: rotY=90 lleva +Z a +X
  nearV(toWorld({ ...p, rotY: 90 }, [1, 1, 2]), [1, 0, 0]);
  // la matriz es ortonormal con determinante 1
  const m = rotationMatrix({ rotX: 33.3, rotY: -71.2, rotZ: 125 });
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  near(det, 1);
  // el centro no se mueve
  nearV(toWorld({ ...p, rotX: 12, rotY: 34, rotZ: 56 }, [1, 1, 1]), [0, 0, 0]);
});

test('giro: partBounds sin giro es exactamente position/size; con giro es la caja de las esquinas giradas', () => {
  const p = part({ size: [100, 200, 30], position: [10.5, 20, 30] });
  assert.deepEqual(partBounds(p), { min: [10.5, 20, 30], max: [110.5, 220, 60], size: [100, 200, 30] });
  const q = partBounds({ ...p, rotZ: 90 });
  nearV(q.size, [200, 100, 30]);
  nearV([q.min[0] + q.size[0] / 2, q.min[1] + q.size[1] / 2], [60.5, 120]); // mismo centro
  const d = partBounds(part({ size: [100, 100, 10], rotZ: 45 }));
  near(d.size[0], 100 * Math.SQRT2, 1e-4);
  near(d.size[2], 10);
  // varios giros: el volumen de la caja envolvente nunca es menor que el de la pieza
  const w = partBounds(part({ size: [100, 50, 20], rotX: 20, rotY: 30, rotZ: 40 }));
  assert.ok(w.size[0] * w.size[1] * w.size[2] >= 100 * 50 * 20);
  assert.deepEqual(boundsOf([p, part({ position: [500, 0, 0] })]).max, [600, 220, 100]);
});

// ---------------------------------------------------------------- validación

test('validación: parámetros absurdos con mensajes claros', () => {
  const tube = part({ form: 'tube', size: [50, 1000, 50], axis: 'y' });
  assert.match(validatePart(tube)!, /necesita wall/);
  assert.match(validatePart({ ...tube, wall: 25 })!, /espesor de pared \(25 mm\) debe ser menor que la mitad del lado menor.*25 mm/);
  assert.match(validatePart({ ...tube, wall: 30 })!, /espesor de pared/);
  assert.equal(validatePart({ ...tube, wall: 3, cornerRadius: 5 }), null);
  assert.match(validatePart({ ...tube, wall: 3, cornerRadius: 30 })!, /cornerRadius/);
  assert.match(validatePart({ ...tube, wall: 3, profile: [[0, 0], [1, 0], [1, 1]] })!, /profile no se usa con form "tube"/);
  const cyl = part({ form: 'cylinder', size: [120, 20, 120] });
  assert.equal(validatePart(cyl), null);
  assert.match(validatePart({ ...cyl, wall: 60 })!, /espesor de pared/);
  assert.match(validatePart(part({ form: 'cone' as never }))!, /no existe/);
  assert.match(validatePart(part({ wall: 3 }))!, /wall no se usa con form "box"/);
  assert.match(validatePart(part({ rotX: Infinity }))!, /rotX/);
  assert.match(validatePart(part({ size: [0, 1, 1] }))!, /mayores que 0/);
  assert.match(validatePart({ ...cyl, shape: { radius: 5 } })!, /shape/);
  assert.match(validatePart({ ...cyl, segments: 3 })!, /segments/);

  const prism = part({ form: 'prism', size: [400, 1800, 400], profile: [[0, 0], [400, 0], [270, 1800], [0, 1800]] });
  assert.equal(validatePart(prism), null);
  assert.match(validatePart({ ...prism, profile: undefined })!, /necesita profile/);
  assert.match(validatePart({ ...prism, profile: [[0, 0], [10, 0]] })!, /al menos 3 vértices/);
  assert.match(validatePart({ ...prism, profile: [[0, 0], [10, 0], [20, 0]] })!, /no encierra área/);
  // corbata: los lados 1 y 3 se cruzan
  assert.match(validatePart({ ...prism, profile: [[0, 0], [400, 1800], [400, 0], [0, 1800]] })!, /se cruza/);
  assert.match(validatePart({ ...prism, profile: [[0, 0], [500, 0], [500, 100], [0, 100]] })!, /se sale de la caja/);
  assert.match(validatePart({ ...prism, profile: [[-5, 0], [400, 0], [400, 100]] })!, /negativas/);
  assert.match(validatePart({ ...prism, profile: [[0, 0], [1, 0], [Number.NaN, 5]] })!, /números finitos/);
  // el vértice repetido que cierra el polígono se tolera
  assert.equal(validatePart({ ...prism, profile: [[0, 0], [400, 0], [270, 1800], [0, 1800], [0, 0]] }), null);

  const rev = part({ form: 'revolve', axis: 'y', size: [120, 20, 120], profile: [[0, 0], [60, 0], [60, 20], [0, 20]] });
  assert.equal(validatePart(rev), null);
  assert.match(validatePart({ ...rev, profile: [[0, 0], [-5, 0], [60, 20]] })!, /r .*no puede ser negativa/);
  assert.match(validatePart({ ...rev, profile: [[0, 0], [70, 0], [70, 20], [0, 20]] })!, /no cabe en la sección/);
  assert.match(validatePart({ ...rev, profile: [[0, 0], [60, 0], [60, 25], [0, 25]] })!, /h debe estar entre 0 y 20/);
  assert.equal(validatePart(part({})), null); // una caja de siempre
});

test('polígonos: autointersección y limpieza', () => {
  assert.equal(selfIntersection([[0, 0], [4, 0], [4, 4], [0, 4]]), null);
  assert.ok(selfIntersection([[0, 0], [4, 4], [4, 0], [0, 4]]));
  assert.ok(selfIntersection([[0, 0], [4, 0], [4, 4], [2, 0], [0, 4]]), 'se toca a sí mismo');
  assert.deepEqual(cleanProfile([[0, 0], [0, 0], [1, 0], [1, 1], [0, 0]]), [[0, 0], [1, 0], [1, 1]]);
});

// ---------------------------------------------------------------- formas

test('cilindro, tubo, prisma y revolución: eje, geometría y volumen real', () => {
  // eje por omisión: la dimensión distinta
  assert.equal(resolveAxis({ form: 'cylinder', size: [120, 20, 120] }), 1);
  assert.equal(resolveAxis({ form: 'tube', size: [50, 50, 1000] }), 2);
  assert.equal(resolveAxis({ form: 'tube', size: [50, 20, 1000] }), 2);
  assert.equal(resolveAxis({ form: 'tube', size: [1000, 50, 20] }), 0);
  assert.equal(resolveAxis({ form: 'prism', size: [1, 2, 3] }), 2);
  assert.equal(resolveAxis({ form: 'revolve', size: [1, 2, 3] }), 1);
  assert.equal(resolveAxis({ form: 'prism', axis: 'x', size: [1, 2, 3] }), 0);

  // cilindro macizo y hueco
  const pin = part({ form: 'cylinder', axis: 'x', size: [80, 12, 12] });
  near(partVolume(pin), Math.PI * 36 * 80, 1e-6);
  const pipe = part({ form: 'cylinder', size: [100, 200, 100], wall: 5 });
  near(partVolume(pipe), Math.PI * (2500 - 45 * 45) * 200, 1e-6);
  const sp = solidSpec(pipe)!;
  assert.equal(sp.kind, 'extrude');
  if (sp.kind === 'extrude') { assert.equal(sp.axis, 1); assert.equal(sp.holes.length, 1); assert.equal(sp.outer.length, 48); near(sp.sc, 200); }

  // tubo 50x50x3 de 1000: sección 50² - 44² = 564 mm²
  const tube = part({ form: 'tube', size: [50, 1000, 50], axis: 'y', wall: 3 });
  near(partVolume(tube), 564 * 1000);
  assert.equal(describeSolid(tube), 'tubo 50×50×3, largo 1000');
  const rounded = part({ form: 'tube', size: [50, 1000, 50], axis: 'y', wall: 3, cornerRadius: 6 });
  near(partVolume(rounded), (2500 - (4 - Math.PI) * 36 - (1936 - (4 - Math.PI) * 9)) * 1000, 1e-6);
  const ts = solidSpec(rounded)!;
  if (ts.kind === 'extrude') { assert.equal(ts.outer.length, 4 * 7); assert.equal(ts.holes[0].length, 4 * 7); }
  const flat = part({ form: 'tube', size: [100, 3000, 50], axis: 'y', wall: 2 }); // 100x50x2
  near(partVolume(flat), (5000 - 96 * 46) * 3000);

  // cuña de pilar: de 400 a 270 en 1800, fondo 400
  const wedge = part({ form: 'prism', axis: 'z', size: [400, 1800, 400], profile: [[0, 0], [400, 0], [270, 1800], [0, 1800]] });
  near(partVolume(wedge), ((400 + 270) / 2) * 1800 * 400);
  // ángulo L 40x40x3 de 1000
  const ang = part({ form: 'prism', axis: 'z', size: [40, 40, 1000], profile: [[0, 0], [40, 0], [40, 3], [3, 3], [3, 40], [0, 40]] });
  near(partVolume(ang), (40 * 3 + 37 * 3) * 1000);
  // prisma con el perfil dado en sentido horario: se normaliza a antihorario sin cambiar nada
  const cw = part({ ...ang, profile: [...ang.profile!].reverse() });
  near(partVolume(cw), partVolume(ang));
  const s2 = solidSpec(cw)!;
  if (s2.kind === 'extrude') assert.ok(s2.outer.reduce((a, p, i) => a + (p[0] * s2.outer[(i + 1) % s2.outer.length][1] - s2.outer[(i + 1) % s2.outer.length][0] * p[1]), 0) > 0);
  // eje x: el perfil está en (Y, Z)
  const ax = part({ form: 'prism', axis: 'x', size: [500, 40, 40], profile: [[0, 0], [40, 0], [0, 40]] });
  assert.equal(validatePart(ax), null);
  near(partVolume(ax), 800 * 500);

  // revolución: rectángulo = cilindro; con ranura en V pierde volumen
  const disc = part({ form: 'revolve', axis: 'y', size: [120, 20, 120], profile: [[0, 0], [60, 0], [60, 20], [0, 20]] });
  near(partVolume(disc), Math.PI * 3600 * 20, 1e-6);
  const wheel = part({ form: 'revolve', axis: 'y', size: [120, 20, 120], profile: [[0, 0], [60, 0], [60, 8], [52, 10], [60, 12], [60, 20], [0, 20]] });
  assert.equal(validatePart(wheel), null);
  assert.ok(partVolume(wheel) < partVolume(disc));
  near(partVolume(wheel), partVolume(disc) - 2 * Math.PI * (/* ranura triangular: área 16 mm² con el centroide en r = 57.33 */ 16 * (172 / 3)), 1e-3);
});

test('lista de sólidos: agrupa, da volumen y no se mezcla con las cajas', () => {
  const t = (id: string) => part({ id, name: `Poste ${id}`, material: 'acero', form: 'tube', size: [50, 1000, 50], axis: 'y', wall: 3 });
  const rows = solidsList([t('a'), t('b'), part({ id: 'c' })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 2);
  assert.equal(rows[0].description, 'tubo 50×50×3, largo 1000');
  assert.deepEqual(rows[0].box, [1000, 50, 50]);
  near(rows[0].volumeCm3, 564);
  near(rows[0].totalCm3, 1128);
});

// ---------------------------------------------------------------- retrocompatibilidad y despiece

function legacyProject(): Project {
  const p = defaultProject();
  p.materials.push({ id: 'vidrio', name: 'Vidrio', thickness: 6, sheetW: 1, sheetH: 1, color: '#9fd3f0', grain: false, purchased: true });
  addCabinet(p, { name: 'Base 1', width: 800, height: 720, depth: 560, doors: 2, shelves: 1 });
  addCabinet(p, { name: 'Alto 1', width: 600, height: 1800, depth: 350, x: 900, drawers: 2, edging: true });
  p.parts.push({ id: 'p99', name: 'Vidrio', size: [500, 400, 6], position: [0, 800, 0], material: 'vidrio' });
  return p;
}

test('retrocompatibilidad: un proyecto sin campos nuevos no cambia al normalizarse ni al guardarse', () => {
  const p = legacyProject();
  const before = JSON.stringify(p);
  for (const part of p.parts) normalizePart(part);
  assert.equal(JSON.stringify(p), before);
  assert.equal(JSON.stringify(JSON.parse(before)), before);
  for (const part of p.parts) assert.equal(validatePart(part), null, part.name);
  for (const part of p.parts) assert.ok(!('form' in part) && !('rotX' in part));
  // sin giro, los límites son los de siempre
  for (const part of p.parts) assert.deepEqual(partBounds(part), { min: part.position, max: part.position.map((v, i) => v + part.size[i]), size: part.size });
});

test('despiece, presupuesto, tapacanto y herrajes: los sólidos y los giros no cambian los resultados de las cajas', () => {
  const base = legacyProject();
  applyAutoEdges(base);
  const want = { cuts: cutList(base), budget: budget(base) };

  const mixed = structuredClone(base);
  mixed.materials.push({ id: 'acero', name: 'Acero', thickness: 3, sheetW: 6000, sheetH: 50, color: '#888888', grain: false, price: 99999 });
  mixed.parts.push(
    { id: 's1', name: 'Puerta tubo', size: [50, 1000, 50], position: [0, 0, 0], material: 'acero', form: 'tube', wall: 3, axis: 'y', edges: { largo: 2, ancho: 2 } },
    { id: 's2', name: 'Rueda', size: [120, 20, 120], position: [0, 0, 0], material: 'mel18', form: 'revolve', axis: 'y', profile: [[0, 0], [60, 0], [60, 20], [0, 20]] },
    { id: 's3', name: 'Cuña', size: [400, 1800, 400], position: [0, 0, 0], material: 'mel18', form: 'prism', profile: [[0, 0], [400, 0], [270, 1800], [0, 1800]] },
  );
  // una caja girada sigue siendo una pieza de plancha con las mismas medidas de corte
  mixed.parts[0].rotZ = 30;
  applyAutoEdges(mixed);
  const solidIds = new Set(['s1', 's2', 's3']);
  const rebase = structuredClone(base);
  rebase.parts[0].rotZ = 30;
  assert.deepEqual(cutList(mixed), cutList(rebase));
  assert.deepEqual(nest(mixed).sheets.map((s) => s.placements.map((pl) => [pl.partId, pl.x, pl.y, pl.w, pl.h])), nest(rebase).sheets.map((s) => s.placements.map((pl) => [pl.partId, pl.x, pl.y, pl.w, pl.h])));
  assert.deepEqual(nest(mixed).unplaced, []);
  assert.deepEqual(budget(mixed), budget(rebase));
  assert.deepEqual(hardwareCounts(mixed), hardwareCounts(rebase));
  assert.equal(edgeMeters(mixed.parts.find((p) => p.id === 's1')!), 0);
  assert.ok(!nest(mixed).sheets.some((s) => s.placements.some((pl) => solidIds.has(pl.partId))));
  assert.ok(!cutList(mixed).some((r) => r.names.some((n) => ['Puerta tubo', 'Rueda', 'Cuña'].includes(n))));
  // el CSV de cajas es el mismo; los sólidos van en una tabla aparte al final
  const csv = piecesCsv(mixed, nest(mixed));
  assert.equal(csv.split('\r\n\r\n')[0], piecesCsv(rebase, nest(rebase)));
  assert.ok(csv.includes('Perfiles y sólidos'));
  assert.match(csv, /tubo 50×50×3, largo 1000/);
  // la base sin tocar sigue igual que al principio
  assert.deepEqual(cutList(base), want.cuts);
  assert.deepEqual(budget(base), want.budget);
});

test('colisiones: una pieza girada que invade la puerta se detecta con su caja envolvente', () => {
  const p = defaultProject();
  p.room = { width: 3000, depth: 2000, height: 2400, openings: [{ wall: 'back', a: 1000, b: 1900, y: 0, h: 2000, kind: 'door' }] };
  // viga de 1500 mm a lo largo de Z, al lado de la puerta (zona de barrido: x 1000–1900, z 0–800)
  p.parts.push({ id: 'v', name: 'Viga', size: [100, 20, 1500], position: [1950, 500, 0], material: 'mel18', group: 'Viga' });
  assert.deepEqual(openingConflicts(p), []);
  p.parts[0].rotY = 90; // gira alrededor de su centro (2000, 510, 750): ahora se extiende en X de 1250 a 2750
  assert.equal(openingConflicts(p).length, 1);
});

test('demostración docs/ejemplos/formas.json: pilar con cara inclinada y rueda con ranura en V', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const demo = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', 'docs', 'ejemplos', 'formas.json'), 'utf8')) as Project;
  for (const p of demo.parts) assert.equal(validatePart(p), null, p.name);
  const pilar = demo.parts.find((p) => p.name.startsWith('Pilar'))!;
  near(partVolume(pilar), ((400 + 270) / 2) * 1800 * 400);
  const rueda = demo.parts.find((p) => p.name.startsWith('Rueda'))!;
  assert.ok(partVolume(rueda) < Math.PI * 60 * 60 * 20, 'la ranura en V quita material');
  // los sólidos de la demostración no entran al despiece; la caja girada (tablón) sí
  assert.deepEqual(nest(demo).sheets.flatMap((s) => s.placements.map((pl) => pl.name)), ['Tablón girado 12,5°']);
  assert.equal(solidsList(demo.parts).reduce((n, r) => n + r.qty, 0), 7);
  // normalizar no cambia nada (el archivo ya está en forma canónica)
  const copy = structuredClone(demo);
  for (const p of copy.parts) normalizePart(p);
  assert.deepEqual(copy, demo);
});
