import { blockDrawing, createBlock, describeBlock, editBlock, explodeInsert, removeBlock, renameBlock } from '../core/blockOps';
import { blockCtx, checkBlockName, findBlock } from '../core/blocks';
import type { EntityInput } from '../core/drawing';
import { entitiesBounds } from '../core/geom2d';
import { findBoundary, loopsFromEntities } from '../core/hatch';
import { buildIndex, pickAt, selectBox, type SpatialIndex } from '../core/select2d';
import { apertureFromPixels, snapPoint } from '../core/snap2d';
import { HATCH_PATTERNS, type Drawing, type Entity, type HatchPattern, type Pt2 } from '../core/types';
import { formDialog } from './drawingDialogs';
import type { DrawingPointerEvent, DrawingToolApi, DrawingToolController } from './drawingHooks';
import { entityShapeSvg, entityStyle, esc } from './drawingRender';
import { EXTRA_ALIASES } from './drawingTools2d';
import type { DrawingsUi } from './drawingUi';

/**
 * Interfaz de sombreados y bloques del dibujo 2D: herramientas de ratón «Sombreado» (H), «Crear bloque» (B), «Insertar» (I) y «Explotar» (X),
 * su barra de opciones (patrón, ángulo, separación, color…), la pestaña «Bloques» (lista con miniatura, insertar, editar, renombrar, borrar) y la
 * barra del modo «Editar bloque». Toda la lógica es la del núcleo (src/core/hatch.ts, blocks.ts, blockOps.ts); esto solo une el ratón y el DOM.
 * Cada operación pasa por `api.add` / `api.edit` / `drawings.editDrawing`: un solo paso de deshacer, respetando capas bloqueadas y congeladas.
 */

const PATTERN_LABEL: Record<HatchPattern, string> = { solid: 'Sólido', lines: 'Líneas', cross: 'Cuadrícula', dots: 'Puntos', ansi31: 'Diagonal (ANSI31)', brick: 'Ladrillo', concrete: 'Concreto', wood: 'Madera' };
const KEY = 'mueblecad.sombreado2d';

interface HatchState { pattern: HatchPattern; angle: number; scale: number; color: string; fill: string; mode: 'point' | 'objects' }
const DEFAULT_STATE: HatchState = { pattern: 'ansi31', angle: 0, scale: 50, color: '', fill: '', mode: 'point' };

const ls = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

const CSS = `
.d2-optbar { display: none; flex-wrap: wrap; align-items: center; gap: 8px; padding: 5px 10px; background: var(--panel); border-bottom: 1px solid var(--line); font-size: 12px; }
.d2-optbar.on { display: flex; }
.d2-optbar label { display: flex; align-items: center; gap: 4px; color: var(--muted); white-space: nowrap; }
.d2-optbar input[type=number] { width: 64px; padding: 3px 5px; }
.d2-optbar input[type=color] { width: 30px; height: 24px; padding: 0; border: 1px solid var(--line); background: none; }
.d2-optbar input.bylayer { opacity: .35; }
.d2-optbar select { width: auto; max-width: 180px; }
.d2-optbar button { padding: 2px 9px; font-size: 12px; }
.d2-optbar button.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
.d2-optbar .hint { color: var(--muted); flex: 1; min-width: 160px; }
.d2-blockbar { display: none; align-items: center; gap: 8px; padding: 6px 10px; background: #fff7e0; color: #5b4300; border-bottom: 1px solid #e6c866; font-size: 13px; flex-wrap: wrap; }
.d2-blockbar.on { display: flex; }
.d2-blockbar b { font-weight: 700; }
.d2-blockbar .spacer { flex: 1; }
.d2-bp { padding: 8px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
.d2-bp .bp-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.d2-bp .bp-item { display: grid; grid-template-columns: 64px 1fr; gap: 8px; padding: 6px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg, #fff); }
.d2-bp .bp-item.editing { border-color: #e6c866; background: #fffbea; }
.d2-bp .bp-thumb { width: 64px; height: 48px; border: 1px solid var(--line); background: #fff; border-radius: 4px; }
.d2-bp .bp-name { font-weight: 600; word-break: break-word; }
.d2-bp .bp-meta { color: var(--muted); font-size: 12px; }
.d2-bp .bp-btns { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.d2-bp .bp-btns button { padding: 1px 8px; font-size: 12px; }
`;

export interface HatchBlocksCtx { host: HTMLElement; toast(text: string, ms?: number): void }

export function setupHatchBlocks(drawings: DrawingsUi, ctx: HatchBlocksCtx): void {
  const host = ctx.host;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  let st: HatchState = { ...DEFAULT_STATE };
  try { const raw = ls.get(KEY); if (raw) st = { ...DEFAULT_STATE, ...(JSON.parse(raw) as Partial<HatchState>) }; } catch { /* valores de omisión */ }
  if (!HATCH_PATTERNS.includes(st.pattern)) st.pattern = DEFAULT_STATE.pattern;
  const saveState = (): void => ls.set(KEY, JSON.stringify(st));

  let pendingBlock: string | null = null; // bloque elegido para insertar (desde la lista)
  let insertScale = 1, insertRot = 0;
  let idx: { d: Drawing; index: SpatialIndex } | null = null;
  const indexFor = (d: Drawing): SpatialIndex => (idx && idx.d === d ? idx.index : (idx = { d, index: buildIndex(d) }).index);
  const activeLayer = (): string => drawings.activeLayer();

  // ---------------------------------------------------------------- barras

  const optBar = document.createElement('div');
  optBar.className = 'd2-optbar';
  host.querySelector('.d2-body')?.before(optBar);
  const blockBar = document.createElement('div');
  blockBar.className = 'd2-blockbar';
  host.querySelector('.d2-body')?.before(blockBar);
  let barKind: 'hatch' | 'insert' | 'make' | 'explode' | null = null;
  let hintEl: HTMLElement | null = null;
  const setHint = (t: string): void => { if (hintEl) hintEl.textContent = t; };

  function paintBar(): void {
    optBar.classList.toggle('on', barKind !== null);
    if (barKind === 'hatch') {
      optBar.innerHTML = `<b>Sombreado</b>
        <label>Patrón <select data-h="pattern">${HATCH_PATTERNS.map((p) => `<option value="${p}" ${p === st.pattern ? 'selected' : ''}>${PATTERN_LABEL[p]}</option>`).join('')}</select></label>
        <label title="Giro del patrón en grados (antihorario)">Ángulo <input type="number" step="any" data-h="angle" value="${st.angle}" /></label>
        <label title="Separación entre las líneas del patrón (mm)">Separación <input type="number" step="any" min="0.1" data-h="scale" value="${st.scale}" /> mm</label>
        <label title="Color de las líneas (vacío = el de la capa)">Color <input type="color" data-h="color" class="${st.color ? '' : 'bylayer'}" value="${st.color || '#000000'}" /><button data-h="bylayer" title="Usar el color de la capa">capa</button></label>
        <label title="Color de fondo del sombreado">Fondo <input type="color" data-h="fill" class="${st.fill ? '' : 'bylayer'}" value="${st.fill || '#ffffff'}" /><button data-h="nofill" title="Sin fondo">ninguno</button></label>
        <span><button data-mode="point" class="${st.mode === 'point' ? 'on' : ''}" title="Clic dentro de una región cerrada: detecta el contorno y las islas">Punto interior</button><button data-mode="objects" class="${st.mode === 'objects' ? 'on' : ''}" title="Elegir las entidades del contorno">Objetos</button></span>
        ${st.mode === 'objects' ? '<button data-act="apply" class="primary">Aplicar</button>' : ''}
        <span class="hint"></span>`;
    } else if (barKind === 'insert') {
      const d = drawings.activeDrawing();
      const names = (d?.blocks ?? []).map((b) => b.name);
      optBar.innerHTML = `<b>Insertar bloque</b>
        <label>Bloque <select data-i="block">${names.map((n) => `<option ${n === pendingBlock ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <label>Escala <input type="number" step="any" data-i="scale" value="${insertScale}" /></label>
        <label>Giro (°) <input type="number" step="any" data-i="rot" value="${insertRot}" /></label>
        <span class="hint"></span>`;
    } else if (barKind === 'make') {
      optBar.innerHTML = '<b>Crear bloque</b><button data-act="base" class="primary">Elegir punto base →</button><button data-act="cancel">Cancelar</button><span class="hint"></span>';
    } else if (barKind === 'explode') {
      optBar.innerHTML = '<b>Explotar</b><span class="hint">Clic en un insert para convertirlo en sus entidades (un nivel). Esc termina.</span>';
    } else optBar.innerHTML = '';
    hintEl = optBar.querySelector('.hint');
  }

  optBar.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    const h = t.dataset.h, i = t.dataset.i;
    if (h) {
      if (h === 'angle' || h === 'scale') { const v = Number(t.value); if (Number.isFinite(v) && (h === 'angle' || v > 0)) st[h] = v; }
      else if (h === 'color' || h === 'fill') { st[h] = t.value; t.classList.remove('bylayer'); }
      saveState();
    } else if (i === 'scale') { const v = Number(t.value); if (Number.isFinite(v) && v !== 0) insertScale = v; }
    else if (i === 'rot') { const v = Number(t.value); if (Number.isFinite(v)) insertRot = v; }
  });
  optBar.addEventListener('change', (e) => {
    const t = e.target as HTMLSelectElement;
    if (t.dataset.h === 'pattern') { st.pattern = t.value as HatchPattern; saveState(); }
    else if (t.dataset.i === 'block') pendingBlock = t.value;
  });
  optBar.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.dataset.h === 'bylayer') { st.color = ''; saveState(); paintBar(); }
    else if (t.dataset.h === 'nofill') { st.fill = ''; saveState(); paintBar(); }
    else if (t.dataset.mode) { st.mode = t.dataset.mode as HatchState['mode']; saveState(); chosen = []; apiNow?.select([]); paintBar(); setHint(modeHint()); }
    else if (t.dataset.act === 'apply') applyObjects();
    else if (t.dataset.act === 'base') makeToBase();
    else if (t.dataset.act === 'cancel') apiNow?.done();
  });

  // ---------------------------------------------------------------- utilidades de ratón

  let apiNow: DrawingToolApi | null = null;
  let down: { p: Pt2; screen: Pt2; shift: boolean } | null = null;
  let boxEnd: Pt2 | null = null;
  const boxGuides = (): [Pt2, Pt2][] => {
    if (!down || !boxEnd) return [];
    const a = down.p, b = boxEnd, c: Pt2 = [a[0], b[1]], e: Pt2 = [b[0], a[1]];
    return [[a, c], [c, b], [b, e], [e, a]];
  };
  const snap = (ev: DrawingPointerEvent): Pt2 => snapPoint(ev.drawing, ev.point, { aperture: apertureFromPixels(10, ev.mmPerPx), modes: { end: true, mid: true, cen: true, int: true }, index: indexFor(ev.drawing) }).point;
  const snapInfo = (ev: DrawingPointerEvent) => { const s = snapPoint(ev.drawing, ev.point, { aperture: apertureFromPixels(10, ev.mmPerPx), modes: { end: true, mid: true, cen: true, int: true }, index: indexFor(ev.drawing) }); return s; };
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // ---------------------------------------------------------------- sombreado

  let chosen: string[] = [];
  const modeHint = (): string => (st.mode === 'point' ? 'Clic dentro de una región cerrada. Esc termina.' : 'Elige las entidades del contorno (clic o ventana) y pulsa Aplicar.');
  let hoverTimer = 0;
  let lastHover = 0;

  const hatchInput = (loops: unknown[], source?: string[]): EntityInput => ({
    type: 'hatch', loops, pattern: st.pattern, ...(st.angle ? { angle: st.angle } : {}), scale: st.scale,
    ...(st.color ? { color: st.color } : {}), ...(st.fill ? { fillColor: st.fill } : {}), layer: activeLayer(), ...(source?.length ? { source } : {}),
  } as unknown as EntityInput);

  function applyObjects(): void {
    const api = apiNow;
    if (!api) return;
    if (!chosen.length) { setHint('Primero elige las entidades del contorno.'); return; }
    try {
      const b = loopsFromEntities(api.drawing, chosen);
      api.add([hatchInput(b.loops, b.source)]);
      chosen = []; api.select([]);
      setHint('Sombreado creado.');
    } catch (e) { setHint(message(e)); ctx.toast(message(e), 5000); }
  }

  const hatchCtrl: DrawingToolController = {
    id: 'hatch', label: 'Sombreado', title: 'Sombreado (H): clic dentro de una región cerrada para rellenarla (detecta islas); «Objetos» para elegir el contorno',
    activate(api) { apiNow = api; barKind = 'hatch'; chosen = []; api.select([]); paintBar(); setHint(modeHint()); },
    deactivate() { barKind = null; chosen = []; down = null; boxEnd = null; paintBar(); window.clearTimeout(hoverTimer); apiNow?.setPreview(null); },
    pointer(ev, api) {
      apiNow = api;
      if (ev.type === 'leave') { api.setPreview(null); return false; }
      if (ev.type === 'dblclick') return false;
      if (ev.type === 'move') {
        if (down && st.mode === 'objects') { boxEnd = ev.point; api.setPreview({ guides: boxGuides() }); return true; }
        if (st.mode === 'point' && ev.drawing.entities.length < 3000) {
          const now = Date.now();
          window.clearTimeout(hoverTimer);
          const run = (): void => {
            lastHover = Date.now();
            try {
              const b = findBoundary(ev.drawing, ev.point);
              api.setPreview(b ? { entities: b.loops.map((l, i): Entity => ({ id: `g${i}`, layer: '0', type: 'poly', pts: l, closed: true })) } : null);
            } catch { api.setPreview(null); }
          };
          if (now - lastHover > 120) run(); else hoverTimer = window.setTimeout(run, 120);
        }
        return true;
      }
      if (ev.type === 'down') { if (ev.button !== 0) return false; down = { p: ev.point, screen: ev.screen, shift: ev.shiftKey }; boxEnd = null; return true; }
      // up
      const dn = down; down = null; boxEnd = null;
      api.setPreview(null);
      if (!dn) return true;
      const d = ev.drawing;
      if (st.mode === 'point') {
        try {
          const b = findBoundary(d, ev.point);
          if (!b) { setHint('No hay un contorno cerrado alrededor de ese punto: cierra las líneas o usa «Objetos».'); api.hint('Sin contorno cerrado en ese punto'); return true; }
          api.add([hatchInput(b.loops, b.source)]);
          setHint(`Sombreado creado (${b.loops.length} contorno${b.loops.length > 1 ? 's' : ''}${b.loops.length > 1 ? ', con islas' : ''}).`);
        } catch (e) { setHint(message(e)); ctx.toast(message(e), 5000); }
        return true;
      }
      const moved = Math.hypot(ev.screen[0] - dn.screen[0], ev.screen[1] - dn.screen[1]) >= 5;
      const ok = (id: string): boolean => { const e = d.entities.find((x) => x.id === id); return !!e && (e.type === 'line' || e.type === 'arc' || e.type === 'circle' || e.type === 'poly'); };
      let hit: string[];
      if (moved) hit = selectBox(d, dn.p, ev.point, { index: indexFor(d) }).ids.filter(ok);
      else hit = pickAt(d, ev.point, 6 * ev.mmPerPx, { index: indexFor(d) }).filter(ok).slice(0, 1);
      for (const id of hit) chosen = chosen.includes(id) && !moved ? chosen.filter((x) => x !== id) : chosen.includes(id) ? chosen : [...chosen, id];
      api.select(chosen);
      setHint(chosen.length ? `${chosen.length} entidad(es) elegida(s). Pulsa Aplicar.` : modeHint());
      return true;
    },
  };

  // ---------------------------------------------------------------- insertar

  const ghostInsert = (p: Pt2): Entity => ({
    id: 'ghost', layer: activeLayer(), type: 'insert', block: pendingBlock!, p,
    ...(insertScale !== 1 ? { sx: insertScale, sy: insertScale } : {}), ...(insertRot ? { rot: insertRot } : {}),
  });

  const insertCtrl: DrawingToolController = {
    id: 'insert', label: 'Insertar', title: 'Insertar bloque (I): elige el bloque, escala y giro en la barra y haz clic donde va su punto base',
    activate(api) {
      apiNow = api;
      const d = api.drawing;
      const names = (d?.blocks ?? []).map((b) => b.name);
      if (!names.length) { ctx.toast('Este dibujo no tiene bloques: crea uno con «Crear bloque» o importa un DXF con bloques.', 5000); api.done(); return; }
      if (!pendingBlock || !names.includes(pendingBlock)) pendingBlock = names[0];
      barKind = 'insert'; paintBar(); setHint('Clic: punto de inserción. Cambia escala y giro en la barra. Esc termina.');
    },
    deactivate() { barKind = null; paintBar(); apiNow?.setPreview(null); },
    pointer(ev, api) {
      apiNow = api;
      if (ev.type === 'leave') { api.setPreview(null); return false; }
      if (ev.type === 'dblclick' || !pendingBlock) return false;
      if (ev.type === 'move') {
        const s = snapInfo(ev);
        api.setPreview({ entities: [ghostInsert(s.point)], snap: s.mode !== 'none' ? { p: s.point, kind: s.label } : null });
        return true;
      }
      if (ev.type === 'down') return ev.button === 0;
      const p = snap(ev);
      api.add([{ type: 'insert', block: pendingBlock, p, ...(insertScale !== 1 ? { sx: insertScale, sy: insertScale } : {}), ...(insertRot ? { rot: insertRot } : {}), layer: activeLayer() } as EntityInput]);
      return true;
    },
  };

  // ---------------------------------------------------------------- explotar

  const explodeCtrl: DrawingToolController = {
    id: 'explode', label: 'Explotar', title: 'Explotar (X): clic en un insert para convertirlo en entidades sueltas; con inserts seleccionados los explota de inmediato',
    activate(api) {
      apiNow = api;
      const d = api.drawing;
      const pre = api.selection().filter((id) => d?.entities.find((e) => e.id === id)?.type === 'insert');
      if (pre.length) {
        api.edit((cur) => pre.reduce((acc, id) => explodeInsert(acc, id).drawing, cur));
        api.select([]);
        api.done();
        return;
      }
      barKind = 'explode'; paintBar();
    },
    deactivate() { barKind = null; paintBar(); },
    pointer(ev, api) {
      apiNow = api;
      if (ev.type === 'move' || ev.type === 'leave' || ev.type === 'dblclick') return false;
      if (ev.type === 'down') return ev.button === 0;
      const d = ev.drawing;
      const hit = pickAt(d, ev.point, 6 * ev.mmPerPx, { index: indexFor(d) }).find((id) => d.entities.find((e) => e.id === id)?.type === 'insert');
      if (!hit) { api.hint('Ahí no hay ningún insert'); return true; }
      api.edit((cur) => explodeInsert(cur, hit).drawing);
      return true;
    },
  };

  // ---------------------------------------------------------------- crear bloque

  let makePhase: 'select' | 'base' = 'select';
  let makeIds: string[] = [];

  function makeToBase(): void {
    const api = apiNow;
    if (!api) return;
    if (!makeIds.length) { setHint('Primero elige las entidades del bloque.'); return; }
    makePhase = 'base';
    setHint(`${makeIds.length} entidad(es). Haz clic en el punto base del bloque.`);
  }

  async function finishMake(base: Pt2): Promise<void> {
    const api = apiNow;
    if (!api) return;
    const d = api.drawing;
    const v = await formDialog('Crear bloque', [
      { key: 'name', label: 'Nombre del bloque', type: 'text', value: `Bloque ${(d.blocks?.length ?? 0) + 1}`, wide: true },
      { key: 'desc', label: 'Descripción (opcional)', type: 'text', value: '', wide: true },
      { key: 'replace', label: 'Entidades originales', type: 'select', value: 'si', wide: true, options: [['si', 'Reemplazarlas por una instancia del bloque'], ['no', 'Conservarlas (solo crear la definición)']] },
    ], {
      ok: 'Crear', note: `Punto base: ${base[0].toFixed(1)}, ${base[1].toFixed(1)} mm. Después podrás insertarlo varias veces y editarlo: todas las instancias se actualizan.`,
      check: (x) => checkBlockName(x.name.trim()) ?? (findBlock(d, x.name.trim()) ? `Ya existe un bloque llamado "${x.name.trim()}".` : null),
    });
    if (!v) { makePhase = 'base'; return; }
    api.edit((cur) => createBlock(cur, { name: v.name.trim(), ids: makeIds, base, ...(v.desc.trim() ? { description: v.desc.trim() } : {}), replace: v.replace === 'si', layer: activeLayer() }).drawing);
    api.select([]);
    api.done();
    ctx.toast(`Bloque «${v.name.trim()}» creado.`, 3500);
  }

  const makeCtrl: DrawingToolController = {
    id: 'block-make', label: 'Crear bloque', title: 'Crear bloque (B): elige entidades (clic o ventana), pulsa «Elegir punto base» y haz clic en el punto base',
    activate(api) {
      apiNow = api; makePhase = 'select';
      makeIds = api.selection();
      barKind = 'make'; paintBar();
      setHint(makeIds.length ? `${makeIds.length} entidad(es) seleccionada(s): añade más o pulsa «Elegir punto base».` : 'Elige las entidades del bloque (clic o ventana).');
    },
    deactivate() { barKind = null; down = null; boxEnd = null; paintBar(); apiNow?.setPreview(null); makeIds = []; },
    pointer(ev, api) {
      apiNow = api;
      if (ev.type === 'leave') { api.setPreview(null); return false; }
      if (ev.type === 'dblclick') return false;
      const d = ev.drawing;
      if (makePhase === 'base') {
        if (ev.type === 'move') { const s = snapInfo(ev); api.setPreview({ snap: s.mode !== 'none' ? { p: s.point, kind: s.label } : null }); return true; }
        if (ev.type === 'down') return ev.button === 0;
        void finishMake(snap(ev));
        return true;
      }
      if (ev.type === 'move') { if (down) { boxEnd = ev.point; api.setPreview({ guides: boxGuides() }); return true; } return true; }
      if (ev.type === 'down') { if (ev.button !== 0) return false; down = { p: ev.point, screen: ev.screen, shift: ev.shiftKey }; boxEnd = null; return true; }
      const dn = down; down = null; boxEnd = null; api.setPreview(null);
      if (!dn) return true;
      const moved = Math.hypot(ev.screen[0] - dn.screen[0], ev.screen[1] - dn.screen[1]) >= 5;
      const hit = moved ? selectBox(d, dn.p, ev.point, { index: indexFor(d) }).ids : pickAt(d, ev.point, 6 * ev.mmPerPx, { index: indexFor(d) }).slice(0, 1);
      for (const id of hit) makeIds = makeIds.includes(id) && !moved ? makeIds.filter((x) => x !== id) : makeIds.includes(id) ? makeIds : [...makeIds, id];
      api.select(makeIds);
      setHint(makeIds.length ? `${makeIds.length} entidad(es) elegida(s). Pulsa «Elegir punto base».` : 'Elige las entidades del bloque (clic o ventana).');
      return true;
    },
  };

  for (const c of [hatchCtrl, makeCtrl, insertCtrl, explodeCtrl]) drawings.registerTool(c);
  for (const a of ['h', 'hatch', 'sombreado', 'bhatch']) EXTRA_ALIASES.set(a, 'hatch');
  for (const a of ['b', 'block', 'bloque', 'make']) EXTRA_ALIASES.set(a, 'block-make');
  for (const a of ['i', 'insert', 'insertar']) EXTRA_ALIASES.set(a, 'insert');
  for (const a of ['x', 'explode', 'explotar']) EXTRA_ALIASES.set(a, 'explode');

  // ---------------------------------------------------------------- pestaña «Bloques»

  const tabs = host.querySelector('.d2-tabs');
  const dock = host.querySelector('.d2-dock');
  const pane = document.createElement('div');
  pane.id = 'd2Blocks'; pane.className = 'd2-pane'; pane.style.display = 'none';
  const tabBtn = document.createElement('button');
  tabBtn.dataset.dock = 'blocks'; tabBtn.textContent = 'Bloques'; tabBtn.title = 'Bloques del dibujo: insertar, editar, renombrar y borrar';
  tabs?.append(tabBtn);
  dock?.append(pane);
  const otherPanes = (): HTMLElement[] => [host.querySelector<HTMLElement>('#d2Ents'), host.querySelector<HTMLElement>('#d2Layers')].filter((x): x is HTMLElement => !!x);
  tabBtn.onclick = () => {
    host.querySelectorAll<HTMLButtonElement>('[data-dock]').forEach((b) => b.classList.toggle('active', b === tabBtn));
    otherPanes().forEach((p) => { p.style.display = 'none'; });
    pane.style.display = '';
    renderPanel();
  };
  tabs?.querySelectorAll<HTMLButtonElement>('[data-dock]').forEach((b) => { if (b !== tabBtn) b.addEventListener('click', () => { pane.style.display = 'none'; }); });

  const realDrawing = (): Drawing | null => {
    const list = drawings.drawings();
    const a = drawings.activeDrawing();
    return a ? list.find((x) => a.id === x.id || a.id.startsWith(`${x.id}#`)) ?? null : null;
  };

  function thumb(d: Drawing, name: string): string {
    const bd = blockDrawing(d, name);
    const b = entitiesBounds(bd.entities, blockCtx(bd));
    if (!b) return '<svg class="bp-thumb"></svg>';
    const w = Math.max(b.max[0] - b.min[0], 1), h = Math.max(b.max[1] - b.min[1], 1), m = Math.max(w, h) * 0.06;
    const shapes = bd.entities.slice(0, 200).map((e) => entityShapeSvg(e, entityStyle(bd, e), bd)).join('');
    return `<svg class="bp-thumb" viewBox="${b.min[0] - m} ${-(b.max[1] + m)} ${w + 2 * m} ${h + 2 * m}" preserveAspectRatio="xMidYMid meet"><g transform="matrix(1 0 0 -1 0 0)">${shapes}</g></svg>`;
  }

  function renderPanel(): void {
    const d = realDrawing();
    if (!d) { pane.innerHTML = '<div class="note">No hay un dibujo activo.</div>'; return; }
    const editing = drawings.editingBlock();
    const list = d.blocks ?? [];
    pane.innerHTML = `<div class="d2-bp"><div class="bp-head"><button data-bact="make" class="primary" title="Crea un bloque con las entidades que elijas">Crear bloque…</button><span class="muted">${list.length} bloque${list.length === 1 ? '' : 's'}</span></div>
      ${list.map((b) => { const info = describeBlock(d, b); return `<div class="bp-item ${editing && editing.toLowerCase() === b.name.toLowerCase() ? 'editing' : ''}" data-block="${esc(b.name)}">${thumb(d, b.name)}
        <div><div class="bp-name">${esc(b.name)}</div><div class="bp-meta">${info.entities} entidad${info.entities === 1 ? '' : 'es'} · ${info.uses + info.usesInBlocks} uso${info.uses + info.usesInBlocks === 1 ? '' : 's'}${b.description ? ` · ${esc(b.description)}` : ''}</div>
        <div class="bp-btns"><button data-bact="insert" title="Insertar este bloque">Insertar</button><button data-bact="edit" title="Editar las entidades del bloque: se actualizan todas las instancias">Editar</button><button data-bact="rename">Renombrar</button><button data-bact="delete" class="danger">Borrar</button></div></div></div>`; }).join('') || '<div class="note">Este dibujo no tiene bloques. Elige entidades y usa «Crear bloque», o importa un DXF con bloques.</div>'}</div>`;
  }

  async function renameDialog(name: string): Promise<void> {
    const d = realDrawing();
    if (!d) return;
    const v = await formDialog('Renombrar bloque', [{ key: 'name', label: 'Nombre nuevo', type: 'text', value: name, wide: true }], {
      check: (x) => checkBlockName(x.name.trim()) ?? (x.name.trim().toLowerCase() !== name.toLowerCase() && findBlock(d, x.name.trim()) ? `Ya existe un bloque llamado "${x.name.trim()}".` : null),
    });
    if (!v || v.name.trim() === name) return;
    const wasEditing = drawings.editingBlock()?.toLowerCase() === name.toLowerCase();
    const to = v.name.trim();
    if (drawings.editDrawing((cur) => renameBlock(cur, name, to)) && wasEditing) window.setTimeout(() => drawings.editBlock(to), 80);
  }

  function deleteBlock(name: string): void {
    const d = realDrawing();
    if (!d) return;
    const info = describeBlock(d, findBlock(d, name)!);
    const uses = info.uses + info.usesInBlocks;
    const msg = uses
      ? `El bloque «${name}» se usa ${uses} vez/veces. ¿Borrarlo y convertir esas instancias en entidades sueltas? (Se puede deshacer con Ctrl+Z)`
      : `¿Borrar el bloque «${name}»? (Se puede deshacer con Ctrl+Z)`;
    if (!confirm(msg)) return;
    if (drawings.editingBlock()?.toLowerCase() === name.toLowerCase()) drawings.editBlock(null);
    drawings.editDrawing((cur) => removeBlock(cur, name, { explode: true }));
  }

  pane.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-bact]');
    if (!t) return;
    const act = t.dataset.bact;
    const name = t.closest<HTMLElement>('[data-block]')?.dataset.block;
    if (act === 'make') drawings.setTool('block-make');
    else if (act === 'insert' && name) { pendingBlock = name; drawings.setTool('insert'); }
    else if (act === 'edit' && name) drawings.editBlock(name);
    else if (act === 'rename' && name) void renameDialog(name);
    else if (act === 'delete' && name) deleteBlock(name);
  });

  // ---------------------------------------------------------------- barra «Editando bloque»

  function paintBlockBar(): void {
    const name = drawings.editingBlock();
    blockBar.classList.toggle('on', !!name);
    const d = realDrawing();
    const b = name && d ? findBlock(d, name) : undefined;
    if (!name || !b || !d) { blockBar.innerHTML = ''; return; }
    const uses = describeBlock(d, b);
    blockBar.innerHTML = `<span>Editando el bloque <b>${esc(b.name)}</b> · ${uses.uses + uses.usesInBlocks} instancia(s) se actualizan con cada cambio · punto base ${b.base[0].toFixed(1)}, ${b.base[1].toFixed(1)}</span><span class="spacer"></span>
      <button data-bb="base" title="Cambiar el punto base del bloque">Punto base…</button><button data-bb="done" class="primary">Terminar edición</button>`;
  }
  blockBar.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-bb]');
    if (!t) return;
    const name = drawings.editingBlock();
    if (t.dataset.bb === 'done') { drawings.editBlock(null); return; }
    const d = realDrawing();
    const b = name && d ? findBlock(d, name) : undefined;
    if (t.dataset.bb === 'base' && b && name) {
      void formDialog('Punto base del bloque', [
        { key: 'x', label: 'x (mm)', type: 'number', value: b.base[0] }, { key: 'y', label: 'y (mm)', type: 'number', value: b.base[1] },
      ], { note: 'Coordenadas locales del bloque: el punto que cae sobre el punto de inserción de cada instancia.', check: (x) => (Number.isFinite(Number(x.x)) && Number.isFinite(Number(x.y)) ? null : 'Escribe números.') }).then((v) => {
        if (v) drawings.editDrawing((cur) => editBlock(cur, name, (bd) => bd, { base: [Number(v.x), Number(v.y)] }));
      });
    }
  });

  drawings.onRefresh(() => { paintBlockBar(); if (pane.style.display !== 'none') renderPanel(); if (barKind === 'insert') paintBar(); });
  paintBar();
}
