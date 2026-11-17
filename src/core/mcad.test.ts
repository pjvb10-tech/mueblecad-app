import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProject } from './types';
import { MCAD_VERSION, McadError, mcadFileName, migrateProject, parseMcad, serializeMcad } from './mcad';

test('mcad: ida y vuelta conserva el proyecto y lleva envoltorio versionado', () => {
  const p = { ...defaultProject(), name: 'Cocina ñandú' };
  const text = serializeMcad(p);
  const env = JSON.parse(text);
  assert.equal(env.formato, 'mcad');
  assert.equal(env.version, MCAD_VERSION);
  assert.deepEqual(parseMcad(text), p);
});

test('mcad: acepta el JSON plano antiguo y con BOM', () => {
  const p = defaultProject();
  assert.deepEqual(parseMcad(JSON.stringify(p)), p);
  assert.deepEqual(parseMcad('﻿' + JSON.stringify(p)), p);
});

test('mcad: rechaza basura, versiones futuras y proyectos incompletos', () => {
  assert.throws(() => parseMcad('no json'), /JSON válido/);
  assert.throws(() => parseMcad('[]'), /no es un proyecto/);
  assert.throws(() => parseMcad('{"a":1}'), /no es un proyecto/);
  assert.throws(() => parseMcad(JSON.stringify({ formato: 'mcad', version: 99, project: defaultProject() })), /más nueva/);
  assert.throws(() => parseMcad(JSON.stringify({ formato: 'mcad', version: 0, project: defaultProject() })), /Versión/);
  assert.throws(() => parseMcad(JSON.stringify({ formato: 'mcad', version: 1 })), /no contiene/);
  assert.throws(() => parseMcad(JSON.stringify({ formato: 'mcad', version: 1, project: { name: 'x' } })), /no es un proyecto/);
});

test('mcad: las migraciones se aplican en cadena y fallan si falta un paso', () => {
  const table = {
    1: (p: Record<string, unknown>) => ({ ...p, pasos: [...((p.pasos as string[]) ?? []), '1a2'] }),
    2: (p: Record<string, unknown>) => ({ ...p, pasos: [...((p.pasos as string[]) ?? []), '2a3'] }),
  };
  assert.deepEqual(migrateProject({ name: 'x' }, 1, 3, table).pasos, ['1a2', '2a3']);
  assert.deepEqual(migrateProject({ name: 'x' }, 2, 3, table).pasos, ['2a3']);
  assert.throws(() => migrateProject({}, 3, 5, table), McadError);
});

test('mcad: nombre de archivo seguro', () => {
  assert.equal(mcadFileName('Casa: A/B'), 'Casa_ A_B.mcad');
  assert.equal(mcadFileName('   '), 'proyecto.mcad');
});
