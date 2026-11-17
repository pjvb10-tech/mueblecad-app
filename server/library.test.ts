import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from './store';
import { createLibrary } from './library';
import { TINY_PNG } from '../src/core/testPlan';

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-lib-'));
  const store = createStore(dir);
  return { dir, lib: createLibrary(store), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);

test('agregar imagen por base64: nombre saneado, entrada de catálogo y nunca sobrescribe', () => {
  const { dir, lib, done } = setup();
  try {
    const a = lib.addFromBase64(TINY_PNG.toString('base64'), 'Mármol Blanco (60x60).PNG', { titulo: 'Mármol', w: 600, h: 1200, junta: 2, categoria: 'porcelanato' });
    assert.equal(a.archivo, 'Marmol-Blanco-60x60.png');
    assert.equal(a.item.id, 'marmol'); assert.equal(a.item.h, 1200); assert.equal(a.item.categoria, 'porcelanato');
    const b = lib.addFromBase64('data:image/png;base64,' + TINY_PNG.toString('base64'), 'Mármol Blanco (60x60).png', { titulo: 'Mármol' });
    assert.equal(b.archivo, 'Marmol-Blanco-60x60-2.png');
    assert.equal(b.item.id, 'marmol-2');
    assert.equal(lib.readCatalog().length, 2);
    assert.ok(fs.readFileSync(path.join(dir, 'texturas', a.archivo)).equals(TINY_PNG));
    assert.ok(fs.existsSync(path.join(dir, 'respaldos')), 'copia del catálogo antes de escribir');
  } finally { done(); }
});

test('validación: firma real, extensión coincidente, tamaño, nombres con rutas', () => {
  const { dir, lib, done } = setup();
  try {
    const b64 = TINY_PNG.toString('base64');
    assert.throws(() => lib.addFromBase64(Buffer.from('hola mundo, esto no es una imagen').toString('base64'), 'a.png'), /firma de archivo/);
    assert.throws(() => lib.addFromBase64(b64, 'a.jpg'), /no coincide.*png/);
    assert.throws(() => lib.addFromBase64(b64, 'a.gif'), /Nombre de archivo no válido/);
    assert.throws(() => lib.addFromBase64(b64, '.png'), /Nombre de archivo no válido/);
    assert.throws(() => lib.addFromBase64(b64, 'a.png.exe'), /Nombre de archivo no válido/);
    assert.throws(() => lib.addFromBase64('%%%no-base64', 'a.png'), /base64/);
    assert.throws(() => lib.addFromBase64(Buffer.alloc(15 * 1024 * 1024 + 10).toString('base64'), 'a.png'), /15 MB/);
    // un nombre con rutas se reduce al nombre de archivo: nunca sale de texturas/
    const r = lib.addFromBase64(b64, '../../escape.png');
    assert.equal(r.archivo, 'escape.png');
    assert.ok(fs.existsSync(path.join(dir, 'texturas', 'escape.png')));
    assert.ok(!fs.existsSync(path.join(path.dirname(dir), 'escape.png')));
    assert.equal(lib.readCatalog().length, 1, 'los rechazos no dejan entradas');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'texturas')).filter((n) => n.endsWith('.png')), ['escape.png']);
  } finally { done(); }
});

test('agregar desde ruta local: debe existir, ser archivo normal e imagen real', () => {
  const { dir, lib, done } = setup();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-src-'));
  try {
    const png = path.join(src, 'piso.png'), jpg = path.join(src, 'foto.jpeg'), fake = path.join(src, 'falso.png'), noExt = path.join(src, 'descarga');
    fs.writeFileSync(png, TINY_PNG); fs.writeFileSync(jpg, JPG); fs.writeFileSync(fake, 'texto plano de más de doce bytes'); fs.writeFileSync(noExt, TINY_PNG);
    const a = lib.addFromFile(png, { titulo: 'Piso gris' });
    assert.equal(a.item.nombre, 'Piso gris'); assert.equal(a.archivo, 'piso.png');
    assert.equal(lib.addFromFile(jpg).archivo, 'foto.jpeg');
    assert.throws(() => lib.addFromFile(fake), /firma de archivo/);
    assert.throws(() => lib.addFromFile(noExt), /Nombre de archivo no válido/);
    assert.equal(lib.addFromFile(noExt, { nombre: 'sin-extension.png' }).archivo, 'sin-extension.png');
    assert.throws(() => lib.addFromFile(path.join(src, 'no-existe.png')), /No existe el archivo/);
    assert.throws(() => lib.addFromFile(src), /no es un archivo/);
    assert.throws(() => lib.addFromFile('piso.png'), /absoluta/);
    assert.throws(() => lib.addFromFile('\\\\servidor\\compartido\\a.png'), /red/);
    assert.throws(() => lib.addFromFile('//servidor/compartido/a.png'), /red/);
    assert.throws(() => lib.addFromFile(png + '\0.png'), /no válida/);
    assert.throws(() => lib.addFromFile(''), /Falta la ruta/);
    const big = path.join(src, 'grande.png');
    fs.writeFileSync(big, Buffer.concat([TINY_PNG, Buffer.alloc(15 * 1024 * 1024)]));
    assert.throws(() => lib.addFromFile(big), /15 MB/);
    const link = path.join(src, 'enlace.png');
    let linked = true;
    try { fs.symlinkSync(png, link); } catch { linked = false; } // en Windows sin permisos no se puede crear
    if (linked) assert.throws(() => lib.addFromFile(link), /enlaces simbólicos/);
    assert.ok(fs.readdirSync(path.join(dir, 'texturas')).every((n) => !n.includes('falso') && !n.includes('grande')));
  } finally { done(); fs.rmSync(src, { recursive: true, force: true }); }
});

test('color liso, actualizar y quitar (el archivo solo se borra si nadie más lo usa)', () => {
  const { dir, lib, done } = setup();
  try {
    const c = lib.addColor('#f4f3ef', { titulo: 'Pintura blanca' });
    assert.equal(c.item.categoria, 'pintura'); assert.equal(c.item.junta, 0);
    assert.throws(() => lib.addColor('blanco'), /#rrggbb/);
    const u = lib.update(c.item.id, { titulo: 'Blanco hueso', color: '#eeeeee', w: 400 });
    assert.equal(u.nombre, 'Blanco hueso'); assert.equal(u.color, '#eeeeee'); assert.equal(u.w, 400);
    assert.throws(() => lib.update('zzz', {}), /No existe la textura/);

    const a = lib.addFromBase64(TINY_PNG.toString('base64'), 'a.png', { titulo: 'A' });
    // una segunda entrada que comparte el mismo archivo (como permite la API web)
    const items = lib.readCatalog();
    items.push({ ...a.item, id: 'a-copia', nombre: 'A copia' });
    fs.writeFileSync(lib.catalogFile, JSON.stringify({ version: 1, items }));
    const r1 = lib.remove('a');
    assert.equal(r1.fileDeleted, false); assert.match(r1.fileKept!, /otra textura/);
    assert.ok(fs.existsSync(path.join(dir, 'texturas', 'a.png')));
    const r2 = lib.remove('a-copia');
    assert.equal(r2.fileDeleted, true);
    assert.ok(!fs.existsSync(path.join(dir, 'texturas', 'a.png')));
    assert.throws(() => lib.remove('a'), /No existe/);
    assert.deepEqual(lib.usage({ finishes: { H1: { floor: { tex: 'x' }, walls: { tex: 'y' } } } }, 'y'), ['H1']);
    assert.deepEqual(lib.usage({}, 'y'), []);
  } finally { done(); }
});
