import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultProject } from '../src/core/types';
import { importMeshInto, meshSlim, resolveImportFile } from './mcpMesh';
import { partRow } from './mcpParts';
import { solidsList } from '../src/core/solids';

const CUBE = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nv 0 0 1\nv 1 0 1\nv 1 1 1\nv 0 1 1\nf 1 4 3 2\nf 5 6 7 8\nf 1 2 6 5\nf 2 3 7 6\nf 3 4 8 7\nf 4 1 5 8\n';

test('import_mesh: lee de la carpeta importar, asigna ids, no vuelca vértices y no deja salir de la carpeta', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-mesh-'));
  fs.mkdirSync(path.join(dir, 'importar'));
  fs.writeFileSync(path.join(dir, 'importar', 'caja.obj'), CUBE);
  const project = defaultProject();
  const res = importMeshInto(project, dir, { file: 'caja.obj', unidad: 'cm', ejeArriba: 'z', posicion: [100, 0, 0], nombre: 'Caja' });
  assert.equal(res.agregadas.length, 1);
  const part = project.parts.find((p) => p.id === res.agregadas[0].id)!;
  assert.equal(part.form, 'mesh');
  assert.deepEqual(part.size, [10, 10, 10]);
  assert.deepEqual(part.position, [100, 0, 0]);
  assert.ok(JSON.stringify(partRow(part)).length < 800);
  assert.ok(JSON.stringify(meshSlim(part)).length < 800);
  assert.equal(solidsList(project.parts)[0].form, 'mesh');
  assert.throws(() => resolveImportFile(dir, '../project.json'), /dentro de la carpeta/);
  assert.throws(() => importMeshInto(project, dir, { file: 'nada.obj' }), /No existe/);
  assert.throws(() => importMeshInto(project, dir, {}), /exactamente uno/);
  assert.throws(() => importMeshInto(project, dir, { text: CUBE, material: 'inexistente' }), /Material desconocido/);
  const b64 = importMeshInto(project, dir, { base64: Buffer.from(CUBE).toString('base64'), formato: 'obj', unidad: 'mm' });
  assert.equal(b64.agregadas.length, 1);
  assert.equal(new Set(project.parts.map((p) => p.id)).size, project.parts.length);
});
