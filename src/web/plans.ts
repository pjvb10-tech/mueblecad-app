import type { Part, Project } from '../core/types';
import { partBounds } from '../core/solids';
import { fmtMm } from '../core/units';

interface R { x: number; y: number; w: number; h: number; depth: number; part: Part }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// Las vistas usan la caja envolvente de cada pieza (con su giro): las formas sólidas y las piezas giradas se dibujan como su caja.
const VIEWS: { title: string; project: (p: Part) => Omit<R, 'part'> }[] = [
  { title: 'Frente', project: (p) => { const b = partBounds(p); return { x: b.min[0], y: -b.max[1], w: b.size[0], h: b.size[1], depth: b.min[2] }; } },
  { title: 'Planta (vista desde arriba, el frente abajo)', project: (p) => { const b = partBounds(p); return { x: b.min[0], y: b.min[2], w: b.size[0], h: b.size[2], depth: b.min[1] }; } },
  { title: 'Lado derecho (el frente a la derecha)', project: (p) => { const b = partBounds(p); return { x: b.min[2], y: -b.max[1], w: b.size[2], h: b.size[1], depth: b.min[0] }; } },
];

/** Tres vistas ortogonales en SVG con cotas generales y medidas de cada mueble. */
export function renderPlans(project: Project, isHidden: (p: Part) => boolean): string {
  const parts = project.parts.filter((p) => !isHidden(p) && !project.materials.find((m) => m.id === p.material)?.purchased);
  if (!parts.length) return '<p class="muted">No hay piezas para dibujar.</p>';
  return VIEWS.map((view) => svgView(project, parts, view)).join('');
}

function svgView(project: Project, parts: Part[], view: (typeof VIEWS)[number]): string {
  const rects: R[] = parts.map((part) => ({ ...view.project(part), part })).sort((a, b) => a.depth - b.depth);
  const minX = Math.min(...rects.map((r) => r.x)), maxX = Math.max(...rects.map((r) => r.x + r.w));
  const minY = Math.min(...rects.map((r) => r.y)), maxY = Math.max(...rects.map((r) => r.y + r.h));
  const W = maxX - minX, H = maxY - minY;
  const fs = Math.max(W, H) / 55;
  const sw = fs / 10;

  // Cuadro de cada mueble
  const groups = new Map<string, { x0: number; x1: number; y0: number; y1: number }>();
  for (const r of rects) {
    const g = r.part.group ?? r.part.name;
    const b = groups.get(g) ?? { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    b.x0 = Math.min(b.x0, r.x); b.x1 = Math.max(b.x1, r.x + r.w);
    b.y0 = Math.min(b.y0, r.y); b.y1 = Math.max(b.y1, r.y + r.h);
    groups.set(g, b);
  }

  let body = '';
  for (const r of rects) {
    const color = project.materials.find((m) => m.id === r.part.material)?.color ?? '#ccc';
    body += `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${color}" fill-opacity="0.85" stroke="#374151" stroke-width="${sw}" />`;
  }
  const sorted = [...groups].sort((a, b) => a[1].x0 - b[1].x0);
  for (const [name, b] of sorted) {
    body += `<rect x="${b.x0}" y="${b.y0}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" fill="none" stroke="#2563eb" stroke-width="${sw * 1.5}" stroke-dasharray="${fs} ${fs / 2}" />`;
    body += `<text x="${(b.x0 + b.x1) / 2}" y="${b.y0 - fs * 0.4}" font-size="${fs * 0.85}" text-anchor="middle" fill="#1d4ed8">${esc(name)}</text>`;
  }

  // Cotas: cadena por mueble y total (abajo), alto total (derecha)
  const dimH = (x0: number, x1: number, y: number) => {
    const t = fmtMm(x1 - x0);
    return `<g stroke="#111827" stroke-width="${sw}"><line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" /><line x1="${x0}" y1="${y - fs * 0.5}" x2="${x0}" y2="${y + fs * 0.5}" /><line x1="${x1}" y1="${y - fs * 0.5}" x2="${x1}" y2="${y + fs * 0.5}" /></g>
      <text x="${(x0 + x1) / 2}" y="${y - fs * 0.3}" font-size="${fs * 0.9}" text-anchor="middle" fill="#111827">${t}</text>`;
  };
  let dims = '';
  const chainY = maxY + fs * 2.5;
  // La cadena de muebles solo se dibuja si no se solapan (en una vista de frente es lo normal).
  const nonOverlap = sorted.every(([, b], i) => i === 0 || b.x0 >= sorted[i - 1][1].x1 - 1);
  if (nonOverlap && sorted.length > 1) for (const [, b] of sorted) dims += dimH(b.x0, b.x1, chainY);
  dims += dimH(minX, maxX, chainY + fs * 3);
  const vx = maxX + fs * 3;
  dims += `<g stroke="#111827" stroke-width="${sw}"><line x1="${vx}" y1="${minY}" x2="${vx}" y2="${maxY}" /><line x1="${vx - fs * 0.5}" y1="${minY}" x2="${vx + fs * 0.5}" y2="${minY}" /><line x1="${vx - fs * 0.5}" y1="${maxY}" x2="${vx + fs * 0.5}" y2="${maxY}" /></g>
    <text transform="translate(${vx - fs * 0.4} ${(minY + maxY) / 2}) rotate(-90)" font-size="${fs * 0.9}" text-anchor="middle" fill="#111827">${fmtMm(H)}</text>`;

  const pad = fs * 4;
  const vb = `${minX - pad} ${minY - pad} ${W + pad * 2 + fs * 3} ${H + pad * 2 + fs * 6}`;
  return `<div class="plan"><h3>${view.title}</h3><svg viewBox="${vb}">${body}${dims}</svg></div>`;
}
