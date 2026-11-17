import { applyOps, createTool, type DrawOp, type Tool, type ToolName } from '../core/drawingTools';
import { buildIndex, pickAt, selectBox, type SpatialIndex } from '../core/select2d';
import { apertureFromPixels, snapPoint, type SnapMode, type SnapResult } from '../core/snap2d';
import type { Drawing, Pt2 } from '../core/types';
import { fmtMm } from '../core/units';
import type { EntityInput } from '../core/drawing';
import type { DrawingPointerEvent, DrawingToolApi, DrawingToolController } from './drawingHooks';
import type { DrawingsUi } from './drawingUi';
import { esc } from './drawingRender';
import { gridStep2d } from './drawingViewport';

/**
 * Herramientas de ratón del dibujo 2D: une el lienzo (drawingUi / drawingView) con las máquinas de estados puras de
 * src/core/drawingTools.ts, el imán de snap2d.ts y la selección de select2d.ts. Por herramienta se registra un controlador con
 * `drawings.registerTool`; todos comparten la misma sesión (herramienta activa, imán, índice espacial, línea de comandos).
 * Teclado: las letras se escriben en la línea de comandos (como en AutoCAD) y Enter las interpreta: alias de herramienta (L, PL, REC…),
 * letra de opción de la herramienta activa (C = cerrar, A = arco…), coordenadas (x,y · @dx,dy · @d<a) o una distancia.
 */

interface ToolSpec { id: string; label: string; name: ToolName; alias: string[]; edit?: boolean; title: string }

/** Alias de la línea de comandos de herramientas registradas por otros módulos (sombreados, bloques…): alias en minúsculas → id de herramienta. */
export const EXTRA_ALIASES = new Map<string, string>();

export const TOOL_SPECS: ToolSpec[] = [
  { id: 'line', label: 'Línea', name: 'line', alias: ['L', 'LINE'], title: 'Línea (L): clic a clic; C cierra, Enter/Esc termina' },
  { id: 'polyline', label: 'Polilínea', name: 'polyline', alias: ['PL', 'POLYLINE'], title: 'Polilínea (PL): A arco tangente, L línea, C cierra, U deshace' },
  { id: 'rect', label: 'Rectángulo', name: 'rect', alias: ['REC', 'RECT', 'RECTANG'], title: 'Rectángulo (REC): dos esquinas, o D para dar ancho y alto' },
  { id: 'circle', label: 'Círculo', name: 'circle', alias: ['C', 'CIRCLE'], title: 'Círculo (C): centro y radio; D diámetro, 2 = dos puntos, 3 = tres puntos' },
  { id: 'arc', label: 'Arco', name: 'arc', alias: ['A', 'ARC'], title: 'Arco (A): por tres puntos; C = centro, inicio y fin' },
  { id: 'text', label: 'Texto', name: 'text', alias: ['T', 'TEXT'], title: 'Texto (T): punto de inserción y luego escribe el texto en la línea de comandos' },
  { id: 'dim', label: 'Cota', name: 'dim', alias: ['DIM'], title: 'Cota lineal (DIM): dos puntos y la posición; H / V fuerzan la orientación' },
  { id: 'move', label: 'Mover', name: 'move', alias: ['M', 'MOVE'], edit: true, title: 'Mover (M): designa objetos, Enter, punto base y destino' },
  { id: 'copy', label: 'Copiar', name: 'copy', alias: ['CO', 'COPY'], edit: true, title: 'Copiar (CO): designa objetos, Enter, punto base y destinos' },
  { id: 'rotate', label: 'Rotar', name: 'rotate', alias: ['RO', 'ROTATE'], edit: true, title: 'Rotar (RO): designa objetos, Enter, centro y ángulo; C copia, R referencia' },
  { id: 'scale', label: 'Escalar', name: 'scale', alias: ['SC', 'SCALE'], edit: true, title: 'Escalar (SC): designa objetos, Enter, punto base y factor; C copia, R referencia' },
  { id: 'mirror', label: 'Simetría', name: 'mirror', alias: ['MI', 'MIRROR'], edit: true, title: 'Simetría (MI): designa objetos, Enter, dos puntos del eje; S/N borra el original' },
  { id: 'offset', label: 'Desfase', name: 'offset', alias: ['O', 'OFFSET'], title: 'Desfase (O): escribe la distancia, elige el objeto y el lado' },
  { id: 'erase', label: 'Borrar', name: 'erase', alias: ['E', 'ERASE'], edit: true, title: 'Borrar (E): designa objetos y Enter (con una selección previa borra de inmediato)' },
  { id: 'trim', label: 'Recortar', name: 'trim', alias: ['TR', 'TRIM'], title: 'Recortar (TR): designa bordes (o Enter = todos) y haz clic en lo que sobra; Mayús extiende, B bordes extendidos, U deshace' },
  { id: 'extend', label: 'Extender', name: 'extend', alias: ['EX', 'EXTEND'], title: 'Extender (EX): designa bordes (o Enter = todos) y haz clic cerca del extremo a alargar; Mayús recorta, B bordes extendidos, U deshace' },
];

const SNAP_MODES: [SnapMode, string, string][] = [
  ['end', 'Extremo', 'Extremos de líneas, arcos y vértices'], ['mid', 'Medio', 'Puntos medios'], ['cen', 'Centro', 'Centros de círculos y arcos'],
  ['qua', 'Cuadrante', 'Cuadrantes de círculos y arcos'], ['int', 'Intersección', 'Cruces entre objetos'], ['per', 'Perpendicular', 'Perpendicular al objeto desde el punto anterior'],
  ['tan', 'Tangente', 'Tangente a círculos y arcos desde el punto anterior'], ['nea', 'Cercano', 'El punto más cercano sobre un objeto'], ['grid', 'Rejilla', 'Puntos de la cuadrícula'],
  ['ortho', 'Orto (F8)', 'Fuerza horizontal o vertical respecto del punto anterior'], ['polar', 'Polar', 'Rastreo cada 45° respecto del punto anterior'],
];
const SNAP_KEY = 'mueblecad.imanes2d';
const DEFAULT_SNAP: Partial<Record<SnapMode, boolean>> = { end: true, mid: true, cen: true, int: true, per: true };

const ls = {
  get: (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

/** Tamaño de letra "bonito" (1, 2, 5 × 10^n mm) para unos 14 px en pantalla con el zoom actual. */
function niceTextHeight(mmPerPx: number): number {
  const raw = Math.max(mmPerPx * 14, 1e-3), p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export interface DrawingToolsCtx { host: HTMLElement; toast(text: string, ms?: number): void }

export function setupDrawingTools(drawings: DrawingsUi, ctx: DrawingToolsCtx): void {
  // --- estado compartido -----------------------------------------------------------------
  let modes: Partial<Record<SnapMode, boolean>> = { ...DEFAULT_SNAP };
  try { const raw = ls.get(SNAP_KEY); if (raw) modes = JSON.parse(raw) as typeof modes; } catch { /* se queda con los de omisión */ }
  let spec: ToolSpec | null = null;
  let lastSpec: ToolSpec | null = null;
  let tool: Tool | null = null;
  let api: DrawingToolApi | null = null;
  let mmPerPx = 1;
  let snap: SnapResult | null = null;
  let down: { p: Pt2; screen: Pt2; shift: boolean } | null = null;
  let boxEnd: Pt2 | null = null;
  let selecting = false;
  let picking = false;
  let curBase: Pt2 | null = null;
  let curSel: string[] = [];
  let pushedSel = '';
  let idx: { d: Drawing; index: SpatialIndex } | null = null;
  const indexFor = (d: Drawing): SpatialIndex => (idx && idx.d === d ? idx.index : (idx = { d, index: buildIndex(d) }).index);

  // --- línea de comandos y barra de imanes -------------------------------------------------
  const bar = document.createElement('div');
  bar.className = 'd2-cmd';
  bar.innerHTML = `<div class="d2-snapbar">${SNAP_MODES.map(([m, label, tip]) => `<button data-snap="${m}" title="${esc(tip)}">${esc(label)}</button>`).join('')}</div>
    <div class="d2-cmdrow"><span class="d2-prompt"></span><input class="d2-cmdin" autocomplete="off" spellcheck="false" placeholder="Comando (L, PL, REC, C, A, T, DIM, M, CO, RO, SC, MI, O, E, TR, EX) · x,y · @dx,dy · @d&lt;a" /></div>`;
  ctx.host.querySelector('.d2-body')?.after(bar);
  const input = bar.querySelector<HTMLInputElement>('.d2-cmdin')!;
  const promptEl = bar.querySelector<HTMLElement>('.d2-prompt')!;
  const paintSnapBar = (): void => bar.querySelectorAll<HTMLButtonElement>('[data-snap]').forEach((b) => b.classList.toggle('on', !!modes[b.dataset.snap as SnapMode]));
  const setMode = (m: SnapMode, on: boolean): void => {
    modes[m] = on;
    if (on && m === 'ortho') modes.polar = false;
    if (on && m === 'polar') modes.ortho = false;
    ls.set(SNAP_KEY, JSON.stringify(modes));
    paintSnapBar();
  };
  bar.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest<HTMLElement>('[data-snap]'); if (b) { const m = b.dataset.snap as SnapMode; setMode(m, !modes[m]); } });
  paintSnapBar();

  const IDLE = 'Elige una herramienta o escribe un comando (L, PL, REC, C, A, T, DIM, M, CO, RO, SC, MI, O, E, TR, EX). F8 = orto.';
  function setPrompt(text: string, error?: string | null): void {
    promptEl.innerHTML = `${esc(text || IDLE)}${error ? ` <span class="err">${esc(error)}</span>` : ''}`;
  }
  setPrompt('');

  // --- sesión de herramienta ---------------------------------------------------------------
  const textMode = (): boolean => !!tool && tool.preview().prompt.startsWith('Texto:');

  function start(): void {
    if (!spec || !api) return;
    const d = api.drawing;
    if (!d) { ctx.toast('Crea un dibujo primero (botón «Nuevo»).', 4000); api.done(); return; }
    const opts: Record<string, unknown> = { layer: drawings.activeLayer(), textHeight: niceTextHeight(mmPerPx) };
    if (spec.edit) opts.selection = api.selection();
    tool = createTool(spec.name, d, opts);
    snap = null; pushedSel = '';
    after();
  }

  /** Aplica las operaciones de una herramienta terminada como UN solo paso de deshacer. */
  function apply(ops: DrawOp[]): void {
    if (!api) return;
    if (ops.every((o) => o.op === 'add')) api.add(ops.map((o) => (o as Extract<DrawOp, { op: 'add' }>).entity as EntityInput));
    else api.edit((d) => applyOps(d, ops).drawing);
  }

  /** Tras cada evento: si la herramienta terminó se aplica y se reinicia; si no, se repinta. */
  function after(): void {
    if (!tool || !api) return;
    const pending = tool.drain?.() ?? []; // recortar/extender: cada clic se aplica ya (un paso de deshacer por clic)
    if (pending.length) apply(pending);
    if (tool.done) {
      if (spec && (spec.id === 'trim' || spec.id === 'extend') && pushedSel) { api.select([]); pushedSel = ''; }
      const cancelled = tool.cancelled;
      const ops = tool.commit();
      tool = null;
      if (ops.length) { apply(ops); if (spec?.edit) api.select([]); }
      if (cancelled || !ops.length) { api.done(); return; }
      start();
      return;
    }
    paint();
  }

  function boxGuides(): [Pt2, Pt2][] {
    if (!down || !boxEnd) return [];
    const a = down.p, b = boxEnd, c: Pt2 = [a[0], b[1]], e: Pt2 = [b[0], a[1]];
    return [[a, c], [c, b], [b, e], [e, a]];
  }

  function paint(): void {
    if (!tool || !api) return;
    const pv = tool.preview();
    picking = /^Designe objeto a (recortar|extender)/.test(pv.prompt); // recortar/extender: clic con punto crudo (sin imán), no selección
    selecting = !picking && /^Designe|designado/.test(pv.prompt);
    curBase = pv.base; curSel = pv.selection;
    const sigSel = pv.selection.join(',');
    if (sigSel !== pushedSel) { pushedSel = sigSel; api.select(pv.selection); }
    const guides = [...(snap?.guide ? [snap.guide] : []), ...boxGuides()];
    let label: { p: Pt2; text: string } | null = null;
    if (snap && pv.base && !selecting) {
      const L = Math.hypot(snap.point[0] - pv.base[0], snap.point[1] - pv.base[1]);
      if (L > 1e-9) label = { p: snap.point, text: `${fmtMm(L)} mm  ∠${(((Math.atan2(snap.point[1] - pv.base[1], snap.point[0] - pv.base[0]) * 180) / Math.PI + 360) % 360).toFixed(1)}°` };
    }
    api.setPreview({ entities: pv.ghosts, guides, snap: snap && snap.mode !== 'none' ? { p: snap.point, kind: snap.label } : null, label });
    setPrompt(pv.prompt, pv.error);
  }

  function snapAt(p: Pt2, d: Drawing): SnapResult {
    return snapPoint(d, p, { aperture: apertureFromPixels(10, mmPerPx), modes: { ...modes }, base: curBase, gridStep: gridStep2d(mmPerPx), index: indexFor(d), exclude: curSel });
  }

  function pickSelect(dn: NonNullable<typeof down>, ev: DrawingPointerEvent): void {
    if (!tool) return;
    const d = ev.drawing, index = indexFor(d);
    if (Math.hypot(ev.screen[0] - dn.screen[0], ev.screen[1] - dn.screen[1]) < 5) {
      const hit = pickAt(d, ev.point, 6 * mmPerPx, { index });
      if (hit.length) tool.onSelect(hit.slice(0, 1), spec?.id === 'offset' ? 'replace' : dn.shift ? 'toggle' : 'add');
    } else tool.onSelect(selectBox(d, dn.p, ev.point, { index }).ids, dn.shift ? 'toggle' : 'add');
  }

  function pointer(ev: DrawingPointerEvent, a: DrawingToolApi): boolean {
    api = a;
    mmPerPx = ev.mmPerPx;
    if (ev.type === 'leave') { snap = null; if (tool) paint(); return false; }
    if (ev.type === 'dblclick') return false;
    if (!tool) { start(); if (!tool) return true; }
    const t = tool!;
    t.sync?.(ev.drawing); // recortar/extender: ven siempre el dibujo actual (p. ej. lo que el agente agregó con la herramienta activa)
    if (ev.type === 'move') {
      if (down && selecting) { boxEnd = ev.point; t.onMove(ev.point); paint(); return true; }
      snap = selecting || picking ? null : snapAt(ev.point, ev.drawing);
      t.onMove(snap ? snap.point : ev.point);
      paint();
      return true;
    }
    if (ev.type === 'down') { down = { p: ev.point, screen: ev.screen, shift: ev.shiftKey }; boxEnd = null; return true; }
    const dn = down;
    down = null; boxEnd = null;
    if (!dn) return true;
    if (selecting) pickSelect(dn, { ...ev, shiftKey: dn.shift });
    else if (picking) { snap = null; t.onPoint(ev.point, { shift: dn.shift, tol: 6 * mmPerPx }); }
    else { snap = snapAt(ev.point, ev.drawing); t.onPoint(snap.point); }
    after();
    return true;
  }

  // --- teclado y línea de comandos -------------------------------------------------------------
  const aliases = new Map<string, ToolSpec>();
  for (const s of TOOL_SPECS) for (const al of s.alias) aliases.set(al.toLowerCase(), s);

  function feed(fn: (t: Tool) => void): void {
    if (!tool) return;
    fn(tool);
    after();
  }

  /** Herramienta recién iniciada (sin puntos ni selección): una letra de alias cambia de herramienta en vez de ser opción. */
  const pristine = (): boolean => { if (!tool) return true; const pv = tool.preview(); return !pv.base && !pv.ghosts.length && !pv.selection.length; };
  /** Opciones que valen desde el principio y chocan con un alias: círculo R/D, arco C. */
  const ownOption = (k: string): boolean => (spec?.id === 'circle' && /^[rd]$/i.test(k)) || (spec?.id === 'arc' && /^c$/i.test(k));

  function submit(raw: string): void {
    const s = raw.trim();
    input.value = '';
    if (!s) { // Enter vacío: confirma en la herramienta activa o repite la última
      if (tool) feed((t) => t.onKey('Enter')); else if (lastSpec) drawings.setTool(lastSpec.id);
      return;
    }
    const extra = EXTRA_ALIASES.get(s.toLowerCase());
    const alias = aliases.get(s.toLowerCase()) ?? (extra ? ({ id: extra } as ToolSpec) : undefined);
    if (!tool) {
      if (alias) drawings.setTool(alias.id); else ctx.toast(`Comando desconocido: "${s}". Usa L, PL, REC, C, A, T, DIM, M, CO, RO, SC, MI, O, E, TR o EX.`, 4000);
      return;
    }
    if (!textMode() && alias && (s.length > 1 || (pristine() && !ownOption(s)))) { drawings.setTool(alias.id); return; }
    const option = !textMode() && (/^[a-z]$/i.test(s) || (spec?.id === 'circle' && /^[23]$/.test(s) && !curBase));
    feed((t) => (option ? t.onKey(s) : t.onText(s)));
  }

  function escape(): boolean {
    if (input.value) { input.value = ''; return true; }
    if (!tool) return false;
    feed((t) => t.onKey('Escape'));
    return true;
  }

  drawings.setKeyHook((e: KeyboardEvent): boolean => {
    const t = e.target as HTMLElement | null;
    const inCmd = t === input;
    if (!inCmd && (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement)) return false;
    if (e.key === 'F8') { setMode('ortho', !modes.ortho); return true; }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.key === 'Escape') return escape();
    if (inCmd) {
      if (e.key === 'Enter') { submit(input.value); return true; }
      if (e.key === 'Backspace' && !input.value && tool) { feed((x) => x.onKey('Backspace')); return true; }
      return false;
    }
    if (e.key === 'Enter' || e.key === ' ') { if (tool || input.value || lastSpec) { submit(input.value); return true; } return false; }
    if (e.key === 'Backspace' && tool) { if (input.value) input.value = input.value.slice(0, -1); else feed((x) => x.onKey('Backspace')); return true; }
    if (e.key.length === 1 && /[\w@#<,.+\-:]/.test(e.key)) { input.focus(); input.value += e.key; return true; }
    return false;
  });

  // --- registro -----------------------------------------------------------------------------
  for (const s of TOOL_SPECS) {
    const ctrl: DrawingToolController = {
      id: s.id, label: s.label, title: s.title,
      activate(a) { api = a; spec = s; lastSpec = s; tool = null; start(); },
      deactivate() { tool?.cancel(); tool = null; spec = null; snap = null; down = null; boxEnd = null; selecting = false; picking = false; pushedSel = ''; api?.setPreview(null); setPrompt(''); },
      pointer,
    };
    drawings.registerTool(ctrl);
  }
}
