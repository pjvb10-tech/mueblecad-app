import { blockCtx } from '../core/blocks';
import { entitiesBounds, entityBounds, type Bounds } from '../core/geom2d';
import type { Drawing, Entity, Pt2 } from '../core/types';
import { fmtMm } from '../core/units';
import type { DrawingPointerEvent, DrawingPreview, DrawingToolApi, DrawingToolController } from './drawingHooks';
import { contentTransform, entitiesInBox, entitiesSvg, entityShapeSvg, entityStyle, entityVisible, esc, pickEntity } from './drawingRender';
import { fitView, gridLines, mmPerPixel, panBy, toDrawing, toScreen, zoomAt, zoomText, type View } from './drawingViewport';

const NS = 'http://www.w3.org/2000/svg';
export type FlashKind = 'new' | 'edit' | 'del';
export interface FlashEntity { entity: Entity; kind: FlashKind }
const FLASH_COLORS: Record<FlashKind, string> = { new: '#16a34a', edit: '#f59e0b', del: '#dc2626' };

/**
 * Lienzo SVG del dibujo 2D: pan (arrastre o botón medio), zoom con la rueda centrado en el cursor, ajustar a la ventana, cuadrícula adaptativa
 * y ejes, selección por clic / Mayús / ventana, resaltado del agente y una capa de vista previa con imán para las herramientas de ratón.
 * La matemática de la vista está en drawingViewport.ts y el dibujo de las entidades en drawingRender.ts (ambos puros y con pruebas).
 */
export class DrawingView {
  readonly svg: SVGSVGElement;
  private gridG = document.createElementNS(NS, 'g');
  private world = document.createElementNS(NS, 'g');
  private content = document.createElementNS(NS, 'g');
  private flashG = document.createElementNS(NS, 'g');
  private previewG = document.createElementNS(NS, 'g');
  private overlayG = document.createElementNS(NS, 'g');
  private status = document.createElement('div');
  private drawing: Drawing | null = null;
  private selected = new Set<string>();
  private view: View = { cx: 0, cy: 0, scale: 0.1, w: 800, h: 600 };
  private fittedFor: string | null = null;
  /** El contenedor ya se midió una vez (mientras está oculto mide 0 y no se puede encuadrar). */
  private measured = false;
  private preview: DrawingPreview | null = null;
  private tool: { ctrl: DrawingToolController; api: DrawingToolApi } | null = null;
  private hint = '';
  private cursor: Pt2 | null = null;
  private hover: string | null = null;
  private gesture: { kind: 'pan' | 'box' | 'tool' | 'pending'; sx: number; sy: number; lx: number; ly: number; moved: boolean; shift: boolean; id: number } | null = null;
  private box: { a: Pt2; b: Pt2 } | null = null;

  /** Cambió la selección (clic, ventana o Mayús = agregar/quitar). */
  onSelect: (ids: string[], how: 'set' | 'toggle' | 'add') => void = () => {};

  constructor(private host: HTMLElement) {
    this.svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
    this.svg.classList.add('d2-svg');
    this.world.append(this.content, this.flashG, this.previewG);
    this.svg.append(this.gridG, this.world, this.overlayG);
    this.status.className = 'd2-status';
    host.append(this.svg, this.status);
    new ResizeObserver(() => this.resize()).observe(host);
    this.svg.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    this.svg.addEventListener('pointerdown', (e) => this.down(e));
    this.svg.addEventListener('pointermove', (e) => this.move(e));
    this.svg.addEventListener('pointerup', (e) => this.up(e));
    this.svg.addEventListener('pointerleave', () => { this.cursor = null; this.hoverId(null); this.toolEvent('leave', null); this.paintStatus(); });
    this.svg.addEventListener('dblclick', (e) => { const ev = this.mk('dblclick', e); if (ev && this.tool) { e.preventDefault(); this.tool.ctrl.pointer(ev, this.tool.api); } });
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault());
    this.resize();
  }

  // --- estado ------------------------------------------------------------------

  get currentView(): View { return this.view; }

  /** Muestra un dibujo. Si es otro distinto del anterior, encuadra todo. */
  setDrawing(d: Drawing | null): void {
    const changed = (d?.id ?? null) !== (this.drawing?.id ?? null);
    this.drawing = d;
    if (changed) { this.flashG.replaceChildren(); this.setPreview(null); this.box = null; }
    if (d && this.measured && (changed || this.fittedFor !== d.id)) this.fit();
    this.paintContent();
    this.paintView();
  }

  /** Ids seleccionados (para exportar solo la selección). */
  selectedIds(): string[] { return [...this.selected]; }

  setSelection(ids: Iterable<string>): void {
    this.selected = new Set(ids);
    this.paintContent();
  }

  /** Encuadra todo lo visible del dibujo (o 6 m alrededor del origen si está vacío). */
  fit(onlyIds?: Iterable<string>): void {
    const d = this.drawing;
    const set = onlyIds ? new Set(onlyIds) : null;
    const list = d ? d.entities.filter((e) => entityVisible(d, e) && (!set || set.has(e.id))) : [];
    const b: Bounds | null = d ? entitiesBounds(list, blockCtx(d)) : null;
    this.view = fitView(b, this.view.w, this.view.h);
    this.fittedFor = d?.id ?? null;
    this.paintView();
  }

  /** Restaura un encuadre guardado (vista guardada): centro (mm) y píxeles por mm. */
  setFrame(f: { cx: number; cy: number; scale: number }): void {
    this.view = { ...this.view, ...f };
    this.fittedFor = this.drawing?.id ?? null;
    this.paintView();
  }

  /** Avisa que el contenedor pasó de oculto a visible (se mide de nuevo). */
  resize(): void {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (w < 2 || h < 2) return;
    const first = !this.measured;
    this.measured = true;
    this.view = { ...this.view, w, h };
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    if (first || (this.drawing && this.fittedFor !== this.drawing.id)) this.fit(); else this.paintView();
  }

  // --- gancho de herramientas ---------------------------------------------------

  setTool(ctrl: DrawingToolController | null, api?: DrawingToolApi): void {
    this.tool?.ctrl.deactivate?.();
    this.tool = ctrl && api ? { ctrl, api } : null;
    this.svg.style.cursor = ctrl?.cursor ?? (ctrl ? 'crosshair' : '');
    this.setPreview(null);
    this.tool?.ctrl.activate?.(this.tool.api);
  }

  setPreview(p: DrawingPreview | null): void {
    this.preview = p;
    this.paintPreview();
  }

  setHint(text: string | null): void { this.hint = text ?? ''; this.paintStatus(); }

  /** Resalta entidades (verde = nueva, naranja = modificada, rojo = borrada) y se apaga sola. */
  flash(items: FlashEntity[], d: Drawing, ms = 6000): void {
    if (!items.length) return;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'd2-flash');
    g.style.animationDuration = `${ms}ms`;
    let html = '';
    for (const { entity, kind } of items.slice(0, 400)) {
      const b = entityBounds(entity, blockCtx(d));
      if (!b) continue;
      const color = FLASH_COLORS[kind];
      const st = { ...entityStyle(d, entity), color, width: 3, dash: kind === 'del' ? '6 4' : '', forced: true };
      html += `<rect x="${b.min[0]}" y="${b.min[1]}" width="${b.max[0] - b.min[0]}" height="${b.max[1] - b.min[1]}" fill="${color}" fill-opacity="0.14" stroke="${color}" stroke-width="1" vector-effect="non-scaling-stroke" />${entityShapeSvg(entity, st, d)}`;
    }
    g.innerHTML = html;
    this.flashG.append(g);
    setTimeout(() => g.remove(), ms + 100);
  }

  // --- pintado -------------------------------------------------------------------

  private paintContent(): void {
    this.content.innerHTML = this.drawing ? entitiesSvg(this.drawing, this.selected) : '';
    if (this.hover) this.content.querySelector(`[data-id="${CSS.escape(this.hover)}"]`)?.classList.add('hover');
  }

  private paintView(): void {
    const v = this.view;
    this.world.setAttribute('transform', contentTransform(v));
    const g = gridLines(v);
    let minor = '', major = '', labels = '';
    for (const l of g.vertical) { const s = `M${l.px.toFixed(1)} 0V${v.h}`; l.major ? (major += s) : (minor += s); if (l.major) labels += `<text x="${(l.px + 3).toFixed(1)}" y="11">${esc(fmtMm(l.mm))}</text>`; }
    for (const l of g.horizontal) { const s = `M0 ${l.px.toFixed(1)}H${v.w}`; l.major ? (major += s) : (minor += s); if (l.major) labels += `<text x="3" y="${(l.px - 3).toFixed(1)}">${esc(fmtMm(l.mm))}</text>`; }
    const axes = (g.axisX !== null ? `<path class="d2-axis-y" d="M${g.axisX.toFixed(1)} 0V${v.h}" />` : '') + (g.axisY !== null ? `<path class="d2-axis-x" d="M0 ${g.axisY.toFixed(1)}H${v.w}" />` : '');
    this.gridG.innerHTML = `<path class="d2-minor" d="${minor}" /><path class="d2-major" d="${major}" />${axes}<g class="d2-glabel">${labels}</g>`;
    this.gridStep = g.step;
    this.paintPreview();
    this.paintStatus();
  }
  private gridStep = 0;

  private paintPreview(): void {
    const p = this.preview, d = this.drawing;
    let w = '';
    if (p?.entities && d) {
      for (const e of p.entities) {
        const st = entityStyle(d, e);
        w += entityShapeSvg(e, { ...st, color: e.color !== undefined ? st.color : '#2f6fed', dash: '6 4', width: 1.5, forced: true }, d);
      }
    }
    for (const [a, b] of p?.guides ?? []) w += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3 3" vector-effect="non-scaling-stroke" />`;
    this.previewG.innerHTML = w;
    let o = '';
    if (p?.snap) {
      const s = toScreen(this.view, p.snap.p);
      o += `<rect class="d2-snap" x="${(s[0] - 5).toFixed(1)}" y="${(s[1] - 5).toFixed(1)}" width="10" height="10" />`;
      if (p.snap.kind) o += `<text class="d2-snaplbl" x="${(s[0] + 9).toFixed(1)}" y="${(s[1] - 8).toFixed(1)}">${esc(p.snap.kind)}</text>`;
    }
    if (p?.label) { const s = toScreen(this.view, p.label.p); o += `<text class="d2-tip" x="${(s[0] + 12).toFixed(1)}" y="${(s[1] + 18).toFixed(1)}">${esc(p.label.text)}</text>`; }
    if (this.box) {
      const a = toScreen(this.view, this.box.a), b = toScreen(this.view, this.box.b);
      const cross = this.box.b[0] < this.box.a[0];
      o += `<rect class="d2-box${cross ? ' cross' : ''}" x="${Math.min(a[0], b[0])}" y="${Math.min(a[1], b[1])}" width="${Math.abs(a[0] - b[0])}" height="${Math.abs(a[1] - b[1])}" />`;
    }
    this.overlayG.innerHTML = o;
  }

  private paintStatus(): void {
    const c = this.cursor;
    const pos = c ? `x ${fmtMm(c[0], 0, 1)} · y ${fmtMm(c[1], 0, 1)}` : '';
    this.status.innerHTML = `<span>${pos}</span><span>zoom ${zoomText(this.view)} · cuadrícula ${fmtMm(this.gridStep)} mm</span>${this.hint ? `<b>${esc(this.hint)}</b>` : ''}`;
  }

  // --- eventos ---------------------------------------------------------------------

  private local(e: MouseEvent): Pt2 {
    const r = this.svg.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const s = this.local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    this.view = zoomAt(this.view, s[0], s[1], Math.exp(-Math.max(-300, Math.min(300, dy)) * 0.0015));
    this.paintView();
  }

  private mk(type: DrawingPointerEvent['type'], e: MouseEvent | null, screen?: Pt2): DrawingPointerEvent | null {
    if (!this.drawing) return null;
    const s = screen ?? (e ? this.local(e) : [0, 0] as Pt2);
    return { type, point: toDrawing(this.view, s), screen: s, button: e?.button ?? 0, shiftKey: !!e?.shiftKey, ctrlKey: !!(e?.ctrlKey || e?.metaKey), altKey: !!e?.altKey, mmPerPx: mmPerPixel(this.view), drawing: this.drawing };
  }

  private toolEvent(type: DrawingPointerEvent['type'], e: MouseEvent | null): boolean {
    if (!this.tool) return false;
    const ev = this.mk(type, e, e ? undefined : this.cursor ?? [0, 0]);
    return ev ? this.tool.ctrl.pointer(ev, this.tool.api) : false;
  }

  private hoverId(id: string | null): void {
    if (id === this.hover) return;
    if (this.hover) this.content.querySelector(`[data-id="${CSS.escape(this.hover)}"]`)?.classList.remove('hover');
    this.hover = id;
    if (id) this.content.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('hover');
  }

  private down(e: PointerEvent): void {
    const s = this.local(e);
    this.svg.setPointerCapture(e.pointerId);
    const base = { sx: s[0], sy: s[1], lx: s[0], ly: s[1], moved: false, shift: e.shiftKey, id: e.pointerId };
    if (e.button === 1 || e.button === 2) { e.preventDefault(); this.gesture = { kind: 'pan', ...base }; return; }
    if (e.button !== 0) return;
    if (this.tool && this.toolEvent('down', e)) { this.gesture = { kind: 'tool', ...base }; return; }
    this.gesture = { kind: 'pending', ...base };
  }

  private move(e: PointerEvent): void {
    const s = this.local(e);
    this.cursor = toDrawing(this.view, s);
    const g = this.gesture;
    if (g && g.id === e.pointerId) {
      if (g.kind === 'tool') { this.toolEvent('move', e); this.paintStatus(); return; }
      if (g.kind === 'pending' && Math.hypot(s[0] - g.sx, s[1] - g.sy) > 4) g.kind = g.shift ? 'box' : 'pan';
      if (g.kind === 'pan') {
        this.view = panBy(this.view, s[0] - g.lx, s[1] - g.ly);
        g.lx = s[0]; g.ly = s[1]; g.moved = true;
        this.paintView();
        return;
      }
      if (g.kind === 'box') {
        g.moved = true;
        this.box = { a: toDrawing(this.view, [g.sx, g.sy]), b: this.cursor };
        this.paintPreview();
        this.paintStatus();
        return;
      }
    }
    if (this.tool) this.toolEvent('move', e);
    else if (this.drawing) this.hoverId(pickEntity(this.drawing, this.cursor, 6 * mmPerPixel(this.view)));
    this.paintStatus();
  }

  private up(e: PointerEvent): void {
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    this.gesture = null;
    try { this.svg.releasePointerCapture(e.pointerId); } catch { /* ya liberado */ }
    if (g.kind === 'tool') { this.toolEvent('up', e); return; }
    if (g.kind === 'box' && this.box && this.drawing) {
      const b = this.box;
      this.box = null;
      this.paintPreview();
      this.onSelect(entitiesInBox(this.drawing, b.a, b.b, b.b[0] < b.a[0]), 'add');
      return;
    }
    if (g.kind === 'pending' && this.drawing) {
      const id = pickEntity(this.drawing, toDrawing(this.view, [g.sx, g.sy]), 6 * mmPerPixel(this.view));
      this.onSelect(id ? [id] : [], e.shiftKey ? 'toggle' : 'set');
    }
  }

  /** Tecla dirigida a la herramienta activa. Devuelve true si la consumió. */
  keyToTool(e: KeyboardEvent): boolean {
    return !!(this.tool && this.tool.ctrl.key?.(e, this.tool.api));
  }
}
