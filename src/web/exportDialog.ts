import { nextViewId, validateView, withoutView, withView, findView } from '../core/savedViews';
import { PAPER_MM } from '../core/pdfDrawing';
import type { Part, Project, SavedView } from '../core/types';
import { STD_VIEWS, type StdView } from '../core/viewSheet';
import { download } from './exporters';
import { buildExport, defaultOpts, FORMATS_BY_SOURCE, orderToOpts, type ExportEnv, type ExportOpts, type ExportResult, type OrderRequest, type SheetPart, type Source } from './exportView';
import type { Viewer } from './viewer';
import type { DrawingsUi } from './drawingUi';

/**
 * Diálogo "Exportar vista" (3D del visor, dibujo 2D, planos y lámina) y lista de vistas guardadas del proyecto.
 * Cada resultado se puede descargar o guardar en la carpeta export/ de los datos (POST /api/export-file). También procesa los pedidos
 * que deja el agente en export/pedidos.json (MCP request_view_export) cuando la app está abierta.
 */

export interface ExportCtx {
  viewer: Viewer;
  drawings: DrawingsUi;
  project(): Project;
  isHidden(p: Part): boolean;
  hiddenLayers: Set<string>;
  tab(): string;
  setTab(t: 'd3' | 'plans'): void;
  /** Aplica un cambio al proyecto con deshacer y lo guarda. */
  commit(change: () => void): Promise<void>;
  render(): void;
  toast(text: string, ms?: number): void;
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const SRC_LABEL: Record<Source, string> = { '3d': 'Vista 3D del visor', '2d': 'Dibujo 2D activo', sheet: 'Planos y lámina (varias vistas en una hoja)' };
const RES_LABEL: [string, string][] = [['1', '1x (tamaño del visor)'], ['2', '2x'], ['4', '4x'], ['custom', 'A medida (px)']];
const VIEW_OPTIONS: [string, string][] = [['current', 'Vista actual del visor'], ...(Object.keys(STD_VIEWS) as StdView[]).filter((k) => k !== 'persp').map((k): [string, string] => [k, STD_VIEWS[k].label]), ['persp', 'Perspectiva estándar']];

const STYLE = `
  #exportDlg { width: 640px; } #exportDlg .form { grid-template-columns: 1fr 1fr; } #exportDlg [hidden] { display: none !important; }
  #exportDlg .exh { margin: 14px 0 6px; font-weight: 600; font-size: 13px; } #exportDlg .exmsg { min-height: 1.3em; font-size: 12px; color: var(--muted); margin-top: 8px; }
  #exportDlg .exmsg.err { color: var(--danger); } #exportDlg .exviews { display: grid; gap: 4px; max-height: 160px; overflow: auto; }
  #exportDlg .exview { display: flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 6px; padding: 3px 8px; font-size: 13px; }
  #exportDlg .exview b { flex: 1; font-weight: 500; } #exportDlg .exview small { color: var(--muted); } #exportDlg .exchecks { display: flex; gap: 12px; flex-wrap: wrap; font-size: 13px; }
  #exportDlg .exchecks label { display: flex; align-items: center; gap: 4px; color: var(--text); } #exportDlg .exchecks input { width: auto; }
  #exportDlg .exsave { display: flex; gap: 6px; margin-top: 6px; } #exportDlg .exsave input { flex: 1; }
`;

export function setupExport(ctx: ExportCtx): { open(): void } {
  const env: ExportEnv = { viewer: ctx.viewer, project: ctx.project, isHidden: ctx.isHidden, drawings: ctx.drawings };
  const o: ExportOpts = defaultOpts();
  let last: ExportResult | null = null;

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.append(style);
  const dlg = document.createElement('dialog');
  dlg.id = 'exportDlg';
  const sel = (key: string, label: string, opts: [string, string][], attrs = ''): string => `<label ${attrs}>${label}<select data-k="${key}">${opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select></label>`;
  const txt = (key: string, label: string, type = 'text', attrs = ''): string => `<label ${attrs}>${label}<input data-k="${key}" type="${type}" ${type === 'number' ? 'step="any" min="0"' : ''} /></label>`;
  const chk = (key: string, label: string, attrs = ''): string => `<label class="check" ${attrs}><input data-k="${key}" type="checkbox" /> ${label}</label>`;
  const paperOpts: [string, string][] = Object.keys(PAPER_MM).map((k) => [k, `${k} (${PAPER_MM[k][0]}×${PAPER_MM[k][1]} mm)`]);
  dlg.innerHTML = `<form method="dialog" onsubmit="return false"><h3>Exportar vista</h3>
    <div class="form">
      ${sel('source', 'Qué exportar', (Object.keys(SRC_LABEL) as Source[]).map((k) => [k, SRC_LABEL[k]]), 'class="wide"')}
      ${sel('format', 'Formato', [['png', 'PNG']])}
      <span data-src="3d,sheet"></span>
      <div class="wide" data-src="3d,sheet"><div class="exh" style="margin-top:4px">Vista 3D</div></div>
      ${sel('view', 'Vista', VIEW_OPTIONS, 'data-src="3d,sheet"')}
      ${sel('proj', 'Proyección', [['auto', 'Automática (ortográfica en vistas estándar)'], ['persp', 'Perspectiva'], ['ortho', 'Ortográfica']], 'data-src="3d,sheet"')}
      ${sel('res', 'Resolución', RES_LABEL, 'data-src="3d" data-fmt="png,jpg,pdf"')}
      ${txt('cw', 'Ancho (px)', 'number', 'data-src="3d" data-when="res=custom"')}${txt('ch', 'Alto (px) — vacío = proporcional', 'number', 'data-src="3d" data-when="res=custom"')}
      ${sel('bg', 'Fondo', [['white', 'Blanco'], ['viewer', 'Gris del visor'], ['transparent', 'Transparente (solo PNG)'], ['color', 'Color…']], 'data-src="3d,2d" data-fmt="png,jpg,svg"')}
      <label data-src="3d,2d" data-when="bg=color">Color de fondo<input data-k="color" type="color" /></label>
      ${chk('grid', 'Con cuadrícula', 'data-src="3d"')}${chk('labels', 'Con cotas y etiquetas', 'data-src="3d"')}
      ${sel('area', 'Área del dibujo', [['all', 'Todo el dibujo'], ['window', 'Ventana actual'], ['selection', 'Solo la selección']], 'data-src="2d" data-fmt="png,jpg,svg"')}
      ${txt('px', 'Ancho de la imagen (px)', 'number', 'data-src="2d,sheet" data-fmt="png,jpg,svg"')}
      ${chk('mono', 'Todo en negro', 'data-src="2d,sheet"')}
      <div class="wide" data-src="sheet"><div class="exh">Vistas de la lámina (hasta 4)</div><div class="exchecks" id="exParts">
        <label><input type="checkbox" data-part="3d" /> 3D</label><label><input type="checkbox" data-part="front" /> Frente</label><label><input type="checkbox" data-part="top" /> Planta</label><label><input type="checkbox" data-part="side" /> Lado</label><label><input type="checkbox" data-part="draw" /> Dibujo 2D activo</label></div></div>
      ${chk('cutlist', 'Adjuntar lista de piezas (páginas aparte)', 'class="check wide" data-src="sheet" data-fmt="pdf"')}
      <div class="wide" data-fmt="pdf"><div class="exh">Papel y cajetín</div></div>
      ${sel('paper', 'Papel', paperOpts, 'data-fmt="pdf"')}
      ${sel('orientation', 'Orientación', [['landscape', 'Horizontal'], ['portrait', 'Vertical']], 'data-fmt="pdf" data-src="2d,sheet"')}
      ${txt('scale', 'Escala', 'text', 'data-src="2d,sheet" data-fmt="pdf,png,jpg,svg" title="fit = la mayor escala normalizada que cabe; o 1:50, 1:20, 0.02"')}
      ${chk('tb', 'Con cajetín', 'data-fmt="pdf"')}
      ${txt('titulo', 'Título (vacío = nombre del proyecto)', 'text', 'class="wide" data-fmt="pdf"')}${txt('autor', 'Autor', 'text', 'data-fmt="pdf"')}${txt('fecha', 'Fecha', 'text', 'data-fmt="pdf"')}
    </div>
    <div class="exmsg" id="exMsg"></div>
    <div class="actions" style="flex-direction:row-reverse;justify-content:flex-start;margin-top:8px">
      <button type="button" class="primary" id="exDl">Descargar</button><button type="button" id="exSv" title="Guarda el archivo en la carpeta export/ de los datos de MuebleCAD">Guardar en export/</button><button type="button" id="exClose">Cerrar</button></div>
    <div class="exh">Vistas guardadas</div><div class="exviews" id="exViews"></div>
    <div class="exsave"><input id="exViewName" placeholder="Nombre de la vista (cámara 3D con capas, o encuadre del dibujo 2D)" /><button type="button" id="exSaveView">Guardar vista actual</button></div>
  </form>`;
  document.body.append(dlg);
  const $ = <T extends HTMLElement>(q: string): T => dlg.querySelector(q) as T;
  const field = (k: string): HTMLInputElement | HTMLSelectElement => $(`[data-k="${k}"]`);
  const msg = (t: string, err = false): void => { const m = $('#exMsg'); m.textContent = t; m.className = `exmsg${err ? ' err' : ''}`; };

  /** Pasa del formulario a `o` (solo las claves presentes). */
  function readForm(): void {
    for (const el of Array.from(dlg.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]'))) {
      const k = el.dataset.k as keyof ExportOpts;
      const cur = o[k];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') (o as unknown as Record<string, unknown>)[k] = el.checked;
      else if (typeof cur === 'number') (o as unknown as Record<string, unknown>)[k] = Number(el.value) || 0;
      else (o as unknown as Record<string, unknown>)[k] = el.value;
    }
    o.parts = Array.from(dlg.querySelectorAll<HTMLInputElement>('[data-part]')).filter((c) => c.checked).map((c) => c.dataset.part as SheetPart);
  }
  function writeForm(): void {
    for (const el of Array.from(dlg.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]'))) {
      const v = o[el.dataset.k as keyof ExportOpts];
      if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v; else el.value = String(v ?? '');
    }
    for (const c of Array.from(dlg.querySelectorAll<HTMLInputElement>('[data-part]'))) c.checked = o.parts.includes(c.dataset.part as SheetPart);
  }
  /** Muestra solo los campos que valen para el origen y formato elegidos. */
  function refresh(): void {
    readForm();
    const formats = FORMATS_BY_SOURCE[o.source];
    if (!formats.includes(o.format)) o.format = formats[0];
    const fsel = field('format') as HTMLSelectElement;
    fsel.innerHTML = formats.map((f) => `<option value="${f}">${f.toUpperCase()}</option>`).join('');
    fsel.value = o.format;
    for (const el of Array.from(dlg.querySelectorAll<HTMLElement>('[data-src],[data-fmt],[data-when]'))) {
      const src = el.dataset.src, fmt = el.dataset.fmt, when = el.dataset.when;
      let ok = (!src || src.split(',').includes(o.source)) && (!fmt || fmt.split(',').includes(o.format));
      if (ok && when) { const [k, v] = when.split('='); ok = String(o[k as keyof ExportOpts]) === v; }
      el.hidden = !ok;
    }
    // la perspectiva y las vistas del 3D en la lámina solo cuentan si lleva la vista 3D
    for (const el of Array.from(dlg.querySelectorAll<HTMLElement>('[data-src="3d,sheet"]'))) if (o.source === 'sheet' && !o.parts.includes('3d') && el.tagName !== 'DIV') el.hidden = true;
    const transp = field('bg').querySelector<HTMLOptionElement>('option[value="transparent"]')!;
    transp.disabled = o.format !== 'png';
    if (o.format !== 'png' && o.bg === 'transparent') { o.bg = 'white'; field('bg').value = 'white'; }
    const pdfScale = $('[data-k="scale"]').closest('label')!;
    pdfScale.hidden = !(o.source === '2d' ? o.format === 'pdf' : o.source === 'sheet');
    $('#exSv').toggleAttribute('disabled', false);
  }

  async function produce(): Promise<ExportResult> {
    readForm();
    msg('Generando…');
    try { last = await buildExport(env, o); msg(`${last.name}: ${last.info}`); return last; } catch (e) { msg((e as Error).message, true); throw e; }
  }
  $('#exDl').onclick = async () => { try { const r = await produce(); download(r.name, r.data, r.mime); } catch { /* ya se mostró */ } };
  $('#exSv').onclick = async () => {
    try {
      const r = await produce();
      const res = await fetch(`/api/export-file?name=${encodeURIComponent(r.name)}`, { method: 'POST', body: r.data });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? 'No se pudo guardar.');
      msg(`Guardado en ${j.file} (${Math.round(j.bytes / 1024)} KB). ${r.info}`);
    } catch (e) { msg((e as Error).message, true); }
  };
  $('#exClose').onclick = () => dlg.close();
  dlg.addEventListener('change', refresh);
  dlg.addEventListener('input', (e) => { if ((e.target as HTMLElement).dataset?.k === 'cw' || (e.target as HTMLElement).dataset?.k === 'ch') readForm(); });

  // ---------------------------------------------------------------- vistas guardadas

  function currentView(name: string): SavedView {
    const p = ctx.project();
    const id = nextViewId(p);
    if (ctx.drawings.is2D()) {
      const d = ctx.drawings.realDrawing();
      if (!d) throw new Error('No hay un dibujo 2D activo: crea uno o pasa a 3D para guardar la cámara.');
      const v = ctx.drawings.view.currentView;
      return { id, name, kind: '2d', drawing: d.id, view: { cx: v.cx, cy: v.cy, scale: v.scale } };
    }
    const cam = ctx.viewer.getCamera();
    return { id, name, kind: '3d', camera: { ...cam, ortho: o.proj === 'ortho' }, ...(ctx.hiddenLayers.size ? { hiddenLayers: [...ctx.hiddenLayers] } : {}) };
  }
  function restore(v: SavedView): void {
    if (v.kind === '3d') {
      ctx.drawings.setMode('3d');
      ctx.setTab('d3');
      ctx.hiddenLayers.clear();
      for (const l of v.hiddenLayers ?? []) ctx.hiddenLayers.add(l);
      ctx.render();
      ctx.viewer.setCamera(v.camera.position, v.camera.target);
      return;
    }
    const d = ctx.project().drawings?.find((x) => x.id === v.drawing);
    if (!d) throw new Error(`El dibujo "${v.drawing}" de esta vista ya no existe.`);
    ctx.drawings.setMode('2d');
    const s = document.querySelector<HTMLSelectElement>('#d2Sel');
    if (s && s.value !== d.id) { s.value = d.id; s.dispatchEvent(new Event('change')); }
    requestAnimationFrame(() => ctx.drawings.view.setFrame(v.view));
  }
  function paintViews(): void {
    const list = ctx.project().views ?? [];
    $('#exViews').innerHTML = list.length
      ? list.map((v) => `<div class="exview" data-id="${esc(v.id)}"><b>${esc(v.name)}</b><small>${v.kind === '3d' ? '3D' : '2D'}</small><button type="button" data-act="restore">Restaurar</button><button type="button" data-act="export" title="Restaura la vista y exporta con las opciones de arriba">Exportar</button><button type="button" data-act="del" class="danger">✕</button></div>`).join('')
      : '<small style="color:var(--muted)">Aún no hay vistas guardadas.</small>';
  }
  $('#exSaveView').onclick = async () => {
    const input = $<HTMLInputElement>('#exViewName');
    const name = input.value.trim();
    if (!name) { msg('Escribe un nombre para la vista.', true); return; }
    try {
      const v = currentView(name);
      const bad = validateView(v);
      if (bad) throw new Error(bad);
      const dup = findView(ctx.project(), name);
      if (dup) v.id = dup.id; // mismo nombre = reemplaza
      await ctx.commit(() => { const p = ctx.project(); p.views = withView(p, v).views; });
      input.value = '';
      paintViews();
      msg(`Vista «${name}» guardada.`);
    } catch (e) { msg((e as Error).message, true); }
  };
  $('#exViews').addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
    if (!btn) return;
    const id = btn.closest<HTMLElement>('[data-id]')!.dataset.id!;
    const v = (ctx.project().views ?? []).find((x) => x.id === id);
    if (!v) return;
    try {
      if (btn.dataset.act === 'del') { await ctx.commit(() => { const p = ctx.project(); p.views = withoutView(p, id).views; }); paintViews(); return; }
      restore(v);
      if (btn.dataset.act === 'export') {
        o.source = v.kind === '3d' ? '3d' : '2d';
        if (v.kind === '3d') o.view = 'current';
        if (v.kind === '2d') o.area = 'window';
        writeForm();
        refresh();
        await new Promise((r) => setTimeout(r, 60)); // deja que la vista restaurada se pinte
        $<HTMLButtonElement>('#exDl').click();
      } else msg(`Vista «${v.name}» restaurada.`);
    } catch (err) { msg((err as Error).message, true); }
  });

  function open(): void {
    const p = ctx.project();
    o.source = ctx.drawings.is2D() ? '2d' : ctx.tab() === 'plans' ? 'sheet' : '3d';
    if (!o.titulo) o.titulo = '';
    void p;
    writeForm();
    refresh();
    paintViews();
    msg('');
    if (!dlg.open) dlg.showModal();
  }

  // ---------------------------------------------------------------- pedidos del agente

  let busy = false;
  async function processOrders(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const items: { id: string; status: string; request: OrderRequest }[] = (await (await fetch('/api/export-orders')).json()).items ?? [];
      for (const it of items.filter((x) => x.status === 'pending')) {
        const claim = await (await fetch(`/api/export-orders/claim?id=${encodeURIComponent(it.id)}`, { method: 'POST' })).json();
        if (!claim.ok) continue;
        try {
          const { opts, saved } = orderToOpts(it.request);
          let restoreBack: (() => void) | null = null;
          if (saved) {
            const v = findView(ctx.project(), saved);
            if (!v) throw new Error(`No existe la vista guardada "${saved}".`);
            if (v.kind === '2d') opts.source = '2d';
            restoreBack = () => restore(v);
          }
          restoreBack?.();
          await new Promise((r) => setTimeout(r, 80));
          const r = await buildExport(env, { ...opts, view: saved ? 'current' : opts.view });
          const name = it.request.name ? `${it.request.name.replace(/[\\/:*?"<>|]/g, '_')}.${opts.format}` : r.name;
          await fetch(`/api/export-file?name=${encodeURIComponent(name)}&order=${encodeURIComponent(it.id)}`, { method: 'POST', body: r.data });
          ctx.toast(`Vista exportada por el agente: export/${name}`, 5000);
        } catch (e) {
          await fetch(`/api/export-orders/fail?id=${encodeURIComponent(it.id)}`, { method: 'POST', body: (e as Error).message });
        }
      }
    } catch { /* sin servidor o sin pedidos */ } finally { busy = false; }
  }
  if (typeof EventSource !== 'undefined') new EventSource('/api/events').onmessage = () => { void processOrders(); };
  setTimeout(() => void processOrders(), 1500);

  return { open };
}
