# Dibujo 2D libre: contrato del núcleo

Un proyecto (`Project`) contiene piezas 3D y **dibujos 2D** (`Project.drawings?: Drawing[]`) en el mismo sistema de coordenadas. Este documento es el contrato que deben respetar la interfaz, el MCP y la exportación DXF. El núcleo es matemática pura (sin DOM ni servidor): `src/core/`.

Un proyecto sin `drawings` es válido y se guarda exactamente igual que antes (la clave no aparece en el JSON).

## Convenciones

- Unidades: **mm**. Ángulos: **grados** en la API y en el JSON (antihorario, CCW), nunca radianes.
- En el plano del dibujo: **x a la derecha, y arriba**.
- Ids de entidad: texto corto estable (`"e1"`, `"e2"`…), únicos dentro de su dibujo. Un id no cambia mientras la entidad exista (mover, girar, editar la conservan). Ids de dibujo: `"d1"`, `"d2"`… únicos en el proyecto (`nextDrawingId`).
- Nombres de capa: únicos sin distinguir mayúsculas; la entidad guarda el nombre canónico de la capa. La capa `"0"` siempre existe y no se renombra ni se borra.
- Color: índice ACI entero 1..255 o `"#rrggbb"`. Sin `color` en la entidad = **PorCapa**. `aciToHex(c, dark?)` (`src/core/aci.ts`): 1..9 y 250..255 exactos; 10..249 aproximados. El 7 es negro sobre fondo claro y blanco sobre oscuro.

## Dónde está el plano del dibujo en el 3D

`Drawing.plane` y `Drawing.origin` ubican el dibujo. Mundo = `origin + u·U + v·V` (`src/core/drawingPlane.ts`: `drawingToWorld`, `worldToDrawing`, `PLANE_BASIS`):

| plane | U (derecha) | V (arriba) | normal | vista |
|---|---|---|---|---|
| `xy` | +X | +Y | +Z | alzado frontal (desde +Z) |
| `xz` | +X | **-Z** | +Y | **planta**, desde arriba; "arriba" del papel = hacia el muro del fondo (z menor) |
| `yz` | **-Z** | +Y | +X | alzado lateral (desde +X) |

En los tres, U × V = normal: no hay espejos. Extruir con profundidad positiva va hacia +normal. El sistema 3D es el de las piezas: X ancho, Y alto, Z fondo (el frente mira a +Z), mano derecha.

## Tipos (`src/core/types.ts`)

```ts
Drawing { id, name, plane: 'xy'|'xz'|'yz', origin: [x,y,z], layers: Layer[], entities: Entity[],
          visible?: boolean, sheet?: { w, h, scale } }   // sheet: papel en mm; scale 0.02 = 1:50
Layer   { name, color: ACI|"#hex", linetype?: 'continuous'|'dashed'|'center', lineweight?: mm de papel,
          on, frozen, locked }
Entity  = (todas con { id, layer, color? })
  line   { type:'line', a:[x,y], b:[x,y] }
  poly   { type:'poly', pts:[{ p:[x,y], bulge? }], closed? }
  circle { type:'circle', c:[x,y], r }
  arc    { type:'arc', c, r, a0, a1 }                // CCW de a0 a a1, grados; a0 == a1 es la vuelta completa
  text   { type:'text', p, h, s, rot?, align?: 'left'|'center'|'right' }   // h = alto de letra (mm); p = punto base
  dim    { type:'dim', kind:'linear',   p1, p2, at, rot?, text? }          // rot 0 = horizontal, 90 = vertical
         { type:'dim', kind:'aligned',  p1, p2, at, text? }
         { type:'dim', kind:'radius'|'diameter', c, r, ang?, text? }       // ang: dirección de la guía (45 por omisión)
```

- **bulge** (en el vértice que sale hacia el siguiente): `tan(barrido/4)`; `+` = arco CCW (se curva a la derecha del recorrido), `-` = CW; 0/ausente = recto; semicírculo = ±1. `bulgeFromSweep`, `bulgeArc`, `bulgeFrom3Points` en `geom2d.ts`. En una poly cerrada el último vértice también puede llevar bulge (tramo de cierre).
- **rect** no es un tipo almacenado: es azúcar de entrada. Se guarda como `poly` cerrada de 4 vértices (CCW desde la esquina mínima).
- **dim**: la medida **no se guarda**, se calcula (`dimMeasure`, `dimLabel`); `text` la sustituye. `at` es un punto por donde pasa la línea de cota. Sombreados y bloques: ver las secciones «Sombreados» y «Bloques» al final.
- **Exportación DXF de cotas**: se exportan como líneas + texto sueltos (decisión del usuario). Usa `dimGeometry(dim, { textH? })`, que devuelve `{ lines: [p,q][], texts: {p,h,s,rot,align}[], value }` (extensión, línea de cota, flechas y el texto).
- `Entity.layer` debe existir en `Drawing.layers`. Capas `frozen` o `locked`: sus entidades no se pueden editar (error claro), pero se leen.

## Operaciones puras (`src/core/drawing.ts`)

Todas devuelven un dibujo **nuevo** (inmutable) y lanzan `DrawingError` (mensaje accionable en español) si algo no es válido; las operaciones por lotes son todo-o-nada.

| función | qué hace |
|---|---|
| `createDrawing(name, { id?, plane?, origin?, sheet?, layers? })` | dibujo con la capa "0" |
| `addLayer(d, layer)` / `setLayer(d, name, patch)` / `removeLayer(d, name)` | `layer.new` / `layer.set` (también renombra y actualiza las entidades) / borra capa vacía |
| `addEntity(d, input)` / `addEntities(d, inputs)` | devuelven `{ drawing, id }` / `{ drawing, ids }`; sin `layer` usa "0" |
| `updateEntity(d, id, patch)` | no cambia `id` ni `type`; `color: null` vuelve a PorCapa; valida el resultado |
| `removeEntity(d, ids)` | borra uno o varios |
| `moveEntities(d, ids, [dx,dy])`, `rotateEntities(d, ids, centro, grados)`, `scaleEntities(d, ids, centro, factor>0)` | transforman; no hay espejos |
| `copyEntities(d, ids, [dx,dy], count=1)` | copia `count` veces, cada una desplazada `delta·k`; ids nuevos agrupados por copia |
| `offsetEntity(d, id, dist)` | línea / poly sin bulge (inglete): `+` = izquierda del recorrido; círculo / arco: `+` = radio mayor |
| `validateEntity`, `validateDrawing`, `validateDrawings(project)` | devuelven el mensaje o `null` |
| `normalizeDrawing(raw)` | repone la capa "0", completa banderas de capa y valida (para leer JSON) |
| `findDrawing(project, idONombre)`, `withDrawing(project, d)`, `withoutDrawing(project, id)`, `nextDrawingId(project)` | helpers del proyecto, inmutables |
| `effectiveColor(d, e)` | color resuelto (propio o de la capa) |

Formas de **entrada** de `addEntity` (`EntityInput`; todas admiten `layer?`, `color?`, `id?`):

```jsonc
{ "type": "line", "a": [0,0], "b": [100,0] }
{ "type": "poly", "pts": [[0,0],[100,0],{"p":[100,50],"bulge":0.4}], "closed": true }   // vértices [x,y] o {p, bulge}
{ "type": "rect", "p1": [0,0], "p2": [400,300] }                                        // dos esquinas
{ "type": "rect", "origin": [0,0], "w": 400, "h": 300 }                                  // esquina + ancho + alto
{ "type": "circle", "c": [50,50], "r": 20 }   |  { "type": "circle", "c": [50,50], "d": 40 }
{ "type": "circle", "pts": [[1,0],[0,1],[-1,0]] }                                        // 3 puntos
{ "type": "arc", "c": [0,0], "r": 10, "a0": 0, "a1": 90 }                                // CCW, grados
{ "type": "arc", "pts": [[1,0],[0,1],[-1,0]] }                                           // inicio, intermedio, fin
{ "type": "text", "p": [0,0], "h": 50, "s": "Sala", "rot": 15, "align": "center" }
{ "type": "dim", "kind": "linear", "p1": [0,0], "p2": [4000,0], "at": [0,-300], "layer": "Cotas" }
```

## Geometría pura (`src/core/geom2d.ts`)

Bulge↔arco (`bulgeArc`, `arcFrom3Points`, `circleFrom3Points`), `polyLength/polyPerimeter/polyArea/polySignedArea/polyCentroid` (con arcos), `isCCW/orientCCW/reversePoly/dedupePoly`, `entityBounds/entitiesBounds`, intersecciones (`intersectLines`, `intersectSegments`, `intersectLineCircle`, `intersectCircles`, `pointsOnArc`), `distPointEntity` (hit-test: distancia 0 dentro de la caja de un texto), teselado con tolerancia (`tessellateArc`, `tessellateCircle`, `tessellatePoly`; flecha máxima `tol` mm, 0.1 por omisión), lazos (`joinSegments` une segmentos en lazos cerrados y cadenas abiertas), `pointInPolygon`, `dimMeasure/dimLabel/dimGeometry`. El ancho de un texto se estima como `0.6·h` por carácter (solo para cajas y selección).

## Deshacer

`DrawingHistory` (`src/core/drawingHistory.ts`, sin DOM): `push(dibujo)` antes de cada cambio, `undo(actual)`, `redo(actual)`, `drop()`, `canUndo/canRedo`. Guarda copias JSON de UN dibujo. (La interfaz sigue usando su `History` del proyecto completo, que ya incluye `drawings` porque va dentro de `Project`.)

## Del dibujo al sólido (`src/core/extrude.ts`)

`extrudeProfile(drawing, entity, depth, { name?, material?, group?, tolerance? })` devuelve una definición de pieza (`Omit<Part,'id'>`):

- `poly` cerrada (incluye rect y arcos, que se aproximan con segmentos; el perfil sube la tolerancia solo si pasara de 500 puntos) → `form: 'prism'` con `profile`. **Los perfiles cóncavos son válidos** (el prisma exige polígono simple; si se cruza, lanza `se cruza o se toca a sí mismo`).
- `circle` → `form: 'cylinder'` exacto.
- Otra cosa o poly abierta → `DrawingError`. `depth` ≠ 0: positiva va hacia +normal del plano, negativa al otro lado.
- El eje del prisma es el de la normal (`xy`→`z`, `xz`→`y`, `yz`→`x`); `size`/`position` es la caja envolvente en el mundo y `profile` está en el marco local del sólido (ver `docs/formas.md`). El resultado pasa `validatePart`. `material` por omisión `"mel18"`; asigna `id` al agregarla.

`partToOutline(part)` hace lo inverso: devuelve `{ plane, origin, input }` (prisma → poly, cilindro → circle, caja → rect en `xy`) o `null` (piezas giradas, tubos, revoluciones). El plano pasa por la cara mínima de la pieza sobre su eje.

## Persistencia

`drawings` va dentro de `project.json` tal cual (`JSON.stringify`); `server/store.ts` no lo toca (solo exige que sea una lista si existe). `clear_parts` y el resto de operaciones que solo cambian `parts`/`cabinets` no borran los dibujos. Quien escriba dibujos desde el MCP o la UI debe llamar `validateDrawings(project)` antes de guardar. Tests: `src/core/geom2d.test.ts`, `src/core/drawing.test.ts` (incluye ida y vuelta por el almacén).

## Ejemplo de JSON

```json
{
  "name": "Casa", "kerf": 3, "materials": [], "parts": [],
  "drawings": [{
    "id": "d1", "name": "Planta baja", "plane": "xz", "origin": [0, 0, 0],
    "sheet": { "w": 420, "h": 297, "scale": 0.02 },
    "layers": [
      { "name": "0", "color": 7, "linetype": "continuous", "on": true, "frozen": false, "locked": false },
      { "name": "Cotas", "color": 3, "linetype": "center", "on": true, "frozen": false, "locked": false }
    ],
    "entities": [
      { "id": "e1", "layer": "0", "color": "#ff8800", "type": "poly", "closed": true,
        "pts": [{ "p": [0, 0] }, { "p": [4000, 0] }, { "p": [4000, 3000] }, { "p": [0, 3000] }] },
      { "id": "e2", "layer": "Cotas", "type": "dim", "kind": "linear", "p1": [0, 0], "p2": [4000, 0], "at": [0, -300] },
      { "id": "e3", "layer": "0", "type": "text", "p": [200, 200], "h": 120, "s": "Sala", "align": "left" }
    ]
  }]
}
```

## Importar y exportar (DXF y PDF)

Funciones puras (sin DOM ni servidor), sin dependencias nuevas: el DXF se lee con `dxf-parser` (ya usada por `plan.ts`) y el PDF se escribe a mano. Para conectarlas a la interfaz o al MCP basta con guardar el texto (DXF) o los bytes (PDF) que devuelven.

### DXF de salida: `drawingToDxf` (`src/core/dxfDrawing.ts`)

```ts
drawingToDxf(drawing | drawings[], { eol?: '\r\n' | '\n', prefixLayers?, dimTextH?, trueColor? }): string
drawingsToDxfFiles(drawings, opts): { name, text }[]   // un archivo por dibujo, nombre saneado y sin repetir
```

- **DXF R2000 (AC1015)** con secciones CLASSES, HEADER (`$INSUNITS` = 4 mm, `$HANDSEED`, extensiones), TABLES (VPORT, LTYPE `Continuous`/`Dashed`/`Center`, LAYER, STYLE, VIEW, UCS, APPID, DIMSTYLE, BLOCK_RECORD), BLOCKS (`*Model_Space`, `*Paper_Space`), ENTITIES y OBJECTS. Handles únicos y consistentes con `$HANDSEED`. Fin de línea CRLF por omisión (igual que el DXF de planchas); `eol: '\n'` para LF.
- **Capas**: color ACI (los `#rrggbb` llevan el ACI más cercano en 62 y el color verdadero en 420), `linetype`, `lineweight` (código 370 en centésimas de mm, ajustado al valor válido más cercano), `on` (color negativo), `frozen` (flag 1) y `locked` (flag 4). Los caracteres no válidos en nombres de capa DXF se cambian por `_`.
- **Entidades**: `line` -> LINE; `poly` -> LWPOLYLINE (bulge en 42, cerrada en 70); `circle` -> CIRCLE; `arc` -> ARC en grados (un arco con `a0 == a1` sale como CIRCLE); `text` -> TEXT ASCII (acentos normalizados como en `export.ts`; `Ø`, `°`, `±` salen como `%%c`, `%%d`, `%%p`; `align` con 72/11; `rot` en 50). Sin color propio la entidad queda PorCapa.
- **Cotas**: sin DIMENSION nativa; se exportan como líneas + texto sueltos con `dimGeometry`, en la capa de la cota.
- Las coordenadas son las del plano del dibujo (x, y). `plane` y `origin` (la ubicación 3D) no se exportan.
- Varios dibujos en un archivo: las capas llevan el nombre del dibujo como prefijo (`Planta-Muros`, `Alzado-0`); con `prefixLayers: false` se fusionan por nombre. Un archivo por dibujo: `drawingsToDxfFiles`.
- Las capas apagadas y congeladas se exportan con su estado (no se filtran).

### DXF de entrada: `dxfToDrawing`

```ts
dxfToDrawing(text, { name?, id?, plane?, units?: 'auto'|'mm'|'cm'|'m'|'in'|'ft'|number, tolerance?, dropDimensions?, dropFrozen?, dropOff?,
                     dropLayers?: (string|RegExp)[], includePaperSpace?, maxEntities? })
  => { drawing, warnings: string[], stats: { imported, omitted, entities }, units: { factor, source } }
```

| DXF | resultado |
|---|---|
| LINE, LWPOLYLINE, POLYLINE 2D/3D | `line`, `poly` (bulge, cerrada; la Z se ignora; las mallas 3D se omiten) |
| CIRCLE, ARC | `circle`, `arc` (ángulos en grados) |
| ELLIPSE | `poly` aproximada con `tolerance` (aviso); una elipse de razón 1 pasa a `circle`/`arc` |
| SPLINE | B-spline evaluada y simplificada a `poly` con `tolerance` (aviso). Sin nudos válidos usa los puntos de ajuste o el polígono de control; los pesos (racionales) se ignoran |
| TEXT, MTEXT | `text`; se limpian los códigos de formato (`\P`, `\f..;`, `{}`, `\S`, `%%c/d/p`...). Un MTEXT de varias líneas da un `text` por línea, con su rotación y anclaje |
| DIMENSION | con bloque anónimo (`*D1`...): se expande a su geometría (líneas, flechas, texto) con aviso; sin bloque: `dim` simple (lineal, alineada, radio, diámetro); las angulares y de ordenadas sin bloque se omiten con aviso |
| INSERT / bloques | por omisión (`explodeBlocks: false`) los BLOCK pasan a `Drawing.blocks` y cada INSERT a un `insert` editable (ver «Bloques»); con `explodeBlocks: true` se explotan con escala, giro, espejo, matrices (filas/columnas) y anidados (hasta 16 niveles). La capa `0` y los colores PorBloque heredan del INSERT. Una escala no uniforme convierte círculos/arcos en polilíneas (aviso) |
| SOLID, 3DFACE | contorno como `poly` cerrada (el relleno se pierde; sirve para las flechas de las cotas) |
| HATCH | pasa a `hatch` (ver «Sombreados»); los patrones de AutoCAD que no son nuestros se aproximan con líneas (aviso); los contornos con splines se omiten |
| POINT, IMAGE, LEADER, MLINE, ATTRIB, REGION, 3DSOLID... | omitidos y contados en `stats.omitted` y en `warnings` |

- **Capas**: se leen de la tabla LAYER (color ACI o verdadero, tipo de línea -> `continuous|dashed|center`, grosor, apagada/congelada/bloqueada). Las capas que solo aparecen en las entidades se crean con valores por omisión. Un color de entidad igual al de su capa se guarda como PorCapa.
- **Colores**: ACI (1..255) y color verdadero (420, `#rrggbb`). Limitación: en un archivo con colores verdaderos, un ACI 10..249 se toma como `#rrggbb` (el parser ya entrega su RGB exacto).
- **Unidades**: `$INSUNITS` -> mm (pulgadas, pies, cm, m...). Sin unidades se asume mm y se avisa; `units` fuerza otra unidad o un factor numérico.
- **Espacio papel** (`inPaperSpace`) se omite salvo `includePaperSpace`. Las entidades invisibles o degeneradas (longitud 0, radio 0) se omiten y se cuentan.
- **Descartes**: `dropDimensions` (cotas y capas tipo `Cotas`, `DIM`, `A-ANNO-DIMS`, `Defpoints`), `dropFrozen`, `dropOff`, `dropLayers`.
- **Tamaño**: 100 000 entidades en menos de un segundo. `maxEntities` (por omisión 1 000 000) corta con aviso. Los ids son `e1`, `e2`... y el resultado pasa `validateDrawing`.
- Un `.dwg`, o un archivo que `dxf-parser` no logra leer, lanza `Error` con un mensaje en español.

### PDF: `drawingToPdf` (`src/core/pdfDrawing.ts`)

```ts
drawingToPdf(drawing, { paper?: 'A4'|'A3'|'A2'|'A1'|'A0'|{w,h}, orientation?: 'landscape'|'portrait', scale?: number|'fit', exactFit?, margin?,
                        titleBlock?: { titulo, autor?, fecha, escala?, hoja? }, colors?: 'layer'|'mono', defaultLineweight?, dimTextH?, title? }): Uint8Array
pdfLayout(drawing, opts): { paper, scale, scaleLabel, margin, area }   // lo que usará el PDF, para mostrar la escala resultante
```

- PDF 1.4 escrito a mano, una página, sin comprimir: Catalog, Pages, Page, contenido, fuente Helvetica estándar (WinAnsi: acentos, `Ø`, `°`, `±`) e Info. Trazos con grosor (`lineweight` de la capa, 0.25 mm por omisión), color y trama (`dashed`, `center`) por capa; arcos y círculos como curvas Bézier; las cotas con `dimGeometry`. Solo se dibujan las capas encendidas y no congeladas.
- Color 7 (y blanco o casi blanco) sale **negro** sobre el papel; `colors: 'mono'` lo pone todo negro.
- Papel por omisión: `drawing.sheet` (w, h) o A3 horizontal. Escala (`papel / dibujo`, 0.02 = 1:50): `scale` numérica, la de `drawing.sheet.scale` o `'fit'` (la mayor escala normalizada 1:1, 1:2, 1:5... que cabe; `exactFit` ajusta exacto). El dibujo se centra en el área libre y se recorta a ella.
- Marco a `margin` mm (10 por omisión). Con `titleBlock`, cajetín abajo a la derecha (título, autor, fecha y escala, hoja); sin `escala` usa la real ("1:50").
- Limitaciones: una sola página, los sombreados se dibujan (relleno `f*` y trazos finos); el alto de letra se toma como altura de mayúscula (≈ 0.72 del tamaño de fuente) y el ancho del texto se mide con las métricas de Helvetica.

Tests: `src/core/dxfDrawing.test.ts` (ida y vuelta con `dxf-parser`, DXF estilo AutoCAD con INSERT escalado y rotado, cotas con bloque, elipse/spline, MTEXT, 100 000 entidades) y `src/core/pdfDrawing.test.ts` (xref, offsets, `/Length`, textos, colores).
## Herramientas de ratón

Lógica pura (sin DOM) para que la interfaz dibuje y edite con el ratón como en un CAD. La UI traduce píxeles a unidades de dibujo, llama a estas funciones y aplica el resultado. Archivos: `src/core/snap2d.ts`, `select2d.ts`, `drawingTools.ts` y la base común `prims2d.ts` (segmentos/arcos, intersecciones, `SpatialIndex`). Solo cuentan las capas activas y no congeladas; las **bloqueadas** se pueden imantar y resaltar, pero no se seleccionan para editar (salvo `includeLocked`).

### Imán de objetos (`snap2d.ts`)

```ts
snapPoint(drawing, cursor: Pt2, { aperture, modes, base?, gridStep?, polarInc?, index?, exclude? }): SnapResult
// SnapResult = { point, mode: 'end'|'mid'|'cen'|'qua'|'int'|'per'|'tan'|'nea'|'grid'|'ortho'|'polar'|'none', entityId?, label, marker?, guide? }
apertureFromPixels(px, unitsPerPixel): number     // 10 px × mm/px del zoom
```

- `modes`: `{ end, mid, cen, qua, int, per, tan, nea, grid, ortho, polar }` (booleanos). `aperture` en unidades de dibujo.
- Prioridad: **end > int > mid > cen > qua > per > tan > nea**; el primero con candidato dentro de la apertura gana y, a igual prioridad, el más cercano. Si no hay imán de objeto: **ortho** (o **polar**, cada `polarInc`° = 45 por omisión) respecto de `base`, y por último **grid**. Con ortho/polar + grid la longitud se redondea al paso. Sin imán: `{ point: cursor, mode: 'none' }`.
- `int` entre cualquier par de línea / poly (tramos rectos y arcos por bulge) / círculo / arco, incluida la tangencia (un punto). `per` y `tan` necesitan `base`. Círculos: sin extremo ni punto medio. Texto: `end` = punto de inserción; cota: `end` en p1/p2.
- `label` ya viene en español ("Extremo", "Punto medio", "Intersección"…); `marker` sugiere el símbolo (`square`, `triangle`, `circle`, `diamond`, `x`, `perp`, `tangent`, `near`, `dot`, `cross`); `guide` = línea de rastreo `[base, punto]` en ortho/polar.
- Rendimiento: pasa `index` (`buildIndex(drawing)`, reconstruir solo cuando cambie el dibujo) con dibujos grandes; sin él, a partir de 2000 entidades se construye uno efímero en cada llamada.

### Selección (`select2d.ts`)

```ts
pickAt(drawing, p, tolerance, { includeLocked?, index? }): string[]     // candidatos, del más cercano al más lejano (empate: el de encima)
cyclePick(candidates, current?): string | null                           // clic repetido: siguiente candidato (da la vuelta)
selectBox(drawing, p1, p2, { mode?: 'auto'|'window'|'crossing', includeLocked?, index? }): { ids, mode }
boxModeOf(p1, p2): 'window' | 'crossing'                                 // izquierda→derecha = ventana; derecha→izquierda = cruce
selectFence(drawing, pts, opts): string[]                                // valla: lo que cruza la polilínea abierta
applySelection(current, hit, shift): string[]                            // sin Mays reemplaza; con Mays alterna
selectAll(drawing, opts): string[]
buildIndex(drawing): SpatialIndex                                         // rejilla; 10 000 entidades: consultas de ~0.3 ms
```

Ventana = entidades completamente dentro; cruce = dentro o tocadas (también por el trazo de arcos con bulge; un cruce que cae dentro de un círculo sin tocar el trazo no lo selecciona; un texto cuenta por su caja).

### Herramientas (`drawingTools.ts`)

```ts
createTool(name, drawing, opts?): Tool     // name ∈ TOOL_NAMES: line polyline rect circle arc text dim move copy rotate scale mirror offset erase trim extend
interface Tool {
  name; done; cancelled; error; selection;
  onPoint(p); onMove(p); onKey(k); onText(s); onSelect(ids, mode?: 'add'|'replace'|'toggle'); cancel();
  preview(): { ghosts: Entity[]; prompt: string; selection: string[]; error: string | null; base: Pt2 | null };
  commit(): DrawOp[];                      // solo si done y no cancelada; una sola vez
}
type DrawOp = { op:'add'; entity: EntityInput } | { op:'update'; id; patch } | { op:'remove'; ids: string[] }
applyOps(drawing, ops): { drawing, ids }   // atómico: usa addEntity / updateEntity / removeEntity; lanza DrawingError si algo falla
```

`ToolOptions`: `layer`, `color`, `selection` (selección previa; se filtran ids inexistentes y de capas bloqueadas/congeladas), `textHeight`, `pickTolerance`. Opciones propias: `circle {mode:'cr'|'cd'|'2p'|'3p'}` (en `cd` la distancia o el número es el diámetro), `arc {mode:'3p'|'cse'}`, `dim {kind:'linear'|'aligned'}`, `copy {once}`, `rotate/scale {copy}`, `offset {distance}`, `text {rot, align}`.

Teclas (`onKey`): `Enter`/`" "` confirma o termina; `Escape` termina conservando lo dibujado en línea/polilínea/copiar/desfasar y cancela en el resto; `Backspace` o `u` deshacen el último punto; letras = opciones del prompt (`c` cerrar, `a`/`l` arco/línea, `d` dimensiones/diámetro, `r` referencia/radio, `h`/`v` cota, `s`/`n` sí/no…). `cancel()` siempre descarta todo.

Entrada escrita (`onText`, y `parseInput(raw, base)`): `x,y` absoluta · `@dx,dy` relativa al punto base · `@d<a` y `d<a` polar (grados, antihorario) · `d` distancia en la dirección del cursor desde el punto base · `<a` fija esa dirección para la próxima distancia · unidades `mm`, `cm`, `m` · decimales con punto. Los errores no lanzan: quedan en `tool.error` / `preview().error`. En texto, el contenido se entrega con `onText` tras el punto de inserción.

Cómo cablearlo en la UI: (1) por cada evento de ratón calcula `snapPoint(...)` con `base = tool.preview().base` y llama `onMove(snap.point)` / `onPoint(snap.point)`; (2) en modo selección llama `pickAt`/`selectBox`/`selectFence` y entrega los ids con `onSelect`; (3) tras cada evento, si `tool.done`, `applyOps(drawing, tool.commit())` (un único paso de deshacer) y crea otra herramienta del mismo tipo; (4) pinta `preview().ghosts` atenuados y `prompt` en la línea de comandos. Las herramientas guardan el `drawing` con el que se crearon: créalas de nuevo si el dibujo cambia.

Límites: polilínea con arcos solo tangentes (sin arco por 2 puntos ni por centro); "desfasar" hereda el límite de `offsetEntity` (sin bulge); `mirror` no espeja el texto (solo lo mueve).

### Recortar y extender (`trimExtend.ts`)

```ts
trimEntity(drawing, targetId, pickPoint, boundaries: string[] | 'todos', { edgeMode?: 'normal' | 'extendido' }): DrawOp[]
extendEntity(drawing, targetId, pickPoint, boundaries, opts): DrawOp[]
diffOps(before, after): DrawOp[]   // operaciones inversas (para «Deshacer» dentro de una herramienta)
```

Funciones puras que devuelven `DrawOp[]` listas para `applyOps` (o lanzan `DrawingError` en español: sin intersección, capa bloqueada o congelada, tipo no válido, borde inexistente…).

- **Objetivos**: línea, arco, círculo y polilínea abierta o cerrada (con bulge). **Bordes**: línea, polilínea, círculo, arco; `'todos'` = todo lo visible (capas activas y no congeladas) salvo el propio objetivo. Si el objetivo está en la lista de bordes se ignora; si es el único, error.
- **Recortar**: quita el tramo que contiene el punto, entre los cortes vecinos; con corte solo de un lado, hasta el extremo. Los cortes en un extremo no cuentan. Una figura cerrada necesita al menos 2 cortes: el círculo pasa a arco (`remove` + `add` con el mismo id) y la polilínea cerrada queda abierta, con el arco partido conservando su curvatura. Una tangencia cuenta como corte.
- **Extender**: elige el extremo más cercano al clic (por longitud recorrida) y lo alarga hasta el primer borde: la línea recta, el arco por su círculo (sin superar una vuelta ni tocar su propio inicio), la polilínea en su primer o último tramo (recto o arco). Círculos y polilíneas cerradas no tienen extremos.
- **Ids**: el trozo conservado mantiene el id (`update`); si el recorte lo parte en dos, el primero (desde el inicio) lo conserva y el segundo es un `add` (id nuevo al aplicar). Capa y color se copian.
- **Bordes extendidos** (`edgeMode: 'extendido'`): las líneas son infinitas, los arcos círculos completos y los extremos de una polilínea abierta se prolongan en recto (los tramos en arco de una polilínea no se prolongan).
- **Herramienta** (`createTool('trim' | 'extend')`, alias TR y EX): «Designe bordes de corte o Enter para todos:» → «Designe objeto a recortar [Deshacer]:» (o «…extender…»), repetitiva hasta Enter/Esc. `onPoint(p, { shift, tol })`: Mayús invierte recortar↔extender y `tol` es la tolerancia de elección en mm; `B` alterna bordes extendidos; `U`/`D`/Retroceso deshacen. Cada clic produce operaciones que se entregan con `tool.drain()` (la interfaz las aplica enseguida, un paso de deshacer por clic); quien no use `drain` recibe todo en `commit()`.
- **MCP**: `trim_entity` y `extend_entity` (ver mcp.md); también por `drawing_execute`.
- **Inserts, sombreados y bloque en edición**: un insert no es objetivo ni borde (mensaje que pide explotarlo). Las herramientas operan sobre `drawings.activeDrawing()`, que en modo edición de bloque es el bloque; la interfaz aplica cada edición con `edit()`, que llama a `syncHatches` (sombreados asociativos) o escribe de vuelta en el bloque.
- Límites: las auto-intersecciones de una polilínea no son borde de sí misma; el círculo recortado pasa al final del orden de apilado (se repone con el mismo id); no se recortan textos ni cotas, ni se usan como bordes.

### Cableado en la interfaz (src/web)

- `drawingTools2d.ts`: un controlador por herramienta (`drawings.registerTool`) sobre `createTool`; en cada evento calcula `snapPoint` (modos conmutables, F8 orto), pinta fantasmas, marcador de imán y la línea de comandos (alias, opciones por letra, entrada numérica) y aplica `tool.commit()` con un solo paso de deshacer (`api.add` si todo son altas, `api.edit(applyOps)` si no). La fase "designar objetos" de las herramientas de edición se detecta por el prompt (`Designe…`). El índice espacial (`buildIndex`) se reconstruye solo cuando cambia el objeto `Drawing`. Recortar/Extender: la fase «Designe objeto a…» elige con el punto crudo (sin imán, `onPoint(p, { shift, tol })`) y después de cada evento se aplica `tool.drain()`.
- `drawingIo.ts`: `drawings.setIoHandlers({ importDxf, exportDxf, exportPdf })` (no hay importar PDF).
- `meshImportDialog.ts`: «Importar 3D». MCP: `server/mcpDrawingIO.ts`.

## Sombreados (`hatch`)

```ts
HatchEntity { type:'hatch', loops: PolyVertex[][], pattern: 'solid'|'lines'|'cross'|'dots'|'ansi31'|'brick'|'concrete'|'wood',
              angle?: grados, scale?: mm (separación, 50 por omisión), color? (líneas), fillColor? (fondo; en solid, el relleno), source?: ids }
```

- `loops`: contornos cerrados (vértices con bulge; un círculo es `[{p:[cx+r,cy],bulge:1},{p:[cx-r,cy],bulge:1}]`). **Par-impar**: un lazo dentro de otro es un hueco, otro dentro del hueco vuelve a rellenar.
- `scale` es la separación de las líneas (en `brick`, la altura de hilada; en `dots` y `concrete`, el paso de la rejilla). `angle` gira el patrón; ansi31 es `lines` a 45° + `angle`. El patrón se ancla al origen del dibujo: dos sombreados contiguos con el mismo patrón se alinean.
- `source`: ids de entidades cerradas (poly cerrada, círculo) que forman TODOS los lazos. Asociatividad simple: si cambian (mover, editar vértices…) sin tocar el sombreado, `syncHatches(antes, después)` recalcula `loops`; si un origen desaparece, el sombreado conserva sus lazos y pierde `source`. La interfaz y el MCP lo aplican tras cada edición.
- Entrada de `addEntity`: `{type:'hatch', loops:[[[x,y]…] | [{p,bulge}…]], pattern?, angle?, scale?, color?, fillColor?, source?}`.
- Núcleo (`src/core/hatch.ts`): `hatchGeometry(h, {tol?, maxSegments?})` → `{polygons, segments, dots, spacing, capped}` (líneas paralelas recortadas por scanline contra los polígonos teselados; tope 60 000 trazos: si se pasa, ensancha la separación y marca `capped`); `findBoundary(drawing, punto)` (parte los tramos en cruces y empalmes, poda cabos, recorre las caras del grafo plano y elige la menor que contiene el punto; las componentes conexas dentro son islas; devuelve `{loops, source?, entityIds}` o null); `loopsFromEntities(d, ids)`; `hatchContains`, `hatchArea`, `hatchPickDistance`, `syncHatches`.
- Selección: se elige por su contorno o, dentro, solo si no hay nada más cerca. No se imanta a sus bordes (usa las entidades de origen).
- Render: SVG de la interfaz y de `render_drawing` (relleno evenodd + trazos finos + puntos), PDF (`f*` + trazos finos), 3D (solo el contorno).
- **DXF**: `solid`, `lines`, `cross` y `ansi31` salen como **HATCH nativo R2000** (nombres SOLID, LINE, NET, ANSI31; lazos como polilíneas con bulge; definición del patrón escrita explícita) y vuelven idénticos con `dxfToDrawing`. `dots`, `brick`, `concrete` y `wood` no tienen equivalente fiel: salen como LINE y POINT sueltos (no vuelven como sombreado). La importación lee HATCH a mano (dxf-parser no lo entrega): lazos de polilínea o de aristas (línea, arco, elipse; splines se omiten con aviso), SOLID, ANSI31, LINE, NET y, para otros nombres, una aproximación con `lines`/`cross` según su primera línea de definición (aviso). Solo se verificó la ida y vuelta con nuestro propio lector.
- Interfaz: herramienta «Sombreado» (H): clic en un punto interior (vista previa del contorno al pasar) o «Objetos»; barra con patrón, ángulo, separación, color y fondo; edición en la tabla (patrón, ángulo, separación, fondo, contornos). MCP: `draw_hatch {drawing, point | entities | loops, pattern, angle, scale, color, fillColor, layer, associative}`.

## Bloques (`Drawing.blocks` + `insert`)

```ts
Block { name, base:[x,y], entities: Entity[] (coordenadas locales, ids únicos dentro del bloque), description? }
InsertEntity { type:'insert', block, p:[x,y], sx?, sy?, rot?, cols?, rows?, dx?, dy?, layer, color? }
```

- Transformación: `mundo = p + R(rot)·S(sx, sy)·(local − base)`; `sx`/`sy` ≠ 0 (negativo = espejo), 1 por omisión. Arreglo `cols × rows` (máx. 10 000 copias): separaciones `dx` (columnas) y `dy` (filas) en el marco girado, sin escalar (igual que DXF).
- Los hijos en la capa `"0"` toman la capa del insert; los que no tienen color propio toman el color del insert si lo tiene (si no, el de su capa). Un insert en una capa apagada o congelada no se dibuja entero.
- Escala no uniforme: círculos y arcos pasan a polilíneas (teselado), una cota pasa a líneas y texto.
- Validación (`validateBlocks`, parte de `validateDrawing`): nombres únicos sin distinguir mayúsculas y sin `< > / \ " : ; ? * | = \``, `base` finita, ids únicos, inserts que referencian bloques existentes, **sin ciclos** y **profundidad máxima 8**.
- `resolveInsert(insert, drawing)` (`src/core/blocks.ts`): entidades transformadas con ids `idInsert/idHijo` (`idInsert#k/…` en arreglos), memoizado; las usan render, PDF, DXF explotado, medición, selección (`pickAt`, `selectBox`), imán (`snapPoint`) y `entityBounds(e, blockCtx(d))`. `flattenEntities` / `flattenDrawing` aplanan.
- Operaciones (`src/core/blockOps.ts`, puras): `createBlock(d, {name, ids, base?, description?, replace?, layer?})` (coordenadas conservadas; con `replace` las sustituye por un insert), `insertBlock`, `explodeInsert` (un nivel; anidados siguen siendo insert cuando la matriz compuesta no tiene sesgo), `editBlock(d, nombre, op)` / `blockDrawing` / `applyBlockDrawing` (el bloque como dibujo: reutiliza todas las operaciones de drawing.ts; **todas las instancias se actualizan** porque se referencian por nombre), `renameBlock` (actualiza inserts, también anidados), `removeBlock(d, nombre, {explode?})` (en uso: error, o con `explode` sus inserts pasan a entidades sueltas), `describeBlock`, `blockUsage`.
- Capas: crear con `replace`, insertar y explotar respetan capas bloqueadas y congeladas (error claro).
- **DXF**: se exportan BLOCK + BLOCK_RECORD + INSERT nativos (escala, giro, arreglos, anidados; los hijos con capa `0` quedan en la capa 0 de DXF, que hereda la del INSERT) y vuelven como `blocks` + `insert`. Importación: `explodeBlocks` (false por omisión) conserva los BLOCK como bloques editables (nombres saneados: los caracteres no válidos pasan a `_`; ByBlock → sin color propio; unidades convertidas); `explodeBlocks: true` da el comportamiento anterior (entidades sueltas). Los bloques anónimos de cotas siempre se expanden. Límite: un color de INSERT solo afecta a los hijos sin color propio de nuestro modelo, mientras que en DXF afecta a los ByBlock.
- Interfaz: herramientas «Crear bloque» (B), «Insertar» (I, vista previa con imán; bloque, escala y giro en la barra), «Explotar» (X); pestaña «Bloques» (miniatura, usos, insertar, editar, renombrar, borrar) y modo «Editar bloque» (el lienzo, la tabla, las capas y las herramientas trabajan sobre el bloque; cada operación actualiza todas las instancias en un paso de deshacer; barra con «Punto base…» y «Terminar edición»).
- MCP: `block_create`, `block_list`, `block_get`, `block_update {add, update, remove, base, description, rename}`, `block_remove {explode}`, `insert_block`, `explode_insert` (`server/mcpHatchBlocks.ts`); `import_dxf` acepta `explodeBlocks`. `drawing_batch` y `query_entities` admiten `hatch` e `insert`.

Pruebas: `src/core/hatch.test.ts`, `src/core/blocks.test.ts`, `server/mcpHatchBlocks.test.ts`.

## Exportar vista con sombreados y bloques

`src/web/exportView.ts` y `src/core/viewShapes.ts` dibujan también `hatch` e `insert`:

- `drawingShapes(d)` resuelve los inserts (`flattenEntities`, solo capas visibles) y convierte cada sombreado en una forma `fill` (relleno par-impar con islas, forma neutra de `viewSheet.ts`) más líneas finas para los trazos del patrón y trazos casi nulos con extremo redondo para los puntos. Sirve para la lámina (SVG/PNG/PDF) y para los PDF de `save_view`.
- El SVG del dibujo 2D (PNG/JPG/SVG) usa `entityShapeSvg(e, estilo, d)` con `restyle` para que los hijos de un insert escalen sus grosores como el resto.
- El PDF vectorial (`drawingToPdf`) ya resolvía bloques y sombreados.
- Para exportar o guardar una vista se usa `drawings.realDrawing()`, nunca `activeDrawing()` (que en edición de bloque devuelve el bloque). «Solo la selección» no está disponible mientras se edita un bloque.
- Resaltado en vivo: `diffDrawings` marca como modificados los inserts de un bloque cuya definición cambió (`DrawingChange.blocks`). En «Editar bloque» el lienzo resalta las entidades de la definición (`blockEntityChanges`, coordenadas locales), no el insert.
- Cambios en vivo y diálogos: `livePaused` (`src/web/livePause.ts`) decide si se pausa la recarga. Los diálogos de `formDialog`/`infoDialog` llevan `data-live="1"` (su contenido vive en su DOM) y no pausan; los demás diálogos sí, y lo pendiente se aplica en cuanto se cierran (evento `close` en captura).
- Recortar/Extender llaman a `tool.sync(ev.drawing)` en cada evento del ratón: ven siempre el dibujo actual (entidades que el agente agregó con la herramienta activa); los bordes designados que ya no existen se descartan.
- En 3D los sombreados se muestran solo por su contorno y los inserts por su geometría resuelta.
