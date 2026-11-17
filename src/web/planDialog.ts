import { assignOpenings, cropPlan, detectRoom, parsePlan, planBounds, rotatePlan, scalePlan, toFloorPlan, type RawPlan, type Unit } from '../core/plan';
import type { FloorPlan, Project } from '../core/types';

interface Ctx {
  getProject: () => Project;
  checkpoint: () => void;
  save: () => void;
  toast: (text: string) => void;
  /** Hace visible el plano en el visor 3D. */
  show: () => void;
}
interface Pt { x: number; z: number }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);

const msgEl = () => $('plMsg');

/** Convierte un .dwg a texto DXF con el convertidor local (LibreDWG) que expone la API. */
async function dwgToDxf(file: File): Promise<string> {
  msgEl().textContent = 'Convirtiendo el DWG…';
  const r = await fetch('/api/dwg', { method: 'POST', body: await file.arrayBuffer() });
  const body = await r.json();
  if (r.status === 501) throw new Error(`Para abrir .dwg falta el convertidor LibreDWG (dwg2dxf.exe). Descomprímelo en «${body.folder}» y vuelve a intentarlo, o guarda el plano como DXF desde AutoCAD.`);
  if (!r.ok) throw new Error(body.error || 'No pude convertir el DWG.');
  return body.dxf as string;
}

/** Diálogo para importar un plano DXF, calibrarlo y marcar qué parte es el espacio donde van los muebles. */
export function setupPlanDialog(ctx: Ctx) {
  let raw: RawPlan | null = null;
  let fileName = 'plano';
  let work: FloorPlan = { name: '', lines: [] };
  let rect: { a: Pt; b: Pt } | null = null;
  let cal: Pt[] = [];
  let mode: 'rect' | 'cal' = 'rect';
  let drag = false;
  let view = { minX: 0, minZ: 0, s: 1, ox: 0, oz: 0 };
  /** true = encuadrar todo el dibujo; false = el usuario hizo zoom o desplazó la vista. */
  let autoFit = true;
  let pan: { x: number; y: number } | null = null;
  const canvas = $<HTMLCanvasElement>('plCanvas');
  const g = canvas.getContext('2d')!;

  const msg = (t: string) => { $('plMsg').textContent = t; };
  const selectedLayers = () => Array.from(document.querySelectorAll<HTMLInputElement>('#plLayers input:checked')).map((i) => i.dataset.layer!);

  function rebuild() {
    if (!raw) return;
    work = toFloorPlan(raw, input('plUnit').value as Unit, selectedLayers(), fileName);
    rect = null; cal = [];
    autoFit = true;
    $('plCalRow').style.display = 'none';
    draw();
  }

  function draw() {
    const b = planBounds(work);
    g.clearRect(0, 0, canvas.width, canvas.height);
    $<HTMLButtonElement>('plOk').disabled = !b;
    if (!b) { msg('El plano no tiene líneas visibles: activa alguna capa.'); return; }
    const m = 24;
    const bw = Math.max(1, b.maxX - b.minX), bh = Math.max(1, b.maxZ - b.minZ);
    const s = Math.min((canvas.width - 2 * m) / bw, (canvas.height - 2 * m) / bh);
    if (autoFit) view = { minX: b.minX, minZ: b.minZ, s, ox: m + (canvas.width - 2 * m - bw * s) / 2, oz: m + (canvas.height - 2 * m - bh * s) / 2 };
    const sx = (x: number) => view.ox + (x - view.minX) * view.s, sz = (z: number) => view.oz + (z - view.minZ) * view.s;
    g.strokeStyle = '#334155';
    g.lineWidth = 1;
    g.beginPath();
    for (const l of work.lines) { g.moveTo(sx(l[0]), sz(l[1])); g.lineTo(sx(l[2]), sz(l[3])); }
    g.stroke();
    if (input('plTexts').checked && work.texts) {
      g.fillStyle = '#0f766e';
      g.textBaseline = 'alphabetic';
      let drawn = 0;
      for (const t of work.texts) {
        const px = sx(t.x), pz = sz(t.z);
        if (px < -50 || pz < -20 || px > canvas.width + 50 || pz > canvas.height + 20) continue;
        const size = Math.min(40, (t.h || 120) * view.s);
        if (size < 6 || drawn++ > 2500) continue;
        g.font = size + 'px sans-serif';
        g.fillText(t.t, px, pz);
      }
    }
    // el borde de arriba es el muro del fondo
    g.fillStyle = '#64748b';
    g.font = '11px sans-serif';
    g.fillText('▲ muro del fondo (arriba)', 8, 14);
    if (rect) {
      const x0 = Math.min(rect.a.x, rect.b.x), x1 = Math.max(rect.a.x, rect.b.x), z0 = Math.min(rect.a.z, rect.b.z), z1 = Math.max(rect.a.z, rect.b.z);
      g.fillStyle = 'rgba(37,99,235,.15)';
      g.strokeStyle = '#2563eb';
      g.lineWidth = 2;
      g.fillRect(sx(x0), sz(z0), (x1 - x0) * view.s, (z1 - z0) * view.s);
      g.strokeRect(sx(x0), sz(z0), (x1 - x0) * view.s, (z1 - z0) * view.s);
      g.fillStyle = '#1d4ed8';
      g.font = 'bold 13px sans-serif';
      g.fillText(`${Math.round(x1 - x0)} × ${Math.round(z1 - z0)} mm`, sx(x0) + 6, sz(z0) + 18);
    }
    g.strokeStyle = g.fillStyle = '#dc2626';
    g.lineWidth = 2;
    cal.forEach((p) => { g.beginPath(); g.arc(sx(p.x), sz(p.z), 4, 0, 7); g.fill(); });
    if (cal.length === 2) { g.beginPath(); g.moveTo(sx(cal[0].x), sz(cal[0].z)); g.lineTo(sx(cal[1].x), sz(cal[1].z)); g.stroke(); }
    if (!rect && cal.length < 2) {
      msg(mode === 'rect'
        ? `Dibujo de ${Math.round(bw)} × ${Math.round(bh)} mm. Rueda = acercar, clic derecho y arrastrar = mover. Arrastra con el botón izquierdo para marcar el espacio (se pega a las esquinas).`
        : 'Haz clic en dos puntos cuya distancia real conozcas.');
    }
  }

  /** Posición del puntero en mm del plano, imantada a la esquina de línea más cercana. */
  function at(e: PointerEvent): Pt {
    const r = canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * canvas.width, pz = ((e.clientY - r.top) / r.height) * canvas.height;
    let p = { x: view.minX + (px - view.ox) / view.s, z: view.minZ + (pz - view.oz) / view.s };
    if (work.lines.length < 40000) {
      let best = 10 / view.s;
      for (const l of work.lines) {
        for (const [x, z] of [[l[0], l[1]], [l[2], l[3]]]) {
          const d = Math.hypot(x - p.x, z - p.z);
          if (d < best) { best = d; p = { x, z }; }
        }
      }
    }
    return p;
  }

  canvas.oncontextmenu = (e) => e.preventDefault();
  canvas.onwheel = (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * canvas.width, pz = ((e.clientY - r.top) / r.height) * canvas.height;
    const f = e.deltaY < 0 ? 1.25 : 0.8;
    const wx = view.minX + (px - view.ox) / view.s, wz = view.minZ + (pz - view.oz) / view.s;
    view = { ...view, s: view.s * f, ox: px - (wx - view.minX) * view.s * f, oz: pz - (wz - view.minZ) * view.s * f };
    autoFit = false;
    draw();
  };
  canvas.onpointerdown = (e) => {
    if (!planBounds(work)) return;
    if (e.button !== 0) {
      canvas.setPointerCapture(e.pointerId);
      pan = { x: e.clientX, y: e.clientY };
      return;
    }
    const p = at(e);
    if (mode === 'cal') {
      if (cal.length >= 2) cal = [];
      cal.push(p);
      $('plCalRow').style.display = cal.length === 2 ? '' : 'none';
      draw();
      if (cal.length === 2) {
        const d = Math.hypot(cal[1].x - cal[0].x, cal[1].z - cal[0].z);
        input('plCalVal').value = String(Math.round(d));
        msg(`Esa distancia mide ${Math.round(d)} mm en el plano. Escribe la medida real y pulsa Aplicar.`);
      }
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    drag = true;
    rect = { a: p, b: p };
    draw();
  };
  canvas.onpointermove = (e) => {
    if (pan) {
      const r = canvas.getBoundingClientRect();
      view = { ...view, ox: view.ox + ((e.clientX - pan.x) / r.width) * canvas.width, oz: view.oz + ((e.clientY - pan.y) / r.height) * canvas.height };
      pan = { x: e.clientX, y: e.clientY };
      autoFit = false;
      draw();
    } else if (drag && rect) { rect.b = at(e); draw(); }
  };
  canvas.onpointerup = () => {
    if (pan) { pan = null; return; }
    drag = false;
    if (rect && Math.abs(rect.a.x - rect.b.x) < 100 && Math.abs(rect.a.z - rect.b.z) < 100) rect = null;
    draw();
  };

  const setMode = (m: 'rect' | 'cal') => {
    mode = m;
    cal = [];
    $('plCalRow').style.display = 'none';
    $('plRect').classList.toggle('primary', m === 'rect');
    $('plCal').classList.toggle('primary', m === 'cal');
    draw();
  };
  $('plRect').onclick = () => setMode('rect');
  $('plCal').onclick = () => setMode('cal');
  $('plRot').onclick = () => { work = rotatePlan(work); rect = null; cal = []; autoFit = true; draw(); };
  $('plFit').onclick = () => { autoFit = true; draw(); };
  input('plTexts').onchange = draw;
  $('plCalOk').onclick = () => {
    if (cal.length !== 2) return;
    const d = Math.hypot(cal[1].x - cal[0].x, cal[1].z - cal[0].z), real = parseFloat(input('plCalVal').value);
    if (!(real > 0) || !(d > 0)) return;
    work = scalePlan(work, real / d);
    rect = null;
    autoFit = true;
    setMode('rect');
  };

  const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  function listLayers() {
    if (!raw) return;
    const counts = raw.layers.map((_, i) => raw!.segs.filter((s) => s[4] === i).length + raw!.texts.filter((t) => t.layer === i).length);
    $('plLayers').innerHTML = raw.layers.map((l, i) =>
      `<label class="check"><input type="checkbox" data-layer="${escHtml(l)}" checked /> ${escHtml(l)} (${counts[i]})</label>`).join('');
  }

  input('plFile').onchange = async () => {
    const f = input('plFile').files?.[0];
    if (!f) return;
    try {
      raw = parsePlan(/\.dwg$/i.test(f.name) ? await dwgToDxf(f) : await f.text());
      fileName = f.name.replace(/\.(dxf|dwg)$/i, '');
      input('plUnit').value = raw.unit;
      $('plInfo').textContent = raw.unitKnown ? 'Unidades leídas del archivo.' : 'El archivo no dice sus unidades: revisa que sean las correctas.';
      $('plSetup').style.display = '';
      listLayers();
      rebuild();
      setMode('rect');
    } catch (err) { raw = null; msg(`⚠ ${(err as Error).message}`); }
    input('plFile').value = '';
  };
  input('plUnit').onchange = rebuild;
  $('plLayers').addEventListener('change', rebuild);

  $('plan').onclick = () => {
    const p = ctx.getProject();
    raw = null;
    work = p.plan ? { name: p.plan.name, lines: p.plan.lines.map((l) => [...l]) } : { name: '', lines: [] };
    rect = null; cal = [];
    autoFit = true;
    $('plSetup').style.display = 'none';
    $('plInfo').textContent = '';
    $('plRemove').style.display = p.plan ? '' : 'none';
    setMode('rect');
    if (!p.plan) msg('Elige un archivo .dxf para empezar.');
    $<HTMLDialogElement>('dlgPlan').showModal();
    draw();
  };

  $('planForm').addEventListener('submit', (e) => {
    const v = (e as SubmitEvent).submitter?.getAttribute('value');
    const p = ctx.getProject();
    if (v === 'remove') { ctx.checkpoint(); delete p.plan; ctx.save(); return; }
    if (v !== 'ok' || !planBounds(work)) return;
    ctx.checkpoint();
    let plan = work;
    if (rect) {
      let x0 = Math.min(rect.a.x, rect.b.x), x1 = Math.max(rect.a.x, rect.b.x), z0 = Math.min(rect.a.z, rect.b.z), z1 = Math.max(rect.a.z, rect.b.z);
      // se ajusta a las caras interiores de los muros y toma su espesor; si la habitación está abierta, queda el recuadro marcado
      const found = detectRoom(work, { x0, z0, x1, z1 });
      if (found) ({ x0, z0, x1, z1 } = found);
      plan = cropPlan(work, { x: x0, z: z0 });
      const w = p.room?.window;
      const width = Math.round(x1 - x0), depth = Math.round(z1 - z0);
      // puertas y ventanas leídas de las elevaciones que caen sobre los muros del espacio
      const openings = assignOpenings(plan, width, depth, found?.wall ?? 100);
      p.room = {
        width, depth, height: plan.panelH ?? p.room?.height ?? 2400,
        ...(found ? { wall: found.wall } : {}),
        ...(openings.length ? { openings } : w && w.x + w.w <= width ? { window: w } : {}),
      };
      const nd = openings.filter((o) => o.kind === 'door').length, nw = openings.length - nd;
      const hv = openings.length ? ` Puertas: ${nd}, ventanas: ${nw}.` : '';
      ctx.toast(found ? `Espacio interior de ${width} × ${depth} mm, muros de ${found.wall} mm.${hv}` : `Espacio de ${width} × ${depth} mm (no encontré muros cerrados: usé el recuadro).${hv}`);
    }
    p.plan = { ...plan, name: plan.name || fileName };
    ctx.show();
    ctx.save();
  });
}
