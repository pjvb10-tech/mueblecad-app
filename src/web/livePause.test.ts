import test from 'node:test';
import assert from 'node:assert/strict';
import { livePaused } from './livePause';

test('sin diálogos ni foco en un campo no se pausa', () => {
  assert.equal(livePaused({ dialogs: [], focus: 'other' }), false);
  assert.equal(livePaused({ dialogs: [], focus: 'cmd' }), false);
});
test('un campo con foco pausa; la línea de comandos 2D no', () => {
  assert.equal(livePaused({ dialogs: [], focus: 'field' }), true);
});
test('un diálogo modal ajeno al proyecto no pausa, ni su campo con foco', () => {
  assert.equal(livePaused({ dialogs: [{ live: true }], focus: 'field', inLiveDialog: true }), false);
  assert.equal(livePaused({ dialogs: [{ live: true }], focus: 'other' }), false);
});
test('un diálogo que edita datos del proyecto pausa (se aplica al cerrarlo)', () => {
  assert.equal(livePaused({ dialogs: [{ live: false }], focus: 'other' }), true);
  assert.equal(livePaused({ dialogs: [{ live: true }, { live: false }], focus: 'cmd' }), true);
});
