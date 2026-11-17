import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createStore } from './store';
import { mcpCommands } from './mcpCommand.cjs';
import { defaultProject } from '../src/core/types';

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
const createApi = createRequire(import.meta.url)('./api.cjs') as (dir: string, opts?: object) => Handler;

const LAUNCH = { command: 'C:\\Apps\\MuebleCAD.exe', args: ['C:\\Datos\\mcp.cjs'], env: { MUEBLECAD_DATA: 'C:\\Datos', ELECTRON_RUN_AS_NODE: '1' } };

async function withServer(fn: (base: string, dir: string) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-api-'));
  const api = createApi(dir, { mcpLaunch: () => LAUNCH });
  const server = http.createServer(async (req, res) => { if (!(await api(req, res))) { res.statusCode = 404; res.end(); } });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try { await fn(base, dir); } finally { server.closeAllConnections(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const put = (base: string, body: unknown, rev?: number) => fetch(`${base}/api/project`, { method: 'PUT', headers: rev === undefined ? {} : { 'x-rev': String(rev) }, body: JSON.stringify(body) });

test('guardar con rev: si el agente escribió antes, 409 con la versión actual y sin pisar su cambio', async () => {
  await withServer(async (base, dir) => {
    const first = await (await put(base, defaultProject())).json() as { rev: number };
    // el agente (MCP) agrega una pieza por su cuenta
    const store = createStore(dir);
    store.updateProject((p) => { p.parts.push({ id: 'X1', name: 'del agente', material: p.materials[0].id, position: [0, 0, 0], size: [100, 100, 18] } as never); });
    const mine = { ...defaultProject(), name: 'mio' };
    const res = await put(base, mine, first.rev); // editó sobre la versión vieja
    assert.equal(res.status, 409);
    const body = await res.json() as { conflict: boolean; project: { parts: { id: string }[] } };
    assert.equal(body.conflict, true);
    assert.deepEqual(body.project.parts.map((p) => p.id), ['X1']);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).parts.length, 1, 'el archivo conserva el cambio del agente');
    // con la rev actual sí guarda; sin rev (clientes antiguos) también
    const cur = await (await fetch(`${base}/api/project`)).json() as { rev: number };
    assert.equal((await put(base, mine, cur.rev)).status, 200);
    assert.equal((await put(base, mine)).status, 200);
  });
});

test('SSE /api/events: avisa en menos de 1 s cuando el agente cambia project.json o su actividad', async () => {
  await withServer(async (base, dir) => {
    const store = createStore(dir);
    store.readProject();
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const next = async (ms: number) => {
      const t0 = Date.now();
      const n = buf.split('\n\n').length;
      while (buf.split('\n\n').length === n) {
        const left = ms - (Date.now() - t0);
        if (left <= 0) throw new Error('no llegó el evento a tiempo');
        const r = await Promise.race([reader.read(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('no llegó el evento a tiempo')), left))]);
        buf += dec.decode(r.value);
      }
      return Date.now() - t0;
    };
    await next(1000); // saludo inicial con la rev
    const wait1 = next(1000);
    store.updateProject((p) => { p.name = 'cambiado por el agente'; });
    assert.ok(await wait1 < 1000);
    const wait2 = next(1000);
    store.logActivity({ tool: 'add_part', mode: 'write', ok: true, message: 'Pieza P1' });
    assert.ok(await wait2 < 1000);
    const act = await (await fetch(`${base}/api/actividad`)).json() as { items: { tool: string }[] };
    assert.equal(act.items.at(-1)?.tool, 'add_part');
    ctl.abort();
  });
});

test('/api/mcp-info y mcpCommands: comando con las rutas de la instalación', async () => {
  await withServer(async (base) => {
    const info = await (await fetch(`${base}/api/mcp-info`)).json() as { claudeCode: string; json: string };
    assert.match(info.claudeCode, /^claude mcp add mueblecad /);
    assert.ok(info.claudeCode.includes('MuebleCAD.exe') && info.claudeCode.includes('mcp.cjs') && info.claudeCode.includes('ELECTRON_RUN_AS_NODE=1'));
    const cfg = JSON.parse(info.json) as { mcpServers: { mueblecad: { env: Record<string, string> } } };
    assert.equal(cfg.mcpServers.mueblecad.env.MUEBLECAD_DATA, 'C:\\Datos');
  });
  const posix = { command: '/Apps/Mi App/MuebleCAD', args: ["/Datos/o'k/mcp.cjs"], env: { MUEBLECAD_DATA: "/Datos/o'k" } };
  assert.equal(mcpCommands(posix, 'linux').claudeCode, "claude mcp add mueblecad -e 'MUEBLECAD_DATA=/Datos/o'\\''k' -- '/Apps/Mi App/MuebleCAD' '/Datos/o'\\''k/mcp.cjs'");
  const win = { command: 'C:\\A B\\M.exe', args: ['C:\\D\\mcp.cjs'], env: { MUEBLECAD_DATA: 'C:\\D' } };
  assert.equal(mcpCommands(win, 'win32').claudeCode, 'claude mcp add mueblecad -e "MUEBLECAD_DATA=C:\\D" -- "C:\\A B\\M.exe" "C:\\D\\mcp.cjs"');
});
