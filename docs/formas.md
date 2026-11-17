# Giros y formas sólidas

Además de las cajas de siempre, una pieza (`Part`) puede **girar** a cualquier ángulo y tener una **forma sólida**: cilindro, tubo rectangular, prisma (polígono extruido) o revolución (perfil girado). Sirve para dibujar con precisión pilares con la cara inclinada, ruedas con ranura en V, perfiles de fierro con su espesor de pared real, ángulos, cuñas, diagonales, pasadores, etc.

Todo es opcional: **una pieza sin los campos nuevos es una caja sin giro, exactamente como antes**. Los proyectos existentes cargan, se ven y se calculan igual, y al guardarse no cambia ni un byte.

Ejemplo visual: `docs/ejemplos/formas.json` (proyecto de demostración) y sus capturas `docs/ejemplos/formas.png` y `docs/ejemplos/formas-rueda.png`.

## Convenciones

- Medidas en mm. X ancho (derecha), Y alto (arriba), Z fondo (el frente mira a +Z). Sistema de mano derecha.
- `size` y `position` **siguen siendo la caja envolvente nominal sin girar**, también en las formas que no son caja: `position` es su esquina mínima y `size` = [x, y, z]. Así todo lo que dependía de ellos (listas, vistas, selección) sigue funcionando.
- **Giro** (`rotX`, `rotY`, `rotZ`, grados, decimales libres): se gira **alrededor del centro de la caja** (`position + size / 2`).
  - Orden: primero alrededor de **X**, luego de **Y** y por último de **Z**, siempre sobre los **ejes fijos del mundo**. Matriz `R = Rz · Ry · Rx`.
  - Sentido positivo: regla de la mano derecha. Ejemplos: `rotZ: 90` lleva +X a +Y; `rotY: 90` lleva +Z a +X.
  - Con `rotX: 90, rotZ: 90`, +X pasa a +Y (primero X, que no lo mueve, luego Z). Con el orden contrario el resultado sería otro.
  - Un valor 0 o ausente = sin giro (no se guarda).
- Marco local de un sólido: `(a, b, c)` con **c = eje del largo** (`axis`). `(a, b, c) = (X, Y, Z)` si `axis = "z"`, `(Y, Z, X)` si `axis = "x"`, `(Z, X, Y)` si `axis = "y"`. Son permutaciones cíclicas: no hay espejos.

## Campos

| Campo | Para qué |
|---|---|
| `form` | `"box"` (omisión), `"cylinder"`, `"tube"`, `"prism"`, `"revolve"`, `"mesh"` (malla importada, ver Mallas). No confundir con `shape`, que son los recortes 2D de las piezas planas (esquinas, muescas, huecos) y solo existen en cajas. |
| `axis` | `"x" \| "y" \| "z"`: eje del largo (cylinder, tube, prism) o eje de giro (revolve). Por omisión: cylinder/tube = la dimensión de `size` que se diferencia de las otras dos (o la más larga); prism = `"z"`; revolve = `"y"`. |
| `wall` | Espesor de pared (mm). Obligatorio en `tube`; en `cylinder` lo vuelve tubo redondo hueco. |
| `cornerRadius` | Solo `tube`: radio de la esquina exterior (mm). 0 = esquina viva. |
| `profile` | `[[x, y], ...]` mm. prism: sección. revolve: pares `[r, h]`. |
| `segments` | Lados de las curvas (8 a 256; 48 por omisión). |
| `rotX`, `rotY`, `rotZ` | Giro en grados. |

## Cómo definir cada forma

### Tubo rectangular 50x50x3 (de 1000 mm de largo, de pie)

```json
{ "name": "Poste", "material": "acero", "form": "tube", "axis": "y",
  "size": [50, 1000, 50], "wall": 3, "cornerRadius": 6, "position": [0, 0, 0] }
```

`size` es la caja (50 × 1000 × 50); `wall` es el espesor. Para 50x20x2 tendido a lo largo de X: `size: [1000, 20, 50]`, `axis: "x"`, `wall: 2` (la sección es el lado Y × Z). Se rechaza si `wall` es mayor o igual que la mitad del lado menor.

### Tubo redondo, cilindro y pasador

```json
{ "name": "Pasador Ø12", "form": "cylinder", "axis": "x", "size": [80, 12, 12], ... }
{ "name": "Tubo Ø60x4",  "form": "cylinder", "axis": "y", "size": [60, 800, 60], "wall": 4, ... }
```

El diámetro es el lado de la caja en las otras dos direcciones; si difieren sale un cilindro elíptico.

### Cuña de pilar: de 400 a 270 mm en 1800 mm de alto

Prisma cuya sección está en el plano XY (`axis: "z"`) y se extruye 400 mm de fondo:

```json
{ "name": "Pilar", "material": "hormigon", "form": "prism", "axis": "z",
  "size": [400, 1800, 400], "position": [0, 0, 0],
  "profile": [[0, 0], [400, 0], [270, 1800], [0, 1800]] }
```

El origen del perfil es la esquina mínima de la caja, y el perfil debe caber en ella. En `add_part`/`batch_parts` puedes omitir `size` si das `length` (aquí 400): se deduce del perfil.

### Ángulo en L 40x40x3 (de 600 mm)

```json
{ "name": "Ángulo L", "form": "prism", "axis": "z", "size": [40, 40, 600],
  "profile": [[0, 0], [40, 0], [40, 3], [3, 3], [3, 40], [0, 40]], ... }
```

Los perfiles en U y T son lo mismo con otro polígono.

### Rueda de 120 mm con ranura en V

Revolución: el perfil son pares `[r, h]` (distancia al eje, posición a lo largo del eje) y se gira 360°. Rueda de 20 mm de ancho, con el eje a lo largo de Z:

```json
{ "name": "Rueda", "material": "acero", "form": "revolve", "axis": "z",
  "size": [120, 120, 20], "position": [800, 0, 900],
  "profile": [[0, 0], [60, 0], [60, 8], [52, 10], [60, 12], [60, 20], [0, 20]] }
```

La ranura es el triángulo (60, 8)-(52, 10)-(60, 12). `r` no puede ser negativo, `h` va de 0 al largo del eje y `2·r máximo` debe caber en la caja. Sirve también para rodillos, pernos con cabeza y piñones simples. Con `size` omitido se deduce: `[2R, 2R, largo]` según el eje.

### Pieza girada

Cualquier pieza (también una caja) admite giro: `{ ..., "rotZ": 35 }` para una diagonal, o `"rotX": 25, "rotY": -10.5`.

## Cálculos

- **Despiece, planchas, G-code, tapacanto y herrajes**: las piezas con `form` distinta de caja **no entran** (no se cortan de planchas). Una caja girada sigue siendo una pieza de plancha con las mismas medidas de corte. Los resultados de las cajas no cambian.
- **Lista de sólidos**: `get_solids` (MCP) y una segunda tabla al final del CSV de piezas (solo si hay sólidos) agrupan por material y forma, con descripción («tubo 50×50×3, largo 1000»), caja envolvente, cantidad y **volumen real** (analítico, no el de la malla).
- **Presupuesto**: las planchas y el tapacanto se calculan igual que antes; los sólidos no suman líneas (no tienen precio por plancha).
- **Colisiones, medidas y vistas** (muebles, puertas bloqueadas, planos de frente/planta/lado, cotas del visor): usan la **caja envolvente de la pieza ya girada** (las 8 esquinas de `position`/`size` giradas). Es una cota conservadora: para formas redondas o piezas giradas puede ser algo mayor que la geometría real. El visor sí dibuja la geometría real.
- **Visor 3D**: las curvas se suavizan y las aristas vivas quedan marcadas; las piezas iguales comparten geometría en la GPU (probado con ~860 piezas). Se pueden seleccionar y arrastrar como cualquier pieza; en el inspector hay campos de giro.

## Validación

Se rechazan, con mensajes claros, entre otros: `wall` ≥ la mitad del lado menor, tubo sin `wall`, `cornerRadius` mayor que la mitad del lado, perfil con menos de 3 vértices, sin área o con autointersección (también si se toca a sí mismo), perfil fuera de la caja envolvente o con coordenadas negativas, parámetros que no corresponden a la forma (por ejemplo `wall` en una caja), `form` desconocida y números no finitos.

## Con el agente MCP

- `add_part` y `update_part` aceptan los campos nuevos (con `null` se quita un campo: `rotZ: null` deshace el giro; `form: "box"` vuelve a caja).
- `batch_parts({ add, update, remove, dryRun })` crea, modifica y borra muchas piezas en una llamada, todo o nada, con un solo respaldo:

```json
{ "add": [
    { "name": "Poste 1", "group": "Portón", "material": "acero", "form": "tube", "axis": "y",
      "size": [50, 2000, 50], "wall": 3, "position": [0, 0, 0] },
    { "name": "Diagonal 1", "group": "Portón", "material": "acero", "form": "tube", "axis": "y",
      "size": [50, 1500, 50], "wall": 3, "position": [100, 100, 0], "rotZ": 35 } ],
  "update": [ { "id": "p12", "position": [500, 0, 0], "rotY": 15 } ],
  "remove": ["p3", "p4"] }
```

- `list_parts` (compacto, con filtros) y `get_solids`.

## Mallas

`form: "mesh"` es una pieza cuya forma es una **malla de triángulos importada** (modelos de SketchUp u otros programas). Como las demás formas: `size`/`position` son la caja envolvente, admite `rotX/rotY/rotZ`, se ve con el material de la pieza, se selecciona y colisiona por su caja, y **no entra** al despiece, planchas ni presupuesto (aparece en `get_solids` y en la tabla de sólidos del CSV, con su volumen real).

**SketchUp**: el `.skp` es propietario y no se puede leer. Exporta desde SketchUp con *Archivo > Exportar > Modelo 3D* a **OBJ**, **STL** o **glTF/GLB** (COLLADA `.dae` no está soportado: usa OBJ). SketchUp suele exportar en pulgadas (OBJ/STL, según la opción de unidades) o metros (glTF), con Z arriba.

### Datos y almacenamiento

```json
{ "form": "mesh", "size": [600, 800, 500], "position": [0, 0, 0],
  "mesh": { "vertices": 8, "triangles": 12, "bbox": [600, 800, 500],
            "positions": "<Float32 LE xyz en base64>", "indices": "<Uint32 LE en base64>", "hash": "1a2b3c4d" } }
```

- Vértices en mm **relativos a la esquina mínima de la malla** (la caja ocupa `[0, bbox]`). Si `size` difiere de `bbox` el visor la escala por eje (reescalar la pieza escala la malla; el volumen se ajusta).
- **Decisión de almacenamiento**: los datos van **dentro de la pieza, en `project.json`**, codificados en base64 (≈ 24 bytes por triángulo con vértices compartidos; 200 000 triángulos ≈ 5 MB). Se descartó un archivo aparte (`mallas/<id>.json`) porque rompería la exportación/importación de proyectos y los respaldos (`respaldos/`), que hoy son un único JSON autocontenido; un archivo suelto exigiría sincronizar copias, borrados y restauraciones. El costo es que `get_project` y los respaldos pesan más con mallas grandes; por eso las herramientas MCP las resumen (ver abajo) y el tope es moderado.
- **Límites**: máximo 200 000 triángulos por pieza (`MAX_MESH_TRIANGLES`). Al importar, si se pasa se rechaza con un mensaje, o con `decimar: true` se simplifica por agrupación de vértices en rejilla (burda: pierde detalle fino; conviene mejor exportar una versión liviana). Se limpian triángulos degenerados y vértices sin uso. Validación: tamaños base64 coherentes, índices en rango, coordenadas finitas, vértices dentro de `bbox`; `mesh` no se admite en otras formas.
- Las aristas del visor se omiten por encima de 40 000 triángulos (rendimiento); las normales se suavizan en curvas y quedan vivas por encima de 35°.

### Importar: `importMesh` (src/core/meshImport.ts)

Capa pura, sin DOM ni three.js (parsers propios para OBJ, STL binario/ASCII y glTF/GLB: sin dependencias nuevas); funciona igual en Node y navegador.

```ts
importMesh(bytes | ArrayBuffer | string, opciones): Part[]            // ids provisorios "mesh1", "mesh2"...
importMeshDetailed(...): { parts, unidad, unidadDetectada, avisos }    // lo que necesita un diálogo
```

| Opción | Efecto |
|---|---|
| `formato` / `nombreArchivo` | `obj`, `stl`, `gltf`, `glb`; si falta se deduce de la extensión o del contenido. |
| `unidad` | `mm`, `cm`, `m`, `in`, `ft`. glTF = m. En OBJ/STL, si falta, se **detecta** por tamaño (`detectUnit`: ≤ 20 → m, ≤ 500 → cm, si no mm) y se devuelve `unidadDetectada: true` con un aviso: **la UI debe mostrarla y dejar corregirla**. |
| `ejeArriba` | `y` (omisión) o `z` (SketchUp/CAD): se gira −90° alrededor de X, `(x,y,z) → (x,z,−y)`, que conserva la orientación. glTF es siempre Y arriba. |
| `escala` | Factor extra tras la unidad. |
| `nombre`, `material`, `grupo` | De las piezas (con varias: «nombre - objeto»). `material` debe existir (lo comprueba quien agrega). |
| `separar` | `objetos` (omisión; una pieza por `o`/`g` de OBJ o nodo de glTF, conservando su posición relativa) o `uno`. |
| `soldar` | Soldar vértices coincidentes (omisión: sí en STL, no en OBJ/glTF). |
| `centrar`, `posicion` | La esquina mínima del conjunto va a `posicion` (omisión `[0,0,0]`); `centrar: false` conserva las coordenadas del archivo. |
| `decimar`, `maxTriangulos` | Ver límites. |

Funciones auxiliares en `src/core/mesh.ts`: `encodeMesh`, `decodeMesh`, `validateMesh`, `meshSummary`, `meshVolume`, `weldMesh`, `cleanMesh`, `decimateMesh`.

### Cableado (UI y MCP)

- **MCP**: `import_mesh` (server/mcpMesh.ts, ya registrado en `server/mcp.ts`). Recibe `file` (archivo dentro de `<datos>/importar/`, sin salirse de esa carpeta), o `base64`, o `text`, más las opciones de arriba (en español: `unidad`, `ejeArriba`, `escala`, `separar`, `soldar`, `decimar`, `posicion`...). Agrega las piezas al proyecto con un respaldo y devuelve ids, triángulos y avisos. `get_project`, `list_parts` y `get_solids` **no vuelcan la malla**: dan un resumen (`vertices`, `triangles`, `bbox`, `kb`, `hash`).
- **Diálogo «Importar modelo 3D»** (botón «Importar 3D», `src/web/meshImportDialog.ts`; los .skp y .dae se rechazan con la indicación de exportar a OBJ): leer el archivo con `File.arrayBuffer()`, llamar `importMeshDetailed(bytes, { nombreArchivo, unidad, ejeArriba, escala, separar, decimar, material, posicion })`, mostrar `unidad`/`avisos` (y pedir la unidad si `unidadDetectada`), asignar ids reales con `nextId(project)` a cada `Part`, comprobar `validatePart` y agregarlas con un solo paso de historial.
