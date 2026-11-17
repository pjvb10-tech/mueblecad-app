import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultProject } from '../src/core/types';
import { createStore } from './store';
import { COMMANDS, applyDrawingBatch, drawingToSvg, runCommand } from './mcpDrawing';
import { createDrawing } from '../src/core/drawing';

const root = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
type Res = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: Res) => r.content.map((c) => c.text ?? '').join('\n');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-dibujo-'));
  const p = defaultProject();
  p.materials.push({ id: 'acero', name: 'Acero', thickness: 10, sheetW: 2400, sheetH: 1200, color: '#888888', grain: false });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p, null, 2));
  return { dir, store: createStore(dir) };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (s: ReturnType<typeof createStore>, name: string, args: Record<string, unknown> = {}): any => runCommand(s, name, args);

test('dibujar: formas de entrada, lotes todo-o-nada y dryRun', () => {
  const { store } = tmpStore();
  run(store, 'new_drawing', { name: 'Planta', plane: 'xz' });
  assert.throws(() => run(store, 'new_drawing', { name: 'planta' }), /Ya existe/);
  const r = run(store, 'draw_rect', { origin: [0, 0], w: 4000, h: 3000 });
  assert.deepEqual(r.ids, ['e1']);
  run(store, 'draw_circle', { c: [500, 500], d: 300 });
  run(store, 'draw_circle', { pts: [[0, 0], [10, 10], [20, 0]] });
  run(store, 'draw_arc', { pts: [[1000, 0], [1100, 100], [1200, 0]] });
  run(store, 'draw_arc', { c: [0, 0], r: 50, a0: 0, a1: 90 });
  run(store, 'draw_poly', { pts: [[0, 0], [100, 0], { p: [100, 50], bulge: 0.4 }], closed: true });
  run(store, 'draw_text', { p: [10, 10], h: 100, s: 'Sala', align: 'center' });
  run(store, 'draw_dim', { kind: 'linear', p1: [0, 0], p2: [4000, 0], at: [0, -300] });
  const n = run(store, 'inspect_drawing', {}).total;
  assert.equal(n, 8);

  // lote malo: no cambia nada y lista los problemas
  assert.throws(() => run(store, 'draw_line', { items: [{ a: [0, 0], b: [1, 1] }, { a: [0, 0], b: [0, 0] }, { a: [0, 0], b: [5, 5], layer: 'Nada' }] }), /Entidad #2.*mismo punto/s);
  assert.equal(run(store, 'inspect_drawing', {}).total, 8, 'todo o nada');
  assert.throws(() => run(store, 'draw_line', { a: [0, 0], b: [1, 1], items: [{ a: [0, 0], b: [1, 1] }] }), /no los dos/);
  assert.throws(() => run(store, 'draw_rect', { origin: [0, 0], w: 10, h: 0 }), /ancho o alto 0/);
  assert.throws(() => run(store, 'draw_line', { a: [0, 0], b: [1, 1], bogus: 1 }), /parámetros no válidos/);

  const dry = run(store, 'draw_line', { items: [{ a: [0, 0], b: [10, 0] }, { a: [0, 0], b: [0, 10] }], dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(run(store, 'inspect_drawing', {}).total, 8, 'dryRun no guarda');
  assert.equal(run(store, 'draw_line', { items: [{ a: [0, 0], b: [10, 0] }, { a: [0, 0], b: [0, 10] }] }).count, 2);
});

test('lote de dibujo, edición, capas y consultas', () => {
  const { store } = tmpStore();
  run(store, 'new_drawing', { name: 'A' });
  const b = run(store, 'drawing_batch', { add: [{ type: 'rect', p1: [0, 0], p2: [400, 300] }, { type: 'circle', c: [200, 150], r: 50 }, { type: 'text', p: [0, 320], h: 30, s: 'Mesa grande' }] });
  assert.deepEqual(b.added, ['e1', 'e2', 'e3']);
  assert.throws(() => run(store, 'drawing_batch', { add: [{ type: 'line', a: [0, 0], b: [1, 1] }, { type: 'circle', c: [0, 0], r: -2 }], update: [{ id: 'zz', r: 3 }], remove: ['e1'] }),
    (e: Error) => /no se aplicó/.test(e.message) && /add\[1\] circle/.test(e.message) && /update\[0\] zz/.test(e.message));
  assert.equal(run(store, 'inspect_drawing', {}).total, 3);

  run(store, 'layer_new', { name: 'Cotas', color: 3, linetype: 'center' });
  assert.throws(() => run(store, 'layer_new', { name: 'cotas' }), /ya existe/);
  run(store, 'update_entity', { id: 'e2', patch: { layer: 'Cotas', r: 60, color: 1 } });
  run(store, 'update_entity', { id: 'e2', patch: { color: null } });
  assert.throws(() => run(store, 'update_entity', { id: 'e2', patch: { type: 'line' } }), /id ni el type/);
  run(store, 'layer_set', { name: 'Cotas', rename: 'Cotas2', locked: true });
  assert.throws(() => run(store, 'move_entities', { ids: ['e2'], delta: [1, 1] }), /bloqueada/);
  run(store, 'layer_set', { name: 'Cotas2', locked: false });
  run(store, 'move_entities', { ids: 'e2', delta: [10, 0] });
  const cp = run(store, 'copy_entities', { ids: ['e2'], delta: [100, 0], count: 3 });
  assert.equal(cp.count, 3);
  run(store, 'rotate_entities', { ids: ['e1'], center: [0, 0], angle: 90 });
  run(store, 'scale_entities', { ids: ['e1'], center: [0, 0], factor: 2 });
  assert.throws(() => run(store, 'scale_entities', { ids: ['e1'], center: [0, 0], factor: -1 }), /parámetros no válidos/);
  const off = run(store, 'offset_entity', { id: 'e2', distance: 10 });
  assert.match(off.id, /^e\d+$/);
  run(store, 'remove_entity', { ids: cp.ids });
  assert.throws(() => run(store, 'remove_entity', { id: 'nada' }), /no existe la entidad/);

  const q = run(store, 'query_entities', { type: 'circle' });
  assert.equal(q.total, 2); // e2 y su offset
  const win = run(store, 'query_entities', { window: [-1000, -1000, 5, 5] });
  assert.equal(win.total, 0);
  assert.equal(run(store, 'query_entities', { window: [-10, -10, 5, 5], crossing: true }).total, 1);
  assert.equal(run(store, 'query_entities', { layer: 'Cotas2' }).total, 2);
  assert.equal(run(store, 'query_entities', { limit: 1, offset: 1 }).entities.length, 1);
  assert.equal(run(store, 'find_text', { contains: 'GRANDE' }).total, 1);

  const m = run(store, 'measure_shapes', { ids: ['e1', 'e2'] });
  assert.equal(m.shapes[0].area, 400 * 300 * 4, 'rect escalado ×2: 800×600... (área ×4)');
  assert.ok(Math.abs(m.shapes[1].area - Math.PI * 60 * 60) < 0.01);
  assert.equal(m.closed, 2);
  assert.throws(() => run(store, 'layer_remove', { name: 'Cotas2' }), /tiene 2 entidad/);
});

test('render SVG, guardado en export/ y extrusión a sólido y vuelta', () => {
  const { store, dir } = tmpStore();
  run(store, 'new_drawing', { name: 'Planta', plane: 'xz', origin: [100, 0, 50] });
  run(store, 'draw_rect', { p1: [0, 0], p2: [400, 300] });
  run(store, 'draw_circle', { c: [100, 100], r: 40 });
  run(store, 'draw_poly', { pts: [[0, 0], [10, 10]] });
  run(store, 'draw_dim', { kind: 'linear', p1: [0, 0], p2: [400, 0], at: [0, -50] });
  run(store, 'draw_text', { p: [0, 0], h: 20, s: 'A<B' });
  const r = run(store, 'render_drawing', { save: true, filename: '../malo/x.svg' });
  assert.match(r.svg, /^<svg /);
  assert.match(r.svg, /A&lt;B/);
  assert.ok(r.file.startsWith(path.join(dir, 'export')) && fs.existsSync(r.file), 'se guarda dentro de export/');
  assert.ok(!run(store, 'render_drawing', { returnSvg: false }).svg);

  const ex = run(store, 'extrude_entity', { entities: ['e1', 'e2'], depth: 500, material: 'acero', name: 'Bloque' });
  assert.equal(ex.parts.length, 2);
  assert.equal(ex.parts[0].form, 'prism');
  assert.equal(ex.parts[1].form, 'cylinder');
  assert.deepEqual(ex.parts[0].size, [400, 500, 300]);
  assert.deepEqual(ex.parts[0].position, [100, 0, 50 - 300], 'planta: v hacia -Z');
  assert.throws(() => run(store, 'extrude_entity', { entity: 'e3', depth: 10, material: 'acero' }), /está abierta/);
  assert.throws(() => run(store, 'extrude_entity', { entity: 'e1', depth: 10, material: 'nope' }), /Material desconocido/);
  assert.throws(() => run(store, 'extrude_entity', { entity: 'e1', depth: 0, material: 'acero' }), /distinto de 0/);
  const saved = store.readProject().project;
  assert.equal(saved.parts.length, 2);

  // dryRun no crea piezas
  run(store, 'extrude_entity', { entity: 'e1', depth: 5, material: 'acero', dryRun: true });
  assert.equal(store.readProject().project.parts.length, 2);

  const back = run(store, 'part_to_drawing', { part: ex.parts[1].id });
  assert.equal(back.plane, 'xz');
  const list = run(store, 'list_drawings');
  assert.equal(list.length, 2);
  assert.equal(run(store, 'get_drawing', { drawing: back.drawing }).entities[0].type, 'circle');
  run(store, 'remove_drawing', { drawing: back.drawing });
  assert.equal(run(store, 'list_drawings').length, 1);
  assert.throws(() => run(store, 'inspect_drawing', { drawing: 'nope' }), /No existe el dibujo/);
  // sin drawing hay varios -> pide cuál
  run(store, 'new_drawing', { name: 'B' });
  assert.throws(() => run(store, 'inspect_drawing', {}), /Indica "drawing"/);
});

test('proyecto: respaldo antes de escribir y dibujos no tocan las piezas', () => {
  const { store } = tmpStore();
  run(store, 'new_drawing', { name: 'A' });
  run(store, 'draw_line', { a: [0, 0], b: [1, 1] });
  assert.ok(fs.readdirSync(store.backupDir).some((n) => n.startsWith('sesion-')), 'hay respaldo de sesión');
  const p = store.readProject().project;
  assert.equal(p.parts.length, 0);
  assert.equal(p.drawings!.length, 1);
});

test('applyDrawingBatch y drawingToSvg directos', () => {
  const d = createDrawing('X');
  const r = applyDrawingBatch(d, { add: [{ type: 'line', a: [0, 0], b: [10, 0] }, { type: 'arc', c: [0, 0], r: 5, a0: 0, a1: 90 }] });
  assert.equal(r.drawing.entities.length, 2);
  const svg = drawingToSvg(r.drawing, { width: 500 });
  assert.match(svg, /<polyline/);
  assert.match(svg, /width="500"/);
  assert.match(drawingToSvg(createDrawing('Vacío')), /^<svg/);
});

test('MCP (stdio): herramientas de dibujo, drawing_execute y drawing_list_commands', { timeout: 120_000 }, async () => {
  const { dir } = tmpStore();
  const client = new Client({ name: 'dibujo', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [tsxCli, path.join(root, 'server', 'mcp.ts')], cwd: root,
    env: { ...(process.env as Record<string, string>), MUEBLECAD_DATA: dir }, stderr: 'pipe',
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Res;
  const ok = async (name: string, args: Record<string, unknown> = {}) => { const r = await call(name, args); assert.ok(!r.isError, `${name}: ${textOf(r)}`); return JSON.parse(textOf(r)); };
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const c of COMMANDS) assert.ok(tools.some((t) => t.name === c.name), `falta ${c.name}`);
    for (const n of ['drawing_batch', 'drawing_execute', 'drawing_list_commands']) assert.ok(tools.some((t) => t.name === n), `falta ${n}`);
    assert.match(tools.find((t) => t.name === 'draw_circle')!.description ?? '', /\[ESCRIBE/);
    assert.match(tools.find((t) => t.name === 'query_entities')!.description ?? '', /SOLO LECTURA/);

    const nd = await ok('new_drawing', { name: 'Fachada', plane: 'xy' });
    assert.equal(nd.id, 'd1');
    const c = await ok('draw_circle', { c: [0, 0], d: 100 });
    assert.deepEqual(c.ids, ['e1']);
    const bad = await call('draw_line', { a: [0, 0], b: [0, 0] });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /mismo punto/);

    const cmds = await ok('drawing_list_commands', { command: 'draw_rect' });
    assert.equal(cmds[0].command, 'draw_rect');
    assert.ok(cmds[0].parametros.p1);
    const all = await ok('drawing_list_commands');
    assert.ok(all.length >= COMMANDS.length);
    const ex = await ok('drawing_execute', { command: 'draw_rect', params: { p1: [0, 0], p2: [200, 100] } });
    assert.equal(ex.count, 1);
    const rd = await ok('drawing_execute', { command: 'measure_shapes', params: {} });
    assert.equal(rd.closed, 2);
    const unknown = await call('drawing_execute', { command: 'nada', params: {} });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /No existe el comando/);
    const e = await ok('extrude_entity', { entity: 'e2', depth: 18, material: 'acero' });
    assert.equal(e.parts[0].form, 'prism');
    assert.ok(fs.readFileSync(path.join(dir, 'actividad.json'), 'utf8').includes('extrude_entity'), 'queda en la actividad');
    const svg = await ok('render_drawing', {});
    assert.match(svg.svg, /<svg/);
  } finally {
    await client.close().catch(() => {});
  }
});
