import { aciToHex } from './aci';
import { findLayer } from './drawing';
import { flattenEntities } from './blocks';
import { hatchGeometry } from './hatch';
import { bulgeArc, dimGeometry, polySegments, sweepFromBulge, sweepOf, norm360 } from './geom2d';
import { partBounds } from './solids';
import { fmtMm } from './units';
import type { Shape } from './viewSheet';
import type { Drawing, Part, Project, Pt2 } from './types';

/**
 * Pasa a formas vectoriales neutras (viewSheet.ts) los planos acotados del proyecto (frente, planta, lado: mismo contenido que
 * src/web/plans.ts, que dibuja el SVG de la pestaña Planos) y un dibujo 2D. Puro: sirve igual en el navegador y en el servidor (MCP).
 * Coordenadas en mm del modelo con el eje y hacia abajo; grosores en mm de papel.
 */

export type PlanViewKey = 'front' | 'top' | 'side';
export const PLAN_TITLES: Record<PlanViewKey, string> = { front: 'Frente', top: 'Planta (vista desde arriba, el frente abajo)', side: 'Lado derecho (el frente a la derecha)' };
export const PLAN_KEYS: PlanViewKey[] = ['front', 'top', 'side'];

interface R { x: number; y: number; w: number; h: number; depth: number; part: Part }
const PROJ: Record<PlanViewKey, (p: Part) => Omit<R, 'part'>> = {
  front: (p) => { const b = partBounds(p); return { x: b.min[0], y: -b.max[1], w: b.size[0], h: b.size[1], depth: b.min[2] }; },
  top: (p) => { const b = partBounds(p); return { x: b.min[0], y: b.min[2], w: b.size[0], h: b.size[2], depth: b.min[1] }; },
  side: (p) => { const b = partBounds(p); return { x: b.min[2], y: -b.max[1], w: b.size[2], h: b.size[1], depth: b.min[0] }; },
};

/** Piezas que entran en los planos: visibles y no compradas. */
export function planParts(project: Project, isHidden: (p: Part) => boolean = () => false): Part[] {
  return project.parts.filter((p) => !isHidden(p) && !project.materials.find((m) => m.id === p.material)?.purchased);
}

/** Formas del plano acotado de una vista; [] si no hay piezas. */
export function planShapes(project: Project, key: PlanViewKey, isHidden: (p: Part) => boolean = () => false): Shape[] {
  const parts = planParts(project, isHidden);
  if (!parts.length) return [];
  const rects: R[] = parts.map((part) => ({ ...PROJ[key](part), part })).sort((a, b) => a.depth - b.depth);
  const minX = Math.min(...rects.map((r) => r.x)), maxX = Math.max(...rects.map((r) => r.x + r.w));
  const minY = Math.min(...rects.map((r) => r.y)), maxY = Math.max(...rects.map((r) => r.y + r.h));
  const H = maxY - minY;
  const fs = Math.max(maxX - minX, H) / 55;
  const out: Shape[] = [];
  const groups = new Map<string, { x0: number; x1: number; y0: number; y1: number }>();
  for (const r of rects) {
    const g = r.part.group ?? r.part.name;
    const b = groups.get(g) ?? { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    b.x0 = Math.min(b.x0, r.x); b.x1 = Math.max(b.x1, r.x + r.w);
    b.y0 = Math.min(b.y0, r.y); b.y1 = Math.max(b.y1, r.y + r.h);
    groups.set(g, b);
  }
  for (const r of rects) {
    const color = project.materials.find((m) => m.id === r.part.material)?.color ?? '#cccccc';
    out.push({ t: 'rect', x: r.x, y: r.y, w: r.w, h: r.h, fill: color, fillOpacity: 0.85, stroke: '#374151', sw: 0.2 });
  }
  const sorted = [...groups].sort((a, b) => a[1].x0 - b[1].x0);
  for (const [name, b] of sorted) {
    out.push({ t: 'rect', x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0, stroke: '#2563eb', sw: 0.3, dash: [2.5, 1.2] });
    out.push({ t: 'text', x: (b.x0 + b.x1) / 2, y: b.y0 - fs * 0.4, size: fs * 0.85, s: name, anchor: 'middle', color: '#1d4ed8' });
  }
  const dimH = (x0: number, x1: number, y: number): void => {
    const sw = 0.2, c = '#111827';
    out.push({ t: 'line', x1: x0, y1: y, x2: x1, y2: y, stroke: c, sw });
    out.push({ t: 'line', x1: x0, y1: y - fs * 0.5, x2: x0, y2: y + fs * 0.5, stroke: c, sw });
    out.push({ t: 'line', x1: x1, y1: y - fs * 0.5, x2: x1, y2: y + fs * 0.5, stroke: c, sw });
    out.push({ t: 'text', x: (x0 + x1) / 2, y: y - fs * 0.3, size: fs * 0.9, s: fmtMm(x1 - x0), anchor: 'middle', color: c });
  };
  const chainY = maxY + fs * 2.5;
  const nonOverlap = sorted.every(([, b], i) => i === 0 || b.x0 >= sorted[i - 1][1].x1 - 1);
  if (nonOverlap && sorted.length > 1) for (const [, b] of sorted) dimH(b.x0, b.x1, chainY);
  dimH(minX, maxX, chainY + fs * 3);
  const vx = maxX + fs * 3, c = '#111827', sw = 0.2;
  out.push({ t: 'line', x1: vx, y1: minY, x2: vx, y2: maxY, stroke: c, sw });
  out.push({ t: 'line', x1: vx - fs * 0.5, y1: minY, x2: vx + fs * 0.5, y2: minY, stroke: c, sw });
  out.push({ t: 'line', x1: vx - fs * 0.5, y1: maxY, x2: vx + fs * 0.5, y2: maxY, stroke: c, sw });
  out.push({ t: 'text', x: vx - fs * 0.4, y: (minY + maxY) / 2, size: fs * 0.9, s: fmtMm(H), anchor: 'middle', color: c, rot: -90 });
  return out;
}

// ---------------------------------------------------------------- dibujo 2D

const ARC_STEP = 6; // grados por segmento al aproximar curvas

/** Negro para blanco/casi blanco (papel claro); si no, el color tal cual. */
function paperHex(c: Parameters<typeof aciToHex>[0]): string {
  const hex = aciToHex(c, false).toLowerCase();
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return r > 242 && g > 242 && b > 242 ? '#000000' : hex;
}

function arcPoints(c: Pt2, r: number, a0: number, sweep: number): [number, number][] {
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP) + 1);
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((a0 + (sweep * i) / (n - 1)) * Math.PI) / 180;
    pts.push([c[0] + r * Math.cos(a), -(c[1] + r * Math.sin(a))]);
  }
  return pts;
}

/** Formas de un dibujo 2D (capas encendidas y no congeladas), con curvas como polilíneas; opts.mono = todo negro. */
export function drawingShapes(d: Drawing, opts: { mono?: boolean; dimTextH?: number } = {}): Shape[] {
  const out: Shape[] = [];
  const CAP = 0.72;
  for (const e of flattenEntities(d, { visibleOnly: true })) { // los inserts van resueltos a su geometría
    const layer = findLayer(d, e.layer);
    if (!layer || !layer.on || layer.frozen) continue;
    const color = opts.mono ? '#000000' : paperHex(e.color ?? layer.color ?? 7);
    const sw = layer.lineweight ?? 0.25;
    const dash: [number, number] | undefined = layer.linetype === 'dashed' ? [3, 1.5] : layer.linetype === 'center' ? [8, 2] : undefined;
    const txt = (t: { p: Pt2; h: number; s: string; rot?: number; align?: 'left' | 'center' | 'right' }): void => {
      out.push({ t: 'text', x: t.p[0], y: -t.p[1], size: t.h / CAP, s: t.s, anchor: t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start', color, rot: t.rot ? -t.rot : undefined });
    };
    switch (e.type) {
      case 'line': out.push({ t: 'line', x1: e.a[0], y1: -e.a[1], x2: e.b[0], y2: -e.b[1], stroke: color, sw, dash }); break;
      case 'poly': {
        const pts: [number, number][] = [];
        const segs = polySegments(e);
        segs.forEach((s, i) => {
          if (i === 0) pts.push([s.a[0], -s.a[1]]);
          const arc = bulgeArc(s.a, s.b, s.bulge);
          if (arc) {
            const a0 = (Math.atan2(s.a[1] - arc.c[1], s.a[0] - arc.c[0]) * 180) / Math.PI;
            pts.push(...arcPoints(arc.c, arc.r, a0, sweepFromBulge(s.bulge)).slice(1));
          } else pts.push([s.b[0], -s.b[1]]);
        });
        if (e.closed && pts.length > 1) { const a = pts[0], b = pts[pts.length - 1]; if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) pts.pop(); }
        out.push({ t: 'poly', pts, closed: !!e.closed, stroke: color, sw, dash });
        break;
      }
      case 'circle': out.push({ t: 'poly', pts: arcPoints(e.c, e.r, 0, 360).slice(0, -1), closed: true, stroke: color, sw, dash }); break;
      case 'arc': out.push({ t: 'poly', pts: arcPoints(e.c, e.r, norm360(e.a0), sweepOf(e.a0, e.a1)), stroke: color, sw, dash }); break;
      case 'text': txt(e); break;
      case 'hatch': {
        // relleno par-impar (sólido o color de fondo) y luego los trazos / puntos del patrón
        const fill = e.fillColor !== undefined ? paperHex(e.fillColor) : e.pattern === 'solid' ? color : null;
        const g = hatchGeometry(e);
        if (fill) out.push({ t: 'fill', polys: g.polygons.map((q) => q.map((p) => [p[0], -p[1]] as [number, number])), fill: opts.mono ? '#000000' : fill });
        for (const [p, q] of g.segments) out.push({ t: 'line', x1: p[0], y1: -p[1], x2: q[0], y2: -q[1], stroke: color, sw: Math.min(sw, 0.18) });
        for (const p of g.dots) out.push({ t: 'line', x1: p[0], y1: -p[1], x2: p[0] + 0.02, y2: -p[1], stroke: color, sw: 0.45 });
        break;
      }
      case 'dim': {
        const g = dimGeometry(e, opts.dimTextH ? { textH: opts.dimTextH } : {});
        for (const [p, q] of g.lines) out.push({ t: 'line', x1: p[0], y1: -p[1], x2: q[0], y2: -q[1], stroke: color, sw });
        for (const t of g.texts) txt(t);
        break;
      }
    }
  }
  return out;
}
