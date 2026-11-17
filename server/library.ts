/**
 * Biblioteca de texturas para el agente (MCP): misma validación que la API web (reutiliza server/texturas.cjs).
 * Todo ocurre dentro de <datos>/texturas/. Sin red; la única lectura fuera de esa carpeta es la imagen local que se pide agregar.
 */
import fs from 'node:fs';
import path from 'node:path';
import txModule from './texturas.cjs';
import { atomicWrite, type Store } from './store';
import type { Project } from '../src/core/types';

const tx = txModule;

export const MAX_IMAGE_BYTES = tx.MAX_BYTES;
export const CATEGORIES = tx.CATEGORIAS;

/** Entrada del catálogo tal como se guarda (ver TextureItem en core/finish). */
export interface CatalogEntry {
  id: string; nombre: string; categoria: string; archivo?: string; color?: string;
  w: number; h: number; junta: number; colorJunta: string; veta: 0 | 90; patron: 'recto' | 'trabado';
}
export interface TextureInput {
  titulo?: string; categoria?: string; w?: number; h?: number; junta?: number; colorJunta?: string; veta?: number; patron?: string;
}

export function createLibrary(store: Store) {
  const dir = path.join(store.dataDir, 'texturas');
  const catalogFile = path.join(dir, 'catalogo.json');

  const readCatalog = (): CatalogEntry[] => {
    try {
      const c = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
      return Array.isArray(c) ? c : Array.isArray(c.items) ? c.items : [];
    } catch { return []; }
  };
  const writeCatalog = (items: CatalogEntry[]) => {
    fs.mkdirSync(dir, { recursive: true });
    store.backup(catalogFile, 'catalogo');
    atomicWrite(catalogFile, JSON.stringify({ version: 1, items }, null, 2));
  };

  /** Guarda una imagen (ya leída) en la biblioteca y crea su entrada. Lanza con un mensaje claro si algo no es válido. */
  function addImage(data: Buffer, filename: string, meta: TextureInput = {}): { item: CatalogEntry; archivo: string } {
    if (data.length > MAX_IMAGE_BYTES) throw new Error('La imagen supera los 15 MB.');
    const nm = tx.sanearNombre(filename);
    if (!nm) throw new Error(`Nombre de archivo no válido: "${filename}". Usa letras, números, guion o punto, con extensión png, jpg, jpeg o webp.`);
    const tipo = tx.firmaImagen(data);
    if (!tipo) throw new Error('El contenido no es una imagen png, jpg o webp válida (firma de archivo no reconocida).');
    if (!tx.extCoincide(nm.ext, tipo)) throw new Error(`La extensión .${nm.ext} no coincide con el contenido, que es ${tipo}. Renombra el archivo con la extensión correcta.`);
    fs.mkdirSync(dir, { recursive: true });
    const archivo = tx.nombreLibre(dir, nm.base, nm.ext); // nunca sobrescribe
    const items = readCatalog();
    const titulo = (meta.titulo ?? '').trim() || nm.base;
    const item = tx.normalizarItem({ id: tx.idLibre(items, titulo), nombre: titulo, archivo, categoria: meta.categoria, w: meta.w, h: meta.h, junta: meta.junta, colorJunta: meta.colorJunta, veta: meta.veta, patron: meta.patron });
    if (!item) throw new Error('Datos de la textura no válidos.');
    fs.writeFileSync(path.join(dir, archivo), data, { flag: 'wx' });
    try { writeCatalog([...items, item]); } catch (e) { try { fs.unlinkSync(path.join(dir, archivo)); } catch { /* ya no está */ } throw e; }
    return { item, archivo };
  }

  /** Agrega una imagen desde una ruta local absoluta: debe existir, ser un archivo normal (no enlace simbólico) y una imagen real. */
  function addFromFile(file: string, meta: TextureInput & { nombre?: string } = {}) {
    if (typeof file !== 'string' || !file.trim()) throw new Error('Falta la ruta del archivo.');
    if (file.includes('\0')) throw new Error('Ruta no válida.');
    if (/^[\\/]{2}/.test(file)) throw new Error('No se aceptan rutas de red (\\\\servidor\\…); copia la imagen a este equipo.');
    if (!path.isAbsolute(file)) throw new Error('La ruta debe ser absoluta (por ejemplo C:\\imagenes\\piso.png o /home/yo/piso.png).');
    let st: fs.Stats;
    try { st = fs.lstatSync(file); } catch { throw new Error(`No existe el archivo: ${file}`); }
    if (st.isSymbolicLink()) throw new Error('No se aceptan enlaces simbólicos: indica la ruta real del archivo.');
    if (!st.isFile()) throw new Error('La ruta no es un archivo.');
    if (st.size > MAX_IMAGE_BYTES) throw new Error('La imagen supera los 15 MB.');
    return addImage(fs.readFileSync(file), meta.nombre ?? path.basename(file), meta);
  }

  /** Agrega una imagen recibida en base64 (con o sin prefijo data:). `nombre` es el nombre de archivo con extensión. */
  function addFromBase64(b64: string, nombre: string, meta: TextureInput = {}) {
    const clean = String(b64).replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new Error('El base64 no es válido.');
    if ((clean.length * 3) / 4 > MAX_IMAGE_BYTES + 3) throw new Error('La imagen supera los 15 MB.');
    return addImage(Buffer.from(clean, 'base64'), nombre, meta);
  }

  /** Agrega un color liso (#rrggbb) como textura. */
  function addColor(color: string, meta: TextureInput = {}): { item: CatalogEntry } {
    const items = readCatalog();
    const titulo = (meta.titulo ?? '').trim() || `Color ${color}`;
    const item = tx.normalizarItem({ id: tx.idLibre(items, titulo), nombre: titulo, color, categoria: meta.categoria ?? 'pintura', w: meta.w, h: meta.h, junta: meta.junta ?? 0, colorJunta: meta.colorJunta, veta: meta.veta, patron: meta.patron });
    if (!item) throw new Error('El color debe tener la forma #rrggbb.');
    writeCatalog([...items, item]);
    return { item };
  }

  /** Cambia datos de una entrada (no el id ni el archivo). */
  function update(id: string, patch: TextureInput & { nombre?: string; color?: string }): CatalogEntry {
    const items = readCatalog();
    const i = items.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`No existe la textura "${id}". Disponibles: ${items.map((x) => x.id).join(', ') || '(vacía)'}.`);
    const { titulo, ...rest } = patch;
    const cambios = Object.fromEntries(Object.entries({ ...rest, ...(titulo !== undefined ? { nombre: titulo } : {}) }).filter(([, v]) => v !== undefined));
    if (items[i].archivo) delete (cambios as { color?: string }).color;
    const item = tx.normalizarItem({ ...cambios, id }, items[i]);
    if (!item) throw new Error('Datos de la textura no válidos.');
    items[i] = item;
    writeCatalog(items);
    return item;
  }

  /** Cuántos acabados del proyecto usan la textura. */
  function usage(project: Pick<Project, 'finishes' | 'roomFloors'>, id: string): string[] {
    const out: string[] = [];
    for (const [room, f] of Object.entries(project.finishes ?? {})) if (JSON.stringify(f).includes(`"tex":${JSON.stringify(id)}`)) out.push(room);
    return out;
  }

  /** Quita la entrada; el archivo de imagen solo se borra si ninguna otra entrada lo usa. */
  function remove(id: string, deleteFile = true): { removed: CatalogEntry; fileDeleted: boolean; fileKept?: string } {
    const items = readCatalog();
    const it = items.find((x) => x.id === id);
    if (!it) throw new Error(`No existe la textura "${id}".`);
    const rest = items.filter((x) => x !== it);
    writeCatalog(rest);
    if (!it.archivo) return { removed: it, fileDeleted: false };
    if (!deleteFile) return { removed: it, fileDeleted: false, fileKept: 'se pidió conservarlo' };
    if (rest.some((x) => x.archivo === it.archivo)) return { removed: it, fileDeleted: false, fileKept: 'otra textura usa la misma imagen' };
    const f = path.join(dir, it.archivo);
    if (path.dirname(f) !== dir || !fs.existsSync(f) || !fs.lstatSync(f).isFile()) return { removed: it, fileDeleted: false, fileKept: 'el archivo no estaba' };
    fs.unlinkSync(f);
    return { removed: it, fileDeleted: true };
  }

  return { dir, catalogFile, readCatalog, addImage, addFromFile, addFromBase64, addColor, update, remove, usage };
}

export type Library = ReturnType<typeof createLibrary>;
