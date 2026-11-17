import { z } from 'zod';
import type { Kit } from './mcpKit';
import type { Store } from './store';
import type { Library } from './library';
import { CATEGORIES, MAX_IMAGE_BYTES } from './library';
import { parseCatalog, SIDES, type Side } from '../src/core/finish';
import { clearFinish, describeFinishes, setFinish, type SideSpec } from '../src/core/finishEdit';
import { estimateTiles, resolveTileSpec, roomTileRegions } from '../src/core/tiles';
import { effectiveFinishes } from '../src/core/finish';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Debe ser #rrggbb');
const veta = z.union([z.literal(0), z.literal(90)]);
const patron = z.enum(['recto', 'trabado']);
const room = z.string().regex(/^H\d{1,3}$/, 'Clave de habitación como H5').describe('Clave de la habitación (H1, H2…; ver list_rooms)');

const adjust = {
  w: z.number().min(20).max(3000).optional().describe('Ancho de la pieza (mm); reemplaza el de la textura'),
  h: z.number().min(20).max(3000).optional().describe('Alto de la pieza (mm)'),
  junta: z.number().min(0).max(30).optional().describe('Ancho de la junta (mm)'),
  colorJunta: hex.optional().describe('Color de la junta #rrggbb'),
  veta: veta.optional().describe('Giro de la imagen dentro de la pieza: 0 o 90 grados'),
  patron: patron.optional().describe("'recto' (juntas continuas) o 'trabado' (cada fila desfasada 50 %)"),
  dx: z.number().min(-100000).max(100000).optional().describe('Desplazamiento horizontal de la pieza (mm) para alinear juntas'),
  dy: z.number().min(-100000).max(100000).optional().describe('Desplazamiento vertical (mm)'),
  altura: z.number().min(100).max(10000).optional().describe('Solo muros: altura del revestimiento desde el piso (mm); sin ella, hasta el cielo'),
};
const sideSpec = z.object({ texture: z.string().optional().describe("Id de textura; '' = ese muro sin revestir; omitido = copia/ajusta el general"), ...adjust }).strict().nullable();

export function registerFinishTools(kit: Kit, store: Store, lib: Library) {
  const catalog = () => parseCatalog(lib.readCatalog());

  kit.read('list_textures', 'Lista la biblioteca de texturas (texturas/catalogo.json): id, nombre, categoría, tamaño de pieza (w×h mm), junta, patrón, veta y si es imagen o color liso. EN: list the texture library.', {}, () =>
    catalog().map((t) => ({ id: t.id, nombre: t.nombre, categoria: t.categoria, tipo: t.archivo ? 'imagen' : 'color', archivo: t.archivo, color: t.color, piezaMm: `${t.w}x${t.h}`, w: t.w, h: t.h, junta: t.junta, colorJunta: t.colorJunta, veta: t.veta, patron: t.patron })));

  kit.files('add_texture',
    `Agrega una textura a la biblioteca desde UNA de estas fuentes: path (ruta local ABSOLUTA de una imagen de UNA pieza/baldosa), base64 (+ filename) o color (#rrggbb liso). Validación: nombre saneado, solo png/jpg/jpeg/webp comprobados por firma del archivo, máx. ${MAX_IMAGE_BYTES / 1024 / 1024} MB, nunca sobrescribe un archivo existente. No descarga de internet: si la imagen está en la web, descárgala tú y pasa la ruta. w×h es el tamaño REAL de la pieza en mm. EN: add a texture from a local image path, base64 or a flat colour.`,
    {
      path: z.string().optional().describe('Ruta local absoluta de la imagen (png/jpg/jpeg/webp). No se aceptan enlaces simbólicos ni rutas de red.'),
      base64: z.string().optional().describe('Imagen en base64 (con o sin prefijo data:)'),
      filename: z.string().optional().describe('Nombre de archivo con extensión (obligatorio con base64; con path, por omisión el de la ruta). Se sanea.'),
      color: hex.optional().describe('Color liso (#rrggbb) en lugar de imagen'),
      nombre: z.string().max(80).optional().describe('Nombre visible'),
      categoria: z.enum(CATEGORIES as [string, ...string[]]).optional(),
      w: z.number().min(20).max(3000).optional().describe('Ancho real de la pieza (mm), 600 por omisión'),
      h: z.number().min(20).max(3000).optional().describe('Alto real de la pieza (mm), 600 por omisión'),
      junta: z.number().min(0).max(30).optional(), colorJunta: hex.optional(), veta: veta.optional(), patron: patron.optional(),
    },
    (a) => {
      const given = [a.path, a.base64, a.color].filter((v) => v !== undefined).length;
      if (given !== 1) throw new Error('Indica exactamente una fuente: path, base64 o color.');
      const meta = { titulo: a.nombre, categoria: a.categoria, w: a.w, h: a.h, junta: a.junta, colorJunta: a.colorJunta, veta: a.veta, patron: a.patron };
      if (a.color) return lib.addColor(a.color, meta);
      if (a.base64) {
        if (!a.filename) throw new Error('Con base64 hace falta filename (por ejemplo "piso.png").');
        return lib.addFromBase64(a.base64, a.filename, meta);
      }
      return lib.addFromFile(a.path!, { ...meta, nombre: a.filename });
    });

  kit.files('update_texture', 'Cambia datos de una textura de la biblioteca (nombre, categoría, tamaño de pieza, junta, color de junta, veta, patrón, o el color si es liso). No cambia el id ni la imagen. EN: edit a texture entry.',
    {
      id: z.string(), nombre: z.string().max(80).optional(), categoria: z.enum(CATEGORIES as [string, ...string[]]).optional(),
      color: hex.optional().describe('Solo para texturas de color liso'),
      w: z.number().min(20).max(3000).optional(), h: z.number().min(20).max(3000).optional(), junta: z.number().min(0).max(30).optional(),
      colorJunta: hex.optional(), veta: veta.optional(), patron: patron.optional(),
    },
    ({ id, nombre, ...rest }) => lib.update(id, { ...rest, ...(nombre !== undefined ? { titulo: nombre } : {}) }));

  kit.files('remove_texture', 'Quita una textura de la biblioteca. El archivo de imagen solo se borra si ninguna otra entrada lo usa. Si algún acabado la usa, se rechaza salvo force=true (esos acabados dejarían de verse). EN: delete a texture (file kept if shared).',
    { id: z.string(), deleteFile: z.boolean().optional().describe('Borrar también el archivo de imagen (true por omisión; solo si nadie más lo usa)'), force: z.boolean().optional() },
    ({ id, deleteFile, force }) => {
      const { project } = store.readProject();
      const users = lib.usage(project, id);
      if (users.length && !force) throw new Error(`La textura "${id}" la usan los acabados de ${users.join(', ')}. Quita esos acabados (clear_finish) o repite con force=true.`);
      const r = lib.remove(id, deleteFile ?? true);
      return { ...r, usadaPor: users };
    });

  kit.write('set_finish',
    "Asigna o ajusta el acabado (textura de la biblioteca) del piso o de los muros de una habitación H#. Con texture reemplaza la textura de esa superficie; sin texture solo ajusta el acabado ya asignado. En muros se puede dar altura (mm desde el piso) y sides: acabado propio por muro norte/sur/este/oeste (texture '' = ese muro sin revestir; null = vuelve al general). Los ajustes w/h/junta/colorJunta/veta/patron/dx/dy reemplazan los de la textura. norte = muro de z menor (arriba en el plano). Ver describe_room. EN: set floor/wall finish of a room.",
    {
      room, surface: z.enum(['floor', 'walls']).describe("'floor' = piso, 'walls' = muros"),
      texture: z.string().optional().describe("Id de la textura (list_textures). En muros, '' deja el muro general sin revestir (útil con sides)."),
      ...adjust,
      sides: z.object({ norte: sideSpec.optional(), sur: sideSpec.optional(), este: sideSpec.optional(), oeste: sideSpec.optional() }).strict().optional().describe('Solo muros: acabado propio por lado'),
    },
    ({ room: r, surface, texture, sides, ...adj }) => store.updateProject((p) => {
      const msg = setFinish(p, catalog(), { room: r, surface, texture, adjust: adj, sides: sides as Partial<Record<Side, SideSpec>> | undefined });
      return `${msg}\nLa app web se actualiza sola en ~1 s.`;
    }));

  kit.write('clear_finish', "Quita el acabado de una habitación: surface 'floor', 'walls' o 'all' (por omisión). Con side (norte/sur/este/oeste) quita solo el ajuste propio de ese muro (vuelve al acabado general de muros). EN: remove finishes of a room.",
    { room, surface: z.enum(['floor', 'walls', 'all']).optional(), side: z.enum(SIDES as [Side, ...Side[]]).optional() },
    ({ room: r, surface, side }) => store.updateProject((p) => clearFinish(p, catalog(), r, surface ?? 'all', side)));

  kit.read('get_finishes', 'Acabados vigentes por habitación (piso y muros) con los valores ya resueltos (pieza, junta, patrón, altura) y avisos de texturas faltantes. Incluye los del formato antiguo roomFloors. EN: finishes per room.',
    { room: room.optional().describe('Una sola habitación; omitido = todas') },
    ({ room: r }) => {
      const { project } = store.readProject();
      const d = describeFinishes(project, catalog());
      return r ? { ...d, acabados: d.acabados.filter((x) => x.room === r) } : d;
    });

  kit.read('estimate_tiles',
    'Estima cuántas losas comprar para el piso y/o los muros de una habitación: coloca la grilla con junta, descuenta puertas y ventanas, recorta los bordes y empaqueta los recortes en losas enteras con cortes de guillotina (kerf). Devuelve piezas enteras, recortes, total, total con reserva, % de pérdida y costo. La pieza es la medida comprada (w×h sin junta). Es una estimación: la colocación real puede variar. EN: tile quantity, waste % and cost for a room.',
    {
      room,
      surface: z.enum(['floor', 'walls', 'both']).optional().describe("'floor' por omisión"),
      texture: z.string().optional().describe('Textura de la biblioteca; omitida = la asignada a esa superficie'),
      w: z.number().min(20).max(3000).optional(), h: z.number().min(20).max(3000).optional(), junta: z.number().min(0).max(30).optional(), patron: patron.optional(),
      altura: z.number().min(100).max(10000).optional().describe('Muros: altura del revestimiento desde el piso (mm); omitida = la del acabado o hasta el cielo'),
      sides: z.array(z.enum(SIDES as [Side, ...Side[]])).optional().describe('Muros: solo estos lados'),
      kerf: z.number().min(0).max(20).optional().describe('Grosor del corte (mm), 3 por omisión'),
      optimize: z.boolean().optional().describe('Probar desfases de la grilla para usar menos losas (más lento)'),
      rotate: z.boolean().optional().describe('Permitir girar 90° los recortes (no con veta/dibujo direccional)'),
      reservePct: z.number().min(0).max(50).optional().describe('Reserva por roturas (% de las losas)'),
      pricePerTile: z.number().min(0).optional().describe('Precio por losa'),
      pricePerM2: z.number().min(0).optional().describe('Precio por m² de losa (alternativa a pricePerTile)'),
    },
    (a) => {
      const { project } = store.readProject();
      const plan = project.plan;
      if (!plan) throw new Error('El proyecto no tiene plano: no hay habitaciones.');
      const surface = a.surface ?? 'floor';
      const eff = effectiveFinishes(project, catalog());
      const rf = eff.finishes[a.room];
      const spec = resolveTileSpec(eff.catalog, a.texture, rf, surface, { w: a.w, h: a.h, junta: a.junta, patron: a.patron });
      const altura = a.altura ?? (surface !== 'floor' ? spec.altura ?? rf?.walls?.altura : undefined);
      const regions = roomTileRegions(plan, a.room, { surface, altura, lados: a.sides });
      const est = estimateTiles(regions, { w: spec.w, h: spec.h, junta: spec.junta, patron: spec.patron, kerf: a.kerf, girar: a.rotate, optimizar: a.optimize, reservaPct: a.reservePct });
      const unit = a.pricePerTile ?? (a.pricePerM2 !== undefined ? a.pricePerM2 * est.piezaM2 : undefined);
      return {
        habitacion: a.room, superficie: surface, textura: a.texture ?? rf?.floor?.tex ?? rf?.walls?.tex,
        pieza: { w: spec.w, h: spec.h, junta: spec.junta, patron: spec.patron },
        ...(altura ? { alturaMuros: altura } : {}),
        ...est,
        ...(unit !== undefined ? { precioPorLosa: Math.round(unit * 100) / 100, costo: Math.round(est.total * unit * 100) / 100, costoConReserva: Math.round(est.totalConReserva * unit * 100) / 100 } : {}),
      };
    });
}
