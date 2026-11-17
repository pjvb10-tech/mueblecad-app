import type { Project } from './types';

/**
 * Formato nativo `.mcad` de MuebleCAD: un JSON de texto (UTF-8, sin comprimir, legible y comparable con diff)
 * con un envoltorio versionado: { "formato": "mcad", "version": 1, "project": { ...Project } }.
 * Se decidió no comprimir: los proyectos pesan poco, el texto plano es robusto y editable a mano, y evita depender de
 * CompressionStream en cada entorno. El lector también acepta el JSON plano antiguo (un Project suelto, `.json`).
 */
export const MCAD_FORMAT = 'mcad';
export const MCAD_VERSION = 1;
export const MCAD_EXT = '.mcad';

export interface McadFile { formato: typeof MCAD_FORMAT; version: number; project: Project }

type Migration = (project: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migraciones: MIGRATIONS[n] convierte el `project` de la versión n a la n+1.
 * Al subir MCAD_VERSION se añade aquí la función de la versión anterior (y su prueba).
 */
export const MIGRATIONS: Record<number, Migration> = {};

export class McadError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Comprueba la forma mínima de un Project; lanza McadError si no lo es. */
export function assertProject(p: unknown): asserts p is Project {
  if (!isObj(p) || !Array.isArray(p.parts) || !Array.isArray(p.materials) || typeof p.name !== 'string') throw new McadError('El archivo no es un proyecto de MuebleCAD.');
}

/** Aplica en cadena las migraciones desde la versión `from` hasta `to`. */
export function migrateProject(project: Record<string, unknown>, from: number, to: number = MCAD_VERSION, table: Record<number, Migration> = MIGRATIONS): Record<string, unknown> {
  let p = project;
  for (let v = from; v < to; v++) {
    const step = table[v];
    if (!step) throw new McadError(`No hay migración del formato ${v} al ${v + 1}.`);
    p = step(p);
  }
  return p;
}

/** Serializa el proyecto como texto .mcad (con envoltorio versionado). */
export function serializeMcad(project: Project): string {
  const file: McadFile = { formato: MCAD_FORMAT, version: MCAD_VERSION, project };
  return JSON.stringify(file, null, 2);
}

/** Lee un .mcad (o un .json antiguo con el Project plano), migra por versión y devuelve el proyecto. */
export function parseMcad(text: string): Project {
  let data: unknown;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new McadError('El archivo no es un JSON válido.'); }
  if (!isObj(data)) throw new McadError('El archivo no es un proyecto de MuebleCAD.');
  if (data.formato !== MCAD_FORMAT) { assertProject(data); return data; } // JSON plano antiguo
  const version = data.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw new McadError('Versión de archivo .mcad no válida.');
  if (version > MCAD_VERSION) throw new McadError(`El archivo se creó con una versión más nueva de MuebleCAD (formato ${version}); actualiza la aplicación para abrirlo.`);
  if (!isObj(data.project)) throw new McadError('El archivo .mcad no contiene un proyecto.');
  const project = migrateProject(data.project, version);
  assertProject(project);
  return project;
}

/** Nombre de archivo seguro para guardar el proyecto: «<nombre>.mcad». */
export function mcadFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 80) || 'proyecto';
  return base + MCAD_EXT;
}
