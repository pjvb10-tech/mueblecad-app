import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf, clampSize, composeSheet, cutListLines, exportSize, fitRect, gridFor, imagePdf, jpegInfo, jpegToPdfImage, MAX_SIDE, placedToSvg, placeShapes, shapesBounds, sheetLayout, shapesToPdfOps, STD_VIEWS, titleBlockRows, type Shape } from './viewSheet';
import { drawingShapes, planShapes } from './viewShapes';
import { addCabinet } from './furniture';
import { defaultProject } from './types';
import { createDrawing } from './drawing';
import { validateView, validateViews, withView, withoutView, nextViewId, findView } from './savedViews';
import type { SavedView } from './types';

/** JPEG mínimo: SOI + SOF0 (w × h, n componentes) + EOI. No se decodifica; basta para la cabecera y para incrustarlo. */
function fakeJpeg(w: number, h: number, n = 3): Uint8Array {
  const sof = [0xff, 0xc0, 0, 8 + 3 * n, 8, h >> 8, h & 255, w >> 8, w & 255, n];
  for (let i = 0; i < n; i++) sof.push(i + 1, 0x11, 0);
  return new Uint8Array([0xff, 0xd8, ...sof, 0xff, 0xd9]);
}
const text = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

test('clampSize y exportSize: multiplicadores, tamaño a medida y topes', () => {
  assert.deepEqual(exportSize({ w: 1000, h: 500 }, { mult: 2 }), { w: 2000, h: 1000, clamped: false });
  assert.deepEqual(exportSize({ w: 1000, h: 500 }, { custom: { w: 3000 } }), { w: 3000, h: 1500, clamped: false });
  assert.deepEqual(exportSize({ w: 1000, h: 500 }, { custom: { h: 100 } }), { w: 200, h: 100, clamped: false });
  const big = clampSize(20000, 10000);
  assert.equal(big.w, MAX_SIDE);
  assert.equal(big.h, MAX_SIDE / 2);
  assert.ok(big.clamped);
  const px = clampSize(8000, 8000); // 64 Mpx > tope de píxeles
  assert.ok(px.w * px.h <= 50_000_000 && px.clamped);
  assert.throws(() => clampSize(0, 10), /mayores que 0/);
  assert.throws(() => exportSize({ w: 10, h: 10 }, { mult: -1 }), /multiplicador/);
});

test('vistas estándar: direcciones de cámara', () => {
  assert.deepEqual(STD_VIEWS.front.dir, [0, 0, 1]);
  assert.equal(STD_VIEWS.persp.ortho, false);
  assert.equal(STD_VIEWS.iso.ortho, true);
  assert.ok(STD_VIEWS.top.dir[1] > 0 && Math.abs(STD_VIEWS.top.dir[2]) < 0.001);
});

test('cajetín: filas y escala', () => {
  const rows = titleBlockRows({ titulo: 'Mesa', autor: 'Ana', fecha: '2026-01-02' }, '1:20');
  assert.deepEqual(rows.map((r) => r[0]), ['Título', 'Autor', 'Fecha', 'Hoja']);
  assert.equal(rows[0][1], 'Mesa');
  assert.match(rows[2][1], /2026-01-02.*Escala 1:20/);
  assert.match(titleBlockRows({ titulo: 'x', fecha: 'f', escala: '1:5', hoja: '2/3' }, '1:20')[2][1], /Escala 1:5/);
  assert.equal(titleBlockRows({ titulo: 'x', fecha: 'f', hoja: '2/3' }, 'a')[3][1], '2/3');
});

test('sheetLayout: papel, orientación, cajetín y celdas sin solaparse', () => {
  const l = sheetLayout({ paper: 'A3', titleBlock: true, count: 4 });
  assert.deepEqual(l.paper, { w: 420, h: 297 });
  assert.equal(l.cells.length, 4);
  assert.ok(l.tb && l.tb.y > l.area.y + l.area.h - 1); // el cajetín queda bajo el área de vistas
  for (const c of l.cells) { assert.ok(c.x >= l.area.x - 1e-9 && c.x + c.w <= l.area.x + l.area.w + 1e-9 && c.y + c.h <= l.area.y + l.area.h + 1e-9); }
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const a = l.cells[i], b = l.cells[j];
    assert.ok(a.x + a.w <= b.x + 1e-9 || b.x + b.w <= a.x + 1e-9 || a.y + a.h <= b.y + 1e-9 || b.y + b.h <= a.y + 1e-9, `celdas ${i} y ${j} se solapan`);
  }
  const v = sheetLayout({ paper: 'A4', orientation: 'portrait', count: 2 });
  assert.deepEqual(v.paper, { w: 210, h: 297 });
  assert.equal(v.cells[0].w, v.cells[1].w);
  assert.ok(v.cells[1].y > v.cells[0].y); // en vertical, dos filas
  assert.deepEqual(gridFor(3, true), { cols: 2, rows: 2 });
  assert.throws(() => sheetLayout({ count: 5 }), /1 a 4/);
  assert.throws(() => sheetLayout({ paper: 'B7', count: 1 }), /no existe/);
});

test('fitRect y placeShapes: ajuste centrado y escala normalizada', () => {
  const r = fitRect(200, 100, { x: 0, y: 0, w: 100, h: 100 });
  assert.deepEqual(r, { x: 0, y: 25, w: 100, h: 50 });
  const shapes: Shape[] = [{ t: 'rect', x: 0, y: 0, w: 1000, h: 500, stroke: '#000000', sw: 0.2 }];
  const p = placeShapes(shapes, { x: 10, y: 10, w: 100, h: 60 }, 'fit');
  assert.equal(p.scale, 1 / 10); // cabe a 0.12 -> la normalizada 1:10
  assert.equal(p.label, '1:10');
  const rect = p.shapes[0] as Extract<Shape, { t: 'rect' }>;
  assert.equal(rect.w, 100);
  assert.equal(rect.x, 10); // centrada: ocupa todo el ancho
  assert.equal(rect.y, 10 + (60 - 50) / 2);
  assert.equal(placeShapes(shapes, { x: 0, y: 0, w: 100, h: 60 }, 0.05).label, '1:20');
  assert.ok(Math.abs(placeShapes(shapes, { x: 0, y: 0, w: 200, h: 40 }, 'exact').scale - 0.08) < 1e-9);
  assert.throws(() => placeShapes(shapes, { x: 0, y: 0, w: 1, h: 1 }, 0), /mayor que 0/);
});

test('jpegInfo: cabecera, gris y errores', () => {
  assert.deepEqual(jpegInfo(fakeJpeg(640, 480)), { w: 640, h: 480, colors: 3 });
  assert.deepEqual(jpegInfo(fakeJpeg(7, 9, 1)), { w: 7, h: 9, colors: 1 });
  assert.throws(() => jpegInfo(new Uint8Array([1, 2, 3, 4, 5])), /No es un JPEG/);
  assert.throws(() => jpegInfo(fakeJpeg(8, 8, 4)), /componentes/);
});

/** Comprueba la tabla xref: cada desplazamiento apunta al "N 0 obj" correspondiente. */
function checkXref(pdf: Uint8Array): number {
  const s = text(pdf);
  const start = Number(/startxref\n(\d+)\n%%EOF/.exec(s)![1]);
  assert.ok(s.startsWith('%PDF-1.4'));
  assert.ok(s.slice(start).startsWith('xref\n'));
  const m = /xref\n0 (\d+)\n/.exec(s.slice(start))!;
  const n = Number(m[1]);
  const lines = s.slice(start + m[0].length).split('\n').slice(0, n);
  assert.equal(lines[0], '0000000000 65535 f ');
  for (let i = 1; i < n; i++) {
    const off = Number(lines[i].slice(0, 10));
    assert.ok(s.slice(off).startsWith(`${i} 0 obj`), `objeto ${i} fuera de su desplazamiento`);
  }
  return n;
}

test('buildPdf: imagen JPEG incrustada (DCTDecode), xref válida y bytes intactos', () => {
  const jpg = fakeJpeg(320, 200);
  const pdf = buildPdf([{ w: 297, h: 210, ops: ['q 100 0 0 100 10 10 cm /Im0 Do Q'], images: [jpegToPdfImage(jpg)] }], { title: 'Prueba ñ' });
  checkXref(pdf);
  const s = text(pdf);
  assert.match(s, /\/Subtype \/Image \/Width 320 \/Height 200 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/DCTDecode \/Length 23/);
  assert.match(s, /\/XObject << \/Im0 \d+ 0 R >>/);
  assert.match(s, /\/MediaBox \[0 0 841\.89 595\.276\]/);
  // los bytes del JPEG van sin cambios
  assert.ok(Buffer.from(pdf).includes(Buffer.from(jpg)));
  assert.throws(() => buildPdf([]), /al menos una página/);
});

test('buildPdf: Flate con predictor PNG y máscara alfa (SMask)', () => {
  const pdf = buildPdf([{ w: 100, h: 100, ops: [], images: [{ w: 4, h: 4, colors: 3, filter: 'Flate', predictor: 15, data: new Uint8Array([1, 2, 3]), alpha: new Uint8Array([4, 5]) }] }]);
  checkXref(pdf);
  const s = text(pdf);
  assert.match(s, /\/FilterFlateDecode|\/Filter \/FlateDecode \/DecodeParms << \/Predictor 15 \/Colors 3 \/BitsPerComponent 8 \/Columns 4 >> \/SMask \d+ 0 R/);
  assert.match(s, /\/ColorSpace \/DeviceGray/);
});

test('composeSheet: una página con 4 vistas (3 vectoriales + 1 imagen), cajetín y escalas', () => {
  const p = defaultProject();
  addCabinet(p, { width: 800, height: 720, depth: 500, name: 'Base' } as never);
  const fr = planShapes(p, 'front'), top = planShapes(p, 'top'), side = planShapes(p, 'side');
  assert.ok(fr.length > 5 && top.length > 5 && side.length > 5);
  const r = composeSheet({
    paper: 'A3', title: 'Lámina', titleBlock: { titulo: 'Base 800', autor: 'Yo', fecha: '2026-05-01' },
    cells: [
      { title: '3D iso', content: { kind: 'image', image: jpegToPdfImage(fakeJpeg(600, 400)) } },
      { title: 'Frente', content: { kind: 'shapes', shapes: fr } },
      { title: 'Planta', content: { kind: 'shapes', shapes: top } },
      { title: 'Lado', content: { kind: 'shapes', shapes: side } },
    ],
  });
  assert.equal(r.pages, 1);
  assert.equal(r.scales[0], null);
  assert.ok(r.scales.slice(1).every((s) => /^1:\d+/.test(s!)));
  const s = text(r.pdf);
  checkXref(r.pdf);
  assert.ok(s.includes('/DCTDecode') && s.includes('/Im0 Do'));
  assert.ok(s.includes('(Base 800)') && s.includes('(Yo)'));
  assert.match(s, /\(Frente {3}Esc\. 1:\d+\)/);
});

test('composeSheet: la lista de piezas añade páginas', () => {
  const lines = Array.from({ length: 150 }, (_, i) => `Fila ${i}`);
  const r = composeSheet({ paper: 'A4', title: 't', cells: [{ title: 'a', content: { kind: 'shapes', shapes: [{ t: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#000000' }] } }], notes: { title: 'Lista de piezas', lines } });
  assert.ok(r.pages >= 2);
  const s = text(r.pdf);
  assert.match(s, /\/Count \d+/);
  assert.ok(s.includes('(Fila 0)') && s.includes('(Fila 149)'));
  assert.ok(s.includes('Lista de piezas \\(1/'));
  checkXref(r.pdf);
});

test('imagePdf: la orientación sigue a la imagen', () => {
  assert.deepEqual(imagePdf(jpegToPdfImage(fakeJpeg(100, 300)), { title: 'x', paper: 'A4' }).layout.paper, { w: 210, h: 297 });
  assert.deepEqual(imagePdf(jpegToPdfImage(fakeJpeg(300, 100)), { title: 'x', paper: 'A4' }).layout.paper, { w: 297, h: 210 });
});

test('formas -> SVG y operadores PDF', () => {
  const sh: Shape[] = [
    { t: 'line', x1: 0, y1: 0, x2: 10, y2: 0, stroke: '#ff0000', sw: 0.3, dash: [3, 1] },
    { t: 'rect', x: 1, y: 1, w: 5, h: 5, fill: '#00ff00', fillOpacity: 0.5, stroke: '#000000' },
    { t: 'text', x: 5, y: 5, size: 3, s: 'Ñandú <&>', anchor: 'middle', color: '#000000', rot: -90 },
  ];
  const svg = placedToSvg(sh, 100, 50, { bg: '#ffffff', px: { w: 400, h: 200 } });
  assert.match(svg, /^<svg [^>]*width="400" height="200" viewBox="0 0 100 50"/);
  assert.ok(svg.includes('stroke-dasharray="3 1"') && svg.includes('Ñandú &lt;&amp;&gt;') && svg.includes('rotate(-90)') && svg.includes('<rect width="100" height="50" fill="#ffffff" />'));
  assert.equal(placedToSvg(sh, 100, 50).includes('mm"'), true);
  const ops = shapesToPdfOps(sh, 50).join('\n');
  assert.ok(ops.includes(' m ') && ops.includes(' l S') && ops.includes(' re B') && ops.includes('BT') && ops.includes('Tj'));
  assert.ok(shapesBounds(sh)!.x1 >= 10);
  assert.equal(shapesBounds([]), null);
});

test('planShapes: tres vistas con cotas y piezas; sin piezas no hay formas', () => {
  const p = defaultProject();
  assert.deepEqual(planShapes(p, 'front'), []);
  addCabinet(p, { width: 800, height: 720, depth: 500, name: 'Base' } as never);
  const fr = planShapes(p, 'front');
  assert.ok(fr.some((s) => s.t === 'text' && s.s === '800')); // cota general del ancho
  assert.ok(fr.some((s) => s.t === 'text' && s.s === '720' && s.rot === -90)); // cota del alto
  const b = shapesBounds(fr)!;
  assert.ok(b.x1 - b.x0 >= 800 && b.y1 - b.y0 >= 720);
  // la planta usa el fondo (500) como alto
  const t = shapesBounds(planShapes(p, 'top'))!;
  assert.ok(t.y1 - t.y0 >= 500 && t.y1 - t.y0 < 800);
});

test('drawingShapes: líneas, arcos, círculos, texto y capas apagadas', () => {
  const d = createDrawing('Mesa');
  d.layers.push({ name: 'oculta', color: 1, linetype: 'continuous', on: false, frozen: false, locked: false });
  d.entities.push(
    { id: 'e1', type: 'line', layer: '0', a: [0, 0], b: [100, 0] },
    { id: 'e2', type: 'circle', layer: '0', c: [50, 50], r: 20 },
    { id: 'e3', type: 'text', layer: '0', p: [0, 10], h: 5, s: 'Hola' },
    { id: 'e4', type: 'line', layer: 'oculta', a: [0, 0], b: [1, 1] },
    { id: 'e5', type: 'poly', layer: '0', closed: false, pts: [{ p: [0, 0], bulge: 1 }, { p: [10, 0] }] },
  );
  const sh = drawingShapes(d);
  assert.equal(sh.filter((s) => s.t === 'line').length, 1); // la de la capa apagada no sale
  assert.equal(sh.filter((s) => s.t === 'text').length, 1);
  const circ = sh.find((s) => s.t === 'poly' && s.closed) as Extract<Shape, { t: 'poly' }>;
  assert.ok(circ.pts.length >= 60 && circ.pts.every((p) => Math.abs(Math.hypot(p[0] - 50, p[1] + 50) - 20) < 1e-6)); // y invertida
  const arc = sh.find((s) => s.t === 'poly' && !s.closed) as Extract<Shape, { t: 'poly' }>;
  assert.ok(arc.pts.length > 10); // el bulge 1 es una semicircunferencia, aproximada por tramos
  assert.equal((sh[0] as Extract<Shape, { t: 'line' }>).stroke, '#000000'); // el 7 (blanco) va negro en papel
});

test('cutListLines: encabezado y filas', () => {
  const l = cutListLines([{ qty: 2, length: 720, width: 560, thickness: 18, material: 'm1', names: ['Lateral', 'Lateral'] }], () => 'Melamina');
  assert.equal(l.length, 2);
  assert.match(l[1], /2 ×.*720 × 560 × 18.*Melamina.*Lateral/);
});

test('vistas guardadas: validar, agregar, reemplazar, borrar y ida y vuelta JSON', () => {
  let p = defaultProject();
  assert.equal(validateViews(p), null);
  assert.equal(nextViewId(p), 'v1');
  const v3: SavedView = { id: 'v1', name: 'Isométrica', kind: '3d', camera: { position: [2000, 1500, 2000], target: [400, 300, 200], ortho: true }, hiddenLayers: ['Puertas'] };
  const v2: SavedView = { id: 'v2', name: 'Planta', kind: '2d', drawing: 'd1', view: { cx: 100, cy: 50, scale: 0.4 } };
  p = withView(withView(p, v3), v2);
  assert.equal(nextViewId(p), 'v3');
  assert.equal(validateViews(p), null);
  assert.equal(findView(p, 'isométrica')?.id, 'v1');
  p = withView(p, { ...v3, name: 'Iso 2' });
  assert.equal(p.views!.length, 2);
  assert.equal(p.views![0].name, 'Iso 2');
  const rt = JSON.parse(JSON.stringify(p));
  assert.deepEqual(rt.views, p.views);
  assert.equal(validateViews(rt), null);
  p = withoutView(withoutView(p, 'v1'), 'v2');
  assert.equal(p.views, undefined);
  assert.throws(() => withoutView(p, 'v9'), /No existe la vista/);
});

test('vistas guardadas: validación con mensajes accionables', () => {
  const bad = (v: unknown): string | null => validateView(v as SavedView);
  assert.match(bad({ id: 'a', name: '', kind: '3d' })!, /falta el nombre/);
  assert.match(bad({ id: 'a', name: 'x', kind: '3d', camera: { position: [0, 0, 0], target: [0, 0, 0] } })!, /mismo punto/);
  assert.match(bad({ id: 'a', name: 'x', kind: '3d', camera: { position: [0, 'a', 0], target: [1, 0, 0] } })!, /position y target/);
  assert.match(bad({ id: 'a', name: 'x', kind: '2d', drawing: 'd1', view: { cx: 0, cy: 0, scale: 0 } })!, /scale/);
  assert.match(bad({ id: 'a', name: 'x', kind: 'raro' })!, /kind/);
  assert.match(validateViews({ views: [{ id: 'a', name: 'x', kind: '2d', drawing: 'd', view: { cx: 0, cy: 0, scale: 1 } }, { id: 'a', name: 'y', kind: '2d', drawing: 'd', view: { cx: 0, cy: 0, scale: 1 } }] })!, /dos vistas/);
  assert.match(validateViews({ views: 5 as never })!, /lista/);
});

test('sheetSvg: fondo, imagen JPEG incrustada y formas', async () => {
  const { buildSheet, sheetSvg } = await import('./viewSheet');
  const b = buildSheet({ title: 't', titleBlock: { titulo: 'T', fecha: 'f' }, cells: [{ title: 'Foto', content: { kind: 'image', image: jpegToPdfImage(fakeJpeg(40, 20)) } }, { title: 'Plano', content: { kind: 'shapes', shapes: [{ t: 'rect', x: 0, y: 0, w: 100, h: 50, stroke: '#000000' }] } }] });
  const svg = sheetSvg(b, { bg: '#ffffff', px: { w: 1000, h: 700 } });
  assert.match(svg, /<svg [^>]*width="1000" height="700"/);
  assert.ok(svg.indexOf('fill="#ffffff"') < svg.indexOf('<image '));
  assert.ok(svg.includes('href="data:image/jpeg;base64,/9j/'));
  assert.ok(svg.includes('Plano   Esc. 1:'));
});
