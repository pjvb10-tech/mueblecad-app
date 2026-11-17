import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultProject } from '../src/core/types';
import { addCabinet } from '../src/core/furniture';
import { withView } from '../src/core/savedViews';
import { createStore } from './store';
import { createOrders, registerExportViewTools, renderVector, serverCanRender } from './mcpExportView';
import type { Kit } from './mcpKit';

type Fn = (a: Record<string, unknown>) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-ev-'));
  let p = defaultProject();
  addCabinet(p, { width: 800, height: 720, depth: 500, name: 'Base' } as never);
  p = withView(p, { id: 'v1', name: 'Iso', kind: '3d', camera: { position: [1000, 1000, 1000], target: [0, 0, 0] } });
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p));
  const store = createStore(dir);
  const tools = new Map<string, Fn>();
  const reg = (name: string, _d: string, _s: unknown, fn: Fn) => { tools.set(name, fn); };
  registerExportViewTools({ read: reg, write: reg, files: reg } as unknown as Kit, store, dir);
  return { dir, tools, project: p };
}

test('serverCanRender: vectorial sí; 3D, raster y vistas guardadas no', () => {
  assert.equal(serverCanRender({ view: 'front', format: 'pdf' }), true);
  assert.equal(serverCanRender({ view: 'sheet' }), true);
  assert.equal(serverCanRender({ view: 'top', format: 'svg' }), true);
  assert.equal(serverCanRender({ view: 'sheet', format: 'svg' }), false);
  assert.equal(serverCanRender({ view: 'iso', format: 'pdf' }), false);
  assert.equal(serverCanRender({ view: 'front', format: 'png' }), false);
  assert.equal(serverCanRender({ saved: 'Iso', format: 'pdf' }), false);
});

test('save_view: lámina y plano vectoriales se generan sin navegador', () => {
  const { dir, tools } = setup();
  const r = tools.get('save_view')!({ view: 'sheet', paper: 'A3', titleBlock: { autor: 'Ana' }, includeCutlist: true });
  assert.equal(r.rendered, true);
  const pdf = fs.readFileSync(r.file);
  assert.ok(pdf.subarray(0, 8).toString() === '%PDF-1.4');
  const s = pdf.toString('latin1');
  assert.match(s, /\(Ana\)/);
  assert.match(s, /\/Count 2|\/Count [3-9]/); // la lista de piezas añade páginas
  assert.equal(path.dirname(r.file), path.join(dir, 'export'));

  const svg = tools.get('save_view')!({ view: 'front', format: 'svg', name: 'plano-frente', width: 1200 });
  assert.equal(svg.rendered, true);
  const t = fs.readFileSync(svg.file, 'utf8');
  assert.match(t, /^<svg .*width="1200"/);
  assert.ok(t.includes('>800<'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save_view: lo que necesita la app queda como pedido; request_view_export y list_view_exports', () => {
  const { dir, tools } = setup();
  const q = tools.get('save_view')!({ view: 'iso', format: 'png', width: 2000, height: 1200, background: 'transparent' });
  assert.equal(q.rendered, false);
  assert.equal(q.queued, true);
  const items = tools.get('list_view_exports')!({});
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'pending');
  assert.equal(items[0].request.width, 2000);
  const r2 = tools.get('request_view_export')!({ saved: 'Iso', format: 'jpg' });
  assert.equal(r2.queued, true);
  assert.equal(tools.get('list_view_exports')!({}).length, 2);
  assert.ok(fs.existsSync(path.join(dir, 'export', 'pedidos.json')));
  assert.throws(() => tools.get('request_view_export')!({ saved: 'No existe' }), /No existe la vista guardada/);
  assert.throws(() => tools.get('request_view_export')!({ view: 'iso', format: 'jpg', background: 'transparent' }), /transparente/);
  assert.throws(() => tools.get('save_view')!({ view: 'drawing' }), /dibujos/); // sin dibujos
  fs.rmSync(dir, { recursive: true, force: true });
});

test('renderVector: error claro si no hay piezas y orden con límite de 50', () => {
  const p = defaultProject();
  assert.throws(() => renderVector(p, { view: 'front' }), /No hay piezas/);
  assert.throws(() => renderVector(p, { view: 'iso' }), /app abierta/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-ev-'));
  const o = createOrders(dir);
  for (let i = 0; i < 55; i++) o.enqueue({ view: 'iso' });
  assert.equal(o.read().length, 50);
  fs.rmSync(dir, { recursive: true, force: true });
});
