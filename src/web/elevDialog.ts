import type { PlanPanel, Project } from '../core/types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Dibuja una elevación de muro (líneas, textos y huecos) en un canvas. */
function drawPanel(p: PlanPanel, canvas: HTMLCanvasElement) {
  const pad = 12;
  const s = Math.min(1000 / p.w, 0.3);
  canvas.width = Math.ceil(p.w * s + pad * 2);
  canvas.height = Math.ceil(p.h * s + pad * 2);
  const g = canvas.getContext('2d')!;
  const X = (x: number) => pad + x * s, Y = (y: number) => canvas.height - pad - y * s;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (const o of p.openings) {
    g.fillStyle = o.kind === 'door' ? 'rgba(217,119,6,.28)' : 'rgba(14,165,233,.28)';
    g.fillRect(X(o.x0), Y(o.y + o.h), (o.x1 - o.x0) * s, o.h * s);
  }
  g.strokeStyle = '#334155';
  g.lineWidth = 1;
  g.beginPath();
  for (const l of p.lines) { g.moveTo(X(l[0]), Y(l[1])); g.lineTo(X(l[2]), Y(l[3])); }
  g.stroke();
  g.fillStyle = '#0f172a';
  g.font = '11px sans-serif';
  g.textAlign = 'center';
  for (const t of p.texts) g.fillText(t.t, X(t.x), Y(t.y));
  g.fillStyle = '#92400e';
  g.textAlign = 'left';
  g.font = 'bold 11px sans-serif';
  for (const o of p.openings) g.fillText(`${o.kind === 'door' ? 'Puerta' : 'Ventana'} ${o.x1 - o.x0}×${o.h}`, X(o.x0) + 4, Y(o.y + o.h) + 14);
}

/** Ventana con las elevaciones de los paneles de muro leídas del plano de CAD. */
export function setupElevations(getProject: () => Project) {
  const dlg = $<HTMLDialogElement>('dlgElev');
  $('elev').onclick = () => {
    const panels = getProject().plan?.panels ?? [];
    const list = $('elevList');
    list.innerHTML = '';
    // primero los que tienen puertas o ventanas, luego por ancho
    const sorted = [...panels].sort((a, b) => b.openings.length - a.openings.length || b.w - a.w);
    for (const p of sorted) {
      const box = document.createElement('div');
      box.style.margin = '0 0 14px';
      const head = document.createElement('div');
      head.className = 'note';
      const nd = p.openings.filter((o) => o.kind === 'door').length, nw = p.openings.length - nd;
      head.textContent = `${p.tags.slice(0, 8).join(' · ')} — ${p.w} × ${p.h} mm` + (p.openings.length ? ` — ${nd} puerta(s), ${nw} ventana(s)` : ' — muro ciego');
      const cv = document.createElement('canvas');
      cv.style.cssText = 'border:1px solid #e2e8f0;max-width:100%';
      drawPanel(p, cv);
      box.append(head, cv);
      list.appendChild(box);
    }
    $('elevNote').textContent = `${panels.length} paneles de muro leídos del plano. Naranja = puerta, azul = ventana.`;
    dlg.showModal();
  };
}

/** Muestra el botón solo si el plano trae elevaciones. */
export function refreshElevButton(p: Project) {
  $('elev').style.display = p.plan?.panels?.length ? '' : 'none';
}
