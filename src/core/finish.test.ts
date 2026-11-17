import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claddingRects, effectiveFinishes, emptyQuads, faceOpenings, migrateRoomFloors, parseCatalog, patternPeriod, resolveSurface, roomWallFaces, roomWallGeometry, wallQuads } from './finish';
import type { Buckets, TextureItem } from './finish';
import type { FloorPlan, Project } from './types';

const tx = createRequire(import.meta.url)('../../server/texturas.cjs');

const item = (o: Partial<TextureItem> = {}): TextureItem => ({ id: 'trav', nombre: 'Travertino', categoria: 'ceramica', archivo: 'ceramica-travertino.png', w: 600, h: 600, junta: 3, colorJunta: '#c9c7c1', veta: 0, patron: 'recto', ...o });

test('catálogo: descarta entradas inválidas, corrige rangos y acepta lista u objeto', () => {
  const raw = { version: 1, items: [
    { id: 'a', nombre: ' A ', archivo: 'a.png', w: 99999, h: 5, junta: -3, veta: 90, patron: 'trabado', categoria: 'madera' },
    { id: 'a', color: '#ffffff' }, // id repetido
    { id: 'b', color: 'blanco' }, // color inválido y sin imagen
    { id: 'c', archivo: '../x.png' }, // ruta
    { id: 'd d', color: '#ffffff' }, // id inválido
    { id: 'e', color: '#aabbcc', categoria: 'rara' },
    null, 5,
  ] };
  const c = parseCatalog(raw);
  assert.deepEqual(c.map((x) => x.id), ['a', 'e']);
  assert.equal(c[0].nombre, 'A');
  assert.equal(c[0].w, 3000); assert.equal(c[0].h, 20); assert.equal(c[0].junta, 0);
  assert.equal(c[0].veta, 90); assert.equal(c[0].patron, 'trabado'); assert.equal(c[0].categoria, 'madera');
  assert.equal(c[1].categoria, 'otro'); assert.equal(c[1].archivo, undefined);
  assert.deepEqual(parseCatalog([{ id: 'z', color: '#000000' }]).map((x) => x.id), ['z']);
  assert.deepEqual(parseCatalog(undefined), []);
});

test('roomFloors antiguo: se lee como finishes y se migra sin perder datos', () => {
  const cat = [item()];
  const p = { roomFloors: { H5: { image: 'ceramica-travertino.png', tile: 600 } } } as unknown as Project;
  const e = effectiveFinishes(p, cat);
  assert.deepEqual(e.finishes.H5.floor, { tex: 'trav' });
  // tile distinto del catálogo: queda como ajuste
  const q = { roomFloors: { H1: { image: 'ceramica-travertino.png', tile: 800 } } } as unknown as Project;
  assert.deepEqual(effectiveFinishes(q, cat).finishes.H1.floor, { tex: 'trav', w: 800, h: 800 });
  // imagen que no está en el catálogo: textura virtual
  const v = effectiveFinishes(q, []);
  assert.equal(v.catalog.length, 1); assert.equal(v.catalog[0].archivo, 'ceramica-travertino.png');
  // si hay finishes para la habitación, roomFloors no la pisa
  const both = { roomFloors: p.roomFloors, finishes: { H5: { walls: { tex: 'trav' } } } } as unknown as Project;
  assert.equal(effectiveFinishes(both, cat).finishes.H5.floor, undefined);
  assert.ok(migrateRoomFloors(p, cat));
  assert.equal(p.roomFloors, undefined);
  assert.deepEqual(p.finishes, { H5: { floor: { tex: 'trav' } } });
  assert.equal(migrateRoomFloors(p, cat), false);
});

test('resolver superficie: ajustes sobre los valores de la textura; la clave no depende de la altura', () => {
  const cat = [item({ w: 600, h: 1200 })];
  const r = resolveSurface({ tex: 'trav', junta: 5, altura: 1200 }, cat)!;
  assert.equal(r.w, 600); assert.equal(r.h, 1200); assert.equal(r.junta, 5); assert.equal(r.altura, 1200);
  assert.equal(resolveSurface({ tex: 'trav', altura: 900 }, cat)!.key, resolveSurface({ tex: 'trav' }, cat)!.key);
  assert.equal(resolveSurface({ tex: 'nada' }, cat), null);
  assert.deepEqual(patternPeriod({ w: 600, h: 300, patron: 'trabado' }), { pw: 600, ph: 600 });
});

test('revestimiento de un muro con vanos: encima, debajo y laterales; altura parcial', () => {
  const area = (rs: { u0: number; u1: number; y0: number; y1: number }[]) => rs.reduce((s, r) => s + (r.u1 - r.u0) * (r.y1 - r.y0), 0);
  // muro de 4000, puerta 1000..1900 (0..2000) y ventana 2500..3300 (900..2100), techo 2440
  const ops = [{ u0: 1000, u1: 1900, y0: 0, y1: 2000 }, { u0: 2500, u1: 3300, y0: 900, y1: 2100 }];
  const full = claddingRects(0, 4000, 2440, ops);
  assert.equal(area(full), 4000 * 2440 - 900 * 2000 - 800 * 1200);
  assert.ok(full.some((r) => r.u0 === 1000 && r.u1 === 1900 && r.y0 === 2000 && r.y1 === 2440), 'dintel de la puerta');
  assert.ok(full.some((r) => r.u0 === 2500 && r.u1 === 3300 && r.y0 === 0 && r.y1 === 900), 'bajo la ventana');
  assert.ok(full.some((r) => r.u0 === 2500 && r.u1 === 3300 && r.y0 === 2100), 'sobre la ventana');
  assert.equal(full.length, 6);
  // a 1200 mm: la puerta corta todo; la ventana solo deja 0..900 debajo y 900..1200 queda libre
  const half = claddingRects(0, 4000, 1200, ops);
  assert.equal(area(half), (4000 - 900) * 1200 - 800 * 300);
  assert.ok(half.every((r) => r.y1 <= 1200));
  assert.ok(!half.some((r) => r.u0 < 1900 && r.u1 > 1000));
  // un vano que sobresale de la cara se recorta; sin vanos queda un solo rectángulo
  assert.deepEqual(claddingRects(0, 1000, 1200, []), [{ u0: 0, u1: 1000, y0: 0, y1: 1200 }]);
  assert.equal(area(claddingRects(0, 1000, 1200, [{ u0: -500, u1: 300, y0: 0, y1: 5000 }])), 700 * 1200);
});

// Cuarto 0..4000 x 0..3000 con muros de 140 mm; puerta en el muro sur (z = 3000..3140) y ventana en el norte.
const room = (): FloorPlan => {
  const w = (x0: number, z0: number, x1: number, z1: number) => ({ kind: 'MP' as const, x0, z0, x1, z1 });
  return {
    name: 't', lines: [], panelH: 2440,
    walls: [w(-140, -140, 4140, 0), w(-140, 3000, 4140, 3140), w(-140, 0, 0, 3000), w(4000, 0, 4140, 3000)],
    rooms: [{ id: 'H1', name: 'Baño', x0: 0, z0: 0, x1: 4000, z1: 3000, cx: 2000, cz: 1500, area: 12 }],
    openings: [
      { x1: 1000, z1: 3070, x2: 1900, z2: 3070, y: 0, h: 2000, kind: 'door' },
      { x1: 2500, z1: -70, x2: 3300, z2: -70, y: 900, h: 1200, kind: 'window' },
      { x1: 100, z1: 5070, x2: 900, z2: 5070, y: 0, h: 2000, kind: 'door' }, // otra pared lejana: no cuenta
    ],
  } as FloorPlan;
};

test('caras interiores de la habitación y vanos que las cruzan', () => {
  const plan = room();
  const faces = roomWallFaces(plan, 'H1');
  assert.deepEqual(faces.map((f) => f.side).sort(), ['este', 'norte', 'oeste', 'sur']);
  const sur = faces.find((f) => f.side === 'sur')!, norte = faces.find((f) => f.side === 'norte')!;
  assert.equal(sur.axis, 'z'); assert.equal(sur.c, 3000); assert.equal(sur.n, -1);
  assert.equal(norte.c, 0); assert.equal(norte.n, 1);
  assert.deepEqual([norte.a0, norte.a1], [0, 4000]);
  assert.equal(faceOpenings(plan, sur).length, 1);
  assert.equal(faceOpenings(plan, norte).length, 1);
  assert.equal(faceOpenings(plan, faces.find((f) => f.side === 'este')!).length, 0);
});

test('geometría de muros: media altura deja libres puerta y ventana, UV en mm reales', () => {
  const plan = room();
  const cat = [item()];
  const b: Buckets = new Map();
  roomWallGeometry(plan, 'H1', { walls: { tex: 'trav', altura: 1200 } }, cat, b);
  assert.equal(b.size, 1);
  const { q } = [...b.values()][0];
  // área de todos los triángulos = suma de rectángulos
  let area = 0;
  for (let i = 0; i < q.pos.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = q.pos.slice(i, i + 9);
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  // perímetro 14000 x 1200, menos la puerta (900 x 1200) y el hueco de la ventana entre 900 y 1200 (800 x 300)
  assert.ok(Math.abs(area - (14000 * 1200 - 900 * 1200 - 800 * 300)) < 1);
  assert.ok(q.pos.every((v, i) => i % 3 !== 1 || (v >= 0 && v <= 1200)));
  assert.ok(q.pos.some((v, i) => i % 3 === 2 && Math.abs(v - 1.5) < 1e-9), 'cara norte retranqueada');
  assert.ok(q.pos.some((v, i) => i % 3 === 2 && Math.abs(v - 2998.5) < 1e-9), 'cara sur retranqueada');
  for (let i = 0; i < q.nrm.length; i += 3) assert.ok(Math.abs(Math.hypot(q.nrm[i], q.nrm[i + 1], q.nrm[i + 2]) - 1) < 1e-9);
  // el sentido de giro de cada triángulo coincide con su normal (cara visible desde dentro)
  for (let i = 0; i < q.pos.length; i += 9) {
    const p = q.pos.slice(i, i + 9);
    const u = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], v = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(n[0] * q.nrm[i] + n[1] * q.nrm[i + 1] + n[2] * q.nrm[i + 2] > 0, 'giro hacia la normal');
  }
  // sin revestir un lado: tex ''
  const b2: Buckets = new Map();
  roomWallGeometry(plan, 'H1', { walls: { tex: 'trav', lados: { norte: { tex: '' } } } }, cat, b2);
  assert.ok(![...b2.values()][0].q.pos.some((v, i) => i % 3 === 2 && Math.abs(v - 1.5) < 1e-9));
});

test('UV: mm reales entre el período del patrón, con desfase y trabado', () => {
  const f = { axis: 'z' as const, c: 0, a0: 0, a1: 1200, n: 1 as const, side: 'norte' as const };
  const r = resolveSurface({ tex: 'x', dx: 100, patron: 'trabado' }, [item({ id: 'x', w: 600, h: 300 })])!;
  const q = wallQuads(f, [{ u0: 0, u1: 1200, y0: 0, y1: 900 }], r, emptyQuads());
  assert.equal(q.uv.length, 12);
  const us = q.uv.filter((_, i) => i % 2 === 0), vs = q.uv.filter((_, i) => i % 2 === 1);
  assert.ok(Math.abs(Math.min(...us) - (-100 / 600)) < 1e-9);
  assert.ok(Math.abs(Math.max(...us) - 1100 / 600) < 1e-9);
  assert.ok(Math.abs(Math.max(...vs) - 900 / 600) < 1e-9); // trabado: período vertical = 2 x 300
});

test('servidor: nombre de archivo saneado y firma de imagen', () => {
  assert.equal(tx.sanearNombre('Piso Gris 60x60.PNG').nombre, 'Piso-Gris-60x60.png');
  assert.equal(tx.sanearNombre('C:\\fotos\\mármol blanco.jpeg').nombre, 'marmol-blanco.jpeg');
  assert.equal(tx.sanearNombre('../../etc/passwd.png').nombre, 'passwd.png');
  for (const n of ['x.exe', 'x.png.exe', 'x', '.png', '', '...png', 'a.svg', undefined]) assert.equal(tx.sanearNombre(n), null, String(n));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]);
  assert.equal(tx.firmaImagen(png), 'png'); assert.equal(tx.firmaImagen(jpg), 'jpg'); assert.equal(tx.firmaImagen(webp), 'webp');
  assert.equal(tx.firmaImagen(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(tx.firmaImagen(Buffer.from('MZ programa ejecutable de prueba')), null);
  assert.ok(tx.extCoincide('jpeg', 'jpg')); assert.ok(tx.extCoincide('png', 'png'));
  assert.ok(!tx.extCoincide('png', 'jpg')); assert.ok(!tx.extCoincide('png', null));
});

test('servidor: no sobrescribe, ids libres, entradas normalizadas y host/origen locales', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-'));
  fs.writeFileSync(path.join(dir, 'a.png'), 'x');
  assert.equal(tx.nombreLibre(dir, 'a', 'png'), 'a-2.png');
  fs.writeFileSync(path.join(dir, 'a-2.png'), 'x');
  assert.equal(tx.nombreLibre(dir, 'a', 'png'), 'a-3.png');
  assert.equal(tx.nombreLibre(dir, 'b', 'png'), 'b.png');
  fs.rmSync(dir, { recursive: true });
  assert.equal(tx.idLibre([{ id: 'piso-gris' }], 'Piso Gris'), 'piso-gris-2');
  assert.equal(tx.normalizarItem({ id: 'q', nombre: 'Q', color: '#abc' }), null);
  const n = tx.normalizarItem({ id: 'q', nombre: 'Q', color: '#aabbcc', w: '9999', h: 'x', junta: '2', veta: '90', patron: 'trabado' });
  assert.deepEqual([n.w, n.h, n.junta, n.veta, n.patron, n.color], [3000, 600, 2, 90, 'trabado', '#aabbcc']);
  const req = (ip: string, host: string, origin?: string) => ({ socket: { remoteAddress: ip }, headers: { host, ...(origin ? { origin } : {}) } });
  assert.ok(tx.soloLocal(req('127.0.0.1', 'localhost:5173')));
  assert.ok(tx.soloLocal(req('::1', '127.0.0.1:5173', 'http://127.0.0.1:5173')));
  assert.ok(!tx.soloLocal(req('100.101.102.103', 'localhost:5173')), 'red externa');
  assert.ok(!tx.soloLocal(req('127.0.0.1', 'evil.com')), 'rebinding');
  assert.ok(!tx.soloLocal(req('127.0.0.1', 'localhost:5173', 'http://evil.com')), 'CSRF');
});
