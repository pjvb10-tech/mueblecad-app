import fs from 'node:fs';
import path from 'node:path';
import { defaultProject, type Project } from '../src/core/types';

/** Por defecto `data/` del proyecto; con MUEBLECAD_DATA se apunta a la carpeta de la app de escritorio. */
export const DATA_DIR = process.env.MUEBLECAD_DATA ?? path.resolve(import.meta.dirname, '..', 'data');

/** Copias de respaldo hechas por el agente (MCP): project-<marca>.json antes de cada escritura (se conservan las últimas 10) y sesion-<marca>.json con el estado previo a la primera escritura de cada sesión (últimas 5). */
export const KEEP_BACKUPS = 10;
export const KEEP_SESSION_BACKUPS = 5;
/** Si la última copia es más reciente que esto (ms), no se hace otra (evita llenar la rotación con una ráfaga de cambios). */
const MIN_BACKUP_GAP_MS = 30_000;

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '').replace('.', '');
const BACKUP_NAME = /^(project|sesion|catalogo)-\d{8}-\d{9}\.json$/;

/** Escritura atómica: archivo temporal en la misma carpeta y renombrado (con reintentos si el archivo está momentáneamente abierto en Windows). */
export function atomicWrite(file: string, data: string | Buffer): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) { try { fs.unlinkSync(tmp); } catch { /* ya no existe */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}

export const KEEP_ACTIVITY = 40;
export interface ActivityEntry { t: number; tool: string; mode: string; ok: boolean; message: string }

export class ConflictError extends Error {}

/** Almacén de datos de un proyecto en una carpeta. `dataDir` debe ser la carpeta de datos de MuebleCAD. */
export function createStore(dataDir: string) {
  const projectFile = path.join(dataDir, 'project.json');
  const backupDir = path.join(dataDir, 'respaldos');
  let sessionBackupDone = false;

  const prune = (prefix: string, keep: number) => {
    if (!fs.existsSync(backupDir)) return;
    const names = fs.readdirSync(backupDir).filter((n) => n.startsWith(`${prefix}-`) && BACKUP_NAME.test(n)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - keep))) { try { fs.unlinkSync(path.join(backupDir, n)); } catch { /* se ignora */ } }
  };

  /** Copia `file` a respaldos/ con marca de tiempo. Devuelve el nombre de la copia o null si no hizo falta. */
  function backup(file: string, prefix: 'project' | 'catalogo', force = false): string | null {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) return null;
    fs.mkdirSync(backupDir, { recursive: true });
    let made: string | null = null;
    if (prefix === 'project' && !sessionBackupDone) {
      const n = `sesion-${stamp()}.json`;
      fs.copyFileSync(file, path.join(backupDir, n));
      sessionBackupDone = true;
      prune('sesion', KEEP_SESSION_BACKUPS);
      made = n;
    }
    const recent = fs.readdirSync(backupDir).filter((n) => n.startsWith(`${prefix}-`) && BACKUP_NAME.test(n)).sort().pop();
    const age = recent ? Date.now() - fs.statSync(path.join(backupDir, recent)).mtimeMs : Infinity;
    if (force || age >= MIN_BACKUP_GAP_MS) {
      const n = `${prefix}-${stamp()}.json`;
      fs.copyFileSync(file, path.join(backupDir, n));
      prune(prefix, KEEP_BACKUPS);
      made = n;
    }
    return made;
  }

  function readProject(): { rev: number; project: Project } {
    if (!fs.existsSync(projectFile)) { fs.mkdirSync(dataDir, { recursive: true }); atomicWrite(projectFile, JSON.stringify(defaultProject(), null, 2)); }
    const rev = fs.statSync(projectFile).mtimeMs;
    let project: Project;
    try { project = JSON.parse(fs.readFileSync(projectFile, 'utf8')); } catch (e) {
      throw new Error(`project.json no es un JSON válido (${(e as Error).message}). No se modificó nada; restaura una copia de respaldos/ con restore_backup.`);
    }
    if (!project || typeof project !== 'object' || !Array.isArray(project.parts) || !Array.isArray(project.materials)) {
      throw new Error('project.json no tiene la forma de un proyecto de MuebleCAD (faltan parts o materials). No se modificó nada.');
    }
    if (project.drawings !== undefined && !Array.isArray(project.drawings)) {
      throw new Error('project.json: drawings debe ser una lista de dibujos 2D (ver docs/dibujo-2d.md). No se modificó nada; restaura una copia de respaldos/.');
    }
    if (project.views !== undefined && !Array.isArray(project.views)) {
      throw new Error('project.json: views debe ser una lista de vistas guardadas. No se modificó nada; restaura una copia de respaldos/.');
    }
    return { rev, project };
  }

  /** Guarda el proyecto (copia de respaldo + escritura atómica). Si `expectedRev` no coincide con el archivo, lanza ConflictError sin escribir. */
  function writeProject(project: Project, expectedRev?: number): number {
    fs.mkdirSync(dataDir, { recursive: true });
    if (expectedRev !== undefined && fs.existsSync(projectFile) && fs.statSync(projectFile).mtimeMs !== expectedRev) {
      throw new ConflictError('El proyecto cambió mientras se editaba (otra sesión o la app).');
    }
    backup(projectFile, 'project');
    atomicWrite(projectFile, JSON.stringify(project, null, 2));
    return fs.statSync(projectFile).mtimeMs;
  }

  /**
   * Lee, aplica `fn` y guarda. Si `fn` lanza no se escribe nada. Si el archivo cambió entre la lectura y la escritura
   * (la app web u otra sesión) se vuelve a leer y a aplicar `fn`, hasta 3 intentos.
   */
  function updateProject<T>(fn: (project: Project) => T): T {
    for (let attempt = 0; ; attempt++) {
      const { rev, project } = readProject();
      const result = fn(project);
      try { writeProject(project, rev); return result; } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= 2) throw e;
      }
    }
  }

  function listBackups(): { name: string; kb: number; modified: string }[] {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir).filter((n) => BACKUP_NAME.test(n)).sort().reverse().map((n) => {
      const st = fs.statSync(path.join(backupDir, n));
      return { name: n, kb: Math.round(st.size / 1024), modified: st.mtime.toISOString() };
    });
  }

  /** Restaura una copia de proyecto (project-*.json o sesion-*.json) como project.json; antes guarda el estado actual. */
  function restoreBackup(name: string): string {
    if (!BACKUP_NAME.test(name) || name.startsWith('catalogo-')) throw new Error('Nombre de copia no válido: usa uno de list_backups (project-… o sesion-…).');
    const file = path.join(backupDir, name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`No existe la copia ${name}.`);
    const data = fs.readFileSync(file, 'utf8');
    JSON.parse(data); // debe ser JSON válido antes de pisar nada
    const project = JSON.parse(data) as Project;
    if (!Array.isArray(project.parts) || !Array.isArray(project.materials)) throw new Error(`La copia ${name} no parece un proyecto.`);
    const saved = fs.existsSync(projectFile) ? (backup(projectFile, 'project', true) ?? 'sin copia') : 'no había proyecto';
    atomicWrite(projectFile, data);
    return `Restaurada ${name}. Estado anterior guardado como: ${saved}.`;
  }

  /** Registro de actividad del agente (actividad.json, últimas 40 llamadas). La app lo lee para mostrar "Agente trabajando…" en vivo. */
  const activityFile = path.join(dataDir, 'actividad.json');
  function readActivity(): ActivityEntry[] {
    try { const a = JSON.parse(fs.readFileSync(activityFile, 'utf8')); return Array.isArray(a.items) ? a.items : []; } catch { return []; }
  }
  function logActivity(call: { tool: string; mode: string; ok: boolean; message: string }): void {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const items = [...readActivity(), { t: Date.now(), ...call }].slice(-KEEP_ACTIVITY);
      atomicWrite(activityFile, JSON.stringify({ version: 1, items }));
    } catch { /* si no se puede escribir el registro, la herramienta sigue funcionando */ }
  }

  return { dataDir, projectFile, activityFile, readActivity, logActivity, backupDir, readProject, writeProject, updateProject, backup, listBackups, restoreBackup };
}

export type Store = ReturnType<typeof createStore>;
export const store = createStore(DATA_DIR);
export const PROJECT_FILE = store.projectFile;
export const SCREENSHOT_FILE = path.join(DATA_DIR, 'latest.png');
export const readProject = store.readProject;
export const writeProject = store.writeProject;
