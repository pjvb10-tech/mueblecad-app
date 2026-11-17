import { findLayer, validateEntity } from './drawing';
import { bulgeArc, dimGeometry, norm360, tessellateArc, tessellateCircle, tessellatePoly } from './geom2d';
import type { BlockCtx } from './geom2d';
import type { ArcEntity, Block, DimAlignedEntity, DimLinearEntity, Drawing, DrawingColor, Entity, HatchEntity, InsertEntity, PolyVertex, Pt2 } from './types';

/**
 * Bloques: resolución de inserciones (`resolveInsert`), matrices y validación. Núcleo puro, sin DOM. Las operaciones que modifican
 * el dibujo (crear, insertar, explotar, editar, renombrar, borrar) están en blockOps.ts. Contrato: docs/dibujo-2d.md, sección Bloques.
 *
 * Modelo: mundo = p + R(rot)·S(sx, sy)·(local − base) (+ desplazamiento de arreglo en el marco girado). Esta función y drawing.ts se importan
 * mutuamente, pero solo se llaman en tiempo de ejecución (no al cargar los módulos).
 */

export const MAX_BLOCK_DEPTH = 8;
/** Tope de copias de un arreglo (cols × rows) y de entidades resueltas por insert. */
export const MAX_ARRAY = 10000;
const BAD_NAME = /[<>/\\":;?*|=`\r\n]/;
const TOL = 0.1;

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const findBlock = (d: Pick<Drawing, 'blocks'>, name: string): Block | undefined => (d.blocks ?? []).find((b) => sameName(b.name, name));

// ---------------------------------------------------------------- matrices

/** Mat = [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];
export const mmul = (A: Mat, B: Mat): Mat => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
export const mpt = (m: Mat, p: Pt2): Pt2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

/** Matriz de UNA copia del insert (i = fila, j = columna del arreglo). */
export function insertMatrix(ins: InsertEntity, base: Pt2, i = 0, j = 0): Mat {
  const sx = ins.sx ?? 1, sy = ins.sy ?? 1, r = ((ins.rot ?? 0) * Math.PI) / 180;
  const cs = Math.cos(r), sn = Math.sin(r);
  const local: Mat = [sx, 0, 0, sy, -base[0] * sx + j * (ins.dx ?? 0), -base[1] * sy + i * (ins.dy ?? 0)];
  return mmul([cs, sn, -sn, cs, ins.p[0], ins.p[1]], local);
}

interface Sim { s: number; theta: number; mirrored: boolean }
/** Si la matriz es una semejanza (escala uniforme, giro y quizá espejo) devuelve sus parámetros; si no, null. */
export function similarity(m: Mat): Sim | null {
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  if (sx < 1e-12 || sy < 1e-12) return null;
  if (Math.abs(sx - sy) > 1e-9 * Math.max(sx, sy)) return null;
  if (Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-9 * sx * sy) return null;
  return { s: sx, theta: (Math.atan2(m[1], m[0]) * 180) / Math.PI, mirrored: m[0] * m[3] - m[1] * m[2] < 0 };
}

/** Parámetros de insert (rot, sx, sy y el punto que corresponde al origen local) equivalentes a una matriz, o null si tiene sesgo. */
export function matrixToInsert(m: Mat, base: Pt2): { p: Pt2; sx: number; sy: number; rot: number } | null {
  const a = Math.hypot(m[0], m[1]), b = Math.hypot(m[2], m[3]);
  if (a < 1e-12 || b < 1e-12 || Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-9 * a * b) return null;
  const det = m[0] * m[3] - m[1] * m[2];
  return { p: mpt(m, base), sx: a, sy: det < 0 ? -b : b, rot: norm360((Math.atan2(m[1], m[0]) * 180) / Math.PI) };
}

// ---------------------------------------------------------------- transformar una entidad con una matriz

const clean = (v: number): number => (Math.abs(v) < 1e-9 ? 0 : v);

function transformHatch(e: HatchEntity, m: Mat): HatchEntity {
  const sm = similarity(m);
  const out: HatchEntity = { ...e, loops: [] };
  if (sm) {
    out.loops = e.loops.map((l) => l.map((v): PolyVertex => (v.bulge ? { p: mpt(m, v.p), bulge: sm.mirrored ? -v.bulge : v.bulge } : { p: mpt(m, v.p) })));
    out.scale = (e.scale ?? 50) * sm.s;
    out.angle = norm360(sm.mirrored ? sm.theta - (e.angle ?? 0) : (e.angle ?? 0) + sm.theta);
  } else {
    out.loops = e.loops.map((l) => tessellatePoly({ pts: l, closed: true }, TOL).map((p): PolyVertex => ({ p: mpt(m, p) })));
    out.scale = (e.scale ?? 50) * (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2;
    out.angle = norm360((e.angle ?? 0) + (Math.atan2(m[1], m[0]) * 180) / Math.PI);
  }
  if (!out.angle) delete out.angle;
  if (e.scale === undefined && Math.abs(out.scale - 50) < 1e-9) delete out.scale;
  delete out.source;
  return out;
}

/** Transforma una entidad con una matriz cualquiera (con espejo y escala no uniforme). Una cota con escala no uniforme se descompone en líneas y textos. */
export function transformEntityMat(e: Entity, m: Mat, tol = TOL): Entity[] {
  const sm = similarity(m);
  const th = sm?.theta ?? (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const sc = sm?.s ?? Math.hypot(m[2], m[3]);
  const polyOut = (pts: Pt2[], closed: boolean): Entity => ({ ...e, type: 'poly', pts: pts.map((p) => ({ p: mpt(m, p) })), ...(closed ? { closed: true } : {}) } as Entity);
  switch (e.type) {
    case 'line': return [{ ...e, a: mpt(m, e.a), b: mpt(m, e.b) }];
    case 'poly':
      if (!e.pts.some((v) => v.bulge)) return [polyOut(e.pts.map((v) => v.p), !!e.closed)];
      if (sm) return [{ ...e, pts: e.pts.map((v) => (v.bulge ? { p: mpt(m, v.p), bulge: sm.mirrored ? -v.bulge : v.bulge } : { p: mpt(m, v.p) })) }];
      return [polyOut(tessellatePoly(e, tol / Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]), 1e-12)), !!e.closed)];
    case 'circle':
      if (sm) return [{ ...e, c: mpt(m, e.c), r: e.r * sm.s }];
      return [polyOut(tessellateCircle(e.c, e.r, tol / Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]), 1e-12)), true)];
    case 'arc':
      if (sm) {
        const [a0, a1] = sm.mirrored ? [sm.theta - e.a1, sm.theta - e.a0] : [sm.theta + e.a0, sm.theta + e.a1];
        return [{ ...e, c: mpt(m, e.c), r: e.r * sm.s, a0: norm360(a0), a1: norm360(a1) } as ArcEntity];
      }
      return [polyOut(tessellateArc(e.c, e.r, e.a0, e.a1, tol / Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]), 1e-12)), false)];
    case 'text': {
      const t = { ...e, p: mpt(m, e.p), h: e.h * sc } as typeof e;
      const rot = norm360(sm?.mirrored ? th - (e.rot ?? 0) : (e.rot ?? 0) + th);
      if (rot > 1e-9 && rot < 360 - 1e-9) t.rot = clean(rot); else delete t.rot;
      return [t];
    }
    case 'dim': {
      if (!sm) {
        const g = dimGeometry(e);
        const out: Entity[] = g.lines.map(([a, b], i) => ({ id: `${e.id}.l${i}`, layer: e.layer, ...(e.color !== undefined ? { color: e.color } : {}), type: 'line', a: mpt(m, a), b: mpt(m, b) }) as Entity);
        g.texts.forEach((t, i) => out.push(...transformEntityMat({ id: `${e.id}.t${i}`, layer: e.layer, ...(e.color !== undefined ? { color: e.color } : {}), type: 'text', p: t.p, h: t.h, s: t.s, rot: t.rot, align: t.align } as Entity, m, tol)));
        return out;
      }
      if (e.kind === 'radius' || e.kind === 'diameter') {
        const t = { ...e, c: mpt(m, e.c), r: e.r * sm.s } as typeof e;
        const ang = sm.mirrored ? sm.theta - (e.ang ?? 45) : (e.ang ?? 45) + sm.theta;
        if (e.ang !== undefined || Math.abs(sm.theta) > 1e-9 || sm.mirrored) t.ang = ang;
        return [t];
      }
      const d = e as DimLinearEntity | DimAlignedEntity;
      const t: Record<string, unknown> = { ...d, p1: mpt(m, d.p1), p2: mpt(m, d.p2), at: mpt(m, d.at) };
      if (d.kind === 'linear') {
        const rot = sm.mirrored ? sm.theta - (d.rot ?? 0) : (d.rot ?? 0) + sm.theta;
        if (Math.abs(norm360(rot)) > 1e-9 && Math.abs(norm360(rot) - 360) > 1e-9) t.rot = rot; else delete t.rot;
      }
      return [t as unknown as Entity];
    }
    case 'hatch': return [transformHatch(e, m)];
    case 'insert': {
      // un insert suelto (sin resolver): se compone con su propia matriz solo si no hay arreglo; si no, la resolución lo hará por copias
      return [e];
    }
  }
}

// ---------------------------------------------------------------- resolución

interface Inherit { layer: string; color?: DrawingColor; prefix: string }

/** Entidades de un bloque aplicando una matriz de insert; `keepNested` deja los inserts anidados como inserts (si la composición es representable). */
function expand(d: Pick<Drawing, 'blocks'>, block: Block, m: Mat, inh: Inherit, depth: number, keepNested: boolean, out: Entity[]): void {
  if (depth > MAX_BLOCK_DEPTH) return;
  for (const child of block.entities) {
    const layer = child.layer === '0' ? inh.layer : child.layer;
    const color = child.color ?? inh.color;
    if (child.type === 'insert') {
      const nb = findBlock(d, child.block);
      if (!nb) continue;
      const cols = Math.max(1, child.cols ?? 1), rows = Math.max(1, child.rows ?? 1);
      const total = Math.min(cols * rows, MAX_ARRAY);
      for (let k = 0; k < total; k++) {
        const i = Math.floor(k / cols), j = k % cols;
        const mc = mmul(m, insertMatrix(child, nb.base, i, j));
        const prefix = `${inh.prefix}${child.id}${total > 1 ? `#${k}` : ''}/`;
        const ni: Inherit = { layer, ...(color !== undefined ? { color } : {}), prefix };
        const rep = keepNested ? matrixToInsert(mc, nb.base) : null;
        if (rep) {
          const e: InsertEntity = { id: `${inh.prefix}${child.id}${total > 1 ? `#${k}` : ''}`, layer, ...(color !== undefined ? { color } : {}), type: 'insert', block: nb.name, p: rep.p };
          if (Math.abs(rep.sx - 1) > 1e-12) e.sx = rep.sx;
          if (Math.abs(rep.sy - 1) > 1e-12) e.sy = rep.sy;
          if (rep.rot > 1e-9 && rep.rot < 360 - 1e-9) e.rot = rep.rot;
          out.push(e);
        } else expand(d, nb, mc, ni, depth + 1, false, out);
      }
      continue;
    }
    for (const t of transformEntityMat(child, m)) {
      const e = { ...t, id: `${inh.prefix}${t.id}`, layer: t.layer === child.layer ? layer : t.layer } as Entity;
      if (color !== undefined && e.color === undefined) e.color = color;
      out.push(e);
    }
  }
}

const cache = new WeakMap<object, WeakMap<InsertEntity, Entity[]>>();
const EMPTY: Block[] = [];

/**
 * Entidades resueltas de un insert (con su transformación, arreglo, anidados incluidos), listas para dibujar, exportar, medir o imantar.
 * Los ids son `idInsert/idHijo` (y `idInsert#k/idHijo` en arreglos). Memoizado por insert y por lista de bloques: no mutar entidades ya entregadas.
 */
export function resolveInsert(ins: InsertEntity, d: Pick<Drawing, 'blocks'>): Entity[] {
  const key: object = d.blocks ?? EMPTY;
  let per = cache.get(key);
  if (!per) cache.set(key, (per = new WeakMap()));
  const hit = per.get(ins);
  if (hit) return hit;
  const out: Entity[] = [];
  const block = findBlock(d, ins.block);
  if (block) {
    const cols = Math.max(1, ins.cols ?? 1), rows = Math.max(1, ins.rows ?? 1);
    const total = Math.min(cols * rows, MAX_ARRAY);
    for (let k = 0; k < total; k++) {
      const i = Math.floor(k / cols), j = k % cols;
      expand(d, block, insertMatrix(ins, block.base, i, j), { layer: ins.layer, ...(ins.color !== undefined ? { color: ins.color } : {}), prefix: `${ins.id}${total > 1 ? `#${k}` : ''}/` }, 1, false, out);
    }
  }
  per.set(ins, out);
  return out;
}

/** Un solo nivel (para "Explotar"): los inserts anidados siguen siendo inserts (con la transformación compuesta) cuando se puede. Ids sin prefijo de ruta. */
export function explodeOnce(ins: InsertEntity, d: Pick<Drawing, 'blocks'>): Entity[] {
  const block = findBlock(d, ins.block);
  if (!block) return [];
  const out: Entity[] = [];
  const cols = Math.max(1, ins.cols ?? 1), rows = Math.max(1, ins.rows ?? 1);
  const total = Math.min(cols * rows, MAX_ARRAY);
  for (let k = 0; k < total; k++) {
    const i = Math.floor(k / cols), j = k % cols;
    expand(d, block, insertMatrix(ins, block.base, i, j), { layer: ins.layer, ...(ins.color !== undefined ? { color: ins.color } : {}), prefix: '' }, 1, true, out);
  }
  return out;
}

const emptyCtx: BlockCtx = { resolveInsert: () => [] };
const ctxCache = new WeakMap<object, BlockCtx>();
/** Contexto para geom2d (`entityBounds(e, ctx)`, `distPointEntity(p, e, ctx)`) y prims2d. Un dibujo sin bloques da un contexto vacío. */
export function blockCtx(d: Pick<Drawing, 'blocks'>): BlockCtx {
  if (!d.blocks?.length) return emptyCtx;
  let c = ctxCache.get(d.blocks);
  if (!c) ctxCache.set(d.blocks, (c = { resolveInsert: (e) => resolveInsert(e, d) }));
  return c;
}

/** Todas las entidades del dibujo con los inserts sustituidos por su geometría resuelta. Con `visibleOnly` se omiten los inserts cuya capa está apagada o congelada. */
export function flattenEntities(d: Drawing, opts: { visibleOnly?: boolean } = {}): Entity[] {
  if (!d.blocks?.length && !d.entities.some((e) => e.type === 'insert')) return d.entities;
  const out: Entity[] = [];
  for (const e of d.entities) {
    if (e.type !== 'insert') { out.push(e); continue; }
    if (opts.visibleOnly) { const l = findLayer(d, e.layer); if (l && (!l.on || l.frozen)) continue; }
    for (const c of resolveInsert(e, d)) out.push(c);
  }
  return out;
}
/** Mismo dibujo con los inserts resueltos (y sin `blocks`): para exportar PDF o DXF explotado. */
export const flattenDrawing = (d: Drawing, opts: { visibleOnly?: boolean } = {}): Drawing => {
  if (!d.blocks?.length && !d.entities.some((e) => e.type === 'insert')) return d;
  const { blocks: _b, ...rest } = d;
  return { ...rest, entities: flattenEntities(d, opts) };
};

// ---------------------------------------------------------------- uso y grafo

/** Nombres de bloque que referencia directamente un conjunto de entidades. */
const refsOf = (list: Entity[]): string[] => list.filter((e): e is InsertEntity => e.type === 'insert').map((e) => e.block);

/** Cantidad de inserts que usan el bloque (en el dibujo y dentro de otros bloques). */
export function blockUsage(d: Pick<Drawing, 'entities' | 'blocks'>, name: string): { inDrawing: number; inBlocks: number } {
  const n = (list: Entity[]) => refsOf(list).filter((b) => sameName(b, name)).length;
  return { inDrawing: n(d.entities), inBlocks: (d.blocks ?? []).filter((b) => !sameName(b.name, name)).reduce((s, b) => s + n(b.entities), 0) };
}

/** Profundidad máxima de anidamiento si empezamos en `names`; Infinity si hay un ciclo. */
function depthOf(d: Pick<Drawing, 'blocks'>, names: string[]): number {
  const memo = new Map<string, number>(), stack = new Set<string>();
  const visit = (name: string): number => {
    const key = name.toLowerCase();
    if (stack.has(key)) return Infinity;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const b = findBlock(d, name);
    if (!b) return 1;
    stack.add(key);
    let best = 1;
    for (const r of refsOf(b.entities)) best = Math.max(best, 1 + visit(r));
    stack.delete(key);
    memo.set(key, best);
    return best;
  };
  return names.reduce((m, n) => Math.max(m, visit(n)), 0);
}

/** Valida nombre de bloque. Devuelve el mensaje o null. */
export function checkBlockName(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return 'El bloque necesita un nombre (texto no vacío).';
  if (name !== name.trim()) return `El nombre del bloque "${name}" no puede empezar ni terminar con espacios.`;
  if (BAD_NAME.test(name)) return `El nombre del bloque "${name}" tiene caracteres no válidos (< > / \\ " : ; ? * | = \`).`;
  if (name.length > 120) return 'El nombre del bloque es demasiado largo (máximo 120 caracteres).';
  return null;
}

/** Valida las definiciones de bloques de un dibujo y que los inserts (del dibujo y de los bloques) referencien bloques existentes, sin ciclos ni más de 8 niveles. */
export function validateBlocks(d: Drawing): string | null {
  const who = `Dibujo "${d.name ?? d.id}"`;
  if (d.blocks !== undefined && !Array.isArray(d.blocks)) return `${who}: blocks debe ser una lista de bloques.`;
  const names = new Set<string>();
  for (const b of d.blocks ?? []) {
    if (!b || typeof b !== 'object') return `${who}: cada bloque debe ser un objeto { name, base, entities }.`;
    const m = checkBlockName(b.name);
    if (m) return `${who}: ${m}`;
    if (names.has(b.name.toLowerCase())) return `${who}: el bloque "${b.name}" está repetido (los nombres no distinguen mayúsculas).`;
    names.add(b.name.toLowerCase());
    if (!Array.isArray(b.base) || b.base.length !== 2 || !b.base.every((v) => typeof v === 'number' && Number.isFinite(v))) return `${who}: el bloque "${b.name}" necesita base [x, y] con números finitos.`;
    if (!Array.isArray(b.entities)) return `${who}: el bloque "${b.name}" necesita entities (lista).`;
    if (b.description !== undefined && typeof b.description !== 'string') return `${who}: la descripción del bloque "${b.name}" debe ser texto.`;
    const ids = new Set<string>();
    for (const e of b.entities) {
      const em = validateEntity(e, d);
      if (em) return `${who}, bloque "${b.name}": ${em}`;
      if (ids.has(e.id)) return `${who}, bloque "${b.name}": el id "${e.id}" está repetido dentro del bloque.`;
      ids.add(e.id);
    }
  }
  for (const b of d.blocks ?? []) if (depthOf(d, [b.name]) === Infinity) return `${who}: el bloque "${b.name}" se contiene a sí mismo (ciclo de bloques); un bloque no puede insertarse dentro de sí mismo ni de sus descendientes.`;
  const top = depthOf(d, refsOf(d.entities));
  if (top > MAX_BLOCK_DEPTH) return `${who}: los bloques están anidados a más de ${MAX_BLOCK_DEPTH} niveles.`;
  return null;
}

/** ¿Insertar `inner` dentro del bloque `outer` crearía un ciclo? (outer == inner, o inner contiene a outer). */
export function wouldCycle(d: Pick<Drawing, 'blocks'>, outer: string, inner: string): boolean {
  if (sameName(outer, inner)) return true;
  const seen = new Set<string>();
  const reaches = (from: string): boolean => {
    if (sameName(from, outer)) return true;
    if (seen.has(from.toLowerCase())) return false;
    seen.add(from.toLowerCase());
    const b = findBlock(d, from);
    return !!b && refsOf(b.entities).some(reaches);
  };
  return reaches(inner);
}
export { depthOf as blockDepth };
