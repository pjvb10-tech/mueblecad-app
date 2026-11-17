import type { Project } from '../core/types';
import { CATEGORIES, CATEGORY_LABEL, SIDES, clamp, effectiveFinishes, migrateRoomFloors, parseCatalog, resolveSurface } from '../core/finish';
import type { RoomFinish, Side, SurfaceFinish, TextureItem } from '../core/finish';

/** Lo que el panel necesita de la aplicación (el proyecto cambia de objeto al deshacer, por eso es una función). */
export interface FinishCtx {
  project: () => Project;
  checkpoint: () => void;
  save: () => Promise<void>;
  toast: (text: string) => void;
  /** Llega la biblioteca (inicio, subida, borrado): la aplicación vuelve a dibujar el 3D. */
  onCatalog: (items: TextureItem[]) => void;
  getShow: () => boolean;
  setShow: (v: boolean) => void;
}

type Surf = 'floor' | 'walls' | Side;
const SURF_LABEL: Record<Surf, string> = { floor: 'Piso', walls: 'Muros (todos)', norte: 'Muro norte', sur: 'Muro sur', este: 'Muro este', oeste: 'Muro oeste' };
const HEIGHTS = [600, 900, 1200, 1500, 2100];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Panel «Acabados»: elige habitación y superficie (piso, muros o un muro), la textura de la biblioteca y sus ajustes
 * (baldosa, junta, veta, patrón, altura). Todo se guarda en project.finishes, con deshacer. «Agregar textura…» sube
 * una imagen (o crea un color liso) a la biblioteca del servidor.
 */
export function setupFinishes(ctx: FinishCtx) {
  const el = document.getElementById('finPanel') as HTMLDivElement;
  let catalog: TextureItem[] = [];
  let room = '';
  let surf: Surf = 'floor';
  let open = false;
  let adding = false;

  async function loadCatalog() {
    try {
      const r = await fetch('/api/texturas');
      catalog = r.ok ? parseCatalog(await r.json()) : [];
    } catch { catalog = []; }
    ctx.onCatalog(catalog);
  }
  const setCatalog = (items: unknown) => { catalog = parseCatalog(items); ctx.onCatalog(catalog); };

  const rooms = () => ctx.project().plan?.rooms ?? [];
  const finishOf = () => effectiveFinishes(ctx.project(), catalog).finishes[room];
  /** Superficie que se ve en el panel (para un muro sin ajuste propio, la general). */
  function current(): { sf?: SurfaceFinish; inherited: boolean } {
    const f = finishOf();
    if (surf === 'floor') return { sf: f?.floor, inherited: false };
    if (surf === 'walls') return { sf: f?.walls?.tex ? f.walls : undefined, inherited: false };
    const own = f?.walls?.lados?.[surf];
    if (own) return { sf: own.tex ? own : undefined, inherited: false };
    return { sf: f?.walls?.tex ? f.walls : undefined, inherited: true };
  }

  /** Cambia project.finishes con deshacer: primero se migra el antiguo roomFloors, luego se limpia lo que quede vacío. */
  function mutate(fn: (rf: RoomFinish) => void) {
    ctx.checkpoint();
    const p = ctx.project();
    migrateRoomFloors(p, catalog);
    p.finishes ??= {};
    const rf = (p.finishes[room] ??= {});
    fn(rf);
    if (rf.walls) {
      if (rf.walls.lados && !Object.keys(rf.walls.lados).length) delete rf.walls.lados;
      if (!rf.walls.tex && !rf.walls.lados) delete rf.walls;
    }
    if (!rf.floor && !rf.walls) delete p.finishes[room];
    if (!Object.keys(p.finishes).length) delete p.finishes;
    return ctx.save();
  }

  /** Ajuste propio de un muro: se crea copiando el general. */
  const ownSide = (rf: RoomFinish, side: Side): SurfaceFinish => {
    rf.walls ??= { tex: '' };
    rf.walls.lados ??= {};
    if (!rf.walls.lados[side]) { const { lados: _l, altura: _a, ...g } = rf.walls; rf.walls.lados[side] = { ...g }; }
    return rf.walls.lados[side]!;
  };
  const target = (rf: RoomFinish): SurfaceFinish | undefined => (surf === 'floor' ? rf.floor : surf === 'walls' ? rf.walls : ownSide(rf, surf));

  function setTexture(id: string) {
    void mutate((rf) => {
      if (surf === 'floor') { if (id) rf.floor = { tex: id }; else delete rf.floor; }
      else if (surf === 'walls') rf.walls = { ...(rf.walls?.lados ? { lados: rf.walls.lados } : {}), ...(rf.walls?.altura ? { altura: rf.walls.altura } : {}), tex: id };
      else { rf.walls ??= { tex: '' }; (rf.walls.lados ??= {})[surf] = { tex: id, ...(rf.walls.lados[surf]?.altura ? { altura: rf.walls.lados[surf]!.altura } : {}) }; }
    }).then(() => draw());
  }
  function setField(key: keyof SurfaceFinish, value: number | string | undefined) {
    void mutate((rf) => {
      const t = target(rf);
      if (!t) return;
      const o = t as unknown as Record<string, unknown>;
      if (value === undefined || value === '') delete o[key]; else o[key] = value;
    });
  }
  function resetAdjust() {
    void mutate((rf) => {
      const t = target(rf);
      if (!t) return;
      for (const k of ['w', 'h', 'junta', 'colorJunta', 'veta', 'patron', 'dx', 'dy'] as const) delete t[k];
    }).then(() => draw());
  }
  function removeFinish() {
    void mutate((rf) => {
      if (surf === 'floor') delete rf.floor;
      else if (surf === 'walls') delete rf.walls;
      else if (rf.walls?.lados) delete rf.walls.lados[surf];
    }).then(() => draw());
  }

  const swatch = (t: TextureItem) => (t.archivo
    ? `<span class="sw" style="background-image:url('/api/textura/${encodeURIComponent(t.archivo)}')"></span>`
    : `<span class="sw" style="background:${t.color}"></span>`);

  function draw() {
    if (!open) { el.style.display = 'none'; return; }
    const all = effectiveFinishes(ctx.project(), catalog);
    const rs = rooms();
    if (!room || !rs.some((r) => r.id === room)) room = rs.find((r) => all.finishes[r.id])?.id ?? rs[0]?.id ?? '';
    const { sf, inherited } = current();
    const res = resolveSurface(sf, all.catalog);
    const panelH = ctx.project().plan?.panelH ?? 2440;
    const roomOpts = rs.map((r) => `<option value="${r.id}"${r.id === room ? ' selected' : ''}>${r.id} · ${esc(r.name || 'sin nombre')}${all.finishes[r.id] ? ' ✓' : ''}</option>`).join('');
    const surfOpts = (Object.keys(SURF_LABEL) as Surf[]).map((s) => {
      const f = all.finishes[room];
      const mark = s === 'floor' ? f?.floor : s === 'walls' ? f?.walls?.tex : f?.walls?.lados?.[s];
      return `<option value="${s}"${s === surf ? ' selected' : ''}>${SURF_LABEL[s]}${mark ? ' ✓' : ''}</option>`;
    }).join('');
    const num = (k: string, v: number | undefined, extra = '') => `<input type="number" data-f="${k}" value="${v ?? ''}" ${extra} />`;
    const cur = sf?.tex ?? '';
    const tiles = [`<button class="fp-tile${cur === '' ? ' sel' : ''}" data-tex="" title="Sin acabado"><span class="sw none">∅</span><small>Sin acabado</small></button>`,
      ...all.catalog.map((t) => `<button class="fp-tile${cur === t.id ? ' sel' : ''}" data-tex="${esc(t.id)}" title="${esc(t.nombre)} · ${t.w}×${t.h} mm">${swatch(t)}<small>${esc(t.nombre)}</small></button>`)].join('');
    const isWall = surf !== 'floor';
    const controls = res
      ? `<h4>Ajustes${inherited ? ' <span class="muted">(este muro usa el general; al cambiar algo tendrá el suyo)</span>' : ''}</h4>
        <div class="grid fp-grid">
          <div><label>Baldosa ancho (mm)</label>${num('w', res.w, 'min="20" max="3000" step="10"')}</div>
          <div><label>Baldosa alto (mm)</label>${num('h', res.h, 'min="20" max="3000" step="10"')}</div>
          <div><label>Junta (mm)</label>${num('junta', res.junta, 'min="0" max="30" step="0.5"')}</div>
          <div><label>Color de junta</label><input type="color" data-f="colorJunta" value="${res.colorJunta}" /></div>
          <div><label>Veta (giro)</label><select data-f="veta"><option value="0"${res.veta === 0 ? ' selected' : ''}>0°</option><option value="90"${res.veta === 90 ? ' selected' : ''}>90°</option></select></div>
          <div><label>Patrón</label><select data-f="patron"><option value="recto"${res.patron === 'recto' ? ' selected' : ''}>Recto</option><option value="trabado"${res.patron === 'trabado' ? ' selected' : ''}>Trabado (50 %)</option></select></div>
          <div><label>Desfase X (mm)</label>${num('dx', res.dx, 'step="10"')}</div>
          <div><label>Desfase Y (mm)</label>${num('dy', res.dy, 'step="10"')}</div>
        </div>
        ${isWall ? `<h4>Altura del revestimiento</h4>
        <div class="row"><input type="number" data-f="altura" min="100" max="${panelH}" step="50" placeholder="techo (${panelH})" value="${res.altura ?? ''}" style="width:110px" />
        ${HEIGHTS.map((h) => `<button data-h="${h}" class="${res.altura === h ? 'on' : ''}">${h}</button>`).join('')}<button data-h="0" class="${res.altura ? '' : 'on'}">Techo</button></div>
        <div class="note">Desde el piso, en mm. Deja libres puertas y ventanas.</div>` : ''}
        <div class="row"><button data-act="reset" title="Vuelve al formato y junta de la textura">Restablecer ajustes</button><button class="danger" data-act="remove">Quitar acabado</button></div>`
      : `<div class="note">${isWall && inherited ? '' : 'Elige una textura para esta superficie.'}</div>`;
    const sel = all.catalog.find((t) => t.id === cur);
    el.style.display = 'block';
    el.innerHTML = `
      <div class="fp-head"><b>Acabados</b>
        <label class="fp-show"><input type="checkbox" id="fpShow"${ctx.getShow() ? ' checked' : ''} /> Ver en 3D</label>
        <button data-act="close" title="Cerrar">×</button></div>
      ${rs.length ? `<div class="grid fp-grid"><div><label>Habitación</label><select id="fpRoom">${roomOpts}</select></div>
        <div><label>Superficie</label><select id="fpSurf">${surfOpts}</select></div></div>`
        : '<div class="note">Importa un plano con habitaciones para asignar acabados.</div>'}
      <h4>Biblioteca de texturas</h4>
      <div class="fp-gal" id="fpGal" title="Arrastra aquí una imagen para agregarla">${tiles}</div>
      ${sel && !sel.id.startsWith('legacy-') ? `<div class="row"><button class="danger" data-act="delete" title="Quita «${esc(sel.nombre)}» de la biblioteca (y su imagen si nadie más la usa)">Borrar de la biblioteca</button></div>` : ''}
      ${rs.length ? controls : ''}
      <details id="fpAdd"${adding ? ' open' : ''}><summary>Agregar textura…</summary>
        <div class="grid fp-grid">
          <div style="grid-column:1/-1"><label>Tipo</label><select id="fpKind"><option value="img">Imagen (png, jpg, webp)</option><option value="color">Color liso (pintura)</option></select></div>
          <div style="grid-column:1/-1" id="fpFileRow"><label>Imagen de la baldosa</label><input type="file" id="fpFile" accept="image/png,image/jpeg,image/webp" /></div>
          <div style="grid-column:1/-1;display:none" id="fpColorRow"><label>Color</label><input type="color" id="fpColor" value="#f2f2ee" /></div>
          <div style="grid-column:1/-1"><label>Nombre</label><input id="fpName" maxlength="80" placeholder="Porcelanato gris 60×120" /></div>
          <div><label>Categoría</label><select id="fpCat">${CATEGORIES.map((c) => `<option value="${c}">${CATEGORY_LABEL[c]}</option>`).join('')}</select></div>
          <div><label>Junta (mm)</label><input type="number" id="fpJ" value="3" min="0" max="30" step="0.5" /></div>
          <div><label>Ancho (mm)</label><input type="number" id="fpW" value="600" min="20" max="3000" step="10" /></div>
          <div><label>Alto (mm)</label><input type="number" id="fpH" value="600" min="20" max="3000" step="10" /></div>
        </div>
        <div class="row"><button class="primary" data-act="upload">Agregar a la biblioteca</button></div>
        <div class="note">Una imagen de UNA baldosa (hasta 15 MB). El tamaño real es el de la baldosa; se repite con juntas.</div>
      </details>`;
  }

  function refresh(force = false) {
    if (!force && el.contains(document.activeElement) && /^(INPUT|SELECT)$/.test((document.activeElement as HTMLElement).tagName)) return;
    draw();
  }

  async function upload() {
    const q = (id: string) => el.querySelector<HTMLInputElement>('#' + id)!;
    const liso = q('fpKind').value === 'color';
    const name = q('fpName').value.trim();
    const file = q('fpFile').files?.[0];
    const common = { categoria: (el.querySelector('#fpCat') as HTMLSelectElement).value, w: Number(q('fpW').value), h: Number(q('fpH').value), junta: Number(q('fpJ').value) };
    try {
      let r: Response;
      if (liso) {
        if (!name) { ctx.toast('Escribe un nombre para el color.'); return; }
        r = await fetch('/api/texturas', { method: 'POST', body: JSON.stringify({ nombre: name, color: q('fpColor').value, ...common }) });
      } else {
        if (!file) { ctx.toast('Elige una imagen.'); return; }
        const qs = new URLSearchParams({ nombre: file.name, titulo: name || file.name.replace(/\.[^.]+$/, ''), categoria: common.categoria, w: String(common.w), h: String(common.h), junta: String(common.junta) });
        r = await fetch('/api/textura?' + qs, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
      }
      const data = await r.json();
      if (!r.ok) { ctx.toast(data.error || 'No se pudo agregar la textura.'); return; }
      setCatalog(data.items);
      adding = false;
      ctx.toast(`Textura «${data.item.nombre}» agregada.`);
      if (room) setTexture(data.item.id); else draw();
    } catch (e) { ctx.toast('No se pudo agregar la textura: ' + String((e as Error).message || e)); }
  }

  async function deleteTexture() {
    const t = catalog.find((x) => x.id === current().sf?.tex);
    if (!t) return;
    const p = ctx.project();
    const users = Object.values(effectiveFinishes(p, catalog).finishes).reduce((n, f) => n + JSON.stringify(f).split(`"tex":"${t.id}"`).length - 1, 0);
    if (!confirm(`¿Borrar «${t.nombre}» de la biblioteca?${users ? `\nSe usa en ${users} superficie(s): quedarán sin acabado visible.` : ''}\nTambién se borra su imagen si ninguna otra textura la usa.`)) return;
    const r = await fetch(`/api/texturas/${encodeURIComponent(t.id)}?archivo=1`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) { ctx.toast(data.error || 'No se pudo borrar.'); return; }
    setCatalog(data.items);
    draw();
  }

  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b || !el.contains(b)) return;
    if (b.dataset.tex !== undefined) setTexture(b.dataset.tex);
    else if (b.dataset.h !== undefined) { setField('altura', Number(b.dataset.h) || undefined); setTimeout(() => draw(), 0); }
    else if (b.dataset.act === 'close') { open = false; setOpen(false); }
    else if (b.dataset.act === 'reset') resetAdjust();
    else if (b.dataset.act === 'remove') removeFinish();
    else if (b.dataset.act === 'upload') void upload();
    else if (b.dataset.act === 'delete') void deleteTexture();
  });
  el.addEventListener('toggle', (e) => { if ((e.target as HTMLElement).id === 'fpAdd') adding = (e.target as HTMLDetailsElement).open; }, true);
  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.id === 'fpRoom') { room = t.value; draw(); return; }
    if (t.id === 'fpSurf') { surf = t.value as Surf; draw(); return; }
    if (t.id === 'fpShow') { ctx.setShow((t as HTMLInputElement).checked); return; }
    if (t.id === 'fpKind') {
      const liso = t.value === 'color';
      (el.querySelector('#fpFileRow') as HTMLElement).style.display = liso ? 'none' : '';
      (el.querySelector('#fpColorRow') as HTMLElement).style.display = liso ? '' : 'none';
      return;
    }
    if (t.id === 'fpFile') {
      const f = (t as HTMLInputElement).files?.[0];
      const nm = el.querySelector<HTMLInputElement>('#fpName')!;
      if (f && !nm.value) nm.value = f.name.replace(/\.[^.]+$/, '');
      return;
    }
    const key = t.dataset.f as keyof SurfaceFinish | undefined;
    if (!key || !current().sf?.tex) return;
    if (key === 'colorJunta') setField(key, t.value);
    else if (key === 'veta') setField(key, Number(t.value));
    else if (key === 'patron') setField(key, t.value);
    else if (t.value.trim() === '') setField(key, undefined);
    else if (key === 'w' || key === 'h') setField(key, clamp(Number(t.value), 20, 3000, 600));
    else if (key === 'junta') setField(key, clamp(Number(t.value), 0, 30, 3));
    else if (key === 'altura') { const v = Number(t.value); setField(key, v >= 100 ? Math.round(v) : undefined); }
    else setField(key, clamp(Number(t.value), -100000, 100000, 0));
  });
  // arrastrar una imagen sobre el panel: abre «Agregar textura…» con el archivo ya elegido
  el.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  el.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    adding = true;
    draw();
    const inp = el.querySelector<HTMLInputElement>('#fpFile')!;
    const dt = new DataTransfer();
    dt.items.add(f);
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });

  let onOpen: (v: boolean) => void = () => {};
  function setOpen(v: boolean) { open = v; onOpen(v); draw(); }

  return {
    loadCatalog,
    refresh,
    get isOpen() { return open; },
    toggle() { setOpen(!open); },
    /** Se llama al abrir/cerrar para marcar el botón de la barra. */
    onToggle(fn: (v: boolean) => void) { onOpen = fn; },
    /** Mostrar solo en la pestaña 3D. */
    setVisible(v: boolean) { el.style.visibility = v ? '' : 'hidden'; },
  };
}
