import assert from 'node:assert/strict';
import test from 'node:test';

await import('../public/config-state.js');

function makeStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    }
  };
}

test('writeConfig stores the last manual restore configuration snapshot', () => {
  const storage = makeStorage();

  const saved = globalThis.XhsConfigState.writeConfig({
    visualMode: 'comparison',
    comparisonStyleIds: ['student-grid', 'major-rows'],
    noteTitle: '预算6K左右',
    noteBody: '产品参数正文',
    topicDirection: '重点参数红色突出',
    batchCount: 5,
    size: '1024x1536',
    concurrency: 5,
    futureProductionRules: '后续统一规则'
  }, storage);
  const restored = globalThis.XhsConfigState.readConfig(storage);

  assert.equal(saved.visualMode, 'comparison');
  assert.deepEqual(restored.comparisonStyleIds, ['student-grid', 'major-rows']);
  assert.equal(restored.noteTitle, '预算6K左右');
  assert.equal(restored.batchCount, '5');
  assert.equal(restored.concurrency, '5');
  assert.equal(restored.futureProductionRules, '后续统一规则');
});

test('buildConfigSnapshot preserves a legacy single comparison style id as an array', () => {
  const snapshot = globalThis.XhsConfigState.buildConfigSnapshot({
    comparisonStyleId: 'student-grid'
  });

  assert.deepEqual(snapshot.comparisonStyleIds, ['student-grid']);
});

test('readConfig ignores malformed saved configuration', () => {
  const storage = makeStorage();
  storage.setItem(globalThis.XhsConfigState.storageKey, '{bad json');

  assert.equal(globalThis.XhsConfigState.readConfig(storage), null);
});
