import {
  addEntities, copyEntities, createDrawing, DrawingError, findDrawing, nextDrawingId, removeEntity, validateDrawing, withDrawing, withoutDrawing,
  type EntityInput,
} from '../core/drawing';
import { PLANE_BASIS } from '../core/drawingPlane';
import { applyBlockDrawing, blockDrawing } from '../core/blockOps';
import { blockCtx, findBlock } from '../core/blocks';
import { syncHatches } from '../core/hatch';
import { entitiesBounds } from '../core/geom2d';
import type { Drawing, DrawingPlane, Entity, Project, Vec3 } from '../core/types';
import { cleanMm, fmtMm } from '../core/units';
import { blockEntityChanges, changeText, diffDrawings, entityWorldBox } from './drawingDiff';
import { formDialog } from './drawingDialogs';
import { buildExtrusions, isExtrudable } from './drawingExtrude';
import { drawingLineSets } from './drawing3d';
import type { DrawingIoHandlers, DrawingPreview, DrawingToolApi, DrawingToolController } from './drawingHooks';
import { esc } from './drawingRender';
import { setupEntityTable } from './drawingTable';
import { DrawingView, type FlashEntity } from './drawingView';
import { setupLayersPanel } from './layersPanel';
import type { FlashItem, Viewer } from './viewer';
import './drawing.css';

export interface DrawingsCtx {
  project(): Project;
  /** commit de main.ts: guarda un punto de deshacer, aplica el cambio y lo guarda (respeta el rev y el 409). */
  commit(change: () => void): Promise<void>;
  toast(text: string, ms?: number): void;
  viewer: Viewer;
  /** Contenedor vacío (#draw2d) donde se construye la interfaz 2D; su padre (#view) recibe la clase `mode2d`. */
  host: HTMLElement;
  /** Deja elegido un mueble (grupo de piezas) en el 3D, p. ej. el sólido recién extruido. */
  selectGroup?(group: string): void;
}

export interface DrawingsUi {
  /** Vuelve a pintar todo desde el proyecto (llamar al final de render() de main.ts). */
  refresh(): void;
  /** Compara dos versiones del proyecto: resalta lo que cambió en los dibujos (2D y 3D) y devuelve las cajas 3D y un texto para el indicador del agente. */
  changes(old: Project, cur: Project): { items: FlashItem[]; text: string };
  is2D(): boolean;
  setMode(mode: '2d' | '3d'): void;
  /** Lo que ve el lienzo: el bloque en edición como dibujo, o el dibujo. Para exportar o imprimir usa `realDrawing`. */
  activeDrawing(): Drawing | null;
  /** El dibujo real del proyecto (nunca el bloque en edición): lo que se exporta, imprime o guarda en una vista. */
  realDrawing(): Drawing | null;
  /** GANCHO herramientas de ratón: agrega un botón a la barra 2D y conecta su controlador al lienzo. */
  registerTool(ctrl: DrawingToolController): void;
  /** GANCHO importar / exportar DXF y PDF: mientras no haya manejador, el botón está deshabilitado. */
  setIoHandlers(h: DrawingIoHandlers): void;
  /** Capa activa del dibujo (donde van las entidades nuevas). */
  activeLayer(): string;
  /** Activa una herramienta registrada por su id (null = Seleccionar). */
  setTool(id: string | null): void;
  /** Teclado de las herramientas de ratón: se consulta primero (en 2D, sin diálogos abiertos); si devuelve true la tecla se consume. */
  setKeyHook(h: (e: KeyboardEvent) => boolean): void;
  /** Agrega un dibujo ya armado (p. ej. importado de DXF) en un solo paso de deshacer y lo deja activo. */
  addDrawing(d: Drawing): Promise<void>;
  /** Todos los dibujos del proyecto actual. */
  drawings(): Drawing[];
  /** Modo edición de bloque: el lienzo, la tabla, las capas y las herramientas trabajan sobre las entidades del bloque (con sus coordenadas locales) y cada cambio actualiza todas las instancias. null = volver al dibujo. */
  editBlock(name: string | null): void;
  editingBlock(): string | null;
  /** Edición pura sobre el dibujo REAL (también mientras se edita un bloque), un solo paso de deshacer. Devuelve false (ya avisó del error) si falló. */
  editDrawing(op: (d: Drawing) => Drawing): boolean;
  /** Se llama al final de cada refresh() en modo 2D (para paneles que dependen del dibujo). */
  onRefresh(cb: () => void): void;
  readonly view: DrawingView;
}

const MODE_KEY = 'mueblecad.modo2d', ACTIVE_KEY = 'mueblecad.dibujoActivo';
const PLANE_LABEL: Record<DrawingPlane, string> = { xy: 'XY · alzado frontal', xz: 'XZ · planta', yz: 'YZ · alzado lateral' };
const NORMAL_TEXT: Record<DrawingPlane, string> = { xy: '+Z (hacia el frente)', xz: '+Y (hacia arriba)', yz: '+X (hacia la derecha)' };

const ls = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

export function setupDrawings(ctx: DrawingsCtx): DrawingsUi {
  const host = ctx.host;
  const viewEl = host.parentElement as HTMLElement;
  host.innerHTML = `
    <div class="d2-top">
      <select id="d2Sel" title="Dibujo activo"></select>
      <button id="d2New" title="Crear un dibujo nuevo">Nuevo</button>
      <button id="d2Ren" title="Cambiar el nombre del dibujo">Renombrar</button>
      <button id="d2Del" class="danger" title="Borrar el dibujo con todas sus entidades (se puede deshacer)">Borrar</button>
      <span class="sep"></span>
      <label class="inl" title="Plano del 3D donde vive el dibujo">Plano <select id="d2Plane">${(Object.keys(PLANE_LABEL) as DrawingPlane[]).map((p) => `<option value="${p}">${PLANE_LABEL[p]}</option>`).join('')}</select></label>
      <label class="inl" title="Punto 3D (mm) del mundo donde está el (0,0) del dibujo">Origen <input id="d2Ox" type="number" step="any" /><input id="d2Oy" type="number" step="any" /><input id="d2Oz" type="number" step="any" /></label>
      <label class="inl check"><input id="d2Vis" type="checkbox" /> Ver en 3D</label>
      <span class="sep"></span>
      <div class="d2-tools" id="d2Tools"><button data-tool="" class="on" title="Seleccionar y mover la vista">Seleccionar</button></div>
      <button id="d2Fit" title="Encuadrar todo el dibujo en la ventana">Ajustar</button>
      <span class="spacer"></span>
      <div class="d2-io" title="Importar y exportar (se conectan con setIoHandlers)">
        <button id="d2ImpDxf" disabled title="Importar DXF: próximamente">Importar DXF</button><button id="d2ExpDxf" disabled title="Exportar DXF: próximamente">Exportar DXF</button>
        <button id="d2ExpPdf" disabled title="Exportar PDF: próximamente">Exportar PDF</button>
        <input id="d2File" type="file" hidden />
      </div>
      <button id="d2Extrude" class="primary" title="Convierte polilíneas cerradas, rectángulos y círculos en sólidos 3D (el dibujo se conserva)">Extruir…</button>
    </div>
    <div class="d2-body">
      <div class="d2-stage" id="d2Stage"><div class="d2-empty" id="d2Empty" style="display:none">Este proyecto no tiene dibujos 2D.<br /><button id="d2EmptyNew" class="primary">Crear un dibujo</button></div></div>
      <div class="d2-dock">
        <div class="d2-tabs"><button data-dock="ents" class="active">Entidades</button><button data-dock="layers">Capas</button></div>
        <div id="d2Ents" class="d2-pane"></div><div id="d2Layers" class="d2-pane" style="display:none"></div>
      </div>
    </div>`;
  const $ = <T extends HTMLElement>(id: string) => host.querySelector<T>(`#${id}`)!;

  let mode: '2d' | '3d' = ls.get(MODE_KEY) === '2d' ? '2d' : '3d';
  let activeId: string | null = ls.get(ACTIVE_KEY);
  let activeLayer = '0';
  let sel = new Set<string>();
  let io: DrawingIoHandlers = {};
  const tools = new Map<string, DrawingToolController>();
  let activeTool: string | null = null;
  let lastSig = '';
  let ioFile: ((f: File) => void) | null = null;
  let keyHook: (e: KeyboardEvent) => boolean = () => false;
  let blockEditing: string | null = null;
  const refreshCbs: (() => void)[] = [];
  let blockView: { real: Drawing; name: string; d: Drawing } | null = null;

  const view = new DrawingView($('d2Stage'));
  const project = () => ctx.project();
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  /** Dibujo real del proyecto que se está mostrando. */
  const realActive = (): Drawing | null => {
    const list = project().drawings ?? [];
    return list.find((d) => d.id === activeId) ?? list[0] ?? null;
  };
  /** Lo que ven el lienzo, la tabla y las herramientas: el dibujo, o el bloque en edición como un dibujo (mismas capas, entidades locales). */
  const active = (): Drawing | null => {
    const real = realActive();
    if (!real || !blockEditing) return real;
    if (!findBlock(real, blockEditing)) { blockEditing = null; return real; }
    if (!blockView || blockView.real !== real || blockView.name !== blockEditing) blockView = { real, name: blockEditing, d: blockDrawing(real, blockEditing) };
    return blockView.d;
  };

  // --- escritura en el proyecto -------------------------------------------------

  /** Reemplaza `project.drawings` por el de `next` (sin dejar la clave si quedó vacía, como antes de existir los dibujos). */
  const store = (next: Project) => { const p = project(); if (next.drawings) p.drawings = next.drawings; else delete p.drawings; };

  /**
   * Aplica una edición pura al dibujo activo. Primero se prueba (si falla, se avisa y no se guarda nada) y luego se aplica con `commit`,
   * que vuelve a ejecutar la operación sobre la versión nueva del dibujo si el agente guardó antes (409).
   */
  function edit(op: (d: Drawing) => Drawing, onReal = false): boolean {
    const d = realActive();
    if (!d) return false;
    const id = d.id, blk = onReal ? null : blockEditing;
    const run = (cur: Drawing): Drawing => {
      // en edición de bloque la operación se aplica al bloque como dibujo y se escribe de vuelta; si no, los sombreados asociativos se recalculan
      const next = blk ? applyBlockDrawing(cur, blk, op(blockDrawing(cur, blk))) : syncHatches(cur, op(cur));
      const msg = validateDrawing(next);
      if (msg) throw new DrawingError(msg);
      return next;
    };
    try { run(d); } catch (e) { ctx.toast(message(e), 6000); return false; }
    void ctx.commit(() => {
      const cur = findDrawing(project(), id);
      if (!cur) return;
      try { store(withDrawing(project(), run(cur))); } catch (e) { ctx.toast(message(e), 6000); }
    });
    return true;
  }

  function add(inputs: EntityInput[]): boolean {
    let ids: string[] = [];
    const ok = edit((d) => { const r = addEntities(d, inputs); ids = r.ids; return r.drawing; });
    if (ok) select(ids, 'set');
    return ok;
  }

  // --- selección -----------------------------------------------------------------

  function select(ids: string[], how: 'set' | 'toggle' | 'add', fromCanvas = false): void {
    if (how === 'set') sel = new Set(ids);
    else if (how === 'add') ids.forEach((i) => sel.add(i));
    else for (const i of ids) sel.has(i) ? sel.delete(i) : sel.add(i);
    view.setSelection(sel);
    table.render();
    if (fromCanvas) table.scrollToSelection();
  }
  view.onSelect = (ids, how) => select(ids, how, true);

  const selected = (d: Drawing | null): Entity[] => (d ? d.entities.filter((e) => sel.has(e.id)) : []);

  // --- panel de entidades y de capas ---------------------------------------------

  const table = setupEntityTable($('d2Ents'), {
    drawing: active, edit, add,
    selection: () => sel,
    select: (ids, additive) => select(ids, additive ? 'toggle' : 'set'),
    activeLayer: () => activeLayer, setActiveLayer: (n) => { activeLayer = n; },
    toast: (m) => ctx.toast(m, 6000),
  });
  const layers = setupLayersPanel($('d2Layers'), {
    drawing: active, edit, activeLayer: () => activeLayer, setActiveLayer: (n) => { activeLayer = n; }, toast: (m) => ctx.toast(m, 6000),
  });
  host.querySelectorAll<HTMLButtonElement>('[data-dock]').forEach((b) => (b.onclick = () => {
    host.querySelectorAll<HTMLButtonElement>('[data-dock]').forEach((x) => x.classList.toggle('active', x === b));
    $('d2Ents').style.display = b.dataset.dock === 'ents' ? '' : 'none';
    $('d2Layers').style.display = b.dataset.dock === 'layers' ? '' : 'none';
  }));

  // --- herramientas de ratón (gancho) ---------------------------------------------

  const api: DrawingToolApi = {
    get drawing() { return active()!; },
    setPreview: (p: DrawingPreview | null) => view.setPreview(p),
    add: (inputs) => { let ids: string[] = []; edit((d) => { const r = addEntities(d, inputs); ids = r.ids; return r.drawing; }); select(ids, 'set'); return ids; },
    edit: (op) => { edit(op); },
    select: (ids) => select(ids, 'set'),
    selection: () => [...sel],
    hint: (t) => view.setHint(t),
    done: () => setTool(null),
  };
  function setTool(id: string | null): void {
    activeTool = id && tools.has(id) ? id : null;
    view.setTool(activeTool ? tools.get(activeTool)! : null, api);
    view.setHint(null);
    host.querySelectorAll<HTMLButtonElement>('#d2Tools [data-tool]').forEach((b) => b.classList.toggle('on', (b.dataset.tool || null) === activeTool));
  }
  function paintTools(): void {
    $('d2Tools').innerHTML = `<button data-tool="" class="${activeTool === null ? 'on' : ''}" title="Seleccionar y mover la vista">Seleccionar</button>` +
      [...tools.values()].map((t) => `<button data-tool="${esc(t.id)}" class="${t.id === activeTool ? 'on' : ''}" title="${esc(t.title ?? t.label)}">${esc(t.label)}</button>`).join('');
  }
  $('d2Tools').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tool]');
    if (b) setTool(b.dataset.tool || null);
  });

  // --- barra superior ----------------------------------------------------------------

  async function newDrawing(): Promise<void> {
    const list = project().drawings ?? [];
    const v = await formDialog('Nuevo dibujo', [
      { key: 'name', label: 'Nombre', type: 'text', value: `Dibujo ${list.length + 1}`, wide: true },
      { key: 'plane', label: 'Plano', type: 'select', value: 'xz', options: (Object.keys(PLANE_LABEL) as DrawingPlane[]).map((p) => [p, PLANE_LABEL[p]]) },
      { key: 'ox', label: 'Origen X (mm)', type: 'number', value: 0 }, { key: 'oy', label: 'Origen Y (mm)', type: 'number', value: 0 }, { key: 'oz', label: 'Origen Z (mm)', type: 'number', value: 0 },
    ], {
      ok: 'Crear', note: 'El plano decide dónde queda el dibujo en el 3D; el origen es el punto del mundo donde está su (0,0).',
      check: (x) => { try { createDrawing(x.name, { plane: x.plane as DrawingPlane, origin: [Number(x.ox) || 0, Number(x.oy) || 0, Number(x.oz) || 0] }); return null; } catch (e) { return message(e); } },
    });
    if (!v) return;
    let newId = '';
    void ctx.commit(() => {
      const d = createDrawing(v.name, { id: nextDrawingId(project()), plane: v.plane as DrawingPlane, origin: [Number(v.ox) || 0, Number(v.oy) || 0, Number(v.oz) || 0] });
      store(withDrawing(project(), d));
      newId = d.id;
    });
    activeId = newId; sel = new Set(); activeLayer = '0';
    ls.set(ACTIVE_KEY, newId);
  }

  async function renameDrawing(): Promise<void> {
    const d = active();
    if (!d) return;
    const v = await formDialog('Renombrar dibujo', [{ key: 'name', label: 'Nombre', type: 'text', value: d.name, wide: true }], { check: (x) => (x.name.trim() ? null : 'El nombre no puede estar vacío.') });
    if (v) edit((cur) => ({ ...cur, name: v.name.trim() }));
  }

  function deleteDrawing(): void {
    const d = active();
    if (!d || !confirm(`¿Borrar el dibujo "${d.name}" con sus ${d.entities.length} entidades? (Se puede deshacer con Ctrl+Z)`)) return;
    void ctx.commit(() => { if (findDrawing(project(), d.id)) store(withoutDrawing(project(), d.id)); });
    activeId = null; sel = new Set();
  }

  $('d2Sel').onchange = () => { blockEditing = null; activeId = $<HTMLSelectElement>('d2Sel').value; ls.set(ACTIVE_KEY, activeId); sel = new Set(); activeLayer = '0'; refresh(); };
  $('d2New').onclick = () => void newDrawing();
  $('d2EmptyNew').onclick = () => void newDrawing();
  $('d2Ren').onclick = () => void renameDrawing();
  $('d2Del').onclick = deleteDrawing;
  $('d2Fit').onclick = () => view.fit(sel.size ? sel : undefined);
  $('d2Plane').onchange = () => { const p = $<HTMLSelectElement>('d2Plane').value as DrawingPlane; edit((d) => ({ ...d, plane: p })); };
  for (const k of ['d2Ox', 'd2Oy', 'd2Oz']) {
    $(k).onchange = () => {
      const o: Vec3 = ['d2Ox', 'd2Oy', 'd2Oz'].map((id) => Number($<HTMLInputElement>(id).value) || 0) as Vec3;
      edit((d) => ({ ...d, origin: o }));
    };
  }
  $('d2Vis').onchange = () => {
    const on = $<HTMLInputElement>('d2Vis').checked;
    edit((d) => { const { visible: _v, ...rest } = d; return on ? rest : { ...rest, visible: false }; });
  };

  // --- importar / exportar (ganchos) --------------------------------------------------

  const ioButtons: [string, keyof DrawingIoHandlers, string][] = [['d2ImpDxf', 'importDxf', 'Importar DXF'], ['d2ExpDxf', 'exportDxf', 'Exportar DXF'], ['d2ExpPdf', 'exportPdf', 'Exportar PDF']];
  function paintIo(): void {
    for (const [id, key, label] of ioButtons) {
      const b = $<HTMLButtonElement>(id);
      const has = !!io[key];
      b.disabled = !has || (key.startsWith('export') && !active());
      b.title = has ? label : `${label}: próximamente`;
    }
  }
  for (const [id, key] of ioButtons) {
    $(id).onclick = async () => {
      const h = io[key];
      if (!h) return;
      try {
        if (key === 'exportDxf' || key === 'exportPdf') { const d = realActive(); if (d) await (h as (d: Drawing) => unknown)(d); return; }
        const input = $<HTMLInputElement>('d2File');
        input.accept = '.dxf';
        ioFile = (f) => { void Promise.resolve((h as (f: File) => unknown)(f)).catch((e) => ctx.toast(message(e), 6000)); };
        input.value = '';
        input.click();
      } catch (e) { ctx.toast(message(e), 6000); }
    };
  }
  $<HTMLInputElement>('d2File').onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f && ioFile) ioFile(f); };

  // --- extruir ------------------------------------------------------------------------

  async function extrude(): Promise<void> {
    const d = active();
    if (!d) return;
    const proj = project();
    const mats = proj.materials.filter((m) => !m.purchased);
    if (!mats.length) return ctx.toast('No hay materiales para cortar; agrega uno en «Materiales».', 5000);
    const chosen = selected(d);
    const closedSel = chosen.filter(isExtrudable);
    const closedAll = d.entities.filter(isExtrudable).length;
    const defMat = mats.find((m) => m.id === 'mel18') ?? mats[0];
    const v = await formDialog('Extruir a sólido', [
      { key: 'scope', label: 'Qué extruir', type: 'select', value: chosen.length ? 'sel' : 'all', wide: true,
        options: [['sel', `Entidades seleccionadas (${chosen.length}${chosen.length - closedSel.length ? `, ${chosen.length - closedSel.length} no se pueden extruir` : ''})`], ['all', `Todas las cerradas del dibujo (${closedAll})`]] },
      { key: 'name', label: 'Nombre del mueble', type: 'text', value: d.name, wide: true },
      { key: 'depth', label: 'Espesor (mm)', type: 'number', value: defMat.thickness, note: `Negativo extruye hacia el otro lado. Positivo va hacia ${NORMAL_TEXT[d.plane]}.` },
      { key: 'mat', label: 'Material', type: 'select', value: defMat.id, options: mats.map((m) => [m.id, m.name]) },
    ], {
      ok: 'Crear sólido', note: 'Crea una pieza sólida por cada polilínea cerrada, rectángulo o círculo. El dibujo no se borra.',
      onChange: (k, vals, set) => { if (k === 'mat') { const m = mats.find((x) => x.id === vals.mat); if (m) set('depth', String(m.thickness)); } },
      check: (x) => {
        const depth = Number(x.depth);
        if (!Number.isFinite(depth) || depth === 0) return 'El espesor debe ser un número distinto de 0.';
        try { buildExtrusions(proj, d, { name: x.name, depth, material: x.mat, ids: x.scope === 'sel' ? [...sel] : null }); return null; } catch (e) { return message(e); }
      },
    });
    if (!v) return;
    const req = { name: v.name, depth: Number(v.depth), material: v.mat, ids: v.scope === 'sel' ? [...sel] : null };
    let group = '', n = 0;
    void ctx.commit(() => {
      const cur = findDrawing(project(), d.id);
      if (!cur) return;
      try {
        const r = buildExtrusions(project(), cur, req);
        project().parts.push(...r.parts);
        group = r.group; n = r.parts.length;
      } catch (e) { ctx.toast(message(e), 6000); }
    });
    if (group) {
      ctx.selectGroup?.(group);
      setMode('3d');
      ctx.toast(`Sólido «${group}» creado (${n} pieza${n > 1 ? 's' : ''}). El dibujo se conserva.`, 5000);
    }
  }
  $('d2Extrude').onclick = () => void extrude();

  // --- modo 2D / 3D -----------------------------------------------------------------------

  function setMode(m: '2d' | '3d'): void {
    mode = m;
    ls.set(MODE_KEY, m);
    viewEl.classList.toggle('mode2d', m === '2d');
    document.querySelectorAll<HTMLButtonElement>('[data-dim]').forEach((b) => b.classList.toggle('active', b.dataset.dim === m));
    if (m === '2d') document.querySelector<HTMLButtonElement>('[data-tab="d3"]')?.click(); // las demás pestañas tapan el lienzo
    refresh();
    requestAnimationFrame(() => { view.resize(); window.dispatchEvent(new Event('resize')); });
  }
  document.querySelectorAll<HTMLButtonElement>('[data-dim]').forEach((b) => (b.onclick = () => setMode(b.dataset.dim as '2d' | '3d')));

  // --- teclado (solo en 2D) -----------------------------------------------------------------

  window.addEventListener('keydown', (e) => {
    if (mode !== '2d' || document.querySelector('dialog[open]')) return;
    const t = e.target;
    const typing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
    const mod = e.ctrlKey || e.metaKey;
    const eat = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (keyHook(e)) return eat();
    if (!typing && view.keyToTool(e)) return eat();
    if (e.key === 'Escape') {
      if (activeTool) setTool(null); else if (sel.size) select([], 'set');
      return eat();
    }
    if (typing) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { const ids = [...sel]; if (edit((d) => removeEntity(d, ids))) select([], 'set'); return eat(); }
    if (mod && e.key.toLowerCase() === 'd' && sel.size) {
      const ids = [...sel]; let made: string[] = [];
      if (edit((d) => { const r = copyEntities(d, ids, [100, 100]); made = r.ids; return r.drawing; })) select(made, 'set');
      return eat();
    }
    if (mod && e.key.toLowerCase() === 'a') { const d = active(); if (d) select(d.entities.map((x) => x.id), 'set'); return eat(); }
  }, true);

  // --- refresco desde el proyecto -----------------------------------------------------------

  function refresh(): void {
    const proj = project();
    const list = proj.drawings ?? [];
    const d = active(), real = realActive();
    if (d) { activeId = real!.id; if (!d.layers.some((l) => l.name === activeLayer)) activeLayer = '0'; }
    // 3D: líneas de los dibujos visibles (solo si cambiaron)
    const sig = JSON.stringify(proj.drawings ?? null);
    if (sig !== lastSig) { lastSig = sig; ctx.viewer.setDrawingLines(drawingLineSets(proj)); }
    paintIo();
    if (mode !== '2d') return;
    // selección: se descartan ids que ya no existen
    if (d) sel = new Set([...sel].filter((id) => d.entities.some((e) => e.id === id)));
    else sel = new Set();
    $<HTMLSelectElement>('d2Sel').innerHTML = list.map((x) => `<option value="${esc(x.id)}" ${x.id === real?.id ? 'selected' : ''}>${esc(x.name)} (${x.entities.length})</option>`).join('') || '<option>(sin dibujos)</option>';
    for (const id of ['d2Ren', 'd2Del', 'd2Plane', 'd2Ox', 'd2Oy', 'd2Oz', 'd2Vis', 'd2Extrude']) $<HTMLButtonElement>(id).disabled = !d || !!blockEditing; // no aplican al editar un bloque
    $<HTMLButtonElement>('d2Fit').disabled = !d;
    if (d) {
      $<HTMLSelectElement>('d2Plane').value = d.plane;
      ['d2Ox', 'd2Oy', 'd2Oz'].forEach((id, i) => { const el = $<HTMLInputElement>(id); if (document.activeElement !== el) el.value = String(cleanMm(d.origin[i])); });
      $<HTMLInputElement>('d2Vis').checked = d.visible !== false;
      $('d2Stage').title = `${d.name}: ${PLANE_LABEL[d.plane]} · origen ${d.origin.map((v) => fmtMm(v)).join(', ')} mm`;
    }
    $('d2Empty').style.display = d ? 'none' : 'flex';
    view.setDrawing(d);
    view.setSelection(sel);
    table.render();
    layers.render();
    refreshCbs.forEach((cb) => cb());
  }

  // --- cambios del agente ----------------------------------------------------------------------

  function changes(old: Project, cur: Project): { items: FlashItem[]; text: string } {
    const diff = diffDrawings(old, cur);
    const items: FlashItem[] = [];
    for (const c of diff) {
      const dNew = (cur.drawings ?? []).find((x) => x.id === c.drawingId);
      const dOld = (old.drawings ?? []).find((x) => x.id === c.drawingId);
      if (c.drawing) {
        const d = (c.drawing === 'new' ? dNew : dOld)!;
        const b = entitiesBounds(d.entities, blockCtx(d)), box = b && entityWorldBox(d, { id: 'x', layer: '0', type: 'line', a: b.min, b: b.max });
        if (box) items.push({ ...box, kind: c.drawing === 'new' ? 'new' : 'del' });
        if (c.drawing === 'new' && mode === '2d') { activeId = c.drawingId; sel = new Set(); }
        continue;
      }
      if (!dNew) continue;
      for (const e of c.added) { const b = entityWorldBox(dNew, e); if (b) items.push({ ...b, kind: 'new' }); }
      for (const e of c.changed) { const b = entityWorldBox(dNew, e); if (b) items.push({ ...b, kind: 'edit' }); }
      for (const e of c.removed) { const b = entityWorldBox(dOld ?? dNew, e); if (b) items.push({ ...b, kind: 'del' }); }
      if (c.moved) { const b = entitiesBounds(dNew.entities, blockCtx(dNew)), box = b && entityWorldBox(dNew, { id: 'x', layer: '0', type: 'line', a: b.min, b: b.max }); if (box) items.push({ ...box, kind: 'edit' }); }
      if (blockEditing && dNew.id === realActive()?.id) {
        // edición de bloque: el lienzo muestra la definición, así que se resaltan sus entidades (coordenadas locales), no el insert del dibujo
        const bc = blockEntityChanges(old, cur, dNew.id, blockEditing);
        if (bc?.change) view.flash([...bc.change.added.map((entity) => ({ entity, kind: 'new' as const })), ...bc.change.changed.map((entity) => ({ entity, kind: 'edit' as const })), ...bc.change.removed.map((entity) => ({ entity, kind: 'del' as const }))], bc.drawing);
      } else if (dNew.id === active()?.id) {
        const fl: FlashEntity[] = [...c.added.map((entity) => ({ entity, kind: 'new' as const })), ...c.changed.map((entity) => ({ entity, kind: 'edit' as const })), ...c.removed.map((entity) => ({ entity, kind: 'del' as const }))];
        view.flash(fl, dNew);
      }
    }
    return { items: items.slice(0, 400), text: changeText(diff) };
  }

  setMode(mode);
  return {
    refresh, changes, is2D: () => mode === '2d', setMode, activeDrawing: active, realDrawing: realActive, view,
    registerTool(ctrl) { tools.set(ctrl.id, ctrl); paintTools(); },
    setIoHandlers(h) { io = { ...io, ...h }; paintIo(); },
    activeLayer: () => activeLayer,
    setTool,
    setKeyHook(h) { keyHook = h; },
    drawings: () => project().drawings ?? [],
    editBlock(name) {
      const real = realActive();
      if (name !== null && (!real || !findBlock(real, name))) { ctx.toast(`El bloque "${name}" no existe.`, 4000); return; }
      blockEditing = name ? findBlock(real!, name)!.name : null;
      sel = new Set(); setTool(null);
      if (mode !== '2d') setMode('2d'); else refresh();
    },
    editingBlock: () => blockEditing,
    editDrawing: (op) => edit(op, true),
    onRefresh(cb) { refreshCbs.push(cb); },
    async addDrawing(d) {
      await ctx.commit(() => { store(withDrawing(project(), { ...d, id: nextDrawingId(project()) })); });
      const list = project().drawings ?? [];
      activeId = list[list.length - 1]?.id ?? activeId; sel = new Set(); activeLayer = '0';
      if (activeId) ls.set(ACTIVE_KEY, activeId);
      setMode('2d');
    },
  };
}
