import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { store, SCREENSHOT_FILE, DATA_DIR } from './store';
import { createLibrary } from './library';
import { fail, toolKit } from './mcpKit';
import { registerFinishTools } from './mcpFinish';
import { meshSlim, registerMeshTools } from './mcpMesh';
import { registerRoomTools } from './mcpRooms';
import { registerPartTools } from './mcpParts';
import { registerDrawingTools } from './mcpDrawing';
import { registerTrimExtendTools } from './mcpTrimExtend';
import { registerDrawingIoTools } from './mcpDrawingIO';
import { registerHatchBlockTools } from './mcpHatchBlocks';
import { registerExportViewTools } from './mcpExportView';
import { registerMcadTools } from './mcpMcad';
import { boundsOf } from '../src/core/solids';
import { cleanMm } from '../src/core/units';
import { addCabinet, groupOf, rebuildCabinet } from '../src/core/furniture';
import { fitToRoom } from '../src/core/layout';
import { dxf, gcode, piecesCsv } from '../src/core/export';
import { cutList, nest } from '../src/core/nesting';
import { applyAutoEdges, edgeMeters } from '../src/core/edges';
import { applyAutoHardware, budget } from '../src/core/budget';
import { planSummary } from '../src/core/rooms';
import { validateCabinetOptions, validateEdgeRound } from '../src/core/validate';
import { defaultHardware, type CabinetSpec, type Project } from '../src/core/types';

const server = new McpServer({ name: 'mueblecad', version: '0.4.0' });
const kit = toolKit(server, (call) => store.logActivity(call)); // cada llamada queda en actividad.json: la app la muestra en vivo
const lib = createLibrary(store);

const groupBox = (project: Project, group: string) => {
  const parts = project.parts.filter((p) => groupOf(p) === group);
  if (!parts.length) return null;
  const { min, max, size } = boundsOf(parts); // caja envolvente con los giros de las piezas
  return { parts, min, max, size };
};
/** Lectura con herrajes por omisión. */
const view = () => {
  const { project } = store.readProject();
  project.hardware ??= defaultHardware();
  return project;
};
/** Edición: lee, aplica, guarda con respaldo y escritura atómica (si `fn` lanza no se escribe nada). */
const edit = <T>(fn: (project: Project) => T): T => store.updateProject((project) => { project.hardware ??= defaultHardware(); return fn(project); });

// ---------------------------------------------------------------- proyecto

kit.read('get_project', 'Devuelve el proyecto (materiales, piezas, espacio, herrajes, acabados, mueble por mueble). Medidas en mm; X ancho, Y alto, Z fondo; el frente mira a +Z. Las piezas pueden llevar giro (rotX/rotY/rotZ) y forma sólida (form, axis, wall, cornerRadius, profile, segments); para solo ver piezas de forma compacta usa list_parts. El plano importado pesa megabytes: por omisión va resumido (usa list_rooms/describe_room); full=true lo incluye completo. EN: project data; plan summarised unless full=true.', { full: z.boolean().optional().describe('Incluir el plano completo (líneas, paneles, techo): muy grande') }, ({ full }) => {
  const whole = view();
  const project = { ...whole, parts: whole.parts.map(meshSlim) }; // las mallas importadas van resumidas (triángulos, bbox), nunca sus vértices
  if (full) return project;
  const { plan, ...rest } = project;
  return { ...rest, plan: planSummary(plan) };
});

kit.read('list_furniture', 'Resumen de los muebles (grupos de piezas): nombre, cantidad de piezas, posición y medidas totales. EN: list furniture groups.', {}, () => {
  const project = view();
  const names = [...new Set(project.parts.map(groupOf))];
  return names.map((n) => {
    const b = groupBox(project, n)!;
    return { name: n, parts: b.parts.length, position: b.min, size: b.size, spec: project.cabinets?.[n] };
  });
});

// ---------------------------------------------------------------- muebles y piezas

registerPartTools(kit, store); // add_part, update_part, batch_parts, list_parts, get_solids

kit.write('set_edge_round', 'Redondea el canto de una pieza plana (media caña / bullnose): edge 0 = canto largo de v mínimo, 2 = de v máximo; radius en mm, máximo la mitad del espesor de la pieza. quitar=true elimina el redondeo. Solo afecta al 3D (el contorno de corte no cambia) y conserva el resto de la forma. EN: round a part edge.',
  { id: z.string(), edge: z.union([z.literal(0), z.literal(2)]).optional(), radius: z.number().positive().optional(), quitar: z.boolean().optional() },
  ({ id, edge, radius, quitar }) => edit((project) => {
    const part = project.parts.find((p) => p.id === id);
    if (!part) throw new Error(`No existe la pieza ${id}`);
    if (quitar) {
      if (part.shape) { delete part.shape.edgeRound; if (!Object.keys(part.shape).length) delete part.shape; }
      return `${id}: redondeo de canto quitado.`;
    }
    if (edge === undefined || radius === undefined) throw new Error('Indica edge (0 o 2) y radius (mm), o quitar=true.');
    const err = validateEdgeRound(part, edge, radius);
    if (err) throw new Error(err);
    part.shape = { ...part.shape, edgeRound: { edge, radius } };
    return `${id}: canto ${edge} redondeado con radio ${radius} mm.`;
  }));

kit.write('remove_part', 'Elimina una pieza por id. EN: delete a part.', { id: z.string() }, ({ id }) => edit((project) => {
  if (!project.parts.some((p) => p.id === id)) throw new Error(`No existe la pieza ${id}`);
  project.parts = project.parts.filter((p) => p.id !== id);
  return `Pieza ${id} eliminada. Quedan ${project.parts.length}.`;
}));

kit.write('remove_furniture', 'Elimina un mueble completo (todas las piezas de un grupo). EN: delete a furniture group.', { group: z.string() }, ({ group }) => edit((project) => {
  const before = project.parts.length;
  project.parts = project.parts.filter((p) => groupOf(p) !== group);
  if (project.cabinets) delete project.cabinets[group];
  return `Se eliminaron ${before - project.parts.length} piezas de "${group}".`;
}));

kit.write('move_furniture', 'Mueve un mueble completo: su esquina mínima pasa a la posición dada (mm). Omite un eje para dejarlo igual. EN: move a furniture group.',
  { group: z.string(), x: z.number().optional(), y: z.number().optional(), z: z.number().optional() },
  ({ group, ...pos }) => edit((project) => {
    const b = groupBox(project, group);
    if (!b) throw new Error(`No existe el mueble "${group}"`);
    const target = [pos.x, pos.y, pos.z];
    const delta = target.map((t, i) => (t === undefined ? 0 : t - b.min[i]));
    for (const p of b.parts) p.position = p.position.map((v, i) => cleanMm(v + delta[i])) as [number, number, number];
    return `"${group}" ahora empieza en ${b.min.map((v, i) => cleanMm(v + delta[i])).join(', ')}`;
  }));

kit.write('add_material', 'Agrega o reemplaza un material de plancha. purchased=true para elementos comprados hechos (no se cortan). EN: add/replace a sheet material.',
  { id: z.string(), name: z.string(), thickness: z.number().positive(), sheetW: z.number().positive().default(2400), sheetH: z.number().positive().default(1200), color: z.string().default('#cccccc'), grain: z.boolean().default(true), price: z.number().optional(), purchased: z.boolean().optional() },
  (m) => edit((project) => {
    project.materials = [...project.materials.filter((x) => x.id !== m.id), m];
    return project.materials;
  }));

kit.write('set_kerf', 'Define el grosor del corte de la sierra en mm. EN: saw kerf.', { kerf: z.number().min(0) }, ({ kerf }) => edit((project) => { project.kerf = kerf; return `Kerf = ${kerf} mm`; }));

const cabinetOptions = {
  kind: z.enum(['box', 'corner']).optional().describe('box = mueble recto; corner = esquinero en L (width = brazo en X, wingB = brazo en Z)'),
  wingB: z.number().positive().optional().describe('Esquinero: largo del segundo brazo (Z)'),
  shelves: z.number().int().min(0).optional().describe('Número de entrepaños con reparto uniforme (los reemplaza shelfAt)'),
  shelfAt: z.array(z.number().min(0)).optional().describe('Alturas (mm desde la base del mueble) de la CARA INFERIOR de cada entrepaño; reemplaza el reparto uniforme de shelves. [] la quita. Solo muebles rectos.'),
  rods: z.array(z.number().min(0)).optional().describe('Barras de colgar (tubo de 25 mm): altura (mm desde la base del mueble) de la parte baja de cada barra. [] las quita. Solo muebles rectos.'),
  rodMaterial: z.string().optional().describe('Material comprado (purchased) de la barra; por omisión el del mueble'),
  faceBack: z.boolean().optional().describe('Frente espejado: el frente mira a -Z (mueble pegado a un muro por su lado +Z) y el fondo queda en +Z. No se combina con rebateBack.'),
  material: z.string().optional(), backMaterial: z.string().optional().describe('Material del fondo delgado'), doorMaterial: z.string().optional().describe('Material de puertas/frentes de cajón'),
  drawers: z.number().int().min(0).optional().describe('Cajones (reemplazan a las puertas)'),
  doors: z.number().int().min(0).optional().describe('Número de puertas; 0 u omitido = automático (una cada ~500 mm)'),
  rebateBack: z.boolean().optional().describe('Fondo embutido en un rebaje de 8 mm en laterales, base y tapa'),
  edging: z.boolean().optional().describe('Tapacanto automático (true por omisión)'),
};
const clean = <T extends object>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

kit.write('add_cabinet',
  'Genera un mueble (laterales, base, tapa, entrepaños) con fondo, puertas o cajones opcionales y tapacanto automático; o un esquinero en L con kind=corner. Opciones: shelfAt (entrepaños a altura fija), rods (barras de colgar para closets), faceBack (frente espejado hacia -Z), rebateBack. Usa x/y/z para ubicarlo (mm); por ejemplo y=100 para dejar zócalo. El nombre debe ser nuevo. Después se puede cambiar con resize_furniture. EN: generate a cabinet (rods = hanging rails, shelfAt = fixed-height shelves, faceBack = mirrored front).',
  {
    name: z.string().min(1).optional(),
    width: z.number().positive(), height: z.number().positive(), depth: z.number().positive(),
    ...cabinetOptions,
    x: z.number().optional(), y: z.number().optional(), z: z.number().optional(),
  },
  (o) => edit((project) => {
    const name = o.name ?? 'Gabinete';
    if (project.parts.some((p) => groupOf(p) === name)) throw new Error(`Ya existe un mueble llamado "${name}". Elige otro nombre, o usa resize_furniture / remove_furniture.`);
    const err = validateCabinetOptions(project, o);
    if (err) throw new Error(err);
    const parts = addCabinet(project, { ...o, name });
    return `Se agregaron ${parts.length} piezas al mueble "${name}": ${parts.map((p) => `${p.id}=${p.name}`).join(', ')}`;
  }));

kit.write('resize_furniture',
  'Cambia medidas u opciones de un mueble creado con add_cabinet (ancho, alto, fondo, entrepaños, shelfAt, rods, faceBack, cajones, puertas, materiales...) en la misma posición. Regenera sus piezas, así que se pierden las ediciones manuales de ellas. EN: change size/options of a generated cabinet (regenerates its parts).',
  { group: z.string(), width: z.number().positive().optional(), height: z.number().positive().optional(), depth: z.number().positive().optional(), ...cabinetOptions },
  ({ group, ...patch }) => edit((project) => {
    const spec = project.cabinets?.[group];
    if (!spec) throw new Error(`"${group}" no es un mueble generado con add_cabinet.`);
    const merged: CabinetSpec = { ...spec, ...clean(patch) };
    const err = validateCabinetOptions(project, merged);
    if (err) throw new Error(err);
    const parts = rebuildCabinet(project, group, clean(patch));
    if (!parts) throw new Error(`"${group}" no es un mueble generado con add_cabinet (no se encontraron sus piezas).`);
    return `"${group}" regenerado: ${parts.length} piezas.`;
  }));

kit.write('fit_to_room', 'Acomoda los muebles en el espacio (requiere set_room): back = pegar al muro del fondo, left/right = pegar el conjunto a un muro, center = centrar, fill = estirar los muebles generados para llenar el ancho del muro. EN: arrange furniture in the room box.',
  { mode: z.enum(['back', 'left', 'right', 'center', 'fill']) },
  ({ mode }) => edit((project) => fitToRoom(project, mode)));

kit.write('set_layer', 'Asigna una capa propia a un mueble completo (group) o a una pieza (id). Sin layer vuelve a la capa automática. EN: set layer.',
  { group: z.string().optional(), id: z.string().optional(), layer: z.string().optional() },
  ({ group, id, layer }) => edit((project) => {
    const targets = project.parts.filter((p) => (group && groupOf(p) === group) || (id && p.id === id));
    for (const p of targets) { if (layer) p.layer = layer; else delete p.layer; }
    return `${targets.length} piezas ${layer ? `en la capa "${layer}"` : 'con capa automática'}.`;
  }));

kit.write('clear_parts', 'Borra todas las piezas del proyecto (queda copia en respaldos/). EN: delete all parts.', {}, () => edit((project) => { project.parts = []; project.cabinets = {}; return 'Proyecto vacío.'; }));

kit.write('set_room',
  'Define el espacio de trabajo simple (caja): ancho del muro, fondo (profundidad) y alto, con una ventana opcional en el muro del fondo (x,y desde la esquina inferior izquierda). Sin argumentos quita el espacio. No confundir con las habitaciones H# del plano (list_rooms). EN: simple room box.',
  { width: z.number().positive().optional(), depth: z.number().positive().optional(), height: z.number().positive().optional(), window: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).optional() },
  (a) => edit((project) => {
    if (a.width === undefined) { delete project.room; return 'Espacio quitado.'; }
    project.room = { width: a.width, depth: a.depth ?? 3000, height: a.height ?? 2400, window: a.window };
    return project.room;
  }));

// ---------------------------------------------------------------- cortes y presupuesto

kit.write('auto_edges', 'Aplica tapacanto automático (puertas por 4 cantos, el resto por el canto frontal). Con group solo a ese mueble. EN: auto edge banding.', { group: z.string().optional() }, ({ group }) => edit((project) => {
  const n = applyAutoEdges(project, group);
  const meters = project.parts.reduce((s, p) => s + edgeMeters(p), 0);
  return `Tapacanto aplicado a ${n} piezas. Total: ${meters.toFixed(2)} m.`;
}));

kit.write('set_prices', 'Define precios: por plancha de un material, tapacanto por metro y precio/cantidad de herrajes (por id: bisagra, manija, soporte, corredera, tornillos). EN: set prices.',
  {
    materials: z.array(z.object({ id: z.string(), price: z.number().min(0) })).optional(), edgePrice: z.number().min(0).optional(),
    hardware: z.array(z.object({ id: z.string(), price: z.number().min(0).optional(), qty: z.number().min(0).optional() })).optional(),
  },
  (a) => edit((project) => {
    for (const m of a.materials ?? []) { const x = project.materials.find((k) => k.id === m.id); if (!x) throw new Error(`Material desconocido: ${m.id}`); x.price = m.price; }
    if (a.edgePrice !== undefined) project.edgePrice = a.edgePrice;
    for (const h of a.hardware ?? []) {
      const x = project.hardware!.find((k) => k.id === h.id);
      if (!x) throw new Error(`Herraje desconocido: ${h.id}. Ids: ${project.hardware!.map((k) => k.id).join(', ')}`);
      if (h.price !== undefined) x.price = h.price;
      if (h.qty !== undefined) x.qty = h.qty;
    }
    return 'Precios actualizados.';
  }));

kit.write('calc_hardware', 'Calcula las cantidades de herrajes (bisagras, manijas, soportes de repisa, correderas) a partir del diseño y las guarda. EN: compute hardware quantities.', {}, () => edit((project) => applyAutoHardware(project)));

kit.read('get_budget', 'Presupuesto: planchas, tapacanto y herrajes con sus precios y el total. EN: budget.', {}, () => budget(view()));

kit.read('get_cutlist', 'Lista de cortes agrupada por material y medida, con tapacanto. Las formas sólidas (tubo, cilindro, prisma, revolución; ver add_part) no se cortan de planchas y no aparecen aquí: están en get_solids. EN: cut list (non-box solids are in get_solids).', {}, () => cutList(view()));

kit.read('optimize_cuts', 'Distribuye las piezas (cajas; las formas sólidas quedan fuera, ver get_solids) en planchas con cortes de guillotina y reporta planchas, aprovechamiento, posiciones, secuencia de cortes y advertencias. EN: sheet nesting.', {}, () => {
  const r = nest(view());
  return {
    sheets: r.sheets.map((s) => ({ material: s.material.name, sheet: s.index, efficiency: `${(s.efficiency * 100).toFixed(1)}%`, placements: s.placements, cuts: s.cuts })),
    totalSheets: r.sheets.length,
    unplaced: r.unplaced.map((p) => p.name),
    warnings: r.warnings,
  };
});

kit.files('export_files', 'Genera archivos de fabricación en la carpeta export/ de los datos: CSV de piezas, DXF de planchas y G-code para CNC. Devuelve las rutas. EN: write CSV/DXF/G-code files.',
  { toolDiameter: z.number().positive().optional().describe('Diámetro de la fresa del G-code (mm), 6 por defecto') },
  ({ toolDiameter }) => {
    const project = view();
    const result = nest(project);
    const dir = path.join(DATA_DIR, 'export');
    fs.mkdirSync(dir, { recursive: true });
    const base = project.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'proyecto';
    const files: Record<string, string> = {
      [`${base}-piezas.csv`]: piecesCsv(project, result),
      [`${base}-planchas.dxf`]: dxf(project, result),
      [`${base}.nc`]: gcode(project, result, toolDiameter ? { toolDiameter } : {}),
    };
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    return { folder: dir, files: Object.keys(files), warnings: result.warnings };
  });

// ---------------------------------------------------------------- respaldos

kit.read('list_backups', 'Copias de respaldo de project.json hechas por el agente en respaldos/ (project-… antes de cada cambio, sesion-… antes del primer cambio de cada sesión). EN: list project backups.', {}, () => store.listBackups());
kit.write('restore_backup', 'Restaura una copia de respaldo (nombre de list_backups) como project.json; antes guarda el estado actual. Pierde los cambios posteriores a esa copia. EN: restore a backup.', { name: z.string() }, ({ name }) => store.restoreBackup(name));

// ---------------------------------------------------------------- acabados, habitaciones, captura

registerFinishTools(kit, store, lib);
registerMeshTools(kit, store, DATA_DIR); // import_mesh (OBJ/STL/glTF -> piezas form 'mesh')
registerRoomTools(kit, store);
registerDrawingIoTools(kit, store, DATA_DIR); // import_dxf, export_dxf, export_pdf (server/mcpDrawingIO.ts)
registerHatchBlockTools(kit, store); // sombreados y bloques: draw_hatch, block_*, insert_block, explode_insert (server/mcpHatchBlocks.ts)
registerExportViewTools(kit, store, DATA_DIR); // save_view, request_view_export, list_view_exports (server/mcpExportView.ts)
registerMcadTools(kit, store, DATA_DIR); // export_mcad, import_mcad (server/mcpMcad.ts)
registerDrawingTools(kit, store); // dibujo 2D: draw_*, edición, capas, consultas, render, extrude_entity (server/mcpDrawing.ts)
registerTrimExtendTools(kit, store); // trim_entity, extend_entity (server/mcpTrimExtend.ts)

kit.read('get_screenshot', 'Devuelve la última captura del visor 3D. La app web/escritorio debe estar abierta en la pestaña 3D: es ella quien guarda latest.png; sin la app no hay captura (o es antigua). EN: last 3D viewport capture (needs the app open on the 3D tab).', {}, () => {
  if (!fs.existsSync(SCREENSHOT_FILE)) return fail('Aún no hay captura. Abre la app (MuebleCAD.exe o npm run dev) en la pestaña 3D.');
  const age = Math.round((Date.now() - fs.statSync(SCREENSHOT_FILE).mtimeMs) / 60000);
  return {
    content: [
      { type: 'text' as const, text: age > 5 ? `Aviso: la captura tiene ${age} min; puede no reflejar el estado actual (abre la app en la pestaña 3D).` : 'Captura reciente del visor 3D.' },
      { type: 'image' as const, data: fs.readFileSync(SCREENSHOT_FILE).toString('base64'), mimeType: 'image/png' },
    ],
  };
});

server.connect(new StdioServerTransport()).catch((e) => { console.error(e); process.exit(1); });
