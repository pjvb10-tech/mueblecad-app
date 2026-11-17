# Usar MuebleCAD desde un agente (MCP)

MuebleCAD incluye un servidor **MCP** (Model Context Protocol) que deja a un agente de IA (Claude Code, Claude Desktop u otro cliente MCP) leer y modificar tu proyecto: crear muebles, sacar la lista de cortes y el presupuesto, probar acabados de piso y muros, y contar cuántas losas comprar. El agente edita el mismo `project.json` que usa la app; la app web o de escritorio se actualiza sola en ~1 segundo.

## Instalación

### Con la app de escritorio (sin Node ni repositorio)

1. Instala `MuebleCAD-Setup.exe` (o usa la portátil `MuebleCAD.exe`) y ábrela.
2. Pulsa **Conectar Claude** (barra superior): muestra el comando `claude mcp add ...` y la configuración JSON (Claude Desktop, `.mcp.json`) con las rutas reales de tu instalación y de tu carpeta de datos (`Documentos/MuebleCAD`, o `MUEBLECAD_DATA` si la definiste). Copia y pégalo en una terminal.
3. Abre una sesión nueva del agente y comprueba con `/mcp` que `mueblecad` está conectado.

El servidor MCP va empaquetado en la app (`dist-mcp/mcp.cjs`, generado con esbuild por `npm run dist`). Al arrancar, la app lo copia a `<datos>/mcp/mcp.cjs` (ruta estable) y el comando usa el propio ejecutable como Node: `MuebleCAD.exe` con la variable `ELECTRON_RUN_AS_NODE=1` y esa ruta como argumento, transporte stdio. La versión **portátil** es un lanzador que se descomprime en una carpeta temporal y termina al instante, así que no sirve como Node por stdio: el comando que muestra usa el ejecutable temporal y **solo vale mientras la app está abierta**. Para un registro permanente instala con `MuebleCAD-Setup.exe`.

### Desde el código

Requisitos: Node.js 20 o superior, el repositorio clonado y `npm install` una vez. (Opcional) la app abierta (`npm run dev`) para ver los cambios y para `get_screenshot`. En modo `npm run dev` el botón **Conectar Claude** también muestra el comando (con `node` + `tsx`) con las rutas del repositorio. `npm run build:mcp` genera `dist-mcp/mcp.cjs` si quieres probar el paquete con `node dist-mcp/mcp.cjs`.

## Registrarlo en Claude Code desde el código

Variable `MUEBLECAD_DATA`: carpeta de datos donde están `project.json` y `texturas/`. Si no la pones, usa la carpeta `data/` del repositorio. Para trabajar con los datos de la app de escritorio usa su carpeta (normalmente `Documentos/MuebleCAD`).

**Mac / Linux**

```bash
claude mcp add mueblecad -e MUEBLECAD_DATA="$HOME/Documents/MuebleCAD" -- npx tsx /ruta/al/repositorio/server/mcp.ts
```

**Windows** (`npx` es un script `.cmd`, por eso va envuelto en `cmd.exe`):

```bat
claude mcp add mueblecad -e MUEBLECAD_DATA=C:\Users\TU_USUARIO\Documents\MuebleCAD -- cmd.exe /d /c npx tsx C:\ruta\al\repositorio\server\mcp.ts
```

Alternativa más ligera en Windows (sin `cmd` ni `npx`, un proceso menos):

```bat
claude mcp add mueblecad -e MUEBLECAD_DATA=C:\Users\TU_USUARIO\Documents\MuebleCAD -- node C:\ruta\al\repositorio\node_modules\tsx\dist\cli.mjs C:\ruta\al\repositorio\server\mcp.ts
```

**Alcance (`-s`)**: por omisión (`-s local`) el servidor queda registrado solo para el directorio donde ejecutas el comando. `-s project` lo guarda en un `.mcp.json` de ese proyecto (compartible, pero lleva rutas de tu equipo). **`-s user` lo carga en TODAS tus sesiones de Claude Code**, una copia del servidor por sesión: si tienes poca RAM, evítalo y usa `local` o `project`.

## Herramientas

Cada descripción empieza con `[SOLO LECTURA]`, `[ESCRIBE project.json]` o `[ESCRIBE ARCHIVOS]` (también como anotación MCP `readOnlyHint`). Medidas en mm; X ancho, Y alto, Z fondo (el frente mira a +Z).

**Proyecto**
- `get_project({ full? })` (lectura): materiales, piezas, herrajes, acabados, muebles; el plano importado va resumido (con `full=true`, completo y muy grande).
- `list_furniture` (lectura), `add_material`, `set_kerf`, `set_room` (caja simple de espacio).
- `list_backups` (lectura) y `restore_backup({ name })`: ver Seguridad de datos.

**Muebles y piezas**
- `add_cabinet({ name?, width, height, depth, x?, y?, z?, kind?, wingB?, shelves?, shelfAt?, rods?, rodMaterial?, faceBack?, material?, backMaterial?, doorMaterial?, drawers?, doors?, rebateBack?, edging? })`: mueble recto o esquinero en L. `shelfAt` = alturas (mm desde la base) de la cara inferior de cada entrepaño; `rods` = alturas de las barras de colgar (tubo de 25 mm, material `rodMaterial`, p. ej. uno comprado); `faceBack` = frente espejado hacia -Z.
- `resize_furniture({ group, ...mismas opciones })`: cambia medidas u opciones y regenera sus piezas (`rods: []` quita las barras).
- `add_part`, `update_part`: una pieza (caja por omisión) con giro (`rotX/rotY/rotZ`, grados, alrededor del centro; orden X, Y, Z) y formas sólidas (`form`: `cylinder`, `tube`, `prism`, `revolve`, con `axis`, `wall`, `cornerRadius`, `profile`, `segments`); `null` quita un campo. Ver [formas.md](formas.md).
- `batch_parts({ add?, update?, remove?, dryRun? })`: muchas piezas en una llamada, todo o nada y con un solo respaldo (borra, actualiza y agrega, en ese orden).
- `list_parts` (lectura, compacta, con filtros) y `get_solids` (lectura: perfiles y sólidos agrupados con su volumen; no entran al despiece).
- `remove_part`, `remove_furniture`, `move_furniture`, `set_layer`, `clear_parts`, `fit_to_room`.
- `set_edge_round({ id, edge: 0|2, radius, quitar? })`: canto redondeado (media caña); radio máximo = mitad del espesor de la pieza. Solo afecta al 3D.

**Cortes y presupuesto**: `auto_edges`, `calc_hardware`, `set_prices`, `get_budget`, `get_cutlist`, `optimize_cuts` (lectura salvo las tres primeras), `export_files` (CSV, DXF y G-code en `export/`).

**Archivos .mcad**: `export_mcad` (escribe `<proyecto>.mcad` en `export/`) e `import_mcad({ path })` (lee de `importar/`, acepta también `.json` antiguos y REEMPLAZA el proyecto activo tras guardar una copia en `respaldos/`). Herramientas nuevas: abre una sesión nueva de Claude Code para verlas.

**Habitaciones y plano** (requieren un plano importado en la app)
- `list_rooms`: claves `H#`, nombre, área y caja.
- `describe_room({ room })`: contorno real del piso (rectángulos), caras interiores de los muros (norte/sur/este/oeste, coordenada, tramo) con las aberturas `D#`/`V#`/`A#` que las cruzan (posición, ancho, antepecho, alto), altura de muros, acabado asignado e información del techo (cantidad de paneles, espesor, altura).
- `list_openings`: todas las puertas y ventanas con su clave.
- `set_room_name({ room, name })`.

**Acabados y texturas**
- `list_textures`: biblioteca (id, nombre, categoría, tamaño de pieza, junta, patrón).
- `add_texture({ path | base64+filename | color, nombre?, categoria?, w?, h?, junta?, colorJunta?, veta?, patron? })`: agrega una imagen de UNA baldosa desde una **ruta local absoluta**, base64 o un color liso. Solo png/jpg/jpeg/webp comprobados por la firma del archivo, hasta 15 MB, sin enlaces simbólicos ni rutas de red, nombre saneado y sin sobrescribir archivos existentes. No descarga nada de internet: si la imagen está en la web, descárgala aparte y pasa la ruta.
- `update_texture`, `remove_texture({ id, deleteFile?, force? })` (el archivo solo se borra si ninguna otra entrada lo usa; se rechaza si un acabado la usa, salvo `force`).
- `set_finish({ room, surface: 'floor'|'walls', texture?, w?, h?, junta?, colorJunta?, veta?, patron?, dx?, dy?, altura?, sides? })`: asigna o ajusta el acabado; en muros, `altura` desde el piso y `sides` para un muro distinto por lado (`texture: ''` = sin revestir; `null` = vuelve al general).
- `clear_finish({ room, surface?, side? })`, `get_finishes({ room? })`.
- `estimate_tiles({ room, surface?, texture?, w?, h?, junta?, patron?, altura?, sides?, kerf?, optimize?, rotate?, reservePct?, pricePerTile?, pricePerM2? })`: cuántas losas comprar para el piso y/o muros: coloca la grilla con junta, descuenta puertas y ventanas, recorta los bordes y empaqueta los recortes en losas enteras (guillotina con kerf). Devuelve enteras, recortes, total, total con reserva, % de pérdida y costo. `optimize` prueba desfases de la grilla; `rotate` permite girar los recortes (no con veta). Es una estimación: la colocación real puede variar.

**Dibujo 2D libre** (ver [dibujo-2d.md](dibujo-2d.md): mm, ángulos en grados antihorarios, x derecha / y arriba; `plane` xy = alzado frontal, xz = planta, yz = alzado lateral)
- Dibujos: `list_drawings`, `new_drawing({ name, plane?, origin?, sheet?, layers? })`, `remove_drawing`, `get_drawing` (JSON completo) e `inspect_drawing({ drawing?, entities?, limit? })` (resumen: capas, tipos, caja). `drawing` es el id (`d1`) o el nombre; se puede omitir si solo hay un dibujo.
- Dibujar: `draw_line`, `draw_poly` (vértices `[x,y]` o `{p, bulge}`), `draw_rect` (dos esquinas o `origin`+`w`+`h`), `draw_circle` (centro+radio, centro+diámetro `d` o 3 puntos `pts`), `draw_arc` (3 puntos o centro+radio+`a0`/`a1`), `draw_text`, `draw_dim` (`linear`, `aligned`, `radius`, `diameter`). Todas aceptan `layer`, `color`, `items` (lista, todo o nada) y `dryRun`.
- Lote: `drawing_batch({ drawing?, add?, update?, remove?, dryRun? })`: borra, actualiza y agrega en una llamada, todo o nada, con el error de cada operación (`add[3]`, `update[0]`).
- Editar: `update_entity`, `remove_entity`, `move_entities`, `copy_entities({ ids, delta, count })`, `rotate_entities`, `scale_entities`, `offset_entity`, `trim_entity` y `extend_entity` (abajo); capas: `layer_new`, `layer_set` (color, tipo de línea, grosor, visible, congelada, bloqueada, `rename`), `layer_remove`.
- Recortar y extender (como en CAD; núcleo en `src/core/trimExtend.ts`): `trim_entity({ drawing?, entity, point, boundaries? | all?, edgeMode?, dryRun? })` y `extend_entity({ … })`. `point` es el «clic» en mm; `boundaries` son ids de bordes (línea, polilínea, círculo, arco) y, si se omite o `all: true`, valen todos los objetos visibles salvo el propio. Recortar quita el tramo que contiene `point` entre los cortes vecinos (si hay corte solo de un lado, hasta el extremo); el primer trozo conserva el id y, si queda partido, el segundo trae id nuevo (`added`); un círculo pasa a arco con el mismo id; una polilínea cerrada queda abierta. Extender alarga el extremo más cercano a `point` hasta el primer borde (línea recta, arco por su círculo, polilínea en su primer o último tramo). `edgeMode: "extendido"` prolonga los bordes virtualmente. Sin cortes devuelve un error claro; capas bloqueadas o congeladas se rechazan; `dryRun` solo valida; con respaldo, rev y actividad como el resto. Los sombreados asociativos cuyo contorno se recorta o extiende se recalculan (si el origen queda abierto, el sombreado conserva su contorno y deja de ser asociativo). Los inserts de bloque no se recortan ni sirven de borde (error claro: explótalos antes). También están en `drawing_execute` / `drawing_list_commands`, igual que `draw_hatch`, `block_*`, `insert_block` y `explode_insert`.
- Consultar: `query_entities({ drawing?, type?, layer?, window?, crossing?, limit?, offset? })`, `find_text({ contains })`, `measure_shapes` (longitud, área, perímetro y centroide, con arcos), `render_drawing({ drawing?, window?, width?, save?, filename? })`: devuelve un SVG como texto y con `save` lo guarda en `export/` (solo SVG).
- Del dibujo al sólido: `extrude_entity({ drawing?, entity | entities, depth, material?, name?, group? })` crea piezas `prism` (polilínea cerrada o rectángulo) o `cylinder` (círculo) a lo largo de la normal del plano; `part_to_drawing({ part, drawing?, new_name? })` dibuja el contorno de una pieza (prisma, cilindro o caja sin girar).
- Importar y exportar: `import_dxf({ path | text, units?, name?, plane?, dropDimensions?, dropFrozen? })` crea un dibujo nuevo desde un DXF (`path` es un archivo dentro de `<datos>/importar/`) y devuelve `warnings` y `stats`; `export_dxf({ drawing | all })` escribe DXF R2000 en `export/`; `export_pdf({ drawing, paper?, orientation?, scale?, titleBlock?, mono? })` escribe un PDF vectorial en `export/` (`scale`: `"fit"`, `"1:50"` o 0.02) y devuelve la escala resultante. Los DWG hay que convertirlos antes a DXF.
- Alternativa genérica: `drawing_list_commands` describe cada comando y sus parámetros; `drawing_execute({ command, params })` ejecuta cualquiera por nombre.
- Los cambios se respaldan y validan (`validateDrawings`) antes de guardar y aparecen en la actividad en vivo; `clear_parts` no borra los dibujos.

**Captura**: `get_screenshot` devuelve la última captura del visor 3D.

**Exportar vistas** (escriben en `export/`):
- `save_view({ view?, saved?, drawing?, format?, width?, height?, background?, name?, paper?, orientation?, scale?, titleBlock?, includeCutlist? })`. **Sin navegador** genera en el servidor lo vectorial: `view=front|top|right` (plano acotado), `view=sheet` (lámina PDF con frente, planta y lado, cajetín y escala; `drawing` añade el dibujo como cuarta vista; `includeCutlist` añade la lista de piezas) y `view=drawing`, en `pdf` o `svg`. Todo lo demás (vistas 3D iso/persp/…, PNG/JPG, vistas guardadas) necesita el render 3D del navegador: en ese caso la herramienta deja un pedido (ver abajo) y devuelve `queued: true`.
- `request_view_export({ view?, saved?, format?, width?, height?, background?, grid?, labels?, … })`: deja un pedido en `export/pedidos.json`. La app abierta lo detecta por los mismos eventos (SSE) que los cambios del proyecto, renderiza a la resolución pedida (hasta 8192 px) y guarda el archivo en `export/`. Si la app no está abierta el pedido queda pendiente.
- `list_view_exports` (lectura): estado de los pedidos (`pending`, `processing`, `done` con la ruta, `error`).

## Ejemplos de peticiones

- «Agrega un closet de 3 m de ancho, 2,4 m de alto y 60 cm de fondo con una barra de colgar a 1,70 m y dos repisas, en H9, pegado al muro del fondo.» (el agente usa `describe_room`, `add_cabinet` con `rods`/`shelfAt`, `fit_to_room` o `move_furniture`)
- «Prueba la textura "gris-60x120" en el piso y en los muros de H5 hasta 1,2 m de alto, y dime cuántas losas compro con 10 % de reserva.» (`list_textures`, `set_finish`, `estimate_tiles`)
- «Exporta los cortes y dime el costo del presupuesto.» (`optimize_cuts`, `get_budget`, `export_files`)

## Seguridad de datos

- Toda herramienta que escribe guarda antes una copia de `project.json` en `respaldos/` dentro de la carpeta de datos: `project-<fecha>.json` (se conservan las últimas 10; no más de una cada 30 s) y `sesion-<fecha>.json` con el estado previo al primer cambio de cada sesión (últimas 5). Tus copias manuales (`project.json.bak…`) no se tocan. El catálogo de texturas también se respalda (`catalogo-<fecha>.json`).
- Las escrituras son atómicas (archivo temporal y renombrado). Si el archivo cambió entre la lectura y la escritura (la app guardó justo en ese momento), el agente vuelve a leer y reaplica el cambio, hasta 3 veces.
- `list_backups` y `restore_backup` permiten volver atrás; restaurar guarda antes el estado actual.
- Ninguna herramienta ejecuta comandos ni descarga nada. Las únicas lecturas fuera de la carpeta de datos son la imagen cuya ruta local pidas en `add_texture` (debe ser un archivo de imagen real) ; `export_files` escribe solo en `export/`.
- Un `project.json` ilegible no se sobrescribe: el error indica cómo restaurar una copia.

## Con la app abierta

Los cambios del agente aparecen **solos y en menos de un segundo**: el servidor de la app vigila `project.json`, el registro de actividad y las texturas, y avisa a la ventana por eventos del servidor (SSE, `/api/events`); un sondeo cada segundo queda de respaldo. La ventana lo muestra de forma visible:

- Las piezas **nuevas** se resaltan en verde, las **modificadas** en naranja y las **borradas** en rojo (donde estaban) durante unos segundos.
- Un indicador abajo a la derecha dice **Agente trabajando…** (punto verde que pulsa) mientras llegan llamadas, con la última herramienta usada y un resumen ("+2 nuevas · 1 modificada"). Al hacer clic se despliega el registro de las últimas llamadas (`actividad.json`, 40 como máximo; lo escribe el MCP).
- Los cambios se adoptan como un paso deshacible (Ctrl+Z).

**Concurrencia:** el MCP y la app escriben el mismo `project.json`. El MCP relee y reaplica si el archivo cambió entre su lectura y su escritura (hasta 3 veces). La app, al guardar, envía la versión (`rev`) sobre la que editó; si el agente escribió después, el servidor responde 409 sin pisar su cambio, la app carga la versión del agente (resaltándola) y reaplica tu cambio encima. Ten en cuenta:

- Si estás escribiendo en un campo o hay un diálogo abierto, la app pausa la sincronización hasta que termines.
- La app guarda su estado completo cada vez que cambias algo. Si el agente escribe en el mismo segundo en que la app guarda un cambio tuyo, el cambio de uno puede pisar al del otro: espera a que el agente responda antes de editar a mano. Las copias en `respaldos/` guardan el estado previo a cada cambio del agente.
- Cambios de acabados y de texturas se ven sin recargar. La app no se rompe con texturas que faltan: el acabado simplemente no se dibuja y `get_finishes` lo avisa.

## Limitaciones

- No hay render 3D sin navegador (sería necesario WebGL o un rasterizador nativo, dependencias pesadas que no se añaden): las vistas 3D y los PNG/JPG de `save_view` pasan por la app abierta (`request_view_export`). Los planos, la lámina y el dibujo 2D en PDF/SVG sí se generan sin ella.
- El MCP no abre ni controla la vista 3D. `get_screenshot` solo devuelve la última captura que guardó la app (pestaña 3D abierta); sin la app, o con una captura antigua, no es fiable.
- El techo es solo visual (no entra en cortes ni presupuesto) y el agente no puede modificarlo; solo informa de sus paneles.
- Las claves `H#`, `P#`, `I#`, `D#`, `V#`, `A#` dependen del plano importado: si reimportas un plano distinto pueden cambiar.
- Las herramientas de habitaciones y acabados necesitan un plano importado con muros (DXF/DWG).
- `estimate_tiles` es una estimación (no considera la orientación real del dibujo de la textura ni mermas por rotura salvo la reserva que indiques), y usa una textura única para todas las superficies que se consulten juntas.
- Regenerar un mueble (`resize_furniture`) pierde las ediciones manuales de sus piezas.
- No hay paquete npm publicado: o se usa la app de escritorio (MCP incluido) o se ejecuta desde el repositorio clonado.
