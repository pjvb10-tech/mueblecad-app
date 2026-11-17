import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Kit } from './mcpKit';
import type { Store } from './store';
import { pickDrawing } from './mcpDrawing';
import { resolveImportFile } from './mcpMesh';
import { DrawingError, nextDrawingId, validateDrawings, withDrawing } from '../src/core/drawing';
import { drawingToDxf, drawingsToDxfFiles, dxfToDrawing } from '../src/core/dxfDrawing';
import { drawingToPdf, parseScale, pdfLayout, type PdfOptions } from '../src/core/pdfDrawing';
import { defaultHardware, type Drawing, type DrawingPlane } from '../src/core/types';

/**
 * Importar y exportar el dibujo 2D por MCP: import_dxf (lee de <datos>/importar/), export_dxf y export_pdf (escriben en <datos>/export/).
 * Funciones puras del núcleo: src/core/dxfDrawing.ts y pdfDrawing.ts.
 */

const safeName = (s: string): string => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'dibujo';

/** Texto de un DXF: UTF-8 y, si hay caracteres de reemplazo, Windows-1252 (los DXF R2000 suelen venir en ANSI). */
export function decodeDxf(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(bytes) : utf8;
}

export function registerDrawingIoTools(kit: Kit, store: Store, dataDir: string): void {
  const exportDir = () => { const d = path.join(dataDir, 'export'); fs.mkdirSync(d, { recursive: true }); return d; };

  kit.write('import_dxf',
    'Importa un DXF (de AutoCAD, LibreCAD, etc.; DWG no: conviértelo a DXF) como un dibujo 2D NUEVO del proyecto. El archivo va en la carpeta "importar" dentro de la carpeta de datos (path="plano.dxf") o se pasa su contenido en text. units: auto (usa $INSUNITS; sin unidades se asume mm), mm, cm, m, in o ft. Devuelve el id del dibujo, advertencias (tipos no soportados, unidades asumidas) y estadísticas. EN: import a DXF as a new drawing.',
    {
      path: z.string().optional().describe('Archivo dentro de la carpeta "importar" de los datos'),
      text: z.string().optional().describe('Contenido del DXF (alternativa a path)'),
      units: z.enum(['auto', 'mm', 'cm', 'm', 'in', 'ft']).optional().describe('Unidades del archivo (auto por omisión)'),
      name: z.string().optional().describe('Nombre del dibujo (por omisión el del archivo)'),
      plane: z.enum(['xy', 'xz', 'yz']).optional().describe('Plano 3D donde vive el dibujo (xz = planta por omisión)'),
      dropDimensions: z.boolean().optional().describe('Descartar cotas'),
      dropFrozen: z.boolean().optional().describe('Descartar capas congeladas'),
      explodeBlocks: z.boolean().optional().describe('Explotar los INSERT en entidades sueltas (por omisión false: los BLOCK quedan como bloques editables y cada INSERT como insert)'),
    },
    (a) => store.updateProject((project) => {
      if ((a.path === undefined) === (a.text === undefined)) throw new Error('Indica exactamente uno de: path (archivo en la carpeta "importar" de los datos) o text (contenido del DXF).');
      let raw: string, name = a.name;
      if (a.path !== undefined) { const full = resolveImportFile(dataDir, a.path); raw = decodeDxf(new Uint8Array(fs.readFileSync(full))); name ??= path.basename(full).replace(/\.dxf$/i, ''); }
      else raw = a.text!;
      project.hardware ??= defaultHardware();
      try {
        const r = dxfToDrawing(raw, { name: name || 'Importado', id: nextDrawingId(project), units: a.units, plane: a.plane as DrawingPlane | undefined, dropDimensions: a.dropDimensions, dropFrozen: a.dropFrozen, explodeBlocks: a.explodeBlocks });
        project.drawings = withDrawing(project, r.drawing).drawings;
        const m = validateDrawings(project);
        if (m) throw new Error(m);
        return { drawing: r.drawing.id, name: r.drawing.name, entities: r.stats.entities, units: r.units, warnings: r.warnings, stats: r.stats };
      } catch (e) { throw e instanceof DrawingError ? new Error(e.message) : e; }
    }));

  kit.files('export_dxf',
    'Exporta dibujos 2D a DXF R2000 (se abre en AutoCAD, LibreCAD, etc.; unidades mm) en la carpeta export/ de los datos. Con drawing (id o nombre) un archivo; con all=true un archivo por dibujo. Devuelve las rutas. EN: export drawings as DXF.',
    { drawing: z.string().optional().describe('Id o nombre del dibujo (se puede omitir si hay uno solo)'), all: z.boolean().optional().describe('Todos los dibujos, un DXF por dibujo') },
    (a) => {
      const project = store.readProject().project;
      const dir = exportDir();
      const files = a.all ? drawingsToDxfFiles(project.drawings ?? []) : (() => { const d = pickDrawing(project, a.drawing); return [{ name: `${safeName(d.name)}.dxf`, text: drawingToDxf(d) }]; })();
      if (!files.length) throw new Error('El proyecto no tiene dibujos que exportar.');
      for (const f of files) fs.writeFileSync(path.join(dir, safeName(f.name)), f.text);
      return { folder: dir, files: files.map((f) => safeName(f.name)) };
    });

  kit.files('export_pdf',
    'Exporta un dibujo 2D a PDF vectorial (1 página, con cajetín opcional) en la carpeta export/ de los datos. paper: A4, A3 (omisión), A2, A1 o A0; orientation: landscape (omisión) o portrait; scale: "fit" (la mayor escala normalizada que cabe), "1:50" o un número (0.02). titleBlock: {titulo, autor?, fecha?}. Devuelve la ruta y la escala resultante. EN: export a drawing as PDF.',
    {
      drawing: z.string().optional().describe('Id o nombre del dibujo (se puede omitir si hay uno solo)'),
      paper: z.enum(['A4', 'A3', 'A2', 'A1', 'A0']).optional(),
      orientation: z.enum(['landscape', 'portrait']).optional(),
      scale: z.union([z.string(), z.number().positive()]).optional().describe('"fit", "1:50" o un número (0.02 = 1:50)'),
      titleBlock: z.object({ titulo: z.string().optional(), autor: z.string().optional(), fecha: z.string().optional() }).optional(),
      mono: z.boolean().optional().describe('Todo en negro'),
    },
    (a) => {
      const d: Drawing = pickDrawing(store.readProject().project, a.drawing);
      const opts: PdfOptions = {
        ...(a.paper ? { paper: a.paper } : {}), ...(a.orientation ? { orientation: a.orientation } : {}),
        ...(a.scale !== undefined ? { scale: parseScale(a.scale) } : {}), ...(a.mono ? { colors: 'mono' as const } : {}),
        ...(a.titleBlock ? { titleBlock: { titulo: a.titleBlock.titulo ?? d.name, autor: a.titleBlock.autor, fecha: a.titleBlock.fecha ?? new Date().toISOString().slice(0, 10) } } : {}),
      };
      const lay = pdfLayout(d, opts);
      const file = path.join(exportDir(), `${safeName(d.name)}.pdf`);
      fs.writeFileSync(file, drawingToPdf(d, opts));
      return { file, paper: lay.paper, scale: lay.scaleLabel, warnings: d.entities.length ? [] : ['El dibujo está vacío.'] };
    });
}
