/** Qué hay en pantalla que impide recargar ahora los cambios del agente (lógica pura; `main.ts` la alimenta con el DOM). */
export interface PauseState {
  /** Diálogos modales abiertos: `live` = formulario independiente del proyecto (se puede refrescar el resto de la ventana sin tocarlo). */
  dialogs: { live: boolean }[];
  /** Elemento con el foco: línea de comandos 2D, campo de formulario (input/select) o nada relevante. */
  focus: 'cmd' | 'field' | 'other';
  /** El foco está dentro de un diálogo `live`. */
  inLiveDialog?: boolean;
}

/**
 * true = no recargar todavía (el cambio queda pendiente y se aplica al cerrar el diálogo o soltar el campo, sin pérdida: el sondeo compara la versión).
 * Los diálogos `live` (p. ej. «Nuevo dibujo») no pausan: sus valores viven en su propio DOM y el refresco no lo toca.
 */
export function livePaused(s: PauseState): boolean {
  if (s.dialogs.some((d) => !d.live)) return true;
  if (s.focus === 'cmd') return false;
  return s.focus === 'field' && !s.inLiveDialog;
}
