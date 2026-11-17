import { defaultHardware, defaultProject, type CabinetSpec, type Material, type Part, type Project, type Room, type Vec3 } from '../core/types';
import { addCabinet, groupOf, layerOf, nextId, rebuildCabinet } from '../core/furniture';
import { cutList, cutPiece, isShaped, nest, rebateText, type NestingResult } from '../core/nesting';
import { applyAutoEdges, edgeMeters } from '../core/edges';
import { applyAutoHardware, budget } from '../core/budget';
import { fitToRoom, type FitMode } from '../core/layout';
import { DEFAULT_GCODE, placedPiece, type GcodeOptions } from '../core/export';
import { openingConflicts } from '../core/clearance';
import { describeSolid, isRotated, isSolid, partBounds, validatePart } from '../core/solids';
import { livePaused } from './livePause';
import { setupPlanDialog } from './planDialog';
import { refreshElevButton, setupElevations } from './elevDialog';
import { refreshIdsButton, setupIds } from './idDialog';
import { setupFinishes } from './finishPanel';
import type { TextureItem } from '../core/finish';
import { Viewer, type FlashItem, type ViewName } from './viewer';
import { History } from './history';
import { MOVE_STEPS, cleanMm, fmtMm, parseMoveStep } from '../core/units';
import { renderPlans } from './plans';
import { dxf, download, gcode, piecesCsv } from './exporters';
import { setupDrawings } from './drawingUi';
import { setupDrawingTools } from './drawingTools2d';
import { setupDrawingIo } from './drawingIo';
import { setupHatchBlocks } from './hatchBlocksUi';
import { setupMeshImport } from './meshImportDialog';
import { setupExport } from './exportDialog';
import { McadError, mcadFileName, parseMcad, serializeMcad } from '../core/mcad';

type Tab = 'd3' | 'plans' | 'cuts' | 'budget' | 'labels';
interface Template { name: string; group: string; parts: Part[] }

let project: Project = defaultProject();
let rev = 0;
let selGroup: string | null = null;
let selPart: string | null = null;
let tab: Tab = 'd3';
let showRoom = true;
let showPlan = true;
let showRoof = false;
let showWalls = true;
let showIds = true;
let showFloors = true;
let catalog: TextureItem[] = [];
const hiddenGroups = new Set<string>();
const hiddenLayers = new Set<string>();
const history = new History();

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
/** Limpia el ruido de coma flotante (hasta 0,001 mm); ya no redondea a 0,1 mm. */
const round = cleanMm;
const money = (n: number) => n.toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const matName = (id: string) => project.materials.find((m) => m.id === id)?.name ?? id;
const isPurchased = (p: Part) => !!project.materials.find((m) => m.id === p.material)?.purchased;
const toast = (text: string, ms = 3500) => { viewer.onInfo(text); setTimeout(() => viewer.onInfo(null), ms); };

const viewer = new Viewer($<HTMLCanvasElement>('canvas'));
if (new URLSearchParams(location.search).has('debug')) (window as unknown as { __viewer: Viewer }).__viewer = viewer; // con ?debug en la dirección: permite mover la cámara desde la consola

// --- datos y deshacer ------------------------------------------------------

function adopt(p: Project) {
  project = p;
  project.hardware ??= defaultHardware();
  project.edgePrice ??= 0;
  for (const part of project.parts) part.group = groupOf(part);
  if (selGroup && !project.parts.some((x) => x.group === selGroup)) { selGroup = null; selPart = null; }
  if (selPart && !project.parts.some((x) => x.id === selPart)) selPart = null;
}

async function load() {
  const r = await (await fetch('/api/project')).json();
  rev = r.rev;
  adopt(r.project ?? defaultProject());
  await fin.loadCatalog();
  render();
}

let saving = 0;
/**
 * Guarda el proyecto indicando sobre qué versión (rev) se editó. Si el agente (MCP) escribió entretanto, el servidor responde 409:
 * se adopta su versión (resaltando lo que cambió) y, si se conoce el cambio del usuario (`reapply`), se vuelve a aplicar encima y a guardar.
 */
async function save(reapply?: () => void): Promise<void> {
  saving++;
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch('/api/project', { method: 'PUT', headers: { 'x-rev': String(rev) }, body: JSON.stringify(project) });
      const r = await res.json();
      if (res.status !== 409) { rev = r.rev; break; }
      const old = project;
      rev = r.rev;
      adopt(r.project);
      flashChanges(old, project);
      void pullActivity();
      if (reapply && attempt < 2) { reapply(); continue; }
      toast('El agente cambió el proyecto mientras editabas: se cargó su versión. Repite tu cambio.', 6000);
      break;
    }
  } finally { saving--; }
  render();
}

const checkpoint = () => history.push(JSON.stringify(project));
function commit(change: () => void) { checkpoint(); change(); return save(change); }

function undo() {
  const s = history.undo(JSON.stringify(project));
  if (s) { adopt(JSON.parse(s)); save(); }
}
function redo() {
  const s = history.redo(JSON.stringify(project));
  if (s) { adopt(JSON.parse(s)); save(); }
}

// El agente (MCP) escribe el mismo archivo: se recarga cuando cambia, y ese cambio también se puede deshacer.
async function pullExternal() {
  if (saving) return;
  const r = await (await fetch('/api/project')).json();
  if (saving || !r.project || r.rev === rev) return;
  rev = r.rev;
  const old = project;
  checkpoint();
  adopt(r.project);
  void pullCatalog(true);
  flashChanges(old, project);
  render();
}

// --- agente en vivo: resaltado de piezas, indicador y registro de actividad -------------------------------------

/** Compara piezas por id y resalta en el visor las nuevas (verde), las modificadas (naranja) y las borradas (rojo, donde estaban). */
function flashChanges(old: Project, cur: Project) {
  const before = new Map(old.parts.map((p) => [p.id, p]));
  const now = new Map(cur.parts.map((p) => [p.id, p]));
  const items: FlashItem[] = [];
  const count = { nuevas: 0, modificadas: 0, borradas: 0 };
  for (const [id, p] of now) {
    const o = before.get(id);
    if (!o) { count.nuevas++; items.push({ ...partBounds(p), kind: 'new' }); } else if (JSON.stringify(o) !== JSON.stringify(p)) { count.modificadas++; items.push({ ...partBounds(p), kind: 'edit' }); }
  }
  for (const [id, p] of before) if (!now.has(id)) { count.borradas++; items.push({ ...partBounds(p), kind: 'del' }); }
  const dr = drawings.changes(old, cur); // dibujos 2D: resalta en el lienzo y devuelve las cajas 3D
  items.push(...dr.items);
  if (!items.length) return;
  viewer.flash(items.slice(0, 400));
  const txt = [count.nuevas && `+${count.nuevas} nueva${count.nuevas > 1 ? 's' : ''}`, count.modificadas && `${count.modificadas} modificada${count.modificadas > 1 ? 's' : ''}`, count.borradas && `${count.borradas} borrada${count.borradas > 1 ? 's' : ''}`, dr.text && `dibujos: ${dr.text}`].filter(Boolean).join(' · ');
  lastChange = { text: txt, at: Date.now() };
  paintAgent();
}

interface ActivityItem { t: number; tool: string; mode: string; ok: boolean; message: string }
let activity: ActivityItem[] = [];
let activityAt = 0; // marca local (Date.now) de la última llamada del agente, para no depender de que los relojes coincidan
let lastChange: { text: string; at: number } | null = null;
let agentOpen = false;
const WORKING_MS = 6000;

async function pullActivity() {
  try {
    const r = await (await fetch('/api/actividad')).json() as { now: number; items: ActivityItem[] };
    activity = r.items;
    const last = activity[activity.length - 1];
    activityAt = last ? Date.now() - Math.max(0, r.now - last.t) : 0;
    paintAgent();
  } catch { /* sin servidor: se reintenta */ }
}

function paintAgent() {
  const box = $('agent');
  const last = activity[activity.length - 1];
  box.style.display = last ? 'block' : 'none';
  if (!last) return;
  const working = Date.now() - activityAt < WORKING_MS;
  box.classList.toggle('working', working);
  $('agentState').textContent = working ? 'Agente trabajando…' : 'Agente inactivo';
  const recentChange = lastChange && Date.now() - lastChange.at < 30000 ? ` · ${lastChange.text}` : '';
  $('agentLast').textContent = `${last.tool}${recentChange}`;
  $('agentLog').style.display = agentOpen ? 'block' : 'none';
  if (agentOpen) {
    $('agentLog').innerHTML = [...activity].reverse().slice(0, 12).map((a) => `<div class="${a.ok ? '' : 'err'} ${a.mode === 'read' ? 'rd' : ''}"><time>${new Date(a.t).toLocaleTimeString('es', { hour12: false })}</time> <b>${esc(a.tool)}</b> ${esc(a.message)}</div>`).join('');
  }
}
$('agentHead').onclick = () => { agentOpen = !agentOpen; paintAgent(); };
setInterval(paintAgent, 500);

// Cambios en vivo: el servidor avisa por SSE en cuanto cambia project.json o la actividad del agente (menos de 1 s). El sondeo de abajo queda de respaldo.
const paused = () => {
  const el = document.activeElement;
  // los diálogos de formulario del dibujo 2D (data-live) no pausan: su contenido vive en su propio DOM; los demás sí y se aplica lo pendiente al cerrarlos
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('dialog[open]')).map((d) => ({ live: d.dataset.live === '1' }));
  const focus = el instanceof HTMLElement && el.classList.contains('d2-cmdin') ? 'cmd' : el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? 'field' : 'other';
  return livePaused({ dialogs, focus, inLiveDialog: !!(el instanceof HTMLElement && el.closest('dialog[data-live="1"]')) });
};
if (typeof EventSource !== 'undefined') {
  new EventSource('/api/events').onmessage = () => { void pullActivity(); if (!paused()) void pullExternal(); };
  // lo pendiente de un diálogo del proyecto se aplica en cuanto se cierra (los eventos «close» no burbujean: captura)
  document.addEventListener('close', () => { setTimeout(() => { if (!paused()) void pullExternal(); }, 0); }, true);
}
// El agente también puede agregar texturas a la biblioteca (texturas/catalogo.json): se recarga el catálogo si cambió.
let catalogSig = '';
async function pullCatalog(force = false) {
  try {
    const sig = await (await fetch('/api/texturas')).text();
    const changed = sig !== catalogSig;
    catalogSig = sig;
    if (changed || force) await fin.loadCatalog();
  } catch { /* sin servidor: se reintenta */ }
}
let ticks = 0;
setInterval(() => {
  if (paused()) return;
  void pullExternal();
  if (++ticks % 5 === 0) { void pullCatalog(); void pullActivity(); }
}, 1000);

let shotTimer: number | undefined;
function scheduleShot() {
  clearTimeout(shotTimer);
  shotTimer = window.setTimeout(() => { if (tab === 'd3') fetch('/api/screenshot', { method: 'POST', body: viewer.capture() }); }, 500);
}

// --- agrupación -------------------------------------------------------------

function groups(): Map<string, Part[]> {
  const map = new Map<string, Part[]>();
  for (const p of project.parts) {
    const g = p.group ?? groupOf(p);
    map.set(g, [...(map.get(g) ?? []), p]);
  }
  return map;
}

function bbox(parts: Part[]) {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const b = partBounds(p); // con giro: caja envolvente del mundo; sin giro, position / position + size
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], b.min[i]); max[i] = Math.max(max[i], b.max[i]); }
  }
  return { min, max, size: [0, 1, 2].map((i) => round(max[i] - min[i])) as Vec3 };
}

const selectedGroupParts = () => (selGroup ? groups().get(selGroup) ?? [] : []);
function selectedIds(): Set<string> {
  if (selPart) return new Set([selPart]);
  return new Set(selectedGroupParts().map((p) => p.id));
}
const rightEdge = () => project.parts.filter((p) => !isPurchased(p)).reduce((m, p) => Math.max(m, partBounds(p).max[0]), 0);
const isHidden = (p: Part) => hiddenGroups.has(p.group ?? '') || hiddenLayers.has(layerOf(project, p));

// --- interacción con el visor -----------------------------------------------

viewer.onPick = (id) => {
  const part = project.parts.find((p) => p.id === id);
  if (!part) return;
  // Primer clic elige el mueble; un segundo clic en el mismo mueble elige la pieza.
  if (selGroup === part.group) selPart = id;
  else { selGroup = part.group!; selPart = null; }
  render();
};

viewer.onDragEnd = (d) => {
  const ids = selectedIds();
  commit(() => {
    for (const p of project.parts) if (ids.has(p.id)) p.position = p.position.map((v, i) => round(v + d[i])) as Vec3;
  });
};

viewer.onInfo = (text) => {
  const el = $('info');
  el.style.display = text ? 'block' : 'none';
  if (text) el.textContent = text;
};

// --- panel lateral ----------------------------------------------------------

function renderList() {
  const gs = groups();
  if (!gs.size) {
    $('list').innerHTML = '<div class="empty">Todavía no hay muebles.<br />Pulsa <b>+ Agregar mueble</b> para empezar.</div>';
    return;
  }
  let html = '<h2>Muebles</h2>';
  for (const [name, parts] of gs) {
    const b = bbox(parts);
    const open = name === selGroup;
    html += `<div class="item ${open && !selPart ? 'sel' : ''} ${hiddenGroups.has(name) ? 'off' : ''}" data-g="${esc(name)}">
      <button class="eye" data-eye="${esc(name)}" title="Mostrar / ocultar">${hiddenGroups.has(name) ? '○' : '●'}</button>
      <div class="meta"><b>${esc(name)}</b><small>${parts.length} piezas · ${fmtMm(b.size[0])} × ${fmtMm(b.size[1])} × ${fmtMm(b.size[2])} mm</small></div></div>`;
    if (open) {
      html += '<div class="subparts">' + parts.map((p) => {
        const c = cutPiece(p);
        return `<div class="${p.id === selPart ? 'sel' : ''}" data-p="${p.id}"><span>${esc(p.name.replace(name, '').trim() || p.name)}</span><small>${fmtMm(c.length)}×${fmtMm(c.width)}×${fmtMm(c.thickness)}</small></div>`;
      }).join('') + '</div>';
    }
  }
  $('list').innerHTML = html;
}

function field(label: string, key: string, value: string | number, type = 'number', wide = false, attr = 'data-k') {
  return `<div class="${wide ? 'wide' : ''}"><label>${label}</label><input ${attr}="${key}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${esc(String(value))}" ${type === 'text' ? 'list="layerList"' : ''} /></div>`;
}
const select = (key: string, options: [string | number, string][], value: string | number, label: string, attr = 'data-k') =>
  `<div><label>${label}</label><select ${attr}="${key}">${options.map(([v, t]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;

const allLayers = () => [...new Set(project.parts.map((p) => layerOf(project, p)))];

function specFields(spec: CabinetSpec): string {
  const corner = spec.kind === 'corner';
  return `<h4>Medidas del mueble (se regenera)</h4><div class="grid">
    ${field(corner ? 'Brazo X' : 'Ancho', 'width', spec.width, 'number', false, 'data-c')}${field('Alto', 'height', spec.height, 'number', false, 'data-c')}${field('Fondo', 'depth', spec.depth, 'number', false, 'data-c')}
    ${corner ? field('Brazo Z', 'wingB', spec.wingB ?? spec.width, 'number', false, 'data-c') : ''}
    ${field('Repisas', 'shelves', spec.shelves ?? 0, 'number', false, 'data-c')}${corner ? '' : field('Cajones', 'drawers', spec.drawers ?? 0, 'number', false, 'data-c')}
    ${field('Puertas (0=auto)', 'doors', spec.doors ?? 0, 'number', false, 'data-c')}
    ${spec.backMaterial ? select('rebateBack', [[0, 'Fondo entre laterales'], [1, 'Fondo embutido (rebaje)']], spec.rebateBack ? 1 : 0, 'Fondo', 'data-c') : ''}</div>
    <div class="row"><button data-act="regen">Aplicar medidas</button></div>
    <div class="note">Al aplicar se vuelven a generar las piezas del mueble y se pierden las ediciones manuales que les hayas hecho.</div>`;
}

function renderInspector() {
  const el = $('inspector');
  $('layerList').innerHTML = allLayers().map((l) => `<option value="${esc(l)}"></option>`).join('');
  const part = project.parts.find((p) => p.id === selPart);
  if (part) {
    const c = cutPiece(part);
    const mats = project.materials.map((m) => `<option value="${m.id}" ${m.id === part.material ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
    const e = part.edges ?? { largo: 0, ancho: 0 };
    const sh = part.shape ?? {};
    const hole = sh.holes?.[0];
    const n = sh.notch;
    const rb = part.rebates?.[0];
    const qty3: [number, string][] = [[0, 'Ninguno'], [1, '1 canto'], [2, '2 cantos']];
    const solid = isSolid(part);
    const rotInfo = isRotated(part) ? ` Girada ${part.rotX ?? 0}°, ${part.rotY ?? 0}°, ${part.rotZ ?? 0}° (X, Y, Z) alrededor del centro.` : '';
    el.innerHTML = `<h3>Pieza</h3><div class="grid">
      ${field('Nombre', 'pname', part.name, 'text', true)}
      ${field('Ancho X', 'sx', part.size[0])}${field('Alto Y', 'sy', part.size[1])}${field('Fondo Z', 'sz', part.size[2])}
      ${field('Posición X', 'px', part.position[0])}${field('Posición Y', 'py', part.position[1])}${field('Posición Z', 'pz', part.position[2])}
      <div class="wide"><label>Material</label><select data-k="pmat">${mats}</select></div></div>
      <h4>Giro (grados, alrededor del centro; orden X, Y, Z)</h4>
      <div class="grid">${field('Giro X', 'rtx', part.rotX ?? 0)}${field('Giro Y', 'rty', part.rotY ?? 0)}${field('Giro Z', 'rtz', part.rotZ ?? 0)}</div>
      ${solid ? `<div class="note">Forma sólida: ${esc(describeSolid(part))}. No entra al despiece de planchas (las medidas son su caja envolvente; edita el resto con el agente MCP o en project.json).${rotInfo}</div>` : `<div class="note">Se corta de ${fmtMm(c.length)} × ${fmtMm(c.width)} mm, espesor ${fmtMm(c.thickness)} mm. Tapacanto: ${edgeMeters(part).toFixed(2)} m. ${esc(rebateText(part))}${rotInfo}</div>
      <h4>Tapacanto</h4>
      <div class="grid g2">${select('edL', qty3, e.largo, 'Lados largos')}${select('edA', qty3, e.ancho, 'Lados cortos')}</div>
      <h4>Forma (medidas sobre la pieza: largo × ancho)</h4>
      <div class="grid g2">${field('Esquinas redondeadas (radio mm)', 'rad', sh.radius ?? 0)}</div>
      <div class="grid g4">${field('Muesca ancho', 'nw', n?.w ?? 0)}${field('Muesca alto', 'nh', n?.h ?? 0)}
        ${select('nc', [[0, 'Esq. 1'], [1, 'Esq. 2'], [2, 'Esq. 3'], [3, 'Esq. 4']], n?.corner ?? 2, 'Esquina')}</div>
      <div class="grid g4">${field('Hueco x', 'hx', hole?.x ?? 0)}${field('Hueco y', 'hy', hole?.y ?? 0)}${field('Hueco ancho', 'hw', hole?.w ?? 0)}${field('Hueco alto', 'hh', hole?.h ?? 0)}</div>
      <h4>Rebaje (ranura para embutir el fondo)</h4>
      <div class="grid g4">${select('rbE', [[-1, 'Ninguno'], [0, 'Largo A'], [1, 'Corto A'], [2, 'Largo B'], [3, 'Corto B']], rb?.edge ?? -1, 'Canto')}${field('Ancho', 'rbW', rb?.width ?? 3)}${field('Profundo', 'rbD', rb?.depth ?? 8)}</div>
      `}
      <h4>Capa</h4>
      <div class="grid">${field('Capa propia (vacío = automática)', 'plyr', part.layer ?? '', 'text', true)}</div>
      <div class="row"><button class="danger" data-act="delPart">Eliminar pieza</button></div>`;
    return;
  }
  const parts = selectedGroupParts();
  if (selGroup && parts.length) {
    const b = bbox(parts);
    const spec = project.cabinets?.[selGroup];
    el.innerHTML = `<h3>Mueble</h3><div class="grid">
      ${field('Nombre', 'gname', selGroup, 'text', true)}
      ${field('Posición X', 'gx', b.min[0])}${field('Posición Y', 'gy', b.min[1])}${field('Posición Z', 'gz', b.min[2])}
      ${field('Capa propia para todo el mueble (vacío = automática)', 'glyr', parts.every((p) => p.layer && p.layer === parts[0].layer) ? parts[0].layer! : '', 'text', true)}</div>
      <div class="note">Medidas: ${fmtMm(b.size[0])} × ${fmtMm(b.size[1])} × ${fmtMm(b.size[2])} mm. También puedes arrastrarlo en el 3D.</div>
      <div class="row"><button data-act="dup">Duplicar</button><button data-act="tpl">Guardar como plantilla</button><button data-act="edges">Tapacanto automático</button><button class="danger" data-act="delGroup">Eliminar</button></div>
      ${spec ? specFields(spec) : ''}`;
    return;
  }
  el.innerHTML = '<div class="note">Elige un mueble de la lista (o haz clic en él en el 3D) para editar su nombre, medidas y posición.</div>';
}

$('inspector').addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const k = t.dataset.k;
  if (!k) return;
  const root = $('inspector');
  const val = (key: string) => (root.querySelector<HTMLInputElement>(`[data-k="${key}"]`)?.value ?? '');
  const part = project.parts.find((p) => p.id === selPart);
  commit(() => {
    if (part) {
      const axis = { x: 0, y: 1, z: 2 } as const;
      const before = structuredClone(part);
      if (k === 'pname') part.name = t.value;
      else if (k === 'pmat') part.material = t.value;
      else if (k === 'rtx' || k === 'rty' || k === 'rtz') {
        const key = ({ rtx: 'rotX', rty: 'rotY', rtz: 'rotZ' } as const)[k];
        if (num(t.value)) part[key] = num(t.value); else delete part[key];
      }
      else if (k === 'plyr') { const v = t.value.trim(); if (v) part.layer = v; else delete part.layer; }
      else if (k === 'edL' || k === 'edA') part.edges = { largo: num(val('edL')) as 0 | 1 | 2, ancho: num(val('edA')) as 0 | 1 | 2 };
      else if (k === 'rbE' || k === 'rbW' || k === 'rbD') {
        const edge = num(val('rbE'));
        part.rebates = edge >= 0 && num(val('rbW')) > 0 && num(val('rbD')) > 0 ? [{ edge: edge as 0 | 1 | 2 | 3, width: num(val('rbW')), depth: num(val('rbD')) }] : undefined;
        if (!part.rebates) delete part.rebates;
      } else if (k === 'rad' || k === 'nw' || k === 'nh' || k === 'nc' || k.startsWith('h')) {
        const shape = part.shape ?? {};
        shape.radius = num(val('rad')) > 0 ? num(val('rad')) : undefined;
        shape.notch = num(val('nw')) > 0 && num(val('nh')) > 0 ? { w: num(val('nw')), h: num(val('nh')), corner: num(val('nc')) as 0 | 1 | 2 | 3 } : undefined;
        shape.holes = num(val('hw')) > 0 && num(val('hh')) > 0 ? [{ x: num(val('hx')), y: num(val('hy')), w: num(val('hw')), h: num(val('hh')) }] : undefined;
        part.shape = isShaped(shape) || shape.edgeRound ? shape : undefined;
      } else if (k[0] === 's') part.size[axis[k[1] as 'x']] = Math.max(1, num(t.value));
      else if (k[0] === 'p') part.position[axis[k[1] as 'x']] = num(t.value);
      // un cambio que deje la pieza inválida (p. ej. un tubo con pared mayor que su lado) se deshace con aviso
      const err = validatePart(part);
      if (err && !validatePart(before)) {
        for (const key of Object.keys(part)) delete (part as unknown as Record<string, unknown>)[key];
        Object.assign(part, before);
        setTimeout(() => alert(err), 0);
      }
    } else if (selGroup) {
      const gp = selectedGroupParts();
      if (k === 'gname') {
        const name = t.value.trim() || selGroup;
        gp.forEach((p) => (p.group = name));
        if (hiddenGroups.delete(selGroup)) hiddenGroups.add(name);
        if (project.cabinets?.[selGroup]) { project.cabinets[name] = project.cabinets[selGroup]; delete project.cabinets[selGroup]; }
        selGroup = name;
      } else if (k === 'glyr') {
        const v = t.value.trim();
        gp.forEach((p) => { if (v) p.layer = v; else delete p.layer; });
      } else {
        const axis = { gx: 0, gy: 1, gz: 2 }[k as 'gx'];
        const delta = num(t.value) - bbox(gp).min[axis];
        gp.forEach((p) => (p.position[axis] = round(p.position[axis] + delta)));
      }
    }
  });
});

$('inspector').addEventListener('click', async (e) => {
  const act = (e.target as HTMLElement).dataset.act;
  if (!act) return;
  if (act === 'delPart' && selPart) {
    commit(() => { project.parts = project.parts.filter((p) => p.id !== selPart); selPart = null; });
  } else if (act === 'delGroup' && selGroup) {
    if (!confirm(`¿Eliminar "${selGroup}" y sus ${selectedGroupParts().length} piezas? (Se puede deshacer con Ctrl+Z)`)) return;
    commit(() => { project.parts = project.parts.filter((p) => p.group !== selGroup); if (project.cabinets) delete project.cabinets[selGroup!]; selGroup = null; });
  } else if (act === 'dup' && selGroup) duplicateGroup();
  else if (act === 'edges' && selGroup) commit(() => { applyAutoEdges(project, selGroup!); });
  else if (act === 'regen' && selGroup) {
    const get = (k: string) => $('inspector').querySelector<HTMLInputElement | HTMLSelectElement>(`[data-c="${k}"]`)?.value;
    const patch: Partial<CabinetSpec> = {};
    for (const k of ['width', 'height', 'depth', 'wingB', 'shelves', 'drawers', 'doors'] as const) { const v = get(k); if (v !== undefined) patch[k] = Math.max(0, num(v)); }
    const rb = get('rebateBack');
    if (rb !== undefined) patch.rebateBack = rb === '1';
    checkpoint();
    try {
      rebuildCabinet(project, selGroup, patch);
      selPart = null;
      await save();
    } catch (err) {
      history.drop();
      toast((err as Error).message, 6000);
    }
  } else if (act === 'tpl' && selGroup) {
    const name = await askName('Nombre de la plantilla', selGroup);
    if (!name) return;
    const parts = selectedGroupParts();
    const b = bbox(parts);
    const tpls = await fetchTemplates();
    tpls.push({ name, group: selGroup, parts: parts.map((p) => ({ ...p, id: '', size: [...p.size], position: [p.position[0] - b.min[0], p.position[1], p.position[2] - b.min[2]] as Vec3 })) });
    await fetch('/api/templates', { method: 'PUT', body: JSON.stringify(tpls) });
    toast(`Plantilla "${name}" guardada`);
  }
});

function duplicateGroup() {
  if (!selGroup) return;
  const parts = selectedGroupParts();
  const b = bbox(parts);
  let name = `${selGroup} copia`;
  for (let i = 2; groups().has(name); i++) name = `${selGroup} copia ${i}`;
  const from = selGroup;
  commit(() => {
    for (const p of parts) {
      project.parts.push({ ...p, id: nextId(project), name: p.name.replace(from, name), group: name, size: [...p.size], position: [p.position[0] + b.size[0], p.position[1], p.position[2]] });
    }
    if (project.cabinets?.[from]) project.cabinets[name] = { ...project.cabinets[from] };
    selGroup = name;
  });
}

$('list').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const eye = t.closest<HTMLElement>('[data-eye]');
  if (eye) {
    const g = eye.dataset.eye!;
    hiddenGroups.has(g) ? hiddenGroups.delete(g) : hiddenGroups.add(g);
    return render();
  }
  const sub = t.closest<HTMLElement>('[data-p]');
  if (sub) { selPart = sub.dataset.p!; return render(); }
  const item = t.closest<HTMLElement>('[data-g]');
  if (item) { selGroup = item.dataset.g!; selPart = null; render(); }
});

// --- PDF --------------------------------------------------------------------

async function exportPdf() {
  const app = (window as unknown as { muebleApp?: { savePdf: (name: string) => Promise<string | null> } }).muebleApp;
  if (!app) return window.print(); // en el navegador: el diálogo de impresión permite guardar como PDF
  const saved = await app.savePdf(`${project.name}.pdf`);
  if (saved) toast(`PDF guardado en ${saved}`, 5000);
}

// --- cortes -----------------------------------------------------------------

const edgeText = (e: { largo: number; ancho: number }) => (e.largo || e.ancho ? `${e.largo} largos · ${e.ancho} cortos` : '—');

function renderCuts(result: NestingResult) {
  const rows = cutList(project).map((r) => `<tr><td>${r.qty}</td><td><b>${fmtMm(r.length)} × ${fmtMm(r.width)}</b> × ${fmtMm(r.thickness)}</td>
    <td>${esc(matName(r.material))}</td><td>${edgeText(r.edges)}</td>
    <td>${r.shaped ? '<span class="tag">con forma</span> ' : ''}${esc(r.rebates)}</td><td class="muted">${esc(r.names.join(', '))}</td></tr>`).join('');
  const sheets = result.sheets.map((s) => {
    const { sheetW, sheetH } = s.material;
    const shapes = s.placements.map((pl) => {
      const part = project.parts.find((p) => p.id === pl.partId);
      const placed = placedPiece(part, pl, sheetH);
      const pt = ([x, y]: [number, number]) => `${x},${sheetH - y}`;
      const d = [placed.outer, ...placed.holes].map((ring) => 'M' + ring.map(pt).join('L') + 'Z').join(' ');
      const reb = placed.rebates.map((r) => `<line x1="${r.a[0]}" y1="${sheetH - r.a[1]}" x2="${r.b[0]}" y2="${sheetH - r.b[1]}" stroke="#ea580c" stroke-opacity="0.55" stroke-width="${Math.max(r.width, 5)}" />`).join('');
      const fs = Math.min(60, pl.w / 7, pl.h / 3);
      return `<path d="${d}" fill="${s.material.color}" fill-rule="evenodd" stroke="#374151" stroke-width="3" />${reb}
        <text x="${pl.x + pl.w / 2}" y="${pl.y + pl.h / 2}" font-size="${fs}" text-anchor="middle" fill="#111827">${esc(pl.name)}</text>
        <text x="${pl.x + pl.w / 2}" y="${pl.y + pl.h / 2 + fs * 1.1}" font-size="${fs * 0.85}" text-anchor="middle" fill="#374151">${fmtMm(pl.w, 0, 1)} × ${fmtMm(pl.h, 0, 1)}${pl.rotated ? ' ↻' : ''}</text>`;
    }).join('');
    const cuts = s.cuts.map((c) => {
      const [x1, y1, x2, y2] = c.orientation === 'h' ? [c.from, c.pos, c.to, c.pos] : [c.pos, c.from, c.pos, c.to];
      const [cx, cy] = c.orientation === 'h' ? [c.from + 26, c.pos] : [c.pos, c.from + 26];
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#dc2626" stroke-width="3" stroke-dasharray="14 10" />
        <circle cx="${cx}" cy="${cy}" r="22" fill="#dc2626" /><text x="${cx}" y="${cy + 9}" font-size="26" text-anchor="middle" fill="#fff" font-weight="700">${c.n}</text>`;
    }).join('');
    return `<div class="sheet"><b>${esc(s.material.name)}</b> · plancha ${s.index} · aprovechamiento ${(s.efficiency * 100).toFixed(0)}% · ${s.cuts.length} cortes
      <svg viewBox="-10 -10 ${sheetW + 20} ${sheetH + 20}"><rect width="${sheetW}" height="${sheetH}" fill="none" stroke="#9ca3af" stroke-width="5" />${shapes}${cuts}</svg></div>`;
  }).join('');
  const totals = new Map<string, number>();
  result.sheets.forEach((s) => totals.set(s.material.name, (totals.get(s.material.name) ?? 0) + 1));
  const meters = project.parts.reduce((s, p) => s + edgeMeters(p), 0);
  const cards = [...totals].map(([n, c]) => `<div class="card"><b>${c}</b><span>${esc(n)}</span></div>`).join('') +
    (meters ? `<div class="card"><b>${meters.toFixed(1)} m</b><span>Tapacanto</span></div>` : '');
  $('cuts').innerHTML = `
    <div class="bar noprint">
      <label>Grosor del corte (mm)<input id="kerf" type="number" min="0" step="0.5" value="${project.kerf}" /></label>
      <button id="autoEdges">Tapacanto automático a todo</button>
      <div class="spacer"></div>
      <button id="csv">CSV</button><button id="dxf">DXF</button><button id="nc">G-code CNC</button><button id="print">Guardar PDF</button>
    </div>
    <h2>Planchas necesarias</h2>
    <div class="cards">${cards || '<span class="muted">Sin piezas para cortar.</span>'}</div>
    ${result.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
    <h2>Lista de cortes</h2>
    <table><tr><th>Cant.</th><th>Largo × Ancho × Espesor (mm)</th><th>Material</th><th>Tapacanto</th><th>Mecanizado</th><th>Piezas</th></tr>${rows}</table>
    <h2>Distribución en planchas <span class="muted" style="font-weight:400;font-size:13px">· rojo: cortes de lado a lado, en orden · naranja: rebajes</span></h2>${sheets || '<p class="muted">Sin piezas.</p>'}`;
  input('kerf').onchange = () => commit(() => { project.kerf = Math.max(0, num(input('kerf').value)); });
  $('autoEdges').onclick = () => commit(() => { applyAutoEdges(project); });
  $('print').onclick = exportPdf;
  $('csv').onclick = () => download(`${project.name}-cortes.csv`, piecesCsv(project, result), 'text/csv;charset=utf-8');
  $('dxf').onclick = () => download(`${project.name}-planchas.dxf`, dxf(project, result), 'application/dxf');
  $('nc').onclick = openGcode;
}

// G-code
const GC_KEY = 'mueblecad.gcode';
function readGcodeOptions(): GcodeOptions {
  try { return { ...DEFAULT_GCODE, ...JSON.parse(localStorage.getItem(GC_KEY) ?? '{}') }; } catch { return { ...DEFAULT_GCODE }; }
}
function openGcode() {
  const o = readGcodeOptions();
  input('gTool').value = String(o.toolDiameter);
  input('gFeed').value = String(o.feed);
  input('gPlunge').value = String(o.plungeFeed);
  input('gPass').value = String(o.passDepth);
  input('gSafe').value = String(o.safeZ);
  input('gRpm').value = String(o.spindle);
  $<HTMLDialogElement>('dlgGcode').showModal();
}
$('gcodeForm').addEventListener('submit', (e) => {
  if ((e as SubmitEvent).submitter?.getAttribute('value') !== 'ok') return;
  const o: GcodeOptions = {
    toolDiameter: Math.max(1, num(input('gTool').value)), feed: Math.max(1, num(input('gFeed').value)), plungeFeed: Math.max(1, num(input('gPlunge').value)),
    passDepth: Math.max(0.5, num(input('gPass').value)), safeZ: Math.max(1, num(input('gSafe').value)), spindle: Math.max(1, num(input('gRpm').value)),
  };
  try { localStorage.setItem(GC_KEY, JSON.stringify(o)); } catch { /* sin almacenamiento */ }
  download(`${project.name}.nc`, gcode(project, nest(project), o), 'text/plain');
});

// --- presupuesto ------------------------------------------------------------

function renderBudget(result: NestingResult) {
  const b = budget(project, result);
  const counts = new Map<string, number>();
  result.sheets.forEach((s) => counts.set(s.material.id, (counts.get(s.material.id) ?? 0) + 1));
  const matRows = project.materials.filter((m) => counts.has(m.id)).map((m) => {
    const qty = counts.get(m.id)!;
    return `<tr><td>${esc(m.name)}</td><td class="num">${qty}</td><td class="num"><input class="sm" type="number" min="0" data-mprice="${m.id}" value="${m.price ?? 0}" /></td><td class="num">${money(qty * (m.price ?? 0))}</td></tr>`;
  }).join('');
  const meters = Math.round(project.parts.reduce((s, p) => s + edgeMeters(p), 0) * 100) / 100;
  const hwRows = (project.hardware ?? []).map((h) => `<tr><td>${esc(h.name)} ${h.rule ? '<span class="tag">auto</span>' : ''}</td>
    <td class="num"><input class="sm" type="number" min="0" data-hq="${h.id}" value="${h.qty}" /></td>
    <td class="num"><input class="sm" type="number" min="0" data-hp="${h.id}" value="${h.price}" /></td>
    <td class="num">${money(h.qty * h.price)}</td><td>${h.rule ? '' : `<button data-hdel="${h.id}" class="danger">✕</button>`}</td></tr>`).join('');
  const needPrices = b.total === 0 && project.parts.length > 0;
  $('budget').innerHTML = `
    <div class="bar noprint"><div class="spacer"></div><button id="print2">Guardar PDF</button></div>
    <div class="cards"><div class="card total"><b>${money(b.total)}</b><span>Total estimado</span></div></div>
    ${needPrices ? '<div class="warn">Escribe los precios de las planchas, el tapacanto y los herrajes para ver el total.</div>' : ''}
    <h2>Planchas</h2>
    <table><tr><th>Material</th><th class="num">Planchas</th><th class="num">Precio por plancha</th><th class="num">Subtotal</th></tr>${matRows || '<tr><td colspan="4" class="muted">Sin piezas.</td></tr>'}</table>
    <h2>Tapacanto</h2>
    <table><tr><th>Concepto</th><th class="num">Metros</th><th class="num">Precio por metro</th><th class="num">Subtotal</th></tr>
      <tr><td>Tapacanto</td><td class="num">${meters}</td><td class="num"><input class="sm" type="number" min="0" data-eprice value="${project.edgePrice ?? 0}" /></td><td class="num">${money(meters * (project.edgePrice ?? 0))}</td></tr></table>
    <h2>Herrajes</h2>
    <div class="bar noprint"><button id="hwAuto">Calcular herrajes del diseño</button><button id="hwAdd">+ Agregar herraje</button></div>
    <table><tr><th>Herraje</th><th class="num">Cantidad</th><th class="num">Precio unitario</th><th class="num">Subtotal</th><th></th></tr>${hwRows}</table>
    <p class="note">Las bisagras (2 a 4 por puerta según su altura), manijas, soportes de repisa y correderas se calculan solos; las cantidades se pueden corregir a mano.</p>`;
  $('print2').onclick = exportPdf;
  $('hwAuto').onclick = () => commit(() => { applyAutoHardware(project); });
  $('hwAdd').onclick = async () => {
    const name = await askName('Nombre del herraje', '');
    if (name) commit(() => { project.hardware!.push({ id: `h${Date.now()}`, name, price: 0, qty: 1 }); });
  };
}

$('budget').addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const d = t.dataset;
  if (d.mprice) commit(() => { project.materials.find((m) => m.id === d.mprice)!.price = Math.max(0, num(t.value)); });
  else if ('eprice' in d) commit(() => { project.edgePrice = Math.max(0, num(t.value)); });
  else if (d.hq) commit(() => { project.hardware!.find((h) => h.id === d.hq)!.qty = Math.max(0, Math.round(num(t.value))); });
  else if (d.hp) commit(() => { project.hardware!.find((h) => h.id === d.hp)!.price = Math.max(0, num(t.value)); });
});
$('budget').addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).dataset.hdel;
  if (id) commit(() => { project.hardware = project.hardware!.filter((h) => h.id !== id); });
});

// --- etiquetas y planos -----------------------------------------------------

function renderLabels(result: NestingResult) {
  const where = new Map<string, string>();
  for (const s of result.sheets) for (const pl of s.placements) where.set(pl.partId, `Plancha ${s.index} · x ${fmtMm(pl.x, 0, 1)}, y ${fmtMm(pl.y, 0, 1)}${pl.rotated ? ' ↻' : ''}`);
  const cards = project.parts.filter((p) => !isPurchased(p)).map((p) => {
    const c = cutPiece(p);
    return `<div class="label"><small>${esc(p.group ?? '')}</small><b>${esc(p.name.replace(p.group ?? '', '').trim() || p.name)}</b>
      <div class="dim">${fmtMm(c.length)} × ${fmtMm(c.width)} × ${fmtMm(c.thickness)}</div>
      <small>${esc(matName(p.material))}</small><small>Tapacanto: ${edgeText(p.edges ?? { largo: 0, ancho: 0 })}</small>${isShaped(p.shape) ? '<small>Con forma especial</small>' : ''}
      ${p.rebates?.length ? `<small>${esc(rebateText(p))}</small>` : ''}<small>${where.get(p.id) ?? ''}</small></div>`;
  }).join('');
  $('labels').innerHTML = `<div class="bar noprint"><div class="spacer"></div><button id="print3">Guardar PDF / imprimir etiquetas</button></div><div class="labels">${cards || '<p class="muted">Sin piezas.</p>'}</div>`;
  $('print3').onclick = exportPdf;
}

function renderPlansTab() {
  $('plans').innerHTML = `<div class="bar noprint"><div class="spacer"></div><button id="print4">Guardar PDF</button></div>
    <p class="note">Medidas en mm. Cotas generales abajo y a la derecha; el recuadro azul marca cada mueble.</p>${renderPlans(project, isHidden)}`;
  $('print4').onclick = exportPdf;
}

// --- render general ---------------------------------------------------------

function renderLayers() {
  const items = allLayers().map((l) => `<label><input type="checkbox" data-layer="${esc(l)}" ${hiddenLayers.has(l) ? '' : 'checked'} /> ${esc(l)}</label>`);
  if (project.plan) items.push(`<label><input type="checkbox" data-layer="__plan" ${showPlan ? 'checked' : ''} /> Plano CAD</label>`);
  if (project.plan?.panels?.some((e) => e.at)) items.push(`<label><input type="checkbox" data-layer="__walls" ${showWalls ? 'checked' : ''} /> Muros de la casa (elevaciones)</label>`);
  if (project.plan?.rooms?.length || project.plan?.walls?.length) items.push(`<label><input type="checkbox" data-layer="__ids" ${showIds ? 'checked' : ''} /> Identificadores (H, P, I, D)</label>`);
  if (project.plan?.roof) items.push(`<label><input type="checkbox" data-layer="__roof" ${showRoof ? 'checked' : ''} /> Techo (ensamble)</label>`);
  if (project.room) items.push(`<label><input type="checkbox" data-layer="__room" ${showRoom ? 'checked' : ''} /> Espacio (muros)</label>`);
  $('layersMenu').innerHTML = items.join('') || '<span class="muted">Sin capas</span>';
}

function render() {
  input('pname').value = project.name;
  $<HTMLButtonElement>('undo').disabled = !history.canUndo;
  $<HTMLButtonElement>('redo').disabled = !history.canRedo;
  renderList();
  renderInspector();
  renderLayers();
  refreshElevButton(project);
  refreshIdsButton(project);
  const warns = openingConflicts(project);
  $('warn').style.display = warns.length ? 'block' : 'none';
  $('warn').innerHTML = warns.map((w) => `⚠ ${esc(w)}`).join('<br>');
  viewer.update(project, { selected: selectedIds(), isHidden, showRoom, showPlan, showRoof, showWalls, showIds, showFloors, catalog });
  fin.refresh();
  drawings.refresh();
  fin.setVisible(tab === 'd3');
  if (tab !== 'd3') renderTab();
  scheduleShot();
}

function renderTab() {
  if (tab === 'plans') return renderPlansTab();
  const result = nest(project);
  if (tab === 'cuts') renderCuts(result);
  else if (tab === 'budget') renderBudget(result);
  else if (tab === 'labels') renderLabels(result);
}

function setTab(t: Tab) {
  tab = t;
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  for (const id of ['plans', 'cuts', 'budget', 'labels']) $(id).style.display = id === t ? 'block' : 'none';
  if (t !== 'd3') renderTab(); else scheduleShot();
}

document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => (b.onclick = () => setTab(b.dataset.tab as Tab)));
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => (b.onclick = () => viewer.view(b.dataset.view as ViewName)));
$('undo').onclick = undo;
$('redo').onclick = redo;
input('pname').onchange = () => commit(() => { project.name = input('pname').value.trim() || 'Proyecto'; });

$('measure').onclick = () => {
  const on = !viewer.measuring;
  viewer.setMeasuring(on);
  $('measure').classList.toggle('on', on);
};
// Copiar la última medida (distancia y ΔX/ΔY/ΔZ) al portapapeles.
let lastMeasure: string | null = null;
viewer.onMeasure = (text) => { lastMeasure = text; $('measureCopy').style.display = text ? '' : 'none'; };
$('measureCopy').onclick = async () => {
  if (!lastMeasure) return;
  try { await navigator.clipboard.writeText(lastMeasure); toast('Medida copiada: ' + lastMeasure); }
  catch { toast('No se pudo copiar; la medida es: ' + lastMeasure, 6000); }
};
// Paso de movimiento al arrastrar (libre / 0,1 / 1 / 5 / 10 / 50 mm) e imán a bordes: se recuerdan en este navegador.
const STEP_KEY = 'mueblecad.pasoMovimiento', SNAP_KEY = 'mueblecad.iman';
let stepRaw: string | null = null, snapOn = true;
try { stepRaw = localStorage.getItem(STEP_KEY); snapOn = localStorage.getItem(SNAP_KEY) !== 'off'; } catch { /* sin almacenamiento */ }
const stepSel = $<HTMLSelectElement>('moveStep');
stepSel.innerHTML = MOVE_STEPS.map((s) => `<option value="${s}">${s === 0 ? 'libre' : fmtMm(s) + ' mm'}</option>`).join('');
stepSel.value = String(parseMoveStep(stepRaw));
viewer.setMoveStep(Number(stepSel.value));
stepSel.onchange = () => {
  viewer.setMoveStep(Number(stepSel.value));
  try { localStorage.setItem(STEP_KEY, stepSel.value); } catch { /* sin almacenamiento */ }
};
viewer.setSnap(snapOn);
$('snap').classList.toggle('on', snapOn);
$('snap').onclick = () => {
  snapOn = !snapOn;
  viewer.setSnap(snapOn);
  $('snap').classList.toggle('on', snapOn);
  try { localStorage.setItem(SNAP_KEY, snapOn ? 'on' : 'off'); } catch { /* sin almacenamiento */ }
};
viewer.onGridStep = (mm) => { $('grid').title = `Muestra u oculta la cuadrícula del suelo (ahora cada ${fmtMm(mm)} mm; se ajusta al zoom)`; };
$('realistic').onclick = () => {
  viewer.realistic = !viewer.realistic;
  $('realistic').classList.toggle('on', viewer.realistic);
  viewer.refresh();
};
/** Acabados: el botón abre el panel (finishPanel.ts); «Ver en 3D» se recuerda. */
const FLOORS_KEY = 'mueblecad.pisoCeramico';
try { showFloors = localStorage.getItem(FLOORS_KEY) !== 'off'; } catch { /* sin almacenamiento */ }
const fin = setupFinishes({
  project: () => project,
  checkpoint,
  save,
  toast,
  onCatalog: (items) => { catalog = items; if (project.plan) render(); },
  getShow: () => showFloors,
  setShow: (v) => {
    showFloors = v;
    try { localStorage.setItem(FLOORS_KEY, v ? 'on' : 'off'); } catch { /* sin almacenamiento */ }
    render();
  },
});
fin.onToggle((v) => $('floors').classList.toggle('on', v));
$('floors').onclick = () => fin.toggle();
const GRID_KEY = 'mueblecad.cuadricula';
let gridOn = true;
try { gridOn = localStorage.getItem(GRID_KEY) !== 'off'; } catch { /* sin almacenamiento */ }
viewer.setGrid(gridOn);
$('grid').classList.toggle('on', gridOn);
$('grid').onclick = () => {
  gridOn = !gridOn;
  viewer.setGrid(gridOn);
  $('grid').classList.toggle('on', gridOn);
  try { localStorage.setItem(GRID_KEY, gridOn ? 'on' : 'off'); } catch { /* sin almacenamiento */ }
};
// Panel izquierdo (lista y propiedades) plegable; el visor 3D ocupa el ancho liberado.
const LEFT_KEY = 'mueblecad.panelIzquierdo';
const leftMain = document.querySelector('main')!;
const setLeftOpen = (open: boolean) => {
  leftMain.classList.toggle('left-closed', !open);
  $('leftBtn').textContent = open ? '‹' : '›';
  $('leftBtn').title = open ? 'Ocultar panel de muebles' : 'Mostrar panel de muebles';
  try { localStorage.setItem(LEFT_KEY, open ? 'on' : 'off'); } catch { /* sin almacenamiento */ }
  window.dispatchEvent(new Event('resize')); // el visor 3D se ajusta al nuevo ancho
};
$('leftBtn').onclick = () => setLeftOpen(leftMain.classList.contains('left-closed'));
try { if (localStorage.getItem(LEFT_KEY) === 'off') setLeftOpen(false); } catch { /* sin almacenamiento */ }
$('layersBtn').onclick = (e) => { e.stopPropagation(); $('layersMenu').classList.toggle('open'); };
document.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('.pop')) $('layersMenu').classList.remove('open'); });
$('layersMenu').addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const l = t.dataset.layer!;
  if (l === '__plan') showPlan = t.checked;
  else if (l === '__roof') showRoof = t.checked;
  else if (l === '__walls') showWalls = t.checked;
  else if (l === '__ids') showIds = t.checked;
  else if (l === '__room') showRoom = t.checked;
  else t.checked ? hiddenLayers.delete(l) : hiddenLayers.add(l);
  render();
});
$('shot').onclick = async () => {
  setTab('d3');
  const png = viewer.captureHD();
  await fetch('/api/screenshot?save=1', { method: 'POST', body: png });
  const a = document.createElement('a');
  a.href = png;
  a.download = `${project.name}.png`;
  a.click();
};

window.addEventListener('keydown', (e) => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  const mod = e.ctrlKey || e.metaKey; // Ctrl en Windows, Cmd en Mac
  if (mod && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void saveMcadFile(e.shiftKey); }
  else if (mod && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (mod && !typing && e.key.toLowerCase() === 'd' && selGroup) { e.preventDefault(); duplicateGroup(); }
  else if (e.key === 'Escape') {
    if (viewer.measuring) $('measure').click();
    else { selGroup = null; selPart = null; render(); }
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && (selPart || selGroup)) {
    commit(() => {
      if (selPart) { project.parts = project.parts.filter((p) => p.id !== selPart); selPart = null; }
      else { project.parts = project.parts.filter((p) => p.group !== selGroup); selGroup = null; }
    });
  }
});

$('addPart').onclick = () => {
  const part: Part = { id: nextId(project), name: 'Pieza', size: [600, 18, 400], position: [rightEdge(), 0, 0], material: project.materials.find((m) => !m.purchased)!.id, group: 'Pieza' };
  commit(() => { project.parts.push(part); selGroup = 'Pieza'; selPart = part.id; });
};

// --- diálogos ---------------------------------------------------------------

function askName(title: string, initial: string): Promise<string | null> {
  const dlg = $<HTMLDialogElement>('dlgName');
  $('nameTitle').textContent = title;
  input('nameInput').value = initial;
  dlg.returnValue = '';
  dlg.showModal();
  input('nameInput').select();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input('nameInput').value.trim() || null : null), { once: true }));
}

const fetchTemplates = async (): Promise<Template[]> => (await fetch('/api/templates')).json();

// Agregar mueble
const PRESETS = {
  base: { label: 'Mueble bajo de cocina', name: 'Base', w: 800, h: 760, d: 560, shelves: 1, drawers: 0, y: 100, wingB: 0, corner: false },
  cajonera: { label: 'Cajonera (3 cajones)', name: 'Cajonera', w: 600, h: 760, d: 560, shelves: 0, drawers: 3, y: 100, wingB: 0, corner: false },
  esquinero: { label: 'Esquinero en L (cocina)', name: 'Esquinero', w: 1000, h: 760, d: 560, shelves: 1, drawers: 0, y: 100, wingB: 1000, corner: true },
  alto: { label: 'Mueble alto de cocina', name: 'Alto', w: 800, h: 700, d: 330, shelves: 1, drawers: 0, y: 1450, wingB: 0, corner: false },
  closet: { label: 'Closet / alacena', name: 'Closet', w: 1000, h: 2200, d: 550, shelves: 4, drawers: 0, y: 0, wingB: 0, corner: false },
  librero: { label: 'Librero', name: 'Librero', w: 800, h: 1800, d: 300, shelves: 4, drawers: 0, y: 0, wingB: 0, corner: false },
} as const;
let templates: Template[] = [];

function uniqueGroup(base: string) {
  let name = base, i = 1;
  while (groups().has(name)) name = `${base} ${++i}`;
  return name;
}

function fillPreset() {
  const key = $<HTMLSelectElement>('fPreset').value;
  if (key.startsWith('tpl:')) {
    $('fDims').style.display = 'none';
    input('fName').value = uniqueGroup(templates[Number(key.slice(4))].group);
    return;
  }
  $('fDims').style.display = '';
  const p = PRESETS[key as keyof typeof PRESETS];
  input('fName').value = uniqueGroup(p.name);
  input('fW').value = String(p.w);
  input('fH').value = String(p.h);
  input('fD').value = String(p.d);
  input('fShelves').value = String(p.shelves);
  input('fDrawers').value = String(p.drawers);
  input('fY').value = String(p.y);
  input('fWingB').value = String(p.wingB || p.w);
  input('fDoorN').value = '0';
  $('fWingBBox').style.display = p.corner ? '' : 'none';
  $('fWLabel').textContent = p.corner ? 'Brazo X (mm)' : 'Ancho (mm)';
}

$('fPreset').onchange = fillPreset;
$('addCabinet').onclick = async () => {
  templates = await fetchTemplates();
  const cut = project.materials.filter((m) => !m.purchased);
  $('fMat').innerHTML = cut.filter((m) => m.thickness >= 12).map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  $('fPreset').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.label}</option>`).join('') +
    (templates.length ? `<optgroup label="Mis plantillas">${templates.map((t, i) => `<option value="tpl:${i}">${esc(t.name)}</option>`).join('')}</optgroup>` : '');
  fillPreset();
  $<HTMLDialogElement>('dlg').showModal();
};

$('cabForm').addEventListener('submit', (e) => {
  if ((e as SubmitEvent).submitter?.getAttribute('value') !== 'ok') return;
  const name = input('fName').value.trim() || 'Mueble';
  const key = $<HTMLSelectElement>('fPreset').value;
  const x = rightEdge();
  checkpoint();
  if (key.startsWith('tpl:')) {
    const t = templates[Number(key.slice(4))];
    for (const p of t.parts) project.parts.push({ ...p, id: nextId(project), name: p.name.replace(t.group, name), group: name, size: [...p.size], position: [p.position[0] + x, p.position[1], p.position[2]] });
  } else {
    const cut = project.materials.filter((m) => !m.purchased);
    const body = $<HTMLSelectElement>('fMat').value;
    const drawers = Math.max(0, Math.round(num(input('fDrawers').value)));
    try {
      addCabinet(project, {
        name, x, y: num(input('fY').value),
        kind: PRESETS[key as keyof typeof PRESETS].corner ? 'corner' : 'box',
        width: num(input('fW').value), height: num(input('fH').value), depth: num(input('fD').value), wingB: num(input('fWingB').value),
        shelves: Math.max(0, Math.round(num(input('fShelves').value))), drawers, doors: Math.max(0, Math.round(num(input('fDoorN').value))),
        material: body,
        backMaterial: input('fBack').checked ? cut.find((m) => m.thickness <= 6)?.id : undefined,
        rebateBack: input('fRebate').checked,
        doorMaterial: input('fDoors').checked || drawers > 0 ? (cut.find((m) => m.id === 'frente') ?? cut.find((m) => m.id === body))?.id : undefined,
        edging: input('fEdge').checked,
      });
    } catch (err) {
      history.drop();
      toast((err as Error).message, 6000);
      return;
    }
  }
  selGroup = name;
  selPart = null;
  save();
});

// Materiales
function renderMaterials() {
  const m2 = project.materials;
  $('mtable').innerHTML = `<table><tr><th>Nombre</th><th>Espesor</th><th>Plancha (ancho × alto)</th><th>Color</th><th>Veta</th><th>Comprado</th><th>Foto</th><th></th></tr>${m2.map((m) => `
    <tr data-m="${m.id}"><td><input data-f="name" value="${esc(m.name)}" /></td>
    <td><input data-f="thickness" type="number" class="sm" value="${m.thickness}" /></td>
    <td class="nowrap"><input data-f="sheetW" type="number" class="sm" value="${m.sheetW}" /> × <input data-f="sheetH" type="number" class="sm" value="${m.sheetH}" /></td>
    <td><input data-f="color" type="color" value="${m.color}" class="color" /></td>
    <td><input data-f="grain" type="checkbox" ${m.grain ? 'checked' : ''} /></td>
    <td><input data-f="purchased" type="checkbox" ${m.purchased ? 'checked' : ''} /></td>
    <td class="nowrap">${m.texture ? `<img src="${m.texture}" height="24" /> <button data-clr="${m.id}" title="Quitar foto">✕</button>` : ''}<input data-f="texture" type="file" accept="image/*" /></td>
    <td><button data-delm="${m.id}" class="danger">✕</button></td></tr>`).join('')}</table>`;
}

$('connect').onclick = async () => {
  try {
    const info = await (await fetch('/api/mcp-info')).json() as { claudeCode: string; json: string; dataDir: string; launch: { temporal?: boolean } };
    $('mcpTemp').style.display = info.launch.temporal ? 'block' : 'none';
    $('mcpCode').textContent = info.claudeCode;
    $('mcpJson').textContent = info.json;
    $('mcpData').textContent = info.dataDir;
  } catch { $('mcpCode').textContent = 'No se pudo obtener el comando (¿está corriendo el servidor?).'; }
  $<HTMLDialogElement>('dlgConnect').showModal();
};
document.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((b) => (b.onclick = async () => {
  const target = $(b.dataset.copy!);
  try { await navigator.clipboard.writeText(target.textContent ?? ''); b.textContent = 'Copiado'; } catch {
    const r = document.createRange(); r.selectNodeContents(target); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); b.textContent = 'Seleccionado: Ctrl+C';
  }
  setTimeout(() => (b.textContent = 'Copiar'), 2500);
}));
$('materials').onclick = () => { renderMaterials(); $<HTMLDialogElement>('dlgMaterials').showModal(); };
$('mClose').onclick = () => $<HTMLDialogElement>('dlgMaterials').close();
$('mAdd').onclick = () => {
  commit(() => { project.materials.push({ id: `m${Date.now()}`, name: 'Material nuevo', thickness: 18, sheetW: 2400, sheetH: 1200, color: '#c9a577', grain: true, price: 0 }); });
  renderMaterials();
};

/** Reduce una foto a 512 px y la devuelve como data URL, para no inflar el proyecto. */
function shrinkImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, 512 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('No se pudo leer la imagen'));
    img.src = url;
  });
}

$('mtable').addEventListener('change', async (e) => {
  const t = e.target as HTMLInputElement;
  const row = t.closest<HTMLElement>('[data-m]');
  const f = t.dataset.f;
  const m: Material | undefined = project.materials.find((x) => x.id === row?.dataset.m);
  if (!m || !f) return;
  if (f === 'texture') {
    const file = t.files?.[0];
    if (!file) return;
    try {
      const data = await shrinkImage(file);
      await commit(() => { m.texture = data; });
    } catch (err) { toast((err as Error).message); }
  } else {
    await commit(() => {
      if (f === 'name' || f === 'color') (m as unknown as Record<string, string>)[f] = t.value;
      else if (f === 'grain' || f === 'purchased') (m as unknown as Record<string, boolean>)[f] = t.checked;
      else (m as unknown as Record<string, number>)[f] = Math.max(1, num(t.value));
    });
  }
  renderMaterials();
});
$('mtable').addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.clr) await commit(() => { delete project.materials.find((x) => x.id === t.dataset.clr)!.texture; });
  else if (t.dataset.delm) {
    const id = t.dataset.delm;
    if (project.parts.some((p) => p.material === id)) return toast('Ese material lo usan piezas del proyecto; cámbialas primero.', 5000);
    await commit(() => { project.materials = project.materials.filter((m) => m.id !== id); });
  } else return;
  renderMaterials();
});

// Proyectos
async function refreshProjects() {
  const r = await (await fetch('/api/projects')).json() as { current: string | null; projects: { name: string; mtime: number }[] };
  $('plist').innerHTML = r.projects.map((p) => `<div class="it ${p.name === r.current ? 'cur' : ''}"><b>${esc(p.name)}</b>
    <span class="muted">${new Date(p.mtime).toLocaleDateString('es')}</span>
    ${p.name === r.current ? '<span class="tag">abierto</span>' : `<button data-open="${esc(p.name)}">Abrir</button><button class="danger" data-delp="${esc(p.name)}">✕</button>`}</div>`).join('') || '<div class="it muted">Aún no hay proyectos guardados.</div>';
}

async function switchProject(next: Project) {
  await fetch('/api/projects/new', { method: 'POST', body: JSON.stringify(next) });
  currentFile = null;
  history.clear();
  selGroup = selPart = null;
  await load();
void pullActivity();
  await refreshProjects();
}

$('projects').onclick = async () => { await refreshProjects(); $<HTMLDialogElement>('dlgProjects').showModal(); };
$('pClose').onclick = () => $<HTMLDialogElement>('dlgProjects').close();
$('plist').addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  if (t.dataset.open) {
    await fetch(`/api/projects/open?name=${encodeURIComponent(t.dataset.open)}`, { method: 'POST' });
    currentFile = null;
    history.clear();
    selGroup = selPart = null;
    await load();
    $<HTMLDialogElement>('dlgProjects').close();
  } else if (t.dataset.delp && confirm(`¿Eliminar el proyecto "${t.dataset.delp}"? No se puede deshacer.`)) {
    await fetch(`/api/projects?name=${encodeURIComponent(t.dataset.delp)}`, { method: 'DELETE' });
    await refreshProjects();
  }
});
$('pNew').onclick = async () => {
  const name = input('newName').value.trim() || 'Proyecto nuevo';
  await switchProject({ ...defaultProject(), name });
  $<HTMLDialogElement>('dlgProjects').close();
};
$('pDup').onclick = async () => {
  const name = input('newName').value.trim() || `${project.name} copia`;
  await switchProject({ ...structuredClone(project), name });
  $<HTMLDialogElement>('dlgProjects').close();
};
// Archivos .mcad (formato nativo). En Electron: diálogos nativos y reescritura de la ruta de origen; en la web: selector de archivos y descarga.
interface McadPayload { path: string; text?: string; error?: string }
interface MuebleApp {
  openMcad?: () => Promise<McadPayload | null>;
  saveMcad?: (file: string | null, name: string, text: string, forceDialog?: boolean) => Promise<string | null>;
  takePendingMcad?: () => Promise<McadPayload | null>;
  onOpenMcad?: (cb: (p: McadPayload) => void) => void;
}
const muebleApp = (): MuebleApp | undefined => (window as unknown as { muebleApp?: MuebleApp }).muebleApp;
/** Ruta del archivo .mcad de donde vino el proyecto activo (solo Electron). «Guardar» reescribe esa ruta. */
let currentFile: string | null = null;

/** Abre un proyecto desde texto .mcad/.json y lo deja como activo (el anterior queda en la biblioteca). */
async function openProjectText(text: string, file: string | null) {
  try {
    const p = parseMcad(text);
    await switchProject(p);
    currentFile = file;
    $<HTMLDialogElement>('dlgProjects').close();
    toast(`Proyecto "${p.name}" abierto`);
  } catch (err) { toast(err instanceof McadError ? err.message : `No se pudo abrir: ${(err as Error).message}`, 5000); }
}
async function openPayload(p: McadPayload | null) {
  if (!p) return;
  if (p.error || p.text === undefined) return toast(p.error || 'No se pudo leer el archivo.', 5000);
  await openProjectText(p.text, p.path);
}
async function saveMcadFile(asNew: boolean) {
  const text = serializeMcad(project);
  const name = mcadFileName(project.name);
  const app = muebleApp();
  if (!app?.saveMcad) { download(name, text, 'application/json'); return toast(`Descargado ${name}`); }
  try {
    const saved = await app.saveMcad(currentFile, name, text, asNew);
    if (saved) { currentFile = saved; toast(`Guardado en ${saved}`, 5000); }
  } catch (err) { toast(`No se pudo guardar: ${(err as Error).message}`, 5000); }
}
$('fSave').onclick = () => saveMcadFile(false);
$('fSaveAs').onclick = () => saveMcadFile(true);
$('pExport').onclick = () => saveMcadFile(true);
$('fOpen').onclick = (e) => { // en Electron se usa el diálogo nativo (recuerda la ruta para «Guardar»)
  const app = muebleApp();
  if (!app?.openMcad) return;
  e.preventDefault();
  void app.openMcad().then(openPayload);
};
async function importFromInput(id: string) {
  const file = input(id).files?.[0];
  input(id).value = '';
  if (file) await openProjectText(await file.text(), null);
}
$('fOpen').onchange = () => importFromInput('fOpen');
$('pImport').onchange = () => importFromInput('pImport');
{
  const app = muebleApp();
  app?.onOpenMcad?.((p) => { void openPayload(p); });
  void app?.takePendingMcad?.().then((p) => openPayload(p)); // archivo con el que se lanzó la app (doble clic)
}

// Espacio
const roomInputs = ['rW', 'rD', 'rH', 'rwx', 'rwy', 'rww', 'rwh'] as const;
function readRoom(): Room {
  const room: Room = { width: num(input('rW').value), depth: num(input('rD').value), height: num(input('rH').value) };
  if (project.room?.wall) room.wall = project.room.wall;
  if (input('rWin').checked) room.window = { x: num(input('rwx').value), y: num(input('rwy').value), w: num(input('rww').value), h: num(input('rwh').value) };
  return room;
}
function fillRoom(r: Room) {
  input('rW').value = String(r.width);
  input('rD').value = String(r.depth);
  input('rH').value = String(r.height);
  const w = r.window ?? { x: Math.max(0, (r.width - 1200) / 2), y: 1000, w: 1200, h: 1000 };
  input('rWin').checked = !!r.window;
  input('rwx').value = String(w.x);
  input('rwy').value = String(w.y);
  input('rww').value = String(w.w);
  input('rwh').value = String(w.h);
}
function roomCheck() {
  const w = num(input('rW').value), d = num(input('rD').value), h = num(input('rH').value);
  const parts = project.parts.filter((p) => !isPurchased(p));
  const el = $('roomCheck');
  if (!parts.length) { el.textContent = ''; return; }
  const b = bbox(parts);
  const over: string[] = [];
  if (b.max[0] > w) over.push(`el ancho (${fmtMm(b.max[0])} > ${w})`);
  if (b.max[2] > d) over.push(`el fondo (${fmtMm(b.max[2])} > ${d})`);
  if (b.max[1] > h) over.push(`el alto (${fmtMm(b.max[1])} > ${h})`);
  el.textContent = over.length ? `⚠ Los muebles se salen en: ${over.join(', ')}.` : `Los muebles caben: ocupan ${fmtMm(b.max[0])} × ${fmtMm(b.max[1])} × ${fmtMm(b.max[2])} mm.`;
}
roomInputs.forEach((id) => $(id).addEventListener('input', roomCheck));

$('room').onclick = () => {
  fillRoom(project.room ?? { width: 3000, depth: 3000, height: 2400 });
  $('rRemove').style.display = project.room ? '' : 'none';
  roomCheck();
  $<HTMLDialogElement>('dlgRoom').showModal();
};
document.querySelectorAll<HTMLButtonElement>('[data-fit]').forEach((b) => (b.onclick = () => {
  checkpoint();
  project.room = readRoom();
  const msg = fitToRoom(project, b.dataset.fit as FitMode);
  $('roomCheck').textContent = msg;
  save();
}));
$('rImport').onchange = async () => {
  const file = input('rImport').files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const r = (data.room ?? data) as Room;
    if (![r.width, r.depth, r.height].every((v) => typeof v === 'number' && v > 0)) throw new Error('El archivo debe tener width, depth y height (en mm), opcionalmente window {x,y,w,h}.');
    fillRoom(r);
    roomCheck();
  } catch (err) { $('roomCheck').textContent = `⚠ ${(err as Error).message}`; }
  input('rImport').value = '';
};
$('roomForm').addEventListener('submit', (e) => {
  const v = (e as SubmitEvent).submitter?.getAttribute('value');
  if (v !== 'ok' && v !== 'remove') return;
  checkpoint();
  if (v === 'remove') delete project.room;
  else { project.room = readRoom(); showRoom = true; }
  save();
});

setupElevations(() => project);
setupIds({ getProject: () => project, checkpoint, save });
setupPlanDialog({ getProject: () => project, checkpoint, save, toast, show: () => { showPlan = true; showRoom = true; } });
// Dibujos 2D (drawingUi.ts): `drawings.registerTool(...)` y `drawings.setIoHandlers(...)` son los ganchos para las herramientas de ratón y el DXF/PDF.
const drawings = setupDrawings({ project: () => project, commit, toast, viewer, host: $('draw2d'), selectGroup: (g) => { selGroup = g; selPart = null; } });
setupDrawingTools(drawings, { host: $('draw2d'), toast });
setupDrawingIo(drawings, { toast });
setupHatchBlocks(drawings, { host: $('draw2d'), toast });
setupMeshImport({ button: $('importMesh'), project: () => project, commit, toast, select: (g) => { selGroup = g; selPart = null; } });
// Exportar vista (3D / dibujo 2D / planos y lámina como PNG, JPG, SVG o PDF) y vistas guardadas: exportDialog.ts
const exporter = setupExport({ viewer, drawings, project: () => project, isHidden, hiddenLayers, tab: () => tab, setTab: (t) => setTab(t), commit, render, toast });
$('exportView').onclick = () => exporter.open();

load();
