import test from 'node:test';
import assert from 'node:assert/strict';
import { addEntities, addEntity, createDrawing, moveEntities, setLayer, updateEntity, validateDrawing, DrawingError } from './drawing';
import { drawingToDxf, dxfToDrawing } from './dxfDrawing';
import { drawingToPdf } from './pdfDrawing';
import { findBoundary, hatchContains, hatchGeometry, hatchPickDistance, insideEvenOdd, loopsFromEntities, syncHatches } from './hatch';
import { polyArea } from './geom2d';
import { pickAt } from './select2d';
import type { Drawing, HatchEntity, PolyVertex, Pt2 } from './types';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const rect = (x0: number, y0: number, x1: number, y1: number): PolyVertex[] => [{ p: [x0, y0] }, { p: [x1, y0] }, { p: [x1, y1] }, { p: [x0, y1] }];
const circleLoop = (cx: number, cy: number, r: number): PolyVertex[] => [{ p: [cx + r, cy], bulge: 1 }, { p: [cx - r, cy], bulge: 1 }];
const hatch = (over: Partial<HatchEntity> & Pick<HatchEntity, 'loops'>): HatchEntity => ({ id: 'h', layer: '0', type: 'hatch', pattern: 'lines', ...over });
const segLen = (s: [Pt2, Pt2]) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
const total = (segs: [Pt2, Pt2][]) => segs.reduce((a, s) => a + segLen(s), 0);

test('líneas horizontales en un cuadrado: una línea por separación y largo exacto', () => {
  const g = hatchGeometry(hatch({ loops: [rect(0, 0, 1000, 1000)], scale: 100 }));
  // filas y = 0, 100, ..., 900 (la 1000 queda fuera por el semiintervalo [ymin, ymax))
  assert.equal(g.segments.length, 10);
  for (const s of g.segments) near(segLen(s), 1000);
  assert.equal(g.dots.length, 0);
  assert.equal(g.capped, false);
});

test('cuadrado con hueco circular: las líneas se parten en el hueco (par-impar)', () => {
  const sq = rect(0, 0, 1000, 1000);
  const hole = circleLoop(500, 500, 200);
  const full = hatchGeometry(hatch({ loops: [sq], scale: 50 }));
  const holed = hatchGeometry(hatch({ loops: [sq, hole], scale: 50 }));
  assert.ok(holed.segments.length > full.segments.length, 'las filas que cruzan el hueco se parten en dos');
  // el largo recortado es el del cuadrado menos las cuerdas del círculo
  const chords = (() => { let t = 0; for (let k = 0; k < 20; k++) { const y = k * 50; const dy = y - 500; if (Math.abs(dy) < 200) t += 2 * Math.sqrt(200 * 200 - dy * dy); } return t; })();
  near(total(holed.segments), total(full.segments) - chords, 3);
  // ningún trazo entra al hueco
  for (const s of holed.segments) { const m: Pt2 = [(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2]; assert.ok(Math.hypot(m[0] - 500, m[1] - 500) >= 199.5, 'el punto medio cae fuera del círculo'); }
  assert.equal(hatchContains(hatch({ loops: [sq, hole] }), [500, 500]), false);
  assert.equal(hatchContains(hatch({ loops: [sq, hole] }), [100, 100]), true);
});

test('isla dentro de isla: alterna (par-impar)', () => {
  const h = hatch({ loops: [rect(0, 0, 1000, 1000), rect(100, 100, 900, 900), rect(300, 300, 700, 700)] });
  assert.equal(hatchContains(h, [50, 50]), true);
  assert.equal(hatchContains(h, [200, 200]), false);
  assert.equal(hatchContains(h, [500, 500]), true);
});

test('polilínea con bulge: el contorno se tesela y el patrón se recorta con él', () => {
  // semicírculo de radio 500 (cuerda abajo): área = π r² / 2
  const loop: PolyVertex[] = [{ p: [-500, 0], bulge: 1 }, { p: [500, 0] }];
  const g = hatchGeometry(hatch({ loops: [loop], scale: 25 }));
  // semicírculo hacia abajo (bulge negativo: CW desde -500 a 500 pasa por debajo)
  for (const s of g.segments) for (const p of s) assert.ok(p[1] <= 1e-6 && Math.hypot(p[0], p[1]) <= 500.2, `punto ${p} dentro`);
  const area = (Math.PI * 500 * 500) / 2;
  let approx = 0; for (let k = 0; k < 20; k++) approx += 0; // evita warning de variable sin uso
  assert.equal(approx, 0);
  // área aproximada por franjas: suma de los largos × separación
  near(total(g.segments) * 25, area, area * 0.05);
});

test('patrón a distintos ángulos: las líneas giran y el largo total se conserva', () => {
  const loops = [rect(0, 0, 2000, 1000)];
  const base = total(hatchGeometry(hatch({ loops, scale: 40 })).segments) * 40; // ≈ área
  for (const angle of [0, 15, 45, 90, 135, 200]) {
    const g = hatchGeometry(hatch({ loops, scale: 40, angle }));
    near(total(g.segments) * 40, 2000 * 1000, 2000 * 1000 * 0.03);
    // todas las líneas tienen la dirección pedida (módulo 180)
    for (const s of g.segments.slice(0, 30)) {
      let a = (Math.atan2(s[1][1] - s[0][1], s[1][0] - s[0][0]) * 180) / Math.PI - angle;
      a = ((a % 180) + 180) % 180;
      assert.ok(a < 1e-6 || Math.abs(a - 180) < 1e-6, `ángulo ${a}`);
    }
  }
  assert.ok(base > 0);
});

test('ansi31 va a 45° y cross trae dos familias perpendiculares', () => {
  const loops = [rect(0, 0, 1000, 1000)];
  const a = hatchGeometry(hatch({ loops, pattern: 'ansi31', scale: 50 }));
  const s = a.segments[Math.floor(a.segments.length / 2)];
  near(Math.abs(s[1][1] - s[0][1]), Math.abs(s[1][0] - s[0][0]), 1e-6);
  const c = hatchGeometry(hatch({ loops, pattern: 'cross', scale: 100 }));
  const horiz = c.segments.filter((q) => Math.abs(q[0][1] - q[1][1]) < 1e-6).length, vert = c.segments.filter((q) => Math.abs(q[0][0] - q[1][0]) < 1e-6).length;
  assert.equal(horiz, 10); assert.equal(vert, 10);
});

test('dots, brick, concrete y wood: producen geometría dentro del contorno', () => {
  const loops = [rect(0, 0, 1000, 600), circleLoop(500, 300, 100)];
  const polys = hatchGeometry(hatch({ loops })).polygons;
  const inside = (p: Pt2) => p[0] >= -1e-6 && p[0] <= 1000 + 1e-6 && p[1] >= -1e-6 && p[1] <= 600 + 1e-6 && Math.hypot(p[0] - 500, p[1] - 300) >= 99;
  const dots = hatchGeometry(hatch({ loops, pattern: 'dots', scale: 50 }));
  assert.ok(dots.dots.length > 100 && dots.dots.every(inside));
  const brick = hatchGeometry(hatch({ loops, pattern: 'brick', scale: 50 }));
  assert.ok(brick.segments.length > 40);
  for (const s of brick.segments) assert.ok(inside([(s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2]));
  const conc = hatchGeometry(hatch({ loops, pattern: 'concrete', scale: 50 }));
  assert.ok(conc.dots.length > 50 && conc.dots.every(inside));
  assert.deepEqual(hatchGeometry(hatch({ loops, pattern: 'concrete', scale: 50 })).dots.length, conc.dots.length, 'determinista');
  const wood = hatchGeometry(hatch({ loops, pattern: 'wood', scale: 40, angle: 10 }));
  assert.ok(wood.segments.length > 20);
});

test('solid no genera trazos; el patrón queda anclado al origen (dos sombreados contiguos alinean)', () => {
  assert.equal(hatchGeometry(hatch({ loops: [rect(0, 0, 100, 100)], pattern: 'solid' })).segments.length, 0);
  const a = hatchGeometry(hatch({ loops: [rect(0, 0, 500, 500)], scale: 100 })), b = hatchGeometry(hatch({ loops: [rect(500, 0, 1000, 500)], scale: 100 }));
  assert.deepEqual(a.segments.map((s) => s[0][1]), b.segments.map((s) => s[0][1]));
});

test('rendimiento: contorno enorme con separación mínima se ensancha (tope) y es rápido', () => {
  const t0 = Date.now();
  const g = hatchGeometry(hatch({ loops: [rect(0, 0, 50000, 50000), circleLoop(25000, 25000, 10000)], scale: 1 }), { maxSegments: 20000 });
  assert.ok(g.capped && g.spacing > 1);
  assert.ok(g.segments.length + g.dots.length <= 20000);
  // circunferencia de radio 20 m teselada, 10 000 líneas
  const g2 = hatchGeometry(hatch({ loops: [circleLoop(0, 0, 20000)], scale: 10, angle: 33 }));
  assert.ok(g2.segments.length > 3000);
  assert.ok(Date.now() - t0 < 4000, `tardó ${Date.now() - t0} ms`);
});

test('una polilínea con 2000 vértices y mil huecos pequeños se recorta sin explotar', () => {
  const loops: PolyVertex[][] = [rect(0, 0, 10000, 10000)];
  for (let i = 0; i < 30; i++) for (let j = 0; j < 30; j++) loops.push(circleLoop(300 + i * 320, 300 + j * 320, 80));
  const t0 = Date.now();
  const g = hatchGeometry(hatch({ loops, scale: 25, angle: 45 }));
  assert.ok(g.segments.length > 1000);
  assert.ok(Date.now() - t0 < 4000, `tardó ${Date.now() - t0} ms`);
});

test('findBoundary: cuadrado con círculo adentro → contorno exterior + isla, ambos exactos y asociativos', () => {
  let d = createDrawing('t');
  d = addEntities(d, [{ type: 'rect', p1: [0, 0], p2: [1000, 800] }, { type: 'circle', c: [500, 400], r: 150 }]).drawing;
  const b = findBoundary(d, [100, 100])!;
  assert.equal(b.loops.length, 2);
  assert.deepEqual(b.source?.sort(), ['e1', 'e2']);
  const outer = b.loops.find((l) => l.length === 4)!, inner = b.loops.find((l) => l.length === 2)!;
  near(polyArea({ pts: outer }), 800000);
  assert.ok(inner[0].bulge === 1);
  // el punto dentro del círculo da solo el círculo
  const c = findBoundary(d, [500, 400])!;
  assert.equal(c.loops.length, 1);
  assert.deepEqual(c.source, ['e2']);
  // fuera de todo: null
  assert.equal(findBoundary(d, [2000, 2000]), null);
});

test('findBoundary: habitación hecha con 4 líneas que se cruzan y sobresalen, con un cabo suelto', () => {
  let d = createDrawing('t');
  d = addEntities(d, [
    { type: 'line', a: [-200, 0], b: [3200, 0] }, { type: 'line', a: [3000, -200], b: [3000, 2200] },
    { type: 'line', a: [3200, 2000], b: [-200, 2000] }, { type: 'line', a: [0, 2200], b: [0, -300] },
    { type: 'line', a: [1500, 0], b: [1500, 900] }, // un cabo que sale de la pared (no cierra nada)
  ]).drawing;
  const b = findBoundary(d, [1000, 1000])!;
  assert.equal(b.loops.length, 1);
  near(polyArea({ pts: b.loops[0] }), 3000 * 2000, 1);
  assert.equal(b.loops[0].length, 4, 'sin vértices alineados sobrantes');
  assert.equal(b.source, undefined, 'armado con tramos sueltos: no es asociativo');
  assert.equal(b.entityIds.length, 4);
});

test('findBoundary: una pared divide el cuarto en dos y elige la mitad del clic; la isla suelta se detecta', () => {
  let d = createDrawing('t');
  d = addEntities(d, [
    { type: 'rect', p1: [0, 0], p2: [4000, 2000] },
    { type: 'line', a: [2000, 0], b: [2000, 2000] },
    { type: 'rect', p1: [500, 500], p2: [900, 900] }, // columna en la mitad izquierda
  ]).drawing;
  const left = findBoundary(d, [200, 200])!;
  assert.equal(left.loops.length, 2, 'cuarto izquierdo + columna');
  near(polyArea({ pts: left.loops[0] }), 2000 * 2000, 1);
  const right = findBoundary(d, [3000, 1000])!;
  assert.equal(right.loops.length, 1);
});

test('findBoundary respeta capas apagadas y ve dentro de inserts', () => {
  let d = createDrawing('t');
  d = { ...d, layers: [...d.layers, { name: 'Muros', color: 7, on: true, frozen: false, locked: false }] };
  d = addEntity(d, { type: 'rect', p1: [0, 0], p2: [100, 100], layer: 'Muros' }).drawing;
  assert.ok(findBoundary(d, [50, 50]));
  d = setLayer(d, 'Muros', { on: false });
  assert.equal(findBoundary(d, [50, 50]), null);
});

test('hatch en el dibujo: validación y normalización de la entrada', () => {
  let d = createDrawing('t');
  const r = addEntity(d, { type: 'hatch', loops: [[[0, 0], [10, 0], [10, 10]]], pattern: 'cross', angle: 30, scale: 5, color: 3, fillColor: '#ffeecc' });
  d = r.drawing;
  const h = d.entities[0] as HatchEntity;
  assert.equal(h.pattern, 'cross'); assert.equal(h.angle, 30); assert.equal(h.fillColor, '#ffeecc');
  assert.equal(validateDrawing(d), null);
  assert.throws(() => addEntity(d, { type: 'hatch', loops: [] }), DrawingError);
  assert.throws(() => addEntity(d, { type: 'hatch', loops: [[[0, 0]]] }), DrawingError);
  assert.throws(() => addEntity(d, { type: 'hatch', loops: [rect(0, 0, 1, 1)], pattern: 'zigzag' as never }), /pattern/);
  assert.throws(() => addEntity(d, { type: 'hatch', loops: [rect(0, 0, 1, 1)], scale: -1 }), /scale/);
  // por omisión ansi31
  assert.equal((addEntity(d, { type: 'hatch', loops: [rect(0, 0, 1, 1)] }).drawing.entities[1] as HatchEntity).pattern, 'ansi31');
});

test('mover un sombreado conserva sus huecos; syncHatches recalcula el asociativo cuando cambia el origen', () => {
  let d = createDrawing('t');
  d = addEntities(d, [{ type: 'rect', p1: [0, 0], p2: [1000, 800] }, { type: 'circle', c: [500, 400], r: 100 }]).drawing;
  const b = findBoundary(d, [50, 50])!;
  d = addEntity(d, { type: 'hatch', loops: b.loops, source: b.source, pattern: 'lines', scale: 50 }).drawing;
  const before = d;
  d = moveEntities(d, ['e1', 'e2'], [100, 0]);
  const synced = syncHatches(before, d);
  const h = synced.entities.find((e) => e.type === 'hatch') as HatchEntity;
  assert.equal(h.loops[0][0].p[0] >= 100, true, 'siguió al rectángulo');
  // si se mueve el sombreado solo, no se recalcula
  const solo = moveEntities(before, ['e3'], [5, 5]);
  assert.equal(syncHatches(before, solo), solo);
  // si el origen se borra, pierde la asociatividad pero conserva los contornos
  const gone = { ...d, entities: d.entities.filter((e) => e.id !== 'e2') };
  const g = syncHatches(before, gone).entities.find((e) => e.type === 'hatch') as HatchEntity;
  assert.equal(g.source, undefined); assert.equal(g.loops.length, 2);
});

test('loopsFromEntities: cerradas, y líneas sueltas que cierran; abiertas dan un error claro', () => {
  let d = createDrawing('t');
  d = addEntities(d, [{ type: 'circle', c: [0, 0], r: 10 }, { type: 'line', a: [100, 0], b: [200, 0] }, { type: 'line', a: [200, 0], b: [200, 50] }, { type: 'line', a: [200, 50], b: [100, 0] }]).drawing;
  const r = loopsFromEntities(d, ['e1', 'e2', 'e3', 'e4']);
  assert.equal(r.loops.length, 2);
  assert.throws(() => loopsFromEntities(d, ['e2', 'e3']), /no cierran/);
});

test('selección: se elige por su contorno o, dentro, solo si no hay nada más cerca', () => {
  let d = createDrawing('t');
  d = addEntities(d, [{ type: 'rect', p1: [0, 0], p2: [1000, 1000] }]).drawing;
  d = addEntity(d, { type: 'hatch', loops: [rect(0, 0, 1000, 1000)], pattern: 'lines' }).drawing;
  assert.deepEqual(pickAt(d, [500, 500], 10), ['e2']);
  assert.ok(pickAt(d, [500, 3], 10).includes('e1'), 'el borde también se elige');
  const h = d.entities[1] as HatchEntity;
  assert.ok(hatchPickDistance(h, [500, 500], 10) <= 10);
  assert.deepEqual(pickAt(d, [2000, 2000], 10), []);
});

test('DXF: los patrones nativos (solid, lines, cross, ansi31) hacen ida y vuelta con contornos, ángulo y separación', () => {
  let d = createDrawing('t', { layers: [{ name: 'Rayado' }] });
  d = addEntities(d, [
    { type: 'hatch', loops: [rect(0, 0, 1000, 800), circleLoop(500, 400, 150)], pattern: 'ansi31', angle: 30, scale: 80, layer: 'Rayado', color: '#ff8800' },
    { type: 'hatch', loops: [rect(2000, 0, 3000, 800)], pattern: 'solid', color: 5 },
    { type: 'hatch', loops: [rect(4000, 0, 5000, 800)], pattern: 'cross', scale: 120, angle: 10 },
    { type: 'hatch', loops: [[{ p: [0, 2000], bulge: 0.4 }, { p: [900, 2000] }, { p: [900, 2900] }]], pattern: 'lines', scale: 60 },
  ]).drawing;
  const text = drawingToDxf(d);
  assert.equal((text.match(/^HATCH$/gm) ?? []).length, 4);
  const r = dxfToDrawing(text);
  const hs = r.drawing.entities.filter((e): e is HatchEntity => e.type === 'hatch');
  assert.equal(hs.length, 4);
  const [a, s, c, l] = hs;
  assert.equal(a.pattern, 'ansi31'); near(a.angle ?? 0, 30); near(a.scale ?? 0, 80, 1e-4); assert.equal(a.loops.length, 2); assert.equal(a.layer, 'Rayado');
  assert.ok(a.loops.some((lp) => lp.length === 2 && lp[0].bulge === 1), 'el círculo vuelve como dos semicírculos');
  assert.equal(s.pattern, 'solid');
  assert.equal(c.pattern, 'cross'); near(c.scale ?? 0, 120, 1e-4); near(c.angle ?? 0, 10);
  assert.equal(l.pattern, 'lines'); near(l.loops[0][0].bulge ?? 0, 0.4, 1e-6);
  assert.equal(validateDrawing(r.drawing), null);
  // el área del contorno exterior se conserva
  near(polyArea({ pts: a.loops.find((lp) => lp.length === 4)! }), 800000, 1e-3);
});

test('DXF: dots, brick, concrete y wood salen como líneas y puntos sueltos (no hay HATCH equivalente)', () => {
  let d = createDrawing('t');
  d = addEntities(d, [{ type: 'hatch', loops: [rect(0, 0, 500, 500)], pattern: 'brick', scale: 50 }, { type: 'hatch', loops: [rect(1000, 0, 1500, 500)], pattern: 'dots', scale: 50 }]).drawing;
  const text = drawingToDxf(d);
  assert.equal((text.match(/^HATCH$/gm) ?? []).length, 0);
  assert.ok((text.match(/^LINE$/gm) ?? []).length > 10);
  assert.ok((text.match(/^POINT$/gm) ?? []).length > 10);
});

test('DXF de entrada estilo AutoCAD: HATCH con lazos de aristas (línea + arco), ANSI32 aproximado y unidades en cm', () => {
  const pairs = (a: (string | number)[]) => a.join('\n');
  const dxf = pairs([
    0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 5, 0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES',
    0, 'HATCH', 5, 'AB', 100, 'AcDbEntity', 8, 'Rellenos', 62, 3, 100, 'AcDbHatch', 10, 0, 20, 0, 30, 0, 210, 0, 220, 0, 230, 1,
    2, 'ANSI32', 70, 0, 71, 0, 91, 1,
    92, 1, 93, 4,
    72, 1, 10, 0, 20, 0, 11, 10, 21, 0,
    72, 1, 10, 10, 20, 0, 11, 10, 21, 10,
    72, 2, 10, 5, 20, 10, 40, 5, 50, 0, 51, 180, 73, 1,
    72, 1, 10, 0, 20, 10, 11, 0, 21, 0,
    97, 0,
    75, 0, 76, 1, 52, 45, 41, 2, 77, 0, 78, 2, 53, 45, 43, 0, 44, 0, 45, 0, 46, 3, 79, 0, 53, 135, 43, 0, 44, 0, 45, 0, 46, 3, 79, 0, 47, 1, 98, 1, 10, 3, 20, 3,
    0, 'ENDSEC', 0, 'EOF',
  ]);
  const r = dxfToDrawing(dxf);
  const h = r.drawing.entities.find((e) => e.type === 'hatch') as HatchEntity;
  assert.ok(h, 'se importó el HATCH');
  assert.equal(h.layer, 'Rellenos'); assert.equal(h.color, 3);
  assert.equal(h.loops.length, 1);
  // la arista curva (semicírculo de radio 5 cm = 50 mm) queda como bulge; unidades cm -> mm
  assert.ok(h.loops[0].some((v) => v.bulge && Math.abs(v.bulge) > 0.99), 'hay un arco');
  near(Math.max(...h.loops[0].map((v) => v.p[0])), 100);
  assert.equal(h.pattern, 'cross', 'dos familias perpendiculares (45° y 135°)');
  assert.ok(r.warnings.some((w) => /ANSI32/.test(w)), 'avisa que el patrón es aproximado');
  assert.equal(r.stats.omitted['HATCH'], undefined);
  assert.equal(validateDrawing(r.drawing), null);
});

test('PDF: el sombreado suma trazos y relleno al contenido; sólido usa f*', () => {
  let d = createDrawing('t');
  const plain = drawingToPdf(addEntity(d, { type: 'line', a: [0, 0], b: [1000, 1000] }).drawing);
  d = addEntities(d, [{ type: 'line', a: [0, 0], b: [1000, 1000] }, { type: 'hatch', loops: [rect(0, 0, 1000, 1000), circleLoop(500, 500, 100)], pattern: 'ansi31', scale: 50 }, { type: 'hatch', loops: [rect(0, 0, 100, 100)], pattern: 'solid' }]).drawing;
  const pdf = Buffer.from(drawingToPdf(d)).toString('latin1');
  assert.ok(pdf.length > Buffer.from(plain).length + 500);
  assert.ok(pdf.includes('f*'));
  assert.ok((pdf.match(/ l\n/g) ?? []).length > 20);
});

test('updateEntity en un sombreado valida y la tabla puede cambiar patrón y separación', () => {
  let d = createDrawing('t');
  d = addEntity(d, { type: 'hatch', loops: [rect(0, 0, 10, 10)], pattern: 'lines' }).drawing;
  d = updateEntity(d, 'e1', { pattern: 'brick', scale: 20, angle: 15 });
  assert.equal((d.entities[0] as HatchEntity).pattern, 'brick');
  assert.throws(() => updateEntity(d, 'e1', { pattern: 'nope' }), DrawingError);
});
