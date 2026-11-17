// API local compartida por el servidor de desarrollo y la app de escritorio.
// Archivos en `dataDir`: project.json (proyecto activo), projects/<nombre>.json (biblioteca),
// templates.json (plantillas de muebles), latest.png (última captura del visor) y texturas/ (imágenes de acabados y catalogo.json con la biblioteca de texturas).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const tx = require('./texturas.cjs');
const { mcpCommands } = require('./mcpCommand.cjs');

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function readBuffer(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('El archivo es demasiado grande.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const safeName = (n) => (String(n || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || 'proyecto');

/** `opts.mcpLaunch()` devuelve { command, args, env } con que se lanza el MCP de esta instalación (para el botón "Conectar con Claude"). */
module.exports = function createApi(dataDir, opts = {}) {
  const PROJECT = path.join(dataDir, 'project.json');
  const LIB = path.join(dataDir, 'projects');
  const TEMPLATES = path.join(dataDir, 'templates.json');
  const SHOT = path.join(dataDir, 'latest.png');
  const TEXTURES = path.join(dataDir, 'texturas');
  const CATALOG = path.join(TEXTURES, 'catalogo.json');
  const TEXTURE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  fs.mkdirSync(LIB, { recursive: true });

  const libFile = (name) => path.join(LIB, `${safeName(name)}.json`);
  const readCurrent = () => (fs.existsSync(PROJECT) ? JSON.parse(fs.readFileSync(PROJECT, 'utf8')) : null);
  const rev = () => (fs.existsSync(PROJECT) ? fs.statSync(PROJECT).mtimeMs : 0);
  const ACTIVITY = path.join(dataDir, 'actividad.json');
  // Exportar vistas: export/ recibe los archivos que guarda la app; export/pedidos.json es la cola de pedidos del MCP (request_view_export).
  const EXPORT = path.join(dataDir, 'export');
  const ORDERS = path.join(EXPORT, 'pedidos.json');
  const readOrders = () => { try { const o = JSON.parse(fs.readFileSync(ORDERS, 'utf8')); return Array.isArray(o.items) ? o.items : []; } catch { return []; } };
  const writeOrders = (items) => { fs.mkdirSync(EXPORT, { recursive: true }); tx.escribirAtomico(ORDERS, JSON.stringify({ version: 1, items }, null, 2)); };
  const patchOrder = (id, patch) => { const items = readOrders(); const o = items.find((x) => x.id === id); if (!o) return null; Object.assign(o, patch); writeOrders(items); return o; };
  const exportName = (n) => (String(n || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 100) || 'vista');
  const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const readActivity = () => { try { const a = JSON.parse(fs.readFileSync(ACTIVITY, 'utf8')); return Array.isArray(a.items) ? a.items : []; } catch { return []; } };

  // Eventos en vivo (SSE): mientras haya ventanas conectadas se vigilan project.json, actividad.json y el catálogo de texturas
  // (cada 250 ms, un stat de tres archivos) y se avisa al instante cuando cambian, para que los cambios del agente (MCP) se vean sin recargar.
  const clients = new Set();
  let watcher = null;
  let last = '';
  const signature = () => JSON.stringify([rev(), mtime(ACTIVITY), mtime(CATALOG), mtime(ORDERS)]);
  const broadcast = (data) => { for (const c of clients) c.write(`data: ${data}\n\n`); };
  const startWatching = () => {
    if (watcher) return;
    last = signature();
    watcher = setInterval(() => {
      const now = signature();
      if (now !== last) { last = now; broadcast(JSON.stringify({ rev: rev() })); }
    }, 250);
    watcher.unref?.();
  };
  const stopWatching = () => { if (watcher && !clients.size) { clearInterval(watcher); watcher = null; } };
  /** Guarda una copia del proyecto activo en la biblioteca, con su nombre. */
  const mirror = () => {
    const cur = readCurrent();
    if (cur) fs.writeFileSync(libFile(cur.name), JSON.stringify(cur, null, 2));
  };

  // Convertidor DWG -> DXF (LibreDWG, programa aparte): variable MUEBLECAD_DWG2DXF, carpeta de herramientas o PATH.
  const TOOLS = path.join(dataDir, 'herramientas');
  const exe = process.platform === 'win32' ? 'dwg2dxf.exe' : 'dwg2dxf';
  const findIn = (dir, depth) => {
    if (!fs.existsSync(dir) || depth < 0) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.toLowerCase() === exe) return path.join(dir, e.name);
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { const f = findIn(path.join(dir, e.name), depth - 1); if (f) return f; }
    }
    return null;
  };
  const findConverter = () => {
    const env = process.env.MUEBLECAD_DWG2DXF;
    if (env && fs.existsSync(env)) return env;
    const local = findIn(TOOLS, 3);
    if (local) return local;
    for (const d of (process.env.PATH || '').split(path.delimiter)) {
      const f = d && path.join(d, exe);
      if (f && fs.existsSync(f)) return f;
    }
    return null;
  };

  const readCatalog = () => {
    try { const c = JSON.parse(fs.readFileSync(CATALOG, 'utf8')); return Array.isArray(c) ? c : Array.isArray(c.items) ? c.items : []; } catch { return []; }
  };
  const writeCatalog = (items) => { fs.mkdirSync(TEXTURES, { recursive: true }); tx.escribirAtomico(CATALOG, JSON.stringify({ version: 1, items }, null, 2)); };

  return async function handle(req, res) {
    const [url, query] = (req.url || '/').split('?');
    if (!url.startsWith('/api/')) return false;
    const params = new URLSearchParams(query || '');
    const json = (v, code = 200) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(v));
      return true;
    };

    if (url === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`retry: 1000\n\ndata: ${JSON.stringify({ rev: rev() })}\n\n`);
      clients.add(res);
      const beat = setInterval(() => res.write(': latido\n\n'), 15000);
      req.on('close', () => { clearInterval(beat); clients.delete(res); stopWatching(); });
      startWatching();
      return true;
    }

    if (url === '/api/actividad' && req.method === 'GET') return json({ now: Date.now(), items: readActivity() });

    if (url === '/api/mcp-info' && req.method === 'GET') {
      const launch = opts.mcpLaunch ? opts.mcpLaunch() : null;
      if (!launch) return json({ error: 'No disponible' }, 404);
      return json({ launch, ...mcpCommands(launch), dataDir, platform: process.platform });
    }

    if (url === '/api/project' && req.method === 'GET') return json({ rev: rev(), project: readCurrent() });

    if (url === '/api/project' && req.method === 'PUT') {
      const next = JSON.parse(await readBody(req));
      // Control de concurrencia: la app dice sobre qué versión (rev) editó. Si el agente (MCP) escribió después, no se pisa su cambio:
      // se responde 409 con la versión actual y la app la adopta y reaplica el cambio del usuario.
      const base = req.headers['x-rev'];
      if (base !== undefined && fs.existsSync(PROJECT) && Number(base) !== rev()) return json({ conflict: true, rev: rev(), project: readCurrent() }, 409);
      const prev = readCurrent();
      fs.writeFileSync(PROJECT, JSON.stringify(next, null, 2));
      // Si se renombró el proyecto, se retira la copia con el nombre viejo.
      if (prev && safeName(prev.name) !== safeName(next.name) && fs.existsSync(libFile(prev.name))) fs.unlinkSync(libFile(prev.name));
      mirror();
      return json({ rev: rev() });
    }

    if (url === '/api/projects' && req.method === 'GET') {
      const current = readCurrent();
      const list = fs.readdirSync(LIB).filter((f) => f.endsWith('.json')).map((f) => {
        const full = path.join(LIB, f);
        return { name: f.slice(0, -5), mtime: fs.statSync(full).mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
      return json({ current: current ? safeName(current.name) : null, projects: list });
    }

    if (url === '/api/projects/open' && req.method === 'POST') {
      const file = libFile(params.get('name'));
      if (!fs.existsSync(file)) return json({ error: 'No existe' }, 404);
      mirror();
      fs.copyFileSync(file, PROJECT);
      return json({ rev: rev() });
    }

    // Proyecto nuevo (o copia): se guarda el actual en la biblioteca y el enviado pasa a ser el activo.
    if (url === '/api/projects/new' && req.method === 'POST') {
      const next = JSON.parse(await readBody(req));
      mirror();
      fs.writeFileSync(PROJECT, JSON.stringify(next, null, 2));
      mirror();
      return json({ rev: rev() });
    }

    if (url === '/api/projects' && req.method === 'DELETE') {
      const file = libFile(params.get('name'));
      if (fs.existsSync(file)) fs.unlinkSync(file);
      return json({ ok: true });
    }

    if (url === '/api/templates' && req.method === 'GET') return json(fs.existsSync(TEMPLATES) ? JSON.parse(fs.readFileSync(TEMPLATES, 'utf8')) : []);
    if (url === '/api/templates' && req.method === 'PUT') {
      fs.writeFileSync(TEMPLATES, JSON.stringify(JSON.parse(await readBody(req)), null, 2));
      return json({ ok: true });
    }

    if (url === '/api/screenshot' && req.method === 'POST') {
      const png = Buffer.from((await readBody(req)).replace(/^data:image\/png;base64,/, ''), 'base64');
      fs.writeFileSync(SHOT, png);
      if (params.get('save')) fs.writeFileSync(path.join(dataDir, `captura-${Date.now()}.png`), png);
      res.end('ok');
      return true;
    }

    // Exportar vistas: la app guarda sus archivos en export/ (POST binario) y procesa los pedidos que deja el agente (MCP).
    if (url === '/api/export-file' && req.method === 'POST') {
      let body;
      try { body = await readBuffer(req, 120 * 1024 * 1024); } catch (e) { return json({ error: e.message }, 413); }
      const name = exportName(params.get('name'));
      fs.mkdirSync(EXPORT, { recursive: true });
      const file = path.join(EXPORT, name);
      fs.writeFileSync(file, body);
      const order = params.get('order');
      if (order) patchOrder(order, { status: 'done', file, bytes: body.length, finished: new Date().toISOString() });
      return json({ ok: true, file, bytes: body.length });
    }
    if (url === '/api/export-orders' && req.method === 'GET') return json({ items: readOrders() });
    if (url === '/api/export-orders/claim' && req.method === 'POST') {
      const o = readOrders().find((x) => x.id === params.get('id'));
      if (!o || o.status !== 'pending') return json({ ok: false });
      return json({ ok: true, order: patchOrder(o.id, { status: 'processing' }) });
    }
    if (url === '/api/export-orders/fail' && req.method === 'POST') {
      const msg = String(await readBody(req)).slice(0, 500);
      patchOrder(params.get('id'), { status: 'error', error: msg, finished: new Date().toISOString() });
      return json({ ok: true });
    }

    if (url === '/api/dwg' && req.method === 'GET') {
      const found = findConverter();
      return json({ available: !!found, tool: found, folder: TOOLS });
    }
    if (url === '/api/dwg' && req.method === 'POST') {
      const tool = findConverter();
      if (!tool) return json({ error: 'No encontré el convertidor DWG (dwg2dxf de LibreDWG).', folder: TOOLS }, 501);
      let tmp;
      try {
        const data = await readBuffer(req, 200 * 1024 * 1024);
        if (!/^AC10\d\d/.test(data.subarray(0, 6).toString('latin1'))) return json({ error: 'El archivo no parece un DWG.' }, 400);
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-dwg-'));
        const input = path.join(tmp, 'plano.dwg'), output = path.join(tmp, 'plano.dxf');
        fs.writeFileSync(input, data);
        // dwg2dxf sale con error en avisos menores aunque escriba el DXF: se juzga por el archivo resultante.
        const stderr = await new Promise((resolve) => execFile(tool, ['-y', '-o', output, input], { timeout: 120000, windowsHide: true }, (_e, _o, err) => resolve(String(err || ''))));
        if (!fs.existsSync(output) || fs.statSync(output).size < 100) return json({ error: 'No pude convertir el DWG: ' + stderr.trim().split('\n').slice(-3).join(' ') }, 422);
        return json({ dxf: fs.readFileSync(output, 'latin1') });
      } catch (err) {
        return json({ error: String(err.message || err) }, 500);
      } finally {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      }
    }

    // Biblioteca de texturas: lectura libre; subir, crear, editar y borrar solo desde este equipo (nunca desde la red).
    if (url === '/api/texturas' && (req.method === 'GET' || req.method === 'HEAD')) return json({ version: 1, items: readCatalog() });

    const escribe = (url === '/api/textura' && req.method === 'POST') || (url.startsWith('/api/texturas') && ['POST', 'PUT', 'DELETE'].includes(req.method));
    if (escribe && !tx.soloLocal(req)) { req.resume(); return json({ error: 'Solo se puede modificar la biblioteca desde este equipo.' }, 403); }

    // Subida de una imagen: cuerpo = bytes del archivo; datos en la URL (nombre, titulo, w, h, junta, colorJunta, categoria, veta, patron).
    if (url === '/api/textura' && req.method === 'POST') {
      const len = Number(req.headers['content-length'] || 0);
      if (len > tx.MAX_BYTES) { req.resume(); return json({ error: 'La imagen supera los 15 MB.' }, 413); }
      const nm = tx.sanearNombre(params.get('nombre'));
      if (!nm) { req.resume(); return json({ error: 'Nombre de archivo no válido (solo png, jpg, jpeg o webp).' }, 400); }
      if (!/^image\/(png|jpeg|webp)$/.test(String(req.headers['content-type'] || '').split(';')[0].trim())) { req.resume(); return json({ error: 'Tipo de contenido no admitido.' }, 415); }
      let data;
      try { data = await readBuffer(req, tx.MAX_BYTES); } catch (err) { return json({ error: String(err.message || err) }, 413); }
      const tipo = tx.firmaImagen(data);
      if (!tipo || !tx.extCoincide(nm.ext, tipo)) return json({ error: 'El contenido no es una imagen png, jpg o webp válida (o no coincide con la extensión).' }, 415);
      fs.mkdirSync(TEXTURES, { recursive: true });
      const archivo = tx.nombreLibre(TEXTURES, nm.base, nm.ext); // nunca sobrescribe
      const items = readCatalog();
      const titulo = (params.get('titulo') || '').trim() || nm.base;
      const item = tx.normalizarItem({
        id: tx.idLibre(items, titulo), nombre: titulo, archivo,
        categoria: params.get('categoria'), w: params.get('w'), h: params.get('h'), junta: params.get('junta'),
        colorJunta: params.get('colorJunta'), veta: params.get('veta'), patron: params.get('patron'),
      });
      if (!item) return json({ error: 'Datos de la textura no válidos.' }, 400);
      fs.writeFileSync(path.join(TEXTURES, archivo), data, { flag: 'wx' });
      writeCatalog([...items, item]);
      return json({ item, items: [...items, item] }, 201);
    }

    // Crear una entrada de catálogo sin subir imagen (color liso, o con una imagen que ya está en la carpeta).
    if (url === '/api/texturas' && req.method === 'POST') {
      let raw;
      try { raw = JSON.parse(await readBody(req)); } catch { return json({ error: 'JSON no válido' }, 400); }
      const items = readCatalog();
      const item = tx.normalizarItem({ ...raw, id: tx.idLibre(items, raw && (raw.nombre || raw.id)) });
      if (!item) return json({ error: 'Falta un color #rrggbb o una imagen válida.' }, 400);
      if (item.archivo && !fs.existsSync(path.join(TEXTURES, item.archivo))) return json({ error: 'Esa imagen no está en la carpeta texturas/.' }, 404);
      writeCatalog([...items, item]);
      return json({ item, items: [...items, item] }, 201);
    }

    const mt = /^\/api\/texturas\/([a-zA-Z0-9_-]{1,40})$/.exec(url);
    if (mt && req.method === 'PUT') {
      let raw;
      try { raw = JSON.parse(await readBody(req)); } catch { return json({ error: 'JSON no válido' }, 400); }
      const items = readCatalog();
      const i = items.findIndex((x) => x.id === mt[1]);
      if (i < 0) return json({ error: 'No existe' }, 404);
      const { id: _i, archivo: _a, ...cambios } = raw || {}; // el id y el archivo no se cambian
      const item = tx.normalizarItem({ ...cambios, id: items[i].id }, items[i]);
      if (!item) return json({ error: 'Datos de la textura no válidos.' }, 400);
      items[i] = item;
      writeCatalog(items);
      return json({ item, items });
    }
    if (mt && req.method === 'DELETE') {
      const items = readCatalog();
      const it = items.find((x) => x.id === mt[1]);
      if (!it) return json({ error: 'No existe' }, 404);
      const rest = items.filter((x) => x !== it);
      writeCatalog(rest);
      // la imagen se borra solo si se pide y ninguna otra entrada la usa
      if (params.get('archivo') === '1' && it.archivo && !rest.some((x) => x.archivo === it.archivo)) {
        const f = path.join(TEXTURES, it.archivo);
        if (path.dirname(f) === TEXTURES && fs.existsSync(f)) fs.unlinkSync(f);
      }
      return json({ items: rest });
    }
    if (url.startsWith('/api/texturas')) return json({ error: 'Ruta desconocida' }, 404);

    // Texturas de piso y muro: solo archivos de imagen de la carpeta texturas/ (nombre sin rutas), solo lectura.
    if (url.startsWith('/api/textura/') && (req.method === 'GET' || req.method === 'HEAD')) {
      let name = '';
      try { name = decodeURIComponent(url.slice('/api/textura/'.length)); } catch { /* nombre inválido */ }
      const type = TEXTURE_TYPES[path.extname(name).toLowerCase()];
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name) || name.includes('..') || !type) return json({ error: 'Nombre de textura no válido' }, 400);
      const file = path.join(TEXTURES, name);
      const st = fs.existsSync(file) ? fs.statSync(file) : null;
      if (!st || !st.isFile()) return json({ error: 'No existe' }, 404);
      if (st.size > 20 * 1024 * 1024) return json({ error: 'Textura demasiado grande' }, 413);
      res.statusCode = 200;
      res.setHeader('content-type', type);
      res.setHeader('content-length', st.size);
      res.setHeader('cache-control', 'no-cache');
      if (req.method === 'HEAD') res.end(); else res.end(fs.readFileSync(file));
      return true;
    }

    return json({ error: 'Ruta desconocida' }, 404);
  };
};
