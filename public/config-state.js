(function attachConfigState(global) {
  const storageKey = 'xhs-cover:last-config:v1';

  function toStringValue(value) {
    return String(value ?? '').trim();
  }

  function toStringArray(value) {
    const source = Array.isArray(value)
      ? value
      : toStringValue(value).split(/[,\n，、/|]+/);
    return Array.from(new Set(source.map(toStringValue).filter(Boolean)));
  }

  function buildConfigSnapshot(values = {}) {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      visualMode: toStringValue(values.visualMode),
      comparisonStyleIds: toStringArray(values.comparisonStyleIds || values.comparisonStyleId),
      noteTitle: toStringValue(values.noteTitle),
      noteBody: toStringValue(values.noteBody),
      topicDirection: toStringValue(values.topicDirection),
      batchCount: toStringValue(values.batchCount),
      size: toStringValue(values.size),
      concurrency: toStringValue(values.concurrency),
      futureProductionRules: toStringValue(values.futureProductionRules)
    };
  }

  function readConfig(storage = global.localStorage) {
    if (!storage) return null;
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.version === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeConfig(values, storage = global.localStorage) {
    if (!storage) return null;
    const snapshot = buildConfigSnapshot(values);
    storage.setItem(storageKey, JSON.stringify(snapshot));
    return snapshot;
  }

  global.XhsConfigState = {
    storageKey,
    buildConfigSnapshot,
    readConfig,
    writeConfig
  };
})(globalThis);
