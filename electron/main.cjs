// Ventana de escritorio de MuebleCAD: sirve la web compilada (dist/) y la API local en un puerto interno.
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const createApi = require('../server/api.cjs');

const DIST = path.join(__dirname, '..', 'dist');
// Carpeta visible para el usuario; el agente (MCP) puede apuntar aquí con MUEBLECAD_DATA.
const DATA_DIR = process.env.MUEBLECAD_DATA || path.join(app.getPath('documents'), 'MuebleCAD');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

/**
 * Cómo se lanza el MCP de esta instalación. Empaquetada: el propio .exe como Node (ELECTRON_RUN_AS_NODE=1) con dist-mcp/mcp.cjs,
 * que se copia a <datos>/mcp/ para tener una ruta estable (el .exe portable se descomprime en una carpeta temporal distinta en cada arranque).
 * Sin empaquetar (npm run app): node + tsx desde el repositorio.
 */
function mcpLaunch() {
  if (!app.isPackaged) {
    const root = path.join(__dirname, '..');
    return { command: 'node', args: [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'server', 'mcp.ts')], env: { MUEBLECAD_DATA: DATA_DIR } };
  }
  const script = path.join(DATA_DIR, 'mcp', 'mcp.cjs');
  try {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'dist-mcp', 'mcp.cjs'), script);
  } catch (e) { console.error('No se pudo copiar el MCP:', e); }
  // La versión portátil es un lanzador que se descomprime en una carpeta temporal y termina al instante: no sirve como Node por stdio.
  // Se usa el .exe real (válido solo mientras la app está abierta); con el instalador (MuebleCAD-Setup.exe) la ruta es fija.
  const temporal = !!process.env.PORTABLE_EXECUTABLE_FILE;
  return { command: process.execPath, args: [script], env: { MUEBLECAD_DATA: DATA_DIR, ELECTRON_RUN_AS_NODE: '1' }, temporal };
}

function startServer() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const api = createApi(DATA_DIR, { mcpLaunch });
  const server = http.createServer(async (req, res) => {
    if (await api(req, res)) return;
    const url = (req.url || '/').split('?')[0];
    const file = path.normalize(path.join(DIST, url === '/' ? 'index.html' : url));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end('no encontrado');
    }
    res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** PDF de la página actual con los estilos de impresión (sin menús ni paneles laterales). */
async function pageToPdf(win) {
  return win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
}

ipcMain.handle('save-pdf', async (event, name) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const safe = String(name || 'MuebleCAD.pdf').replace(/[\\/:*?"<>|]/g, '_');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), safe),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, await pageToPdf(win));
  return filePath;
});

// --- archivos .mcad (formato nativo): abrir con doble clic, «Abrir…», «Guardar» y «Guardar como…» ---

const MCAD_MAX = 200 * 1024 * 1024;
/** Rutas que el usuario eligió en un diálogo o abrió con doble clic: solo en ellas puede escribir «Guardar» sin preguntar. */
const allowedPaths = new Set();
/** Archivo recibido antes de que la ventana pueda recibirlo (arranque con doble clic). */
let pendingOpen = null;
let mainWin = null;
let winReady = false;

const isMcadArg = (a) => typeof a === 'string' && !a.startsWith('-') && /\.mcad$/i.test(a);
const mcadFromArgv = (argv) => argv.slice(app.isPackaged ? 1 : 2).find((a) => isMcadArg(a) && fs.existsSync(a)) || null;

function readMcadFile(file) {
  const full = path.resolve(file);
  const st = fs.statSync(full);
  if (!st.isFile() || st.size > MCAD_MAX) throw new Error('El archivo no es válido o es demasiado grande.');
  allowedPaths.add(full);
  return { path: full, text: fs.readFileSync(full, 'utf8') };
}

const readOrError = (file) => { try { return readMcadFile(file); } catch (e) { return { path: file, error: String(e.message || e) }; } };

/** Entrega el archivo a la ventana (o lo deja pendiente si aún no cargó). */
function openMcad(file) {
  const payload = readOrError(file);
  if (mainWin && winReady) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
    mainWin.webContents.send('open-mcad', payload);
  } else pendingOpen = payload;
}

ipcMain.handle('mcad-take-pending', () => { const p = pendingOpen; pendingOpen = null; winReady = true; return p; });

ipcMain.handle('mcad-open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    defaultPath: app.getPath('documents'), properties: ['openFile'],
    filters: [{ name: 'Proyecto MuebleCAD', extensions: ['mcad', 'json'] }],
  });
  if (canceled || !filePaths[0]) return null;
  return readOrError(filePaths[0]);
});

/** Guarda el texto .mcad: en `file` si el usuario ya eligió esa ruta (y no se pide el diálogo); si no, abre el diálogo de guardar. */
ipcMain.handle('mcad-save', async (event, file, name, text, forceDialog) => {
  if (typeof text !== 'string' || text.length > MCAD_MAX) throw new Error('Contenido no válido.');
  let target = typeof file === 'string' && !forceDialog && allowedPaths.has(path.resolve(file)) ? path.resolve(file) : null;
  if (!target) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const safe = String(name || 'proyecto.mcad').replace(/[\\/:*?"<>|]/g, '_');
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: typeof file === 'string' && file ? file : path.join(app.getPath('documents'), safe),
      filters: [{ name: 'Proyecto MuebleCAD', extensions: ['mcad'] }],
    });
    if (canceled || !filePath) return null;
    target = /\.mcad$/i.test(filePath) ? filePath : filePath + '.mcad';
    allowedPaths.add(path.resolve(target));
  }
  fs.writeFileSync(target, text);
  return target;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const f = mcadFromArgv(argv);
    if (f) openMcad(f);
    else if (mainWin) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
  });
  // Mac: doble clic en un .mcad (puede llegar antes de que la app esté lista).
  app.on('open-file', (e, file) => { e.preventDefault(); if (isMcadArg(file)) openMcad(file); });
  const first = mcadFromArgv(process.argv);
  if (first) pendingOpen = readOrError(first);
}

/** En Mac hace falta un menú mínimo: sin él no funcionan Cmd+C, Cmd+V, Cmd+Z ni Cmd+Q. En Windows no se muestra menú. */
function setupMenu() {
  if (process.platform !== 'darwin') return Menu.setApplicationMenu(null);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Edición', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Ver', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
}

if (gotLock) app.whenReady().then(async () => {
  const port = await startServer();
  setupMenu();
  const win = mainWin = new BrowserWindow({
    width: 1500, height: 900, title: 'MuebleCAD', backgroundColor: '#f3f5f8', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
});

app.on('window-all-closed', () => app.quit());
