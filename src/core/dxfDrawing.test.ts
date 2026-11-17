import test from 'node:test';
import assert from 'node:assert/strict';
import DxfParser from 'dxf-parser';
import { addEntities, addLayer, createDrawing, setLayer } from './drawing';
import { cleanDxfText, drawingsToDxfFiles, drawingToDxf, dxfToDrawing } from './dxfDrawing';
import { dimGeometry } from './geom2d';
import type { Drawing, Entity, PolyEntity } from './types';

/** DXF a mano: lista plana de pares código/valor. */
const dxfOf = (parts: (string | number)[][], header: (string | number)[] = []): string => {
  const flat = (xs: (string | number)[][]) => xs.flat().map(String);
  return [
    '0', 'SECTION', '2', 'HEADER', ...header.map(String), '0', 'ENDSEC',
    ...parts.flat().map(String), '0', 'EOF',
  ].join('\n');
};
const sec = (name: string, body: (string | number)[]): (string | number)[][] => [[0, 'SECTION', 2, name, ...body, 0, 'ENDSEC']];

function sample(): Drawing {
  let d = createDrawing('Planta', { id: 'd1', plane: 'xz' });
  d = addLayer(d, { name: 'Muros', color: 1, linetype: 'continuous', lineweight: 0.5 });
  d = addLayer(d, { name: 'Ejes', color: '#ff8800', linetype: 'center' });
  d = addLayer(d, { name: 'Cotas', color: 3, linetype: 'dashed' });
  d = addLayer(d, { name: 'Oculta', color: 5 });
  d = addEntities(d, [
    { type: 'line', a: [0, 0], b: [4000, 0], layer: 'Muros' },
    { type: 'poly', pts: [[0, 0], { p: [1000, 0], bulge: 0.4142135623730951 }, [1000, 500], [0, 500]], closed: true, layer: 'Muros', color: '#336699' },
    { type: 'poly', pts: [[0, 600], [100.123456, 650.5], { p: [200, 700], bulge: -0.5 }, [300, 700]], layer: 'Ejes' },
    { type: 'circle', c: [500.5, 250.25], r: 75, layer: 'Muros', color: 2 },
    { type: 'arc', c: [1500, 0], r: 300, a0: 30, a1: 210, layer: 'Muros' },
    { type: 'arc', c: [1500, 0], r: 200, a0: 300, a1: 40, layer: 'Muros' },
    { type: 'text', p: [100, 100], h: 80, s: 'Dormitorio Ø5 ± 3°', layer: 'Muros' },
    { type: 'text', p: [2000, 100], h: 50, s: 'Cocina ñandú', rot: 30, align: 'center', layer: 'Ejes' },
    { type: 'dim', kind: 'linear', p1: [0, 0], p2: [4000, 0], at: [0, -300], layer: 'Cotas' },
    { type: 'line', a: [9, 9], b: [19, 19], layer: 'Oculta' },
  ]).drawing;
  d = setLayer(d, 'Cotas', { locked: true });
  d = setLayer(d, 'Oculta', { on: false, frozen: true });
  return d;
}

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('DXF exportado: estructura R2000, handles únicos y dxf-parser lo lee sin errores', () => {
  const d = sample();
  const text = drawingToDxf(d);
  assert.ok(text.includes('AC1015'));
  assert.ok(text.includes('\r\n'));
  for (const s of ['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS', 'LTYPE', 'LAYER', 'STYLE', 'EOF']) assert.ok(text.includes(`\r\n${s}\r\n`) || text.includes(`${s}\r\n`), s);
  const lines = text.split('\r\n');
  const handles: string[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) if (lines[i] === '5') handles.push(lines[i + 1]);
  assert.equal(new Set(handles).size, handles.length, 'handles únicos');
  const seed = parseInt(lines[lines.indexOf('$HANDSEED') + 2], 16);
  for (const h of handles) assert.ok(parseInt(h, 16) <= seed);
  const parsed = new DxfParser().parseSync(text)!;
  const count = (t: string) => parsed.entities.filter((e) => e.type === t).length;
  const geo = dimGeometry(d.entities.find((e) => e.type === 'dim') as never);
  assert.equal(count('LINE'), 2 + geo.lines.length);
  assert.equal(count('LWPOLYLINE'), 2);
  assert.equal(count('CIRCLE'), 1);
  assert.equal(count('ARC'), 2);
  assert.equal(count('TEXT'), 2 + geo.texts.length);
  const layers = (parsed.tables as { layer: { layers: Record<string, { frozen?: boolean; visible?: boolean; colorIndex?: number }> } }).layer.layers;
  assert.deepEqual(Object.keys(layers).sort(), ['0', 'Cotas', 'Ejes', 'Muros', 'Oculta']);
  assert.equal(layers.Oculta.frozen, true);
  assert.equal(layers.Oculta.visible, false);
  assert.equal(layers.Muros.colorIndex, 1);
});

test('DXF: LF opcional, ASCII con códigos %%c %%d %%p y acentos normalizados', () => {
  const text = drawingToDxf(sample(), { eol: '\n' });
  assert.ok(!text.includes('\r'));
  assert.ok(text.includes('Dormitorio %%c5 %%p 3%%d'));
  assert.ok(text.includes('Cocina nandu'));
  assert.ok(/^[\x00-\x7f]*$/.test(text));
});

test('DXF: ida y vuelta conserva geometría (1e-6), capas, colores y textos', () => {
  const d = sample();
  const { drawing: r, warnings, stats } = dxfToDrawing(drawingToDxf(d), { name: 'Planta' });
  assert.equal(stats.omitted['HATCH'], undefined);
  assert.deepEqual(warnings.filter((w) => !/unidades/i.test(w)), []);
  const lines = (x: Drawing) => x.entities.filter((e) => e.type === 'line');
  const geo = dimGeometry(d.entities.find((e) => e.type === 'dim') as never);
  assert.equal(lines(r).length, 2 + geo.lines.length);
  const polys = r.entities.filter((e): e is PolyEntity => e.type === 'poly');
  assert.equal(polys.length, 2);
  const [p0, p1] = [d.entities[1] as PolyEntity, d.entities[2] as PolyEntity];
  assert.equal(polys[0].closed, true);
  assert.equal(polys[1].closed, undefined);
  for (const [a, b] of [[p0, polys[0]], [p1, polys[1]]] as [PolyEntity, PolyEntity][]) {
    assert.equal(a.pts.length, b.pts.length);
    a.pts.forEach((v, i) => { near(v.p[0], b.pts[i].p[0]); near(v.p[1], b.pts[i].p[1]); near(v.bulge ?? 0, b.pts[i].bulge ?? 0); });
  }
  const circle = r.entities.find((e) => e.type === 'circle')!;
  assert.deepEqual([(circle as { c: number[] }).c, (circle as { r: number }).r], [[500.5, 250.25], 75]);
  assert.equal(circle.color, 2);
  const arcs = r.entities.filter((e) => e.type === 'arc') as unknown as { c: number[]; r: number; a0: number; a1: number }[];
  assert.equal(arcs.length, 2);
  near(arcs[0].a0, 30); near(arcs[0].a1, 210); near(arcs[1].a0, 300); near(arcs[1].a1, 40); near(arcs[1].r, 200);
  const texts = r.entities.filter((e) => e.type === 'text') as unknown as { s: string; rot?: number; align?: string; p: number[]; h: number }[];
  assert.equal(texts[0].s, 'Dormitorio Ø5 ± 3°');
  assert.equal(texts[1].s, 'Cocina nandu');
  assert.equal(texts[1].align, 'center');
  near(texts[1].rot!, 30); near(texts[1].p[0], 2000); near(texts[1].h, 50);
  assert.equal(r.entities.find((e) => e.type === 'poly' && e.color === '#336699') !== undefined, true);
  // capas
  const byName = (n: string) => r.layers.find((l) => l.name === n)!;
  assert.equal(byName('Cotas').locked, true);
  assert.equal(byName('Cotas').linetype, 'dashed');
  assert.equal(byName('Ejes').linetype, 'center');
  assert.equal(byName('Ejes').color, '#ff8800');
  assert.equal(byName('Muros').lineweight, 0.5);
  assert.equal(byName('Oculta').frozen, true);
  assert.equal(byName('Oculta').on, false);
  assert.equal(r.entities.every((e) => r.layers.some((l) => l.name === e.layer)), true);
});

test('DXF: varios dibujos con capas prefijadas, o un archivo por dibujo', () => {
  const a = sample();
  const b = createDrawing('Alzado', { id: 'd2' });
  const b2 = addEntities(b, [{ type: 'line', a: [0, 0], b: [10, 0] }]).drawing;
  const text = drawingToDxf([a, b2]);
  const layers = Object.keys((new DxfParser().parseSync(text)!.tables as { layer: { layers: object } }).layer.layers);
  assert.ok(layers.includes('Planta-Muros') && layers.includes('Alzado-0') && layers.includes('0'));
  const files = drawingsToDxfFiles([a, b2]);
  assert.deepEqual(files.map((f) => f.name), ['Planta.dxf', 'Alzado.dxf']);
  assert.ok(Object.keys((new DxfParser().parseSync(files[0].text)!.tables as { layer: { layers: object } }).layer.layers).includes('Muros'));
});

test('DXF: dibujo vacío y nombres de capa con caracteres inválidos', () => {
  let d = createDrawing('x');
  d = addLayer(d, { name: 'A/B:C' });
  const t = drawingToDxf(d);
  assert.ok(new DxfParser().parseSync(t));
  assert.ok(t.includes('A_B_C'));
});

test('DXF estilo AutoCAD: INSERT escalado y rotado, anidado, ByBlock, unidades en cm', () => {
  const text = dxfOf([
    ...sec('TABLES', [
      0, 'TABLE', 2, 'LAYER', 70, 3,
      0, 'LAYER', 2, 'Muros', 70, 0, 62, 1, 6, 'CONTINUOUS',
      0, 'LAYER', 2, 'Marcas', 70, 4, 62, 5, 420, 0xff8800, 6, 'HIDDEN', 370, 50,
      0, 'LAYER', 2, 'Cotas', 70, 1, 62, -3, 6, 'CONTINUOUS',
      0, 'ENDTAB']),
    ...sec('BLOCKS', [
      0, 'BLOCK', 8, '0', 2, 'CAJA', 70, 0, 10, 10, 20, 10, 30, 0,
      0, 'LINE', 8, '0', 62, 0, 10, 10, 20, 10, 11, 20, 21, 10,
      0, 'CIRCLE', 8, '0', 10, 15, 20, 15, 40, 2,
      0, 'ARC', 8, 'Marcas', 10, 10, 20, 10, 40, 5, 50, 0, 51, 90,
      0, 'ENDBLK', 8, '0',
      0, 'BLOCK', 8, '0', 2, 'PAR', 70, 0, 10, 0, 20, 0, 30, 0,
      0, 'INSERT', 8, '0', 2, 'CAJA', 10, 0, 20, 0, 41, 1, 42, 1, 50, 0,
      0, 'INSERT', 8, '0', 2, 'CAJA', 10, 100, 20, 0, 41, 1, 42, 1, 50, 0,
      0, 'ENDBLK', 8, '0',
    ]),
    ...sec('ENTITIES', [
      0, 'INSERT', 8, 'Muros', 62, 3, 2, 'CAJA', 10, 100, 20, 200, 30, 0, 41, 2, 42, 2, 43, 2, 50, 90,
      0, 'INSERT', 8, 'Muros', 2, 'PAR', 10, 0, 20, 0, 30, 0, 41, 1, 42, 1, 50, 0, 70, 1, 71, 1,
      0, 'LINE', 8, 'Cotas', 10, 0, 20, 0, 11, 5, 21, 5,
      0, 'LINE', 8, 'Muros', 10, 0, 20, 0, 11, 0, 21, 0,
      0, 'LWPOLYLINE', 8, 'Muros', 90, 3, 70, 1, 10, 0, 20, 0, 42, 1, 10, 4, 20, 0, 10, 4, 20, 4, 420, 0x112233,
      0, 'POINT', 8, 'Muros', 10, 1, 20, 1,
      0, 'HATCH', 8, 'Muros', 10, 0, 20, 0, 30, 0, 2, 'SOLID',
      0, 'HATCH', 8, 'Muros', 10, 0, 20, 0, 30, 0, 2, 'ANSI31',
    ]),
  ], ['9', '$INSUNITS', '70', 5]);
  const { drawing: r, warnings, stats, units } = dxfToDrawing(text, { explodeBlocks: true });
  assert.equal(units.factor, 10);
  assert.equal(stats.omitted['HATCH'], 2);
  assert.ok(warnings.some((w) => /HATCH/.test(w)));
  const circles = r.entities.filter((e) => e.type === 'circle') as unknown as { c: number[]; r: number; layer: string; color?: number }[];
  // 1 insert escalado + 2 del par = 3 círculos; el primero: base (10,10), c (15,15) -> (5,5)*2 girado 90 -> (-10,10) + (100,200) => cm*10
  assert.equal(circles.length, 3);
  near(circles[0].c[0], (100 - 10) * 10); near(circles[0].c[1], (200 + 10) * 10); near(circles[0].r, 40);
  assert.equal(circles[0].layer, 'Muros');
  assert.equal(circles[0].color, undefined); // ByLayer en capa "0": hereda la capa del INSERT
  // la línea ByBlock del bloque toma el color 3 del INSERT
  const lines = r.entities.filter((e) => e.type === 'line') as unknown as { a: number[]; b: number[]; layer: string; color?: number }[];
  const first = lines[0];
  assert.equal(first.color, 3);
  near(first.a[0], 100 * 10); near(first.a[1], 200 * 10); near(first.b[0], (100 - 0) * 10); near(first.b[1], (200 + 20) * 10);
  // arcos del bloque, en capa Marcas, girados 90° y escalados x2
  const arcs = r.entities.filter((e) => e.type === 'arc') as unknown as { a0: number; a1: number; r: number; layer: string }[];
  assert.equal(arcs.length, 3);
  near(arcs[0].a0, 90); near(arcs[0].a1, 180); near(arcs[0].r, 100); assert.equal(arcs[0].layer, 'Marcas');
  const poly = r.entities.find((e) => e.type === 'poly')! as PolyEntity;
  assert.equal(poly.closed, true); assert.equal(poly.color, '#112233');
  assert.equal(poly.pts[0].bulge, 1);
  near(poly.pts[1].p[0], 40);
  // capas
  const L = (n: string) => r.layers.find((l) => l.name === n)!;
  assert.equal(L('Marcas').locked, true); assert.equal(L('Marcas').color, '#ff8800'); assert.equal(L('Marcas').linetype, 'dashed'); assert.equal(L('Marcas').lineweight, 0.5);
  assert.equal(L('Cotas').frozen, true); assert.equal(L('Cotas').on, false);
  assert.equal(r.layers[0].name, '0');
});

test('DXF: opciones para descartar capas congeladas y de cotas, y forzar unidades', () => {
  const text = dxfOf([
    ...sec('TABLES', [0, 'TABLE', 2, 'LAYER', 70, 3,
      0, 'LAYER', 2, 'Muros', 70, 0, 62, 7, 0, 'LAYER', 2, 'A-ANNO-DIMS', 70, 0, 62, 3, 0, 'LAYER', 2, 'Hielo', 70, 1, 62, 4, 0, 'ENDTAB']),
    ...sec('ENTITIES', [
      0, 'LINE', 8, 'Muros', 10, 0, 20, 0, 11, 10, 21, 0,
      0, 'LINE', 8, 'A-ANNO-DIMS', 10, 0, 20, 5, 11, 10, 21, 5,
      0, 'LINE', 8, 'Hielo', 10, 0, 20, 9, 11, 10, 21, 9,
      0, 'DIMENSION', 8, 'Muros', 2, '*D1', 70, 0, 10, 0, 20, 3, 13, 0, 23, 0, 14, 10, 24, 0, 50, 0,
    ])]);
  const all = dxfToDrawing(text);
  assert.equal(all.drawing.entities.length, 4); // 3 líneas + cota simple
  assert.ok(all.drawing.entities.some((e) => e.type === 'dim'));
  assert.ok(all.warnings.some((w) => /unidades/i.test(w)));
  const cut = dxfToDrawing(text, { dropDimensions: true, dropFrozen: true, units: 'm' });
  assert.equal(cut.drawing.entities.length, 1);
  assert.equal(cut.units.factor, 1000);
  const ln = cut.drawing.entities[0] as unknown as { b: number[] };
  assert.equal(ln.b[0], 10000);
  assert.deepEqual(cut.drawing.layers.map((l) => l.name), ['0', 'Muros']);
});

test('DXF: cota con bloque anónimo se importa como geometría suelta', () => {
  const text = dxfOf([
    ...sec('BLOCKS', [0, 'BLOCK', 8, '0', 2, '*D1', 70, 1, 10, 0, 20, 0, 30, 0,
      0, 'LINE', 8, '0', 10, 0, 20, 3, 11, 10, 21, 3,
      0, 'SOLID', 8, '0', 10, 0, 20, 3, 11, 1, 21, 3.2, 12, 0, 22, 3, 13, 1, 23, 2.8,
      0, 'MTEXT', 8, '0', 10, 5, 20, 3.5, 40, 0.5, 71, 5, 1, '{\\fArial|b0;10}', 0, 'ENDBLK', 8, '0']),
    ...sec('ENTITIES', [0, 'DIMENSION', 8, 'Cotas', 2, '*D1', 70, 0, 10, 0, 20, 3, 13, 0, 23, 0, 14, 10, 24, 0])]);
  const r = dxfToDrawing(text, { units: 'mm' });
  assert.equal(r.drawing.entities.filter((e) => e.type === 'dim').length, 0);
  assert.equal(r.drawing.entities.filter((e) => e.type === 'line').length, 1);
  assert.equal(r.drawing.entities.filter((e) => e.type === 'poly').length, 1);
  const t = r.drawing.entities.find((e) => e.type === 'text') as unknown as { s: string; layer: string; align: string };
  assert.equal(t.s, '10'); assert.equal(t.layer, 'Cotas'); assert.equal(t.align, 'center');
  assert.ok(r.warnings.some((w) => /cotas/i.test(w)));
});

test('DXF: ELLIPSE y SPLINE se aproximan con aviso; elipse circular pasa a círculo', () => {
  const text = dxfOf([
    ...sec('ENTITIES', [
      0, 'ELLIPSE', 8, '0', 10, 0, 20, 0, 30, 0, 11, 10, 21, 0, 31, 0, 40, 0.5, 41, 0, 42, Math.PI * 2,
      0, 'ELLIPSE', 8, '0', 10, 50, 20, 0, 30, 0, 11, 5, 21, 0, 31, 0, 40, 1, 41, 0, 42, Math.PI * 2,
      0, 'SPLINE', 8, '0', 70, 8, 71, 3, 72, 8, 73, 4, 74, 0,
      40, 0, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 40, 1,
      10, 0, 20, 0, 30, 0, 10, 10, 20, 20, 30, 0, 10, 20, 20, 20, 30, 0, 10, 30, 20, 0, 30, 0,
    ])], ['9', '$INSUNITS', '70', 4]);
  const r = dxfToDrawing(text, { tolerance: 0.01 });
  const polys = r.drawing.entities.filter((e) => e.type === 'poly') as PolyEntity[];
  assert.equal(polys.length, 2);
  assert.equal(polys[0].closed, true);
  const xs = polys[0].pts.map((v) => v.p[0]), ys = polys[0].pts.map((v) => v.p[1]);
  near(Math.max(...xs), 10, 1e-6); near(Math.max(...ys), 5, 0.02);
  // elipse circular
  assert.equal(r.drawing.entities.filter((e) => e.type === 'circle').length, 1);
  // spline Bézier cúbica de 4 puntos de control: punto medio = (15, 15)
  const sp = polys[1];
  assert.deepEqual(sp.pts[0].p, [0, 0]); assert.deepEqual(sp.pts[sp.pts.length - 1].p, [30, 0]);
  assert.ok(sp.pts.some((v) => Math.abs(v.p[0] - 15) < 0.5 && Math.abs(v.p[1] - 15) < 0.1));
  assert.ok(r.warnings.some((w) => /elipses/i.test(w)) && r.warnings.some((w) => /splines/i.test(w)));
});

test('MTEXT: limpia códigos de formato y reparte líneas', () => {
  assert.deepEqual(cleanDxfText('{\\fArial|b1|i0|c0;Hola}\\Pmundo %%c20 %%d'), ['Hola', 'mundo Ø20 °']);
  assert.deepEqual(cleanDxfText('\\H2.5x;A\\~B\\S1/2;'), ['A B1/2']);
  const text = dxfOf(sec('ENTITIES', [0, 'MTEXT', 8, '0', 10, 100, 20, 200, 40, 10, 71, 1, 50, 0, 1, 'Uno\\PDos']));
  const r = dxfToDrawing(text, { units: 'mm' });
  const t = r.drawing.entities as unknown as { s: string; p: number[] }[];
  assert.deepEqual(t.map((x) => x.s), ['Uno', 'Dos']);
  near(t[0].p[1], 190); near(t[1].p[1], 176);
});

test('DXF grande: 100 000 entidades se importan rápido', () => {
  const body: (string | number)[] = [];
  for (let i = 0; i < 100000; i++) body.push(0, 'LINE', 8, i % 2 ? 'A' : 'B', 10, i, 20, 0, 11, i, 21, 10);
  const t0 = Date.now();
  const r = dxfToDrawing(dxfOf(sec('ENTITIES', body)), { units: 'mm' });
  assert.equal(r.drawing.entities.length, 100000);
  assert.equal(new Set(r.drawing.entities.map((e) => e.id)).size, 100000);
  assert.ok(Date.now() - t0 < 15000);
  const capped = dxfToDrawing(dxfOf(sec('ENTITIES', body.slice(0, 900))), { units: 'mm', maxEntities: 50 });
  assert.equal(capped.drawing.entities.length, 50);
  assert.ok(capped.warnings.some((w) => /tope/.test(w)));
});

test('DXF: .dwg y archivo vacío dan error claro; entidades degeneradas se omiten', () => {
  assert.throws(() => dxfToDrawing('AC1018\0\0'), /dwg/);
  assert.throws(() => dxfToDrawing(''), /DXF/);
  const r = dxfToDrawing(dxfOf(sec('ENTITIES', [0, 'LINE', 8, '0', 10, 1, 20, 1, 11, 1, 21, 1, 0, 'CIRCLE', 8, '0', 10, 0, 20, 0, 40, 0])), { units: 'mm' });
  assert.equal(r.drawing.entities.length, 0);
  assert.ok(r.warnings.some((w) => /degenerada/.test(w)));
  void ({} as Entity); void setLayer;
});
