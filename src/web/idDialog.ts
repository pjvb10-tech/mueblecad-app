import { makeOpening, openingIds, wallRuns } from '../core/ids';
import type { Project } from '../core/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface Ctx { getProject: () => Project; checkpoint: () => void; save: () => void }

/** Ventana con las claves de la casa (habitaciones, muros y puertas) para poder referirse a cada una; las habitaciones se pueden renombrar. */
export function setupIds(ctx: Ctx) {
  const dlg = $<HTMLDialogElement>('dlgIds');
  const fill = () => {
    const plan = ctx.getProject().plan;
    const rooms = plan?.rooms ?? [];
    const walls = plan ? wallRuns(plan) : [];
    const doors = plan ? openingIds(plan) : [];
    const m = (mm: number) => `${(mm / 1000).toFixed(2)} m`;
    $('idsRooms').innerHTML = rooms.map((r, i) =>
      `<tr><td><b>${r.id}</b></td><td><input data-room="${i}" value="${esc(r.name)}" placeholder="Nombre (ej. Cocina)" /></td><td>${Math.round(r.x1 - r.x0)} × ${Math.round(r.z1 - r.z0)} mm</td><td>${r.area} m²</td></tr>`).join('');
    $('idsWalls').innerHTML = walls.map((w) => `<tr><td><b>${w.id}</b></td><td>${w.kind === 'MP' ? 'Perimetral' : 'Interior'}</td><td>${w.horiz ? 'horizontal' : 'vertical'}</td><td>${m(w.len)}</td></tr>`).join('');
    $('idsDoors').innerHTML = doors.map((d) => `<tr><td><b>${d.id}</b></td><td>${d.o.unknown ? 'Abertura (por confirmar)' : d.o.kind === 'door' ? (d.o.futura ? 'Puerta (será ventana)' : 'Puerta') : 'Ventana'}</td><td>${d.o.manual ? 'en ' + esc(d.o.wall ?? '') : esc(d.o.tag ?? '')}</td><td>${Math.round(Math.hypot(d.o.x2 - d.o.x1, d.o.z2 - d.o.z1))} × ${d.o.h} mm${d.o.y ? ' · antepecho ' + d.o.y : ''}</td><td>${d.o.manual ? `<button type="button" data-del="${d.i}">Quitar</button>` : ''}</td></tr>`).join('');
    const keep = ($('idsWall') as HTMLSelectElement).value;
    $('idsWall').innerHTML = walls.map((w) => `<option value="${w.id}">${w.id} · ${w.kind === 'MP' ? 'perimetral' : 'interior'} · ${w.horiz ? 'de izquierda a derecha' : 'de arriba a abajo'} · ${w.len} mm</option>`).join('');
    if (keep) ($('idsWall') as HTMLSelectElement).value = keep;
  };
  $('ids').onclick = () => { fill(); dlg.showModal(); };
  $('idsKind').onchange = () => {
    const door = ($('idsKind') as HTMLSelectElement).value === 'door';
    ($('idsW') as HTMLInputElement).value = door ? '900' : '1200';
    ($('idsSill') as HTMLInputElement).value = door ? '0' : '900';
    ($('idsH') as HTMLInputElement).value = door ? '2100' : '1200';
  };
  $('idsAddBtn').onclick = () => {
    const plan = ctx.getProject().plan;
    if (!plan) return;
    const num = (id: string) => Number(($(id) as HTMLInputElement).value);
    const o = makeOpening(plan, ($('idsWall') as HTMLSelectElement).value, ($('idsKind') as HTMLSelectElement).value as 'door' | 'window', num('idsStart'), num('idsW'), num('idsSill'), num('idsH'));
    if (!o) { $('idsMsg').textContent = 'No cabe en ese muro: revisa la distancia, el ancho y la altura.'; return; }
    ctx.checkpoint();
    (plan.openings ??= []).push(o);
    ctx.save();
    $('idsMsg').textContent = '';
    fill();
  };
  $('idsDoors').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button[data-del]') as HTMLElement | null;
    const plan = ctx.getProject().plan;
    if (!b || !plan?.openings) return;
    ctx.checkpoint();
    plan.openings.splice(Number(b.dataset.del), 1);
    ctx.save();
    fill();
  });
  $('idsRooms').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const r = ctx.getProject().plan?.rooms?.[Number(t.dataset.room)];
    if (!r) return;
    ctx.checkpoint();
    r.name = t.value.trim();
    ctx.save();
  });
}

/** Muestra el botón solo si el plano trae habitaciones o muros. */
export function refreshIdsButton(p: Project) {
  $('ids').style.display = p.plan?.rooms?.length || p.plan?.walls?.length ? '' : 'none';
}
