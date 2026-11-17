import { aciToHex } from '../core/aci';
import { blockCtx, resolveInsert } from '../core/blocks';
import { findLayer } from '../core/drawing';
import { hatchGeometry, hatchPickDistance } from '../core/hatch';
import { bulgeArc, dimGeometry, distPointEntity, entityBounds, polySegments, textCorners } from '../core/geom2d';
import type { Drawing, Entity, HatchEntity, InsertEntity, Layer, Linetype, Pt2 } from '../core/types';

/**
 * Dibujo de las entidades de un dibujo 2D como SVG (cadenas, sin DOM). Las entidades se escriben en coordenadas del dibujo (mm, y hacia arriba)
 * dentro de un grupo con la transformación de la vista (ver `contentTransform`); los trazos usan `vector-effect: non-scaling-stroke`,
 * así su grosor y sus guiones se miden en píxeles sea cual sea el zoom.
 */

const f = (n: number): string => String(Math.round(n * 1000) / 1000);
export const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Guiones (en píxeles) de cada tipo de línea. */
export const DASH: Record<Linetype, string> = { continuous: '', dashed: '9 5', center: '16 4 3 4' };

/** Una capa se muestra si está encendida y no congelada. */
export const layerVisible = (l: Layer | undefined): boolean => !!l && l.on && !l.frozen;
export const entityVisible = (d: Drawing, e: Entity): boolean => layerVisible(findLayer(d, e.layer));

/** Grosor en píxeles para un grosor de papel en mm (0,25 -> 1 px; 0,5 -> 3 px; máximo 6). */
export const strokePx = (lineweight?: number): number => Math.min(6, Math.max(1, 1 + ((lineweight ?? 0.25) - 0.25) * 8));

/** Color CSS de una entidad (propio o de su capa) sobre papel claro. */
export function entityColor(d: Drawing, e: Entity): string {
  const c = e.color ?? findLayer(d, e.layer)?.color ?? 7;
  return aciToHex(c, false);
}

/** Atributo `transform` del grupo del contenido: dibujo (mm, y arriba) -> píxeles. */
export const contentTransform = (v: { cx: number; cy: number; scale: number; w: number; h: number }): string =>
  `matrix(${f(v.scale)} 0 0 ${f(-v.scale)} ${f(v.w / 2 - v.cx * v.scale)} ${f(v.h / 2 + v.cy * v.scale)})`;

const pt = (p: Pt2): string => `${f(p[0])} ${f(p[1])}`;

/** Trazo SVG ("d") de una polilínea con arcos por bulge. En el sistema del dibujo (y arriba) el barrido antihorario es sweep-flag 1. */
export function polyPathData(pts: { p: Pt2; bulge?: number }[], closed: boolean): string {
  if (!pts.length) return '';
  let d = `M${pt(pts[0].p)}`;
  for (const s of polySegments({ pts, closed })) {
    const arc = bulgeArc(s.a, s.b, s.bulge);
    d += arc ? `A${f(arc.r)} ${f(arc.r)} 0 ${arc.sweep > 180 ? 1 : 0} ${s.bulge > 0 ? 1 : 0} ${pt(s.b)}` : `L${pt(s.b)}`;
  }
  return closed ? d + 'Z' : d;
}

/** Trazo SVG de un arco CCW de a0 a a1 (grados). */
export function arcPathData(c: Pt2, r: number, a0: number, a1: number): string {
  const R = Math.PI / 180;
  const s = ((a1 - a0) % 360 + 360) % 360;
  const sweep = s < 1e-9 ? 360 : s;
  const p = (a: number): Pt2 => [c[0] + r * Math.cos(a * R), c[1] + r * Math.sin(a * R)];
  if (sweep >= 359.999) return `M${pt(p(a0))}A${f(r)} ${f(r)} 0 1 1 ${pt(p(a0 + 180))}A${f(r)} ${f(r)} 0 1 1 ${pt(p(a0))}Z`;
  return `M${pt(p(a0))}A${f(r)} ${f(r)} 0 ${sweep > 180 ? 1 : 0} 1 ${pt(p(a1))}`;
}

/** Tamaño de letra SVG para una altura de letra `h`: el ancho medio de un carácter queda cerca de 0,6·h (la misma estimación de las cajas). */
export const fontSizeFor = (h: number): number => h * 1.2;

interface TextLike { p: Pt2; h: number; s: string; rot?: number; align?: 'left' | 'center' | 'right' }
export function textSvg(t: TextLike, attrs: string): string {
  const anchor = t.align === 'center' ? 'middle' : t.align === 'right' ? 'end' : 'start';
  return `<text transform="translate(${pt(t.p)}) rotate(${f(t.rot ?? 0)}) scale(1 -1)" font-size="${f(fontSizeFor(t.h))}" text-anchor="${anchor}" ${attrs}>${esc(t.s)}</text>`;
}

export interface StyleOpts { color: string; width: number; dash: string; /** clase CSS extra */ cls?: string; /** grosor de los puntos de un sombreado (por omisión 2.2 px con trazo no escalable; al exportar va en unidades del dibujo) */ dotWidth?: number; /** al exportar: reestiliza el estilo propio de cada hijo de un insert (escala de grosores, monocromo) */ restyle?: (st: StyleOpts) => StyleOpts; /** los hijos de un insert usan este estilo en vez del suyo (selección, vista previa, resalte) */ forced?: boolean }

/** Estilo de una entidad: color propio o de la capa, grosor y tipo de línea de la capa. */
export function entityStyle(d: Drawing, e: Entity): StyleOpts {
  const l = findLayer(d, e.layer);
  return { color: entityColor(d, e), width: strokePx(l?.lineweight), dash: DASH[l?.linetype ?? 'continuous'] };
}

const strokeAttrs = (s: StyleOpts): string => `stroke="${s.color}" stroke-width="${f(s.width)}" fill="none" vector-effect="non-scaling-stroke"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}`;

/** SVG de UNA entidad (sin grupo contenedor). Las cotas se dibujan con dimGeometry (líneas sueltas + texto). */
/** Sombreado: relleno (sólido o color de fondo con la regla par-impar) y los trazos / puntos del patrón. */
export function hatchSvg(e: HatchEntity, s: StyleOpts): string {
  let out = '';
  const loopsD = e.loops.map((l) => polyPathData(l, true)).join('');
  const fill = e.pattern === 'solid' ? (e.fillColor !== undefined && !s.forced ? aciToHex(e.fillColor, false) : s.color) : e.fillColor !== undefined && !s.forced ? aciToHex(e.fillColor, false) : null;
  if (fill) out += `<path d="${loopsD}" fill="${fill}" fill-rule="evenodd" stroke="none" />`;
  if (e.pattern === 'solid') return out;
  const g = hatchGeometry(e);
  const dash = s.forced ? s.dash : '';
  if (g.segments.length) out += `<path d="${g.segments.map(([a, b]) => `M${pt(a)}L${pt(b)}`).join('')}" stroke="${s.color}" stroke-width="${f(Math.min(s.width, 1))}" fill="none" vector-effect="non-scaling-stroke"${dash ? ` stroke-dasharray="${dash}"` : ''} />`;
  if (g.dots.length) out += `<path d="${g.dots.map((p) => `M${pt(p)}h0`).join('')}" stroke="${s.color}" stroke-width="${f(s.dotWidth ?? 2.2)}" stroke-linecap="round" fill="none" vector-effect="non-scaling-stroke" />`;
  return out;
}

/** Insert: sus entidades resueltas; cada hijo con su propio estilo (capa y color heredados), o el de `s` si está forzado. */
export function insertSvg(e: InsertEntity, s: StyleOpts, d: Drawing): string {
  let out = '';
  for (const c of resolveInsert(e, d)) {
    if (!entityVisible(d, c)) continue;
    out += entityShapeSvg(c, s.forced ? s : (s.restyle ? s.restyle(entityStyle(d, c)) : entityStyle(d, c)), d);
  }
  return out;
}

export function entityShapeSvg(e: Entity, s: StyleOpts, d?: Drawing): string {
  const st = strokeAttrs(s);
  switch (e.type) {
    case 'line': return `<line x1="${f(e.a[0])}" y1="${f(e.a[1])}" x2="${f(e.b[0])}" y2="${f(e.b[1])}" ${st} />`;
    case 'poly': return `<path d="${polyPathData(e.pts, !!e.closed)}" ${st} />`;
    case 'circle': return `<circle cx="${f(e.c[0])}" cy="${f(e.c[1])}" r="${f(e.r)}" ${st} />`;
    case 'arc': return `<path d="${arcPathData(e.c, e.r, e.a0, e.a1)}" ${st} />`;
    case 'text': return textSvg(e, `fill="${s.color}"`);
    case 'dim': {
      const g = dimGeometry(e);
      const path = g.lines.map(([a, b]) => `M${pt(a)}L${pt(b)}`).join('');
      return `<path d="${path}" ${strokeAttrs({ ...s, dash: '' })} />${g.texts.map((t) => textSvg(t, `fill="${s.color}"`)).join('')}`;
    }
    case 'hatch': return hatchSvg(e, s);
    case 'insert': return d ? insertSvg(e, s, d) : '';
  }
}

/** Contorno de la caja de un texto (para resaltarlo al seleccionar). */
export const textBoxPath = (t: TextLike): string => { const c = textCorners(t); return `M${c.map(pt).join('L')}Z`; };

/**
 * Todas las entidades visibles del dibujo, cada una en su <g data-id>. `selected` y `hover` cambian el color de resalte (el CSS da el estilo).
 * Las capas apagadas o congeladas no se dibujan; las bloqueadas sí (con la clase `locked`, algo atenuadas).
 */
export function entitiesSvg(d: Drawing, selected: ReadonlySet<string>): string {
  let out = '';
  for (const e of d.entities) {
    const l = findLayer(d, e.layer);
    if (!layerVisible(l)) continue;
    const sel = selected.has(e.id);
    const s = entityStyle(d, e);
    if (sel) { s.color = '#2f6fed'; s.width = Math.max(s.width, 1) + 1; s.forced = true; }
    const outline = sel && e.type === 'hatch' ? `<path d="${e.loops.map((lp) => polyPathData(lp, true)).join('')}" stroke="#2f6fed" stroke-width="1.5" stroke-dasharray="6 4" fill="none" vector-effect="non-scaling-stroke" />` : '';
    out += `<g data-id="${esc(e.id)}" class="${sel ? 'sel' : ''}${l?.locked ? ' locked' : ''}">${entityShapeSvg(e, s, d)}${outline}</g>`;
  }
  return out;
}

// ---------------------------------------------------------------- selección (puro)

/** Entidad más cercana al punto `p` dentro de `tol` mm entre las visibles (capa encendida y no congelada); null si ninguna. */
export function pickEntity(d: Drawing, p: Pt2, tol: number): string | null {
  let best: string | null = null, bd = Infinity;
  const ctx = blockCtx(d);
  for (const e of d.entities) {
    if (!entityVisible(d, e)) continue;
    const dist = e.type === 'hatch' ? hatchPickDistance(e, p, tol) : distPointEntity(p, e, ctx);
    // a igual distancia gana la última (la de más arriba)
    if (dist <= tol && dist <= bd) { bd = dist; best = e.id; }
  }
  return best;
}

/** Ids de las entidades visibles cuya caja cae dentro (o, con `crossing`, toca) el rectángulo dado. */
export function entitiesInBox(d: Drawing, a: Pt2, b: Pt2, crossing = false): string[] {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  const out: string[] = [];
  const ctx = blockCtx(d);
  for (const e of d.entities) {
    if (!entityVisible(d, e)) continue;
    const bb = entityBounds(e, ctx);
    if (!bb) continue;
    const inside = bb.min[0] >= x0 && bb.max[0] <= x1 && bb.min[1] >= y0 && bb.max[1] <= y1;
    const touch = bb.max[0] >= x0 && bb.min[0] <= x1 && bb.max[1] >= y0 && bb.min[1] <= y1;
    if (crossing ? touch : inside) out.push(e.id);
  }
  return out;
}
