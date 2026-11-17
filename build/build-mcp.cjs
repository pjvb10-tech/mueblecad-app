// Empaqueta el servidor MCP (server/mcp.ts y sus dependencias) en un solo archivo, dist-mcp/mcp.cjs.
// La app de escritorio lo ejecuta con su propio Node (ELECTRON_RUN_AS_NODE=1), así que quien instala el .exe no necesita Node ni el repositorio.
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.join(__dirname, '..');
buildSync({
  entryPoints: [path.join(root, 'server', 'mcp.ts')],
  outfile: path.join(root, 'dist-mcp', 'mcp.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: true,
  legalComments: 'none',
  define: { 'import.meta.dirname': '__dirname', 'import.meta.url': '__import_meta_url' },
  banner: { js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  logLevel: 'warning',
});
console.log('MCP empaquetado en dist-mcp/mcp.cjs');
