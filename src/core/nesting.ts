import type { Edges, Material, Part, PartShape, Project } from './types';
import { edgeMeters } from './edges';
import { isSolid } from './solids';

export interface CutPiece {
  partId: string;
  name: string;
  length: number;
  width: number;
  thickness: number;
  material: string;
}

export interface Placement {
  partId: string;
  name: string;
  x: number;
  y: number;
  /** Tamaño ocupado en la plancha (ya rotado si corresponde). */
  w: number;
  h: number;
  rotated: boolean;
}

/** Un corte de sierra de lado a lado (guillotina), numerado en el orden en que debe hacerse. */
export interface Cut {
  n: number;
  orientation: 'h' | 'v';
  /** Posición del corte: y si es horizontal, x si es vertical. */
  pos: number;
  from: number;
  to: number;
}

export interface Sheet {
  material: Material;
  index: number;
  placements: Placement[];
  cuts: Cut[];
  efficiency: number;
}

export interface NestingResult {
  sheets: Sheet[];
  unplaced: CutPiece[];
  warnings: string[];
}

/** length >= width >= thickness. La veta corre a lo largo de `length`. */
export function cutPiece(part: Part): CutPiece {
  const [length, width, thickness] = [...part.size].sort((a, b) => b - a);
  return { partId: part.id, name: part.name, length, width, thickness, material: part.material };
}

export interface CutListRow {
  material: string;
  length: number;
  width: number;
  thickness: number;
  qty: number;
  names: string[];
  edges: Edges;
  shaped: boolean;
  edgeMeters: number;
  rebates: string;
}

export function cutList(project: Project): CutListRow[] {
  const rows = new Map<string, CutListRow>();
  for (const part of project.parts) {
    if (project.materials.find((m) => m.id === part.material)?.purchased) continue;
    if (isSolid(part)) continue; // cilindros, tubos, prismas y revoluciones no se cortan de planchas: ver solidsList
    const p = cutPiece(part);
    const edges = part.edges ?? { largo: 0, ancho: 0 };
    const shaped = isShaped(part.shape);
    const rebates = rebateText(part);
    const key = `${p.material}|${p.length}|${p.width}|${p.thickness}|${edges.largo}${edges.ancho}|${shaped ? JSON.stringify(part.shape) : ''}|${rebates}`;
    const row = rows.get(key) ?? { material: p.material, length: p.length, width: p.width, thickness: p.thickness, qty: 0, names: [], edges, shaped, edgeMeters: 0, rebates };
    row.qty++;
    row.names.push(p.name);
    row.edgeMeters += edgeMeters(part);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.material.localeCompare(b.material) || b.length * b.width - a.length * a.width);
}

/** Descripción de los rebajes de una pieza, vacía si no tiene. */
export function rebateText(part: Part): string {
  if (!part.rebates?.length) return '';
  return part.rebates.map((r) => `rebaje ${r.width}×${r.depth} mm en canto ${r.edge % 2 === 0 ? 'largo' : 'corto'}`).join(', ');
}

export function isShaped(shape?: PartShape): boolean {
  return !!shape && (!!shape.radius || !!shape.notch || !!shape.holes?.length);
}

interface Rect { x: number; y: number; w: number; h: number }
type SplitRule = 'short' | 'long' | 'h' | 'v';

/** Plancha con cortes de guillotina: cada pieza que se coloca divide el rectángulo libre con dos cortes de lado a lado. */
class Bin {
  free: Rect[];
  placements: Placement[] = [];
  cuts: Omit<Cut, 'n'>[] = [];
  constructor(w: number, h: number, private kerf: number) {
    this.free = [{ x: 0, y: 0, w, h }];
  }

  /** Best Short Side Fit sobre los rectángulos libres. */
  find(w: number, h: number, canRotate: boolean) {
    let best: { rect: Rect; rotated: boolean; score: [number, number] } | null = null;
    for (const f of this.free) {
      for (const rotated of canRotate && w !== h ? [false, true] : [false]) {
        const iw = rotated ? h : w;
        const ih = rotated ? w : h;
        if (iw > f.w || ih > f.h) continue;
        const score: [number, number] = [Math.min(f.w - iw, f.h - ih), Math.max(f.w - iw, f.h - ih)];
        if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
          best = { rect: f, rotated, score };
        }
      }
    }
    return best;
  }

  place(f: Rect, iw: number, ih: number, rotated: boolean, piece: CutPiece, rule: SplitRule) {
    const k = this.kerf / 2;
    const lw = f.w - iw;
    const lh = f.h - ih;
    const horizontalFirst = rule === 'h' ? true : rule === 'v' ? false : rule === 'short' ? lw <= lh : lw > lh;
    this.free = this.free.filter((r) => r !== f);
    if (horizontalFirst) {
      if (lh > 0) {
        this.cuts.push({ orientation: 'h', pos: f.y + ih - k, from: f.x, to: f.x + f.w });
        this.free.push({ x: f.x, y: f.y + ih, w: f.w, h: lh });
      }
      if (lw > 0) {
        this.cuts.push({ orientation: 'v', pos: f.x + iw - k, from: f.y, to: f.y + ih });
        this.free.push({ x: f.x + iw, y: f.y, w: lw, h: ih });
      }
    } else {
      if (lw > 0) {
        this.cuts.push({ orientation: 'v', pos: f.x + iw - k, from: f.y, to: f.y + f.h });
        this.free.push({ x: f.x + iw, y: f.y, w: lw, h: f.h });
      }
      if (lh > 0) {
        this.cuts.push({ orientation: 'h', pos: f.y + ih - k, from: f.x, to: f.x + iw });
        this.free.push({ x: f.x, y: f.y + ih, w: iw, h: lh });
      }
    }
    this.placements.push({ partId: piece.partId, name: piece.name, x: f.x, y: f.y, w: iw - this.kerf, h: ih - this.kerf, rotated });
  }
}

const SORTS: ((a: CutPiece, b: CutPiece) => number)[] = [
  (a, b) => b.length * b.width - a.length * a.width,
  (a, b) => b.length - a.length || b.width - a.width,
  (a, b) => b.width - a.width || b.length - a.length,
];
const RULES: SplitRule[] = ['short', 'long', 'h', 'v'];

function packMaterial(material: Material, pieces: CutPiece[], kerf: number, sort: number, rule: SplitRule) {
  const bins: Bin[] = [];
  const unplaced: CutPiece[] = [];
  for (const piece of [...pieces].sort(SORTS[sort])) {
    // Se empaqueta con el kerf sumado para que quede un corte de sierra entre piezas.
    const w = piece.length + kerf;
    const h = piece.width + kerf;
    const canRotate = !material.grain;
    let done = false;
    for (const bin of bins) {
      const hit = bin.find(w, h, canRotate);
      if (hit) {
        bin.place(hit.rect, hit.rotated ? h : w, hit.rotated ? w : h, hit.rotated, piece, rule);
        done = true;
        break;
      }
    }
    if (done) continue;
    const bin = new Bin(material.sheetW + kerf, material.sheetH + kerf, kerf);
    const hit = bin.find(w, h, canRotate);
    if (!hit) { unplaced.push(piece); continue; }
    bin.place(hit.rect, hit.rotated ? h : w, hit.rotated ? w : h, hit.rotated, piece, rule);
    bins.push(bin);
  }
  const used = bins.map((b) => b.placements.reduce((s, p) => s + p.w * p.h, 0));
  // Menos planchas primero; a igualdad, concentrar el uso (deja una plancha casi libre para recortes).
  return { bins, unplaced, score: [bins.length, -used.reduce((s, u) => s + u * u, 0)] as [number, number] };
}

export function nest(project: Project): NestingResult {
  const result: NestingResult = { sheets: [], unplaced: [], warnings: [] };
  const kerf = project.kerf;

  for (const material of project.materials) {
    if (material.purchased) continue;
    const pieces = project.parts.filter((p) => p.material === material.id && !isSolid(p)).map(cutPiece);
    if (!pieces.length) continue;

    for (const piece of pieces) {
      if (Math.abs(piece.thickness - material.thickness) > 0.5) {
        result.warnings.push(`"${piece.name}" mide ${piece.thickness} mm de espesor pero ${material.name} es de ${material.thickness} mm.`);
      }
    }

    let best: ReturnType<typeof packMaterial> | null = null;
    for (let s = 0; s < SORTS.length; s++) {
      for (const rule of RULES) {
        const trial = packMaterial(material, pieces, kerf, s, rule);
        if (!best || trial.score[0] < best.score[0] || (trial.score[0] === best.score[0] && trial.score[1] < best.score[1])) best = trial;
      }
    }
    if (!best) continue;
    for (const piece of best.unplaced) {
      result.unplaced.push(piece);
      result.warnings.push(`"${piece.name}" (${piece.length}×${piece.width}) no cabe en una plancha de ${material.sheetW}×${material.sheetH}.`);
    }
    best.bins.forEach((bin, i) => {
      const used = bin.placements.reduce((s, p) => s + p.w * p.h, 0);
      result.sheets.push({
        material,
        index: i + 1,
        placements: bin.placements,
        cuts: bin.cuts.map((c, n) => ({ ...c, n: n + 1 })),
        efficiency: used / (material.sheetW * material.sheetH),
      });
    });
  }
  return result;
}
