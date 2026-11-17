import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConflictError, KEEP_BACKUPS, createStore } from './store';
import { defaultProject } from '../src/core/types';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mueblecad-test-'));

test('escritura: atómica, con respaldo del estado previo y sin tocar las copias manuales .bak', () => {
  const dir = tmp();
  try {
    const s = createStore(dir);
    fs.writeFileSync(path.join(dir, 'project.json.bak2'), 'copia manual del usuario');
    const p = s.readProject().project; // crea el proyecto vacío
    p.name = 'Uno';
    s.writeProject(p);
    p.name = 'Dos';
    s.writeProject(p);
    assert.equal(JSON.parse(fs.readFileSync(s.projectFile, 'utf8')).name, 'Dos');
    const names = fs.readdirSync(s.backupDir);
    assert.ok(names.some((n) => n.startsWith('sesion-')), 'copia de inicio de sesión');
    const sesion = names.find((n) => n.startsWith('sesion-'))!;
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.backupDir, sesion), 'utf8')).name, defaultProject().name);
    assert.equal(fs.readFileSync(path.join(dir, 'project.json.bak2'), 'utf8'), 'copia manual del usuario');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp-')), [], 'sin temporales');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rotación: se conservan las últimas N copias (y la de sesión)', () => {
  const dir = tmp();
  try {
    const s = createStore(dir);
    s.readProject();
    // fabrica copias antiguas para saltar el intervalo mínimo entre copias
    fs.mkdirSync(s.backupDir, { recursive: true });
    for (let i = 0; i < KEEP_BACKUPS + 5; i++) {
      const n = `project-20200101-0000000${String(i).padStart(2, '0')}.json`;
      fs.writeFileSync(path.join(s.backupDir, n), '{}');
      fs.utimesSync(path.join(s.backupDir, n), new Date(2020, 0, 1), new Date(2020, 0, 1));
    }
    s.writeProject(s.readProject().project);
    const projectBackups = fs.readdirSync(s.backupDir).filter((n) => n.startsWith('project-'));
    assert.equal(projectBackups.length, KEEP_BACKUPS);
    assert.equal(s.listBackups().length, KEEP_BACKUPS + 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('updateProject: si fn lanza no escribe; si el archivo cambia a mitad, reintenta; si sigue cambiando, avisa', () => {
  const dir = tmp();
  try {
    const s = createStore(dir);
    s.readProject();
    const before = fs.readFileSync(s.projectFile, 'utf8');
    assert.throws(() => s.updateProject(() => { throw new Error('no vale'); }), /no vale/);
    assert.equal(fs.readFileSync(s.projectFile, 'utf8'), before);

    let calls = 0;
    const n = s.updateProject((p) => {
      if (calls++ === 0) { // otra sesión (la app) guarda mientras tanto
        const other = JSON.parse(before); other.name = 'de la app';
        fs.writeFileSync(s.projectFile, JSON.stringify(other));
        fs.utimesSync(s.projectFile, new Date(), new Date(Date.now() + 5000));
      }
      p.kerf = 7;
      return calls;
    });
    assert.equal(n, 2);
    const saved = JSON.parse(fs.readFileSync(s.projectFile, 'utf8'));
    assert.equal(saved.name, 'de la app', 'se conserva lo que guardó la app');
    assert.equal(saved.kerf, 7);

    let k = 0;
    assert.throws(() => s.updateProject(() => { fs.utimesSync(s.projectFile, new Date(), new Date(Date.now() + 10_000 + 1000 * k++)); }), ConflictError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('project.json dañado: error claro y no se modifica', () => {
  const dir = tmp();
  try {
    const s = createStore(dir);
    fs.writeFileSync(s.projectFile, '{ roto');
    assert.throws(() => s.readProject(), /no es un JSON válido.*restore_backup/);
    assert.throws(() => s.updateProject(() => 1), /no es un JSON válido/);
    assert.equal(fs.readFileSync(s.projectFile, 'utf8'), '{ roto');
    fs.writeFileSync(s.projectFile, '{"name":"x"}');
    assert.throws(() => s.readProject(), /forma de un proyecto/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restore_backup: solo nombres de la lista, guarda el estado actual y exige JSON válido', () => {
  const dir = tmp();
  try {
    const s = createStore(dir);
    const p = s.readProject().project;
    p.name = 'Antes';
    s.writeProject(p);
    p.name = 'Después';
    s.writeProject(p);
    const sesion = s.listBackups().find((b) => b.name.startsWith('sesion-'))!;
    for (const mal of ['../project.json', 'project.json', 'sesion-1.json', 'catalogo-20200101-000000000.json', 'C:\\x\\sesion-20200101-000000000.json']) {
      assert.throws(() => s.restoreBackup(mal), /no válido/, mal);
    }
    assert.throws(() => s.restoreBackup('sesion-20200101-000000000.json'), /No existe/);
    assert.match(s.restoreBackup(sesion.name), /Restaurada/);
    assert.equal(JSON.parse(fs.readFileSync(s.projectFile, 'utf8')).name, defaultProject().name);
    assert.ok(s.listBackups().length >= 2, 'el estado previo a restaurar quedó guardado');
    fs.writeFileSync(path.join(s.backupDir, 'project-20200101-000000001.json'), 'no json');
    assert.throws(() => s.restoreBackup('project-20200101-000000001.json'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('actividad del agente: se registra en actividad.json y conserva solo las ultimas 40', () => {
  const dir = tmp();
  try {
    const s = createStore(dir);
    assert.deepEqual(s.readActivity(), []);
    for (let i = 0; i < 45; i++) s.logActivity({ tool: `t${i}`, mode: 'write', ok: true, message: `m${i}` });
    const a = s.readActivity();
    assert.equal(a.length, 40);
    assert.equal(a[0].tool, 't5');
    assert.equal(a.at(-1)!.tool, 't44');
    assert.ok(a.at(-1)!.t > 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
