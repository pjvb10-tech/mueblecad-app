import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultProject } from '../src/core/types';
import { createStore } from './store';
import { registerDrawingIoTools } from './mcpDrawingIO';
import { parseScale } from '../src/core/pdfDrawing';
import { runCommand } from './mcpDrawing';
import type { Kit } from './mcpKit';

type Fn = (a: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-dio-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(defaultProject()));
  const store = createStore(dir);
  const tools = new Map<string, Fn>();
  const reg = (name: string, _d: string, _s: unknown, fn: Fn) => { tools.set(name, fn); };
  registerDrawingIoTools({ read: reg, write: reg, files: reg } as unknown as Kit, store, dir);
  return { dir, store, tools };
}

test('parseScale: fit, 1:50, número y error', () => {
  assert.equal(parseScale('fit'), 'fit');
  assert.equal(parseScale('1:50'), 1 / 50);
  assert.equal(parseScale(0.02), 0.02);
  assert.throws(() => parseScale('grande'), /Escala no válida/);
});

test('export_dxf / import_dxf / export_pdf: ida y vuelta por archivos', () => {
  const { dir, store, tools } = setup();
  runCommand(store, 'new_drawing', { name: 'Mesa' });
  runCommand(store, 'draw_rect', { origin: [0, 0], w: 1200, h: 600 });
  runCommand(store, 'draw_circle', { c: [600, 300], d: 100 });

  const ex = tools.get('export_dxf')!({});
  assert.deepEqual(ex.files, ['Mesa.dxf']);
  assert.ok(fs.readFileSync(path.join(dir, 'export', 'Mesa.dxf'), 'utf8').includes('AC1015'));

  // import_dxf solo lee de <datos>/importar
  fs.mkdirSync(path.join(dir, 'importar'));
  fs.copyFileSync(path.join(dir, 'export', 'Mesa.dxf'), path.join(dir, 'importar', 'mesa.dxf'));
  const im = tools.get('import_dxf')!({ path: 'mesa.dxf' });
  assert.equal(im.entities, 2);
  assert.equal(store.readProject().project.drawings?.length, 2);
  assert.throws(() => tools.get('import_dxf')!({ path: '../project.json' }), /dentro de la carpeta/);
  assert.throws(() => tools.get('import_dxf')!({}), /exactamente uno/);

  const all = tools.get('export_dxf')!({ all: true });
  assert.equal(all.files.length, 2);

  const pdf = tools.get('export_pdf')!({ drawing: 'Mesa', paper: 'A4', scale: '1:10', titleBlock: { titulo: 'Mesa', autor: 'Ana' } });
  assert.equal(pdf.scale, '1:10');
  assert.ok(fs.readFileSync(pdf.file).subarray(0, 5).toString() === '%PDF-');
});
