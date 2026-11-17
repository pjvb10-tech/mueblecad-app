import { aciToHex } from '../core/aci';
import { addLayer, removeLayer, setLayer, DrawingError, LAYER_0 } from '../core/drawing';
import type { Drawing, Layer, Linetype } from '../core/types';
import { esc } from './drawingRender';

export interface LayersCtx {
  drawing(): Drawing | null;
  edit(op: (d: Drawing) => Drawing): boolean;
  activeLayer(): string;
  setActiveLayer(name: string): void;
  toast(msg: string): void;
}

const LINETYPES: [Linetype, string][] = [['continuous', 'continua'], ['dashed', 'trazos'], ['center', 'eje']];

/** Panel de capas: nueva, color, visible, congelar, bloquear, tipo de línea, renombrar (con las reglas del contrato: la "0" no se renombra ni se borra) y borrar. */
export function setupLayersPanel(host: HTMLElement, ctx: LayersCtx): { render(): void } {
  const err = (e: unknown) => ctx.toast(e instanceof DrawingError || e instanceof Error ? e.message : String(e));

  function render(): void {
    const d = ctx.drawing();
    if (!d) { host.innerHTML = '<div class="note">No hay un dibujo activo.</div>'; return; }
    const count = (l: Layer) => d.entities.filter((e) => e.layer === l.name).length;
    const rows = d.layers.map((l) => {
      const zero = l.name === LAYER_0;
      return `<tr data-layer="${esc(l.name)}" class="${l.name === ctx.activeLayer() ? 'cur' : ''}">
        <td><input type="radio" name="d2cur" data-f="cur" ${l.name === ctx.activeLayer() ? 'checked' : ''} title="Capa activa: las entidades nuevas se crean aquí" /></td>
        <td><input type="checkbox" data-f="on" ${l.on ? 'checked' : ''} title="Visible" /></td>
        <td><input type="checkbox" data-f="frozen" ${l.frozen ? 'checked' : ''} title="Congelada: no se muestra ni se edita" /></td>
        <td><input type="checkbox" data-f="locked" ${l.locked ? 'checked' : ''} title="Bloqueada: se muestra pero no se edita" /></td>
        <td><input type="color" data-f="color" value="${aciToHex(l.color, false)}" title="${typeof l.color === 'number' ? `Color ACI ${l.color}` : 'Color'}" /></td>
        <td><input data-f="name" value="${esc(l.name)}" ${zero ? 'disabled title="La capa 0 no se puede renombrar"' : ''} /></td>
        <td><select data-f="linetype">${LINETYPES.map(([v, t]) => `<option value="${v}" ${(l.linetype ?? 'continuous') === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td class="num muted">${count(l)}</td>
        <td><button data-del="1" class="mini danger" ${zero ? 'disabled' : ''} title="${zero ? 'La capa 0 no se puede borrar' : 'Borrar la capa (debe estar vacía)'}">✕</button></td></tr>`;
    }).join('');
    host.innerHTML = `<div class="etable-wrap"><table class="etable ltable"><thead><tr><th title="Capa activa">Act.</th><th>Ver</th><th>Cong.</th><th>Bloq.</th><th>Color</th><th>Nombre</th><th>Línea</th><th class="num">Ent.</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="eadd"><div class="row" style="margin:0"><input id="d2NewLayer" placeholder="Nombre de la capa nueva" autocomplete="off" /><button id="d2NewLayerBtn" class="primary">Nueva capa</button></div></div>`;
  }

  const create = () => {
    const input = host.querySelector<HTMLInputElement>('#d2NewLayer')!;
    const name = input.value.trim();
    if (!name) return err(new DrawingError('Escribe el nombre de la capa nueva.'));
    if (ctx.edit((d) => addLayer(d, { name, color: 7 }))) { ctx.setActiveLayer(name); render(); }
  };

  host.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest('#d2NewLayerBtn')) return create();
    const tr = t.closest<HTMLElement>('tr[data-layer]');
    if (tr && t.dataset.del) { const name = tr.dataset.layer!; ctx.edit((d) => removeLayer(d, name)); }
  });
  host.addEventListener('keydown', (ev) => { if ((ev.target as HTMLElement).id === 'd2NewLayer' && ev.key === 'Enter') { ev.preventDefault(); create(); } });
  host.addEventListener('change', (ev) => {
    const t = ev.target as HTMLInputElement | HTMLSelectElement;
    const tr = t.closest<HTMLElement>('tr[data-layer]');
    const f = t.dataset.f;
    if (!tr || !f) return;
    const name = tr.dataset.layer!;
    if (f === 'cur') { ctx.setActiveLayer(name); render(); return; }
    let ok: boolean;
    if (f === 'on' || f === 'frozen' || f === 'locked') ok = ctx.edit((d) => setLayer(d, name, { [f]: (t as HTMLInputElement).checked }));
    else if (f === 'name') {
      ok = ctx.edit((d) => setLayer(d, name, { name: t.value }));
      if (ok && ctx.activeLayer() === name) ctx.setActiveLayer(t.value.trim());
    } else if (f === 'color') ok = ctx.edit((d) => setLayer(d, name, { color: t.value }));
    else ok = ctx.edit((d) => setLayer(d, name, { linetype: t.value as Linetype }));
    if (!ok) render();
  });
  return { render };
}
