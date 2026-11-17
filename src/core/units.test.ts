import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMm, fmtMm, gridLayout, gridStepFor, measureText, parseMoveStep, pickSnapPoint, snapRangeMm, stepRound, type SnapCandidate } from './units';

test('cleanMm quita ruido de coma flotante pero conserva micras', () => {
  assert.equal(cleanMm(12.0000001), 12);
  assert.equal(cleanMm(0.1 + 0.2), 0.3);
  assert.equal(cleanMm(12.3456), 12.346);
  assert.equal(cleanMm(-0.0000001), 0);
});

test('fmtMm: sin ruido, coma decimal y mínimo de decimales', () => {
  assert.equal(fmtMm(12.0000001), '12');
  assert.equal(fmtMm(12.5), '12,5');
  assert.equal(fmtMm(12.256), '12,26');
  assert.equal(fmtMm(12, 1), '12,0');
  assert.equal(fmtMm(12.25, 1), '12,25');
  assert.equal(fmtMm(-0.0004), '0');
  assert.equal(fmtMm(-3.04, 1), '-3,04');
  assert.equal(fmtMm(1234.5678, 0, 3), '1234,568');
  assert.equal(fmtMm(NaN), '–');
});

test('stepRound: pasos y modo libre', () => {
  assert.equal(stepRound(12.37, 1), 12);
  assert.equal(stepRound(12.37, 0.1), 12.4);
  assert.equal(stepRound(137, 50), 150);
  assert.equal(stepRound(-137, 50), -150);
  assert.equal(stepRound(12.3456, 0), 12.346); // libre: no redondea al paso, solo limpia
  assert.equal(stepRound(0.3, 0.1), 0.3);
});

test('parseMoveStep acepta solo pasos válidos', () => {
  assert.equal(parseMoveStep('0'), 0);
  assert.equal(parseMoveStep('0.1'), 0.1);
  assert.equal(parseMoveStep('50'), 50);
  assert.equal(parseMoveStep('7'), 1);
  assert.equal(parseMoveStep(null), 1);
  assert.equal(parseMoveStep(''), 1);
});

test('snapRangeMm se acota y crece con la distancia', () => {
  assert.equal(snapRangeMm(0.01), 1);
  assert.equal(snapRangeMm(2, 10), 20);
  assert.equal(snapRangeMm(100), 60);
});

test('pickSnapPoint: vértice sobre punto medio y límite de alcance', () => {
  const c: SnapCandidate[] = [
    { p: [100, 0, 0], kind: 'vertice' },
    { p: [96, 0, 0], kind: 'medio' },
    { p: [97, 5, 0], kind: 'arista' },
  ];
  assert.deepEqual(pickSnapPoint(c, [97, 0, 0], 10)?.kind, 'vertice'); // 3 mm del vértice, 1 del medio: gana el vértice
  assert.equal(pickSnapPoint(c, [300, 0, 0], 10), null);
  assert.deepEqual(pickSnapPoint([{ p: [0, 0, 0], kind: 'centro' }, { p: [20, 0, 0], kind: 'vertice' }], [1, 0, 0], 30)?.kind, 'centro'); // el vértice está mucho más lejos
});

test('measureText: total y componentes con 1 decimal', () => {
  const t = measureText([0, 0, 0], [3, 4, 0]);
  assert.equal(t.total, '5,0 mm');
  assert.equal(t.detail, 'ΔX 3,0 · ΔY 4,0 · ΔZ 0,0');
  const u = measureText([10.25, 0, 0], [0, 100.04, -5]);
  assert.equal(u.detail, 'ΔX 10,25 · ΔY 100,04 · ΔZ 5,0');
  assert.match(u.copy, /^\d+,\d+ mm \(ΔX 10,25, ΔY 100,04, ΔZ 5,0\)$/);
});

test('cuadrícula: el paso sigue al zoom y nunca pasa de ~500 líneas', () => {
  assert.equal(gridStepFor(0.05), 1);
  assert.equal(gridStepFor(1), 50); // 14 px mínimo -> 50 mm
  assert.equal(gridStepFor(5), 100);
  assert.equal(gridStepFor(100000), 1000);
  for (const step of [1, 5, 10, 50, 100, 200, 1000]) {
    for (const extent of [2000, 12000, 80000]) {
      const g = gridLayout(extent, step);
      assert.ok((g.divisions + 1) * 2 <= 500, `step ${step} extent ${extent}: ${g.divisions}`);
    }
  }
  assert.equal(gridLayout(12000, 200).windowed, false);
  assert.equal(gridLayout(12000, 1).windowed, true);
});
