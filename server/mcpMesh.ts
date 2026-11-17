import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Kit } from './mcpKit';
import type { Store } from './store';
import { MAX_MESH_TRIANGLES, meshSummary } from '../src/core/mesh';
import { importMeshDetailed, MESH_UNITS, type MeshFormat, type MeshUnit } from '../src/core/meshImport';
import { nextId } from '../src/core/furniture';
import { validatePart } from '../src/core/solids';
import { defaultHardware, type Project } from '../src/core/types';

/** Subcarpeta de la carpeta de datos de donde import_mesh lee los modelos exportados (OBJ, STL, glTF/GLB). */
export const IMPORT_DIR = 'importar';
const MAX_FILE_BYTES = 200 * 1024 * 1024;

/** Resuelve `file` dentro de <datos>/importar (sin salirse de ella: nada de rutas absolutas ni ..). */
export function resolveImportFile(dataDir: string, file: string): string {
  const root = path.resolve(dataDir, IMPORT_DIR);
  const full = path.resolve(root, file);
  if (path.relative(root, full).startsWith('..') || path.isAbsolute(path.relative(root, full))) throw new Error(`El archivo debe estar dentro de la carpeta "${IMPORT_DIR}" de los datos (${root}).`);
  if (!fs.existsSync(full)) throw new Error(`No existe "${file}" en ${root}. Exporta el modelo desde SketchUp (OBJ/STL/glTF) y copia el archivo ahí.`);
  const st = fs.statSync(full);
  if (!st.isFile() || st.size > MAX_FILE_BYTES) throw new Error(`"${file}" no es un archivo válido o pesa más de ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  return full;
}

export interface ImportMeshArgs {
  file?: string;
  base64?: string;
  text?: string;
  formato?: MeshFormat;
  unidad?: MeshUnit;
  ejeArriba?: 'y' | 'z';
  escala?: number;
  nombre?: string;
  material?: string;
  separar?: 'objetos' | 'uno';
  soldar?: boolean;
  decimar?: boolean;
  maxTriangulos?: number;
  posicion?: [number, number, number];
  grupo?: string;
}

/** Lógica de import_mesh sin MCP (probable por separado): importa, valida y agrega las piezas al proyecto. */
export function importMeshInto(project: Project, dataDir: string, a: ImportMeshArgs) {
  const given = [a.file, a.base64, a.text].filter((v) => v !== undefined).length;
  if (given !== 1) throw new Error('Indica exactamente uno de: file (en la carpeta "importar" de los datos), base64 (bytes del archivo) o text (OBJ / STL ASCII / glTF en texto).');
  const material = a.material ?? project.materials[0]?.id ?? 'mel18';
  if (!project.materials.some((m) => m.id === material)) throw new Error(`Material desconocido: ${material}. Materiales: ${project.materials.map((m) => m.id).join(', ')}.`);
  let data: Uint8Array | string;
  let nombreArchivo: string | undefined;
  if (a.file !== undefined) { const full = resolveImportFile(dataDir, a.file); data = new Uint8Array(fs.readFileSync(full)); nombreArchivo = path.basename(full); }
  else if (a.base64 !== undefined) data = new Uint8Array(Buffer.from(a.base64, 'base64'));
  else data = a.text!;
  const res = importMeshDetailed(data, { ...a, material, nombreArchivo, posicion: a.posicion });
  const added: { id: string; name: string; triangulos: number; size: number[] }[] = [];
  for (const part of res.parts) {
    part.id = nextId(project);
    const err = validatePart(part);
    if (err) throw new Error(err);
    project.parts.push(part);
    added.push({ id: part.id, name: part.name, triangulos: part.mesh!.triangles, size: part.size });
  }
  return { agregadas: added, unidad: res.unidad, unidadDetectada: res.unidadDetectada, avisos: res.avisos };
}

export function registerMeshTools(kit: Kit, store: Store, dataDir: string) {
  const edit = <T>(fn: (project: Project) => T): T => store.updateProject((project) => { project.hardware ??= defaultHardware(); return fn(project); });
  kit.write('import_mesh',
    `Importa un modelo 3D exportado desde SketchUp u otro programa (OBJ, STL binario/ASCII, glTF/GLB; los .skp y .dae no se leen: exporta a OBJ) como piezas de forma 'mesh' (una por objeto, o una sola con separar='uno'). El archivo va en la carpeta "${IMPORT_DIR}" dentro de la carpeta de datos (file="silla.obj"), o se pasa por base64/text. unidad: mm, cm, m, in o ft (SketchUp suele exportar en pulgadas o metros; si se omite se deduce por tamaño y se avisa; glTF siempre es m). ejeArriba: 'y' (omisión) o 'z' (SketchUp/CAD; se gira para dejar Y arriba). escala: factor extra. posicion: esquina mínima del conjunto en mm (por omisión [0,0,0]). Máximo ${MAX_MESH_TRIANGLES} triángulos por pieza: con decimar=true se simplifica, si no se rechaza. Las mallas no entran en despiece, planchas ni presupuesto (se listan en get_solids). EN: import OBJ/STL/glTF models as mesh parts.`,
    {
      file: z.string().optional().describe(`Nombre del archivo dentro de la carpeta "${IMPORT_DIR}" de los datos`),
      base64: z.string().optional().describe('Bytes del archivo en base64 (alternativa a file)'),
      text: z.string().optional().describe('Contenido de texto (OBJ, STL ASCII o glTF JSON) (alternativa a file)'),
      formato: z.enum(['obj', 'stl', 'gltf', 'glb']).optional().describe('Por omisión se deduce de la extensión o el contenido'),
      unidad: z.enum(Object.keys(MESH_UNITS) as [MeshUnit, ...MeshUnit[]]).optional(),
      ejeArriba: z.enum(['y', 'z']).optional(),
      escala: z.number().positive().optional(),
      nombre: z.string().optional(), material: z.string().optional(), grupo: z.string().optional(),
      separar: z.enum(['objetos', 'uno']).optional().describe("'objetos' (omisión): una pieza por objeto/grupo; 'uno': una sola pieza"),
      soldar: z.boolean().optional().describe('Soldar vértices coincidentes (omisión: sí en STL, no en OBJ/glTF)'),
      decimar: z.boolean().optional(), maxTriangulos: z.number().int().min(100).max(MAX_MESH_TRIANGLES).optional(),
      posicion: z.tuple([z.number(), z.number(), z.number()]).optional(),
    },
    (a) => edit((project) => importMeshInto(project, dataDir, a as ImportMeshArgs)));
}

/** Para get_project / list_parts: la malla se resume (sin volcar los datos de vértices). */
export const meshSlim = <T extends { mesh?: Parameters<typeof meshSummary>[0] }>(p: T) => (p.mesh ? { ...p, mesh: meshSummary(p.mesh) } : p);
