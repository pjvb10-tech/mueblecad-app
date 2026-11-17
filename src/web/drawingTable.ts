import { aciToHex } from '../core/aci';
import { copyEntities, moveEntities, removeEntity, updateEntity, DrawingError, type EntityInput } from '../core/drawing';
import type { Drawing, Entity } from '../core/types';
import { entityFields, entitySummary, fieldPatch, parseEntityInput, parseNum, ENTITY_SYNTAX } from './drawingFields';
import { esc } from './drawingRender';

/** Lo que la tabla necesita del resto de la interfaz. */
export interface TableCtx {
  drawing(): Drawing | null;
  /** Aplica una edición pura al dibujo activo (con deshacer y guardado). Devuelve false (ya avisó del error) si falló. */
  edit(op: (d: Drawing) => Drawing): boolean;
  /** Agrega entidades en la capa activa; devuelve false si falló. */
  add(inputs: EntityInput[]): boolean;
  selection(): Set<string>;
  select(ids: string[], additive: boolean): void;
  activeLayer(): string;
  setActiveLayer(name: string): void;
  toast(msg: string): void;
}

/** Máximo de filas que se pintan a la vez (los dibujos importados pueden tener miles de entidades). */
export const MAX_ROWS = 300;

const TYPE_LABEL: Record<string, string> = { line: 'línea', poly: 'polilínea', circle: 'círculo', arc: 'arco', text: 'texto', dim: 'cota', hatch: 'sombreado', insert: 'bloque' };

/**
 * Tabla de entidades del dibujo activo: tipo, capa, color y parámetros editables (número con step any; el resto, texto), selección
 * bidireccional con el lienzo, borrar, duplicar, mover por delta y una línea para agregar entidades escribiendo coordenadas.
 */
export function setupEntityTable(host: HTMLElement, ctx: TableCtx): { render(): void; scrollToSelection(): void } {
  let typeFilter = '';
  let dx = '100', dy = '0';

  const err = (e: unknown) => ctx.toast(e instanceof DrawingError || e instanceof Error ? e.message : String(e));

  function row(d: Drawing, e: Entity, sel: boolean): string {
    const layerSel = `<select data-act="layer">${d.layers.map((l) => `<option value="${esc(l.name)}" ${l.name === e.layer ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>`;
    const colorVal = aciToHex(e.color ?? d.layers.find((l) => l.name === e.layer)?.color ?? 7, false);
    const color = `<input type="color" data-act="color" value="${colorVal}" title="${e.color === undefined ? 'Color por capa (elige uno para fijarlo)' : 'Color propio'}" class="${e.color === undefined ? 'bylayer' : ''}" />${e.color !== undefined ? '<button data-act="bylayer" class="mini" title="Volver al color de la capa">↺</button>' : ''}`;
    const fields = entityFields(e).map((f) => {
      const title = f.title ? ` title="${esc(f.title)}"` : '';
      if (f.kind === 'bool') return `<label class="pf"${title}>${f.label}<input type="checkbox" data-f="${f.key}" ${f.value ? 'checked' : ''} /></label>`;
      if (f.kind === 'select') return `<label class="pf"${title}>${f.label}<select data-f="${f.key}">${(f.options ?? []).map((o) => `<option ${o === f.value ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
      return `<label class="pf ${f.kind === 'text' ? 'wide' : ''}"${title}>${f.label}<input data-f="${f.key}" type="${f.kind === 'num' ? 'number' : 'text'}" ${f.kind === 'num' ? 'step="any"' : ''} value="${esc(String(f.value))}" /></label>`;
    }).join('');
    const sum = entitySummary(e);
    return `<tr data-id="${esc(e.id)}" class="${sel ? 'sel' : ''}"><td class="eid"><b>${esc(e.id)}</b><small>${TYPE_LABEL[e.type] ?? e.type}</small></td>
      <td class="elayer">${layerSel}<div class="ecol">${color}</div></td>
      <td class="eparams">${fields}${sum ? `<small class="esum">${esc(sum)}</small>` : ''}</td></tr>`;
  }

  function render(): void {
    const d = ctx.drawing();
    if (!d) { host.innerHTML = '<div class="note">No hay un dibujo activo. Crea uno con «Nuevo».</div>'; return; }
    const sel = ctx.selection();
    const scroll = host.querySelector<HTMLElement>('.etable-wrap')?.scrollTop ?? 0;
    const types = [...new Set(d.entities.map((e) => e.type))];
    if (typeFilter && !types.includes(typeFilter as Entity['type'])) typeFilter = '';
    let list = d.entities.filter((e) => !typeFilter || e.type === typeFilter);
    const total = list.length;
    if (list.length > MAX_ROWS) {
      // las seleccionadas siempre se ven
      const chosen = list.filter((e) => sel.has(e.id));
      list = [...chosen, ...list.filter((e) => !sel.has(e.id)).slice(0, Math.max(0, MAX_ROWS - chosen.length))];
    }
    const keep = document.activeElement instanceof HTMLInputElement && host.contains(document.activeElement) && document.activeElement.id === 'd2Add';
    const addVal = (host.querySelector<HTMLInputElement>('#d2Add')?.value) ?? '';
    host.innerHTML = `
      <div class="etools">
        <select id="d2Filter" title="Filtrar por tipo"><option value="">todos los tipos</option>${types.map((t) => `<option value="${t}" ${t === typeFilter ? 'selected' : ''}>${TYPE_LABEL[t] ?? t}</option>`).join('')}</select>
        <span class="muted">${sel.size ? `${sel.size} seleccionada${sel.size > 1 ? 's' : ''}` : `${d.entities.length} entidades`}</span>
        <span class="spacer"></span>
        <button data-top="del" ${sel.size ? '' : 'disabled'} class="danger" title="Borrar las entidades seleccionadas (Supr)">Borrar</button>
        <button data-top="dup" ${sel.size ? '' : 'disabled'} title="Duplicar las seleccionadas desplazadas Δx, Δy (Ctrl+D)">Duplicar</button>
        <label class="dxy" title="Desplazamiento (mm) para Mover y Duplicar">Δx <input id="d2Dx" type="number" step="any" value="${esc(dx)}" /></label>
        <label class="dxy">Δy <input id="d2Dy" type="number" step="any" value="${esc(dy)}" /></label>
        <button data-top="move" ${sel.size ? '' : 'disabled'} title="Mover las seleccionadas Δx, Δy">Mover</button>
      </div>
      <div class="etable-wrap"><table class="etable"><thead><tr><th>Id / tipo</th><th>Capa / color</th><th>Parámetros (mm; ángulos en grados)</th></tr></thead>
        <tbody>${list.map((e) => row(d, e, sel.has(e.id))).join('') || '<tr><td colspan="3" class="muted" style="padding:14px">Sin entidades. Agrega una abajo escribiendo sus coordenadas.</td></tr>'}</tbody></table>
        ${total > list.length ? `<div class="note" style="padding:6px 8px">Se muestran ${list.length} de ${total}; filtra por tipo para ver el resto.</div>` : ''}</div>
      <div class="eadd">
        <div class="row" style="margin:0"><select id="d2AddLayer" title="Capa de las entidades nuevas">${d.layers.map((l) => `<option value="${esc(l.name)}" ${l.name === ctx.activeLayer() ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
          <input id="d2Add" placeholder="line 0,0 @100,0  ·  rect 0,0 400,300  ·  circle 50,50 20" value="${esc(addVal)}" autocomplete="off" spellcheck="false" />
          <button id="d2AddBtn" class="primary">Agregar</button></div>
        <details><summary class="note" style="cursor:pointer">Sintaxis</summary><pre class="syntax">${esc(ENTITY_SYNTAX)}</pre></details>
      </div>`;
    const wrap = host.querySelector<HTMLElement>('.etable-wrap');
    if (wrap) wrap.scrollTop = scroll;
    if (keep) host.querySelector<HTMLInputElement>('#d2Add')?.focus();
  }

  function scrollToSelection(): void {
    const first = [...ctx.selection()][0];
    if (!first) return;
    host.querySelector<HTMLElement>(`tr[data-id="${CSS.escape(first)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  const doAdd = () => {
    const input = host.querySelector<HTMLInputElement>('#d2Add')!;
    try {
      const inp = parseEntityInput(input.value);
      ctx.setActiveLayer(host.querySelector<HTMLSelectElement>('#d2AddLayer')!.value);
      if (ctx.add([{ ...inp, layer: ctx.activeLayer() }])) { input.value = ''; render(); host.querySelector<HTMLInputElement>('#d2Add')?.focus(); }
    } catch (e) { err(e); }
  };

  host.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const top = t.closest<HTMLElement>('[data-top]')?.dataset.top;
    const ids = [...ctx.selection()];
    if (top === 'del') { if (ids.length && ctx.edit((d) => removeEntity(d, ids))) { ctx.select([], false); render(); } return; }
    if (top === 'dup' || top === 'move') {
      let delta: [number, number];
      try { delta = [parseNum(dx, 'Δx'), parseNum(dy, 'Δy')]; } catch (e) { return err(e); }
      if (top === 'move') ctx.edit((d) => moveEntities(d, ids, delta));
      else {
        if (!delta[0] && !delta[1]) delta = [100, 100];
        let made: string[] = [];
        if (ctx.edit((d) => { const r = copyEntities(d, ids, delta); made = r.ids; return r.drawing; })) ctx.select(made, false);
      }
      return;
    }
    if (t.closest('#d2AddBtn')) return doAdd();
    const tr = t.closest<HTMLElement>('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id!;
    if (t.dataset.act === 'bylayer') { ctx.edit((d) => updateEntity(d, id, { color: null })); return; }
    if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t.tagName === 'LABEL' || t.tagName === 'OPTION') return; // editar un campo no cambia la selección
    ctx.select([id], ev.ctrlKey || ev.metaKey || ev.shiftKey);
  });

  host.addEventListener('keydown', (ev) => {
    if ((ev.target as HTMLElement).id === 'd2Add' && ev.key === 'Enter') { ev.preventDefault(); doAdd(); }
  });

  host.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t.id === 'd2Dx') dx = t.value; else if (t.id === 'd2Dy') dy = t.value;
  });

  host.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement | HTMLSelectElement;
    if (t.id === 'd2Filter') { typeFilter = t.value; render(); return; }
    if (t.id === 'd2AddLayer') { ctx.setActiveLayer(t.value); return; }
    const tr = t.closest<HTMLElement>('tr[data-id]');
    const d = ctx.drawing();
    if (!tr || !d) return;
    const id = tr.dataset.id!;
    const e = d.entities.find((x) => x.id === id);
    if (!e) return;
    const f = (t as HTMLElement).dataset.f, act = (t as HTMLElement).dataset.act;
    let ok = true;
    if (act === 'layer') ok = ctx.edit((dr) => updateEntity(dr, id, { layer: t.value }));
    else if (act === 'color') ok = ctx.edit((dr) => updateEntity(dr, id, { color: t.value }));
    else if (f) {
      const raw = t instanceof HTMLInputElement && t.type === 'checkbox' ? t.checked : t.value;
      try { const patch = fieldPatch(e, f, raw); ok = ctx.edit((dr) => updateEntity(dr, id, patch)); } catch (er) { err(er); ok = false; }
    }
    if (!ok) render(); // deja los valores como estaban
  });

  return { render, scrollToSelection };
}
