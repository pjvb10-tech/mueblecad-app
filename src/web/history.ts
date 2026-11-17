/** Historial para deshacer y rehacer, guardando copias del proyecto como texto JSON. */
export class History {
  private past: string[] = [];
  private future: string[] = [];

  constructor(private limit = 100) {}

  /** Guarda el estado actual antes de un cambio. */
  push(snapshot: string) {
    if (this.past[this.past.length - 1] === snapshot) return;
    this.past.push(snapshot);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: string): string | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: string): string | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }

  /** Descarta el último punto guardado (por ejemplo si el cambio falló). */
  drop() {
    this.past.pop();
  }

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  clear() {
    this.past = [];
    this.future = [];
  }
}
