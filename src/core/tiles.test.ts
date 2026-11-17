import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTiles, layoutPieces, packBest, resolveTileSpec, roomTileRegions, verifyPacking } from './tiles';
import { projectWithRoom, testCatalog } from './testPlan';

const rect = (u1: number, y1: number) => [{ u0: 0, u1, y0: 0, y1 }];

test('losas: piso que cabe exacto en piezas enteras no tiene recortes', () => {
  // 3 × 2 piezas de 600 con junta 0
  const e = estimateTiles([{ name: 'piso', rects: rect(1800, 1200), ou: 0, ov: 0 }], { w: 600, h: 600, junta: 0 });
  assert.equal(e.enteras, 6); assert.equal(e.recortes, 0); assert.equal(e.total, 6);
  assert.equal(e.perdidaPct, 0); assert.equal(e.areaM2, 2.16);
});

test('losas: los recortes se aprovechan entre sí (sobrante de una pieza sirve para la siguiente)', () => {
  // 2400 × 600 con piezas de 600×600: 4 enteras
  const justo = estimateTiles([{ name: 'a', rects: rect(2400, 600), ou: 0, ov: 0 }], { w: 600, h: 600, junta: 0 });
  assert.equal(justo.total, 4);
  // 2100 × 600 = 3 enteras + 1 recorte de 300 de ancho: 4 losas
  const e = estimateTiles([{ name: 'a', rects: rect(2100, 600), ou: 0, ov: 0 }], { w: 600, h: 600, junta: 0 });
  assert.equal(e.enteras, 3); assert.equal(e.recortes, 1); assert.equal(e.total, 4);
  // dos regiones con un recorte de 300 cada una caben en UNA losa (300 + 300 con kerf 0)
  const dos = estimateTiles([
    { name: 'a', rects: rect(900, 600), ou: 0, ov: 0 },
    { name: 'b', rects: rect(900, 600), ou: 0, ov: 0 },
  ], { w: 600, h: 600, junta: 0, kerf: 0 });
  assert.equal(dos.enteras, 2); assert.equal(dos.recortes, 2); assert.equal(dos.losasParaRecortes, 1); assert.equal(dos.total, 3);
  assert.equal(dos.perdidaPct, 0); // 300 + 300 llenan la losa justo
  const holgado = estimateTiles([{ name: "a", rects: rect(900, 500), ou: 0, ov: 0 }], { w: 600, h: 600, junta: 0 });
  assert.ok(holgado.perdidaPct > 30 && holgado.perdidaPct < 60, String(holgado.perdidaPct));
});

test('losas: junta, trabado y reserva', () => {
  const base = { name: 'p', rects: rect(3000, 2000), ou: 0, ov: 0 };
  const recto = estimateTiles([base], { w: 600, h: 600, junta: 3 });
  const trabado = estimateTiles([base], { w: 600, h: 600, junta: 3, patron: 'trabado' });
  assert.ok(trabado.total >= recto.total);
  assert.ok(recto.total >= recto.minimoTeorico);
  const res = estimateTiles([base], { w: 600, h: 600, junta: 3, reservaPct: 10 });
  assert.equal(res.totalConReserva, Math.ceil(res.total * 1.1 - 1e-9));
});

test('losas: optimizar nunca usa más losas que el desfase cero', () => {
  const regions = [{ name: 'p', rects: [{ u0: 0, u1: 3700, y0: 0, y1: 2900 }], ou: 0, ov: 0 }];
  const normal = estimateTiles(regions, { w: 604, h: 906, junta: 3 });
  const opt = estimateTiles(regions, { w: 604, h: 906, junta: 3, optimizar: true });
  assert.ok(opt.total <= normal.total, `${opt.total} <= ${normal.total}`);
});

test('losas: error claro si el recorte no cabe o la pieza es inválida', () => {
  assert.throws(() => estimateTiles([], { w: 10, h: 600, junta: 0 }), /al menos 20/);
});

test('empaquetado: verificación independiente detecta piezas pegadas', () => {
  const pk = packBest([{ w: 298, h: 600, a: 1, rect: true }, { w: 298, h: 600, a: 1, rect: true }], 600, 600, 3, false)!;
  const sinHolgura = packBest([{ w: 300, h: 600, a: 1, rect: true }, { w: 300, h: 600, a: 1, rect: true }], 600, 600, 3, false)!;
  assert.equal(sinHolgura.n, 2); // 300 + kerf + 300 no cabe en 600
  assert.equal(pk.n, 1);
  assert.ok(verifyPacking(pk.slabs, 600, 600, 3, 2));
  pk.slabs[0].placed[1].x = pk.slabs[0].placed[0].x + 299; // solo 1 mm de separación
  assert.throws(() => verifyPacking(pk.slabs, 600, 600, 3, 2), /kerf/);
});

test('layoutPieces: cuenta enteras y recortes de una región en L', () => {
  const L = layoutPieces([{ u0: 0, u1: 1200, y0: 0, y1: 600 }, { u0: 0, u1: 600, y0: 600, y1: 1200 }], 600, 600, 0, 0, 0, 50);
  assert.equal(L.full, 3); assert.equal(L.parts.length, 0); assert.equal(L.cover, 3 * 600 * 600);
});

test('habitación: regiones de piso y muros descuentan la puerta; la estimación es coherente con el área', () => {
  const p = projectWithRoom();
  const cat = testCatalog();
  const floor = roomTileRegions(p.plan!, 'H1', { surface: 'floor' });
  assert.equal(floor.length, 1);
  const f = estimateTiles(floor, { w: 600, h: 600, junta: 0 });
  assert.ok(Math.abs(f.areaM2 - 2) < 0.01);
  assert.equal(f.total, 7); // 3 enteras + recortes (3 de 600×400, 200×600 y 200×400) que no caben juntos en menos de 4 losas
  const walls = roomTileRegions(p.plan!, 'H1', { surface: 'walls', altura: 1200 });
  assert.equal(walls.length, 4);
  const w = estimateTiles(walls, { w: 600, h: 600, junta: 0 });
  // perímetro interior 6000 × 1200 menos la puerta (900 × 1200)
  assert.ok(Math.abs(w.areaM2 - (6 * 1.2 - 0.9 * 1.2)) < 0.01, String(w.areaM2));
  const norte = roomTileRegions(p.plan!, 'H1', { surface: 'walls', altura: 1200, lados: ['norte'] });
  assert.equal(norte.length, 1);
  const both = roomTileRegions(p.plan!, 'H1', { surface: 'both', altura: 1200 });
  assert.equal(both.length, 5);
  assert.throws(() => roomTileRegions(p.plan!, 'H9', { surface: 'floor' }), /No existe/);
  // la especificación sale de la textura o del acabado asignado
  const spec = resolveTileSpec(cat, 'trav', undefined, 'floor', { junta: 5 });
  assert.equal(spec.junta, 5); assert.equal(spec.w, 600);
  assert.throws(() => resolveTileSpec(cat, undefined, undefined, 'floor', {}), /Indica una textura/);
  assert.throws(() => resolveTileSpec(cat, 'zzz', undefined, 'floor', {}), /no está en la biblioteca/);
  assert.equal(resolveTileSpec(cat, undefined, { floor: { tex: 'blanco' } }, 'floor', {}).w, 300);
});
