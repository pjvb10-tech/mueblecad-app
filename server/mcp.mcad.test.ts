import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultProject } from '../src/core/types';
import { createStore } from './store';
import { registerMcadTools } from './mcpMcad';
import type { Kit } from './mcpKit';

type Fn = (a: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-mcad-'));
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ ...defaultProject(), name: 'Original' }));
  const store = createStore(dir);
  const tools = new Map<string, Fn>();
  const reg = (name: string, _d: string, _s: unknown, fn: Fn) => { tools.set(name, fn); };
  registerMcadTools({ read: reg, write: reg, files: reg } as unknown as Kit, store, dir);
  return { dir, store, tools };
}

test('export_mcad / import_mcad: ida y vuelta, acepta .json antiguo y no sale de importar/', () => {
  const { dir, store, tools } = setup();
  const ex = tools.get('export_mcad')!({});
  assert.equal(path.basename(ex.file), 'Original.mcad');
  assert.equal(JSON.parse(fs.readFileSync(ex.file, 'utf8')).formato, 'mcad');

  fs.mkdirSync(path.join(dir, 'importar'));
  fs.copyFileSync(ex.file, path.join(dir, 'importar', 'a.mcad'));
  const other = { ...defaultProject(), name: 'Plano viejo' };
  fs.writeFileSync(path.join(dir, 'importar', 'viejo.json'), JSON.stringify(other));

  assert.equal(tools.get('import_mcad')!({ path: 'viejo.json' }).name, 'Plano viejo');
  assert.equal(store.readProject().project.name, 'Plano viejo');
  tools.get('import_mcad')!({ path: 'a.mcad' });
  assert.equal(store.readProject().project.name, 'Original');
  assert.ok(fs.readdirSync(path.join(dir, 'respaldos')).length >= 1);
  assert.throws(() => tools.get('import_mcad')!({ path: '../project.json' }), /dentro de la carpeta/);
});
