import DxfParser from 'dxf-parser';
import { aciToHex, isHexColor } from './aci';
import { validateEntity } from './drawing';
import { arcSteps, bulgeArc, dimGeometry, dist, entityBounds, norm360, tessellateArc, tessellateCircle, tessellatePoly } from './geom2d';
import { blockCtx, checkBlockName, transformEntityMat } from './blocks';
import { DEFAULT_SPACING, hatchGeometry } from './hatch';
import type { ArcEntity, Block as DrawingBlock, DimAlignedEntity, DimLinearEntity, Drawing, DrawingColor, Entity, HatchEntity, HatchPattern, InsertEntity, Layer, PolyVertex, Pt2 } from './types';

/**
 * DXF <-> Drawing (dibujo 2D). Funciones puras, sin DOM ni servidor. Contrato: docs/dibujo-2d.md, sección "Importar y exportar".
 * Exporta DXF R2000 (AC1015); importa lo que lee dxf-parser más bloques, cotas y curvas aproximadas.
 */

// ================================================================= exportar

export interface DxfExportOptions {
  /** Fin de línea. Por omisión CRLF, igual que el DXF de planchas (export.ts). */
  eol?: '\r\n' | '\n';
  /** Con varios dibujos, antepone el nombre del dibujo a cada capa ("Planta-Muros"). Por omisión true si hay más de uno. */
  prefixLayers?: boolean;
  /** Altura del texto de las cotas (mm); por omisión la de `dimGeometry`. */
  dimTextH?: number;
  /** Escribe también el color verdadero (420) de los colores "#rrggbb" además del ACI más cercano. Por omisión true. */
  trueColor?: boolean;
}

const DEC = 6;
const fnum = (n: number): string => {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(DEC);
  const t = s.replace(/0+$/, '').replace(/\.$/, '');
  return t === '-0' ? '0' : t;
};

/** Texto ASCII para DXF R2000: Ø, ° y ± pasan a los códigos %%c, %%d, %%p; los acentos se normalizan como en export.ts. */
export function dxfAscii(s: string): string {
  return s.replace(/Ø/g, '%%c').replace(/°/g, '%%d').replace(/±/g, '%%p')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, '?');
}
const safeLayerName = (s: string): string => (s.replace(/[<>/\\":;?*|=`,\r\n]/g, '_').trim().slice(0, 250) || '_');

let acaTable: { aci: number; rgb: [number, number, number] }[] | null = null;
const hexRgb = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
/** Índice ACI (1..254) más cercano a un color "#rrggbb". */
export function nearestAci(hex: string): number {
  acaTable ??= Array.from({ length: 254 }, (_, i) => ({ aci: i + 1, rgb: hexRgb(aciToHex(i + 1, true)) }));
  const [r, g, b] = hexRgb(hex);
  if (r === 255 && g === 255 && b === 255) return 7;
  if (r === 0 && g === 0 && b === 0) return 7;
  let best = 7, bd = Infinity;
  for (const t of acaTable) {
    const d = (t.rgb[0] - r) ** 2 + (t.rgb[1] - g) ** 2 + (t.rgb[2] - b) ** 2;
    if (d < bd) { bd = d; best = t.aci; }
  }
  return best;
}

const VALID_LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const lwCode = (mm: number): number => { const c = mm * 100; return VALID_LW.reduce((a, b) => (Math.abs(b - c) < Math.abs(a - c) ? b : a)); };

const LTYPES: Record<string, { name: string; desc: string; pat: number[] }> = {
  continuous: { name: 'CONTINUOUS', desc: 'Solid line', pat: [] },
  dashed: { name: 'DASHED', desc: 'Dashed __ __ __ __', pat: [12, -6] },
  center: { name: 'CENTER', desc: 'Center ____ _ ____ _', pat: [32, -6, 6, -6] },
};

interface ExportSource { drawing: Drawing; prefix: string }

/**
 * DXF R2000 (AC1015) de uno o varios dibujos. Líneas, polilíneas ligeras (con bulge y cerradas), círculos, arcos (grados) y textos ASCII.
 * Las cotas se exportan como líneas + texto sueltos (sin DIMENSION nativa). Un arco con a0 == a1 (vuelta completa) sale como CIRCLE.
 * Las coordenadas son las del plano del dibujo (x, y); el plano 3D y el origen no se exportan. Con varios dibujos las capas llevan prefijo.
 */
export function drawingToDxf(input: Drawing | Drawing[], opts: DxfExportOptions = {}): string {
  const drawings = Array.isArray(input) ? input : [input];
  const eol = opts.eol ?? '\r\n';
  const prefixLayers = opts.prefixLayers ?? drawings.length > 1;
  const trueColor = opts.trueColor ?? true;

  let seed = 0x1f; // handles bajos reservados para el esqueleto
  const H = (): string => (++seed).toString(16).toUpperCase();
  const out: string[] = [];
  const g = (code: number, v: string | number): void => { out.push(String(code), typeof v === 'number' ? fnum(v) : v); };

  // ---- capas finales (nombres únicos sin distinguir mayúsculas)
  interface OutLayer { name: string; layer: Layer }
  const layers: OutLayer[] = [{ name: '0', layer: { name: '0', color: 7, linetype: 'continuous', on: true, frozen: false, locked: false } }];
  const used = new Set<string>(['0']);
  const src: ExportSource[] = drawings.map((drawing) => ({ drawing, prefix: prefixLayers ? `${drawing.name}-` : '' }));
  const layerName = new Map<Drawing, Map<string, string>>();
  const claim = (raw: string, layer: Layer): string => {
    let n = safeLayerName(raw), k = 2;
    const base = n;
    while (used.has(n.toLowerCase())) n = `${base}_${k++}`;
    used.add(n.toLowerCase());
    layers.push({ name: n, layer });
    return n;
  };
  for (const { drawing, prefix } of src) {
    const m = new Map<string, string>();
    layerName.set(drawing, m);
    for (const l of drawing.layers) {
      if (l.name === '0' && !prefix) { layers[0].layer = { ...l, name: '0' }; m.set('0', '0'); continue; }
      m.set(l.name, claim(prefix + l.name, l));
    }
    for (const e of drawing.entities) if (!m.has(e.layer)) m.set(e.layer, e.layer === '0' && !prefix ? '0' : claim(prefix + e.layer, { name: e.layer, color: 7, linetype: 'continuous', on: true, frozen: false, locked: false }));
  }

  // ---- extensión
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const ext = (x: number, y: number): void => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };

  // ---- entidades (se escriben primero para conocer extensión y $HANDSEED; el orden de handles no importa)
  const MS = '1F'; // BLOCK_RECORD *Model_Space
  let owner = MS; // dueño de las entidades que se escriben (el espacio modelo o el BLOCK_RECORD de un bloque)
  const colorCodes = (c: DrawingColor | undefined): void => {
    if (c === undefined) return;
    if (isHexColor(c)) { g(62, nearestAci(c)); if (trueColor) g(420, parseInt(c.slice(1), 16)); }
    else g(62, c as number);
  };
  const head = (type: string, layer: string, color: DrawingColor | undefined, sub: string): void => {
    g(0, type); g(5, H()); g(330, owner); g(100, 'AcDbEntity'); g(8, layer); colorCodes(color); g(100, sub);
  };
  const pt3 = (c10: number, p: Pt2): void => { g(c10, p[0]); g(c10 + 10, p[1]); g(c10 + 20, 0); ext(p[0], p[1]); };

  const ents: string[] = [];
  const emitLine = (layer: string, color: DrawingColor | undefined, a: Pt2, b: Pt2): void => { head('LINE', layer, color, 'AcDbLine'); pt3(10, a); pt3(11, b); };
  const emitText = (layer: string, color: DrawingColor | undefined, t: { p: Pt2; h: number; s: string; rot?: number; align?: string }): void => {
    const s = dxfAscii(t.s);
    if (!s) return;
    head('TEXT', layer, color, 'AcDbText');
    pt3(10, t.p); g(40, t.h); g(1, s);
    if (t.rot) g(50, norm360(t.rot));
    g(7, 'STANDARD');
    const ha = t.align === 'center' ? 1 : t.align === 'right' ? 2 : 0;
    if (ha) { g(72, ha); pt3(11, t.p); }
    g(100, 'AcDbText'); g(73, 0);
    // el texto no suma a la extensión más que su ancla; añade una caja aproximada para que el zoom lo incluya
    const w = s.length * 0.6 * t.h; ext(t.p[0] - w, t.p[1] - t.h); ext(t.p[0] + w, t.p[1] + t.h);
  };
  let sink: string[] = ents;
  const flush = (): void => { for (const s of out.splice(0)) sink.push(s); };
  const emitPoint = (layer: string, color: DrawingColor | undefined, p: Pt2): void => { head('POINT', layer, color, 'AcDbPoint'); pt3(10, p); };

  // ---- bloques (BLOCK / BLOCK_RECORD / INSERT nativos)
  interface OutBlock { dxfName: string; handle: string; block: DrawingBlock; drawing: Drawing }
  const outBlocks: OutBlock[] = [];
  const blockNameMap = new Map<Drawing, Map<string, string>>();
  const usedBlockNames = new Set<string>(['*model_space', '*paper_space']);
  for (const { drawing, prefix } of src) {
    const m = new Map<string, string>();
    blockNameMap.set(drawing, m);
    for (const b of drawing.blocks ?? []) {
      let n = safeLayerName(prefix + b.name), k = 2;
      const base = n;
      while (usedBlockNames.has(n.toLowerCase())) n = `${base}_${k++}`;
      usedBlockNames.add(n.toLowerCase());
      m.set(b.name.toLowerCase(), n);
      outBlocks.push({ dxfName: n, handle: H(), block: b, drawing });
    }
  }

  /** Sombreado: HATCH nativo para solid / lines / cross / ansi31 (se reimporta idéntico); el resto (puntos, ladrillo, concreto, madera) como líneas y puntos sueltos. */
  const HATCH_DXF: Partial<Record<HatchPattern, { name: string; defs: number[] }>> = { solid: { name: 'SOLID', defs: [] }, lines: { name: 'LINE', defs: [0] }, cross: { name: 'NET', defs: [0, 90] }, ansi31: { name: 'ANSI31', defs: [45] } };
  const emitHatch = (layer: string, e: HatchEntity): void => {
    const nat = HATCH_DXF[e.pattern];
    const bb = entityBounds(e);
    if (bb) { ext(bb.min[0], bb.min[1]); ext(bb.max[0], bb.max[1]); }
    if (!nat) {
      const geo = hatchGeometry(e);
      for (const [a, b] of geo.segments) emitLine(layer, e.color, a, b);
      for (const p of geo.dots) emitPoint(layer, e.color, p);
      return;
    }
    head('HATCH', layer, e.pattern === 'solid' ? e.fillColor ?? e.color : e.color, 'AcDbHatch');
    g(10, 0); g(20, 0); g(30, 0); g(210, 0); g(220, 0); g(230, 1);
    g(2, nat.name); g(70, e.pattern === 'solid' ? 1 : 0); g(71, 0);
    g(91, e.loops.length);
    e.loops.forEach((l, i) => {
      const bulge = l.some((v) => v.bulge);
      g(92, i === 0 ? 3 : 2); g(72, bulge ? 1 : 0); g(73, 1); g(93, l.length);
      for (const v of l) { g(10, v.p[0]); g(20, v.p[1]); if (bulge) g(42, v.bulge ?? 0); }
      g(97, 0);
    });
    g(75, 0); g(76, 1);
    if (nat.defs.length) {
      g(52, e.angle ?? 0); g(41, 1); g(77, 0); g(78, nat.defs.length);
      for (const a of nat.defs) { g(53, a); g(43, 0); g(44, 0); g(45, 0); g(46, e.scale ?? DEFAULT_SPACING); g(79, 0); }
    }
    g(47, 1); g(98, 0);
  };

  const emitEntity = (drawing: Drawing, names: Map<string, string>, e: Entity, inBlock: boolean): void => {
      const layer = inBlock && e.layer === '0' ? '0' : (names.get(e.layer) ?? '0'); // en un bloque la capa 0 hereda la del INSERT
      switch (e.type) {
        case 'hatch': emitHatch(layer, e); break;
        case 'insert': {
          const bn = blockNameMap.get(drawing)?.get(e.block.toLowerCase());
          if (!bn) break;
          head('INSERT', layer, e.color, 'AcDbBlockReference'); g(2, bn); pt3(10, e.p);
          const sx = e.sx ?? 1, sy = e.sy ?? 1;
          if (sx !== 1 || sy !== 1) { g(41, sx); g(42, sy); g(43, 1); }
          if (e.rot) g(50, norm360(e.rot));
          if ((e.cols ?? 1) > 1 || (e.rows ?? 1) > 1) { g(70, e.cols ?? 1); g(71, e.rows ?? 1); g(44, e.dx ?? 0); g(45, e.dy ?? 0); }
          const ib = entityBounds(e, blockCtx(drawing));
          if (ib) { ext(ib.min[0], ib.min[1]); ext(ib.max[0], ib.max[1]); }
          break;
        }
        case 'line': emitLine(layer, e.color, e.a, e.b); break;
        case 'poly':
          head('LWPOLYLINE', layer, e.color, 'AcDbPolyline');
          g(90, String(e.pts.length)); g(70, e.closed ? '1' : '0'); g(43, 0);
          for (const v of e.pts) { g(10, v.p[0]); g(20, v.p[1]); if (v.bulge) g(42, v.bulge); ext(v.p[0], v.p[1]); }
          // los arcos de los bulges pueden salirse de la caja de sus vértices
          for (let i = 0; i < e.pts.length; i++) {
            const v = e.pts[i];
            if (!v.bulge) continue;
            const nx = e.pts[i + 1] ?? (e.closed ? e.pts[0] : undefined);
            if (!nx) continue;
            const a = bulgeArc(v.p, nx.p, v.bulge);
            if (a) { ext(a.c[0] - a.r, a.c[1] - a.r); ext(a.c[0] + a.r, a.c[1] + a.r); }
          }
          break;
        case 'circle':
          head('CIRCLE', layer, e.color, 'AcDbCircle'); pt3(10, e.c); g(40, e.r); ext(e.c[0] - e.r, e.c[1] - e.r); ext(e.c[0] + e.r, e.c[1] + e.r);
          break;
        case 'arc':
          if (Math.abs(norm360(e.a1 - e.a0)) < 1e-9) { head('CIRCLE', layer, e.color, 'AcDbCircle'); pt3(10, e.c); g(40, e.r); }
          else { head('ARC', layer, e.color, 'AcDbCircle'); pt3(10, e.c); g(40, e.r); g(100, 'AcDbArc'); g(50, norm360(e.a0)); g(51, norm360(e.a1)); }
          ext(e.c[0] - e.r, e.c[1] - e.r); ext(e.c[0] + e.r, e.c[1] + e.r);
          break;
        case 'text': emitText(layer, e.color, e); break;
        case 'dim': {
          const geo = dimGeometry(e, opts.dimTextH ? { textH: opts.dimTextH } : {});
          flush();
          for (const [a, b] of geo.lines) emitLine(layer, e.color, a, b);
          for (const t of geo.texts) emitText(layer, e.color, t);
          break;
        }
      }
      flush();
  };
  const blockEnts = new Map<OutBlock, string[]>();
  for (const ob of outBlocks) {
    const buf: string[] = [];
    sink = buf; owner = ob.handle;
    const names = layerName.get(ob.drawing)!;
    for (const e of ob.block.entities) emitEntity(ob.drawing, names, e, true);
    blockEnts.set(ob, buf);
  }
  sink = ents; owner = MS;
  for (const { drawing } of src) {
    const names = layerName.get(drawing)!;
    for (const e of drawing.entities) emitEntity(drawing, names, e, false);
  }
  if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 420; y1 = 297; }

  // ---- ensamblado
  const T = (name: string, count: number, handle: string): void => { g(0, 'TABLE'); g(2, name); g(5, handle); g(330, '0'); g(100, 'AcDbSymbolTable'); g(70, String(count)); };
  const rec = (type: string, handle: string, owner: string, sub: string): void => { g(0, type); g(5, handle); g(330, owner); g(100, 'AcDbSymbolTableRecord'); g(100, sub); };

  const hLayerTable = H(), hLtypeTable = H(), hStyleTable = H(), hVportTable = H(), hViewTable = H(), hUcsTable = H(), hAppidTable = H(), hDimTable = H(), hBrTable = H();
  const hStyle = H(),hLtByBlock = H(), hLtByLayer = H(), hLtCont = H();
  const hLayer0 = H();
  const hRootDict = H(), hGroupDict = H();

  // HEADER (al final se conoce el seed)
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, vh = Math.max(y1 - y0, (x1 - x0) / 1.5, 10) * 1.1;
  const body: string[] = [];
  const swap = (): void => { for (const s of out.splice(0)) body.push(s); };

  g(0, 'SECTION'); g(2, 'CLASSES'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  // VPORT
  T('VPORT', 1, hVportTable);
  rec('VPORT', H(), hVportTable, 'AcDbViewportTableRecord');
  g(2, '*Active'); g(70, '0'); g(10, 0); g(20, 0); g(11, 1); g(21, 1); g(12, cx); g(22, cy); g(13, 0); g(23, 0); g(14, 10); g(24, 10); g(15, 10); g(25, 10);
  g(16, 0); g(26, 0); g(36, 1); g(17, 0); g(27, 0); g(37, 0); g(40, vh); g(41, 1.5); g(42, 50); g(43, 0); g(44, 0); g(50, 0); g(51, 0);
  g(71, '0'); g(72, '100'); g(73, '1'); g(74, '3'); g(75, '0'); g(76, '0'); g(77, '0'); g(78, '0');
  g(0, 'ENDTAB');
  // LTYPE
  T('LTYPE', 3 + 2, hLtypeTable);
  for (const [name, h] of [['ByBlock', hLtByBlock], ['ByLayer', hLtByLayer]] as const) { rec('LTYPE', h, hLtypeTable, 'AcDbLinetypeTableRecord'); g(2, name); g(70, '0'); g(3, ''); g(72, '65'); g(73, '0'); g(40, 0); }
  const ltHandle: Record<string, string> = {};
  for (const key of Object.keys(LTYPES)) {
    const lt = LTYPES[key];
    const h = key === 'continuous' ? hLtCont : H();
    ltHandle[key] = h;
    rec('LTYPE', h, hLtypeTable, 'AcDbLinetypeTableRecord');
    g(2, lt.name); g(70, '0'); g(3, lt.desc); g(72, '65'); g(73, String(lt.pat.length)); g(40, lt.pat.reduce((s, v) => s + Math.abs(v), 0));
    for (const v of lt.pat) { g(49, v); g(74, '0'); }
  }
  g(0, 'ENDTAB');
  // LAYER
  T('LAYER', layers.length, hLayerTable);
  layers.forEach((ol, i) => {
    const l = ol.layer;
    const flags = (l.frozen ? 1 : 0) | (l.locked ? 4 : 0);
    const aci = isHexColor(l.color) ? nearestAci(l.color) : (l.color as number);
    rec('LAYER', i === 0 ? hLayer0 : H(), hLayerTable, 'AcDbLayerTableRecord');
    g(2, ol.name); g(70, String(flags)); g(62, String(l.on ? aci : -aci));
    if (isHexColor(l.color) && trueColor) g(420, parseInt(l.color.slice(1), 16));
    g(6, LTYPES[l.linetype ?? 'continuous'].name);
    if (l.lineweight) g(370, String(lwCode(l.lineweight)));
  });
  g(0, 'ENDTAB');
  // STYLE
  T('STYLE', 1, hStyleTable);
  rec('STYLE', hStyle, hStyleTable, 'AcDbTextStyleTableRecord');
  g(2, 'STANDARD'); g(70, '0'); g(40, 0); g(41, 1); g(50, 0); g(71, '0'); g(42, 2.5); g(3, 'txt'); g(4, '');
  g(0, 'ENDTAB');
  // VIEW, UCS
  T('VIEW', 0, hViewTable); g(0, 'ENDTAB');
  T('UCS', 0, hUcsTable); g(0, 'ENDTAB');
  // APPID
  T('APPID', 1, hAppidTable);
  rec('APPID', H(), hAppidTable, 'AcDbRegAppTableRecord'); g(2, 'ACAD'); g(70, '0');
  g(0, 'ENDTAB');
  // DIMSTYLE
  T('DIMSTYLE', 1, hDimTable); g(100, 'AcDbDimStyleTable'); g(71, '1');
  g(0, 'DIMSTYLE'); g(105, H()); g(330, hDimTable); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbDimStyleTableRecord');
  g(2, 'STANDARD'); g(70, '0'); g(340, hStyle);
  g(0, 'ENDTAB');
  // BLOCK_RECORD
  const hPsRec = H();
  T('BLOCK_RECORD', 2 + outBlocks.length, hBrTable);
  rec('BLOCK_RECORD', MS, hBrTable, 'AcDbBlockTableRecord'); g(2, '*Model_Space');
  rec('BLOCK_RECORD', hPsRec, hBrTable, 'AcDbBlockTableRecord'); g(2, '*Paper_Space');
  for (const ob of outBlocks) { rec('BLOCK_RECORD', ob.handle, hBrTable, 'AcDbBlockTableRecord'); g(2, ob.dxfName); }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  // BLOCKS
  g(0, 'SECTION'); g(2, 'BLOCKS');
  for (const [name, br, ps] of [['*Model_Space', MS, false], ['*Paper_Space', hPsRec, true]] as const) {
    g(0, 'BLOCK'); g(5, H()); g(330, br); g(100, 'AcDbEntity'); if (ps) g(67, '1'); g(8, '0'); g(100, 'AcDbBlockBegin'); g(2, name); g(70, '0'); g(10, 0); g(20, 0); g(30, 0); g(3, name); g(1, '');
    g(0, 'ENDBLK'); g(5, H()); g(330, br); g(100, 'AcDbEntity'); if (ps) g(67, '1'); g(8, '0'); g(100, 'AcDbBlockEnd');
  }
  for (const ob of outBlocks) {
    g(0, 'BLOCK'); g(5, H()); g(330, ob.handle); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockBegin'); g(2, ob.dxfName); g(70, '0'); g(10, ob.block.base[0]); g(20, ob.block.base[1]); g(30, 0); g(3, ob.dxfName); g(1, '');
    for (const s of blockEnts.get(ob)!) out.push(s);
    g(0, 'ENDBLK'); g(5, H()); g(330, ob.handle); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockEnd');
  }
  g(0, 'ENDSEC');
  swap();

  const tail: string[] = [];
  g(0, 'SECTION'); g(2, 'OBJECTS');
  g(0, 'DICTIONARY'); g(5, hRootDict); g(330, '0'); g(100, 'AcDbDictionary'); g(281, '1'); g(3, 'ACAD_GROUP'); g(350, hGroupDict);
  g(0, 'DICTIONARY'); g(5, hGroupDict); g(330, hRootDict); g(100, 'AcDbDictionary'); g(281, '1');
  g(0, 'ENDSEC'); g(0, 'EOF');
  for (const s of out.splice(0)) tail.push(s);

  // HEADER
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1015');
  g(9, '$HANDSEED'); g(5, (seed + 1).toString(16).toUpperCase());
  g(9, '$INSBASE'); g(10, 0); g(20, 0); g(30, 0);
  g(9, '$EXTMIN'); g(10, x0); g(20, y0); g(30, 0);
  g(9, '$EXTMAX'); g(10, x1); g(20, y1); g(30, 0);
  g(9, '$LIMMIN'); g(10, 0); g(20, 0);
  g(9, '$LIMMAX'); g(10, 420); g(20, 297);
  g(9, '$LTSCALE'); g(40, 1);
  g(9, '$TEXTSTYLE'); g(7, 'STANDARD');
  g(9, '$CLAYER'); g(8, '0');
  g(9, '$LUNITS'); g(70, '2'); g(9, '$LUPREC'); g(70, '4');
  g(9, '$MEASUREMENT'); g(70, '1');
  g(9, '$INSUNITS'); g(70, '4');
  g(9, '$DWGCODEPAGE'); g(3, 'ANSI_1252');
  g(0, 'ENDSEC');
  const headerLines = out.splice(0);

  const lines = [...headerLines, ...body, '0', 'SECTION', '2', 'ENTITIES', ...ents, '0', 'ENDSEC', ...tail];
  return lines.join(eol) + eol;
}

/** Un DXF por dibujo ({ name, text }), con nombre de archivo saneado y sin repetir. Las capas no llevan prefijo. */
export function drawingsToDxfFiles(drawings: Drawing[], opts: DxfExportOptions = {}): { name: string; text: string }[] {
  const seen = new Set<string>();
  return drawings.map((d) => {
    const base = d.name.replace(/[^\w\- .()]+/g, '_').trim() || d.id;
    let n = base, k = 2;
    while (seen.has(n.toLowerCase())) n = `${base}_${k++}`;
    seen.add(n.toLowerCase());
    return { name: `${n}.dxf`, text: drawingToDxf(d, { ...opts, prefixLayers: false }) };
  });
}

// ================================================================= importar

export type DxfUnits = 'auto' | 'mm' | 'cm' | 'm' | 'in' | 'ft';


export interface DxfImportOptions {
  /** Nombre del dibujo creado (por omisión "Importado"). */
  name?: string;
  id?: string;
  plane?: Drawing['plane'];
  /** Unidades del archivo: 'auto' (usa $INSUNITS; sin unidades se asume mm) o forzadas; un número es el factor a mm. */
  units?: DxfUnits | number;
  /** Tolerancia (mm) al aproximar splines y elipses por polilíneas. Por omisión 0.1. */
  tolerance?: number;
  /** Descarta las cotas (DIMENSION) y las capas de cotas (nombres tipo "Cotas", "DIM", "A-ANNO-DIMS", "Defpoints"). */
  dropDimensions?: boolean;
  /** Descarta capas congeladas (y sus entidades). */
  dropFrozen?: boolean;
  /** Descarta capas apagadas (off). */
  dropOff?: boolean;
  /** Capas a descartar por nombre exacto (sin distinguir mayúsculas) o por expresión regular. */
  dropLayers?: (string | RegExp)[];
  /** Importa también el espacio papel (por omisión solo el espacio modelo). */
  includePaperSpace?: boolean;
  /** Tope de entidades importadas; el resto se omite con aviso. Por omisión 1 000 000. */
  maxEntities?: number;
  /** Los INSERT se explotan en entidades sueltas (comportamiento anterior). Por omisión false: los BLOCK se conservan como `blocks` editables y cada INSERT como `insert`. */
  explodeBlocks?: boolean;
}

export interface DxfImportResult {
  drawing: Drawing;
  warnings: string[];
  stats: {
    /** Entidades DXF leídas por tipo (las de bloques cuentan cada vez que se insertan). */
    imported: Record<string, number>;
    /** Tipos no importados (o descartados por opción) y cuántas había. */
    omitted: Record<string, number>;
    /** Entidades resultantes en el dibujo. */
    entities: number;
  };
  units: { factor: number; source: string };
}

type Pt = { x: number; y: number; z?: number };
interface Ent {
  type: string; layer?: string; handle?: string; colorIndex?: number; color?: number; visible?: boolean; inPaperSpace?: boolean;
  vertices?: (Pt & { bulge?: number })[]; shape?: boolean; closed?: boolean; center?: Pt; radius?: number; startAngle?: number; endAngle?: number;
  startPoint?: Pt; endPoint?: Pt; textHeight?: number; text?: string; rotation?: number; halign?: number; valign?: number;
  position?: Pt; height?: number; attachmentPoint?: number; directionVector?: Pt;
  name?: string; xScale?: number; yScale?: number; zScale?: number; columnCount?: number; rowCount?: number; columnSpacing?: number; rowSpacing?: number;
  majorAxisEndPoint?: Pt; axisRatio?: number; controlPoints?: Pt[]; fitPoints?: Pt[]; knotValues?: number[]; degreeOfSplineCurve?: number; periodic?: boolean; rational?: boolean;
  points?: Pt[]; block?: string; dimensionType?: number; anchorPoint?: Pt; middleOfText?: Pt; linearOrAngularPoint1?: Pt; linearOrAngularPoint2?: Pt; diameterOrRadiusPoint?: Pt; angle?: number;
  actualMeasurement?: number; extrusionDirection?: Pt; extrusionDirectionZ?: number; is3dPolygonMesh?: boolean; isPolyfaceMesh?: boolean;
}
interface Block { name?: string; position?: Pt; entities?: Ent[] }

/** Mat = [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
type Mat = [number, number, number, number, number, number];
const mmul = (A: Mat, B: Mat): Mat => [
  A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
  A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
  A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
];
const mpt = (m: Mat, p: Pt2): Pt2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

/** Factor a mm de cada código de $INSUNITS. */
const INSUNITS_MM: Record<number, [number, string]> = {
  1: [25.4, 'pulgadas'], 2: [304.8, 'pies'], 3: [1609344, 'millas'], 4: [1, 'mm'], 5: [10, 'cm'], 6: [1000, 'm'], 7: [1e6, 'km'],
  8: [2.54e-5, 'microplgs'], 9: [0.0254, 'milésimas de pulgada'], 10: [914.4, 'yardas'], 11: [1e-7, 'ángstroms'], 12: [1e-6, 'nm'], 13: [1e-3, 'µm'], 14: [100, 'dm'],
};
const NAMED_UNITS: Record<Exclude<DxfUnits, 'auto'>, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

const DIM_LAYER = /(^|[^a-z])(cotas?|dims?|dimension(es|s)?)([^a-z]|$)|^defpoints$/i;
const NOT_DRAWN = new Set(['POINT', 'IMAGE', 'LEADER', 'MLEADER', 'MLINE', 'WIPEOUT', 'VIEWPORT', 'ATTRIB', 'ATTDEF', 'REGION', '3DSOLID', 'BODY', 'RAY', 'XLINE', 'TRACE', 'OLE2FRAME', 'TOLERANCE', 'SHAPE', 'ACAD_TABLE', 'MESH', 'SURFACE', 'UNDERLAY', 'PDFUNDERLAY']);


// ---- HATCH: dxf-parser no lo entrega, se lee a mano del texto (secciones ENTITIES y BLOCKS)

interface RawHatch {
  block?: string; paper: boolean; layer: string; aci?: number; tc?: number; name: string; solid: boolean;
  loops: (PolyVertex[] | null)[]; angle: number; scale: number; defs: { ang: number; dx: number; dy: number }[];
}

function scanHatches(text: string): RawHatch[] {
  if (!/^[ \t]*HATCH[ \t]*\r?$/m.test(text)) return [];
  const lines = text.split(/\r?\n/);
  const ps: [number, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) ps.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  const num = (j: number): number => Number(ps[j]?.[1]);
  const out: RawHatch[] = [];
  let section = '', block: string | undefined;

  const parseLoops = (start: number, count: number): { j: number; loops: (PolyVertex[] | null)[] } => {
    let j = start;
    const loops: (PolyVertex[] | null)[] = [];
    for (let l = 0; l < count; l++) {
      if (ps[j]?.[0] !== 92) { while (j < ps.length && ps[j][0] !== 92 && ps[j][0] !== 75 && ps[j][0] !== 0) j++; if (ps[j]?.[0] !== 92) break; }
      const flags = parseInt(ps[j][1], 10); j++;
      let verts: PolyVertex[] | null = [];
      if (flags & 2) {
        let hasBulge = false;
        while (ps[j] && (ps[j][0] === 72 || ps[j][0] === 73)) { if (ps[j][0] === 72) hasBulge = ps[j][1] === '1'; j++; }
        const n = ps[j]?.[0] === 93 ? parseInt(ps[j++][1], 10) : 0;
        for (let k = 0; k < n && ps[j]?.[0] === 10; k++) {
          const x = num(j), y = num(j + 1); j += 2;
          let bulge = 0;
          if (ps[j]?.[0] === 42) { if (hasBulge) bulge = num(j); j++; }
          verts.push(bulge ? { p: [x, y], bulge } : { p: [x, y] });
        }
      } else {
        const ne = ps[j]?.[0] === 93 ? parseInt(ps[j++][1], 10) : 0;
        let cur = null as Pt2 | null;
        for (let k = 0; k < ne && ps[j]?.[0] === 72; k++) {
          const type = parseInt(ps[j++][1], 10);
          if (type === 1) { // línea
            const a: Pt2 = [num(j), num(j + 1)], b: Pt2 = [num(j + 2), num(j + 3)]; j += 4;
            const rev: boolean = !!cur && dist(a, cur) > 1e-6 && dist(b, cur) < 1e-6;
            verts.push({ p: rev ? b : a }); cur = rev ? a : b;
          } else if (type === 2 || type === 3) { // arco circular / de elipse
            const c: Pt2 = [num(j), num(j + 1)]; j += 2;
            let mx = 0, my = 0, ratio = 1;
            if (type === 3) { mx = num(j); my = num(j + 1); ratio = num(j + 2); j += 3; }
            let r = 0;
            if (type === 2) { r = num(j); j++; }
            const a0 = num(j), a1 = num(j + 1); j += 2;
            let ccw = true;
            if (ps[j]?.[0] === 73) { ccw = ps[j][1] !== '0'; j++; }
            if (type === 3 && Math.abs(ratio - 1) > 1e-9) { // elipse: puntos paramétricos
              const A = Math.hypot(mx, my), rot = Math.atan2(my, mx);
              let t0 = (a0 * Math.PI) / 180, t1 = (a1 * Math.PI) / 180;
              if (ccw) { while (t1 <= t0) t1 += 2 * Math.PI; } else { while (t1 >= t0) t1 -= 2 * Math.PI; }
              const n = 32;
              const pts: Pt2[] = [];
              for (let q = 0; q <= n; q++) { const t = t0 + ((t1 - t0) * q) / n; const ex = A * Math.cos(t), ey = A * ratio * Math.sin(t); pts.push([c[0] + ex * Math.cos(rot) - ey * Math.sin(rot), c[1] + ex * Math.sin(rot) + ey * Math.cos(rot)]); }
              for (let q = 0; q < n; q++) verts.push({ p: pts[q] });
              cur = pts[n];
              continue;
            }
            if (type === 3) r = Math.hypot(mx, my);
            const ang0 = type === 3 ? a0 : a0;
            const pol = (deg: number): Pt2 => [c[0] + r * Math.cos((deg * Math.PI) / 180), c[1] + r * Math.sin((deg * Math.PI) / 180)];
            let sweep = ccw ? norm360(a1 - ang0) : -norm360(ang0 - a1);
            if (Math.abs(sweep) < 1e-9) sweep = ccw ? 360 : -360;
            const s = pol(ang0), e = pol(ang0 + sweep);
            if (Math.abs(sweep) >= 359.999) { const sgn = sweep > 0 ? 1 : -1; verts.push({ p: s, bulge: sgn }, { p: pol(ang0 + 180), bulge: sgn }); cur = s; continue; }
            const bulge = Math.tan((sweep * Math.PI) / 180 / 4);
            const rev: boolean = !!cur && dist(s, cur) > 1e-6 && dist(e, cur) < 1e-6;
            if (rev) { verts.push({ p: e, bulge: -bulge }); cur = s; } else { verts.push({ p: s, bulge }); cur = e; }
          } else { // spline: no se soporta; se resincroniza en el siguiente lazo
            verts = null;
            while (j < ps.length && ps[j][0] !== 92 && ps[j][0] !== 75 && ps[j][0] !== 0) j++;
            break;
          }
        }
      }
      if (verts && ps[j]?.[0] === 97) { const n = parseInt(ps[j++][1], 10); for (let q = 0; q < n && ps[j]?.[0] === 330; q++) j++; }
      if (verts) {
        while (verts.length > 1 && dist(verts[0].p, verts[verts.length - 1].p) < 1e-9 && !verts[verts.length - 1].bulge) verts.pop();
        if (verts.length < 3 && !(verts.length === 2 && verts[0].bulge && verts[1].bulge)) verts = null;
      }
      loops.push(verts);
    }
    return { j, loops };
  };

  const parseHatch = (start: number): { h: RawHatch; end: number } => {
    const h: RawHatch = { paper: false, layer: '0', name: '', solid: false, loops: [], angle: 0, scale: 1, defs: [] };
    let j = start, seenLoops = false;
    while (j < ps.length && ps[j][0] !== 0) {
      const [c, v] = ps[j];
      if (c === 8) h.layer = v; else if (c === 62) h.aci = parseInt(v, 10); else if (c === 420) h.tc = parseInt(v, 10) & 0xffffff;
      else if (c === 67) h.paper = v === '1'; else if (c === 2 && !seenLoops) h.name = v;
      else if (c === 70 && !seenLoops) h.solid = v === '1';
      else if (c === 91) { const r = parseLoops(j + 1, parseInt(v, 10)); h.loops = r.loops; j = r.j; seenLoops = true; continue; }
      else if (seenLoops && c === 52) h.angle = Number(v);
      else if (seenLoops && c === 41) h.scale = Number(v) || 1;
      else if (seenLoops && c === 78) {
        const n = parseInt(v, 10);
        j++;
        for (let q = 0; q < n && ps[j]?.[0] === 53; q++) {
          const d = { ang: num(j), dx: 0, dy: 0 };
          j++;
          while (j < ps.length && ps[j][0] !== 0 && ps[j][0] !== 53 && ps[j][0] !== 47 && ps[j][0] !== 98) { if (ps[j][0] === 45) d.dx = num(j); else if (ps[j][0] === 46) d.dy = num(j); j++; }
          h.defs.push(d);
        }
        continue;
      }
      j++;
    }
    return { h, end: j };
  };

  for (let i = 0; i < ps.length;) {
    const [c, v] = ps[i];
    if (c === 0) {
      if (v === 'SECTION') section = ps[i + 1]?.[0] === 2 ? ps[i + 1][1] : '';
      else if (v === 'ENDSEC') section = '';
      else if (v === 'BLOCK' && section === 'BLOCKS') { for (let j = i + 1; j < ps.length && ps[j][0] !== 0; j++) if (ps[j][0] === 2) { block = ps[j][1]; break; } }
      else if (v === 'ENDBLK') block = undefined;
      else if (v === 'HATCH' && (section === 'ENTITIES' || section === 'BLOCKS')) {
        const r = parseHatch(i + 1);
        out.push({ ...r.h, ...(section === 'BLOCKS' && block ? { block } : {}) });
        i = r.end;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** HATCH leído → entidad hatch (sin id/capa). Los patrones de AutoCAD que no son de los nuestros se aproximan con líneas. Devuelve null si ningún lazo es válido. */
function hatchFromRaw(r: RawHatch, warnOnce: (key: string, msg: string) => void): HatchEntity | null {
  const loops = r.loops.filter((l): l is PolyVertex[] => !!l);
  if (!loops.length) return null;
  if (loops.length < r.loops.length) warnOnce('hatch-spline', 'Algún contorno de sombreado usa splines y se omitió (solo se importan líneas, arcos y polilíneas).');
  const nm = r.name.toUpperCase(), d0 = r.defs[0];
  const perp = (d: { dy: number } | undefined, fallback: number): number => (d && Math.abs(d.dy) > 1e-9 ? Math.abs(d.dy) * r.scale : fallback * r.scale);
  let pattern: HatchPattern, angle = r.angle, spacing: number | undefined;
  if (r.solid || nm === 'SOLID') pattern = 'solid';
  else if (nm === 'ANSI31') { pattern = 'ansi31'; spacing = perp(d0, 3.175); }
  else if (nm === 'LINE') { pattern = 'lines'; spacing = perp(d0, 3.175); }
  else if (nm === 'NET') { pattern = 'cross'; spacing = perp(d0, 3.175); }
  else {
    const two = r.defs.length >= 2 && Math.abs(Math.abs(norm360(r.defs[1].ang - (d0?.ang ?? 0)) - 180) - 90) < 1e-6;
    pattern = two ? 'cross' : 'lines';
    angle = r.angle + (d0?.ang ?? 0);
    spacing = d0 ? perp(d0, 50 / Math.max(r.scale, 1e-9)) : undefined;
    warnOnce('hatch-' + nm, `Patrón de sombreado "${r.name || '?'}" aproximado con ${pattern === 'cross' ? 'una rejilla' : 'líneas paralelas'} (el dibujo solo tiene los patrones solid, lines, cross, dots, ansi31, brick, concrete y wood).`);
  }
  const h: HatchEntity = { type: 'hatch', id: '', layer: '', loops, pattern };
  const a = norm360(angle);
  if (a > 1e-9 && a < 360 - 1e-9 && pattern !== 'solid') h.angle = a;
  if (spacing && pattern !== 'solid') h.scale = spacing;
  return h;
}

/** Quita códigos de formato de MTEXT y los códigos %% de AutoCAD. Devuelve las líneas del texto. */
export function cleanDxfText(raw: string): string[] {
  let s = raw;
  s = s.replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\[Pp]/g, '\n').replace(/\\~/g, ' ');
  s = s.replace(/\\S([^;^#/\\]*)[\^#/]([^;]*);/g, (_, a: string, b: string) => `${a}/${b}`);
  s = s.replace(/\\[fFcCHhQqWwTtAa][^;\\{}]*;/g, '').replace(/\\[LlOoKk]/g, '');
  s = s.replace(/\\([\\{}])/g, '\u0001$1').replace(/[{}]/g, '').replace(/\u0001([\\{}])/g, '$1');
  s = s.replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoO]/g, '').replace(/%%(\d{3})/g, (_, n: string) => String.fromCharCode(Number(n)));
  return s.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l, i, a) => l.length > 0 || (i > 0 && i < a.length - 1));
}

interface RawLayer { name: string; color: DrawingColor; on: boolean; frozen: boolean; locked: boolean; linetype: string; lineweight?: number }

/** Lee la tabla LAYER a mano: dxf-parser no entrega bloqueo, tipo de línea, grosor ni color verdadero. */
function scanLayers(text: string): RawLayer[] {
  const tab = text.search(/^[ \t]*2[ \t]*\r?\n[ \t]*TABLES?[ \t]*\r?$/m);
  const from = text.search(/^[ \t]*2[ \t]*\r?\n[ \t]*LAYER[ \t]*\r?$/m);
  if (from < 0 || (tab >= 0 && from < tab)) return [];
  const end = text.indexOf('ENDTAB', from);
  const lines = text.slice(from, end < 0 ? undefined : end).split(/\r?\n/);
  const out: RawLayer[] = [];
  let cur: Partial<RawLayer> & { flags?: number; aci?: number; tc?: number } | null = null;
  const close = (): void => {
    if (!cur || cur.name === undefined) { cur = null; return; }
    const a = Math.abs(cur.aci ?? 7);
    const color: DrawingColor = cur.tc !== undefined ? `#${cur.tc.toString(16).padStart(6, '0')}` : (a >= 1 && a <= 255 ? a : 7);
    out.push({ name: cur.name, color, on: (cur.aci ?? 7) >= 0, frozen: !!((cur.flags ?? 0) & 3), locked: !!((cur.flags ?? 0) & 4), linetype: cur.linetype ?? 'CONTINUOUS', ...(cur.lineweight ? { lineweight: cur.lineweight } : {}) });
    cur = null;
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim()), v = lines[i + 1].trim();
    if (code === 0) { if (v === 'LAYER') { close(); cur = {}; } continue; }
    if (!cur) continue;
    if (code === 2) cur.name = lines[i + 1].replace(/\r$/, '').trim();
    else if (code === 70) cur.flags = parseInt(v, 10);
    else if (code === 62) cur.aci = parseInt(v, 10);
    else if (code === 420) cur.tc = parseInt(v, 10) & 0xffffff;
    else if (code === 6) cur.linetype = v;
    else if (code === 370) { const n = parseInt(v, 10); if (n > 0) cur.lineweight = n / 100; }
  }
  close();
  return out;
}
const ltFromName = (n: string): NonNullable<Layer['linetype']> => {
  const u = n.toUpperCase();
  if (/CENTER|DASHDOT|PHANTOM|DIVIDE/.test(u)) return 'center';
  if (/DASH|HIDDEN|DOT|BORDER/.test(u)) return 'dashed';
  return 'continuous';
};

/** Ramer-Douglas-Peucker iterativo (listas grandes sin recursión). */
function simplify(pts: Pt2[], tol: number): Pt2[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let md = -1, mi = -1;
    const a = pts[s], b = pts[e], L = dist(a, b);
    for (let i = s + 1; i < e; i++) {
      const p = pts[i];
      const d = L < 1e-12 ? dist(p, a) : Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Evalúa una B-spline (De Boor) en t. */
function deBoor(deg: number, knots: number[], ctrl: Pt2[], t: number): Pt2 {
  const n = ctrl.length;
  let k = deg;
  while (k < n - 1 && t >= knots[k + 1]) k++;
  const d: Pt2[] = [];
  for (let j = 0; j <= deg; j++) d.push([ctrl[j + k - deg][0], ctrl[j + k - deg][1]]);
  for (let r = 1; r <= deg; r++) {
    for (let j = deg; j >= r; j--) {
      const den = knots[j + 1 + k - r] - knots[j + k - deg];
      const al = den === 0 ? 0 : (t - knots[j + k - deg]) / den;
      d[j] = [(1 - al) * d[j - 1][0] + al * d[j][0], (1 - al) * d[j - 1][1] + al * d[j][1]];
    }
  }
  return d[deg];
}

const hexOf = (n: number): string => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

/**
 * Color propio de una entidad DXF: ACI, color verdadero ("#rrggbb"), `inherit` (PorBloque) o undefined (PorCapa).
 * dxf-parser deja en `color` el último de 62/420, así que un 420 que no se parece al color del ACI declarado se toma como verdadero.
 */
function entColor(ent: { colorIndex?: number; color?: number }, inherit: DrawingColor | undefined, trueColorFile: boolean): DrawingColor | undefined {
  const ci = ent.colorIndex === undefined ? undefined : Math.abs(ent.colorIndex);
  if (typeof ent.color === 'number' && (ci === undefined || ci >= 256 || (ci === 0 ? ent.color !== 0 : !aciLike(ci, ent.color, trueColorFile)))) return hexOf(ent.color);
  if (ci === undefined || ci >= 256) return undefined;
  return ci === 0 ? inherit : ci <= 255 ? ci : undefined;
}
function aciLike(ci: number, rgb: number, trueColorFile: boolean): boolean {
  const exact = (ci >= 1 && ci <= 9) || ci >= 250;
  if (!exact) return !trueColorFile; // sin 420 en el archivo, el color del parser es el del ACI; con 420 no se sabe y se prefiere el RGB
  const e = hexRgb(aciToHex(ci, true)), r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  return Math.hypot(e[0] - r, e[1] - g, e[2] - b) <= 8;
}

/** Importa un DXF (cualquier versión que lea dxf-parser) a un Drawing editable. Ver docs/dibujo-2d.md, "Importar y exportar". */
export function dxfToDrawing(text: string, opts: DxfImportOptions = {}): DxfImportResult {
  if (/^AC10\d\d/.test(text.slice(0, 8))) throw new Error('Ese archivo es un .dwg. En AutoCAD usa «Guardar como» y elige DXF (o ábrelo en LibreCAD / DWG TrueView y guárdalo como DXF).');
  let dxf: { entities?: Ent[]; blocks?: Record<string, Block>; header?: Record<string, unknown>; tables?: { layer?: { layers?: Record<string, { name?: string; colorIndex?: number; color?: number; visible?: boolean; frozen?: boolean }> } } } | null;
  try { dxf = new DxfParser().parseSync(text) as unknown as typeof dxf; } catch (err) { throw new Error(`No pude leer el DXF: ${(err as Error).message}`); }
  if (!dxf) throw new Error('No pude leer el archivo DXF.');
  const warnings: string[] = [];
  const imported: Record<string, number> = {};
  const omitted: Record<string, number> = {};
  const bump = (m: Record<string, number>, k: string, n = 1): void => { m[k] = (m[k] ?? 0) + n; };
  const warned = new Set<string>();
  const warnOnce = (key: string, msg: string): void => { if (!warned.has(key)) { warned.add(key); warnings.push(msg); } };
  const tol = opts.tolerance ?? 0.1;
  const maxEntities = opts.maxEntities ?? 1_000_000;

  // ---- unidades
  let factor = 1, source: string;
  const code = Number(dxf.header?.$INSUNITS ?? 0);
  if (typeof opts.units === 'number') { factor = opts.units; source = `forzado (x${opts.units})`; }
  else if (opts.units && opts.units !== 'auto') { factor = NAMED_UNITS[opts.units]; source = `forzado (${opts.units})`; }
  else if (INSUNITS_MM[code]) { [factor, source] = [INSUNITS_MM[code][0], `$INSUNITS=${code} (${INSUNITS_MM[code][1]})`]; }
  else { source = 'sin unidades ($INSUNITS=0): se asume mm'; warnings.push('El DXF no declara unidades ($INSUNITS); se asumen milímetros. Usa la opción units si no lo son.'); }
  if (!(factor > 0)) throw new Error('El factor de unidades debe ser mayor que 0.');
  if (factor !== 1 && !source.startsWith('forzado')) warnings.push(`Unidades del DXF: ${source}; se convierten a mm (x${factor}).`);

  // ---- capas
  const layers = new Map<string, Layer>();
  const dropLayerCache = new Map<string, boolean>();
  const raw = scanLayers(text);
  const addLayerEntry = (r: RawLayer): void => {
    const key = r.name.toLowerCase();
    if (!layers.has(key)) layers.set(key, { name: r.name, color: r.color, linetype: ltFromName(r.linetype), ...(r.lineweight ? { lineweight: Math.min(5, r.lineweight) } : {}), on: r.on, frozen: r.frozen, locked: r.locked });
  };
  if (raw.length) raw.forEach(addLayerEntry);
  else for (const [name, l] of Object.entries(dxf.tables?.layer?.layers ?? {})) {
    const ci = Math.abs(l.colorIndex ?? 7);
    addLayerEntry({ name: l.name ?? name, color: ci >= 1 && ci <= 255 ? ci : 7, on: l.visible !== false, frozen: !!l.frozen, locked: false, linetype: 'CONTINUOUS' });
  }
  if (!layers.has('0')) layers.set('0', { name: '0', color: 7, linetype: 'continuous', on: true, frozen: false, locked: false });
  const layerNamed = (n: string): Layer => {
    const key = n.toLowerCase();
    let l = layers.get(key);
    if (!l) { l = { name: n, color: 7, linetype: 'continuous', on: true, frozen: false, locked: false }; layers.set(key, l); }
    return l;
  };
  const dropsLayer = (name: string): boolean => {
    const key = name.toLowerCase();
    let v = dropLayerCache.get(key);
    if (v !== undefined) return v;
    const l = layerNamed(name);
    v = key !== '0' && ((!!opts.dropFrozen && l.frozen) || (!!opts.dropOff && !l.on) || (!!opts.dropDimensions && DIM_LAYER.test(name))
      || (opts.dropLayers ?? []).some((p) => (typeof p === 'string' ? p.toLowerCase() === key : p.test(name))));
    dropLayerCache.set(key, v);
    return v;
  };

  const trueColorFile = /^[ \t]*420[ \t]*\r?$/m.test(text);

  // ---- conteo de tipos que dxf-parser no entrega (HATCH, etc.)
  const unsupported: Record<string, number> = {};
  {
    const re = /^[ \t]*0[ \t]*\r?\n[ \t]*([A-Z0-9_]+)[ \t]*\r?$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) if (NOT_DRAWN.has(m[1])) bump(unsupported, m[1]);
  }

  // ---- entidades
  const out: Entity[] = [];
  let sink: Entity[] = out; // entidades que se están produciendo (el dibujo, o un bloque que se está convirtiendo)
  let nextId = 0;
  const explode = !!opts.explodeBlocks;
  const hatches = scanHatches(text);
  const blockHatches = new Map<string, RawHatch[]>();
  for (const h of hatches) if (h.block) (blockHatches.get(h.block) ?? blockHatches.set(h.block, []).get(h.block)!).push(h);
  let capped = false;
  const baseMat: Mat | null = factor === 1 ? null : [factor, 0, 0, factor, 0, 0];
  const blocks = dxf.blocks ?? {};

  interface Ctx { m: Mat | null; layer?: string; color?: DrawingColor; depth: number; inBlock: boolean }
  const sim = (m: Mat): { s: number; theta: number; mirrored: boolean } | null => {
    const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
    if (Math.abs(sx - sy) > 1e-9 * Math.max(sx, sy, 1e-12)) return null;
    if (Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-9 * sx * sy) return null;
    return { s: sx, theta: (Math.atan2(m[1], m[0]) * 180) / Math.PI, mirrored: m[0] * m[3] - m[1] * m[2] < 0 };
  };

  const finish = (e: Entity, ent: Ent, ctx: Ctx): void => {
    if (capped) return;
    if (out.length >= maxEntities) { capped = true; warnings.push(`Se alcanzó el tope de ${maxEntities} entidades; el resto se omitió (opción maxEntities).`); return; }
    let lname = ent.layer || '0';
    if (ctx.layer && lname === '0') lname = ctx.layer;
    lname = layerNamed(lname).name;
    if (dropsLayer(lname)) { bump(omitted, `capa descartada (${ent.type})`); return; }
    let color = entColor(ent, ctx.color, trueColorFile);
    const lay = layerNamed(lname);
    if (color !== undefined && color === lay.color) color = undefined;
    const full = { ...e, id: `e${++nextId}`, layer: lname, ...(color !== undefined ? { color } : {}) } as Entity;
    if (validateEntity(full)) { nextId--; bump(omitted, `${ent.type} degenerada`); return; }
    sink.push(full);
  };

  /** Aplica la matriz del contexto a una entidad local y la entrega. */
  const emit = (e: Entity, ent: Ent, ctx: Ctx): void => {
    const m = ctx.m;
    if (!m) { finish(e, ent, ctx); return; }
    const sm = sim(m);
    const maxS = Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]), 1e-12);
    const polyOut = (pts: Pt2[], closed: boolean): void => finish({ type: 'poly', pts: pts.map((p) => ({ p: mpt(m, p) })), ...(closed ? { closed: true } : {}) } as unknown as Entity, ent, ctx);
    switch (e.type) {
      case 'line': finish({ ...e, a: mpt(m, e.a), b: mpt(m, e.b) }, ent, ctx); break;
      case 'poly':
        if (!e.pts.some((v) => v.bulge)) polyOut(e.pts.map((v) => v.p), !!e.closed);
        else if (sm) finish({ ...e, pts: e.pts.map((v) => ({ p: mpt(m, v.p), ...(v.bulge ? { bulge: sm.mirrored ? -v.bulge : v.bulge } : {}) })) }, ent, ctx);
        else { warnOnce('nonuni-poly', 'Una escala no uniforme (X distinta de Y) convirtió arcos de polilíneas en segmentos.'); polyOut(tessellatePoly(e, tol / maxS), !!e.closed); }
        break;
      case 'circle':
        if (sm) finish({ ...e, c: mpt(m, e.c), r: e.r * sm.s }, ent, ctx);
        else { warnOnce('nonuni-circle', 'Una escala no uniforme convirtió círculos o arcos en polilíneas (elipses aproximadas).'); polyOut(tessellateCircle(e.c, e.r, tol / maxS), true); }
        break;
      case 'arc':
        if (sm) {
          const [a0, a1] = sm.mirrored ? [sm.theta - e.a1, sm.theta - e.a0] : [sm.theta + e.a0, sm.theta + e.a1];
          finish({ ...e, c: mpt(m, e.c), r: e.r * sm.s, a0: norm360(a0), a1: norm360(a1) } as ArcEntity, ent, ctx);
        } else { warnOnce('nonuni-circle', 'Una escala no uniforme convirtió círculos o arcos en polilíneas (elipses aproximadas).'); polyOut(tessellateArc(e.c, e.r, e.a0, e.a1, tol / maxS), false); }
        break;
      case 'text': {
        const th = sm?.theta ?? (Math.atan2(m[1], m[0]) * 180) / Math.PI, s = sm?.s ?? Math.hypot(m[2], m[3]);
        const rot = norm360((e.rot ?? 0) + th);
        const t = { ...e, p: mpt(m, e.p), h: e.h * s } as Entity & { rot?: number };
        if (rot > 1e-9 && rot < 360 - 1e-9) t.rot = rot; else delete t.rot;
        finish(t, ent, ctx);
        break;
      }
      case 'hatch': for (const t of transformEntityMat(e, m)) finish(t, ent, ctx); break;
      case 'insert': { // la matriz es solo el factor de unidades (escala uniforme): mueve p y las separaciones del arreglo
        const s = sm?.s ?? 1;
        finish({ ...e, p: mpt(m, e.p), ...(e.dx ? { dx: e.dx * s } : {}), ...(e.dy ? { dy: e.dy * s } : {}) }, ent, ctx);
        break;
      }
      case 'dim': {
        if (!sm) { bump(omitted, 'DIMENSION (con escala no uniforme)'); break; }
        const t: Record<string, unknown> = { ...e };
        if (e.kind === 'radius' || e.kind === 'diameter') { t.c = mpt(m, e.c); t.r = e.r * sm.s; if (e.ang !== undefined || sm.theta) t.ang = (e.ang ?? 45) + sm.theta; }
        else {
          const d = e as DimLinearEntity | DimAlignedEntity;
          t.p1 = mpt(m, d.p1); t.p2 = mpt(m, d.p2); t.at = mpt(m, d.at);
          if (d.kind === 'linear' && (d.rot || sm.theta)) t.rot = (d.rot ?? 0) + sm.theta;
        }
        finish(t as unknown as Entity, ent, ctx);
        break;
      }
    }
  };

  const P = (p: Pt | undefined): Pt2 => [p?.x ?? 0, p?.y ?? 0];
  /** Espejo X del OCS cuando la normal de extrusión es -Z. */
  const flipsX = (ent: Ent): boolean => (ent.extrusionDirection?.z ?? ent.extrusionDirectionZ ?? 1) < 0;
  const mirrorEnt = (e: Entity, ent: Ent): Entity => {
    if (!flipsX(ent)) return e;
    switch (e.type) {
      case 'line': return { ...e, a: [-e.a[0], e.a[1]], b: [-e.b[0], e.b[1]] };
      case 'poly': return { ...e, pts: e.pts.map((v) => ({ p: [-v.p[0], v.p[1]] as Pt2, ...(v.bulge ? { bulge: -v.bulge } : {}) })) };
      case 'circle': return { ...e, c: [-e.c[0], e.c[1]] };
      case 'arc': return { ...e, c: [-e.c[0], e.c[1]], a0: norm360(180 - e.a1), a1: norm360(180 - e.a0) } as ArcEntity;
      default: return e;
    }
  };

  const approxPoly = (pts: Pt2[], closed: boolean, ent: Ent, ctx: Ctx): void => {
    let p = pts;
    if (closed && p.length > 1 && dist(p[0], p[p.length - 1]) < 1e-9) p = p.slice(0, -1);
    if (p.length < 2) { bump(omitted, `${ent.type} degenerada`); return; }
    emit({ type: 'poly', pts: p.map((q) => ({ p: q })), ...(closed && p.length >= 3 ? { closed: true } : {}) } as unknown as Entity, ent, ctx);
  };

  const textEnt = (ent: Ent, ctx: Ctx): void => {
    const lines = cleanDxfText(ent.text ?? '');
    if (!lines.length) { bump(omitted, `${ent.type} vacío`); return; }
    if (ent.type === 'TEXT') {
      const h = ent.textHeight || 2.5;
      const halign = ent.halign ?? 0, valign = ent.valign ?? 0;
      const aligned = halign !== 0 || valign !== 0;
      let p = P(aligned && ent.endPoint ? ent.endPoint : ent.startPoint);
      if (valign === 3) p = [p[0], p[1] - h]; else if (valign === 2) p = [p[0], p[1] - h / 2];
      const align: 'left' | 'center' | 'right' = halign === 1 || halign === 4 ? 'center' : halign === 2 ? 'right' : 'left';
      const e: Entity = { type: 'text', id: '', layer: '', p, h, s: lines.join(' '), ...(ent.rotation ? { rot: norm360(ent.rotation) } : {}), ...(align !== 'left' ? { align } : {}) } as Entity;
      emit(mirrorEnt(e, ent), ent, ctx);
      return;
    }
    // MTEXT: una entidad por línea, con la rotación y el anclaje del bloque
    const h = ent.height || 2.5, step = h * 1.4;
    const ap = ent.attachmentPoint ?? 1;
    const align: 'left' | 'center' | 'right' = ap % 3 === 2 ? 'center' : ap % 3 === 0 ? 'right' : 'left';
    const rotDeg = ent.rotation ?? (ent.directionVector ? (Math.atan2(ent.directionVector.y, ent.directionVector.x) * 180) / Math.PI : 0);
    const r = (rotDeg * Math.PI) / 180, ux = Math.cos(r), uy = Math.sin(r);
    const Hb = h + (lines.length - 1) * step;
    const topShift = ap <= 3 ? 0 : ap <= 6 ? Hb / 2 : Hb; // anclaje vertical: arriba / centro / abajo
    const pos = P(ent.position);
    lines.forEach((ln, i) => {
      const off = topShift - h - i * step; // desplazamiento de la línea base respecto del punto de inserción, en el eje Y del texto
      const px = pos[0] - uy * off, py = pos[1] + ux * off;
      const e: Entity = { type: 'text', id: '', layer: '', p: [px, py], h, s: ln, ...(rotDeg ? { rot: norm360(rotDeg) } : {}), ...(align !== 'left' ? { align } : {}) } as Entity;
      emit(mirrorEnt(e, ent), ent, ctx);
    });
  };

  const dimEnt = (ent: Ent, ctx: Ctx): boolean => {
    const t = (ent.dimensionType ?? 0) & 7;
    const label = ent.text && ent.text !== '<>' && ent.text.trim() ? { text: cleanDxfText(ent.text).join(' ') } : {};
    let e: Entity | null = null;
    if ((t === 0 || t === 1) && ent.linearOrAngularPoint1 && ent.linearOrAngularPoint2 && ent.anchorPoint) {
      const p1 = P(ent.linearOrAngularPoint1), p2 = P(ent.linearOrAngularPoint2), at = P(ent.anchorPoint);
      if (dist(p1, p2) > 1e-9) e = t === 1 ? { type: 'dim', kind: 'aligned', id: '', layer: '', p1, p2, at, ...label } : { type: 'dim', kind: 'linear', id: '', layer: '', p1, p2, at, ...(ent.angle ? { rot: ent.angle } : {}), ...label };
    } else if ((t === 3 || t === 4) && ent.anchorPoint && ent.diameterOrRadiusPoint) {
      const a = P(ent.anchorPoint), b = P(ent.diameterOrRadiusPoint);
      const ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
      if (t === 3) e = { type: 'dim', kind: 'diameter', id: '', layer: '', c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], r: dist(a, b) / 2, ang, ...label };
      else e = { type: 'dim', kind: 'radius', id: '', layer: '', c: a, r: dist(a, b), ang, ...label };
    }
    if (!e) return false;
    emit(e, ent, ctx);
    return true;
  };

  const walk = (list: Ent[], ctx: Ctx): void => {
    for (const ent of list) {
      if (capped) return;
      const type = ent.type;
      if (ent.visible === false) { bump(omitted, `${type} invisible`); continue; }
      if (ent.inPaperSpace && !opts.includePaperSpace && !ctx.inBlock) { bump(omitted, `${type} (espacio papel)`); continue; }
      const L = layerNamed(ent.layer || '0').name;
      if (type !== 'INSERT' && dropsLayer(ctx.layer && L === '0' ? ctx.layer : L)) { bump(omitted, `capa descartada (${type})`); continue; }
      switch (type) {
        case 'LINE': {
          const v = ent.vertices;
          if (v && v.length >= 2) emit(mirrorEnt({ type: 'line', id: '', layer: '', a: P(v[0]), b: P(v[1]) }, ent), ent, ctx);
          bump(imported, type);
          break;
        }
        case 'LWPOLYLINE': case 'POLYLINE': {
          if (ent.is3dPolygonMesh || ent.isPolyfaceMesh) { bump(omitted, 'POLYLINE (malla 3D)'); break; }
          const v = ent.vertices ?? [];
          let closed = !!(ent.shape ?? ent.closed);
          let pts: PolyVertex[] = v.map((q) => (q.bulge ? { p: P(q), bulge: q.bulge } : { p: P(q) }));
          if (pts.length < 2) { bump(omitted, `${type} degenerada`); break; }
          if (closed && pts.length > 2 && dist(pts[0].p, pts[pts.length - 1].p) < 1e-9 && !pts[pts.length - 1].bulge) pts = pts.slice(0, -1);
          if (closed && pts.length < 3) closed = false;
          emit(mirrorEnt({ type: 'poly', id: '', layer: '', pts, ...(closed ? { closed: true } : {}) }, ent), ent, ctx);
          bump(imported, type);
          break;
        }
        case 'CIRCLE':
          if (ent.center && ent.radius) emit(mirrorEnt({ type: 'circle', id: '', layer: '', c: P(ent.center), r: ent.radius }, ent), ent, ctx);
          bump(imported, type);
          break;
        case 'ARC': {
          if (ent.center && ent.radius) {
            const a0 = norm360(((ent.startAngle ?? 0) * 180) / Math.PI), a1 = norm360(((ent.endAngle ?? 0) * 180) / Math.PI);
            emit(mirrorEnt({ type: 'arc', id: '', layer: '', c: P(ent.center), r: ent.radius, a0, a1 }, ent), ent, ctx);
          }
          bump(imported, type);
          break;
        }
        case 'ELLIPSE': {
          bump(imported, type);
          if (!ent.center || !ent.majorAxisEndPoint) break;
          const c = P(ent.center), M = P(ent.majorAxisEndPoint), ratio = ent.axisRatio ?? 1;
          const a = Math.hypot(M[0], M[1]), b = a * ratio;
          let t0 = ent.startAngle ?? 0, t1 = ent.endAngle ?? Math.PI * 2;
          while (t1 <= t0) t1 += Math.PI * 2;
          const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6;
          if (Math.abs(ratio - 1) < 1e-9) { // círculo disfrazado de elipse
            const rot = (Math.atan2(M[1], M[0]) * 180) / Math.PI;
            if (full) emit({ type: 'circle', id: '', layer: '', c, r: a }, ent, ctx);
            else emit({ type: 'arc', id: '', layer: '', c, r: a, a0: norm360(rot + (t0 * 180) / Math.PI), a1: norm360(rot + (t1 * 180) / Math.PI) }, ent, ctx);
            break;
          }
          const n = Math.max(arcSteps(Math.max(a, b), ((t1 - t0) * 180) / Math.PI, tol / (baseMat ? factor : 1)), 12);
          const pts: Pt2[] = [];
          for (let i = 0; i <= n; i++) {
            const t = t0 + ((t1 - t0) * i) / n, ct = Math.cos(t), st = Math.sin(t);
            pts.push([c[0] + ct * M[0] - st * ratio * M[1], c[1] + ct * M[1] + st * ratio * M[0]]);
          }
          approxPoly(pts, full, ent, ctx);
          bump(imported, 'ELLIPSE (aproximada)');
          warnOnce('ellipse', 'Las elipses se aproximaron con polilíneas (el dibujo no tiene elipse nativa).');
          break;
        }
        case 'SPLINE': {
          bump(imported, type);
          const ctrl = (ent.controlPoints ?? []).map(P);
          let pts: Pt2[] = [];
          const deg = ent.degreeOfSplineCurve ?? 3, knots = ent.knotValues ?? [];
          if (ctrl.length >= deg + 1 && knots.length === ctrl.length + deg + 1) {
            const t0 = knots[deg], t1 = knots[ctrl.length];
            const N = Math.min(4000, Math.max(8, (ctrl.length - deg) * 16));
            for (let i = 0; i <= N; i++) pts.push(deBoor(deg, knots, ctrl, i === N ? t1 - (t1 - t0) * 1e-12 : t0 + ((t1 - t0) * i) / N));
            pts[N] = ctrl[ctrl.length - 1]; pts[0] = ctrl[0];
            pts = simplify(pts, tol / (baseMat ? factor : 1));
            if (ent.rational) warnOnce('rational', 'Hay splines racionales: se ignoraron los pesos al aproximarlas.');
          } else if (ent.fitPoints && ent.fitPoints.length >= 2) {
            pts = ent.fitPoints.map(P);
            warnOnce('fit', 'Algunas splines solo traían puntos de ajuste: se unieron con segmentos rectos.');
          } else if (ctrl.length >= 2) {
            pts = ctrl;
            warnOnce('ctrl', 'Algunas splines no traían nudos válidos: se usó su polígono de control.');
          } else { bump(omitted, 'SPLINE degenerada'); break; }
          approxPoly(pts, !!ent.closed || dist(pts[0], pts[pts.length - 1]) < 1e-9, ent, ctx);
          bump(imported, 'SPLINE (aproximada)');
          warnOnce('spline', `Las splines se aproximaron con polilíneas (tolerancia ${tol} mm).`);
          break;
        }
        case 'TEXT': case 'MTEXT': textEnt(ent, ctx); bump(imported, type); break;
        case 'SOLID': case '3DFACE': {
          const q = (ent.points ?? []).map(P);
          if (q.length >= 3) {
            // SOLID guarda las esquinas en orden 1,2,4,3; 3DFACE en orden normal
            const ordered = type === 'SOLID' && q.length === 4 ? [q[0], q[1], q[3], q[2]] : q;
            const uniq = ordered.filter((p, i) => i === 0 || dist(p, ordered[i - 1]) > 1e-9);
            approxPoly(uniq, true, ent, ctx);
            warnOnce('solid', `${type} (relleno) se importó solo como contorno.`);
          }
          bump(imported, type);
          break;
        }
        case 'DIMENSION': {
          bump(imported, type);
          if (opts.dropDimensions) { bump(omitted, 'DIMENSION (descartada)'); break; }
          const blk = ent.block ? blocks[ent.block] : undefined;
          if (blk?.entities?.length && ctx.depth < 16) {
            const nctx: Ctx = { ...ctx, depth: ctx.depth + 1, inBlock: true, layer: L };
            const base = blk.position ?? { x: 0, y: 0 };
            const bm: Mat = [1, 0, 0, 1, -base.x, -base.y];
            nctx.m = ctx.m ? mmul(ctx.m, bm) : (base.x || base.y ? bm : null);
            // los bloques anónimos de cota están en coordenadas del mundo; el punto base suele ser 0,0
            walk(blk.entities, nctx);
            warnOnce('dimblk', 'Las cotas se importaron como su geometría (líneas, flechas y texto sueltos), sin asociatividad.');
          } else if (dimEnt(ent, ctx)) {
            warnOnce('dimsimple', 'Algunas cotas no traían su dibujo y se rehicieron como cotas simples; el aspecto puede variar.');
          } else {
            bump(omitted, `DIMENSION (tipo ${(ent.dimensionType ?? 0) & 7} sin soporte)`);
            warnOnce('dimskip', 'Hay cotas angulares/de ordenadas sin bloque de dibujo; se omitieron.');
          }
          break;
        }
        case 'INSERT': {
          bump(imported, type);
          const blk = ent.name ? blocks[ent.name] : undefined;
          if (!blk?.entities) { bump(omitted, `INSERT sin bloque ("${ent.name}")`); break; }
          if (ctx.depth >= 16) { warnOnce('depth', 'Hay bloques anidados a más de 16 niveles; se cortó la expansión.'); break; }
          if (opts.dropDimensions && /^\*D/i.test(ent.name ?? '')) break;
          if (!explode) { insertEnt(ent, ctx); break; }
          const sx = ent.xScale ?? 1, sy = ent.yScale ?? 1, rot = ((ent.rotation ?? 0) * Math.PI) / 180;
          const cs = Math.cos(rot), sn = Math.sin(rot), base = blk.position ?? { x: 0, y: 0 }, pos = ent.position ?? { x: 0, y: 0 };
          const cols = Math.max(1, ent.columnCount ?? 1), rows = Math.max(1, ent.rowCount ?? 1);
          const cap = Math.min(cols * rows, 10000);
          if (cols * rows > cap) warnOnce('array', 'Un INSERT en matriz era mayor de 10 000 copias; se recortó.');
          const insertLayer = L === '0' && ctx.layer ? ctx.layer : L;
          const color = entColor(ent, ctx.color, trueColorFile);
          for (let k = 0; k < cap; k++) {
            const i = Math.floor(k / cols), j = k % cols;
            const ox = j * (ent.columnSpacing ?? 0), oy = i * (ent.rowSpacing ?? 0);
            // p' = pos + R(rot)·(S·(p - base) + offset de matriz)
            const local: Mat = [sx, 0, 0, sy, -base.x * sx + ox, -base.y * sy + oy];
            const rotm: Mat = [cs, sn, -sn, cs, pos.x, pos.y];
            const mm = mmul(rotm, local);
            const nctx: Ctx = { m: ctx.m ? mmul(ctx.m, mm) : mm, depth: ctx.depth + 1, inBlock: true, layer: insertLayer, ...(color !== undefined ? { color } : {}) };
            walk(blk.entities, nctx);
            for (const r of blockHatches.get(ent.name ?? '') ?? []) hatchEnt(r, nctx);
            if (capped) return;
          }
          break;
        }
        default:
          if (type === 'POINT') { bump(omitted, 'POINT'); break; }
          bump(omitted, type);
      }
    }
  };

  // ---- sombreados y bloques editables
  let failedHatch = 0;
  const hatchEnt = (r: RawHatch, ctx: Ctx): void => {
    const h = hatchFromRaw(r, warnOnce);
    const fake: Ent = { type: 'HATCH', layer: r.layer, ...(r.aci !== undefined ? { colorIndex: r.aci } : {}), ...(r.tc !== undefined ? { color: r.tc } : {}) };
    bump(imported, 'HATCH');
    if (!h) { failedHatch++; return; }
    if (dropsLayer(ctx.layer && r.layer === '0' ? ctx.layer : r.layer)) { bump(omitted, 'capa descartada (HATCH)'); return; }
    emit(h, fake, ctx);
  };
  const blockDefs = new Map<string, DrawingBlock>();
  const blockMap = new Map<string, string | null>();
  const converting = new Set<string>();
  const usedNames = new Set<string>();
  const insertEnt = (ent: Ent, ctx: Ctx): void => {
    const name = ent.name ?? '';
    const mine = blockFor(name);
    if (!mine) return;
    const sx = ent.xScale ?? 1, sy = ent.yScale ?? 1;
    if (!sx || !sy) { bump(omitted, 'INSERT con escala 0'); return; }
    const e: InsertEntity = { type: 'insert', id: '', layer: '', block: mine, p: P(ent.position) };
    if (sx !== 1) e.sx = sx;
    if (sy !== 1) e.sy = sy;
    if (ent.rotation) e.rot = norm360(ent.rotation);
    const cols = Math.max(1, ent.columnCount ?? 1), rows = Math.max(1, ent.rowCount ?? 1);
    if (cols > 1 || rows > 1) {
      const c = Math.min(cols, 1000), r = Math.min(rows, Math.max(1, Math.floor(10000 / c)));
      if (c < cols || r < rows) warnOnce('array', 'Un INSERT en matriz era mayor de 10 000 copias; se recortó.');
      if (c > 1) e.cols = c;
      if (r > 1) e.rows = r;
      e.dx = ent.columnSpacing ?? 0; e.dy = ent.rowSpacing ?? 0;
    }
    emit(e, ent, ctx);
  };
  /** Nombre (único y válido) del bloque editable que corresponde al BLOCK del DXF; lo convierte la primera vez que se usa. */
  function blockFor(name: string): string | null {
    if (blockMap.has(name)) return blockMap.get(name)!;
    const blk = blocks[name];
    if (!blk?.entities) { bump(omitted, `INSERT sin bloque ("${name}")`); blockMap.set(name, null); return null; }
    if (converting.has(name)) { warnOnce('cycle', 'Hay bloques que se contienen a sí mismos; se omitió la referencia circular.'); return null; }
    if (converting.size >= 7) { warnOnce('depth', 'Hay bloques anidados a más de 8 niveles; se cortó la conversión.'); return null; }
    converting.add(name);
    const saveSink = sink, saveId = nextId;
    const list: Entity[] = [];
    sink = list; nextId = 0;
    const bctx: Ctx = { m: baseMat, depth: 1, inBlock: true };
    walk(blk.entities, bctx);
    for (const r of blockHatches.get(name) ?? []) hatchEnt(r, bctx);
    sink = saveSink; nextId = saveId;
    converting.delete(name);
    if (!list.length) { bump(omitted, `INSERT de bloque vacío ("${name}")`); blockMap.set(name, null); return null; }
    let n = name.replace(/[<>/\\":;?*|=\`\r\n]/g, '_').trim().slice(0, 120) || '_', k = 2;
    const base = n;
    while (usedNames.has(n.toLowerCase())) n = `${base}_${k++}`;
    usedNames.add(n.toLowerCase());
    if (checkBlockName(n)) n = `bloque_${blockDefs.size + 1}`;
    const pos = blk.position ?? { x: 0, y: 0 };
    blockDefs.set(name, { name: n, base: mpt(baseMat ?? [1, 0, 0, 1, 0, 0], [pos.x, pos.y]), entities: list });
    blockMap.set(name, n);
    return n;
  }

  for (const r of hatches.filter((h) => !h.block)) {
    if (r.paper && !opts.includePaperSpace) { bump(omitted, 'HATCH (espacio papel)'); continue; }
    hatchEnt(r, { m: baseMat, depth: 0, inBlock: false });
  }
  walk(dxf.entities ?? [], { m: baseMat, depth: 0, inBlock: false });

  for (const [k, n] of Object.entries(unsupported)) {
    bump(omitted, k, n);
    warnings.push(k === 'HATCH' ? `${n} sombreado(s) HATCH ignorado(s) (el dibujo no tiene sombreados).` : `${n} entidad(es) ${k} ignorada(s) (no soportadas).`);
  }
  const des = Object.entries(omitted).filter(([k]) => !(k in unsupported));
  if (des.length) warnings.push(`Omitido: ${des.map(([k, n]) => `${n} ${k}`).join(', ')}.`);

  // capas finales: las usadas por las entidades, "0" y las que quedan tras los descartes
  const finalLayers: Layer[] = [];
  for (const l of layers.values()) {
    if (l.name !== '0' && dropsLayer(l.name)) continue;
    finalLayers.push(l);
  }
  finalLayers.sort((a, b) => (a.name === '0' ? -1 : b.name === '0' ? 1 : 0));

  const drawing: Drawing = {
    id: opts.id ?? 'd1', name: (opts.name ?? 'Importado').trim() || 'Importado', plane: opts.plane ?? 'xy', origin: [0, 0, 0],
    layers: finalLayers, entities: out,
    ...(blockDefs.size ? { blocks: [...blockDefs.values()] } : {}),
  };
  if (failedHatch) { bump(omitted, 'HATCH', failedHatch); warnings.push(`${failedHatch} sombreado(s) HATCH ignorado(s) (sin contornos que se puedan leer).`); }
  if (!out.length) warnings.push('El DXF no tiene entidades importables (líneas, polilíneas, círculos, arcos, textos…).');
  return { drawing, warnings, stats: { imported, omitted, entities: out.length }, units: { factor, source } };
}
