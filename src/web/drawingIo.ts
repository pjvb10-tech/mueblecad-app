import { validateDrawing } from '../core/drawing';
import { drawingToDxf, drawingsToDxfFiles, dxfToDrawing, type DxfUnits } from '../core/dxfDrawing';
import { drawingToPdf, parseScale, pdfLayout, PAPER_MM, type PdfOptions } from '../core/pdfDrawing';
import type { Drawing } from '../core/types';
import { infoDialog, formDialog } from './drawingDialogs';
import { download } from './exporters';
import type { DrawingsUi } from './drawingUi';

/**
 * Importar y exportar el dibujo 2D desde la interfaz: DXF (R2000, ida y vuelta) y PDF vectorial con cajetín.
 * Se conecta con `drawings.setIoHandlers`; las funciones puras están en src/core/dxfDrawing.ts y pdfDrawing.ts.
 */

const safeName = (s: string): string => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 80) || 'dibujo';
const yesNo: [string, string][] = [['no', 'No'], ['si', 'Sí']];

/** Los DXF R2000 suelen venir en ANSI: se prueba UTF-8 y, si hay caracteres de reemplazo, Windows-1252. */
export async function readDxfText(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(bytes) : utf8;
}

export function setupDrawingIo(drawings: DrawingsUi, ctx: { toast(text: string, ms?: number): void }): void {
  async function importDxf(file: File): Promise<void> {
    if (!/\.dxf$/i.test(file.name)) {
      if (/\.dwg$/i.test(file.name)) throw new Error('Los DWG no se leen directamente: ábrelo en AutoCAD / LibreCAD / DWG TrueView y guárdalo como DXF (R2000 o posterior).');
      throw new Error('Elige un archivo .dxf.');
    }
    const text = await readDxfText(file);
    const v = await formDialog('Importar DXF', [
      { key: 'name', label: 'Nombre del dibujo', type: 'text', value: file.name.replace(/\.dxf$/i, ''), wide: true },
      { key: 'units', label: 'Unidades del archivo', type: 'select', value: 'auto', wide: true, options: [['auto', 'Automático (según el archivo; sin dato, mm)'], ['mm', 'Milímetros'], ['cm', 'Centímetros'], ['m', 'Metros'], ['in', 'Pulgadas'], ['ft', 'Pies']] },
      { key: 'noDims', label: 'Sin cotas', type: 'select', value: 'no', options: yesNo },
      { key: 'noFrozen', label: 'Sin capas congeladas', type: 'select', value: 'no', options: yesNo },
      { key: 'blocks', label: 'Bloques (INSERT)', type: 'select', value: 'edit', wide: true, options: [['edit', 'Conservarlos como bloques editables'], ['explode', 'Explotarlos en entidades sueltas']] },
    ], { ok: 'Importar', note: 'Crea un dibujo nuevo con el contenido del DXF (modelo, no espacio papel). Los sombreados (HATCH) y los bloques se conservan; las curvas complejas se aproximan por polilíneas.' });
    if (!v) return;
    const r = dxfToDrawing(text, { name: v.name.trim() || 'Importado', units: v.units as DxfUnits, dropDimensions: v.noDims === 'si', dropFrozen: v.noFrozen === 'si', explodeBlocks: v.blocks === 'explode' });
    const bad = validateDrawing(r.drawing);
    if (bad) throw new Error(`El DXF produjo un dibujo no válido: ${bad}`);
    await drawings.addDrawing(r.drawing);
    const omitted = Object.entries(r.stats.omitted).map(([k, n]) => `${k} ×${n}`).join(', ');
    await infoDialog('DXF importado', [
      `${r.stats.entities} entidades en el dibujo «${r.drawing.name}». Unidades: ${r.units.source} (×${r.units.factor} a mm).`,
      ...(omitted ? [`No importado: ${omitted}.`] : []),
      ...r.warnings,
    ], r.warnings.length ? 'warn' : 'normal');
  }

  async function exportDxf(d: Drawing): Promise<void> {
    const all = drawings.drawings();
    let scope = 'one';
    if (all.length > 1) {
      const v = await formDialog('Exportar DXF R2000', [{ key: 'scope', label: 'Qué exportar', type: 'select', value: 'one', wide: true, options: [['one', `Dibujo activo: ${d.name}`], ['all', `Todos (${all.length}) en un solo DXF, con prefijo de capa`], ['files', `Todos: un archivo por dibujo (${all.length} descargas)`]] }], { ok: 'Exportar' });
      if (!v) return;
      scope = v.scope;
    }
    if (scope === 'one') download(`${safeName(d.name)}.dxf`, drawingToDxf(d), 'application/dxf');
    else if (scope === 'all') download('dibujos.dxf', drawingToDxf(all), 'application/dxf');
    else for (const f of drawingsToDxfFiles(all)) download(f.name, f.text, 'application/dxf');
    ctx.toast('DXF exportado (R2000, unidades mm).', 4000);
  }

  function optionsOf(d: Drawing, v: Record<string, string>): PdfOptions {
    return {
      paper: v.paper as PdfOptions['paper'], orientation: v.orientation as 'landscape' | 'portrait', scale: parseScale(v.scale.trim() || 'fit'),
      colors: v.colors as 'layer' | 'mono', title: v.titulo || d.name,
      ...(v.tb === 'si' ? { titleBlock: { titulo: v.titulo || d.name, autor: v.autor || undefined, fecha: v.fecha || new Date().toISOString().slice(0, 10) } } : {}),
    };
  }

  async function exportPdf(d: Drawing): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const v = await formDialog('Exportar PDF', [
      { key: 'paper', label: 'Papel', type: 'select', value: 'A3', options: Object.keys(PAPER_MM).map((k) => [k, `${k} (${PAPER_MM[k][0]}×${PAPER_MM[k][1]} mm)`]) },
      { key: 'orientation', label: 'Orientación', type: 'select', value: 'landscape', options: [['landscape', 'Horizontal'], ['portrait', 'Vertical']] },
      { key: 'scale', label: 'Escala', type: 'text', value: 'fit', note: '"fit" = la mayor escala normalizada que cabe; o 1:50, 1:20, 0.02…' },
      { key: 'colors', label: 'Colores', type: 'select', value: 'layer', options: [['layer', 'Por capa'], ['mono', 'Todo en negro']] },
      { key: 'tb', label: 'Cajetín', type: 'select', value: 'si', options: [['si', 'Con cajetín'], ['no', 'Sin cajetín']] },
      { key: 'titulo', label: 'Título', type: 'text', value: d.name, wide: true },
      { key: 'autor', label: 'Autor', type: 'text', value: '' },
      { key: 'fecha', label: 'Fecha', type: 'text', value: today },
    ], {
      ok: 'Exportar',
      check: (x) => { try { pdfLayout(d, optionsOf(d, x)); return null; } catch (e) { return e instanceof Error ? e.message : String(e); } },
    });
    if (!v) return;
    const opts = optionsOf(d, v);
    const bytes = drawingToPdf(d, opts);
    download(`${safeName(d.name)}.pdf`, bytes as BlobPart, 'application/pdf');
    ctx.toast(`PDF exportado: ${v.paper} · escala ${pdfLayout(d, opts).scaleLabel}.`, 5000);
  }

  drawings.setIoHandlers({ importDxf, exportDxf, exportPdf });
}
