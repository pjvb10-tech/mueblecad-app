import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { defaultProject, type Project } from '../src/core/types';
import { addCabinet } from '../src/core/furniture';
import { createStore } from './store';
import { applyBatch, createPart, patchPart } from './mcpParts';

const root = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
type Res = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: Res) => r.content.map((c) => c.text ?? '').join('\n');

function project(): Project {
  const p = defaultProject();
  p.materials.push({ id: 'acero', name: 'Acero', thickness: 3, sheetW: 6000, sheetH: 50, color: '#8a8f98', grain: false, purchased: true });
  addCabinet(p, { name: 'Base 1', width: 800, height: 720, depth: 560, doors: 2 });
  return p;
}

test('lote: todo o nada, mensajes con índice, ids nuevos y un solo guardado', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-lote-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project(), null, 2));
  const store = createStore(dir);
  const original = fs.readFileSync(store.projectFile, 'utf8');
  const n0 = store.readProject().project.parts.length;

  // un lote con errores en medio no cambia nada y los lista todos
  assert.throws(() => store.updateProject((p) => applyBatch(p, {
    add: [
      { name: 'Poste', material: 'acero', form: 'tube', size: [50, 1000, 50], wall: 3, position: [0, 0, 0] },
      { name: 'Malo', material: 'acero', form: 'tube', size: [50, 1000, 50], wall: 30, position: [0, 0, 0] },
      { name: 'Peor', material: 'inexistente', size: [1, 1, 1], position: [0, 0, 0] },
    ],
    update: [{ id: 'zzz', position: [1, 1, 1] }],
    remove: ['p1'],
  })), (e: Error) => /no se aplicó/.test(e.message) && /add\[1\] Malo.*espesor de pared/.test(e.message) && /add\[2\] Peor.*Material desconocido/.test(e.message) && /update\[0\] zzz.*No existe/.test(e.message));
  assert.equal(fs.readFileSync(store.projectFile, 'utf8'), original, 'el archivo quedó intacto');

  // un lote bueno: borra, actualiza y agrega
  const res = store.updateProject((p) => applyBatch(p, {
    remove: ['p1'],
    update: [{ id: 'p2', rotZ: 15.5, name: 'Lateral girado' }],
    add: [
      { name: 'Poste', group: 'Portón', material: 'acero', form: 'tube', size: [50, 1000, 50], wall: 3, position: [0, 0, 0] },
      { name: 'Cuña', group: 'Portón', material: 'acero', form: 'prism', axis: 'z', profile: [[0, 0], [400, 0], [270, 1800], [0, 1800]], length: 400, position: [0, 0, 0] },
      { name: 'Rueda', group: 'Portón', material: 'acero', form: 'revolve', profile: [[0, 0], [60, 0], [60, 8], [52, 10], [60, 12], [60, 20], [0, 20]], position: [0, 0, 0] },
    ],
  }));
  assert.deepEqual(res.removed, ['p1']);
  assert.deepEqual(res.updated, ['p2']);
  assert.equal(res.added.length, 3);
  assert.equal(res.total, n0 - 1 + 3);
  const saved = store.readProject().project;
  const cuna = saved.parts.find((p) => p.name === 'Cuña')!;
  assert.deepEqual(cuna.size, [400, 1800, 400], 'size deducido del perfil y length');
  const rueda = saved.parts.find((p) => p.name === 'Rueda')!;
  assert.deepEqual(rueda.size, [120, 20, 120], 'size deducido del perfil de revolución');
  assert.equal(saved.parts.find((p) => p.id === 'p2')!.rotZ, 15.5);
  assert.equal(new Set(saved.parts.map((p) => p.id)).size, saved.parts.length, 'ids únicos');
  assert.ok(fs.readdirSync(store.backupDir).filter((n) => n.startsWith('project-')).length <= 1, 'un solo respaldo por lote');
});

test('add/update: null quita campos y cambiar de forma suelta los parámetros de la anterior', () => {
  const p = project();
  const tube = createPart(p, { name: 'T', material: 'acero', form: 'tube', size: [50, 1000, 50], wall: 3, cornerRadius: 5, rotX: 0, position: [0, 0, 0] });
  assert.ok(!('rotX' in tube), 'el giro 0 no se guarda');
  p.parts.push(tube);
  patchPart(p, tube, { rotZ: 30 });
  assert.equal(tube.rotZ, 30);
  patchPart(p, tube, { rotZ: null });
  assert.ok(!('rotZ' in tube));
  patchPart(p, tube, { form: 'cylinder', size: [50, 1000, 50] });
  assert.equal(tube.form, 'cylinder');
  assert.ok(!('cornerRadius' in tube), 'cornerRadius era de tube');
  assert.equal(tube.wall, 3);
  assert.throws(() => patchPart(p, tube, { wall: 40 }), /espesor de pared/);
  assert.equal(tube.wall, 3, 'un cambio inválido no deja nada a medias');
  patchPart(p, tube, { form: 'box' });
  assert.deepEqual(Object.keys(tube).sort(), ['id', 'material', 'name', 'position', 'size']);
  // una actualización de siempre sobre una caja de siempre deja el mismo objeto
  const lat = p.parts.find((q) => q.name.includes('lateral'))!;
  const before = JSON.stringify(lat);
  patchPart(p, lat, { name: lat.name });
  assert.equal(JSON.stringify(lat), before);
});

test('MCP (stdio): add_part, update_part, batch_parts, list_parts y get_solids', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-mcpparts-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project(), null, 2));
  const client = new Client({ name: 'parts', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [tsxCli, path.join(root, 'server', 'mcp.ts')], cwd: root,
    env: { ...(process.env as Record<string, string>), MUEBLECAD_DATA: dir }, stderr: 'pipe',
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Res;
  const ok = async (name: string, args: Record<string, unknown> = {}) => { const r = await call(name, args); assert.ok(!r.isError, `${name}: ${textOf(r)}`); return JSON.parse(textOf(r)); };
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    for (const n of ['add_part', 'update_part', 'batch_parts', 'list_parts', 'get_solids']) assert.ok(tools.some((t) => t.name === n), `falta ${n}`);
    const batch = tools.find((t) => t.name === 'batch_parts')!;
    assert.match(batch.description ?? '', /Ejemplo/);
    assert.match(batch.description ?? '', /todo-o-nada/);
    const props = (batch.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok('add' in props && 'update' in props && 'remove' in props && 'dryRun' in props);
    const addProps = (tools.find((t) => t.name === 'add_part')!.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    for (const k of ['rotX', 'rotY', 'rotZ', 'form', 'axis', 'wall', 'cornerRadius', 'profile', 'segments']) assert.ok(addProps[k]?.description, `${k} sin descripción`);

    const tube = await ok('add_part', { name: 'Tubo 50x50x3', group: 'Portón', material: 'acero', form: 'tube', size: [50, 1000, 50], axis: 'y', wall: 3, position: [0, 0, 0] });
    assert.equal(tube.form, 'tube');
    const bad = await call('add_part', { name: 'Tubo malo', material: 'acero', form: 'tube', size: [50, 1000, 50], wall: 26, position: [0, 0, 0] });
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /espesor de pared/);
    const poly = await call('add_part', { name: 'Poligono', material: 'acero', form: 'prism', size: [10, 10, 10], profile: [[0, 0], [5, 5]], position: [0, 0, 0] });
    assert.equal(poly.isError, true);

    const upd = await ok('update_part', { id: tube.id, rotZ: 20, rotY: 10 });
    assert.equal(upd.rotZ, 20);
    const back = await ok('update_part', { id: tube.id, rotZ: null, rotY: null });
    assert.ok(!('rotZ' in back) && !('rotY' in back));

    const dry = await ok('batch_parts', { dryRun: true, add: [{ name: 'X', material: 'acero', form: 'cylinder', size: [80, 12, 12], axis: 'x', position: [0, 0, 0] }] });
    assert.equal(dry.dryRun, true);
    assert.equal((await ok('list_parts', { form: 'cylinder' })).total, 0, 'dryRun no guarda');

    const unknownKey = await call('batch_parts', { add: [{ name: 'X', material: 'acero', size: [1, 1, 1], position: [0, 0, 0], giro: 5 }] });
    assert.equal(unknownKey.isError, true, 'campos desconocidos se rechazan en el lote');

    const lote = await ok('batch_parts', { add: Array.from({ length: 40 }, (_, i) => ({ name: `Diagonal ${i}`, group: 'Portón', material: 'acero', form: 'tube', size: [50, 800, 50], wall: 3, position: [i * 60, 0, 0], rotZ: i * 1.5 })), update: [{ id: tube.id, position: [5, 5, 5] }] });
    assert.equal(lote.added.length, 40);
    const list = await ok('list_parts', { form: 'tube', limit: 5 });
    assert.equal(list.total, 41);
    assert.equal(list.parts.length, 5);
    const d10 = (await ok('list_parts', { name: 'diagonal 10' })).parts[0];
    assert.deepEqual(d10.rot, [0, 0, 15]);
    assert.ok(d10.boundsMax[0] - d10.boundsMin[0] > 50, 'la caja envolvente incluye el giro');

    const solids = await ok('get_solids');
    assert.equal(solids.piezas, 41);
    assert.ok(solids.filas.some((f: { description: string }) => f.description === 'tubo 50×50×3, largo 800'));
    // el despiece no sabe de los sólidos: las cajas de siempre y nada más
    assert.ok(!JSON.stringify(await ok('get_cutlist')).includes('Diagonal'));
    assert.ok(!JSON.stringify(await ok('optimize_cuts')).includes('Diagonal'));
  } finally {
    await client.close().catch(() => {});
  }
});
