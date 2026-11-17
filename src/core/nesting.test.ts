import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProject } from './types';
import { buildCabinet } from './furniture';
import { nest, cutList, type Placement } from './nesting';
import { applyAutoEdges, edgeMeters } from './edges';
import { outline, polygonArea } from './shapes';
import { applyAutoHardware, budget } from './budget';

const overlap = (a: Placement, b: Placement) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('un gabinete con 2 entrepaños entra en una plancha y no se solapa', () => {
  const p = defaultProject();
  p.parts = buildCabinet(p, { width: 800, height: 1800, depth: 400, shelves: 2, backMaterial: 'mdf3' });
  const r = nest(p);
  assert.equal(r.unplaced.length, 0);
  assert.equal(r.warnings.length, 0);
  for (const s of r.sheets) {
    for (const [i, a] of s.placements.entries()) {
      assert.ok(a.x + a.w <= s.material.sheetW && a.y + a.h <= s.material.sheetH);
      for (const b of s.placements.slice(i + 1)) assert.ok(!overlap(a, b), `${a.name} solapa con ${b.name}`);
    }
  }
});

test('los cortes son de lado a lado y ninguno atraviesa una pieza', () => {
  const p = defaultProject();
  p.parts = [];
  for (let i = 0; i < 4; i++) p.parts.push(...buildCabinet(p, { name: `M${i}`, width: 900, height: 2000, depth: 500, shelves: 3, backMaterial: 'mdf3', doorMaterial: 'frente' }));
  const r = nest(p);
  assert.ok(r.sheets.length > 1);
  for (const s of r.sheets) {
    assert.ok(s.cuts.length > 0);
    s.cuts.forEach((c, i) => assert.equal(c.n, i + 1));
    for (const c of s.cuts) {
      for (const pl of s.placements) {
        const crosses = c.orientation === 'h'
          ? c.pos > pl.y && c.pos < pl.y + pl.h && c.from < pl.x + pl.w && c.to > pl.x
          : c.pos > pl.x && c.pos < pl.x + pl.w && c.from < pl.y + pl.h && c.to > pl.y;
        assert.ok(!crosses, `corte ${c.n} atraviesa ${pl.name}`);
      }
    }
  }
});

test('lista de cortes agrupa piezas iguales', () => {
  const p = defaultProject();
  p.parts = buildCabinet(p, { width: 800, height: 1800, depth: 400 });
  assert.ok(cutList(p).find((r) => r.qty === 2 && r.length === 1800));
});

test('pieza más grande que la plancha queda sin ubicar', () => {
  const p = defaultProject();
  p.parts = [{ id: 'x', name: 'gigante', size: [3000, 18, 500], position: [0, 0, 0], material: 'mel18' }];
  assert.equal(nest(p).unplaced.length, 1);
});

test('tapacanto: puerta 4 cantos, entrepaño solo el frente, fondo ninguno', () => {
  const p = defaultProject();
  p.parts = buildCabinet(p, { width: 800, height: 1000, depth: 400, shelves: 1, backMaterial: 'mdf3', doorMaterial: 'frente' });
  const by = (s: string) => p.parts.find((x) => x.name.includes(s))!;
  assert.deepEqual(by('puerta 1').edges, { largo: 2, ancho: 2 });
  assert.deepEqual(by('entrepaño').edges, { largo: 1, ancho: 0 });
  assert.deepEqual(by('fondo').edges, { largo: 0, ancho: 0 });
  assert.deepEqual(by('lateral izq').edges, { largo: 1, ancho: 0 });
  assert.ok(edgeMeters(by('puerta 1')) > 2);
  assert.ok(applyAutoEdges(p) === p.parts.length);
});

test('cajones: frente con manija y corredera, interior sin tapacanto', () => {
  const p = defaultProject();
  p.parts = buildCabinet(p, { name: 'Caj', width: 600, height: 700, depth: 500, drawers: 3, backMaterial: 'mdf3', doorMaterial: 'frente' });
  assert.equal(p.parts.filter((x) => x.name.includes('frente')).length, 3);
  assert.equal(p.parts.filter((x) => x.name.includes('puerta')).length, 0);
  assert.equal(nest(p).warnings.length, 0);
  const hw = applyAutoHardware(p);
  assert.equal(hw.find((h) => h.rule === 'slide')!.qty, 3);
  assert.equal(hw.find((h) => h.rule === 'handle')!.qty, 3);
});

test('formas: muesca en L, esquinas redondeadas y huecos', () => {
  const size: [number, number, number] = [1000, 18, 600];
  assert.equal(polygonArea(outline(size).outer), 600000);
  assert.equal(polygonArea(outline(size, { notch: { w: 300, h: 200, corner: 2 } }).outer), 600000 - 60000);
  for (const corner of [0, 1, 2, 3] as const) {
    assert.equal(polygonArea(outline(size, { notch: { w: 300, h: 200, corner } }).outer), 540000, `esquina ${corner}`);
  }
  const rounded = polygonArea(outline(size, { radius: 50 }).outer);
  assert.ok(rounded < 600000 && rounded > 600000 - 4 * 50 * 50 * 0.3, `área redondeada ${rounded}`);
  assert.equal(outline(size, { holes: [{ x: 100, y: 100, w: 200, h: 100 }] }).holes.length, 1);
});

test('presupuesto suma planchas, tapacanto y herrajes', () => {
  const p = defaultProject();
  p.materials[0].price = 100;
  p.edgePrice = 2;
  p.parts = buildCabinet(p, { width: 800, height: 1000, depth: 400, shelves: 1, doorMaterial: 'frente' });
  p.materials[1].price = 120;
  applyAutoHardware(p);
  p.hardware!.find((h) => h.rule === 'hinge')!.price = 3;
  const b = budget(p);
  const sheets = b.lines.filter((l) => l.unit === 'plancha');
  assert.ok(sheets.length >= 2);
  assert.ok(b.lines.some((l) => l.label === 'Tapacanto' && l.total > 0));
  assert.equal(b.total, Math.round(b.lines.reduce((s, l) => s + l.total, 0) * 100) / 100);
  const hinges = b.lines.find((l) => l.label === 'Bisagra')!;
  assert.equal(hinges.total, hinges.qty * 3);
});

