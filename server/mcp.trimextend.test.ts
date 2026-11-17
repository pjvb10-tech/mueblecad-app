import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultProject } from '../src/core/types';
import { createStore } from './store';
import { listCommands, runCommand } from './mcpDrawing';
import { runTrimExtend } from './mcpTrimExtend';
import './mcpHatchBlocks'; // registra draw_hatch, block_* en drawing_execute

const root = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
type Res = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: Res) => r.content.map((c) => c.text ?? '').join('\n');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-recortar-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(defaultProject(), null, 2));
  return { dir, store: createStore(dir) };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (s: ReturnType<typeof createStore>, name: string, args: Record<string, unknown> = {}): any => runCommand(s, name, args);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const trim = (s: ReturnType<typeof createStore>, args: Record<string, unknown>): any => runTrimExtend(s, 'trim', args as never);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const extend = (s: ReturnType<typeof createStore>, args: Record<string, unknown>): any => runTrimExtend(s, 'extend', args as never);

function setup() {
  const t = tmpStore();
  run(t.store, 'new_drawing', { name: 'Plano' });
  run(t.store, 'draw_line', { items: [{ a: [0, 0], b: [100, 0] }, { a: [30, -10], b: [30, 10] }, { a: [70, -10], b: [70, 10] }] });
  return t;
}

test('trim_entity: recorta, parte en dos con id nuevo y guarda con respaldo', () => {
  const { store } = setup();
  const r = trim(store, { entity: 'e1', point: [50, 0], boundaries: ['e2', 'e3'] });
  assert.equal(r.action, 'recortar');
  assert.equal(r.kept, 'e1');
  assert.deepEqual(r.added, ['e4']);
  const d = run(store, 'get_drawing', {});
  assert.equal(d.entities.length, 4);
  assert.deepEqual(d.entities.find((e: { id: string }) => e.id === 'e1').b, [30, 0]);
  assert.ok(store.listBackups().length >= 1, 'hubo respaldo antes de escribir');
});

test('trim_entity: dryRun no guarda; all = todos los bordes; errores claros', () => {
  const { store } = setup();
  const dry = trim(store, { entity: 'e1', point: [50, 0], all: true, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(run(store, 'inspect_drawing', {}).total, 3);
  assert.throws(() => trim(store, { entity: 'e1', point: [50, 0], boundaries: ['e2'], all: true }), /no los dos/);
  assert.throws(() => trim(store, { entity: 'e2', point: [30, 5], boundaries: ['e3'] }), /no hay intersección/);
  assert.throws(() => trim(store, { entity: 'zz', point: [0, 0] }), /no existe/);
  assert.throws(() => trim(store, { entity: 'e1', point: [0], boundaries: ['e2'] }), /parámetros no válidos/);
  assert.equal(run(store, 'inspect_drawing', {}).total, 3, 'los errores no cambian nada');
  assert.equal(trim(store, { entity: 'e1', point: [50, 0] }).added.length, 1); // sin boundaries = todos
});

test('trim_entity: círculo -> arco con el mismo id; capa bloqueada rechaza', () => {
  const { store } = tmpStore();
  run(store, 'new_drawing', { name: 'Plano' });
  run(store, 'layer_new', { name: 'Fija' });
  run(store, 'draw_circle', { c: [0, 0], r: 10 });
  run(store, 'draw_line', { items: [{ a: [-20, 0], b: [20, 0] }, { a: [0, -20], b: [0, 20] }] });
  const r = trim(store, { entity: 'e1', point: [7, 7], boundaries: ['e2', 'e3'] });
  assert.equal(r.convertedTo, 'arc');
  assert.equal(run(store, 'get_drawing', {}).entities.find((e: { id: string }) => e.id === 'e1').type, 'arc'); // al final del orden de apilado, mismo id
  run(store, 'draw_line', { a: [0, 5], b: [100, 5], layer: 'Fija' });
  run(store, 'layer_set', { name: 'Fija', locked: true });
  assert.throws(() => trim(store, { entity: 'e4', point: [50, 5], boundaries: ['e3'] }), /bloqueada/);
  assert.throws(() => extend(store, { entity: 'e4', point: [50, 5], boundaries: ['e3'] }), /bloqueada/);
});

test('extend_entity: alarga hasta el borde; modo extendido; dryRun', () => {
  const { store } = tmpStore();
  run(store, 'new_drawing', { name: 'Plano' });
  run(store, 'draw_line', { items: [{ a: [0, 0], b: [10, 0] }, { a: [100, 10], b: [100, 30] }] });
  assert.throws(() => extend(store, { entity: 'e1', point: [9, 0], boundaries: ['e2'] }), /no hay intersección/);
  const dry = extend(store, { entity: 'e1', point: [9, 0], boundaries: ['e2'], edgeMode: 'extendido', dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.deepEqual(run(store, 'get_drawing', {}).entities[0].b, [10, 0]);
  const r = extend(store, { entity: 'e1', point: [9, 0], boundaries: ['e2'], edgeMode: 'extendido' });
  assert.equal(r.action, 'extender');
  assert.deepEqual(run(store, 'get_drawing', {}).entities[0].b, [100, 0]);
});

test('MCP (stdio): trim_entity y extend_entity quedan registradas', { timeout: 120_000 }, async () => {
  const { dir } = setup();
  const client = new Client({ name: 'recortar', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [tsxCli, path.join(root, 'server', 'mcp.ts')], cwd: root,
    env: { ...(process.env as Record<string, string>), MUEBLECAD_DATA: dir }, stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const n of ['trim_entity', 'extend_entity']) assert.match(tools.find((t) => t.name === n)?.description ?? '', /\[ESCRIBE/, n);
    const r = (await client.callTool({ name: 'trim_entity', arguments: { entity: 'e1', point: [50, 0], boundaries: ['e2', 'e3'] } })) as Res;
    assert.ok(!r.isError, textOf(r));
    assert.deepEqual(JSON.parse(textOf(r)).added, ['e4']);
    const bad = (await client.callTool({ name: 'extend_entity', arguments: { entity: 'e1', point: [29, 0], boundaries: ['e3'], edgeMode: 'normal' } })) as Res;
    assert.ok(!bad.isError, textOf(bad)); // e1 = [0..30] se alarga hasta e3 (x=70)
    assert.match(textOf(bad), /"entity": "e1"/);
    const err = (await client.callTool({ name: 'trim_entity', arguments: { entity: 'nope', point: [0, 0] } })) as Res;
    assert.equal(err.isError, true);
  } finally { await client.close().catch(() => undefined); }
});

test('trim_entity y sombreados/bloques: registrados como comandos, sin tocar inserts y el sombreado asociativo se recalcula', () => {
  const { store } = tmpStore();
  run(store, 'new_drawing', { name: 'Plano' });
  run(store, 'draw_rect', { p1: [0, 0], p2: [100, 100] });                       // e1 (poly cerrada)
  run(store, 'draw_line', { items: [{ a: [30, -20], b: [30, 120] }, { a: [70, -20], b: [70, 120] }] }); // e2, e3
  run(store, 'draw_hatch', { entities: ['e1'], pattern: 'lines' });              // e4 asociado a e1
  const names = listCommands().map((c) => c.command);
  for (const n of ['trim_entity', 'extend_entity', 'draw_hatch', 'block_create', 'insert_block']) assert.ok(names.includes(n), `falta ${n} en drawing_list_commands`);
  run(store, 'block_create', { name: 'B', entities: ['e2'], replace: true });
  const ins = run(store, 'insert_block', { block: 'B', p: [200, 0] });
  const d0 = run(store, 'get_drawing', {});
  assert.ok(d0.entities.some((e: { id: string }) => e.id === ins.id));
  assert.throws(() => run(store, 'trim_entity', { entity: ins.id, point: [200, 0], boundaries: ['e3'] }), /bloque insertado/);
  assert.throws(() => run(store, 'trim_entity', { entity: 'e1', point: [50, 0], boundaries: [ins.id] }), /bloque insertado/);
  run(store, 'trim_entity', { entity: 'e1', point: [90, 50], boundaries: ['e3'] });
  const h = run(store, 'get_drawing', {}).entities.find((e: { type: string }) => e.type === 'hatch');
  assert.ok(h.loops.length === 1 && !h.source, 'el sombreado conserva su contorno y deja de ser asociativo al abrirse el origen');
});
