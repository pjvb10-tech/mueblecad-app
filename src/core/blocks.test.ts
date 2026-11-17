import test from 'node:test';
import assert from 'node:assert/strict';
import { blockUsage, flattenDrawing, flattenEntities, resolveInsert, validateBlocks } from './blocks';
import { applyBlockDrawing, blockDrawing, createBlock, describeBlock, editBlock, explodeInsert, insertBlock, removeBlock, renameBlock } from './blockOps';
import { addEntities, addEntity, createDrawing, DrawingError, moveEntities, rotateEntities, scaleEntities, setLayer, updateEntity, validateDrawing, addLayer, removeEntity } from './drawing';
import { drawingToDxf, dxfToDrawing } from './dxfDrawing';
import { drawingToPdf } from './pdfDrawing';
import { entityBounds, distPointEntity } from './geom2d';
import { blockCtx } from './blocks';
import { pickAt, selectBox } from './select2d';
import { snapPoint } from './snap2d';
import type { ArcEntity, CircleEntity, Drawing, Entity, InsertEntity, LineEntity, PolyEntity, TextEntity } from './types';

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const throwsMsg = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: Error) => e instanceof DrawingError && re.test(e.message), `esperaba un DrawingError que coincida con ${re}`);

/** Dibujo con un "Mueble" (rectángulo 100×50, un círculo y una línea) en (10,10). */
function base(): Drawing {
  let d = createDrawing('t', { layers: [{ name: 'Muros', color: 1 }] });
  d = addEntities(d, [
    { type: 'rect', p1: [10, 10], p2: [110, 60] }, { type: 'circle', c: [60, 35], r: 10 }, { type: 'line', a: [10, 10], b: [110, 60], layer: 'Muros' },
  ]).drawing;
  return d;
}

test('crear bloque desde entidades: coordenadas conservadas, base por omisión en la esquina, ids propios', () => {
  const d = base();
  const r = createBlock(d, { name: 'Mueble', ids: ['e1', 'e2', 'e3'] });
  const b = r.drawing.blocks![0];
  assert.equal(b.name, 'Mueble');
  assert.deepEqual(b.base, [10, 10]);
  assert.deepEqual(b.entities.map((e) => e.id), ['e1', 'e2', 'e3']);
  assert.equal(r.drawing.entities.length, 3, 'sin replace las originales se quedan');
  assert.equal(validateDrawing(r.drawing), null);
  // con replace: las originales se sustituyen por un insert en la base
  const r2 = createBlock(d, { name: 'Mueble', ids: ['e1', 'e2', 'e3'], replace: true, base: [10, 10] });
  assert.equal(r2.drawing.entities.length, 1);
  const ins = r2.drawing.entities[0] as InsertEntity;
  assert.equal(ins.type, 'insert'); assert.deepEqual(ins.p, [10, 10]); assert.equal(r2.insertId, ins.id);
  // se ve igual: mismas cajas
  const b0 = entityBounds(d.entities[0])!, bi = entityBounds(ins, blockCtx(r2.drawing))!;
  assert.deepEqual(bi.min, b0.min);
  throwsMsg(() => createBlock(d, { name: 'Mueble', ids: [] }), /al menos una/);
  throwsMsg(() => createBlock(r.drawing, { name: 'mueble', ids: ['e1'] }), /Ya existe/);
  throwsMsg(() => createBlock(d, { name: 'a/b', ids: ['e1'] }), /no válidos/);
});

test('insertar: transformación p + R·S·(local − base) con giro, escala y espejo', () => {
  let d = createBlock(base(), { name: 'M', ids: ['e1', 'e3'], base: [10, 10] }).drawing;
  d = insertBlock(d, { block: 'm', p: [1000, 0], rot: 90, scale: 2 }).drawing; // nombre sin distinguir mayúsculas; se guarda el canónico
  const ins = d.entities.find((e) => e.type === 'insert') as InsertEntity;
  assert.equal(ins.block, 'M');
  const kids = resolveInsert(ins, d);
  assert.equal(kids.length, 2);
  const poly = kids[0] as PolyEntity;
  // la esquina local (10,10) = base → cae en p; (110,10): (+100, 0) · 2 girado 90° = (0, 200)
  assert.deepEqual(poly.pts[0].p.map((v) => Math.round(v)), [1000, 0]);
  assert.deepEqual(poly.pts[1].p.map((v) => Math.round(v)), [1000, 200]);
  const ln = kids[1] as LineEntity; // (10,10)->(110,60): vector (100,50)·2 = (200,100) girado 90 = (-100, 200)
  assert.deepEqual(ln.b.map((v) => Math.round(v)), [900, 200]);
  assert.match(kids[0].id, /^e\d+\/e1$/, 'ids con ruta insert/hijo');
  // espejo: sx = -1 refleja en X
  d = insertBlock(d, { block: 'M', p: [0, 500], sx: -1 }).drawing;
  const mir = resolveInsert(d.entities[d.entities.length - 1] as InsertEntity, d)[1] as LineEntity;
  assert.deepEqual(mir.b.map((v) => Math.round(v)), [-100, 550]);
});

test('escala no uniforme: círculo → polilínea (elipse), arco → polilínea abierta, texto escala por Y', () => {
  let d = createDrawing('t');
  d = addEntities(d, [{ type: 'circle', c: [0, 0], r: 10 }, { type: 'arc', c: [0, 0], r: 10, a0: 0, a1: 90 }, { type: 'text', p: [0, 0], h: 5, s: 'A' }]).drawing;
  d = createBlock(d, { name: 'C', ids: ['e1', 'e2', 'e3'], base: [0, 0] }).drawing;
  d = insertBlock(d, { block: 'C', p: [100, 100], sx: 3, sy: 1 }).drawing;
  const kids = resolveInsert(d.entities.find((e) => e.type === 'insert') as InsertEntity, d);
  const el = kids[0] as PolyEntity;
  assert.equal(el.type, 'poly'); assert.ok(el.closed);
  const xs = el.pts.map((v) => v.p[0]), ys = el.pts.map((v) => v.p[1]);
  near(Math.max(...xs) - Math.min(...xs), 60, 0.2); near(Math.max(...ys) - Math.min(...ys), 20, 0.2);
  assert.equal(kids[1].type, 'poly');
  assert.equal((kids[2] as TextEntity).type, 'text');
  // escala uniforme con giro: círculo y arco siguen siendo círculo y arco
  const d2 = insertBlock(d, { block: 'C', p: [0, 0], scale: 2, rot: 30 }).drawing;
  const k2 = resolveInsert(d2.entities[d2.entities.length - 1] as InsertEntity, d2);
  assert.equal((k2[0] as CircleEntity).r, 20);
  const arc = k2[1] as ArcEntity;
  near(arc.a0, 30); near(arc.a1, 120);
});

test('bloques anidados: la matriz se compone y el uso se cuenta', () => {
  let d = createDrawing('t');
  d = addEntities(d, [{ type: 'line', a: [0, 0], b: [10, 0] }]).drawing;
  d = createBlock(d, { name: 'Hoja', ids: ['e1'], base: [0, 0], replace: true }).drawing;
  d = addEntity(d, { type: 'insert', block: 'Hoja', p: [0, 0] }).drawing;       // e2 (el insert de reemplazo era e2; este e3)
  const ids = d.entities.map((e) => e.id);
  // bloque Par: dos hojas, una girada 90° a (20, 0)
  d = createBlock(d, { name: 'Par', ids: [ids[0]], base: [0, 0] }).drawing;
  d = editBlock(d, 'Par', (bd) => { const r = addEntity(bd, { type: 'insert', block: 'Hoja', p: [20, 0], rot: 90 }); return r.drawing; });
  d = insertBlock(d, { block: 'Par', p: [100, 100], scale: 2 }).drawing;
  const top = d.entities[d.entities.length - 1] as InsertEntity;
  const kids = resolveInsert(top, d);
  const lines = kids.filter((k) => k.type === 'line') as LineEntity[];
  assert.equal(lines.length, 2);
  // la hoja del Par: (0,0)-(10,0)·2 → (100,100)-(120,100); la girada: p=(20,0)→(140,100), dir 90°+0 → (140,100)-(140,120)
  const sorted = lines.map((l) => [l.a, l.b].map((p) => p.map(Math.round))).sort((a, b) => a[0][0] - b[0][0]);
  assert.deepEqual(sorted[0], [[100, 100], [120, 100]]);
  assert.deepEqual(sorted[1], [[140, 100], [140, 120]]);
  assert.deepEqual(blockUsage(d, 'Hoja'), { inDrawing: d.entities.filter((e) => e.type === 'insert' && e.block === 'Hoja').length, inBlocks: 2 });
});

test('editar el bloque actualiza TODAS las instancias (se referencia por nombre)', () => {
  let d = createBlock(base(), { name: 'M', ids: ['e1'], base: [10, 10], replace: true }).drawing;
  d = insertBlock(d, { block: 'M', p: [500, 0] }).drawing;
  d = insertBlock(d, { block: 'M', p: [0, 500], rot: 90 }).drawing;
  const inserts = () => d.entities.filter((e): e is InsertEntity => e.type === 'insert');
  assert.equal(inserts().length, 3);
  const before = inserts().map((i) => resolveInsert(i, d).length);
  assert.deepEqual(before, [1, 1, 1]);
  d = editBlock(d, 'M', (bd) => addEntity(bd, { type: 'circle', c: [60, 35], r: 5 }).drawing);
  assert.deepEqual(inserts().map((i) => resolveInsert(i, d).length), [2, 2, 2]);
  // mover un vértice del rectángulo dentro del bloque cambia las tres
  d = editBlock(d, 'M', (bd) => updateEntity(bd, 'e1', { pts: [{ p: [10, 10] }, { p: [210, 10] }, { p: [210, 60] }, { p: [10, 60] }] }));
  for (const i of inserts()) {
    const poly = resolveInsert(i, d)[0] as PolyEntity;
    near(Math.hypot(poly.pts[1].p[0] - poly.pts[0].p[0], poly.pts[1].p[1] - poly.pts[0].p[1]), 200);
  }
  assert.equal(validateDrawing(d), null);
  // cambiar la base mueve todas las instancias respecto de su p
  const d2 = editBlock(d, 'M', (bd) => bd, { base: [0, 0], description: 'Mueble base' });
  assert.equal(d2.blocks![0].description, 'Mueble base');
  const p0 = (resolveInsert(inserts()[1], d2)[0] as PolyEntity).pts[0].p, q0 = (resolveInsert(inserts()[1], d)[0] as PolyEntity).pts[0].p;
  assert.notDeepEqual(p0.map(Math.round), q0.map(Math.round));
  assert.equal(describeBlock(d, d.blocks![0]).uses, 3);
});

test('ciclos y profundidad: un bloque no puede contenerse a sí mismo; máximo 8 niveles', () => {
  let d = createBlock(base(), { name: 'A', ids: ['e1'], base: [0, 0], replace: true }).drawing;
  d = insertBlock(d, { block: 'A', p: [0, 0] }).drawing;
  d = createBlock(d, { name: 'B', ids: [d.entities[d.entities.length - 1].id], base: [0, 0] }).drawing; // B contiene un insert de A
  // insertar B dentro de A cerraría el ciclo A → B → A
  throwsMsg(() => editBlock(d, 'A', (bd) => { void bd; return addEntity({ ...bd, blocks: d.blocks }, { type: 'insert', block: 'B', p: [0, 0] }).drawing; }), /contendría|contiene|no existe/);
  // validación directa de un ciclo escrito a mano
  const bad: Drawing = { ...d, blocks: d.blocks!.map((b) => (b.name === 'A' ? { ...b, entities: [...b.entities, { id: 'x1', layer: '0', type: 'insert', block: 'B', p: [0, 0] } as Entity] } : b)) };
  assert.match(validateBlocks(bad)!, /se contiene a sí mismo/);
  // auto-referencia
  const self: Drawing = { ...d, blocks: [{ name: 'S', base: [0, 0], entities: [{ id: 'x1', layer: '0', type: 'insert', block: 'S', p: [0, 0] } as Entity] }] };
  assert.match(validateBlocks(self)!, /se contiene a sí mismo/);
  // cadena de 9 niveles
  let chain = createDrawing('c');
  chain = addEntity(chain, { type: 'line', a: [0, 0], b: [1, 0] }).drawing;
  chain = createBlock(chain, { name: 'N0', ids: ['e1'], base: [0, 0] }).drawing;
  for (let i = 1; i <= 8; i++) {
    const prev = `N${i - 1}`;
    chain = { ...chain, blocks: [...chain.blocks!, { name: `N${i}`, base: [0, 0], entities: [{ id: 'i', layer: '0', type: 'insert', block: prev, p: [0, 0] } as Entity] }] };
  }
  assert.equal(validateBlocks(chain), null, '8 niveles (N8 → ... → N0 más el insert) está en el límite');
  const withTop = addEntity(chain, { type: 'insert', block: 'N8', p: [0, 0] });
  assert.match(validateBlocks(withTop.drawing) ?? '', /más de 8 niveles/);
  // referencia a un bloque inexistente
  throwsMsg(() => insertBlock(d, { block: 'Fantasma', p: [0, 0] }), /no existe/);
});

test('explotar: el insert se sustituye por sus entidades transformadas, con ids nuevos y en su sitio', () => {
  let d = createBlock(base(), { name: 'M', ids: ['e1', 'e2', 'e3'], base: [10, 10], replace: true }).drawing;
  d = insertBlock(d, { block: 'M', p: [1000, 0], rot: 90 }).drawing;
  const first = d.entities[0].id, last = d.entities[1].id;
  const r = explodeInsert(d, last);
  assert.equal(r.ids.length, 3);
  assert.equal(r.drawing.entities.filter((e) => e.type === 'insert').length, 1);
  assert.equal(r.drawing.entities[0].id, first);
  assert.equal(new Set(r.drawing.entities.map((e) => e.id)).size, r.drawing.entities.length);
  const circle = r.drawing.entities.find((e) => e.type === 'circle') as CircleEntity;
  assert.deepEqual(circle.c.map(Math.round), [1000 - 25, 50]); // (60,35)-(10,10) = (50,25) girado 90° = (-25, 50)
  // el dibujo se ve igual: misma caja
  const b0 = entityBounds(d.entities[1], blockCtx(d))!;
  const b1 = r.drawing.entities.slice(1).map((e) => entityBounds(e)!);
  near(Math.min(...b1.map((b) => b.min[0])), b0.min[0], 1e-6);
  const withLine = addEntity(d, { type: 'line', a: [0, 0], b: [1, 1] });
  throwsMsg(() => explodeInsert(withLine.drawing, withLine.id), /no un insert/);
  // un insert con arreglo da una copia por celda
  const arr = insertBlock(d, { block: 'M', p: [0, 0], cols: 3, rows: 2, dx: 200, dy: 100 }).drawing;
  const ex = explodeInsert(arr, arr.entities[arr.entities.length - 1].id);
  assert.equal(ex.ids.length, 3 * 6);
  // explotar con un bloque anidado conserva el anidado como insert
  let n = createBlock(base(), { name: 'In', ids: ['e1'], base: [10, 10], replace: true }).drawing;
  n = insertBlock(n, { block: 'In', p: [0, 0] }).drawing;
  n = createBlock(n, { name: 'Out', ids: [n.entities[n.entities.length - 1].id], base: [0, 0] }).drawing;
  n = insertBlock(n, { block: 'Out', p: [500, 500], scale: 2, rot: 90 }).drawing;
  const exn = explodeInsert(n, n.entities[n.entities.length - 1].id);
  const nested = exn.drawing.entities.find((e) => e.type === 'insert' && e.block === 'In' && Math.abs(e.p[0]) > 100) as InsertEntity;
  assert.ok(nested, 'el anidado sigue siendo insert con la transformación compuesta');
  near(nested.sx ?? 1, 2); near(nested.rot ?? 0, 90);
});

test('arreglos (cols × rows) y tope de copias', () => {
  let d = createBlock(base(), { name: 'M', ids: ['e1'], base: [10, 10], replace: true }).drawing;
  d = insertBlock(d, { block: 'M', p: [0, 0], cols: 4, rows: 3, dx: 150, dy: 80 }).drawing;
  const ins = d.entities[d.entities.length - 1] as InsertEntity;
  const kids = resolveInsert(ins, d);
  assert.equal(kids.length, 12);
  const starts = kids.map((k) => (k as PolyEntity).pts[0].p.map(Math.round).join(','));
  assert.ok(starts.includes('0,0') && starts.includes('450,160'));
  assert.equal(new Set(kids.map((k) => k.id)).size, 12);
  throwsMsg(() => insertBlock(d, { block: 'M', p: [0, 0], cols: 200, rows: 200 }), /10 000/);
  throwsMsg(() => insertBlock(d, { block: 'M', p: [0, 0], sx: 0 }), /distinto de 0/);
});

test('borrar y renombrar bloques: en uso exige explotar; renombrar actualiza inserts (también anidados)', () => {
  let d = createBlock(base(), { name: 'M', ids: ['e1'], base: [10, 10], replace: true }).drawing;
  d = insertBlock(d, { block: 'M', p: [200, 0] }).drawing;
  d = createBlock(d, { name: 'Todo', ids: [d.entities.find((e) => e.type === 'insert')!.id], base: [0, 0] }).drawing;
  throwsMsg(() => removeBlock(d, 'M'), /está en uso/);
  const r = renameBlock(d, 'M', 'Mesa');
  assert.ok(r.entities.every((e) => e.type !== 'insert' || e.block === 'Mesa'));
  assert.equal((r.blocks!.find((b) => b.name === 'Todo')!.entities[0] as InsertEntity).block, 'Mesa');
  assert.equal(validateDrawing(r), null);
  throwsMsg(() => renameBlock(d, 'M', 'Todo'), /Ya existe/);
  const gone = removeBlock(d, 'M', { explode: true });
  assert.equal(gone.blocks!.length, 1);
  assert.ok(gone.entities.every((e) => e.type !== 'insert'));
  assert.equal(validateDrawing(gone), null);
  // un bloque sin uso se borra directo y, al quedar sin bloques, desaparece la clave
  const solo = createBlock(base(), { name: 'X', ids: ['e1'] }).drawing;
  const none = removeBlock(solo, 'X');
  assert.equal('blocks' in none, false);
});

test('capas: bloqueada/congelada impiden insertar y explotar; la capa 0 de los hijos hereda la del insert; el color del insert', () => {
  let d = addLayer(createDrawing('t'), { name: 'Muros', color: 1 });
  d = addLayer(d, { name: 'Otra', color: 5 });
  d = addEntities(d, [{ type: 'line', a: [0, 0], b: [10, 0] }, { type: 'line', a: [0, 5], b: [10, 5], layer: 'Otra' }]).drawing;
  d = createBlock(d, { name: 'L', ids: ['e1', 'e2'], base: [0, 0], replace: true, layer: 'Muros' }).drawing;
  const ins = d.entities[0] as InsertEntity;
  assert.equal(ins.layer, 'Muros');
  const kids = resolveInsert(ins, d);
  assert.deepEqual(kids.map((k) => k.layer), ['Muros', 'Otra'], 'la capa 0 hereda; las demás se conservan');
  const colored = insertBlock(d, { block: 'L', p: [0, 100], color: 3, layer: 'Muros' }).drawing;
  assert.ok(resolveInsert(colored.entities[colored.entities.length - 1] as InsertEntity, colored).every((k) => k.color === 3));
  const locked = setLayer(d, 'Muros', { locked: true });
  throwsMsg(() => explodeInsert(locked, ins.id), /bloqueada/);
  throwsMsg(() => insertBlock(locked, { block: 'L', p: [0, 0], layer: 'Muros' }), /bloqueada/);
  const frozen = setLayer(d, 'Muros', { frozen: true });
  throwsMsg(() => removeEntity(frozen, ins.id), /congelada/);
});

test('hit-test, selección, snap y medición sobre inserts usan las entidades resueltas', () => {
  let d = createBlock(base(), { name: 'M', ids: ['e1', 'e2'], base: [10, 10], replace: true }).drawing;
  d = insertBlock(d, { block: 'M', p: [1000, 1000], rot: 90 }).drawing;
  const id = d.entities[d.entities.length - 1].id;
  const ctx = blockCtx(d);
  const b = entityBounds(d.entities[d.entities.length - 1], ctx)!;
  near(b.max[0] - b.min[0], 50); near(b.max[1] - b.min[1], 100);
  // el contorno del rectángulo girado: lado izquierdo en x = 1000 - 50
  near(distPointEntity([950, 1050], d.entities[d.entities.length - 1], ctx), 0, 1e-6);
  assert.ok(distPointEntity([0, 0], d.entities[d.entities.length - 1], ctx) > 100);
  assert.deepEqual(pickAt(d, [950, 1050], 3), [id]);
  assert.deepEqual(selectBox(d, [900, 950], [1100, 1200], { mode: 'window' }).ids, [id]);
  assert.deepEqual(selectBox(d, [0, 0], [100, 100], { mode: 'window' }).ids, []);
  const s = snapPoint(d, [951, 1001], { aperture: 5, modes: { end: true } });
  assert.equal(s.mode, 'end');
  assert.deepEqual(s.point.map(Math.round), [950, 1000]);
  // cruce: un rectángulo de selección que solo roza el borde del bloque
  assert.deepEqual(selectBox(d, [930, 1040], [960, 1060], { mode: 'crossing' }).ids, [id]);
});

test('mover, girar y escalar un insert transforman el insert, no el bloque', () => {
  let d = createBlock(base(), { name: 'M', ids: ['e1'], base: [10, 10], replace: true }).drawing;
  d = insertBlock(d, { block: 'M', p: [100, 0] }).drawing;
  const id = d.entities[d.entities.length - 1].id;
  const mv = moveEntities(d, [id], [5, 7]).entities.find((e) => e.id === id) as InsertEntity;
  assert.deepEqual(mv.p, [105, 7]);
  const ro = rotateEntities(d, [id], [0, 0], 90).entities.find((e) => e.id === id) as InsertEntity;
  near(ro.rot ?? 0, 90); near(ro.p[0], 0, 1e-9); near(ro.p[1], 100, 1e-9);
  const sc = scaleEntities(d, [id], [0, 0], 2).entities.find((e) => e.id === id) as InsertEntity;
  assert.deepEqual([sc.sx, sc.sy, sc.p[0]], [2, 2, 200]);
  assert.deepEqual(d.blocks![0].entities.length, 1);
});

test('blockDrawing / applyBlockDrawing: editar el bloque como un dibujo con todas las operaciones puras', () => {
  let d = createBlock(base(), { name: 'M', ids: ['e1', 'e2'], base: [10, 10], replace: true }).drawing;
  d = insertBlock(d, { block: 'M', p: [300, 0] }).drawing;
  const bd = blockDrawing(d, 'M');
  assert.equal(bd.entities.length, 2);
  assert.equal(bd.blocks, undefined);
  const edited = moveEntities(bd, ['e2'], [10, 0]);
  const out = applyBlockDrawing(d, 'M', edited);
  assert.deepEqual((out.blocks![0].entities[1] as CircleEntity).c, [70, 35]);
  // las capas nuevas se escriben de vuelta
  const withLayer = addLayer(bd, { name: 'Detalle', color: 2 });
  assert.ok(applyBlockDrawing(d, 'M', withLayer).layers.some((l) => l.name === 'Detalle'));
});

test('PDF y aplanado: los inserts se dibujan resueltos y respetan capas apagadas', () => {
  let d = createBlock(base(), { name: 'M', ids: ['e1', 'e2'], base: [10, 10], replace: true }).drawing;
  d = insertBlock(d, { block: 'M', p: [1000, 0] }).drawing;
  const flat = flattenDrawing(d);
  assert.equal(flat.blocks, undefined);
  assert.equal(flat.entities.length, 5);
  const withInsert = Buffer.from(drawingToPdf(d)).toString('latin1');
  const plainDrawing = { ...d, entities: [] as Entity[] };
  assert.ok(withInsert.length > Buffer.from(drawingToPdf(plainDrawing)).length + 100);
  const off = setLayer(d, '0', { on: false });
  assert.equal(flattenEntities(off, { visibleOnly: true }).length, 1, 'solo queda la línea de la capa Muros');
});

test('DXF: los bloques salen como BLOCK / BLOCK_RECORD / INSERT nativos y vuelven editables (ida y vuelta)', () => {
  let d = createDrawing('t', { layers: [{ name: 'Muros', color: 1 }] });
  d = addEntities(d, [{ type: 'rect', p1: [10, 10], p2: [110, 60] }, { type: 'circle', c: [60, 35], r: 10, layer: 'Muros' }, { type: 'text', p: [20, 20], h: 5, s: 'Mesa' }]).drawing;
  d = createBlock(d, { name: 'Mesa 1', ids: ['e1', 'e2', 'e3'], base: [10, 10], replace: true, description: 'una mesa' }).drawing;
  d = insertBlock(d, { block: 'Mesa 1', p: [1000, 0], rot: 90, sx: 2, sy: 1, layer: 'Muros' }).drawing;
  d = insertBlock(d, { block: 'Mesa 1', p: [0, 500], cols: 3, rows: 2, dx: 200, dy: 100 }).drawing;
  d = createBlock(d, { name: 'Dos', ids: [d.entities[d.entities.length - 1].id], base: [0, 0] }).drawing; // anidado: contiene un insert
  d = insertBlock(d, { block: 'Dos', p: [3000, 0] }).drawing;
  assert.equal(validateDrawing(d), null);
  const text = drawingToDxf(d);
  assert.equal((text.match(/^INSERT$/gm) ?? []).length, 4 + 1, '4 en el dibujo + 1 anidado en el bloque Dos');
  assert.ok(/^BLOCK$/m.test(text) && /^Mesa 1$/m.test(text));
  // los hijos del bloque están dentro del BLOCK (antes de ENDBLK) y no en ENTITIES
  const blocksSec = text.slice(text.indexOf('BLOCKS'), text.indexOf('ENTITIES'));
  assert.ok(/CIRCLE/.test(blocksSec) && /LWPOLYLINE/.test(blocksSec));
  const r = dxfToDrawing(text);
  assert.equal(r.drawing.blocks!.length, 2);
  assert.equal(r.warnings.filter((w) => /bloque/i.test(w)).length, 0);
  const mesa = r.drawing.blocks!.find((b) => b.name === 'Mesa 1')!;
  assert.deepEqual(mesa.base.map(Math.round), [10, 10]);
  assert.equal(mesa.entities.length, 3);
  const inserts = r.drawing.entities.filter((e): e is InsertEntity => e.type === 'insert');
  assert.equal(inserts.length, 4);
  const rot = inserts.find((i) => i.rot)!;
  near(rot.rot!, 90); near(rot.sx!, 2); assert.equal(rot.layer, 'Muros');
  const arr = inserts.find((i) => i.cols)!;
  assert.deepEqual([arr.cols, arr.rows, arr.dx, arr.dy], [3, 2, 200, 100]);
  assert.equal(validateDrawing(r.drawing), null);
  // la geometría resuelta coincide con la original
  const a = flattenEntities(d), b = flattenEntities(r.drawing);
  assert.equal(a.length, b.length);
  const box = (list: Entity[]) => { const bs = list.map((e) => entityBounds(e)!); return [Math.min(...bs.map((x) => x.min[0])), Math.min(...bs.map((x) => x.min[1])), Math.max(...bs.map((x) => x.max[0])), Math.max(...bs.map((x) => x.max[1]))]; };
  const ba = box(a), bb = box(b);
  for (let i = 0; i < 4; i++) near(ba[i], bb[i], 0.5);
  // explodeBlocks: true da entidades sueltas y sin bloques
  const ex = dxfToDrawing(text, { explodeBlocks: true });
  assert.equal(ex.drawing.blocks, undefined);
  assert.equal(ex.drawing.entities.filter((e) => e.type === 'insert').length, 0);
  assert.equal(ex.drawing.entities.length, a.length);
});

test('DXF de entrada: INSERT con unidades, bloque con capa 0 y ByBlock, nombres con caracteres raros y bloques anónimos', () => {
  const pairs = (a: (string | number)[]) => a.join('\n');
  const dxf = pairs([
    0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 5, 0, 'ENDSEC',
    0, 'SECTION', 2, 'BLOCKS',
    0, 'BLOCK', 8, '0', 2, '*U12', 70, 1, 10, 1, 20, 1, 30, 0, 3, '*U12',
    0, 'LINE', 8, '0', 62, 0, 10, 1, 20, 1, 30, 0, 11, 3, 21, 1, 31, 0,
    0, 'CIRCLE', 8, 'Aux', 10, 2, 20, 2, 30, 0, 40, 0.5,
    0, 'ENDBLK', 8, '0',
    0, 'ENDSEC',
    0, 'SECTION', 2, 'ENTITIES',
    0, 'INSERT', 8, 'Muros', 62, 3, 2, '*U12', 10, 10, 20, 20, 30, 0, 41, 2, 42, 2, 43, 2, 50, 90,
    0, 'ENDSEC', 0, 'EOF',
  ]);
  const r = dxfToDrawing(dxf);
  assert.equal(r.drawing.blocks!.length, 1);
  const b = r.drawing.blocks![0];
  assert.match(b.name, /^_U12$/, 'el * del nombre se sustituye');
  assert.deepEqual(b.base, [10, 10], 'cm → mm');
  assert.equal(b.entities.length, 2);
  const ins = r.drawing.entities[0] as InsertEntity;
  assert.deepEqual(ins.p, [100, 200]); assert.equal(ins.sx, 2); assert.equal(ins.layer, 'Muros'); assert.equal(ins.color, 3);
  assert.equal(validateDrawing(r.drawing), null);
  const kids = resolveInsert(ins, r.drawing);
  const line = kids.find((k) => k.type === 'line') as LineEntity;
  assert.equal(line.layer, 'Muros', 'la capa 0 hereda la del insert');
  assert.equal(line.color, 3, 'ByBlock → color del insert');
  assert.equal(kids.find((k) => k.type === 'circle')!.layer, 'Aux');
  // INSERT de un bloque inexistente se omite con aviso
  const missing = dxfToDrawing(pairs([0, 'SECTION', 2, 'ENTITIES', 0, 'INSERT', 8, '0', 2, 'NOHAY', 10, 0, 20, 0, 0, 'ENDSEC', 0, 'EOF']));
  assert.equal(missing.drawing.entities.length, 0);
  assert.ok(missing.warnings.some((w) => /INSERT sin bloque/.test(w)));
});

test('rendimiento: 5 000 inserts de un bloque se resuelven, indexan y seleccionan rápido', () => {
  let d = createBlock(base(), { name: 'M', ids: ['e1', 'e2'], base: [10, 10], replace: true }).drawing;
  d = addEntities(d, Array.from({ length: 5000 }, (_, i) => ({ type: 'insert' as const, block: 'M', p: [(i % 100) * 300, Math.floor(i / 100) * 200] as [number, number], rot: i % 360 }))).drawing;
  const t0 = Date.now();
  assert.equal(flattenEntities(d).length, 10003);
  const hits = pickAt(d, [300 * 7 + 5, 200 * 3 + 5], 8);
  assert.ok(hits.length >= 1);
  assert.ok(selectBox(d, [0, 0], [3000, 2000], { mode: 'crossing' }).ids.length > 100);
  assert.ok(Date.now() - t0 < 3000, `tardó ${Date.now() - t0} ms`);
});
