# Contribuciones

Este proyecto **no acepta contribuciones externas**: no se atienden issues, pull requests ni propuestas de cambios, y los que lleguen se cerrarán sin respuesta.

El código se publica bajo la licencia MIT (ver `LICENSE`), así que puedes **bifurcarlo (fork)**, modificarlo y usarlo libremente según los términos de esa licencia.

## Levantar el proyecto (para uso propio o tu propia bifurcación)

Requisitos: Node.js 20 o superior y Git.

```bash
npm install
npm run dev        # servidor de desarrollo en http://localhost:5173
npm run typecheck  # tsc --noEmit
npm test
```

En Windows con PowerShell usa `npm.cmd` si `npm` está bloqueado. Por omisión los datos van a `data/` (ignorada por git); define `MUEBLECAD_DATA` para usar otra carpeta.
