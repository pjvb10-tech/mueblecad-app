/** Todas las medidas están en milímetros. Ejes: X ancho, Y alto (arriba), Z fondo (el frente del mueble mira a +Z). */
export type Vec3 = [number, number, number];

export interface Material {
  id: string;
  name: string;
  /** Espesor de la plancha. */
  thickness: number;
  sheetW: number;
  sheetH: number;
  color: string;
  /** Si es true la veta corre a lo largo de la plancha y las piezas no se pueden rotar. */
  grain: boolean;
  /** Elemento comprado hecho (lavamanos, vidrio...): se dibuja pero no entra en cortes ni planchas. */
  purchased?: boolean;
  /** Precio de una plancha completa. */
  price?: number;
  /** Foto de la plancha (data URL) para el visor 3D; si falta se usa la veta procedural. */
  texture?: string;
}

/** Cantidad de cantos con tapacanto: a lo largo de la pieza (2 máx.) y a lo ancho (2 máx.). */
export interface Edges {
  largo: 0 | 1 | 2;
  ancho: 0 | 1 | 2;
}

/**
 * Forma de una pieza plana. Las coordenadas van en el plano de la pieza: u a lo largo (lado más largo),
 * v a lo ancho, con origen en la esquina mínima.
 */
export interface PartShape {
  /** Radio de las esquinas exteriores redondeadas. */
  radius?: number;
  /** Muesca rectangular en una esquina (0=u0v0, 1=u1v0, 2=u1v1, 3=u0v1), para cortes en L. */
  notch?: { w: number; h: number; corner: 0 | 1 | 2 | 3 };
  /** Huecos rectangulares interiores. */
  holes?: { x: number; y: number; w: number; h: number }[];
  /** Canto redondeado en el espesor (media caña / bullnose) en un canto largo: 0 = v mínimo, 2 = v máximo. Redondea las dos aristas del canto con `radius` mm (máx. mitad del espesor). Solo afecta al 3D: el contorno de corte no cambia. */
  edgeRound?: { edge: 0 | 2; radius: number };
}

/** Rebaje (ranura) en un canto de la pieza, por ejemplo para embutir el fondo. Cantos en el plano (u,v): 0 = v mínimo, 1 = u máximo, 2 = v máximo, 3 = u mínimo. */
export interface Rebate {
  edge: 0 | 1 | 2 | 3;
  width: number;
  depth: number;
}

/**
 * Forma sólida de una pieza (campo `form`). Una pieza sin `form` es una caja, como siempre.
 * Ojo: no confundir con `shape` (PartShape), que son los recortes 2D de las piezas planas (esquinas, muescas, huecos).
 */
export type SolidForm = 'box' | 'cylinder' | 'prism' | 'tube' | 'revolve' | 'mesh';
export type Axis = 'x' | 'y' | 'z';
/** Punto 2D de un perfil, en mm. */
export type Pt2 = [number, number];

/**
 * Malla de triángulos importada (form 'mesh'), compacta y autocontenida dentro de la pieza (va en project.json).
 * Los vértices están en mm RELATIVOS a la esquina mínima de la caja nativa de la malla (`bbox`), de modo que la caja
 * ocupa [0, bbox]. Si `size` de la pieza difiere de `bbox`, el visor escala la malla (por eje) para que llene `size`.
 */
export interface MeshData {
  vertices: number;
  triangles: number;
  /** Caja nativa de la malla en mm (extensión de los vértices). */
  bbox: Vec3;
  /** Float32 little-endian x,y,z por vértice, en base64. */
  positions: string;
  /** Uint32 little-endian, 3 por triángulo, en base64. */
  indices: string;
  /** Huella (FNV-1a) de positions+indices, para cachés y para detectar cambios. */
  hash: string;
}

export interface Part {
  id: string;
  name: string;
  /** Dimensiones de la caja de la pieza en X, Y, Z. Para las formas que no son caja es la caja ENVOLVENTE nominal (sin girar). */
  size: Vec3;
  /** Esquina mínima de la caja (sin girar). */
  position: Vec3;
  /**
   * Giro en grados (libre, admite decimales) alrededor del CENTRO de la caja (position + size / 2).
   * Orden: primero se gira alrededor de X, luego de Y y por último de Z, siempre sobre los ejes fijos del mundo
   * (matriz R = Rz·Ry·Rx). Sentido positivo: regla de la mano derecha (con X a la derecha, Y arriba, Z hacia el frente).
   * Falta o 0 = sin giro.
   */
  rotX?: number;
  rotY?: number;
  rotZ?: number;
  /** Forma sólida; falta = 'box'. Ver SolidForm y docs/formas.md. */
  form?: SolidForm;
  /**
   * Eje del largo (cilindro, tubo, prisma) o eje de giro (revolve). Si falta: cylinder/tube usan la dimensión que se
   * diferencia de las otras dos (o la más larga si las tres son distintas); prism usa 'z'; revolve usa 'y'.
   */
  axis?: Axis;
  /** Espesor de pared (mm): obligatorio en 'tube'; en 'cylinder' lo vuelve tubo redondo hueco. */
  wall?: number;
  /** Radio de la esquina exterior del tubo rectangular (mm); 0 = esquina viva. */
  cornerRadius?: number;
  /**
   * Polígono 2D en mm. prism: sección que se extruye a lo largo de `axis` (coordenadas (a, b) = (X,Y) si axis=z, (Y,Z) si axis=x,
   * (Z,X) si axis=y; origen en la esquina mínima de la caja). revolve: pares (r, h) = (distancia al eje, posición a lo largo del eje).
   */
  profile?: Pt2[];
  /** Lados con que se aproximan las curvas (cilindro: vuelta completa; tubo: por cada esquina se usa segments/8). 48 por omisión. */
  segments?: number;
  /** Solo con form 'mesh': la malla importada. Ver MeshData y docs/formas.md (sección Mallas). */
  mesh?: MeshData;
  material: string;
  /** Mueble o conjunto al que pertenece (ej. "Base 1"). */
  group?: string;
  edges?: Edges;
  shape?: PartShape;
  rebates?: Rebate[];
  /** Capa propia; si falta se deduce del nombre. */
  layer?: string;
}

/** Parámetros con los que se generó un mueble; permiten volver a generarlo con otras medidas. */
export interface CabinetSpec {
  /** "corner" = esquinero en L: un brazo a lo largo de X (width) y otro a lo largo de Z (wingB). */
  kind?: "box" | "corner";
  width: number;
  height: number;
  depth: number;
  wingB?: number;
  shelves?: number;
  drawers?: number;
  /** Número de puertas; 0 o ausente = automático (una cada ~500 mm). */
  doors?: number;
  material?: string;
  backMaterial?: string;
  doorMaterial?: string;
  /** Fondo embutido en un rebaje de laterales, base y tapa. */
  rebateBack?: boolean;
  edging?: boolean;
  /** Alturas (desde la base del mueble) de la cara inferior de cada entrepaño; si existe reemplaza el reparto uniforme de `shelves`. */
  shelfAt?: number[];
  /** Alturas (desde la base del mueble) de la parte baja de cada barra de colgar. */
  rods?: number[];
  /** Material comprado de la barra de colgar (tubo de 25 mm). */
  rodMaterial?: string;
  /** El frente mira hacia -Z (mueble pegado a un muro por su lado +Z); el fondo queda en el lado +Z. No se combina con rebateBack. */
  faceBack?: boolean;
}

export type HardwareRule = 'hinge' | 'handle' | 'shelfpin' | 'slide';

export interface HardwareItem {
  id: string;
  name: string;
  price: number;
  qty: number;
  /** Si tiene regla, "Calcular herrajes" recalcula su cantidad a partir del diseño. */
  rule?: HardwareRule;
}

/** Espacio donde va el mueble: piso, muro del fondo, muros laterales y una ventana opcional en el muro del fondo. */
export interface Room {
  width: number;
  depth: number;
  height: number;
  /** Espesor de los muros en mm (si falta, 100). */
  wall?: number;
  window?: { x: number; y: number; w: number; h: number };
  /** Puertas y ventanas de los muros, tomadas de las elevaciones del plano. */
  openings?: RoomOpening[];
}

/** Hueco en un muro: a..b es el tramo a lo largo del muro (x en fondo/frente, z en izquierdo/derecho), y = altura del antepecho. */
export interface RoomOpening {
  wall: 'back' | 'front' | 'left' | 'right';
  a: number;
  b: number;
  y: number;
  h: number;
  kind: 'door' | 'window';
  tag?: string;
}

export interface Project {
  name: string;
  /** Grosor del corte de la sierra. */
  kerf: number;
  materials: Material[];
  parts: Part[];
  /** Precio del tapacanto por metro. */
  edgePrice?: number;
  hardware?: HardwareItem[];
  room?: Room;
  /** Parámetros de los muebles creados con el generador, por nombre de mueble. */
  cabinets?: Record<string, CabinetSpec>;
  /** Plano de CAD importado para ubicar los muebles. */
  plan?: FloorPlan;
  /** (Antiguo, se migra a finishes) Acabado de piso por clave de habitación (H5…): imagen de la carpeta `texturas/` y lado de la baldosa (mm). Va aparte del plano para sobrevivir a que se regeneren las habitaciones al reimportar. */
  roomFloors?: Record<string, { image: string; tile: number }>;
  /** Acabados (texturas de la biblioteca) por clave de habitación (H5…): piso y muros. Sustituye a roomFloors, que se sigue leyendo. */
  finishes?: Record<string, import('./finish').RoomFinish>;
  /** Dibujos 2D libres (planos, perfiles, cotas) en el mismo sistema de coordenadas que las piezas. Ver docs/dibujo-2d.md. */
  drawings?: Drawing[];
  /** Vistas guardadas con nombre (cámara 3D o encuadre 2D) para restaurarlas o exportarlas. Ver src/core/savedViews.ts. */
  views?: SavedView[];
}

/** Vista guardada: cámara 3D (posición, objetivo, ortográfica y capas apagadas) o encuadre de un dibujo 2D. */
export type SavedView =
  | { id: string; name: string; kind: "3d"; camera: { position: Vec3; target: Vec3; ortho?: boolean }; hiddenLayers?: string[] }
  | { id: string; name: string; kind: "2d"; drawing: string; view: { cx: number; cy: number; scale: number } };

// ---------------------------------------------------------------- dibujo 2D (contrato completo en docs/dibujo-2d.md)

/** Plano 3D donde vive un dibujo: 'xy' (alzado frontal), 'xz' (planta, vista desde arriba) o 'yz' (alzado lateral). */
export type DrawingPlane = 'xy' | 'xz' | 'yz';
/** Color: índice ACI (1..255) o color hexadecimal "#rrggbb". */
export type DrawingColor = number | string;
export type Linetype = 'continuous' | 'dashed' | 'center';

export interface Layer {
  /** Nombre único (sin distinguir mayúsculas). La capa "0" siempre existe y no se puede borrar. */
  name: string;
  color: DrawingColor;
  linetype?: Linetype;
  /** Grosor de línea en mm de papel (0.25 por omisión). */
  lineweight?: number;
  /** Encendida (visible). */
  on: boolean;
  /** Congelada: no se muestra ni se edita. */
  frozen: boolean;
  /** Bloqueada: se muestra pero no se edita. */
  locked: boolean;
}

export interface EntityBase {
  /** Id corto estable y único dentro del dibujo ("e1", "e2"…); nunca se reutiliza dentro de un dibujo mientras exista. */
  id: string;
  /** Nombre de la capa. */
  layer: string;
  /** Color propio; si falta, "PorCapa" (el de la capa). */
  color?: DrawingColor;
}
/** `bulge` = tan(barrido/4) del tramo que sale de este vértice hacia el siguiente (+ = antihorario). 0 o falta = recto. */
export interface PolyVertex { p: Pt2; bulge?: number }
export interface LineEntity extends EntityBase { type: 'line'; a: Pt2; b: Pt2 }
export interface PolyEntity extends EntityBase { type: 'poly'; pts: PolyVertex[]; closed?: boolean }
export interface CircleEntity extends EntityBase { type: 'circle'; c: Pt2; r: number }
/** Arco antihorario (CCW) desde a0 hasta a1, en GRADOS; el barrido es (a1 - a0) normalizado a (0, 360]. */
export interface ArcEntity extends EntityBase { type: 'arc'; c: Pt2; r: number; a0: number; a1: number }
/** h = alto de letra (mm); rot = giro en grados CCW. */
export interface TextEntity extends EntityBase { type: 'text'; p: Pt2; h: number; s: string; rot?: number; align?: 'left' | 'center' | 'right' }
/**
 * Cota. linear: mide la proyección de p1-p2 sobre la dirección `rot` (0 = horizontal, 90 = vertical); aligned: mide p1-p2.
 * `at` es un punto por donde pasa la línea de cota. radius/diameter: sobre un círculo/arco (c, r), con la guía a ángulo `ang` (45 por omisión).
 * La medida NO se guarda: se calcula (dimMeasure); `text` la sustituye si existe.
 */
export interface DimLinearEntity extends EntityBase { type: 'dim'; kind: 'linear'; p1: Pt2; p2: Pt2; at: Pt2; rot?: number; text?: string }
export interface DimAlignedEntity extends EntityBase { type: 'dim'; kind: 'aligned'; p1: Pt2; p2: Pt2; at: Pt2; text?: string }
export interface DimRadialEntity extends EntityBase { type: 'dim'; kind: 'radius' | 'diameter'; c: Pt2; r: number; ang?: number; text?: string }
export type DimEntity = DimLinearEntity | DimAlignedEntity | DimRadialEntity;
/** Patrones de sombreado (ver docs/dibujo-2d.md, sección Sombreados). */
export const HATCH_PATTERNS = ['solid', 'lines', 'cross', 'dots', 'ansi31', 'brick', 'concrete', 'wood'] as const;
export type HatchPattern = (typeof HATCH_PATTERNS)[number];
/**
 * Sombreado. `loops` son contornos cerrados (vértices con bulge); el relleno usa la regla par-impar (even-odd), así que un lazo dentro de
 * otro es un hueco/isla. `scale` = separación (mm) de las líneas del patrón (50 por omisión); `angle` gira el patrón (grados, antihorario).
 * `color` (de EntityBase) es el de las líneas del patrón; `fillColor` pinta el fondo (y el sólido usa `fillColor ?? color`).
 * `source`: ids de entidades cerradas (poly cerrada / círculo) que forman los lazos; si cambian, `syncHatches` recalcula `loops`.
 */
export interface HatchEntity extends EntityBase { type: 'hatch'; loops: PolyVertex[][]; pattern: HatchPattern; angle?: number; scale?: number; fillColor?: DrawingColor; source?: string[] }
/**
 * Inserción de un bloque (Drawing.blocks) por nombre: mundo = p + R(rot)·S(sx, sy)·(local − base). sx/sy distintos de 0 (negativo = espejo),
 * por omisión 1; rot en grados CCW. Con cols/rows > 1 es un arreglo: copias separadas dx (columnas) y dy (filas) en el marco girado, sin escalar.
 * Los hijos en la capa "0" toman la capa del insert y los que no tienen color propio toman el color del insert (si lo tiene).
 */
export interface InsertEntity extends EntityBase { type: 'insert'; block: string; p: Pt2; sx?: number; sy?: number; rot?: number; cols?: number; rows?: number; dx?: number; dy?: number }
export type Entity = LineEntity | PolyEntity | CircleEntity | ArcEntity | TextEntity | DimEntity | HatchEntity | InsertEntity;

/** Bloque editable: entidades en coordenadas locales y su punto base (el punto local que cae sobre el punto de inserción). */
export interface Block { name: string; base: Pt2; entities: Entity[]; description?: string }

export interface Drawing {
  id: string;
  name: string;
  plane: DrawingPlane;
  /** Punto 3D (mm) del mundo donde está el (0,0) del dibujo. */
  origin: Vec3;
  layers: Layer[];
  entities: Entity[];
  /** Definiciones de bloques; los `insert` las referencian por nombre. */
  blocks?: Block[];
  visible?: boolean;
  /** Hoja de impresión: tamaño en mm de papel y escala (ej. 0.02 = 1:50). */
  sheet?: { w: number; h: number; scale: number };
}

/** Plano importado de CAD (DXF), dibujado sobre el piso. Cada línea es [x1, z1, x2, z2] en mm; x a la derecha, z hacia el frente (el muro del fondo está en z = 0). */
export interface FloorPlan {
  name: string;
  lines: number[][];
  /** Textos y cotas del plano: posición (mm), contenido y alto de letra (mm). */
  texts?: { x: number; z: number; t: string; h: number }[];
  /** Puertas y ventanas leídas de las elevaciones de los muros: línea del muro [x1,z1]-[x2,z2], antepecho y alto. */
  openings?: PlanOpening[];
  /** Plano de techo (ensamble), superpuesto a la planta. */
  roof?: { lines: number[][]; texts?: { x: number; z: number; t: string; h: number }[]; /** Espesor del panel de techo (mm); 210 si falta. */ thickness?: number };
  /** Altura de los paneles de muro (mm). */
  panelH?: number;
  /** Elevaciones de los paneles de muro tal como se dibujaron (mm, origen abajo a la izquierda de cada panel). */
  panels?: PlanPanel[];
  /** Rectángulo de la planta de la casa dentro del dibujo (donde buscar muros sin elevación). */
  house?: { x0: number; z0: number; x1: number; z1: number };
  /** Paneles de muro de la planta (bloques del CAD): MP = perimetral, MI = interior; rectángulo en la planta. */
  walls?: { kind: 'MP' | 'MI'; x0: number; z0: number; x1: number; z1: number }[];
  /** Habitaciones de la casa (zonas cerradas por los muros), con un nombre que se puede cambiar. */
  rooms?: PlanRoom[];
}

export interface PlanPanel {
  w: number;
  h: number;
  tags: string[];
  /** Dónde está el panel en la planta (misma referencia que las líneas del plano): de su borde izquierdo al derecho. */
  at?: { x1: number; y1: number; x2: number; y2: number };
  lines: number[][];
  texts: { x: number; y: number; t: string; h: number }[];
  openings: { x0: number; x1: number; y: number; h: number; kind: 'door' | 'window' }[];
}

/** Habitación detectada en la planta: id (H1…), nombre propio, caja, centro y área en m². */
export interface PlanRoom { id: string; name: string; x0: number; z0: number; x1: number; z1: number; cx: number; cz: number; area: number }

export interface PlanOpening {
  x1: number; z1: number; x2: number; z2: number; y: number; h: number; kind: 'door' | 'window'; tag?: string;
  /** Abertura agregada a mano (no viene del plano): clave del muro donde se puso. */
  manual?: boolean; wall?: string;
  /** Ventanal deducido de un panel perimetral especial (sin elevación): el visor le pone su vidrio. */
  fromBlock?: boolean;
  /** Panel con sombreado cuya función no se sabe todavía (ni puerta ni ventana confirmada): se corta en el muro y se marca en violeta. */
  unknown?: boolean;
  /** Nota del usuario: hoy se trata como puerta pero se convertirá en este tipo. */
  futura?: 'window';
}

export function defaultHardware(): HardwareItem[] {
  return [
    { id: 'bisagra', name: 'Bisagra', price: 0, qty: 0, rule: 'hinge' },
    { id: 'manija', name: 'Manija / tirador', price: 0, qty: 0, rule: 'handle' },
    { id: 'soporte', name: 'Soporte de repisa', price: 0, qty: 0, rule: 'shelfpin' },
    { id: 'corredera', name: 'Corredera (par)', price: 0, qty: 0, rule: 'slide' },
    { id: 'tornillos', name: 'Tornillos y tarugos (caja)', price: 0, qty: 0 },
  ];
}

export function defaultProject(): Project {
  return {
    name: 'Nuevo mueble',
    kerf: 3,
    edgePrice: 0,
    hardware: defaultHardware(),
    materials: [
      { id: 'mel18', name: 'Melamina 18 mm', thickness: 18, sheetW: 2400, sheetH: 1200, color: '#d8b98a', grain: true, price: 0 },
      { id: 'frente', name: 'Melamina blanca 18 mm (puertas)', thickness: 18, sheetW: 2400, sheetH: 1200, color: '#f1f1ee', grain: true, price: 0 },
      { id: 'mdf3', name: 'MDF 3 mm (fondos)', thickness: 3, sheetW: 2400, sheetH: 1200, color: '#a98b64', grain: false, price: 0 },
    ],
    parts: [],
  };
}
