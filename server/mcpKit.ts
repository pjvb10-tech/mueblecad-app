import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z, ZodRawShape } from 'zod';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: Content[]; isError?: boolean };

export const text = (v: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
export const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** Resumen de una llamada a una herramienta (para el registro de actividad que ve el usuario en la app). */
export interface ToolCall { tool: string; mode: 'read' | 'write' | 'files'; ok: boolean; message: string }
const brief = (r: ToolResult | string) => {
  const t = typeof r === 'string' ? r : r.content.find((c) => c.type === 'text')?.text ?? '';
  const line = t.replace(/\s+/g, ' ').trim();
  return line.length > 140 ? `${line.slice(0, 137)}...` : line;
};

/**
 * Registra herramientas marcando en la descripción y en las anotaciones MCP si solo leen o si escriben.
 * Si el manejador lanza una excepción, el agente recibe el mensaje como error (isError) y no se escribe nada.
 */
export function toolKit(server: McpServer, onCall?: (call: ToolCall) => void) {
  const define = <S extends ZodRawShape>(mode: 'read' | 'write' | 'files', name: string, description: string, shape: S, fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => unknown | Promise<unknown>) => {
    const tag = mode === 'read' ? '[SOLO LECTURA / READ-ONLY]' : mode === 'write' ? '[ESCRIBE / WRITES project.json]' : '[ESCRIBE ARCHIVOS / WRITES FILES]';
    server.registerTool(
      name,
      {
        description: `${tag} ${description}`,
        inputSchema: shape,
        annotations: { readOnlyHint: mode === 'read', destructiveHint: false, openWorldHint: false },
      },
      (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
        let out: ToolResult;
        try {
          const r = await fn(args);
          out = r && typeof r === 'object' && 'content' in (r as object) ? (r as ToolResult) : text(r as unknown);
        } catch (e) {
          out = fail(e instanceof Error ? e.message : String(e));
        }
        try { onCall?.({ tool: name, mode, ok: !out.isError, message: mode === 'read' ? '' : brief(out) }); } catch { /* el registro nunca debe romper la herramienta */ }
        return out;
      }) as never,
    );
  };
  return {
    /** Herramienta que no modifica nada. */
    read: <S extends ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => unknown | Promise<unknown>) => define('read', name, description, shape, fn),
    /** Herramienta que modifica project.json (con copia de respaldo y escritura atómica). */
    write: <S extends ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => unknown | Promise<unknown>) => define('write', name, description, shape, fn),
    /** Herramienta que escribe otros archivos (catálogo de texturas, exportaciones). */
    files: <S extends ZodRawShape>(name: string, description: string, shape: S, fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => unknown | Promise<unknown>) => define('files', name, description, shape, fn),
  };
}
export type Kit = ReturnType<typeof toolKit>;
