import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Kit } from './mcpKit';
import type { Store } from './store';
import { resolveImportFile } from './mcpMesh';
import { mcadFileName, parseMcad, serializeMcad } from '../src/core/mcad';
import { defaultHardware } from '../src/core/types';

/** Formato nativo .mcad por MCP: export_mcad escribe en <datos>/export/ e import_mcad lee de <datos>/importar/. Núcleo: src/core/mcad.ts. */
export function registerMcadTools(kit: Kit, store: Store, dataDir: string): void {
  kit.files('export_mcad',
    'Exporta el proyecto activo como archivo .mcad (formato nativo de MuebleCAD, JSON versionado) en la carpeta export/ de los datos. Se abre con doble clic o con «Abrir…». Devuelve la ruta. EN: export the project as a .mcad file.',
    {},
    () => {
      const project = store.readProject().project;
      const dir = path.join(dataDir, 'export');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, mcadFileName(project.name));
      fs.writeFileSync(file, serializeMcad(project));
      return { file, bytes: fs.statSync(file).size };
    });

  kit.write('import_mcad',
    'Importa un archivo .mcad (o un .json de proyecto antiguo) de la carpeta "importar" de los datos y lo deja como proyecto activo, REEMPLAZANDO el actual (antes se guarda una copia en respaldos/; restáuralo con restore_backup). EN: replace the active project with a .mcad file.',
    { path: z.string().describe('Archivo dentro de la carpeta "importar" de los datos, p. ej. "cocina.mcad"') },
    (a) => {
      const full = resolveImportFile(dataDir, a.path);
      const next = parseMcad(fs.readFileSync(full, 'utf8'));
      store.readProject(); // crea project.json si no existía
      store.backup(store.projectFile, 'project', true);
      return store.updateProject((project) => {
      next.hardware ??= defaultHardware();
      const target = project as unknown as Record<string, unknown>;
      for (const k of Object.keys(target)) delete target[k];
      Object.assign(target, next);
      return { name: next.name, partes: next.parts.length, materiales: next.materials.length, dibujos: next.drawings?.length ?? 0 };
      });
    });
}
