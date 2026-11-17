import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProject } from './types';
import { addCabinet, rebuildCabinet } from './furniture';
import { edgeRoundLimit, validateCabinetOptions, validateEdgeRound } from './validate';

const base = { width: 1000, height: 2200, depth: 600 };

test('opciones de mueble: válidas, fuera de rango y combinaciones imposibles', () => {
  const p = defaultProject();
  p.materials.push({ id: 'tubo', name: 'Tubo', thickness: 25, sheetW: 1, sheetH: 1, color: '#999999', grain: false, purchased: true });
  assert.equal(validateCabinetOptions(p, { ...base, rods: [1700], rodMaterial: 'tubo', shelfAt: [300, 900] }), null);
  assert.match(validateCabinetOptions(p, { ...base, rods: [2300] })!, /rods.*fuera del mueble/);
  assert.match(validateCabinetOptions(p, { ...base, shelfAt: [-5] })!, /shelfAt/);
  assert.match(validateCabinetOptions(p, { ...base, rodMaterial: 'nada' })!, /Material desconocido/);
  assert.match(validateCabinetOptions(p, { ...base, faceBack: true, rebateBack: true })!, /faceBack/);
  assert.match(validateCabinetOptions(p, { ...base, kind: 'corner', wingB: 900, rods: [1000] })!, /solo existen en muebles rectos/);
  assert.match(validateCabinetOptions(p, { ...base, width: 0 })!, /width/);
  assert.match(validateCabinetOptions(p, { ...base, drawers: 1.5 })!, /drawers/);
});

test('barras, entrepaños a altura fija y frente espejado se generan y se regeneran', () => {
  const p = defaultProject();
  p.materials.push({ id: 'tubo', name: 'Tubo', thickness: 25, sheetW: 1, sheetH: 1, color: '#999999', grain: false, purchased: true });
  const parts = addCabinet(p, { ...base, name: 'Closet', rods: [1700], rodMaterial: 'tubo', shelfAt: [400, 900], backMaterial: 'mdf3', faceBack: true, y: 100 });
  assert.equal(parts.filter((q) => q.name.includes('barra de colgar')).length, 1);
  assert.equal(parts.filter((q) => q.name.includes('entrepaño')).length, 2);
  const rod = parts.find((q) => q.name.includes('barra'))!;
  assert.equal(rod.position[1], 1800); // y0 + 1700
  assert.equal(rod.material, 'tubo');
  // con el frente espejado, el fondo (mdf3) queda en el lado +Z
  const back = parts.find((q) => q.name.endsWith('fondo'))!;
  assert.ok(back.position[2] > 500);
  const again = rebuildCabinet(p, 'Closet', { rods: [], shelfAt: [600] })!;
  assert.equal(again.filter((q) => q.name.includes('barra')).length, 0);
  assert.equal(again.filter((q) => q.name.includes('entrepaño')).length, 1);
  assert.equal(p.cabinets!.Closet.faceBack, true);
});

test('canto redondeado: límite = mitad del espesor', () => {
  const part = { name: 'Tapa', size: [800, 18, 400] as [number, number, number] };
  assert.equal(edgeRoundLimit(part.size), 9);
  assert.equal(validateEdgeRound(part, 0, 9), null);
  assert.match(validateEdgeRound(part, 0, 10)!, /máximo.*9 mm/);
  assert.match(validateEdgeRound(part, 1, 5)!, /canto debe ser 0/);
  assert.match(validateEdgeRound(part, 2, 0)!, /mayor que 0/);
});
