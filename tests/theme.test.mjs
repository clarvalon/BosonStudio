import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/theme.js', import.meta.url), 'utf8');
function themeEnvironment(saved, initiallyDark = false, storageAvailable = true) {
  let listener; let stored = saved; let themeColor;
  const media = { matches: initiallyDark, addEventListener: (_, callback) => { listener = callback; } };
  const document = { documentElement: { dataset: {}, style: {} }, querySelector: () => ({ setAttribute: (_, value) => { themeColor = value; } }) };
  const window = { matchMedia: () => media };
  const localStorage = { getItem: () => { if (!storageAvailable) throw new Error('blocked'); return stored; }, setItem: (_, value) => { if (!storageAvailable) throw new Error('blocked'); stored = value; } };
  vm.runInNewContext(source, { window, document, localStorage });
  return { theme: window.BosonTheme, document, stored: () => stored, color: () => themeColor, changeSystem: dark => { media.matches = dark; listener(); } };
}

test('system appearance is applied before rendering and tracks OS changes', () => {
  const env = themeEnvironment(null, true);
  assert.equal(env.theme.getPreference(), 'system');
  assert.equal(env.document.documentElement.dataset.theme, 'dark');
  assert.equal(env.document.documentElement.style.colorScheme, 'dark');
  env.changeSystem(false);
  assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(env.color(), '#f7f6f2');
});

test('explicit appearance persists, ignores OS changes, and can return to system', () => {
  const env = themeEnvironment('light', true);
  assert.equal(env.theme.getEffective(), 'light');
  env.theme.setPreference('dark');
  assert.equal(env.stored(), 'dark');
  env.changeSystem(false);
  assert.equal(env.document.documentElement.dataset.theme, 'dark');
  env.theme.setPreference('system');
  assert.equal(env.document.documentElement.dataset.theme, 'light');
  assert.equal(themeEnvironment(env.stored(), true).theme.getEffective(), 'dark');
});

test('appearance remains usable when browser storage is unavailable', () => {
  const env = themeEnvironment(null, false, false);
  env.theme.setPreference('dark');
  assert.equal(env.document.documentElement.dataset.theme, 'dark');
  assert.equal(themeEnvironment('invalid', true).theme.getPreference(), 'system');
});
