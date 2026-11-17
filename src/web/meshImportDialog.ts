import { groupOf, nextId } from '../core/furniture';
import { importMeshDetailed, MESH_UNITS, type MeshUnit } from '../core/meshImport';
import { partBounds, validatePart } from '../core/solids';
import type { Part, Project } from '../core/types';
import { formDialog } from './drawingDialogs';

/**
 * Diálogo «Importar modelo 3D»: OBJ, STL y glTF/GLB (SketchUp u otros) como piezas de forma 'mesh'.
 * La capa pura es `importMeshDetailed` (src/core/meshImport.ts, docs/formas.md "Mallas"); aquí solo se pide lo que falta
 * (unidad, eje arriba, escala, separar), se muestran los avisos y se agrega todo en un único paso de historial.
 */

export interface MeshImportCtx {
  /** Botón que abre el selector de archivos. */
  button: HTMLElement;
  project(): Project;
  /** commit de main.ts: un solo punto de deshacer, aplica y guarda. */
  commit(change: () => void): Promise<void>;
  toast(text: string, ms?: number): void;
  /** Deja elegido el mueble (grupo) recién importado. */
  select(group: string): void;
}

const UNIT_LABEL: Record<MeshUnit, string> = { mm: 'Milímetros', cm: 'Centímetros', m: 'Metros', in: 'Pulgadas', ft: 'Pies' };

export function setupMeshImport(ctx: MeshImportCtx): void {
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.obj,.stl,.gltf,.glb,.skp,.dae';
  picker.hidden = true;
  document.body.append(picker);
  ctx.button.onclick = () => { picker.value = ''; picker.click(); };
  picker.onchange = () => {
    const f = picker.files?.[0];
    if (f) void run(f).catch((e) => ctx.toast(e instanceof Error ? e.message : String(e), 8000));
  };

  async function run(file: File): Promise<void> {
    const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1].toLowerCase() ?? '';
    if (ext === 'skp') throw new Error('SketchUp (.skp) es un formato propietario y no se puede leer. En SketchUp usa Archivo > Exportar > Modelo 3D y elige OBJ (o STL / glTF); luego importa ese archivo aquí.');
    if (ext === 'dae') throw new Error('COLLADA (.dae) no está soportado. Exporta el modelo a OBJ desde SketchUp (Archivo > Exportar > Modelo 3D > OBJ) e impórtalo.');
    if (!['obj', 'stl', 'gltf', 'glb'].includes(ext)) throw new Error(`Formato ".${ext}" no soportado. Usa OBJ, STL, glTF o GLB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const proj = ctx.project();
    const mats = proj.materials.filter((m) => !m.purchased);
    if (!mats.length) throw new Error('No hay materiales para asignar; agrega uno en «Materiales».');

    // primera pasada: detecta unidad y avisos para ofrecerlos en el diálogo
    const probe = importMeshDetailed(bytes, { nombreArchivo: file.name, material: mats[0].id });
    const total = probe.parts.reduce((n, p) => n + (p.mesh?.triangles ?? 0), 0);
    const notes = [`${probe.parts.length} objeto(s), ${total.toLocaleString('es')} triángulos.`, ...probe.avisos];
    const maxX = proj.parts.reduce((m, p) => Math.max(m, partBounds(p).max[0]), -Infinity);
    const gltf = ext === 'gltf' || ext === 'glb';

    let result: Part[] = [];
    const v = await formDialog('Importar modelo 3D', [
      { key: 'name', label: 'Nombre', type: 'text', value: file.name.replace(/\.[^.]+$/, ''), wide: true },
      { key: 'unit', label: probe.unidadDetectada ? 'Unidad (deducida por el tamaño: confírmala)' : 'Unidad del archivo', type: 'select', value: probe.unidad, wide: true, options: (Object.keys(MESH_UNITS) as MeshUnit[]).map((u) => [u, UNIT_LABEL[u]]) },
      { key: 'up', label: 'Eje arriba', type: 'select', value: 'y', options: gltf ? [['y', 'Y (glTF)']] : [['y', 'Y arriba'], ['z', 'Z arriba (CAD / SketchUp)']] },
      { key: 'scale', label: 'Escala extra', type: 'number', value: 1 },
      { key: 'split', label: 'Objetos', type: 'select', value: 'objetos', options: [['objetos', 'Una pieza por objeto'], ['uno', 'Todo en una sola pieza']] },
      { key: 'mat', label: 'Material', type: 'select', value: mats[0].id, wide: true, options: mats.map((m) => [m.id, m.name]) },
    ], {
      ok: 'Importar',
      note: notes.join('  '),
      check: (x) => {
        try {
          const scale = Number(x.scale);
          if (!(scale > 0)) return 'La escala debe ser un número mayor que 0.';
          const r = importMeshDetailed(bytes, {
            nombreArchivo: file.name, nombre: x.name.trim() || undefined, unidad: x.unit as MeshUnit, ejeArriba: x.up as 'y' | 'z', escala: scale,
            separar: x.split as 'objetos' | 'uno', material: x.mat, posicion: [Number.isFinite(maxX) ? maxX + 100 : 0, 0, 0],
          });
          for (const [i, p] of r.parts.entries()) { p.id = `tmp${i}`; const err = validatePart(p); if (err) return err; }
          result = r.parts;
          return null;
        } catch (e) { return e instanceof Error ? e.message : String(e); }
      },
    });
    if (!v) return;

    let first = '';
    await ctx.commit(() => {
      const p = ctx.project();
      for (const part of result) { part.id = nextId(p); p.parts.push(part); }
      first = result[0] ? groupOf(result[0]) : '';
    });
    if (first) ctx.select(first);
    ctx.toast(`Modelo importado: ${result.length} pieza(s).`, 5000);
  }
}
