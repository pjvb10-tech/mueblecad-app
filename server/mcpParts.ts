import { z } from 'zod';
import type { Kit } from './mcpKit';
import type { Store } from './store';
import { groupOf, nextId } from '../src/core/furniture';
import { validateEdgeRound } from '../src/core/validate';
import { defaultHardware, type Axis, type Part, type Project, type SolidForm, type Vec3 } from '../src/core/types';
import { meshSummary } from '../src/core/mesh';
import { describeSolid, formOf, FORM_FIELDS, FORMS, isRotated, isSolid, localAxes, normalizePart, partBounds, partVolume, resolveAxis, solidsList, validatePart } from '../src/core/solids';

// ---------------------------------------------------------------- esquemas

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const edges = z.object({ largo: z.union([z.literal(0), z.literal(1), z.literal(2)]), ancho: z.union([z.literal(0), z.literal(1), z.literal(2)]) });
const shape = z.object({
  radius: z.number().min(0).optional().describe('Radio de esquinas redondeadas (mm)'),
  notch: z.object({ w: z.number(), h: z.number(), corner: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).optional()
    .describe('Muesca rectangular para cortes en L. Medidas en el plano de la pieza: w a lo largo, h a lo ancho. Esquinas: 0=origen, 1=fin del largo, 2=opuesta, 3=fin del ancho'),
  holes: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })).optional().describe('Huecos rectangulares interiores'),
  edgeRound: z.object({ edge: z.union([z.literal(0), z.literal(2)]), radius: z.number().positive() }).optional().describe('Canto redondeado (media caña): edge 0 = v mínimo, 2 = v máximo; radius ≤ mitad del espesor. Mejor usar set_edge_round.'),
});
const rebates = z.array(z.object({ edge: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), width: z.number(), depth: z.number() })).describe('Rebajes en cantos de la pieza: edge 0 = v mínimo, 1 = u máximo, 2 = v máximo, 3 = u mínimo (u = lado largo, v = lado ancho)');

const pt = z.tuple([z.number().finite(), z.number().finite()]);

/** Descripciones de los campos de forma y giro (se reutilizan en add_part, update_part y batch_parts). */
const SOLID = {
  rotX: z.number().finite().describe('Giro en grados (decimales libres) alrededor del eje X, por el CENTRO de la caja size/position. Orden de giro: primero X, luego Y, luego Z, sobre ejes fijos del mundo (R = Rz·Ry·Rx); sentido positivo = regla de la mano derecha (X derecha, Y arriba, Z al frente). 0 o ausente = sin giro.'),
  rotY: z.number().finite().describe('Giro en grados alrededor del eje Y (vertical) por el centro de la caja. Ver rotX.'),
  rotZ: z.number().finite().describe('Giro en grados alrededor del eje Z (profundidad) por el centro de la caja. Ver rotX.'),
  form: z.enum(FORMS as [string, ...string[]]).describe("Forma sólida. 'box' (por omisión) caja; 'cylinder' cilindro (o tubo redondo con wall); 'tube' tubo rectangular hueco (wall obligatorio); 'prism' extrusión de un polígono profile a lo largo de axis (cuñas, pilares con cara inclinada, ángulos L, perfiles U/T); 'revolve' perfil [r,h] girado alrededor de axis (ruedas con ranura en V, rodillos, pernos, piñones simples). size/position son SIEMPRE la caja envolvente nominal sin girar; las formas sólidas no entran al despiece de planchas (ver get_solids)."),
  axis: z.enum(['x', 'y', 'z']).describe("Eje del largo (cylinder, tube, prism) o eje de giro (revolve). Por omisión: cylinder/tube = la dimensión de size que se diferencia de las otras dos (o la más larga); prism = 'z' (perfil en el plano XY); revolve = 'y'. Las coordenadas del perfil son (a,b) = (X,Y) con axis=z, (Y,Z) con axis=x, (Z,X) con axis=y."),
  wall: z.number().positive().describe('Espesor de pared en mm. tube: obligatorio, debe ser menor que la mitad del lado menor de la sección (50x50x3 → wall=3). cylinder: opcional, lo vuelve tubo redondo hueco (diámetro = lado de la caja).'),
  cornerRadius: z.number().min(0).describe('Solo tube: radio de la esquina EXTERIOR en mm (la interior queda en radio-wall). 0 = esquina viva (por omisión). Típico de perfil de fierro: 2×wall.'),
  profile: z.array(pt).min(3).max(500).describe("Polígono 2D en mm [[x,y],...], mínimo 3 vértices, sin cruzarse (se rechaza una autointersección). prism: sección de la extrusión; su origen (0,0) es la esquina mínima de la caja y debe caber en ella (cuña de 400 a 270 en 1800: [[0,0],[400,0],[270,1800],[0,1800]] con axis='z'). revolve: puntos [r,h] = [distancia al eje ≥ 0, posición a lo largo del eje 0..largo]; el polígono cerrado se gira 360° (rueda de Ø120 con ranura en V: [[0,0],[60,0],[60,8],[52,10],[60,12],[60,20],[0,20]])."),
  segments: z.number().int().min(8).max(256).describe('Lados con que se aproximan las curvas (por omisión 48). Más lados = más suave y más pesado.'),
};

const solidOpt = Object.fromEntries(Object.entries(SOLID).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof SOLID]: z.ZodOptional<(typeof SOLID)[K]> };
const solidNullable = Object.fromEntries(Object.entries(SOLID).map(([k, v]) => [k, v.nullable().optional()])) as { [K in keyof typeof SOLID]: z.ZodOptional<z.ZodNullable<(typeof SOLID)[K]>> };

const SOLID_KEYS = Object.keys(SOLID) as (keyof typeof SOLID)[];
const FORM_PARAMS = ['axis', 'wall', 'cornerRadius', 'profile', 'segments'] as const;

const addFields = {
  name: z.string().min(1).describe('Nombre de la pieza; si no pones group, el grupo (mueble) se deduce de él'),
  size: vec3.optional().describe('[x,y,z] mm: caja envolvente sin girar. Obligatorio salvo en prism (se deduce del perfil y `length`) y revolve (se deduce del perfil).'),
  position: vec3.describe('[x,y,z] mm de la esquina mínima de la caja sin girar. El giro se aplica alrededor de su centro.'),
  material: z.string().describe('Id de material (get_project). Un material con purchased=true marca la pieza como comprada.'),
  group: z.string().optional().describe('Mueble o conjunto al que pertenece'),
  edges: edges.optional(),
  shape: shape.optional().describe('Recortes 2D de piezas planas (esquinas, muescas, huecos). Solo con cajas; no confundir con `form`.'),
  rebates: rebates.optional(),
  layer: z.string().optional().describe('Capa propia'),
  ...solidOpt,
  length: z.number().positive().optional().describe('Solo prism sin size: largo de la extrusión (mm) a lo largo de axis.'),
};

const patchFields = {
  name: z.string().min(1).optional(),
  size: vec3.optional(),
  position: vec3.optional(),
  material: z.string().optional(),
  group: z.string().nullable().optional().describe('null quita el grupo explícito'),
  edges: edges.optional(),
  shape: shape.optional().describe('REEMPLAZA la forma plana completa (no es `form`)'),
  rebates: rebates.optional(),
  layer: z.string().nullable().optional().describe('null vuelve a la capa automática'),
  ...solidNullable,
};

type Patch = { [K in keyof typeof patchFields]?: z.infer<(typeof patchFields)[K]> };
type AddIn = { [K in keyof typeof addFields]?: z.infer<(typeof addFields)[K]> } & { name: string; position: Vec3; material: string };

// ---------------------------------------------------------------- lógica (sin MCP, probable por separado)

const checkMaterial = (project: Project, id: string | undefined) => {
  if (id !== undefined && !project.materials.some((m) => m.id === id)) throw new Error(`Material desconocido: ${id}. Materiales: ${project.materials.map((m) => m.id).join(', ')}.`);
};

/** Caja envolvente deducida del perfil (prism: perfil + length; revolve: perfil). Lanza si faltan datos. */
function deriveSize(a: AddIn): Vec3 {
  const form = a.form ?? 'box';
  if (form !== 'prism' && form !== 'revolve') throw new Error(`"${a.name}": falta size [x,y,z] (solo prism y revolve pueden omitirlo).`);
  if (!a.profile?.length) throw new Error(`"${a.name}": falta profile (y size, que se deduce de él).`);
  const axis = resolveAxis({ form, axis: a.axis as Axis | undefined, size: [1, 1, 1] });
  const [ia, ib, ic] = localAxes(axis);
  const xs = a.profile.map((p) => p[0]), ys = a.profile.map((p) => p[1]);
  const size: Vec3 = [0, 0, 0];
  if (form === 'prism') {
    if (a.length === undefined) throw new Error(`"${a.name}": un prism sin size necesita length (largo de la extrusión en mm).`);
    size[ia] = Math.max(...xs); size[ib] = Math.max(...ys); size[ic] = a.length;
  } else {
    size[ia] = size[ib] = 2 * Math.max(...xs); size[ic] = Math.max(...ys);
  }
  return size;
}

/** Crea una pieza nueva validada (lanza con un mensaje claro si algo es absurdo). No la agrega al proyecto. */
export function createPart(project: Project, a: AddIn): Part {
  checkMaterial(project, a.material);
  const size = (a.size ?? deriveSize(a)) as Vec3;
  const part: Part = { id: nextId(project), name: a.name, size, position: a.position, material: a.material };
  for (const k of ['group', 'edges', 'shape', 'rebates', 'layer', ...SOLID_KEYS] as const) {
    if (a[k] !== undefined) (part as unknown as Record<string, unknown>)[k] = a[k];
  }
  if (part.shape?.edgeRound) { const err = validateEdgeRound(part, part.shape.edgeRound.edge, part.shape.edgeRound.radius); if (err) throw new Error(err); }
  const err = validatePart(part);
  if (err) throw new Error(err);
  return normalizePart(part);
}

const TOUCH_SOLID: (keyof Patch)[] = ['size', 'shape', 'rebates', ...SOLID_KEYS];

/** Aplica un cambio parcial a una pieza existente (null quita un campo). Valida el resultado antes de tocar nada. */
export function patchPart(project: Project, part: Part, patch: Patch): void {
  checkMaterial(project, patch.material);
  for (const k of ['name', 'size', 'position', 'material'] as const) if (patch[k] === null) throw new Error(`"${part.name}": ${k} no se puede quitar.`);
  const next = structuredClone(part) as Part;
  // al cambiar de forma se sueltan los parámetros de la forma anterior que el cambio no menciona
  if ((patch.form === null && formOf(part) !== 'box') || (patch.form != null && patch.form !== formOf(part))) {
    const newForm = patch.form ?? 'box';
    for (const k of FORM_PARAMS) if (patch[k] === undefined && !FORM_FIELDS[newForm as SolidForm].includes(k)) delete next[k];
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete (next as unknown as Record<string, unknown>)[k];
    else (next as unknown as Record<string, unknown>)[k] = v;
  }
  if (next.shape?.edgeRound) { const err = validateEdgeRound(next, next.shape.edgeRound.edge, next.shape.edgeRound.radius); if (err) throw new Error(err); }
  if (TOUCH_SOLID.some((k) => patch[k] !== undefined)) { const err = validatePart(next); if (err) throw new Error(err); }
  normalizePart(next);
  for (const k of Object.keys(part)) delete (part as unknown as Record<string, unknown>)[k];
  Object.assign(part, next);
}

export interface BatchInput { remove?: string[]; update?: (Patch & { id: string })[]; add?: AddIn[] }
export interface BatchResult { removed: string[]; updated: string[]; added: { id: string; name: string }[]; total: number }

/**
 * Aplica un lote: primero borra, luego actualiza y por último agrega. Todo o nada: si algo falla se lanza UN error con la lista de
 * problemas (índice + mensaje) y el proyecto no se modifica (quien llama no guarda).
 */
export function applyBatch(project: Project, b: BatchInput): BatchResult {
  const errors: string[] = [];
  const attempt = (label: string, fn: () => void) => { try { fn(); } catch (e) { errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); } };
  const res: BatchResult = { removed: [], updated: [], added: [], total: 0 };
  (b.remove ?? []).forEach((id, i) => attempt(`remove[${i}]`, () => {
    if (!project.parts.some((p) => p.id === id)) throw new Error(`No existe la pieza ${id}`);
    project.parts = project.parts.filter((p) => p.id !== id);
    res.removed.push(id);
  }));
  (b.update ?? []).forEach(({ id, ...patch }, i) => attempt(`update[${i}] ${id}`, () => {
    const part = project.parts.find((p) => p.id === id);
    if (!part) throw new Error(`No existe la pieza ${id}`);
    patchPart(project, part, patch);
    res.updated.push(id);
  }));
  (b.add ?? []).forEach((a, i) => attempt(`add[${i}] ${a.name}`, () => {
    const part = createPart(project, a);
    project.parts.push(part);
    res.added.push({ id: part.id, name: part.name });
  }));
  if (errors.length) throw new Error(`El lote no se aplicó (no se cambió nada). ${errors.length} problema(s):\n${errors.join('\n')}`);
  res.total = project.parts.length;
  return res;
}

/** Fila resumida de una pieza para list_parts. */
export function partRow(p: Part) {
  const row: Record<string, unknown> = { id: p.id, name: p.name, group: groupOf(p), material: p.material, form: formOf(p), size: p.size, position: p.position };
  if (isRotated(p)) row.rot = [p.rotX ?? 0, p.rotY ?? 0, p.rotZ ?? 0];
  if (isSolid(p)) { row.descripcion = describeSolid(p); row.axis = ['x', 'y', 'z'][resolveAxis(p)]; row.volumeCm3 = Math.round(partVolume(p) / 10) / 100; }
  if (isSolid(p) || isRotated(p)) { const b = partBounds(p); row.boundsMin = b.min; row.boundsMax = b.max; }
  for (const k of ['wall', 'cornerRadius', 'segments'] as const) if (p[k] !== undefined) row[k] = p[k];
  if (p.profile) row.profile = p.profile;
  if (p.mesh) row.mesh = meshSummary(p.mesh); // resumen: nunca los vértices
  return row;
}

// ---------------------------------------------------------------- herramientas

export function registerPartTools(kit: Kit, store: Store) {
  const edit = <T>(fn: (project: Project) => T): T => store.updateProject((project) => { project.hardware ??= defaultHardware(); return fn(project); });
  const view = () => { const { project } = store.readProject(); project.hardware ??= defaultHardware(); return project; };

  const SOLID_HELP = ' FORMAS Y GIROS: form = box (omisión) | cylinder | tube | prism | revolve; rotX/rotY/rotZ en grados alrededor del centro de la caja (orden X, Y, Z, ejes fijos). size/position siempre son la caja envolvente SIN girar. Ejemplos: '
    + "(1) tubo 50x50x3 de 1000 mm de largo: {form:'tube', size:[50,1000,50], axis:'y', wall:3}; "
    + "(2) pilar de hormigón con cara inclinada (400 abajo, 270 arriba, 1800 alto, 400 de fondo): {form:'prism', axis:'z', size:[400,1800,400], profile:[[0,0],[400,0],[270,1800],[0,1800]]}; "
    + "(3) rueda Ø120 x 20 con ranura en V: {form:'revolve', axis:'y', size:[120,20,120], profile:[[0,0],[60,0],[60,8],[52,10],[60,12],[60,20],[0,20]]}; "
    + "(4) ángulo L 40x40x3 de 1000 mm: {form:'prism', axis:'z', size:[40,40,1000], profile:[[0,0],[40,0],[40,3],[3,3],[3,40],[0,40]]}; "
    + "(5) pasador Ø12 x 80 tendido a lo largo de X: {form:'cylinder', axis:'x', size:[80,12,12]}; (6) diagonal: cualquier pieza con rotZ:35.";

  kit.write('add_part', `Agrega UNA pieza al diseño. Por omisión es una caja (size=[x,y,z], position=[x,y,z] esquina mínima, mm) pero admite giro y formas sólidas reales: cilindro, tubo rectangular hueco, prisma (polígono extruido) y revolución (perfil girado).${SOLID_HELP} Con prism/revolve puedes omitir size (se deduce del perfil; prism necesita length). Se rechazan parámetros absurdos con un mensaje claro (pared mayor que la mitad del lado, polígono con <3 vértices o que se cruza...). Para crear muchas piezas de una vez usa batch_parts. EN: add one part (box, cylinder, tube, prism, revolve; any rotation).`,
    addFields,
    (a) => edit((project) => {
      const part = createPart(project, a as unknown as AddIn);
      project.parts.push(part);
      return part;
    }));

  kit.write('update_part', `Modifica campos de una pieza existente por id: nombre, medidas, posición, material, tapacanto (edges), forma plana (shape; REEMPLAZA la completa), rebajes, capa, y los campos de giro y forma sólida (rotX/rotY/rotZ, form, axis, wall, cornerRadius, profile, segments). Un campo con null se quita (p. ej. rotZ:null deshace el giro, form:'box' o form:null vuelve a caja). Al cambiar de form se sueltan los parámetros de la forma anterior que no menciones. El resultado se valida antes de guardar.${SOLID_HELP} EN: edit a part by id (null removes a field).`,
    { id: z.string(), ...patchFields },
    ({ id, ...patch }) => edit((project) => {
      const part = project.parts.find((p) => p.id === id);
      if (!part) throw new Error(`No existe la pieza ${id}`);
      patchPart(project, part, patch as unknown as Patch);
      return part;
    }));

  kit.write('batch_parts', `Crea, modifica y borra MUCHAS piezas en una sola llamada, con UN solo respaldo y todo-o-nada: se valida todo y, si hay algún error, no se cambia nada y el mensaje lista cada problema (add[3], update[0]...). Orden de aplicación: remove, update, add. add[] lleva los mismos campos que add_part (incluye giro y formas sólidas); update[] lleva {id, ...campos de update_part} (null quita un campo); remove[] lleva ids. Devuelve los ids creados. dryRun=true solo valida y no guarda. Ejemplo: {add:[{name:'Poste 1', group:'Portón', material:'acero', form:'tube', size:[50,2000,50], axis:'y', wall:3, position:[0,0,0]}, {name:'Diagonal 1', group:'Portón', material:'acero', form:'tube', size:[50,1500,50], axis:'y', wall:3, position:[100,100,0], rotZ:35}], update:[{id:'p12', position:[500,0,0], rotY:15}], remove:['p3','p4']}. Máximo 2000 operaciones.${SOLID_HELP} EN: batch add/update/remove parts atomically with a single backup.`,
    {
      add: z.array(z.object(addFields).strict()).max(2000).optional().describe('Piezas nuevas (campos de add_part)'),
      update: z.array(z.object({ id: z.string(), ...patchFields }).strict()).max(2000).optional().describe('Cambios por id (campos de update_part; null quita)'),
      remove: z.array(z.string()).max(2000).optional().describe('Ids de piezas a borrar'),
      dryRun: z.boolean().optional().describe('Solo validar, sin guardar nada'),
    },
    ({ add, update, remove, dryRun }) => {
      if (((add?.length ?? 0) + (update?.length ?? 0) + (remove?.length ?? 0)) > 2000) throw new Error('Máximo 2000 operaciones por lote.');
      if (dryRun) {
        const r = applyBatch(structuredClone(view()), { add: add as unknown as AddIn[], update: update as unknown as BatchInput['update'], remove });
        return { dryRun: true, ...r, nota: 'Validado: no se guardó nada.' };
      }
      return edit((project) => applyBatch(project, { add: add as unknown as AddIn[], update: update as unknown as BatchInput['update'], remove }));
    });

  kit.read('list_parts', 'Lista las piezas de forma compacta (get_project trae todo y pesa mucho): id, nombre, grupo, material, form, size, position, giro (rot), caja envolvente en el mundo (boundsMin/boundsMax, ya con el giro), volumen real en cm³ y descripción de las formas sólidas. Filtros: group, form, material, name (texto contenido, sin distinguir mayúsculas), ids. Paginado con offset/limit (200 por omisión, máx. 1000). EN: compact part list with filters.',
    {
      group: z.string().optional(), form: z.enum(FORMS as [string, ...string[]]).optional(), material: z.string().optional(),
      name: z.string().optional().describe('Texto que debe contener el nombre'), ids: z.array(z.string()).optional(),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional(),
    },
    ({ group, form, material, name, ids, offset, limit }) => {
      const all = view().parts.filter((p) => (!group || groupOf(p) === group) && (!form || formOf(p) === form) && (!material || p.material === material)
        && (!name || p.name.toLowerCase().includes(name.toLowerCase())) && (!ids || ids.includes(p.id)));
      const from = offset ?? 0, n = limit ?? 200;
      return { total: all.length, offset: from, parts: all.slice(from, from + n).map(partRow) };
    });

  kit.read('get_solids', 'Lista de perfiles y sólidos (tubos, cilindros, prismas, revoluciones) agrupados por material y forma: descripción (p. ej. «tubo 50×50×3, largo 1000»), caja envolvente, cantidad y volumen real. Estas piezas NO entran en get_cutlist, optimize_cuts ni el G-code (no se cortan de planchas): se compran o se fabrican aparte. EN: purchase list for non-box solids.', {}, () => {
    const p = view();
    const rows = solidsList(p.parts).map((r) => ({ ...r, materialNombre: p.materials.find((m) => m.id === r.material)?.name ?? r.material }));
    return { filas: rows, piezas: rows.reduce((s, r) => s + r.qty, 0), volumenTotalCm3: Math.round(rows.reduce((s, r) => s + r.totalCm3, 0) * 100) / 100 };
  });
}
