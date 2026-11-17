import { drawingToWorld } from '../core/drawingPlane';
import { blockCtx, findBlock } from '../core/blocks';
import { blockDrawing } from '../core/blockOps';
import { entityBounds } from '../core/geom2d';
import type { Drawing, Entity, Project, Vec3 } from '../core/types';

/** Qué cambió en los dibujos entre dos versiones del proyecto (p. ej. cuando el agente MCP edita): para resaltar y para el aviso. */
export interface DrawingChange {
  drawingId: string;
  drawingName: string;
  /** El dibujo es nuevo o se borró completo (sus entidades no se detallan). */
  drawing?: 'new' | 'del';
  added: Entity[];
  changed: Entity[];
  removed: Entity[];
  /** Se movió o cambió de plano (el resto del dibujo no cambia). */
  moved?: boolean;
  /** Bloques cuya definición cambió (o se creó): sus inserts salen en `changed`, aunque la entidad insert no se haya tocado. */
  blocks?: string[];
}

/** Nombres (en minúsculas) de los bloques de `cur` cuya definición es nueva o difiere de `old`, o que usan (a cualquier profundidad) uno que cambió. */
function changedBlocks(old: Drawing, cur: Drawing): Set<string> {
  const out = new Set<string>();
  if (!cur.blocks?.length) return out;
  const prev = new Map((old.blocks ?? []).map((b) => [b.name.toLowerCase(), b]));
  for (const b of cur.blocks) { const p = prev.get(b.name.toLowerCase()); if (!p || (p !== b && JSON.stringify(p) !== JSON.stringify(b))) out.add(b.name.toLowerCase()); }
  for (let grew = out.size > 0; grew;) {
    grew = false;
    for (const b of cur.blocks) {
      const k = b.name.toLowerCase();
      if (!out.has(k) && b.entities.some((e) => e.type === 'insert' && out.has(e.block.toLowerCase()))) { out.add(k); grew = true; }
    }
  }
  return out;
}

export function diffDrawings(old: Project | { drawings?: Drawing[] }, cur: Project | { drawings?: Drawing[] }): DrawingChange[] {
  const a = new Map((old.drawings ?? []).map((d) => [d.id, d]));
  const b = new Map((cur.drawings ?? []).map((d) => [d.id, d]));
  const out: DrawingChange[] = [];
  for (const [id, d] of b) {
    const o = a.get(id);
    if (!o) { out.push({ drawingId: id, drawingName: d.name, drawing: 'new', added: [], changed: [], removed: [] }); continue; }
    const before = new Map(o.entities.map((e) => [e.id, e]));
    const now = new Map(d.entities.map((e) => [e.id, e]));
    const ch: DrawingChange = { drawingId: id, drawingName: d.name, added: [], changed: [], removed: [] };
    for (const [eid, e] of now) {
      const p = before.get(eid);
      if (!p) ch.added.push(e); else if (p !== e && JSON.stringify(p) !== JSON.stringify(e)) ch.changed.push(e);
    }
    for (const [eid, e] of before) if (!now.has(eid)) ch.removed.push(e);
    // definiciones de bloque que cambiaron (o contienen un bloque que cambió): se marcan sus inserts
    const blocksChanged = changedBlocks(o, d);
    if (blocksChanged.size) {
      ch.blocks = [...blocksChanged];
      const seen = new Set([...ch.added, ...ch.changed].map((e) => e.id));
      for (const e of d.entities) if (e.type === 'insert' && blocksChanged.has(e.block.toLowerCase()) && !seen.has(e.id)) ch.changed.push(e);
    }
    if (o.plane !== d.plane || o.origin.some((v, i) => v !== d.origin[i])) ch.moved = true;
    if (ch.added.length || ch.changed.length || ch.removed.length || ch.moved || ch.blocks?.length) out.push(ch);
  }
  for (const [id, d] of a) if (!b.has(id)) out.push({ drawingId: id, drawingName: d.name, drawing: 'del', added: [], changed: [], removed: [] });
  return out;
}

/** Caja 3D del mundo (mm) de una entidad de un dibujo, para resaltarla en el visor 3D. */
export function entityWorldBox(d: Pick<Drawing, 'plane' | 'origin' | 'blocks'>, e: Entity): { min: Vec3; max: Vec3 } | null {
  const b = entityBounds(e, blockCtx(d));
  if (!b) return null;
  const corners = [[b.min[0], b.min[1]], [b.max[0], b.min[1]], [b.min[0], b.max[1]], [b.max[0], b.max[1]]].map((p) => drawingToWorld(d, [p[0], p[1]]));
  const min: Vec3 = [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i]))) as Vec3;
  const max: Vec3 = [0, 1, 2].map((i) => Math.max(...corners.map((c) => c[i]))) as Vec3;
  return { min, max };
}

/** Texto corto del cambio para el indicador del agente ("+3 entidades · 1 modificada"). Vacío si no hay nada. */
export function changeText(changes: DrawingChange[]): string {
  let nuevos = 0, mod = 0, del = 0, dnew = 0, ddel = 0, blk = 0;
  for (const c of changes) {
    nuevos += c.added.length; mod += c.changed.length + (c.moved ? 1 : 0); del += c.removed.length;
    blk += c.blocks?.length ?? 0;
    if (c.drawing === 'new') dnew++;
    if (c.drawing === 'del') ddel++;
  }
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    dnew && `+${plural(dnew, 'dibujo', 'dibujos')}`,
    nuevos && `+${plural(nuevos, 'entidad', 'entidades')}`,
    mod && `${plural(mod, 'modificada', 'modificadas')}`,
    del && `${plural(del, 'borrada', 'borradas')}`,
    blk && `${plural(blk, 'bloque editado', 'bloques editados')}`,
    ddel && `${plural(ddel, 'dibujo borrado', 'dibujos borrados')}`,
  ].filter(Boolean).join(' · ');
}

/**
 * Cambios de las entidades DENTRO del bloque `name` entre dos versiones del dibujo `drawingId`, con el bloque como dibujo (coordenadas locales),
 * para resaltar en el lienzo de «Editar bloque» la entidad correcta y no el insert. Devuelve el bloque nuevo como dibujo y el cambio (o null si no hay).
 */
export function blockEntityChanges(old: { drawings?: Drawing[] }, cur: { drawings?: Drawing[] }, drawingId: string, name: string): { drawing: Drawing; change: DrawingChange | null } | null {
  const dNew = (cur.drawings ?? []).find((x) => x.id === drawingId);
  if (!dNew || !findBlock(dNew, name)) return null;
  const bNew = blockDrawing(dNew, name);
  const dOld = (old.drawings ?? []).find((x) => x.id === drawingId);
  if (!dOld || !findBlock(dOld, name)) return { drawing: bNew, change: null };
  const change = diffDrawings({ drawings: [blockDrawing(dOld, name)] }, { drawings: [bNew] })[0] ?? null;
  return { drawing: bNew, change };
}
