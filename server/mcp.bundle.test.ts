import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(import.meta.dirname, '..');

test('MCP empaquetado (dist-mcp/mcp.cjs): arranca con Node a secas, lista herramientas, edita y deja registro de actividad', { timeout: 120_000 }, async () => {
  execFileSync(process.execPath, [path.join(root, 'build', 'build-mcp.cjs')], { cwd: root });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-bundle-'));
  // se ejecuta desde otra carpeta, sin node_modules cerca: el paquete debe bastarse solo
  const lone = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-lone-'));
  fs.copyFileSync(path.join(root, 'dist-mcp', 'mcp.cjs'), path.join(lone, 'mcp.cjs'));
  const client = new Client({ name: 'bundle', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(lone, 'mcp.cjs')], cwd: lone, env: { ...(process.env as Record<string, string>), MUEBLECAD_DATA: dir }, stderr: 'pipe' }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['add_part', 'update_part', 'remove_part', 'batch_parts', 'add_texture']) assert.ok(tools.includes(n), n);
    const r = await client.callTool({ name: 'add_part', arguments: { name: 'tabla', material: 'mel18', size: [400, 18, 300], position: [0, 0, 0] } }) as { isError?: boolean; content: { text?: string }[] };
    assert.ok(!r.isError, JSON.stringify(r.content));
    const act = JSON.parse(fs.readFileSync(path.join(dir, 'actividad.json'), 'utf8')) as { items: { tool: string; mode: string; ok: boolean }[] };
    assert.ok(act.items.some((a) => a.tool === 'add_part' && a.mode === 'write' && a.ok));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).parts.length, 1);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(lone, { recursive: true, force: true });
  }
});
