import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, addLayer, createDrawing, setLayer } from './drawing';
import { drawingToPdf, pdfLayout, scaleLabel } from './pdfDrawing';
import type { Drawing } from './types';

const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

/** Comprobación estructural mínima de un PDF: cabecera, offsets de xref, /Length de los streams, trailer. */
function checkPdf(bytes: Uint8Array): { text: string; objects: number; content: string } {
  const text = latin1(bytes);
  assert.ok(text.startsWith('%PDF-1.4\n'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const start = Number(/startxref\n(\d+)\n%%EOF/.exec(text)![1]);
  assert.equal(text.slice(start, start + 4), 'xref');
  const m = /xref\n0 (\d+)\n([\s\S]*?)trailer\n<< \/Size (\d+) \/Root (\d+) 0 R/.exec(text.slice(start))!;
  const n = Number(m[1]);
  assert.equal(Number(m[3]), n);
  const entries = m[2].split('\n').filter(Boolean);
  assert.equal(entries.length, n);
  assert.match(entries[0], /^0000000000 65535 f $/);
  entries.slice(1).forEach((e, i) => {
    assert.match(e, /^\d{10} 00000 n $/);
    assert.equal(e.length, 19 + 1 - 1); // 20 bytes con el salto
    const off = Number(e.slice(0, 10));
    assert.ok(text.startsWith(`${i + 1} 0 obj\n`, off), `objeto ${i + 1} en ${off}`);
    assert.ok(text.indexOf('endobj', off) > off);
  });
  const sm = /<< \/Length (\d+) >>\nstream\n/.exec(text)!;
  const body = text.slice(sm.index + sm[0].length);
  const len = Number(sm[1]);
  assert.equal(body.slice(len, len + '\nendstream'.length), '\nendstream');
  return { text, objects: n - 1, content: body.slice(0, len) };
}

function sample(): Drawing {
  let d = createDrawing('Planta baja', { sheet: { w: 420, h: 297, scale: 0.02 } });
  d = addLayer(d, { name: 'Muros', color: 1, lineweight: 0.5 });
  d = addLayer(d, { name: 'Ejes', color: '#0000ff', linetype: 'center' });
  d = addLayer(d, { name: 'Oculta', color: 3 });
  d = addEntities(d, [
    { type: 'rect', p1: [0, 0], p2: [4000, 3000], layer: 'Muros' },
    { type: 'poly', pts: [[0, 0], { p: [1000, 0], bulge: 1 }, [1000, 500]], layer: 'Muros' },
    { type: 'circle', c: [2000, 1500], r: 300, layer: 'Ejes' },
    { type: 'arc', c: [500, 500], r: 200, a0: 0, a1: 270, layer: 'Muros' },
    { type: 'line', a: [0, 1500], b: [4000, 1500], layer: 'Ejes' },
    { type: 'text', p: [200, 200], h: 100, s: 'Dormitorio (3) \\ ñ Ø5 °', layer: 'Muros' },
    { type: 'text', p: [2000, 2500], h: 100, s: 'Centrado', align: 'center', rot: 15, layer: 'Muros' },
    { type: 'dim', kind: 'linear', p1: [0, 0], p2: [4000, 0], at: [0, -400], layer: 'Muros' },
    { type: 'line', a: [9000, 9000], b: [9500, 9500], layer: 'Oculta' },
  ]).drawing;
  return setLayer(d, 'Oculta', { on: false });
}

test('PDF: estructura válida, xref con offsets correctos y A3 horizontal', () => {
  const bytes = drawingToPdf(sample(), { paper: 'A3' });
  assert.ok(bytes instanceof Uint8Array);
  const { text, objects } = checkPdf(bytes);
  assert.equal(objects, 6);
  assert.match(text, /\/MediaBox \[0 0 1190\.551 841\.89\]/);
  assert.match(text, /\/BaseFont \/Helvetica/);
});

test('PDF: contiene el texto, escapa paréntesis y barras, y codifica WinAnsi', () => {
  const { content } = checkPdf(drawingToPdf(sample(), { paper: 'A4', orientation: 'portrait' }));
  assert.ok(content.includes('(Dormitorio \\(3\\) \\\\ \xf1 \xd85 \xb0) Tj'), 'texto escapado y en WinAnsi');
  assert.ok(content.includes('(Centrado) Tj'));
  assert.ok(content.includes('(4000) Tj'), 'texto de la cota');
});

test('PDF: trazos con color y grosor por capa; el blanco/7 va negro; capas apagadas no se dibujan', () => {
  const { content } = checkPdf(drawingToPdf(sample(), { paper: 'A3' }));
  assert.ok(content.includes('1 0 0 RG 1.417 w [] 0 d'), 'Muros: rojo, 0.5 mm');
  assert.ok(content.includes('0 0 1 RG'), 'Ejes azul');
  assert.ok(/RG [\d.]+ w \[[\d. ]+\] 0 d/.test(content), 'linea de ejes discontinua');
  assert.ok(!content.includes('0 1 0 RG'), 'capa oculta no sale');
  assert.ok(content.includes(' c\n'), 'arcos como Bézier');
  const mono = latin1(drawingToPdf(sample(), { colors: 'mono' }));
  assert.ok(!mono.includes('1 0 0 RG') && !mono.includes('0 0 1 RG'));
  // color 7 -> negro
  const d = addEntities(createDrawing('x'), [{ type: 'line', a: [0, 0], b: [10, 0] }]).drawing;
  assert.ok(latin1(drawingToPdf(d)).includes('0 0 0 RG'));
});

test('PDF: escala fija, fit normalizado y cajetín con escala y fecha', () => {
  const d = sample();
  const l = pdfLayout(d, { paper: 'A3' }); // usa sheet.scale = 0.02
  assert.equal(l.scale, 0.02);
  assert.equal(l.scaleLabel, '1:50');
  const fit = pdfLayout(d, { paper: 'A4', scale: 'fit' });
  assert.ok(STD(fit.scale), `escala normalizada ${fit.scale}`);
  const exact = pdfLayout(d, { paper: 'A4', scale: 'fit', exactFit: true });
  assert.ok(exact.scale >= fit.scale);
  const tb = { titulo: 'Casa Pérez', autor: 'Equipo', fecha: '2026-05-01', hoja: '2/5' };
  const { content } = checkPdf(drawingToPdf(d, { paper: 'A3', scale: 0.02, titleBlock: tb }));
  assert.ok(content.includes('(Casa P\xe9rez) Tj'));
  assert.ok(content.includes('(2026-05-01   Escala 1:50) Tj'));
  assert.ok(content.includes('(2/5) Tj') && content.includes('(Equipo) Tj'));
  assert.equal(scaleLabel(0.02), '1:50');
  assert.equal(scaleLabel(2), '2:1');
  assert.equal(pdfLayout(d, { scale: 0.1, paper: 'A3', titleBlock: { ...tb, escala: '1:10' } }).scaleLabel, '1:10');
});

test('PDF: papel a medida, errores claros y dibujo vacío', () => {
  const { text } = checkPdf(drawingToPdf(createDrawing('vacío'), { paper: { w: 100, h: 50 } }));
  assert.match(text, /\/MediaBox \[0 0 283\.465 141\.732\]/);
  assert.throws(() => drawingToPdf(createDrawing('x'), { paper: 'A9' as never }), /A9/);
  assert.throws(() => drawingToPdf(createDrawing('x'), { scale: -1 }), /scale/);
  assert.throws(() => drawingToPdf(createDrawing('x'), { margin: 500 }), /margen/);
});

function STD(s: number): boolean { return [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 750, 1000, 1500, 2000, 5000, 10000].some((n) => Math.abs(1 / s - n) < 1e-6 || Math.abs(s - 1 / n) < 1e-9); }
