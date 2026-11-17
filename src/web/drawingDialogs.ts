import { esc } from './drawingRender';

export interface DialogField {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select';
  value: string | number;
  options?: [string, string][];
  /** ocupa todo el ancho */
  wide?: boolean;
  note?: string;
}

/**
 * Diálogo modal sencillo (un <dialog> nativo con el mismo aspecto que los de la app). Devuelve los valores como texto o null si se cancela.
 * `check` valida antes de cerrar: si devuelve un mensaje, se muestra y el diálogo sigue abierto.
 */
export function formDialog(title: string, fields: DialogField[], opts: { ok?: string; note?: string; check?: (v: Record<string, string>) => string | null; onChange?: (key: string, v: Record<string, string>, set: (k: string, val: string) => void) => void } = {}): Promise<Record<string, string> | null> {
  const dlg = document.createElement('dialog');
  dlg.dataset.live = '1'; // no depende de datos del proyecto: la ventana sigue mostrando los cambios del agente
  const ctl = (f: DialogField) => f.type === 'select'
    ? `<select data-k="${f.key}">${(f.options ?? []).map(([v, t]) => `<option value="${esc(v)}" ${v === String(f.value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`
    : `<input data-k="${f.key}" type="${f.type}" ${f.type === 'number' ? 'step="any"' : ''} value="${esc(String(f.value))}" />`;
  dlg.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>
    ${opts.note ? `<p class="note">${esc(opts.note)}</p>` : ''}
    <div class="form">${fields.map((f) => `<label class="${f.wide ? 'wide' : ''}">${esc(f.label)}${ctl(f)}${f.note ? `<span class="note">${esc(f.note)}</span>` : ''}</label>`).join('')}</div>
    <div class="note" data-err style="color:var(--danger);min-height:1.2em"></div>
    <div class="actions" style="flex-direction:row-reverse;justify-content:flex-start"><button value="ok" class="primary">${esc(opts.ok ?? 'Aceptar')}</button><button value="cancel" formnovalidate>Cancelar</button></div></form>`;
  document.body.append(dlg);
  const read = () => Object.fromEntries(Array.from(dlg.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-k]')).map((el) => [el.dataset.k!, el.value]));
  const set = (k: string, val: string) => { const el = dlg.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-k="${k}"]`); if (el) el.value = val; };
  dlg.addEventListener('change', (e) => { const k = (e.target as HTMLElement).dataset.k; if (k) opts.onChange?.(k, read(), set); });
  return new Promise((resolve) => {
    dlg.querySelector('form')!.addEventListener('submit', (e) => {
      const ok = (e as SubmitEvent).submitter?.getAttribute('value') === 'ok';
      if (!ok) return;
      const msg = opts.check?.(read()) ?? null;
      if (msg) { e.preventDefault(); dlg.querySelector<HTMLElement>('[data-err]')!.textContent = msg; }
    });
    dlg.addEventListener('close', () => { const v = dlg.returnValue === 'ok' ? read() : null; dlg.remove(); resolve(v); });
    dlg.showModal();
    dlg.querySelector<HTMLInputElement>('input')?.select();
  });
}

/** Diálogo informativo (resultado de una importación, avisos…): título, líneas de texto y un botón Aceptar. */
export function infoDialog(title: string, lines: string[], tone: 'normal' | 'warn' = 'normal'): Promise<void> {
  const dlg = document.createElement('dialog');
  dlg.dataset.live = '1';
  dlg.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>
    <div class="note" style="max-height:50vh;overflow:auto;${tone === 'warn' ? 'color:var(--danger);' : ''}">${lines.map((l) => `<div>${esc(l)}</div>`).join('')}</div>
    <div class="actions" style="flex-direction:row-reverse;justify-content:flex-start;margin-top:12px"><button value="ok" class="primary">Aceptar</button></div></form>`;
  document.body.append(dlg);
  return new Promise((resolve) => { dlg.addEventListener('close', () => { dlg.remove(); resolve(); }); dlg.showModal(); });
}
