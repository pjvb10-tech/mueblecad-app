import { checkBlockName, explodeOnce, findBlock, validateBlocks, blockUsage, wouldCycle } from './blocks';
import { addEntity, DrawingError, findLayer, getEntity, removeEntity, validateDrawing } from './drawing';
import type { EntityInput } from './drawing';
import { entitiesBounds } from './geom2d';
import { blockCtx } from './blocks';
import type { Block, Drawing, Entity, InsertEntity, Pt2 } from './types';

/**
 * Operaciones PURAS e INMUTABLES sobre los bloques de un dibujo (crear, insertar, explotar, editar, renombrar, borrar). Cada una devuelve un
 * dibujo nuevo y lanza DrawingError con un mensaje accionable en español; el resultado pasa `validateDrawing`. Contrato: docs/dibujo-2d.md, sección Bloques.
 * Editar un bloque modifica las entidades de la definición, así que TODAS las instancias (que lo referencian por nombre) se actualizan solas.
 */

const fail = (m: string): never => { throw new DrawingError(m); };
const clonePt = (p: Pt2): Pt2 => [p[0], p[1]];
const deep = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const idFactory = (list: Entity[]): (() => string) => {
  let n = 0;
  const used = new Set(list.map((e) => e.id));
  for (const e of list) { const m = /^e(\d+)$/.exec(e.id); if (m) n = Math.max(n, Number(m[1])); }
  return () => { let id: string; do id = `e${++n}`; while (used.has(id)); used.add(id); return id; };
};

const checked = (d: Drawing): Drawing => { const m = validateDrawing(d); if (m) fail(m); return d; };
const need = (d: Drawing, name: string): Block => findBlock(d, name) ?? fail(`El bloque "${name}" no existe. Bloques: ${(d.blocks ?? []).map((b) => b.name).join(', ') || '(ninguno)'}.`);

/** Resumen de un bloque para listas: nombre, base, cantidad de entidades, usos y caja. */
export function describeBlock(d: Drawing, b: Block): { name: string; base: Pt2; entities: number; uses: number; usesInBlocks: number; description?: string; bounds?: number[] } {
  const u = blockUsage(d, b.name);
  const bb = entitiesBounds(b.entities, blockCtx(d));
  return { name: b.name, base: b.base, entities: b.entities.length, uses: u.inDrawing, usesInBlocks: u.inBlocks, ...(b.description ? { description: b.description } : {}), ...(bb ? { bounds: [...bb.min, ...bb.max] } : {}) };
}

export interface CreateBlockOptions {
  name: string;
  /** Entidades del dibujo que forman el bloque (sus coordenadas se conservan; `base` es el punto que irá sobre el punto de inserción). */
  ids: string[];
  /** Punto base. Por omisión la esquina inferior izquierda de la caja de las entidades. */
  base?: Pt2;
  description?: string;
  /** Reemplaza las entidades originales por un insert en `base` (las originales deben estar en capas editables). */
  replace?: boolean;
  /** Capa del insert de reemplazo ("0" por omisión). */
  layer?: string;
}

/** Crea un bloque con las entidades indicadas (copiadas con ids nuevos dentro del bloque). Con `replace`, las sustituye por un insert. */
export function createBlock(d: Drawing, o: CreateBlockOptions): { drawing: Drawing; name: string; insertId?: string } {
  const nm = checkBlockName(o.name);
  if (nm) fail(nm);
  if (findBlock(d, o.name)) fail(`Ya existe un bloque llamado "${o.name}"; usa otro nombre o edítalo con updateBlock.`);
  if (!Array.isArray(o.ids) || !o.ids.length) fail('Indica al menos una entidad para el bloque (ids).');
  const src = o.ids.map((id) => getEntity(d, id) ?? fail(`No existe la entidad "${id}". Ids: ${d.entities.slice(0, 20).map((e) => e.id).join(', ') || '(ninguno)'}.`));
  const bb = entitiesBounds(src, blockCtx(d));
  const base = o.base ?? (bb ? clonePt(bb.min) : [0, 0]);
  if (!Array.isArray(base) || base.length !== 2 || !base.every((v) => Number.isFinite(v))) fail('base debe ser [x, y] con números finitos.');
  const next = idFactory([]);
  const entities = src.map((e) => { const c = deep(e); c.id = next(); if (c.type === 'hatch') delete c.source; return c; });
  const block: Block = { name: o.name, base: clonePt(base), entities, ...(o.description ? { description: o.description } : {}) };
  let out: Drawing = { ...d, blocks: [...(d.blocks ?? []), block] };
  if (!o.replace) return { drawing: checked(out), name: o.name };
  out = removeEntity(out, o.ids);
  const r = addEntity(out, { type: 'insert', block: o.name, p: block.base, ...(o.layer ? { layer: o.layer } : {}) });
  return { drawing: checked(r.drawing), name: o.name, insertId: r.id };
}

/** Inserta un bloque (azúcar sobre addEntity). `scale` es un atajo para sx = sy. */
export function insertBlock(d: Drawing, o: { block: string; p: Pt2; sx?: number; sy?: number; scale?: number; rot?: number; layer?: string; color?: number | string; cols?: number; rows?: number; dx?: number; dy?: number }): { drawing: Drawing; id: string } {
  need(d, o.block);
  const { color, ...rest } = o;
  const r = addEntity(d, { type: 'insert', ...rest, ...(color !== undefined ? { color } : {}) } as EntityInput);
  return { drawing: checked(r.drawing), id: r.id };
}

/** Explota un insert un nivel: lo sustituye (en el mismo lugar de la lista) por las entidades de su bloque ya transformadas, con ids nuevos. */
export function explodeInsert(d: Drawing, id: string): { drawing: Drawing; ids: string[] } {
  const e = getEntity(d, id) ?? fail(`No existe la entidad "${id}".`);
  if (e.type !== 'insert') return fail(`"${id}" es ${e.type === 'hatch' ? 'un sombreado' : `una entidad ${e.type}`}, no un insert; solo se explotan inserts de bloques.`);
  removeEntity(d, id); // comprueba capa bloqueada / congelada
  const kids = explodeOnce(e, d);
  const next = idFactory(d.entities);
  const made = kids.map((k) => ({ ...k, id: next() }) as Entity);
  const i = d.entities.indexOf(e);
  const entities = [...d.entities.slice(0, i), ...made, ...d.entities.slice(i + 1)];
  return { drawing: checked({ ...d, entities }), ids: made.map((m) => m.id) };
}

/** Borra un bloque. Si está en uso: error, o con `explode` sus inserts se explotan antes (también dentro de otros bloques). */
export function removeBlock(d: Drawing, name: string, o: { explode?: boolean } = {}): Drawing {
  const b = need(d, name);
  const u = blockUsage(d, b.name);
  if (u.inDrawing + u.inBlocks > 0 && !o.explode) fail(`El bloque "${b.name}" está en uso (${u.inDrawing} insert(s) en el dibujo y ${u.inBlocks} dentro de otros bloques). Explótalos primero o repite con explode: true para convertirlos en entidades sueltas.`);
  let cur: Drawing = d;
  const explodeIn = (list: Entity[], host: Drawing): Entity[] => {
    const next = idFactory(list);
    const out: Entity[] = [];
    for (const e of list) {
      if (e.type === 'insert' && e.block.toLowerCase() === b.name.toLowerCase()) {
        const l = findLayer(host, e.layer);
        if (l?.locked || l?.frozen) fail(`No se puede explotar "${e.id}": su capa "${l.name}" está ${l.locked ? 'bloqueada' : 'congelada'}.`);
        for (const k of explodeOnce(e, host)) out.push({ ...k, id: next() } as Entity);
      } else out.push(e);
    }
    return out;
  };
  const blocks = (cur.blocks ?? []).filter((x) => x !== b).map((x) => ({ ...x, entities: explodeIn(x.entities, cur) }));
  cur = { ...cur, entities: explodeIn(cur.entities, cur), blocks };
  if (!blocks.length) { const { blocks: _b, ...rest } = cur; cur = rest; }
  return checked(cur);
}

/** Cambia el nombre de un bloque y actualiza todos los inserts que lo usan (también los de otros bloques). */
export function renameBlock(d: Drawing, name: string, to: string): Drawing {
  const b = need(d, name);
  const m = checkBlockName(to);
  if (m) fail(m);
  if (to.toLowerCase() !== b.name.toLowerCase() && findBlock(d, to)) fail(`Ya existe un bloque llamado "${to}".`);
  const fix = (list: Entity[]): Entity[] => list.map((e) => (e.type === 'insert' && e.block.toLowerCase() === b.name.toLowerCase() ? ({ ...e, block: to } as InsertEntity) : e));
  return checked({
    ...d, entities: fix(d.entities),
    blocks: (d.blocks ?? []).map((x) => (x === b ? { ...x, name: to, entities: fix(x.entities) } : { ...x, entities: fix(x.entities) })),
  });
}

/** El bloque como un dibujo editable (capas del dibujo, entidades locales). Sirve para reutilizar TODAS las operaciones de drawing.ts y las herramientas de ratón. */
export function blockDrawing(d: Drawing, name: string): Drawing {
  const b = need(d, name);
  const { blocks: _b, sheet: _s, ...rest } = d;
  const others = (d.blocks ?? []).filter((x) => x !== b);
  return { ...rest, id: `${d.id}#${b.name}`, name: `${d.name} · bloque ${b.name}`, entities: b.entities, ...(others.length ? { blocks: others } : {}) };
}

/** Escribe de vuelta el dibujo-bloque editado: las entidades pasan a la definición (y las capas nuevas al dibujo). Rechaza ciclos y referencias inexistentes. */
export function applyBlockDrawing(d: Drawing, name: string, edited: Drawing, extra: { base?: Pt2; description?: string | null } = {}): Drawing {
  const b = need(d, name);
  for (const e of edited.entities) if (e.type === 'insert' && wouldCycle(d, b.name, e.block)) fail(`No se puede insertar "${e.block}" dentro del bloque "${b.name}": se contendría a sí mismo.`);
  const nb: Block = { ...b, entities: edited.entities, ...(extra.base ? { base: clonePt(extra.base) } : {}) };
  if (extra.description === null) delete nb.description; else if (extra.description !== undefined) nb.description = extra.description;
  const out: Drawing = { ...d, layers: edited.layers, blocks: (d.blocks ?? []).map((x) => (x === b ? nb : x)) };
  return checked(out);
}

/** Aplica una edición pura (la misma de drawing.ts: addEntities, updateEntity, removeEntity…) a las entidades del bloque. Todas las instancias se actualizan. */
export function editBlock(d: Drawing, name: string, edit: (blockDrawing: Drawing) => Drawing, extra: { base?: Pt2; description?: string | null } = {}): Drawing {
  return applyBlockDrawing(d, name, edit(blockDrawing(d, name)), extra);
}

export { validateBlocks };
