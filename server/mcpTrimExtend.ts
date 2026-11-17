import { z } from 'zod';
import type { Kit } from './mcpKit';
import type { Store } from './store';
import { addDrawingCommands, pickDrawing } from './mcpDrawing';
import { DrawingError, validateDrawings, withDrawing } from '../src/core/drawing';
import { syncHatches } from '../src/core/hatch';
import { applyOps } from '../src/core/drawingTools';
import { extendEntity, trimEntity } from '../src/core/trimExtend';
import { defaultHardware, type Project } from '../src/core/types';

/**
 * Herramientas MCP RECORTAR y EXTENDER del dibujo 2D: `trim_entity` y `extend_entity`. Núcleo puro: src/core/trimExtend.ts.
 * Escriben con el mismo patrón que server/mcpDrawing.ts: respaldo y reintento por rev (store.updateProject), validación antes de
 * guardar, dryRun y registro de actividad (lo pone el kit).
 */

const num = z.number().finite();
const shape = {
  drawing: z.string().optional().describe('Id (d1) o nombre del dibujo. Se puede omitir si el proyecto tiene un solo dibujo'),
  entity: z.string().describe('Id de la entidad a modificar: línea, arco, círculo o polilínea (con arcos también)'),
  point: z.tuple([num, num]).describe('[x, y] en mm: el punto donde harías clic. Recortar: quita el tramo que contiene ese punto; extender: alarga el extremo más cercano a él'),
  boundaries: z.array(z.string()).min(1).max(5000).optional().describe('Ids de los bordes (línea, polilínea, círculo, arco). Omítelo (o usa all=true) para tomar todos los objetos visibles'),
  all: z.boolean().optional().describe('true = todos los objetos visibles (de capas activas y no congeladas) son bordes; es lo que se hace si omites boundaries'),
  edgeMode: z.enum(['normal', 'extendido']).optional().describe('extendido = los bordes se prolongan virtualmente (rectas infinitas, arcos como círculo completo)'),
  dryRun: z.boolean().optional().describe('Solo valida y dice qué pasaría: no guarda nada'),
};
type Args = { drawing?: string; entity: string; point: [number, number]; boundaries?: string[]; all?: boolean; edgeMode?: 'normal' | 'extendido'; dryRun?: boolean };

function apply(project: Project, kind: 'trim' | 'extend', a: Args): Record<string, unknown> {
  if (a.boundaries && a.all) throw new Error('Usa boundaries (lista de ids) o all=true, no los dos a la vez.');
  const d = pickDrawing(project, a.drawing);
  try {
    const fn = kind === 'trim' ? trimEntity : extendEntity;
    const ops = fn(d, a.entity, a.point, a.boundaries ?? 'todos', { edgeMode: a.edgeMode });
    const r = applyOps(d, ops);
    project.drawings = withDrawing(project, syncHatches(d, r.drawing)).drawings; // los sombreados asociativos siguen al contorno recortado
    const removed = ops.flatMap((o) => (o.op === 'remove' ? o.ids : []));
    const replaced = removed.filter((id) => r.drawing.entities.some((e) => e.id === id)); // círculo -> arco con el mismo id
    return {
      drawing: d.id, action: kind === 'trim' ? 'recortar' : 'extender', entity: a.entity,
      kept: a.entity, convertedTo: replaced.includes(a.entity) ? r.drawing.entities.find((e) => e.id === a.entity)?.type : undefined,
      added: r.ids.filter((id) => id !== a.entity), total: r.drawing.entities.length,
      result: [a.entity, ...r.ids.filter((id) => id !== a.entity)].map((id) => r.drawing.entities.find((e) => e.id === id)),
    };
  } catch (e) {
    if (e instanceof DrawingError) throw new Error(e.message);
    throw e;
  }
}

/** Ejecuta trim_entity / extend_entity sobre el almacén (guarda con respaldo y reintento salvo dryRun). Usado por el registro MCP y por las pruebas. */
export function runTrimExtend(store: Store, kind: 'trim' | 'extend', args: Args): unknown {
  const fresh = () => { const { project } = store.readProject(); project.hardware ??= defaultHardware(); return project; };
  const checked = (p: Project) => { const m = validateDrawings(p); if (m) throw new Error(m); };
  const pr = z.object(shape).strict().safeParse(args);
  if (!pr.success) throw new Error(`${kind === 'trim' ? 'trim_entity' : 'extend_entity'}: parámetros no válidos. ${pr.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`).join('; ')}`);
  const a = pr.data as Args;
  if (a.dryRun) {
    const p = structuredClone(fresh());
    const r = apply(p, kind, a);
    checked(p);
    return { dryRun: true, nota: 'Validado: no se guardó nada.', resultado: r };
  }
  return store.updateProject((p) => { p.hardware ??= defaultHardware(); const r = apply(p, kind, a); checked(p); return r; });
}

const TRIM_DESC = 'RECORTAR (como en CAD): quita de una línea, arco, círculo o polilínea (también con arcos) el tramo que contiene `point`, entre los cortes vecinos con los bordes (`boundaries` = ids, o todos los objetos visibles si omites boundaries / pones all=true). Si solo hay corte de un lado, quita hasta el extremo; si parte el objeto en dos, el primer trozo conserva el id y el segundo recibe uno nuevo (se devuelve en `added`). Un círculo recortado pasa a ser un arco con el mismo id; una polilínea cerrada recortada queda abierta. Necesita al menos 2 cortes en figuras cerradas. edgeMode "extendido" prolonga virtualmente los bordes. Los sombreados asociativos cuyo contorno se recorta se recalculan. Los inserts de bloque no se recortan (explótalos). Respeta capas bloqueadas y congeladas (error). Todo en mm. dryRun=true solo valida. EN: trim an entity at its intersections with cutting edges.';
const EXTEND_DESC = 'EXTENDER (como en CAD): alarga el extremo de una línea, arco o polilínea abierta más cercano a `point` hasta el primer borde (`boundaries` = ids, o todos los objetos visibles si omites boundaries / pones all=true): la línea sigue recta, el arco a lo largo de su círculo (sin pasar de una vuelta), la polilínea en su primer o último tramo (recto o arco). Conserva el id. Círculos y polilíneas cerradas no se extienden. edgeMode "extendido" prolonga virtualmente los bordes (si el borde queda corto). Los sombreados asociativos se recalculan. Los inserts de bloque no se extienden ni sirven de borde (explótalos). Respeta capas bloqueadas y congeladas (error). Todo en mm. dryRun=true solo valida. EN: extend an entity to the nearest cutting edge.';
// `shape` sin dryRun: drawing_execute lo añade para los comandos de escritura
const { dryRun: _dry, ...cmdShape } = shape;
addDrawingCommands([
  { name: 'trim_entity', mode: 'write', desc: TRIM_DESC, shape: cmdShape, run: (p, a) => apply(p, 'trim', a as Args) },
  { name: 'extend_entity', mode: 'write', desc: EXTEND_DESC, shape: cmdShape, run: (p, a) => apply(p, 'extend', a as Args) },
]);

export function registerTrimExtendTools(kit: Kit, store: Store): void {
  kit.write('trim_entity', TRIM_DESC,
    shape, (a) => runTrimExtend(store, 'trim', a as Args));
  kit.write('extend_entity', EXTEND_DESC,
    shape, (a) => runTrimExtend(store, 'extend', a as Args));
}
