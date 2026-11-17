import { z, type ZodRawShape } from 'zod';
import type { Kit } from './mcpKit';
import type { Store } from './store';
import { addDrawingCommands, applyDrawingBatch, pickDrawing } from './mcpDrawing';
import { blockUsage, findBlock } from '../src/core/blocks';
import { blockDrawing, createBlock, describeBlock, editBlock, explodeInsert, insertBlock, removeBlock, renameBlock } from '../src/core/blockOps';
import { addEntity, DrawingError, getEntity, validateDrawings, withDrawing, type EntityInput } from '../src/core/drawing';
import { findBoundary, hatchArea, loopsFromEntities, syncAllHatches } from '../src/core/hatch';
import { defaultHardware, HATCH_PATTERNS, type Drawing, type Project } from '../src/core/types';

/**
 * Herramientas MCP de sombreados y bloques (contrato: docs/dibujo-2d.md, secciones Sombreados y Bloques):
 * draw_hatch, block_create, block_list, block_get, block_update, block_remove, insert_block y explode_insert.
 * Mismas reglas que server/mcpDrawing.ts: las de escritura mutan el proyecto recibido, se validan con validateDrawings y se guardan con respaldo
 * y reintento por rev (updateProject); dryRun=true solo valida. Los errores llegan como mensajes en español.
 */

const num = z.number().finite();
const pt = z.tuple([num, num]).describe('[x, y] en mm, en el plano del dibujo (x derecha, y arriba)');
const color = z.union([z.number().int().min(1).max(255), z.string().regex(/^#[0-9a-fA-F]{6}$/)]).describe('Color: índice ACI 1..255 o "#rrggbb". Sin color = el de la capa');
const dref = z.string().optional().describe('Id (d1) o nombre del dibujo. Se puede omitir si el proyecto tiene un solo dibujo');
const polyVertex = z.union([pt, z.object({ p: pt, bulge: num.optional().describe('tan(barrido/4): + arco antihorario, - horario, 1 = semicírculo') })]);

interface Command {
  name: string;
  mode: 'read' | 'write';
  desc: string;
  shape: ZodRawShape;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (project: Project, args: any) => unknown;
}

const clean = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const put = (project: Project, d: Drawing): void => { project.drawings = withDrawing(project, d).drawings; };
const ids = z.array(z.string()).min(1).max(5000).describe('Ids de entidades');

export const HATCH_BLOCK_COMMANDS: Command[] = [
  {
    name: 'draw_hatch', mode: 'write',
    desc: `Sombrea una región con un patrón. Indica el contorno de UNA de tres formas: point [x,y] (punto interior: busca el contorno cerrado más pequeño que lo rodea entre las líneas, arcos, círculos y polilíneas visibles y detecta las islas como huecos), entities (ids de entidades cerradas —polilíneas cerradas, rectángulos, círculos— o líneas/arcos que cierren un lazo; las cerradas quedan ASOCIADAS: si se mueven o cambian, el sombreado se recalcula) o loops (lista de contornos, cada uno lista de [x,y] o {p, bulge}). Relleno par-impar: un contorno dentro de otro es un hueco. pattern: ${HATCH_PATTERNS.join(' | ')} (por omisión ansi31: líneas a 45°); angle en grados (antihorario, gira el patrón); scale = separación entre líneas del patrón en mm (50 por omisión; en brick es la altura de hilada); color = el de las líneas (sin color = el de la capa); fillColor = color de fondo (en solid, el relleno). associative=false desactiva la asociatividad. Devuelve el id y la cantidad de contornos. dryRun=true solo valida. EN: hatch a region (pattern fill).`,
    shape: {
      drawing: dref,
      point: pt.optional().describe('Punto interior para detectar el contorno'),
      entities: ids.optional().describe('Entidades que forman el contorno'),
      loops: z.array(z.array(polyVertex).min(2).max(5000)).min(1).max(500).optional().describe('Contornos explícitos'),
      pattern: z.enum(HATCH_PATTERNS).optional(),
      angle: num.optional(), scale: z.number().positive().optional(),
      color: color.optional(), fillColor: color.optional(),
      layer: z.string().min(1).optional().describe('Capa (debe existir). Sin capa usa "0"'),
      associative: z.boolean().optional(),
    },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      const given = [a.point, a.entities, a.loops].filter((v) => v !== undefined).length;
      if (given !== 1) throw new Error('Indica exactamente uno de: point (punto interior), entities (ids de entidades de contorno) o loops (contornos explícitos).');
      let loops: unknown[], source: string[] | undefined;
      if (a.point) {
        const b = findBoundary(d, a.point);
        if (!b) throw new Error(`El punto [${a.point.join(', ')}] no está dentro de un contorno cerrado de ${d.id} (revisa que las líneas cierren o usa entities / loops).`);
        loops = b.loops; source = b.source;
      } else if (a.entities) {
        let b;
        try { b = loopsFromEntities(d, a.entities); } catch (e) { throw new Error((e as Error).message); }
        loops = b.loops; source = b.source;
      } else loops = a.loops;
      const input = { type: 'hatch', loops, pattern: a.pattern ?? 'ansi31', ...clean({ angle: a.angle, scale: a.scale, color: a.color, fillColor: a.fillColor, layer: a.layer }), ...(a.associative === false || !source ? {} : { source }) } as unknown as EntityInput;
      const r = addEntity(d, input);
      put(p, r.drawing);
      const h = getEntity(r.drawing, r.id);
      return { drawing: d.id, id: r.id, loops: (loops as unknown[]).length, associative: !!(h && h.type === 'hatch' && h.source), ...(h && h.type === 'hatch' ? { areaMm2: Math.round(hatchArea(h) * 100) / 100 } : {}) };
    },
  },
  {
    name: 'block_create', mode: 'write',
    desc: 'Crea un bloque editable con entidades del dibujo (se copian con ids propios dentro del bloque y conservan sus coordenadas; base es el punto que irá sobre el punto de inserción; por omisión la esquina inferior izquierda de su caja). replace=true sustituye las entidades originales por un insert del bloque en base (layer = capa del insert, "0" por omisión). Nombre único sin distinguir mayúsculas, sin < > / \\ " : ; ? * | =. Después úsalo con insert_block. EN: create a block from entities.',
    shape: { drawing: dref, name: z.string().min(1).max(120), entities: ids, base: pt.optional(), description: z.string().max(300).optional(), replace: z.boolean().optional(), layer: z.string().min(1).optional() },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      const r = createBlock(d, { name: a.name, ids: a.entities, ...clean({ base: a.base, description: a.description, replace: a.replace, layer: a.layer }) });
      put(p, r.drawing);
      const b = findBlock(r.drawing, a.name)!;
      return { drawing: d.id, name: b.name, base: b.base, entities: b.entities.length, ...(r.insertId ? { insertId: r.insertId } : {}) };
    },
  },
  {
    name: 'block_list', mode: 'read', desc: 'Lista los bloques de un dibujo: nombre, punto base, cantidad de entidades, usos (inserts en el dibujo y dentro de otros bloques), descripción y caja local [x0,y0,x1,y1]. EN: list blocks.',
    shape: { drawing: dref },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); return { drawing: d.id, blocks: (d.blocks ?? []).map((b) => describeBlock(d, b)) }; },
  },
  {
    name: 'block_get', mode: 'read', desc: 'Devuelve un bloque completo (nombre, base, descripción y sus entidades en coordenadas locales) y dónde se usa. EN: get a block definition.',
    shape: { drawing: dref, name: z.string().min(1) },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      const b = findBlock(d, a.name);
      if (!b) throw new Error(`El bloque "${a.name}" no existe. Bloques: ${(d.blocks ?? []).map((x) => x.name).join(', ') || '(ninguno)'}.`);
      return { drawing: d.id, ...b, usage: blockUsage(d, b.name), insertIds: d.entities.filter((e) => e.type === 'insert' && e.block.toLowerCase() === b.name.toLowerCase()).map((e) => e.id) };
    },
  },
  {
    name: 'block_update', mode: 'write',
    desc: 'Edita la definición de un bloque: TODAS las instancias (inserts) se actualizan porque lo referencian por nombre. Todo-o-nada. add[] = entidades nuevas (mismos campos que drawing_batch: type line|poly|rect|circle|arc|text|dim|hatch|insert + campos), update[] = {id, …campos} (ids DENTRO del bloque; color:null vuelve a PorCapa), remove[] = ids del bloque; además base (nuevo punto base local), description (null la borra) y rename (nombre nuevo: actualiza todos los inserts). No se permite insertar un bloque dentro de sí mismo ni más de 8 niveles. Ver ids con block_get. EN: edit a block (updates every instance).',
    shape: {
      drawing: dref, name: z.string().min(1), rename: z.string().min(1).max(120).optional(), base: pt.optional(), description: z.string().max(300).nullable().optional(),
      add: z.array(z.object({ type: z.enum(['line', 'poly', 'rect', 'circle', 'arc', 'text', 'dim', 'hatch', 'insert']) }).passthrough()).max(5000).optional(),
      update: z.array(z.object({ id: z.string() }).passthrough()).max(5000).optional(),
      remove: z.array(z.string()).max(5000).optional(),
    },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      const batch = { add: a.add, update: a.update, remove: a.remove };
      let out = editBlock(d, a.name, (bd) => (batch.add || batch.update || batch.remove ? applyDrawingBatch(bd, batch).drawing : bd), clean({ base: a.base, description: a.description }) as never);
      if (a.rename && a.rename !== a.name) out = renameBlock(out, a.name, a.rename);
      put(p, out);
      const b = findBlock(out, a.rename ?? a.name)!;
      return { drawing: d.id, name: b.name, entities: b.entities.length, uses: blockUsage(out, b.name) };
    },
  },
  {
    name: 'block_remove', mode: 'write',
    desc: 'Borra un bloque. Si algún insert lo usa se rechaza, salvo explode=true: entonces esos inserts se convierten antes en entidades sueltas (también dentro de otros bloques). EN: delete a block.',
    shape: { drawing: dref, name: z.string().min(1), explode: z.boolean().optional() },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); put(p, removeBlock(d, a.name, { explode: a.explode })); return `Bloque "${a.name}" eliminado.`; },
  },
  {
    name: 'insert_block', mode: 'write',
    desc: 'Inserta un bloque existente: p = punto donde cae su punto base, scale (atajo para sx = sy) o sx / sy (≠ 0; negativo = espejo), rot en grados (antihorario), layer / color del insert (los hijos en la capa "0" toman esa capa; los sin color propio, ese color). Arreglo: cols × rows copias separadas dx (columnas) y dy (filas) mm (máximo 10 000 copias). Devuelve el id del insert. EN: insert a block instance.',
    shape: { drawing: dref, block: z.string().min(1), p: pt, scale: z.number().finite().optional(), sx: num.optional(), sy: num.optional(), rot: num.optional(), layer: z.string().min(1).optional(), color: color.optional(), cols: z.number().int().min(1).max(1000).optional(), rows: z.number().int().min(1).max(1000).optional(), dx: num.optional(), dy: num.optional() },
    run: (p, a) => {
      const d = pickDrawing(p, a.drawing);
      const { drawing: _d, ...rest } = a;
      const r = insertBlock(d, clean(rest) as never);
      put(p, r.drawing);
      return { drawing: d.id, id: r.id };
    },
  },
  {
    name: 'explode_insert', mode: 'write',
    desc: 'Explota un insert un nivel: lo sustituye por las entidades de su bloque ya transformadas (ids nuevos). Los bloques anidados siguen siendo inserts. No toca la definición del bloque. EN: explode a block instance into entities.',
    shape: { drawing: dref, id: z.string().min(1).describe('Id del insert') },
    run: (p, a) => { const d = pickDrawing(p, a.drawing); const r = explodeInsert(d, a.id); put(p, r.drawing); return { drawing: d.id, ids: r.ids }; },
  },
];

const byName = new Map(HATCH_BLOCK_COMMANDS.map((c) => [c.name, c]));
const dryShape = { dryRun: z.boolean().optional().describe('Solo validar: no guarda nada') };
const shapeOf = (c: Command): ZodRawShape => (c.mode === 'write' ? { ...c.shape, ...dryShape } : c.shape);
const zmsg = (err: z.ZodError) => err.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ');

function runParsed(store: Store, c: Command, a: Record<string, unknown>): unknown {
  const fresh = () => { const { project } = store.readProject(); project.hardware ??= defaultHardware(); return project; };
  const checked = (p: Project) => { const m = validateDrawings(p); if (m) throw new Error(m); };
  try {
    if (c.mode === 'read') return c.run(fresh(), a);
    if (a.dryRun) {
      const p = structuredClone(fresh());
      const r = c.run(p, a);
      checked(p);
      return { dryRun: true, nota: 'Validado: no se guardó nada.', resultado: r };
    }
    return store.updateProject((p) => { p.hardware ??= defaultHardware(); const before = p.drawings; const r = c.run(p, a); const sy = syncAllHatches(before, p.drawings); if (sy !== p.drawings) p.drawings = sy; checked(p); return r; });
  } catch (e) {
    if (e instanceof DrawingError) throw new Error(e.message);
    throw e;
  }
}

/** Ejecuta un comando de sombreados / bloques por nombre (lo usan las pruebas y se puede usar desde otros módulos). */
export function runHatchBlockCommand(store: Store, name: string, args: Record<string, unknown>): unknown {
  const c = byName.get(name);
  if (!c) throw new Error(`No existe el comando "${name}". Comandos: ${HATCH_BLOCK_COMMANDS.map((x) => x.name).join(', ')}.`);
  const parsed = z.object(shapeOf(c)).strict().safeParse(args);
  if (!parsed.success) throw new Error(`${name}: parámetros no válidos. ${zmsg(parsed.error)}`);
  return runParsed(store, c, parsed.data);
}

addDrawingCommands(HATCH_BLOCK_COMMANDS); // también por drawing_execute / drawing_list_commands

export function registerHatchBlockTools(kit: Kit, store: Store): void {
  for (const c of HATCH_BLOCK_COMMANDS) {
    const reg = kit[c.mode] as (n: string, d: string, s: ZodRawShape, f: (a: Record<string, unknown>) => unknown) => void;
    reg(c.name, c.desc, shapeOf(c), (a) => runParsed(store, c, a));
  }
}

export { blockDrawing };
