// Tipos de server/texturas.cjs (se importa desde TypeScript y entra al paquete del MCP con esbuild).
declare const tx: {
  MAX_BYTES: number; CATEGORIAS: string[];
  firmaImagen(b: Buffer): 'png' | 'jpg' | 'webp' | null;
  sanearNombre(n: unknown): { base: string; ext: string; nombre: string } | null;
  extCoincide(ext: string, tipo: string | null): boolean;
  nombreLibre(dir: string, base: string, ext: string): string;
  normalizarItem(raw: unknown, base?: object): any;
  idLibre(items: { id: string }[], nombre: string): string;
};
export default tx;
