import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { projectWithRoom, TINY_PNG } from '../src/core/testPlan';

const root = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

type Res = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: Res) => r.content.map((c) => c.text ?? '').join('\n');

test('MCP de punta a punta (stdio): herramientas, texturas, acabados, habitaciones, mueble con barra y respaldos', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-mcp-'));
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-img-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(projectWithRoom(), null, 2));
  fs.writeFileSync(path.join(dir, 'project.json.bak2'), 'copia manual');
  const png = path.join(src, 'baldosa-gris.png');
  fs.writeFileSync(png, TINY_PNG);
  const fake = path.join(src, 'falsa.png');
  fs.writeFileSync(fake, 'esto es texto y no una imagen, aunque se llame png');

  const client = new Client({ name: 'smoke', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [tsxCli, path.join(root, 'server', 'mcp.ts')], cwd: root,
    env: { ...(process.env as Record<string, string>), MUEBLECAD_DATA: dir }, stderr: 'pipe',
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Res;
  const ok = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    assert.ok(!r.isError, `${name}: ${textOf(r)}`);
    return textOf(r);
  };
  try {
    await client.connect(transport);

    // herramientas: las nuevas y las viejas, con marca de lectura/escritura
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['list_textures', 'add_texture', 'update_texture', 'remove_texture', 'set_finish', 'clear_finish', 'get_finishes', 'estimate_tiles', 'list_rooms', 'describe_room', 'list_openings', 'set_room_name', 'set_edge_round', 'add_cabinet', 'resize_furniture', 'get_project', 'optimize_cuts', 'list_backups', 'restore_backup']) assert.ok(names.includes(n), `falta ${n}`);
    assert.equal(tools.find((t) => t.name === 'list_textures')!.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'set_finish')!.annotations?.readOnlyHint, false);
    assert.match(tools.find((t) => t.name === 'set_finish')!.description ?? '', /^\[ESCRIBE/);
    assert.match(tools.find((t) => t.name === 'get_finishes')!.description ?? '', /^\[SOLO LECTURA/);

    // texturas
    assert.deepEqual(JSON.parse(await ok('list_textures')), []);
    const added = JSON.parse(await ok('add_texture', { path: png, nombre: 'Gris 60x60', categoria: 'porcelanato', w: 600, h: 600, junta: 3 }));
    assert.equal(added.item.id, 'gris-60x60');
    assert.ok(fs.existsSync(path.join(dir, 'texturas', 'baldosa-gris.png')));
    assert.match(textOf(await call('add_texture', { path: fake })), /firma de archivo/);
    assert.equal((await call('add_texture', { path: fake })).isError, true);
    assert.equal((await call('add_texture', { path: png, color: '#ffffff' })).isError, true, 'dos fuentes a la vez');
    assert.match(textOf(await call('add_texture', { path: 'relativa.png' })), /absoluta/);
    await ok('add_texture', { color: '#f4f3ef', nombre: 'Pintura blanca' });
    await ok('add_texture', { base64: TINY_PNG.toString('base64'), filename: 'otra.png', nombre: 'Otra' });
    assert.equal(JSON.parse(await ok('list_textures')).length, 3);
    await ok('update_texture', { id: 'gris-60x60', junta: 5 });

    // habitaciones
    const rooms = JSON.parse(await ok('list_rooms'));
    assert.equal(rooms.habitaciones[0].id, 'H1');
    const d = JSON.parse(await ok('describe_room', { room: 'H1' }));
    assert.equal(d.muros.length, 4);
    assert.equal(JSON.parse(await ok('list_openings'))[0].id, 'D1');
    assert.match(textOf(await call('describe_room', { room: 'H9' })), /No existe la habitación H9/);
    await ok('set_room_name', { room: 'H1', name: 'Cocina' });

    // acabados
    await ok('set_finish', { room: 'H1', surface: 'floor', texture: 'gris-60x60' });
    await ok('set_finish', { room: 'H1', surface: 'walls', texture: 'pintura-blanca', altura: 1200, sides: { norte: { texture: 'gris-60x60' } } });
    const fin = JSON.parse(await ok('get_finishes'));
    assert.equal(fin.acabados[0].name, 'Cocina');
    assert.equal(fin.acabados[0].floor.junta, 5);
    assert.equal(fin.acabados[0].walls.altura, 1200);
    assert.equal(fin.acabados[0].walls.lados.norte.textura, 'gris-60x60');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).finishes.H1.floor.tex, 'gris-60x60');
    assert.match(textOf(await call('set_finish', { room: 'H1', surface: 'floor', texture: 'no-existe' })), /no está en la biblioteca/);
    assert.equal((await call('set_finish', { room: 'H1', surface: 'floor', texture: 'gris-60x60', junta: 99 })).isError, true);
    const est = JSON.parse(await ok('estimate_tiles', { room: 'H1', surface: 'floor', pricePerTile: 10, reservePct: 10 }));
    assert.equal(est.enteras + est.losasParaRecortes, est.total);
    assert.equal(est.costo, est.total * 10);
    assert.ok(est.totalConReserva >= est.total);
    const estM = JSON.parse(await ok('estimate_tiles', { room: 'H1', surface: 'walls', texture: 'gris-60x60', sides: ['norte', 'sur'], altura: 1200 }));
    assert.ok(estM.areaM2 > 0);

    // no se puede quitar una textura en uso
    assert.match(textOf(await call('remove_texture', { id: 'gris-60x60' })), /la usan los acabados de H1/);
    await ok('clear_finish', { room: 'H1' });
    assert.equal(JSON.parse(await ok('get_finishes')).acabados.length, 0);
    assert.match(await ok('remove_texture', { id: 'gris-60x60' }), /fileDeleted": true/);
    assert.ok(!fs.existsSync(path.join(dir, 'texturas', 'baldosa-gris.png')));

    // mueble con barra de colgar, entrepaños fijos y frente espejado; canto redondeado
    await ok('add_material', { id: 'tubo', name: 'Tubo cromado', thickness: 25, sheetW: 1, sheetH: 1, purchased: true });
    const cab = await ok('add_cabinet', { name: 'Closet', width: 3000, height: 2200, depth: 600, rods: [1700], rodMaterial: 'tubo', shelfAt: [400, 900], faceBack: true, doors: 3, doorMaterial: 'frente' });
    assert.match(cab, /barra de colgar/);
    assert.match(textOf(await call('add_cabinet', { name: 'Closet', width: 500, height: 500, depth: 500 })), /Ya existe/);
    assert.match(textOf(await call('add_cabinet', { name: 'Malo', width: 500, height: 500, depth: 500, rods: [900] })), /fuera del mueble/);
    await ok('resize_furniture', { group: 'Closet', rods: [1600, 1900] });
    const furniture = JSON.parse(await ok('list_furniture'));
    assert.equal(furniture[0].spec.faceBack, true);
    const part = JSON.parse(await ok('get_project')).parts.find((p: { name: string }) => p.name === 'Closet tapa');
    assert.match(textOf(await call('set_edge_round', { id: part.id, edge: 0, radius: 10 })), /máximo de "Closet tapa" es 9 mm/);
    await ok('set_edge_round', { id: part.id, edge: 0, radius: 9 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).parts.find((p: { id: string }) => p.id === part.id).shape, { edgeRound: { edge: 0, radius: 9 } });

    // get_project resume el plano por omisión
    const proj = JSON.parse(await ok('get_project'));
    assert.equal(proj.plan.habitaciones, 1);
    assert.equal(proj.plan.lines, undefined);
    assert.ok(JSON.parse(await ok('get_project', { full: true })).plan.walls.length > 0);

    // respaldos: existen, son JSON válidos y no se tocó la copia manual
    const backups = JSON.parse(await ok('list_backups'));
    assert.ok(backups.length >= 2);
    assert.ok(backups.some((b: { name: string }) => b.name.startsWith('sesion-')));
    assert.equal(fs.readFileSync(path.join(dir, 'project.json.bak2'), 'utf8'), 'copia manual');
    const first = backups.find((b: { name: string }) => b.name.startsWith('sesion-')).name;
    assert.ok(Array.isArray(JSON.parse(fs.readFileSync(path.join(dir, 'respaldos', first), 'utf8')).parts));
    await ok('restore_backup', { name: first });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).finishes, undefined);
    assert.match(textOf(await call('restore_backup', { name: '../project.json' })), /no válido/);

    // nada fuera de la carpeta de datos
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), []);
  } finally {
    await client.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
});
