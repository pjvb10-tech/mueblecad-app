import type { Drawing } from './types';

/**
 * Deshacer/rehacer de UN dibujo con instantáneas (copias JSON; sin DOM). Uso: antes de cada cambio `h.push(dibujo)`;
 * para deshacer `const prev = h.undo(dibujoActual)` (null si no hay nada que deshacer); rehacer con `h.redo(dibujoActual)`.
 * Las operaciones de drawing.ts son inmutables, así que también se podrían guardar las referencias; se copian para que
 * una mutación accidental del llamador no corrompa el historial.
 */
export class DrawingHistory {
  private past: string[] = [];
  private future: string[] = [];
  constructor(private limit = 100) {}

  push(d: Drawing): void {
    const s = JSON.stringify(d);
    if (this.past[this.past.length - 1] === s) return;
    this.past.push(s);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: Drawing): Drawing | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(prev) as Drawing;
  }
  redo(current: Drawing): Drawing | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(next) as Drawing;
  }
  /** Descarta el último punto guardado (el cambio falló). */
  drop(): void { this.past.pop(); }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  clear(): void { this.past = []; this.future = []; }
}
