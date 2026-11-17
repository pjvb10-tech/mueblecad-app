// Biblioteca de texturas: validación pura (nombres, firma de imagen, entradas del catálogo). Sin acceso a red.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 15 * 1024 * 1024;
const EXTS = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp' };
const CATEGORIAS = ['ceramica', 'porcelanato', 'madera', 'pintura', 'otro'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const NOMBRE_OK = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const ID_OK = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

/** Tipo real de una imagen por sus primeros bytes: 'png' | 'jpg' | 'webp' | null. */
function firmaImagen(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** Nombre de archivo saneado: solo [a-zA-Z0-9._-], sin rutas ni «..», extensión png/jpg/jpeg/webp. Devuelve {base, ext, nombre} o null. */
function sanearNombre(original) {
  const crudo = String(original ?? '').split(/[\\/]/).pop().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const m = /^(.*?)\.([a-zA-Z0-9]+)$/.exec(crudo);
  if (!m) return null;
  const ext = m[2].toLowerCase();
  if (!EXTS[ext]) return null;
  const base = m[1].replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 60);
  if (!base) return null;
  const nombre = `${base}.${ext}`;
  return NOMBRE_OK.test(nombre) && !nombre.includes('..') ? { base, ext, nombre } : null;
}

/** ¿La extensión declarada coincide con la firma real? (jpg/jpeg con 'jpg'). */
const extCoincide = (ext, tipo) => !!tipo && EXTS[ext] === tipo;

/** Nombre libre en la carpeta: agrega -2, -3… antes de la extensión; nunca sobrescribe. */
function nombreLibre(dir, base, ext) {
  let n = `${base}.${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, n)); i++) n = `${base}-${i}.${ext}`;
  return n;
}

const num = (v, lo, hi, d) => {
  const x = v === null || v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
};
const slug = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'textura';

/** Entrada de catálogo normalizada (o null si no tiene imagen ni color). `base` aporta los valores que falten (para actualizar). */
function normalizarItem(raw, base = {}) {
  const o = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const archivo = typeof o.archivo === 'string' && NOMBRE_OK.test(o.archivo) && !o.archivo.includes('..') && EXTS[path.extname(o.archivo).slice(1).toLowerCase()] ? o.archivo : undefined;
  const color = typeof o.color === 'string' && HEX.test(o.color) ? o.color : undefined;
  if (!archivo && !color) return null;
  if (!ID_OK.test(String(o.id ?? ''))) return null;
  return {
    id: o.id,
    nombre: String(o.nombre ?? '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || o.id,
    categoria: CATEGORIAS.includes(o.categoria) ? o.categoria : 'otro',
    ...(archivo ? { archivo } : { color }),
    w: num(o.w, 20, 3000, 600), h: num(o.h, 20, 3000, 600),
    junta: num(o.junta, 0, 30, 3),
    colorJunta: typeof o.colorJunta === 'string' && HEX.test(o.colorJunta) ? o.colorJunta : '#c9c7c1',
    veta: Number(o.veta) === 90 ? 90 : 0,
    patron: o.patron === 'trabado' ? 'trabado' : 'recto',
  };
}

/** Id libre derivado del nombre. */
function idLibre(items, nombre) {
  const b = slug(nombre);
  let id = b;
  for (let i = 2; items.some((x) => x.id === id); i++) id = `${b}-${i}`;
  return id;
}

/** Solo desde este equipo: IP de loopback, Host de localhost/127.0.0.1 y, si hay Origin, el mismo sitio (anti-CSRF y DNS rebinding). */
function soloLocal(req) {
  const ip = req.socket && req.socket.remoteAddress;
  if (!(ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return false;
  const host = String(req.headers.host || '');
  if (!/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

/** Escritura atómica: archivo temporal en la misma carpeta y renombrado. */
function escribirAtomico(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

module.exports = { MAX_BYTES, CATEGORIAS, firmaImagen, sanearNombre, extCoincide, nombreLibre, normalizarItem, idLibre, soloLocal, escribirAtomico };
