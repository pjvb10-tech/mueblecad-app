import type { Part, Project } from './types';
import { cutPiece, rebateText, type NestingResult, type Placement } from './nesting';
import { edgeMeters } from './edges';
import { outline, polygonArea, type Pt } from './shapes';
import { isSolid, solidsList, FORM_NAMES } from './solids';
import { fmtMm } from './units';

const BOM = '﻿';

/** CSV (separado por ; para Excel en español) con cada pieza, su plancha y su posición. */
export function piecesCsv(project: Project, result: NestingResult): string {
  const where = new Map<string, { sheet: number; x: number; y: number; rotated: boolean }>();
  for (const s of result.sheets) for (const p of s.placements) where.set(p.partId, { sheet: s.index, x: p.x, y: p.y, rotated: p.rotated });
  const head = ['Mueble', 'Pieza', 'Material', 'Largo', 'Ancho', 'Espesor', 'Tapacanto largos', 'Tapacanto anchos', 'Tapacanto m', 'Rebajes', 'Plancha', 'X en plancha', 'Y en plancha', 'Rotada'];
  const rows = project.parts
    .filter((p) => !project.materials.find((m) => m.id === p.material)?.purchased && !isSolid(p))
    .map((part) => {
      const c = cutPiece(part);
      const w = where.get(part.id);
      return [part.group ?? '', part.name, project.materials.find((m) => m.id === part.material)?.name ?? part.material, fmtMm(c.length, 0, 3), fmtMm(c.width, 0, 3), fmtMm(c.thickness, 0, 3),
        part.edges?.largo ?? 0, part.edges?.ancho ?? 0, edgeMeters(part).toFixed(2), rebateText(part), w?.sheet ?? '', w ? fmtMm(w.x, 0, 3) : '', w ? fmtMm(w.y, 0, 3) : '', w ? (w.rotated ? 'sí' : 'no') : ''];
    });
  const q = (r: (string | number)[]) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';');
  const lines = [head, ...rows].map(q);
  // Perfiles y sólidos (tubos, cilindros, prismas, revoluciones): no entran a planchas; van en una tabla aparte solo si existen.
  const solids = solidsList(project.parts);
  if (solids.length) {
    lines.push('', q(['Perfiles y sólidos (no se cortan de planchas)']));
    lines.push(q(['Forma', 'Descripción', 'Material', 'Caja largo', 'Caja ancho', 'Caja alto', 'Cantidad', 'Volumen unitario cm3', 'Piezas']));
    for (const s of solids) lines.push(q([FORM_NAMES[s.form], s.description, project.materials.find((m) => m.id === s.material)?.name ?? s.material, ...s.box.map((v) => fmtMm(v, 0, 3)), s.qty, s.volumeCm3, s.names.join(', ')]));
  }
  return BOM + lines.join('\r\n');
}

export interface PlacedPiece {
  name: string;
  outer: Pt[];
  holes: Pt[][];
  /** Recorrido central de cada rebaje (de a a b), con su ancho y profundidad. */
  rebates: { a: Pt; b: Pt; width: number; depth: number }[];
}

/** Contorno de una pieza ya ubicada en la plancha, en mm con Y hacia arriba (origen en la esquina inferior izquierda de la plancha). */
export function placedPiece(part: Part | undefined, pl: Placement, sheetH: number): PlacedPiece {
  const o = part ? outline(part.size, part.shape) : { outer: [[0, 0], [pl.w, 0], [pl.w, pl.h], [0, pl.h]] as Pt[], holes: [] as Pt[][] };
  const map = ([u, v]: Pt): Pt => (pl.rotated ? [pl.x + v, sheetH - (pl.y + u)] : [pl.x + u, sheetH - (pl.y + v)]);
  const L = pl.rotated ? pl.h : pl.w;
  const W = pl.rotated ? pl.w : pl.h;
  const rebates = (part?.rebates ?? []).map((r) => {
    const h = r.width / 2;
    const line: [Pt, Pt] = [[0, h], [L, h]]; // edge 0
    const [a, b] = r.edge === 0 ? line : r.edge === 1 ? [[L - h, 0], [L - h, W]] as [Pt, Pt] : r.edge === 2 ? [[0, W - h], [L, W - h]] as [Pt, Pt] : [[h, 0], [h, W]] as [Pt, Pt];
    return { a: map(a), b: map(b), width: r.width, depth: r.depth };
  });
  return { name: pl.name, outer: o.outer.map(map), holes: o.holes.map((h) => h.map(map)), rebates };
}

/** DXF con las planchas apiladas: contornos, huecos, rebajes, cortes numerados y etiquetas. Unidades: mm. */
export function dxf(project: Project, result: NestingResult): string {
  const out: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  const f = (n: number) => n.toFixed(3);
  const line = (layer: string, x1: number, y1: number, x2: number, y2: number) =>
    out.push('0', 'LINE', '8', layer, '10', f(x1), '20', f(y1), '30', '0', '11', f(x2), '21', f(y2), '31', '0');
  const text = (layer: string, x: number, y: number, h: number, s: string) =>
    out.push('0', 'TEXT', '8', layer, '10', f(x), '20', f(y), '30', '0', '40', f(h), '1', s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '?'));
  const poly = (layer: string, pts: Pt[], oy: number) => pts.forEach((p, i) => line(layer, p[0], oy + p[1], pts[(i + 1) % pts.length][0], oy + pts[(i + 1) % pts.length][1]));

  let oy = 0;
  for (const s of result.sheets) {
    const { sheetW, sheetH } = s.material;
    poly('PLANCHA', [[0, 0], [sheetW, 0], [sheetW, sheetH], [0, sheetH]], oy);
    text('ETIQUETA', 0, oy + sheetH + 40, 40, `${s.material.name} - plancha ${s.index}`);
    for (const pl of s.placements) {
      const piece = placedPiece(project.parts.find((p) => p.id === pl.partId), pl, sheetH);
      poly('CORTE', piece.outer, oy);
      piece.holes.forEach((h) => poly('HUECOS', h, oy));
      piece.rebates.forEach((r) => line('REBAJE', r.a[0], oy + r.a[1], r.b[0], oy + r.b[1]));
      text('ETIQUETA', pl.x + 20, oy + sheetH - pl.y - pl.h / 2, Math.min(30, pl.h / 4), `${pl.name} ${fmtMm(pl.w, 0, 1).replace(',', '.')}x${fmtMm(pl.h, 0, 1).replace(',', '.')}`);
    }
    for (const c of s.cuts) {
      if (c.orientation === 'h') { line('SECUENCIA', c.from, oy + sheetH - c.pos, c.to, oy + sheetH - c.pos); text('SECUENCIA', c.from + 5, oy + sheetH - c.pos + 5, 25, String(c.n)); }
      else { line('SECUENCIA', c.pos, oy + sheetH - c.from, c.pos, oy + sheetH - c.to); text('SECUENCIA', c.pos + 5, oy + sheetH - c.from - 30, 25, String(c.n)); }
    }
    oy -= sheetH + 300;
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n');
}

// --- G-code ---------------------------------------------------------------

export interface GcodeOptions {
  /** Diámetro de la fresa. */
  toolDiameter: number;
  /** Avance de corte y de bajada, en mm/min. */
  feed: number;
  plungeFeed: number;
  /** Profundidad por pasada. */
  passDepth: number;
  /** Altura segura sobre la plancha. */
  safeZ: number;
  /** Velocidad del husillo (rpm). */
  spindle: number;
}

export const DEFAULT_GCODE: GcodeOptions = { toolDiameter: 6, feed: 1800, plungeFeed: 600, passDepth: 6, safeZ: 8, spindle: 18000 };

const dedupe = (pts: Pt[]) => pts.filter((p, i) => { const q = pts[(i + pts.length - 1) % pts.length]; return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6; });

/** Desplaza un polígono: d > 0 lo agranda y d < 0 lo achica, sin importar su orientación. */
export function offsetPolygon(input: Pt[], d: number): Pt[] {
  const pts = dedupe(input);
  const n = pts.length;
  const s = polygonSigned(pts) > 0 ? 1 : -1;
  const normal = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    return [(s * dy) / len, (-s * dx) / len];
  };
  return pts.map((p, i) => {
    const n1 = normal(pts[(i + n - 1) % n], p);
    const n2 = normal(p, pts[(i + 1) % n]);
    const k = d / Math.max(0.2, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [p[0] + (n1[0] + n2[0]) * k, p[1] + (n1[1] + n2[1]) * k] as Pt;
  });
}

function polygonSigned(p: Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += p[i][0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * p[i][1];
  return s / 2;
}

/**
 * Programa G-code (mm, absoluto) para una fresadora CNC: Z=0 es la cara superior de la plancha.
 * Por pieza: huecos, rebajes y contorno exterior, con la fresa compensada por su radio.
 */
export function gcode(project: Project, result: NestingResult, options: Partial<GcodeOptions> = {}): string {
  const o = { ...DEFAULT_GCODE, ...options };
  const r = o.toolDiameter / 2;
  const f = (n: number) => n.toFixed(3);
  const out: string[] = [
    `( MuebleCAD - ${project.name} )`,
    `( Fresa ${o.toolDiameter} mm, avance ${o.feed} mm/min, pasada ${o.passDepth} mm )`,
    '( Z0 = cara superior de la plancha; origen X0 Y0 = esquina inferior izquierda )',
    'G21 G90 G17', `M3 S${o.spindle}`, `G0 Z${f(o.safeZ)}`,
  ];
  const levels = (total: number) => {
    const n = Math.max(1, Math.ceil(total / o.passDepth));
    return Array.from({ length: n }, (_, i) => -(total * (i + 1)) / n);
  };
  const loop = (pts: Pt[], total: number) => {
    out.push(`G0 Z${f(o.safeZ)}`, `G0 X${f(pts[0][0])} Y${f(pts[0][1])}`);
    for (const z of levels(total)) {
      out.push(`G1 Z${f(z)} F${o.plungeFeed}`);
      for (const p of pts.slice(1)) out.push(`G1 X${f(p[0])} Y${f(p[1])} F${o.feed}`);
      out.push(`G1 X${f(pts[0][0])} Y${f(pts[0][1])} F${o.feed}`);
    }
    out.push(`G0 Z${f(o.safeZ)}`);
  };
  const strip = (a: Pt, b: Pt, total: number) => {
    out.push(`G0 Z${f(o.safeZ)}`, `G0 X${f(a[0])} Y${f(a[1])}`);
    let forward = true;
    for (const z of levels(total)) {
      const [from, to] = forward ? [a, b] : [b, a];
      out.push(`G1 X${f(from[0])} Y${f(from[1])} F${o.feed}`, `G1 Z${f(z)} F${o.plungeFeed}`, `G1 X${f(to[0])} Y${f(to[1])} F${o.feed}`);
      forward = !forward;
    }
    out.push(`G0 Z${f(o.safeZ)}`);
  };

  for (const s of result.sheets) {
    out.push('', `( ===== ${s.material.name} - plancha ${s.index} (espesor ${s.material.thickness} mm) ===== )`);
    for (const pl of s.placements) {
      const part = project.parts.find((p) => p.id === pl.partId);
      const piece = placedPiece(part, pl, s.material.sheetH);
      const through = s.material.thickness + 0.3; // se pasa un poco para cortar limpio
      out.push(`( ${piece.name} )`);
      for (const hole of piece.holes) {
        const xs = hole.map((p) => p[0]), ys = hole.map((p) => p[1]);
        const fits = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) >= o.toolDiameter;
        if (fits) loop(offsetPolygon(hole, -r), through);
        else out.push('( hueco omitido: la fresa no cabe )');
      }
      for (const reb of piece.rebates) {
        if (reb.width > 2 * o.toolDiameter) { out.push(`( rebaje de ${reb.width} mm omitido: necesita más de 2 pasadas, usa otra fresa )`); continue; }
        if (reb.width <= o.toolDiameter) strip(reb.a, reb.b, reb.depth);
        else {
          // Dos pasadas pegadas a cada borde del rebaje.
          const dx = reb.b[0] - reb.a[0], dy = reb.b[1] - reb.a[1], len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len, ny = dx / len, k = (reb.width - o.toolDiameter) / 2;
          strip([reb.a[0] + nx * k, reb.a[1] + ny * k], [reb.b[0] + nx * k, reb.b[1] + ny * k], reb.depth);
          strip([reb.a[0] - nx * k, reb.a[1] - ny * k], [reb.b[0] - nx * k, reb.b[1] - ny * k], reb.depth);
        }
        out.push('( rebaje: se fresa por la cara superior )');
      }
      loop(offsetPolygon(piece.outer, r), through);
    }
  }
  out.push('', 'M5', 'G0 X0 Y0', 'M30');
  return out.join('\n');
}
