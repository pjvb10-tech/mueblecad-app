// Arma el comando `claude mcp add ...` y el JSON de configuración para conectar un agente con esta instalación de MuebleCAD.
// `launch` = { command, args, env }: cómo se lanza el servidor MCP (el propio .exe con ELECTRON_RUN_AS_NODE=1, o node + tsx desde el código).

const q = (s, win) => (win ? `"${String(s).replace(/"/g, '\\"')}"` : `'${String(s).replace(/'/g, `'\\''`)}'`);

function mcpCommands(launch, platform = process.platform) {
  const win = platform === 'win32';
  const envFlags = Object.entries(launch.env).map(([k, v]) => `-e ${q(`${k}=${v}`, win)}`).join(' ');
  const claudeCode = `claude mcp add mueblecad ${envFlags} -- ${[launch.command, ...launch.args].map((s) => q(s, win)).join(' ')}`;
  const json = JSON.stringify({ mcpServers: { mueblecad: { command: launch.command, args: launch.args, env: launch.env } } }, null, 2);
  return { claudeCode, json };
}

module.exports = { mcpCommands };
