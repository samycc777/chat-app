import test from 'node:test';
import assert from 'node:assert/strict';

test('visual preferences start calm, persist and respect live device changes', async () => {
  const values = new Map();
  let blocked = false;
  let changeMotion;
  globalThis.localStorage = {
    getItem(key) { if (blocked) throw new Error('Storage unavailable'); return values.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error('Storage unavailable'); values.set(key, value); },
  };
  globalThis.window = {
    matchMedia: () => ({ matches: false, addEventListener: (_event, callback) => { changeMotion = callback; } }),
  };
  // Vue detects a browser when a document exists; this supplies the element factory it probes.
  globalThis.document = { documentElement: { dataset: {} }, createElement: () => ({}) };
  const prefs = await import('../client/src/visualComfort.ts');

  assert.equal(prefs.calm.value, true, 'first visit needs no device setting');
  assert.equal(document.documentElement.dataset.calm, 'true');
  prefs.reduceEffects.value = false;
  assert.equal(prefs.calm.value, false);
  assert.equal(values.get('reduceVisualEffects'), '0');
  changeMotion({ matches: true });
  assert.equal(prefs.calm.value, true, 'device preference overrides the stored opt-out');
  assert.equal(document.documentElement.dataset.calm, 'true');
  changeMotion({ matches: false });
  assert.equal(prefs.calm.value, false);

  const reloaded = await import('../client/src/visualComfort.ts?reload');
  assert.equal(reloaded.reduceEffects.value, false);

  blocked = true;
  assert.doesNotThrow(() => { prefs.reduceEffects.value = true; });
  assert.equal(prefs.calm.value, true);
  const privateVisit = await import('../client/src/visualComfort.ts?private');
  assert.equal(privateVisit.calm.value, true, 'unavailable storage defaults to calm');
});
