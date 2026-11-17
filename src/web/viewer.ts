import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FloorPlan, Part, PlanOpening, PlanPanel, Project, Room, RoomOpening, Vec3 } from '../core/types';
import { outline, panelAxes } from '../core/shapes';
import { openingIds, wallRuns } from '../core/ids';
import { isShaped } from '../core/nesting';
import { isRotated, partCenter, rotationMatrix, solidSpec } from '../core/solids';
import { buildMeshGeometry, buildSolidGeometry } from './solidGeometry';
import { effectiveFinishes, patternPeriod, roomFloorGeometry, roomWallGeometry } from '../core/finish';
import type { Buckets, Resolved, TextureItem } from '../core/finish';
import { ROOF_THICKNESS, roofCells } from '../core/roof';
import { cleanMm, fmtMm, gridLayout, gridStepFor, measureText, pickSnapPoint, snapRangeMm, stepRound, DEFAULT_MOVE_STEP, type P3, type SnapCandidate } from '../core/units';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type ViewName = 'persp' | 'front' | 'top' | 'side';

export interface ViewState {
  selected: Set<string>;
  isHidden: (part: Part) => boolean;
  showRoom: boolean;
  showPlan?: boolean;
  showRoof?: boolean;
  showWalls?: boolean;
  showIds?: boolean;
  /** Acabados (pisos y muros revestidos, project.finishes); por omisión se ven. */
  showFloors?: boolean;
  /** Biblioteca de texturas (texturas/catalogo.json). */
  catalog?: TextureItem[];
}

/** Resaltado temporal de una pieza que cambió (nueva, modificada o borrada): caja translúcida con aristas que pulsa y se desvanece. */
export interface FlashItem { min: Vec3; max: Vec3; kind: 'new' | 'edit' | 'del' }
const FLASH_COLORS = { new: 0x16a34a, edit: 0xf59e0b, del: 0xdc2626 };

interface Label { pos: THREE.Vector3; text: string; follow: boolean; el: HTMLElement }

/** Alcance del imán (px de pantalla) a bordes de otras piezas y a puntos al medir. */
const SNAP_PX = 10;
const MEASURE_SNAP_PX = 14;

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 10, 100000);
  private controls: OrbitControls;
  private sun = new THREE.DirectionalLight(0xffffff, 1.5);
  private group = new THREE.Group(); // piezas no seleccionadas
  private selGroup = new THREE.Group(); // piezas seleccionadas: se mueven juntas al arrastrar
  private roomGroup = new THREE.Group();
  /** Pisos con acabado de cerámica: no entran en la selección (pick solo mira group/selGroup). */
  private floorGroup = new THREE.Group();
  private floorKey = '';
  private floorToken = 0;
  private planGroup = new THREE.Group();
  private dimGroup = new THREE.Group();
  private measureGroup = new THREE.Group();
  private flashGroup = new THREE.Group();
  /** Líneas de los dibujos 2D visibles, ya en el mundo (las pone drawingUi.ts). */
  private drawingGroup = new THREE.Group();
  private flashes: { obj: THREE.Group; t0: number; ms: number }[] = [];
  private raycaster = new THREE.Raycaster();
  private box = new THREE.Box3();
  private selBox = new THREE.Box3();
  private targets: number[][] = [[], [], []];
  private fitted = false;
  private down: [number, number] = [0, 0];
  private drag: { plane: THREE.Plane; start: THREE.Vector3; mode: 'xz' | 'y'; moved: boolean; delta: Vec3 } | null = null;
  private selectedIds = new Set<string>();
  private labels: Label[] = [];
  private overlay: HTMLElement;
  private textures = new Map<string, THREE.Texture>();
  /** Geometrías de sólidos (y sus aristas) compartidas entre piezas iguales: cientos de ruedas o tubos iguales usan una sola malla en la GPU. */
  private solidCache = new Map<string, { geom: THREE.BufferGeometry; edges: THREE.BufferGeometry }>();
  private lastProject: Project | null = null;
  private lastState: ViewState | null = null;
  private measurePts: THREE.Vector3[] = [];
  private measureKinds: string[] = [];
  /** Paso de movimiento al arrastrar (mm); 0 = libre. */
  private moveStep = DEFAULT_MOVE_STEP;
  private snapOn = true;
  private gridBase = { cx: 0, cz: 0, hw: 6000 };
  private grid: THREE.GridHelper;
  private gridKey = '';
  private gridStep = 200;
  private gridOn = true;
  private walls: { back: THREE.Object3D; left: THREE.Object3D; right: THREE.Object3D; front?: THREE.Object3D; width: number; depth: number } | null = null;

  realistic = true;
  measuring = false;
  onPick: (id: string) => void = () => {};
  onDragEnd: (delta: Vec3) => void = () => {};
  /** Texto de estado (distancia medida, imán...) o null para borrarlo. */
  onInfo: (text: string | null) => void = () => {};
  /** Texto copiable de la última medida completa (o null si no hay). */
  /** Espaciado actual de la cuadrícula visual (mm), para mostrarlo en la interfaz. */
  onGridStep: (mm: number) => void = () => {};
  onMeasure: (copyText: string | null) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color('#eef1f5');
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bec8, 1.5));
    this.sun.position.set(2500, 6000, 4500);
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -6000, right: 6000, top: 6000, bottom: -6000, near: 100, far: 20000 });
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun);
    this.grid = new THREE.GridHelper(12000, 60, 0xb5bcc8, 0xdde1e8);
    this.grid.position.y = -1;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.ShadowMaterial({ opacity: 0.16 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.5;
    ground.receiveShadow = true;
    this.scene.add(this.grid, ground, this.roomGroup, this.floorGroup, this.planGroup, this.group, this.selGroup, this.dimGroup, this.drawingGroup, this.measureGroup, this.flashGroup);

    this.camera.position.set(2500, 1800, 3000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.target.set(400, 600, 200);
    this.controls.update();

    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';
    canvas.parentElement!.appendChild(this.overlay);

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement!);
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    window.addEventListener('pointermove', (e) => this.pointerMove(e));
    window.addEventListener('pointerup', (e) => this.pointerUp(e));
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.tickFlashes();
      this.hideNearWalls();
      this.updateGrid();
      this.renderer.render(this.scene, this.camera);
      this.placeLabels();
    });
  }

  /** Dibuja los dibujos 2D visibles como líneas en su plano (segmentos 3D agrupados por color, ver drawing3d.ts); no cambia el encuadre ni el modelo. */
  setDrawingLines(sets: { color: string; positions: number[] }[]) {
    this.disposeChildren(this.drawingGroup);
    for (const s of sets) {
      if (!s.positions.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(s.positions, 3));
      const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: s.color }));
      lines.renderOrder = 5;
      this.drawingGroup.add(lines);
    }
  }

  /** Resalta piezas por unos segundos (cambios del agente). */
  flash(items: FlashItem[], ms = 6000) {
    const now = performance.now();
    for (const it of items) {
      const size = new THREE.Vector3(...it.max).sub(new THREE.Vector3(...it.min)).max(new THREE.Vector3(6, 6, 6)).addScalar(14);
      const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
      const color = FLASH_COLORS[it.kind];
      const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, depthTest: false, depthWrite: false }));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, depthTest: false }));
      const obj = new THREE.Group();
      obj.add(fill, edges);
      obj.traverse((o) => { o.renderOrder = 999; });
      obj.position.set((it.min[0] + it.max[0]) / 2, (it.min[1] + it.max[1]) / 2, (it.min[2] + it.max[2]) / 2);
      this.flashGroup.add(obj);
      this.flashes.push({ obj, t0: now, ms });
    }
  }

  private tickFlashes() {
    if (!this.flashes.length) return;
    const now = performance.now();
    this.flashes = this.flashes.filter((f) => {
      const k = (now - f.t0) / f.ms;
      if (k >= 1) {
        this.flashGroup.remove(f.obj);
        f.obj.traverse((o) => { if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
        return false;
      }
      const a = k < 0.6 ? 0.65 + 0.35 * Math.sin(now / 90) : 1 - (k - 0.6) / 0.4;
      f.obj.traverse((o) => {
        if (o instanceof THREE.Mesh) (o.material as THREE.MeshBasicMaterial).opacity = 0.5 * a;
        else if (o instanceof THREE.LineSegments) (o.material as THREE.LineBasicMaterial).opacity = Math.min(1, a);
      });
      return true;
    });
  }

  // --- interacción -------------------------------------------------------

  private setRay(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  private pick(e: PointerEvent) {
    this.setRay(e);
    const meshes = [...this.group.children, ...this.selGroup.children].filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
    return this.raycaster.intersectObjects(meshes, false)[0];
  }

  private pointerDown(e: PointerEvent) {
    this.down = [e.clientX, e.clientY];
    if (e.button !== 0 || this.measuring) return;
    const hit = this.pick(e);
    if (!hit || !this.selectedIds.has(hit.object.userData.id)) return;
    const mode = e.shiftKey ? 'y' : 'xz';
    const plane = new THREE.Plane();
    if (mode === 'xz') plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), hit.point);
    else {
      const dir = this.camera.getWorldDirection(new THREE.Vector3());
      dir.y = 0;
      plane.setFromNormalAndCoplanarPoint(dir.normalize().negate(), hit.point);
    }
    this.drag = { plane, start: hit.point.clone(), mode, moved: false, delta: [0, 0, 0] };
    this.controls.enabled = false;
  }

  private pointerMove(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) < 4) return;
    d.moved = true;
    this.setRay(e);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(d.plane, p)) return;
    const raw: Vec3 = d.mode === 'xz' ? [p.x - d.start.x, 0, p.z - d.start.z] : [0, p.y - d.start.y, 0];
    let snapped = false;
    // El imán a bordes de otras piezas tiene un alcance en píxeles (se reduce al acercar el zoom); Alt lo suspende mientras se arrastra.
    const range = this.snapOn && !e.altKey ? snapRangeMm(this.mmPerPixelAt(this.selBox.getCenter(new THREE.Vector3())), SNAP_PX) : 0;
    const delta = raw.map((v, axis) => {
      if (d.mode === 'xz' ? axis === 1 : axis !== 1) return 0;
      let best: number | null = null;
      if (range > 0) for (const target of this.targets[axis]) {
        for (const edge of [this.selBox.min.getComponent(axis) + v, this.selBox.max.getComponent(axis) + v]) {
          const diff = target - edge;
          if (Math.abs(diff) < range && (best === null || Math.abs(diff) < Math.abs(best))) best = diff;
        }
      }
      if (best !== null) { snapped = true; return cleanMm(v + best); }
      return stepRound(v, this.moveStep);
    }) as Vec3;
    d.delta = delta;
    this.selGroup.position.set(...delta);
    this.dimGroup.position.set(...delta);
    this.onInfo(`${snapped ? 'Imán · ' : ''}Mover: ${delta.map((v) => fmtMm(v)).join(', ')} mm`);
  }

  private pointerUp(e: PointerEvent) {
    const d = this.drag;
    if (d) {
      this.drag = null;
      this.controls.enabled = true;
      this.onInfo(null);
      if (d.moved) {
        this.onDragEnd(d.delta);
        return;
      }
    }
    if (e.target !== this.canvas) return;
    if (Math.hypot(e.clientX - this.down[0], e.clientY - this.down[1]) > 4) return; // fue un arrastre de cámara
    const hit = this.pick(e);
    if (this.measuring) return this.measureClick(hit);
    if (hit) this.onPick(hit.object.userData.id);
  }

  // --- medir -------------------------------------------------------------

  /** Milímetros por píxel de pantalla a la distancia de un punto (cámara en perspectiva). */
  private mmPerPixelAt(p: THREE.Vector3): number {
    const dist = this.camera.position.distanceTo(p);
    return (2 * dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / Math.max(1, this.canvas.clientHeight);
  }

  /** Puntos de imán de una pieza: vértices y puntos medios de sus aristas, centro de su caja y (como último recurso) el punto más cercano de una arista. */
  private snapCandidates(obj: THREE.Object3D, ref: THREE.Vector3): SnapCandidate[] {
    const out: SnapCandidate[] = [];
    const tp = (v: THREE.Vector3): P3 => [v.x, v.y, v.z];
    obj.updateMatrixWorld(true);
    for (const child of obj.children) {
      if (!(child instanceof THREE.LineSegments)) continue;
      const pos = child.geometry.getAttribute('position');
      const a = new THREE.Vector3(), b = new THREE.Vector3(), m = new THREE.Vector3(), c = new THREE.Vector3();
      const seg = new THREE.Line3();
      for (let i = 0; i + 1 < pos.count; i += 2) {
        a.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld);
        b.fromBufferAttribute(pos, i + 1).applyMatrix4(child.matrixWorld);
        out.push({ p: tp(a), kind: 'vertice' }, { p: tp(b), kind: 'vertice' }, { p: tp(m.copy(a).add(b).multiplyScalar(0.5)), kind: 'medio' });
        seg.set(a, b).closestPointToPoint(ref, true, c);
        out.push({ p: tp(c), kind: 'arista' });
      }
    }
    out.push({ p: tp(new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3())), kind: 'centro' });
    return out;
  }

  private measureClick(hit: THREE.Intersection | undefined) {
    if (!hit) return;
    if (this.measurePts.length >= 2) this.clearMeasure();
    // Imán a puntos: vértice, punto medio de arista, centro de la pieza o la arista más cercana; alcance en píxeles.
    const range = this.mmPerPixelAt(hit.point) * MEASURE_SNAP_PX;
    const snap = pickSnapPoint(this.snapCandidates(hit.object, hit.point), [hit.point.x, hit.point.y, hit.point.z], range);
    const point = snap ? new THREE.Vector3(...snap.p) : hit.point.clone();
    const what = snap ? snap.kind : 'superficie';
    this.measurePts.push(point);
    this.measureKinds.push(what);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(Math.max(2, this.mmPerPixelAt(point) * 4)), new THREE.MeshBasicMaterial({ color: 0xe11d48, depthTest: false }));
    dot.position.copy(point);
    dot.renderOrder = 10;
    this.measureGroup.add(dot);
    if (this.measurePts.length === 2) {
      const [a, c] = this.measurePts;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, c]), new THREE.LineBasicMaterial({ color: 0xe11d48, depthTest: false }));
      line.renderOrder = 10;
      this.measureGroup.add(line);
      const t = measureText([a.x, a.y, a.z], [c.x, c.y, c.z]);
      this.measureLabel(a.clone().add(c).multiplyScalar(0.5), t.total, 'measure');
      this.onMeasure(t.copy);
      this.onInfo(`Distancia ${t.total} · ${t.detail}  (${this.measureKinds[0]} → ${what})`);
    } else this.onInfo(`Punto 1: ${what}. Elige el segundo punto`);
  }

  private measureLabel(pos: THREE.Vector3, text: string, cls: string) {
    this.addLabel(pos, text, false, cls);
  }

  clearMeasure() {
    this.measurePts = [];
    this.measureKinds = [];
    this.onMeasure(null);
    for (const c of [...this.measureGroup.children]) {
      (c as THREE.Mesh).geometry.dispose();
      this.measureGroup.remove(c);
    }
    this.labels.filter((l) => l.el.classList.contains('measure')).forEach((l) => l.el.remove());
    this.labels = this.labels.filter((l) => !l.el.classList.contains('measure'));
    this.onInfo(null);
  }

  /** Paso de movimiento al arrastrar en mm (0 = libre) y activación del imán a bordes de otras piezas. */
  setMoveStep(step: number) { this.moveStep = step; }
  setSnap(on: boolean) { this.snapOn = on; }

  setMeasuring(on: boolean) {
    this.measuring = on;
    this.canvas.style.cursor = on ? 'crosshair' : '';
    if (!on) this.clearMeasure();
    else this.onInfo('Elige el primer punto');
  }

  // --- etiquetas y cotas -------------------------------------------------

  private addLabel(pos: THREE.Vector3, text: string, follow: boolean, cls = '') {
    const el = document.createElement('div');
    el.className = `lbl ${cls}`;
    el.textContent = text;
    this.overlay.appendChild(el);
    this.labels.push({ pos, text, follow, el });
  }

  /** Oculta el muro que queda entre la cámara y los muebles. */
  private hideNearWalls() {
    const w = this.walls;
    if (!w) return;
    const c = this.camera.position;
    w.back.visible = c.z > -100;
    w.left.visible = c.x > 0;
    w.right.visible = c.x < w.width;
    if (w.front) w.front.visible = c.z < w.depth + 100;
  }

  private placeLabels() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    for (const l of this.labels) {
      const p = l.pos.clone();
      if (l.follow) p.add(this.selGroup.position);
      p.project(this.camera);
      const visible = p.z < 1 && p.z > -1;
      l.el.style.display = visible ? 'block' : 'none';
      l.el.style.transform = `translate(${(p.x * 0.5 + 0.5) * w}px, ${(-p.y * 0.5 + 0.5) * h}px) translate(-50%, -50%)`;
    }
  }

  /** Cotas de ancho, alto y fondo alrededor de la selección. */
  private updateDims() {
    for (const c of [...this.dimGroup.children]) {
      (c as THREE.LineSegments).geometry.dispose();
      this.dimGroup.remove(c);
    }
    this.labels.filter((l) => l.el.classList.contains('dim')).forEach((l) => l.el.remove());
    this.labels = this.labels.filter((l) => !l.el.classList.contains('dim'));
    this.dimGroup.position.set(0, 0, 0);
    if (this.selBox.isEmpty()) return;
    const { min, max } = this.selBox;
    const off = 70;
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const segs: [THREE.Vector3, THREE.Vector3, string][] = [
      [v(min.x, min.y, max.z + off), v(max.x, min.y, max.z + off), `${fmtMm(max.x - min.x)} mm`],
      [v(min.x - off, min.y, max.z), v(min.x - off, max.y, max.z), `${fmtMm(max.y - min.y)} mm`],
      [v(max.x + off, min.y, min.z), v(max.x + off, min.y, max.z), `${fmtMm(max.z - min.z)} mm`],
    ];
    const mat = new THREE.LineBasicMaterial({ color: 0x1d4ed8, depthTest: false });
    for (const [a, b, text] of segs) {
      const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([a, b]), mat);
      line.renderOrder = 9;
      this.dimGroup.add(line);
      this.addLabel(a.clone().add(b).multiplyScalar(0.5), text, true, 'dim');
    }
  }

  // --- escena ------------------------------------------------------------

  private resize() {
    const p = this.canvas.parentElement!;
    this.renderer.setSize(p.clientWidth, p.clientHeight, false);
    this.camera.aspect = p.clientWidth / Math.max(1, p.clientHeight);
    this.camera.updateProjectionMatrix();
  }

  /** Foto de un material (data URL); se carga una sola vez. */
  private photoTexture(url: string): THREE.Texture {
    let tex = this.textures.get(url);
    if (tex) return tex;
    tex = new THREE.TextureLoader().load(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    this.textures.set(url, tex);
    return tex;
  }

  private woodTexture(color: string): THREE.Texture {
    let tex = this.textures.get(color);
    if (tex) return tex;
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = color;
    g.fillRect(0, 0, 256, 256);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 70; i++) {
      g.fillStyle = rnd() > 0.5 ? `rgba(0,0,0,${0.01 + rnd() * 0.025})` : `rgba(255,255,255,${0.02 + rnd() * 0.035})`;
      g.fillRect(0, rnd() * 256, 256, 1 + rnd() * 3);
    }
    tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(color, tex);
    return tex;
  }

  private disposeChildren(g: THREE.Object3D) {
    for (const child of [...g.children]) {
      const m = child as THREE.Mesh;
      if (!m.geometry?.userData.shared) m.geometry?.dispose(); // las de sólidos son compartidas (solidCache)
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose());
      g.remove(child);
    }
  }

  /** Franja de canto redondeado (media caña): perfil (v, t) con las dos aristas del canto curvas, extruida a lo largo de u. Coordenadas locales (u, v, t). */
  private roundedEdgeStrip(L: number, W: number, T: number, rho: number, edge: 0 | 2): THREE.BufferGeometry {
    const segs = 8;
    const pts: THREE.Vector2[] = [];
    const sgn = edge === 2 ? 1 : -1;
    const innerV = edge === 2 ? W - rho : rho;
    pts.push(new THREE.Vector2(innerV, 0));
    for (let k = 0; k <= segs; k++) { const a = -Math.PI / 2 + (Math.PI / 2) * (k / segs); pts.push(new THREE.Vector2(innerV + sgn * rho * Math.cos(a), rho + rho * Math.sin(a))); }
    for (let k = 0; k <= segs; k++) { const a = (Math.PI / 2) * (k / segs); pts.push(new THREE.Vector2(innerV + sgn * rho * Math.cos(a), T - rho + rho * Math.sin(a))); }
    pts.push(new THREE.Vector2(innerV, T));
    const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: L, bevelEnabled: false, curveSegments: 1 });
    // (x, y, z) = (v, t, u) -> (u, v, t): permutación cíclica, conserva la orientación.
    for (const name of ['position', 'normal']) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) a.setXYZ(i, a.getZ(i), a.getX(i), a.getY(i));
      a.needsUpdate = true;
    }
    return g;
  }

  private mergeGeoms(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
    const out = new THREE.BufferGeometry();
    for (const name of ['position', 'normal', 'uv']) {
      const x = a.getAttribute(name) as THREE.BufferAttribute, y = b.getAttribute(name) as THREE.BufferAttribute;
      const arr = new Float32Array(x.array.length + y.array.length);
      arr.set(x.array as Float32Array); arr.set(y.array as Float32Array, x.array.length);
      out.setAttribute(name, new THREE.BufferAttribute(arr, x.itemSize));
    }
    a.dispose(); b.dispose();
    return out;
  }

  private buildMesh(part: Part, project: Project, picked: boolean): THREE.Mesh {
    const [sx, sy, sz] = part.size;
    const [px, py, pz] = part.position;
    const mat = project.materials.find((m) => m.id === part.material);
    const glass = part.material === 'vidrio';
    const textured = this.realistic && !picked && !!mat && (!!mat.texture || (mat.grain && !mat.purchased));
    const material = new THREE.MeshStandardMaterial({
      color: picked ? '#3b82f6' : textured ? '#ffffff' : mat?.color ?? '#cccccc',
      map: textured ? (mat!.texture ? this.photoTexture(mat!.texture) : this.woodTexture(mat!.color)) : null,
      roughness: mat?.purchased ? 0.35 : 0.85,
      metalness: mat?.purchased && !glass ? 0.4 : 0,
      transparent: glass,
      opacity: glass ? 0.35 : 1,
      side: (isShaped(part.shape) || part.shape?.edgeRound) ? THREE.DoubleSide : THREE.FrontSide,
    });
    let mesh: THREE.Mesh;
    const spec = solidSpec(part);
    const isMesh = part.form === 'mesh' && !!part.mesh;
    if (spec || isMesh) {
      // cilindro, tubo, prisma o revolución: malla real (geometría compartida por parámetros), centrada en el centro de la caja
      const key = spec ? JSON.stringify(spec) : `mesh:${part.mesh!.hash}:${part.mesh!.triangles}`;
      let hit = this.solidCache.get(key);
      if (!hit) {
        if (this.solidCache.size > 400) { for (const v of this.solidCache.values()) { v.geom.dispose(); v.edges.dispose(); } this.solidCache.clear(); }
        const geom = spec ? buildSolidGeometry(spec) : buildMeshGeometry(part.mesh!);
        geom.userData.shared = true;
        const edges = spec || part.mesh!.triangles <= 40000 ? new THREE.EdgesGeometry(geom, 25) : new THREE.BufferGeometry(); // mallas muy pesadas: sin aristas
        edges.userData.shared = true;
        hit = { geom, edges };
        this.solidCache.set(key, hit);
      }
      material.map = null;
      material.color.set(picked ? '#3b82f6' : mat?.color ?? '#cccccc');
      material.roughness = mat?.purchased ? 0.35 : 0.7;
      material.metalness = picked ? 0 : mat?.purchased && !glass ? 0.4 : 0.05;
      mesh = new THREE.Mesh(hit.geom, material);
      const c = partCenter(part);
      mesh.position.set(c[0], c[1], c[2]);
      if (isMesh) mesh.scale.set(part.size[0] / part.mesh!.bbox[0], part.size[1] / part.mesh!.bbox[1], part.size[2] / part.mesh!.bbox[2]); // llena `size`
      mesh.userData.id = part.id;
      mesh.castShadow = mesh.receiveShadow = this.realistic && !glass;
      mesh.add(new THREE.LineSegments(hit.edges, new THREE.LineBasicMaterial({ color: picked ? 0x1d4ed8 : 0x4b5563 })));
      this.rotateAboutCenter(mesh, part);
      return mesh;
    }
    if (isShaped(part.shape) || part.shape?.edgeRound) {
      const { u, v, t } = panelAxes(part.size);
      const o = outline(part.size, part.shape);
      const er = part.shape?.edgeRound;
      const rho = er ? Math.min(er.radius, part.size[t] / 2, part.size[v] / 2) : 0;
      if (er && rho > 0) {
        const W = part.size[v];
        const clamp = (p: [number, number]): [number, number] => [p[0], er.edge === 2 ? Math.min(p[1], W - rho) : Math.max(p[1], rho)];
        o.outer = o.outer.map(clamp);
        o.holes = o.holes.map((h) => h.map(clamp));
      }
      const shape = new THREE.Shape(o.outer.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const h of o.holes) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
      let geom: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, { depth: part.size[t], bevelEnabled: false, curveSegments: 1 });
      if (er && rho > 0) geom = this.mergeGeoms(geom, this.roundedEdgeStrip(part.size[u], part.size[v], part.size[t], rho, er.edge));
      const axis = (i: number) => new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0);
      mesh = new THREE.Mesh(geom, material);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.makeBasis(axis(u), axis(v), axis(t)).setPosition(px, py, pz);
    } else {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), material);
      mesh.position.set(px + sx / 2, py + sy / 2, pz + sz / 2);
    }
    mesh.userData.id = part.id;
    mesh.castShadow = mesh.receiveShadow = this.realistic && !glass;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, isShaped(part.shape) || part.shape?.edgeRound ? 25 : 1), new THREE.LineBasicMaterial({ color: picked ? 0x1d4ed8 : 0x4b5563 })));
    this.rotateAboutCenter(mesh, part);
    return mesh;
  }

  /** Aplica el giro de la pieza (rotX, rotY, rotZ; matriz Rz·Ry·Rx) alrededor del centro de su caja a una malla ya colocada sin giro. */
  private rotateAboutCenter(mesh: THREE.Mesh, part: Part) {
    if (!isRotated(part)) return;
    const m = rotationMatrix(part), c = partCenter(part);
    const R = new THREE.Matrix4().set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
    const about = new THREE.Matrix4().makeTranslation(c[0], c[1], c[2]).multiply(R).multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2]));
    if (mesh.matrixAutoUpdate) { mesh.updateMatrix(); mesh.matrixAutoUpdate = false; }
    mesh.matrix.premultiply(about);
  }

  update(project: Project, state: ViewState) {
    this.lastProject = project;
    this.lastState = state;
    this.disposeChildren(this.group);
    this.disposeChildren(this.selGroup);
    this.selGroup.position.set(0, 0, 0);
    this.selectedIds = state.selected;
    this.sun.castShadow = this.realistic;
    this.box.makeEmpty();
    this.selBox.makeEmpty();
    this.targets = [[], [], []];

    for (const part of project.parts) {
      if (state.isHidden(part)) continue;
      const picked = state.selected.has(part.id);
      const mesh = this.buildMesh(part, project, picked);
      (picked ? this.selGroup : this.group).add(mesh);
      mesh.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(mesh);
      this.box.union(b);
      if (picked) this.selBox.union(b);
      else for (let a = 0; a < 3; a++) this.targets[a].push(b.min.getComponent(a), b.max.getComponent(a));
    }

    this.buildGrid(project);
    this.buildRoom(project.room, state.showRoom, !!project.plan?.walls?.length);
    this.buildPlan(project, state.showPlan !== false, !!state.showRoof, state.showWalls !== false, state.showIds !== false);
    this.buildFloors(project, state.showFloors !== false && state.showPlan !== false, state.catalog ?? []);
    if (state.showRoom && project.room) {
      const r = project.room;
      this.targets[0].push(0, r.width);
      this.targets[1].push(0, r.height);
      this.targets[2].push(0, r.depth);
    }
    this.targets[1].push(0);
    // sin muebles todavía, encuadra el espacio importado
    if (this.box.isEmpty() && project.room) this.box.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(project.room.width, project.room.height, project.room.depth));
    this.updateDims();
    if (!this.fitted && !this.box.isEmpty()) {
      this.view('persp');
      this.fitted = true;
    }
  }

  /**
   * Acabados (project.finishes, más el antiguo roomFloors): piso con el contorno real de cada habitación y muros revestidos
   * sobre sus caras interiores (retranqueo de 1,5 mm, vanos libres, altura configurable). UV en mm reales, baldosa con juntas
   * dibujada en un canvas; una malla por material. Se reconstruye solo si cambian los datos y el grupo nuevo reemplaza al
   * anterior cuando todas las imágenes cargaron (sin parpadeo).
   */
  private buildFloors(project: Project, show: boolean, catalog: TextureItem[]) {
    const plan = project.plan;
    const eff = effectiveFinishes(project, catalog);
    const any = Object.keys(eff.finishes).length > 0;
    const key = show && plan && any ? JSON.stringify([eff, plan.walls, plan.openings, plan.panelH, plan.rooms?.map((r) => [r.id, r.cx, r.cz, r.x0, r.x1, r.z0, r.z1])]) : '';
    if (key === this.floorKey) return;
    this.floorKey = key;
    const token = ++this.floorToken;
    if (!key || !plan) { this.disposeFloors(); return; }
    const floors: Buckets = new Map(), walls: Buckets = new Map();
    for (const [id, rf] of Object.entries(eff.finishes)) {
      if (!plan.rooms?.some((r) => r.id === id)) { console.warn(`Acabados de ${id}: no se encontró la habitación`); continue; }
      roomFloorGeometry(plan, id, rf, eff.catalog, floors);
      roomWallGeometry(plan, id, rf, eff.catalog, walls);
    }
    const jobs = [...floors.values(), ...walls.values()];
    const files = [...new Set(jobs.map((j) => j.r.archivo).filter((f): f is string => !!f))];
    Promise.all(files.map((f) => loadTextureImage(f))).then((imgs) => {
      if (token !== this.floorToken) return; // llegó tarde: ya se reconstruyó
      const byFile = new Map(files.map((f, i) => [f, imgs[i]]));
      const group = new THREE.Group();
      const add = (set: Buckets, name: string, shadow: boolean) => {
        for (const { r, q } of set.values()) {
          const img = r.archivo ? byFile.get(r.archivo) ?? null : null;
          if (r.archivo && !img) console.warn(`Acabados: no se pudo cargar la textura ${r.archivo}; se deja la baldosa lisa`);
          const tex = new THREE.CanvasTexture(patternCanvas(r, img));
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
          tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(q.pos, 3));
          geo.setAttribute('normal', new THREE.Float32BufferAttribute(q.nrm, 3));
          geo.setAttribute('uv', new THREE.Float32BufferAttribute(q.uv, 2));
          const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35, metalness: 0 }));
          mesh.receiveShadow = shadow;
          mesh.castShadow = false;
          mesh.name = name;
          group.add(mesh);
        }
      };
      add(floors, 'piso acabado', true);
      add(walls, 'muros acabados', false);
      this.disposeFloors();
      this.floorGroup.add(...group.children);
    });
  }

  private disposeFloors() {
    for (const child of [...this.floorGroup.children]) {
      const m = child as THREE.Mesh, mat = m.material as THREE.MeshStandardMaterial;
      m.geometry.dispose();
      mat.map?.dispose();
      mat.dispose();
      this.floorGroup.remove(child);
    }
  }

  /** Muestra u oculta la cuadrícula del suelo. */
  setGrid(visible: boolean) {
    this.gridOn = visible;
    this.grid.visible = visible;
  }

  /** Zona de la cuadrícula: cubre la planta de la casa (con 1 m de margen), centrada en ella; sin plano, 12 m en el origen. El espaciado se ajusta solo al zoom (updateGrid). */
  private buildGrid(project: Project) {
    const MARGIN = 1000, STEP = 200;
    let cx = 0, cz = 0, hw = 6000;
    const h = project.plan?.house;
    if (h) {
      const x0 = Math.min(h.x0, h.x1), x1 = Math.max(h.x0, h.x1), z0 = Math.min(h.z0, h.z1), z1 = Math.max(h.z0, h.z1);
      cx = Math.round((x0 + x1) / 2 / STEP) * STEP;
      cz = Math.round((z0 + z1) / 2 / STEP) * STEP;
      const r = Math.max(cx - x0, x1 - cx, cz - z0, z1 - cz) + MARGIN;
      hw = Math.ceil(r / STEP) * STEP;
    }
    this.gridBase = { cx, cz, hw };
    this.gridKey = '';
    this.updateGrid();
  }

  /**
   * Cuadrícula visual independiente de las medidas: espaciado automático (1/5/10/50/100/200/1000 mm) según el zoom y
   * nunca más de ~500 líneas (si el paso es fino solo se dibuja una ventana alrededor de lo que se mira). Se reconstruye solo al cambiar la clave.
   */
  private updateGrid() {
    const { cx, cz, hw } = this.gridBase;
    const step = gridStepFor(this.mmPerPixelAt(this.controls.target));
    const lay = gridLayout(hw * 2, step);
    let gx = cx, gz = cz;
    if (lay.windowed) {
      // ventana alineada a múltiplos del paso, recentrada cada 100 pasos para no reconstruir a cada movimiento
      const q = step * 100;
      gx = Math.round(this.controls.target.x / q) * q;
      gz = Math.round(this.controls.target.z / q) * q;
    }
    const key = `${step}|${lay.divisions}|${gx}|${gz}`;
    if (key === this.gridKey) return;
    this.gridKey = key;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    (this.grid.material as THREE.Material).dispose();
    // los ejes del centro y las líneas se pintan con colores suaves; el paso se ve en el pie al mover (info de la barra)
    this.grid = new THREE.GridHelper(lay.divisions * step, lay.divisions, 0xb5bcc8, 0xdde1e8);
    this.grid.position.set(gx, -1, gz);
    this.grid.visible = this.gridOn;
    this.scene.add(this.grid);
    this.gridStep = step;
    this.onGridStep(step);
  }

  /** Vuelve a dibujar con otra calidad (texturas y sombras) sin cambiar el diseño. */
  refresh() {
    if (this.lastProject && this.lastState) this.update(this.lastProject, this.lastState);
  }

  /** Muro de la planta que contiene un tramo: centro de su línea y espesor (caja de panel de mayor traslape); sin caja, la propia línea y 114 mm. */
  private wallAt(plan: FloorPlan, hz: boolean, c: number, a0: number, a1: number): { c: number; T: number } {
    let best = { c, T: 114 }, bo = 0;
    for (const w of plan.walls ?? []) {
      if ((w.x1 - w.x0 >= w.z1 - w.z0) !== hz) continue;
      const c0 = hz ? w.z0 : w.x0, c1 = hz ? w.z1 : w.x1;
      if (c < c0 - 400 || c > c1 + 400) continue;
      const ov = Math.min(a1, hz ? w.x1 : w.z1) - Math.max(a0, hz ? w.x0 : w.z0);
      if (ov > bo) { bo = ov; best = { c: (c0 + c1) / 2, T: c1 - c0 }; }
    }
    return best;
  }

  /** Geometría de una abertura sobre su muro: orientación, largo, centro a lo largo del muro y centro/espesor reales del muro. */
  private openingFrame(plan: FloorPlan, o: PlanOpening) {
    const hz = Math.abs(o.z1 - o.z2) < 1, len = Math.hypot(o.x2 - o.x1, o.z2 - o.z1);
    const a0 = Math.min(hz ? o.x1 : o.z1, hz ? o.x2 : o.z2), a1 = Math.max(hz ? o.x1 : o.z1, hz ? o.x2 : o.z2);
    const w = this.wallAt(plan, hz, hz ? o.z1 : o.x1, a0, a1);
    return { hz, len, mid: (a0 + a1) / 2, c: w.c, T: w.T };
  }

  /** Colores de una abertura: puerta ámbar, ventana azul vidrio, por confirmar violeta (marca del piso opaca, hoja translúcida). */
  private openingStyle(o: PlanOpening) {
    if (o.unknown) return { floor: '#a855f7', sheet: '#a855f7', opacity: 0.5 };
    return o.kind === 'door' ? { floor: '#d97706', sheet: '#f59e0b', opacity: 0.55 } : { floor: '#0284c7', sheet: '#7dd3fc', opacity: 0.4 };
  }

  /** Hoja de una abertura: rellena exactamente el hueco del muro, con el espesor del muro y centrada en su línea. */
  private openingSheet(plan: FloorPlan, o: PlanOpening) {
    const f = this.openingFrame(plan, o), st = this.openingStyle(o);
    // 1 mm menos por lado para no pelear (z-fighting) con las caras del hueco
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(f.len - 1, o.h - 1, f.T - 1), new THREE.MeshStandardMaterial({ color: st.sheet, transparent: true, opacity: st.opacity, depthWrite: false }));
    if (!f.hz) mesh.rotation.y = Math.PI / 2;
    mesh.position.set(f.hz ? f.mid : f.c, o.y + o.h / 2, f.hz ? f.c : f.mid);
    return mesh;
  }

  /** Dibuja el plano de CAD sobre el piso y deja sus esquinas como puntos de imán para los muebles. */
  private buildPlan(project: Project, show: boolean, showRoof: boolean, showWalls: boolean, showIds: boolean) {
    this.disposeChildren(this.planGroup);
    this.labels.filter((l) => l.el.classList.contains('tag')).forEach((l) => l.el.remove());
    this.labels = this.labels.filter((l) => !l.el.classList.contains('tag'));
    const lines = project.plan?.lines;
    if (!lines?.length || !show) return;
    const pos = new Float32Array(lines.length * 6);
    lines.forEach((l, i) => pos.set([l[0], 2, l[1], l[2], 2, l[3]], i * 6));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.planGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#334155' })));
    const seen = [new Set<number>(), new Set<number>()];
    for (const l of lines) {
      for (const [axis, vals] of [[0, [l[0], l[2]]], [1, [l[1], l[3]]]] as const) {
        for (const x of vals) if (seen[axis].size < 400) seen[axis].add(Math.round(x));
      }
    }
    this.targets[0].push(...seen[0]);
    this.targets[2].push(...seen[1]);
    // puertas y ventanas leídas de las elevaciones, marcadas sobre el muro
    for (const o of project.plan?.openings ?? []) {
      const dx = o.x2 - o.x1, dz = o.z2 - o.z1, len = Math.hypot(dx, dz);
      // la marca del piso tiene el espesor real del muro y queda centrada en él, alineada al hueco
      const f = this.openingFrame(project.plan!, o);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(f.len, f.T), new THREE.MeshBasicMaterial({ color: this.openingStyle(o).floor, side: THREE.DoubleSide }));
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = -Math.atan2(dz, dx);
      m.position.set(f.hz ? f.mid : f.c, 3, f.hz ? f.c : f.mid);
      this.planGroup.add(m);
    }
    // muros de la casa: cada elevación se levanta sobre su línea de muro en la planta
    if (showWalls) {
      // una sola hoja por abertura (puerta ámbar, ventana azul, por confirmar violeta) que rellena el hueco
      for (const o of project.plan?.openings ?? []) this.planGroup.add(this.openingSheet(project.plan!, o));
      for (const e of project.plan?.panels ?? []) if (e.at) this.planGroup.add(this.panelWall(e, project.plan!));
      const gw = project.plan?.walls?.length ? this.wallBoxes(project) : this.genericWalls(project);
      if (gw) this.planGroup.add(gw);
    }
    // claves para poder referirse a cada habitación, muro y puerta
    if (showIds && project.plan) {
      const pl = project.plan, H = pl.panelH ?? 2440;
      for (const r of pl.rooms ?? []) this.addLabel(new THREE.Vector3(r.cx, 350, r.cz), r.name ? `${r.id} · ${r.name}` : r.id, false, 'tag room');
      for (const w of wallRuns(pl)) this.addLabel(new THREE.Vector3((w.x0 + w.x1) / 2, H + 120, (w.z0 + w.z1) / 2), w.id, false, 'tag wall');
      for (const d of openingIds(pl)) this.addLabel(new THREE.Vector3((d.o.x1 + d.o.x2) / 2, d.o.y + d.o.h + 100, (d.o.z1 + d.o.z2) / 2), d.id, false, 'tag door');
    }
    // techo (ensamble): paneles sólidos por recuadro, con la cara inferior a la altura del cielo
    const roofData = project.plan?.roof;
    if (showRoof && roofData?.lines.length) {
      const H = project.plan?.panelH ?? project.room?.height ?? 2440;
      const T = roofData.thickness ?? ROOF_THICKNESS;
      const rp = new Float32Array(roofData.lines.length * 6);
      roofData.lines.forEach((l, i) => rp.set([l[0], H, l[1], l[2], H, l[3]], i * 6));
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
      this.planGroup.add(new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: '#b45309' })));
      const { cells } = roofCells(roofData.lines, roofData.texts);
      const geos: THREE.BufferGeometry[] = [];
      for (const c of cells) {
        const g = new THREE.ExtrudeGeometry(new THREE.Shape(c.pts.map((p) => new THREE.Vector2(p[0], p[1]))), { depth: T, bevelEnabled: false });
        g.rotateX(Math.PI / 2); // (x, z, e) -> (x, -e, z)
        g.translate(0, H + T, 0);
        geos.push(g);
        if (showIds && c.labels.length) {
          const cx = c.pts.reduce((a, p) => a + p[0], 0) / c.pts.length, cz = c.pts.reduce((a, p) => a + p[1], 0) / c.pts.length;
          this.addLabel(new THREE.Vector3(cx, H + T + 80, cz), c.labels.join(' '), false, 'tag room');
        }
      }
      if (geos.length) {
        const merged = mergeGeometries(geos, false);
        geos.forEach((g) => g.dispose());
        if (merged) {
          const mesh = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: '#f1d9b0', transparent: true, opacity: 0.45, roughness: 0.9, side: THREE.DoubleSide, depthWrite: false }));
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          this.planGroup.add(mesh);
          this.planGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(merged, 30), new THREE.LineBasicMaterial({ color: '#92400e' })));
        }
      }
    }
  }

  /** Muro de largo `len` y alto `H` con espesor T; las puertas a ras de piso son muescas y las ventanas, huecos. */
  private wallMesh(len: number, H: number, T: number, ops: RoomOpening[], mat: THREE.Material) {
    const doors = ops.filter((o) => o.y <= 1).sort((p, q) => p.a - q.a);
    const pts: THREE.Vector2[] = [new THREE.Vector2(0, 0)];
    for (const d of doors) {
      const top = Math.min(d.h, H - 50);
      pts.push(new THREE.Vector2(d.a, 0), new THREE.Vector2(d.a, top), new THREE.Vector2(d.b, top), new THREE.Vector2(d.b, 0));
    }
    pts.push(new THREE.Vector2(len, 0), new THREE.Vector2(len, H), new THREE.Vector2(0, H));
    const shape = new THREE.Shape(pts);
    for (const o of ops) {
      if (o.y <= 1) continue;
      const y0 = o.y, y1 = Math.min(o.y + o.h, H - 20);
      shape.holes.push(new THREE.Path([new THREE.Vector2(o.a, y0), new THREE.Vector2(o.b, y0), new THREE.Vector2(o.b, y1), new THREE.Vector2(o.a, y1)]));
    }
    return new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false }), mat);
  }

  /** Paneles de muro del plano como cajas con su espesor real (perimetrales más oscuros), abiertos donde hay puertas y ventanas. */
  private wallBoxes(project: Project) {
    const plan = project.plan!;
    const H = plan.panelH ?? 2440;
    const g = new THREE.Group();
    const mats = {
      MP: new THREE.MeshStandardMaterial({ color: '#7c8da3', transparent: true, opacity: 0.6, depthWrite: false }),
      MI: new THREE.MeshStandardMaterial({ color: '#d5dde8', transparent: true, opacity: 0.6, depthWrite: false }),
    };
    // cada hueco: orientación del muro, línea transversal, tramo a lo largo, antepecho y alto
    const ops = (plan.openings ?? []).map((o) => {
      const horiz = Math.abs(o.z1 - o.z2) < 1;
      const p = horiz ? [o.x1, o.x2] : [o.z1, o.z2];
      return { horiz, c: horiz ? o.z1 : o.x1, a: Math.min(p[0], p[1]), b: Math.max(p[0], p[1]), y: o.y, h: o.h };
    });
    const box = (m: THREE.Material, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number) => {
      if (x1 - x0 < 1 || z1 - z0 < 1 || y1 - y0 < 1) return;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), m);
      mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      g.add(mesh);
    };
    for (const w of plan.walls ?? []) {
      const hz = w.x1 - w.x0 >= w.z1 - w.z0;
      const lo = hz ? w.x0 : w.z0, hi = hz ? w.x1 : w.z1, c0 = hz ? w.z0 : w.x0, c1 = hz ? w.z1 : w.x1;
      const cuts = ops.filter((o) => o.horiz === hz && o.c >= c0 - 400 && o.c <= c1 + 400 && Math.min(hi, o.b) - Math.max(lo, o.a) > 50).sort((p, q) => p.a - q.a);
      const put = (a: number, b: number, y0: number, y1: number) => (hz ? box(mats[w.kind], a, c0, b, c1, y0, y1) : box(mats[w.kind], c0, a, c1, b, y0, y1));
      let cur = lo;
      for (const o of cuts) {
        const a = Math.max(lo, o.a), b = Math.min(hi, o.b);
        if (b <= cur) continue;
        const a2 = Math.max(a, cur);
        put(cur, a2, 0, H);
        put(a2, b, 0, o.y);
        put(a2, b, o.y + o.h, H);
        cur = b;
      }
      put(cur, hi, 0, H);
    }
    return g;
  }

  /** Muros de la planta que no tienen elevación: hojas lisas de la altura de los paneles sobre las líneas de muro. */
  private genericWalls(project: Project) {
    const plan = project.plan;
    if (!plan?.house || !plan.panels?.length) return null;
    const H = plan.panelH ?? 2440, hs = plan.house;
    const covered = plan.panels.filter((e) => e.at).map((e) => e.at!);
    const pos: number[] = [];
    for (const l of plan.lines) {
      const horiz = Math.abs(l[1] - l[3]) < 0.5, vert = Math.abs(l[0] - l[2]) < 0.5;
      if (!horiz && !vert) continue;
      const a0 = horiz ? Math.min(l[0], l[2]) : Math.min(l[1], l[3]), a1 = horiz ? Math.max(l[0], l[2]) : Math.max(l[1], l[3]), c = horiz ? l[1] : l[0];
      if (a1 - a0 < 1200 || Math.min(l[0], l[2]) < hs.x0 || Math.max(l[0], l[2]) > hs.x1 || Math.min(l[1], l[3]) < hs.z0 || Math.max(l[1], l[3]) > hs.z1) continue;
      // ya lo cubre una elevación sobre la misma línea
      const hit = covered.some((q) => {
        const qh = Math.abs(q.y1 - q.y2) < 1;
        if (qh !== horiz) return false;
        const qc = qh ? q.y1 : q.x1, q0 = qh ? Math.min(q.x1, q.x2) : Math.min(q.y1, q.y2), q1 = qh ? Math.max(q.x1, q.x2) : Math.max(q.y1, q.y2);
        return Math.abs(qc - c) <= 350 && Math.min(a1, q1) - Math.max(a0, q0) >= 0.5 * (a1 - a0);
      });
      if (hit) continue;
      pos.push(l[0], 0, l[1], l[2], 0, l[3], l[2], H, l[3], l[0], 0, l[1], l[2], H, l[3], l[0], H, l[1]);
    }
    if (!pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: '#94a3b8', transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
  }

  /** Levanta una elevación de muro (dibujo en mm) sobre su línea en la planta: relleno tenue, puertas y ventanas coloreadas y las líneas del dibujo. */
  private panelWall(e: PlanPanel, plan: FloorPlan) {
    const g = new THREE.Group();
    const dx = e.at!.x2 - e.at!.x1, dz = e.at!.y2 - e.at!.y1, len = Math.hypot(dx, dz) || 1, s = len / e.w;
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(dx / len, 0, dz / len), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-dz / len, 0, dx / len));
    m.multiply(new THREE.Matrix4().makeScale(s, s, s));
    // la hoja del dibujo se centra en el muro real (la línea leída puede quedar sobre una de sus caras)
    const hz = Math.abs(e.at!.y1 - e.at!.y2) < 1;
    const wc = this.wallAt(plan, hz, hz ? e.at!.y1 : e.at!.x1, Math.min(hz ? e.at!.x1 : e.at!.y1, hz ? e.at!.x2 : e.at!.y2), Math.max(hz ? e.at!.x1 : e.at!.y1, hz ? e.at!.x2 : e.at!.y2));
    m.setPosition(hz ? e.at!.x1 : wc.c, 0, hz ? wc.c : e.at!.y1);
    // el relleno cubre solo lo que la elevación dibuja: un paso abierto del muro queda sin relleno
    const spansU = e.lines.map((l) => [Math.min(l[0], l[2]), Math.max(l[0], l[2])]).sort((p, q) => p[0] - q[0]);
    const covered: number[][] = [];
    for (const [a, b] of spansU) { const last = covered[covered.length - 1]; if (last && a <= last[1] + 250) last[1] = Math.max(last[1], b); else covered.push([a, b]); }
    const fillMat = new THREE.MeshBasicMaterial({ color: '#cbd5e1', transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false });
    for (const [a, b] of covered.filter((c) => c[1] - c[0] >= 150)) {
      const doors = e.openings.filter((o) => o.y <= 50 && o.x0 >= a - 1 && o.x1 <= b + 1).sort((p, q) => p.x0 - q.x0);
      const pts = [new THREE.Vector2(a, 0)];
      for (const d of doors) pts.push(new THREE.Vector2(d.x0, 0), new THREE.Vector2(d.x0, d.y + d.h), new THREE.Vector2(d.x1, d.y + d.h), new THREE.Vector2(d.x1, 0));
      pts.push(new THREE.Vector2(b, 0), new THREE.Vector2(b, e.h), new THREE.Vector2(a, e.h));
      const shape = new THREE.Shape(pts);
      for (const o of e.openings) if (o.y > 50 && o.x0 >= a - 1 && o.x1 <= b + 1) shape.holes.push(new THREE.Path([new THREE.Vector2(o.x0, o.y), new THREE.Vector2(o.x1, o.y), new THREE.Vector2(o.x1, o.y + o.h), new THREE.Vector2(o.x0, o.y + o.h)]));
      g.add(new THREE.Mesh(new THREE.ShapeGeometry(shape), fillMat));
    }
    // las hojas de puertas y ventanas las dibuja openingSheet (una por abertura): aquí no se duplican
    const pos = new Float32Array(e.lines.length * 6);
    e.lines.forEach((l, i) => pos.set([l[0], l[1], 0, l[2], l[3], 0], i * 6));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: '#475569' })));
    g.matrixAutoUpdate = false;
    g.matrix.copy(m);
    return g;
  }

  /** `houseWalls`: el plano ya trae los muros reales de la casa, así que del espacio no se dibuja nada (ni paredes ni piso). */
  private buildRoom(room: Room | undefined, show: boolean, houseWalls = false) {
    this.disposeChildren(this.roomGroup);
    this.walls = null;
    if (!room || !show) return;
    const wallMat = new THREE.MeshStandardMaterial({ color: '#f8fafc', transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false });
    if (houseWalls) return;
    const T = room.wall ?? 100;
    const ops: RoomOpening[] = [...(room.openings ?? [])];
    // ventana suelta del muro del fondo (proyectos anteriores a la lectura de elevaciones)
    if (room.window && !ops.some((o) => o.wall === 'back')) ops.push({ wall: 'back', a: room.window.x, b: room.window.x + room.window.w, y: room.window.y, h: room.window.h, kind: 'window' });
    const on = (w: RoomOpening['wall']) => ops.filter((o) => o.wall === w);
    const back = this.wallMesh(room.width, room.height, T, on('back'), wallMat);
    back.position.z = -T;
    const left = this.wallMesh(room.depth, room.height, T, on('left'), wallMat);
    left.rotation.y = -Math.PI / 2;
    const right = this.wallMesh(room.depth, room.height, T, on('right'), wallMat);
    right.rotation.y = -Math.PI / 2;
    right.position.x = room.width + T;
    const floor = new THREE.Mesh(new THREE.BoxGeometry(room.width, 20, room.depth), new THREE.MeshStandardMaterial({ color: '#e2e8f0', roughness: 1 }));
    floor.position.set(room.width / 2, -10, room.depth / 2);
    floor.receiveShadow = true;
    this.roomGroup.add(back, left, right, floor);
    this.walls = { back, left, right, width: room.width, depth: room.depth };
    // el frente solo se dibuja si tiene puertas o ventanas
    if (on('front').length) {
      const front = this.wallMesh(room.width, room.height, T, on('front'), wallMat);
      front.position.z = room.depth;
      this.roomGroup.add(front);
      this.walls.front = front;
    }
    for (const o of ops) {
      const len = o.b - o.a, mid = (o.a + o.b) / 2, top = Math.min(o.y + o.h, room.height - 20);
      const h = Math.max(top - o.y, 10), cy = o.y + h / 2;
      const mat = new THREE.MeshStandardMaterial(o.kind === 'door' ? { color: '#a16207', transparent: true, opacity: 0.55 } : { color: '#9fd3f0', transparent: true, opacity: 0.3 });
      const side = o.wall === 'left' || o.wall === 'right';
      const pane = new THREE.Mesh(new THREE.BoxGeometry(side ? 6 : len, h, side ? len : 6), mat);
      pane.position.set(side ? (o.wall === 'left' ? -T / 2 : room.width + T / 2) : mid, cy, side ? mid : o.wall === 'back' ? -T / 2 : room.depth + T / 2);
      this.roomGroup.add(pane);
    }
  }

  /** Encuadra el mueble desde un ángulo predefinido. */
  view(name: ViewName) {
    const box = this.box.isEmpty() ? new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1000, 1000, 500)) : this.box;
    const c = box.getCenter(new THREE.Vector3());
    const radius = box.getSize(new THREE.Vector3()).length() / 2;
    const dist = (radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 0.85;
    const dir = {
      persp: new THREE.Vector3(0.7, 0.5, 1),
      front: new THREE.Vector3(0, 0, 1),
      top: new THREE.Vector3(0, 1, 0.001),
      side: new THREE.Vector3(1, 0, 0),
    }[name].normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.controls.update();
  }

  /** PNG en alta resolución (unos 3000 px de ancho) para presentar el diseño. */
  captureHD(): string {
    const pr = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(Math.min(4, Math.max(2, 3000 / Math.max(1, this.canvas.clientWidth))));
    this.renderer.render(this.scene, this.camera);
    const png = this.canvas.toDataURL('image/png');
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.canvas.parentElement!.clientWidth, this.canvas.parentElement!.clientHeight, false);
    return png;
  }

  // --- exportar vistas (src/web/exportView.ts) -----------------------------

  /** Posición y objetivo de la cámara orbital (para guardar vistas). */
  getCamera(): { position: Vec3; target: Vec3 } {
    return { position: this.camera.position.toArray() as Vec3, target: this.controls.target.toArray() as Vec3 };
  }
  setCamera(position: Vec3, target: Vec3) {
    this.camera.position.set(...position);
    this.controls.target.set(...target);
    this.controls.update();
  }
  /** Tamaño en píxeles del lienzo visible (proporción base de las exportaciones). */
  viewSize(): { w: number; h: number } {
    return { w: Math.max(1, this.canvas.clientWidth), h: Math.max(1, this.canvas.clientHeight) };
  }

  /** Cámara que mira desde la dirección `dir` (del objetivo hacia la cámara) y encuadra todo el modelo para un lienzo de proporción `aspect`. */
  framing(dir: Vec3, aspect: number): { position: Vec3; target: Vec3 } {
    const box = this.box.isEmpty() ? new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1000, 1000, 500)) : this.box;
    const c = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    const vf = THREE.MathUtils.degToRad(this.camera.fov / 2), hf = Math.atan(Math.tan(vf) * aspect);
    const dist = (radius / Math.sin(Math.min(vf, hf))) * 1.05;
    const d = new THREE.Vector3(...dir).normalize();
    return { position: c.clone().addScaledVector(d, dist).toArray() as Vec3, target: c.toArray() as Vec3 };
  }

  /**
   * Dibuja la escena a `w × h` px con un renderizador aparte (no toca el visor: ni su tamaño, ni su cámara, ni su estado) y devuelve un canvas 2D
   * con el resultado. `position`/`target` por omisión la cámara actual; `ortho` usa proyección ortográfica encuadrando el modelo; `background` null = transparente.
   * Las cotas y etiquetas son HTML en el visor: con `labels` se dibujan sobre el canvas con su mismo estilo.
   */
  exportRender(o: { w: number; h: number; position?: Vec3; target?: Vec3; ortho?: boolean; background: string | null; grid: boolean; labels: boolean }): HTMLCanvasElement {
    const gl = document.createElement('canvas');
    gl.width = o.w; gl.height = o.h;
    const r = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1);
    r.setSize(o.w, o.h, false);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    const target = new THREE.Vector3(...(o.target ?? (this.controls.target.toArray() as Vec3)));
    const pos = new THREE.Vector3(...(o.position ?? (this.camera.position.toArray() as Vec3)));
    const aspect = o.w / o.h;
    let cam: THREE.Camera;
    if (o.ortho) {
      const dist = Math.max(1, pos.distanceTo(target));
      const oc = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1);
      oc.position.copy(pos);
      oc.up.set(0, 1, 0);
      oc.lookAt(target);
      oc.updateMatrixWorld(true);
      const box = this.box.isEmpty() ? new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1000, 1000, 500)) : this.box;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const p = new THREE.Vector3(x, y, z).applyMatrix4(oc.matrixWorldInverse);
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z);
      }
      let hw = ((x1 - x0) / 2) * 1.06, hh = ((y1 - y0) / 2) * 1.06;
      if (hw / hh < aspect) hw = hh * aspect; else hh = hw / aspect;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      Object.assign(oc, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh, near: Math.max(1, Math.min(-z1 - 200, dist)), far: Math.max(dist + 1, -z0 + 200) });
      oc.updateProjectionMatrix();
      cam = oc;
    } else {
      const pc = new THREE.PerspectiveCamera(this.camera.fov, aspect, this.camera.near, this.camera.far);
      pc.position.copy(pos);
      pc.lookAt(target);
      cam = pc;
    }
    const saved = { bg: this.scene.background, grid: this.grid.visible, dim: this.dimGroup.visible, meas: this.measureGroup.visible, flash: this.flashGroup.visible };
    try {
      this.scene.background = o.background ? new THREE.Color(o.background) : null;
      this.grid.visible = o.grid && this.gridOn;
      this.dimGroup.visible = this.measureGroup.visible = o.labels;
      this.flashGroup.visible = false;
      r.render(this.scene, cam);
    } finally {
      this.scene.background = saved.bg; this.grid.visible = saved.grid; this.dimGroup.visible = saved.dim; this.measureGroup.visible = saved.meas; this.flashGroup.visible = saved.flash;
    }
    const out = document.createElement('canvas');
    out.width = o.w; out.height = o.h;
    const g = out.getContext('2d')!;
    g.drawImage(gl, 0, 0);
    r.dispose();
    r.forceContextLoss();
    if (o.labels) this.paintLabels(g, cam, o.w, o.h);
    return out;
  }

  /** Dibuja las etiquetas HTML visibles (cotas, claves de habitación, medidas) sobre un canvas 2D con la cámara dada. */
  private paintLabels(g: CanvasRenderingContext2D, cam: THREE.Camera, w: number, h: number) {
    const k = Math.max(1, w / Math.max(1, this.canvas.clientWidth));
    for (const l of this.labels) {
      const p = l.pos.clone();
      if (l.follow) p.add(this.selGroup.position);
      p.project(cam);
      if (p.z >= 1 || p.z <= -1 || Math.abs(p.x) > 1.2 || Math.abs(p.y) > 1.2) continue;
      const cs = getComputedStyle(l.el);
      const px = parseFloat(cs.fontSize) * k;
      g.font = `${cs.fontWeight} ${px}px ${cs.fontFamily}`;
      const tw = g.measureText(l.text).width, pad = 6 * k, bh = px * 1.5;
      const x = (p.x * 0.5 + 0.5) * w - tw / 2 - pad, y = (-p.y * 0.5 + 0.5) * h - bh / 2;
      g.fillStyle = cs.backgroundColor; g.strokeStyle = cs.borderColor; g.lineWidth = Math.max(1, k);
      g.beginPath(); g.roundRect(x, y, tw + pad * 2, bh, 4 * k); g.fill(); g.stroke();
      g.fillStyle = cs.color; g.textBaseline = 'middle';
      g.fillText(l.text, x + pad, y + bh / 2 + k * 0.5);
    }
  }

  /** PNG del estado actual del visor (sin las cotas, que son HTML). */
  capture(): string {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }
}

/** Imágenes de texturas ya cargadas por nombre de archivo (null = falló); se reutilizan entre reconstrucciones. */
const textureImages = new Map<string, Promise<HTMLImageElement | null>>();
function loadTextureImage(file: string): Promise<HTMLImageElement | null> {
  let p = textureImages.get(file);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { textureImages.delete(file); resolve(null); };
      img.src = `/api/textura/${encodeURIComponent(file)}?v=${Date.now()}`;
    });
    textureImages.set(file, p);
  }
  return p;
}

/** Dibuja un período del patrón (una baldosa en recto; dos filas desfasadas 50 % en trabado) con sus juntas. */
export function patternCanvas(r: Resolved, img: HTMLImageElement | null): HTMLCanvasElement {
  const { pw, ph } = patternPeriod(r);
  const s = Math.min(3, 1024 / Math.max(pw, ph)); // px por mm
  const cv = document.createElement('canvas');
  cv.width = Math.max(2, Math.round(pw * s));
  cv.height = Math.max(2, Math.round(ph * s));
  const c = cv.getContext('2d')!;
  c.fillStyle = r.colorJunta;
  c.fillRect(0, 0, cv.width, cv.height);
  const ins = Math.max(r.junta > 0 ? 0.5 : 0, (r.junta * s) / 2);
  const tw = r.w * s, th = r.h * s;
  const tile = (x: number, y: number) => {
    const w = tw - 2 * ins, h = th - 2 * ins;
    if (img) {
      c.save();
      c.beginPath(); c.rect(x + ins, y + ins, w, h); c.clip();
      c.translate(x + tw / 2, y + th / 2);
      if (r.veta === 90) { c.rotate(Math.PI / 2); c.drawImage(img, -h / 2, -w / 2, h, w); } else c.drawImage(img, -w / 2, -h / 2, w, h);
      c.restore();
    } else {
      c.fillStyle = r.color ?? '#cccccc';
      c.fillRect(x + ins, y + ins, w, h);
    }
  };
  tile(0, 0);
  if (r.patron === 'trabado') { tile(-tw / 2, th); tile(tw / 2, th); }
  return cv;
}
