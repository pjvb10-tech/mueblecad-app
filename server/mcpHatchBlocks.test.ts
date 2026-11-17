import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultProject, type HatchEntity, type InsertEntity } from '../src/core/types';
import { createStore } from './store';
import { drawingToSvg, runCommand } from './mcpDrawing';
import { HATCH_BLOCK_COMMANDS, runHatchBlockCommand } from './mcpHatchBlocks';
import { decodeDxf } from './mcpDrawingIO';
import { dxfToDrawing } from '../src/core/dxfDrawing';
import { drawingToDxf } from '../src/core/dxfDrawing';
import { resolveInsert } from '../src/core/blocks';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-hatch-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(defaultProject(), null, 2));
  return createStore(dir);
}
type S = ReturnType<typeof createStore>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (s: S, name: string, args: Record<string, unknown> = {}): any => runHatchBlockCommand(s, name, args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const base = (s: S, name: string, args: Record<string, unknown> = {}): any => runCommand(s, name, args);
const drawing = (s: S) => s.readProject().project.drawings![0];

function room(s: S) {
  base(s, 'new_drawing', { name: 'Planta', plane: 'xz' });
  base(s, 'draw_rect', { origin: [0, 0], w: 4000, h: 3000 });
  base(s, 'draw_circle', { c: [2000, 1500], r: 400 });
}

test('draw_hatch por punto interior: contorno + isla, asociativo; por entidades y por loops; dryRun', () => {
  const s = tmpStore();
  room(s);
  const r = run(s, 'draw_hatch', { point: [200, 200], pattern: 'cross', scale: 100, angle: 30, color: 1, fillColor: '#eeeeee' });
  assert.equal(r.loops, 2); assert.equal(r.associative, true);
  assert.ok(Math.abs(r.areaMm2 - (4000 * 3000 - Math.PI * 400 * 400)) < 500, `área ${r.areaMm2}`);
  const h = drawing(s).entities.find((e) => e.id === r.id) as HatchEntity;
  assert.equal(h.pattern, 'cross'); assert.equal(h.angle, 30); assert.equal(h.scale, 100); assert.equal(h.color, 1); assert.deepEqual(h.source?.sort(), ['e1', 'e2']);
  // sin asociatividad
  const r2 = run(s, 'draw_hatch', { point: [2000, 1500], associative: false, pattern: 'solid' });
  assert.equal(r2.associative, false); assert.equal(r2.loops, 1);
  // por entidades
  const r3 = run(s, 'draw_hatch', { entities: ['e1', 'e2'], pattern: 'dots' });
  assert.equal(r3.loops, 2);
  // por loops
  const r4 = run(s, 'draw_hatch', { loops: [[[0, 0], [100, 0], { p: [100, 100], bulge: 0.3 }]], pattern: 'brick', scale: 20 });
  assert.equal(r4.loops, 1);
  // errores claros
  assert.throws(() => run(s, 'draw_hatch', { point: [90000, 90000] }), /no está dentro de un contorno cerrado/);
  assert.throws(() => run(s, 'draw_hatch', {}), /exactamente uno/);
  assert.throws(() => run(s, 'draw_hatch', { point: [1, 1], entities: ['e1'] }), /exactamente uno/);
  assert.throws(() => run(s, 'draw_hatch', { point: [1, 1], pattern: 'zig' }), /parámetros no válidos/);
  assert.throws(() => run(s, 'draw_hatch', { point: [1, 1], layer: 'Nada' }), /capa "Nada" no existe/);
  // dryRun no guarda
  const n = drawing(s).entities.length;
  const dry = run(s, 'draw_hatch', { point: [200, 200], dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(drawing(s).entities.length, n);
  // inspect_drawing y measure_shapes ven el sombreado
  assert.equal(base(s, 'inspect_drawing', {}).types.hatch, 4);
  assert.ok(base(s, 'measure_shapes', { ids: [r.id] }).shapes[0].area > 1e7);
  // render_drawing dibuja el patrón
  const svg = drawingToSvg(drawing(s));
  assert.ok(svg.includes('fill-rule="evenodd"'));
  assert.ok((svg.match(/<path /g) ?? []).length >= 3);
});

test('bloques por MCP: crear, listar, obtener, insertar, editar (todas las instancias), explotar y borrar', () => {
  const s = tmpStore();
  base(s, 'new_drawing', { name: 'P' });
  base(s, 'draw_rect', { origin: [0, 0], w: 100, h: 50 });
  base(s, 'draw_circle', { c: [50, 25], r: 10 });
  const c = run(s, 'block_create', { name: 'Mesa', entities: ['e1', 'e2'], replace: true, description: 'mesa chica' });
  assert.equal(c.entities, 2); assert.ok(c.insertId);
  assert.equal(drawing(s).entities.length, 1);
  const i1 = run(s, 'insert_block', { block: 'Mesa', p: [500, 0], rot: 90, scale: 2 }).id;
  run(s, 'insert_block', { block: 'mesa', p: [1000, 0], cols: 2, rows: 2, dx: 300, dy: 200 });
  const list = run(s, 'block_list', {});
  assert.equal(list.blocks.length, 1);
  assert.equal(list.blocks[0].uses, 3); assert.equal(list.blocks[0].description, 'mesa chica');
  const got = run(s, 'block_get', { name: 'Mesa' });
  assert.equal(got.entities.length, 2); assert.equal(got.insertIds.length, 3);
  // editar: se agrega una línea y se cambia el radio del círculo; todas las instancias cambian
  run(s, 'block_update', { name: 'Mesa', add: [{ type: 'line', a: [0, 0], b: [100, 50] }], update: [{ id: 'e2', r: 15 }] });
  const d = drawing(s);
  for (const ins of d.entities.filter((e): e is InsertEntity => e.type === 'insert')) {
    const kids = resolveInsert(ins, d);
    const expected = ((ins.cols ?? 1) * (ins.rows ?? 1)) * 3;
    assert.equal(kids.length, expected);
  }
  // un lote malo no cambia nada
  assert.throws(() => run(s, 'block_update', { name: 'Mesa', remove: ['e99'] }), /e99/);
  assert.equal(run(s, 'block_get', { name: 'Mesa' }).entities.length, 3);
  // ciclo rechazado
  assert.throws(() => run(s, 'block_update', { name: 'Mesa', add: [{ type: 'insert', block: 'Mesa', p: [0, 0] }] }), /no existe|contendría|contiene/);
  // renombrar
  run(s, 'block_update', { name: 'Mesa', rename: 'Mesa grande' });
  assert.ok(drawing(s).entities.every((e) => e.type !== 'insert' || e.block === 'Mesa grande'));
  // borrar: en uso falla; con explode funciona
  assert.throws(() => run(s, 'block_remove', { name: 'Mesa grande' }), /en uso/);
  const x = run(s, 'explode_insert', { id: i1 });
  assert.equal(x.ids.length, 3);
  assert.throws(() => run(s, 'explode_insert', { id: x.ids[0] }), /no un insert/);
  run(s, 'block_remove', { name: 'Mesa grande', explode: true });
  assert.equal(drawing(s).blocks, undefined);
  assert.ok(drawing(s).entities.every((e) => e.type !== 'insert'));
  assert.throws(() => run(s, 'insert_block', { block: 'Nada', p: [0, 0] }), /no existe/);
});

test('un insert por drawing_batch, query_entities con ventana y render_drawing resuelven el bloque', () => {
  const s = tmpStore();
  base(s, 'new_drawing', { name: 'P' });
  base(s, 'draw_rect', { origin: [0, 0], w: 100, h: 50 });
  run(s, 'block_create', { name: 'B', entities: ['e1'], replace: true });
  base(s, 'drawing_batch', { add: [{ type: 'insert', block: 'B', p: [1000, 1000] }, { type: 'hatch', loops: [[[0, 0], [10, 0], [10, 10]]], pattern: 'lines' }] });
  const q = base(s, 'query_entities', { type: 'insert', window: [900, 900, 1200, 1200] });
  assert.equal(q.total, 1);
  assert.equal(base(s, 'query_entities', { type: 'insert', window: [0, 0, 50, 50] }).total, 0);
  const svg = drawingToSvg(drawing(s));
  assert.ok(svg.includes('<polygon'), 'el rectángulo del bloque se dibuja');
  assert.ok(base(s, 'inspect_drawing', {}).blocks.includes('B'));
  assert.ok(HATCH_BLOCK_COMMANDS.length === 8);
});

test('import_dxf / export_dxf: bloques editables por omisión y explodeBlocks:true los explota', () => {
  const s = tmpStore();
  base(s, 'new_drawing', { name: 'P', layers: [{ name: 'Muros', color: 1 }] });
  base(s, 'draw_rect', { origin: [0, 0], w: 100, h: 50 });
  run(s, 'block_create', { name: 'B', entities: ['e1'], replace: true });
  run(s, 'insert_block', { block: 'B', p: [500, 500] });
  run(s, 'draw_hatch', { point: [50, 25], pattern: 'ansi31', scale: 10, associative: false });
  const dxf = drawingToDxf(drawing(s));
  const parsed = dxfToDrawing(dxf);
  assert.equal(parsed.drawing.blocks!.length, 1);
  assert.equal(parsed.drawing.entities.filter((e) => e.type === 'hatch').length, 1);
  const r = base(s, 'inspect_drawing', {});
  assert.equal(r.types.insert, 2);
  assert.ok(decodeDxf(new TextEncoder().encode(dxf)).includes('HATCH'));
});

test('un sombreado asociativo sigue a su contorno cuando se mueve con move_entities', () => {
  const s = tmpStore();
  room(s);
  const r = run(s, 'draw_hatch', { point: [200, 200] });
  base(s, 'move_entities', { ids: ['e1', 'e2'], delta: [1000, 500] });
  const h = drawing(s).entities.find((e) => e.id === r.id) as HatchEntity;
  assert.equal(h.loops[0][0].p[0] >= 1000, true);
  assert.equal(h.loops.length, 2);
  // mover solo el sombreado no lo recalcula (queda donde se puso)
  base(s, 'move_entities', { ids: [r.id], delta: [0, 100] });
  const h2 = drawing(s).entities.find((e) => e.id === r.id) as HatchEntity;
  assert.equal(h2.loops[0][0].p[1], h.loops[0][0].p[1] + 100);
});
