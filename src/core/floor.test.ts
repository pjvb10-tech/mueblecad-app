import test from 'node:test';
import assert from 'node:assert/strict';
import { isTextureName, roomFloorRects, rectsArea } from './floor';
import type { FloorPlan } from './types';

test('nombres de textura: solo archivos de imagen sin rutas', () => {
  assert.ok(isTextureName('ceramica-travertino.png'));
  assert.ok(isTextureName('a_b.1.JPG'));
  for (const n of ['../x.png', 'a/b.png', 'a\b.png', 'x.gif', 'x.png.exe', '.png', 'a..b.png', '', 'x'.repeat(90) + '.png', 5]) assert.equal(isTextureName(n), false, String(n));
});

test('piso en L: sigue el hueco real y no la caja', () => {
  // cuarto 0..2000 x 0..1000 con un tabique que entra desde el oeste y cierra un rincón
  const w = (x0: number, z0: number, x1: number, z1: number) => ({ kind: 'MI' as const, x0, z0, x1, z1 });
  const plan = {
    name: 't', lines: [],
    walls: [w(-100, -100, 2100, 0), w(-100, 1000, 2100, 1100), w(-100, 0, 0, 1000), w(2000, 0, 2100, 1000), w(0, 400, 500, 500)],
    rooms: [{ id: 'H1', name: '', x0: 0, z0: 0, x1: 2000, z1: 1000, cx: 1000, cz: 250, area: 0 }],
  } as FloorPlan;
  const rects = roomFloorRects(plan, 'H1');
  assert.ok(rects.length >= 2);
  assert.ok(Math.abs(rectsArea(rects) - (2 * 1 - 0.5 * 0.1)) < 0.001);
});
