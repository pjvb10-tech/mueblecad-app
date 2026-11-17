import type { EntityInput } from '../core/drawing';
import type { Drawing, Entity, Pt2 } from '../core/types';

/**
 * GANCHOS de la interfaz de dibujo 2D: solo tipos. Las herramientas de ratón (src/core/drawingTools.ts, snap2d.ts) y la importación /
 * exportación DXF y PDF se conectan aquí sin tocar el lienzo ni la tabla. Ver `DrawingsUi.registerTool` y `DrawingsUi.setIoHandlers`.
 */

/** Evento de puntero sobre el lienzo, ya en coordenadas del dibujo (mm, y hacia arriba). */
export interface DrawingPointerEvent {
  type: 'down' | 'move' | 'up' | 'dblclick' | 'leave';
  /** Punto del dibujo bajo el cursor (sin imán). */
  point: Pt2;
  /** Píxeles relativos a la esquina superior izquierda del lienzo. */
  screen: Pt2;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** mm por píxel: sirve para el alcance del imán y las tolerancias. */
  mmPerPx: number;
  drawing: Drawing;
}

/** Marcador de imán que pinta el lienzo (cuadrito amarillo con su tipo). */
export interface SnapMarker { p: Pt2; /** "extremo", "medio", "centro", "intersección"… (se muestra como etiqueta) */ kind?: string }

/** Capa de vista previa ("fantasma"): no se guarda, se pinta encima del dibujo mientras se traza. */
export interface DrawingPreview {
  /** Entidades fantasma (id y capa son de relleno; se dibujan con el color de la capa indicada o el de la entidad). */
  entities?: Entity[];
  /** Líneas guía sueltas (ortogonal, polar…), punteadas. */
  guides?: [Pt2, Pt2][];
  snap?: SnapMarker | null;
  /** Texto junto al cursor (distancia, ángulo…). */
  label?: { p: Pt2; text: string } | null;
}

/** Lo que el lienzo le ofrece a una herramienta. */
export interface DrawingToolApi {
  readonly drawing: Drawing;
  setPreview(p: DrawingPreview | null): void;
  /** Agrega entidades al dibujo (una sola operación para deshacer). Devuelve los ids; los deja seleccionados. Lanza DrawingError si algo no es válido. */
  add(inputs: EntityInput[]): string[];
  /** Cualquier edición pura de drawing.ts (mover, girar, borrar…) como una sola operación para deshacer. */
  edit(op: (d: Drawing) => Drawing): void;
  select(ids: string[]): void;
  selection(): string[];
  /** Mensaje en la barra de estado ("Elige el segundo punto"). */
  hint(text: string | null): void;
  /** Termina la herramienta y vuelve a Seleccionar. */
  done(): void;
}

/** Controlador de una herramienta de ratón. Si `pointer` devuelve true el lienzo no mueve la vista ni selecciona. */
export interface DrawingToolController {
  id: string;
  label: string;
  title?: string;
  cursor?: string;
  activate?(api: DrawingToolApi): void;
  deactivate?(): void;
  pointer(ev: DrawingPointerEvent, api: DrawingToolApi): boolean;
  /** Teclas con la herramienta activa (Escape, Enter, números…). True = consumida. */
  key?(ev: KeyboardEvent, api: DrawingToolApi): boolean;
}

/** Importar / exportar: cada gancho recibe el dibujo activo (exportar) o el archivo elegido (importar). Mientras no haya gancho el botón está deshabilitado. */
export interface DrawingIoHandlers {
  importDxf?(file: File): Promise<void> | void;
  exportDxf?(drawing: Drawing): Promise<void> | void;
  exportPdf?(drawing: Drawing): Promise<void> | void;
}
