#!/bin/bash
# Doble clic en Mac: arranca MuebleCAD en modo desarrollo y abre el navegador.
# La primera vez: chmod +x iniciar.command  (y tener Node.js 20 o superior instalado)
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
(sleep 4 && open http://localhost:5173) &
npm run dev
