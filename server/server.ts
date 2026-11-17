import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer as createVite } from 'vite';
import { DATA_DIR } from './store';

const root = path.resolve(import.meta.dirname, '..');
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
const requireCjs = createRequire(import.meta.url);
const PORT = Number(process.env.PORT ?? 5173);
const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
// En modo desarrollo el MCP se lanza desde el código con node + tsx.
const api = (requireCjs('./api.cjs') as (dir: string, opts: object) => Handler)(DATA_DIR, {
  mcpLaunch: () => ({ command: process.execPath, args: [tsxCli, path.join(root, 'server', 'mcp.ts')], env: { MUEBLECAD_DATA: DATA_DIR } }),
});
const vite = await createVite({ server: { middlewareMode: true }, appType: 'spa' });

const server = http.createServer(async (req, res) => {
  if (await api(req, res)) return;
  vite.middlewares(req, res);
});
server.listen(PORT, '127.0.0.1', () => console.log(`MuebleCAD en http://localhost:${PORT}`));
