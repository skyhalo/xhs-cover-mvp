import assert from 'node:assert/strict';
import test from 'node:test';

await import('../public/upload-utils.js');

test('mergeSourceSelection appends new image files without replacing existing selection', () => {
  const existingFiles = [{ name: 'a.png' }, { name: 'b.png' }];
  const existingPreviews = ['blob:a', 'blob:b'];
  const selectedFiles = [{ name: 'c.png' }];

  const result = globalThis.XhsUploadUtils.mergeSourceSelection(
    existingFiles,
    existingPreviews,
    selectedFiles,
    (file) => `blob:${file.name}`
  );

  assert.deepEqual(result.files.map((file) => file.name), ['a.png', 'b.png', 'c.png']);
  assert.deepEqual(result.previews, ['blob:a', 'blob:b', 'blob:c.png']);
});

test('mergeSourceSelection keeps existing files when no new images are selected', () => {
  const result = globalThis.XhsUploadUtils.mergeSourceSelection(
    [{ name: 'a.png' }],
    ['blob:a'],
    [],
    (file) => `blob:${file.name}`
  );

  assert.deepEqual(result.files.map((file) => file.name), ['a.png']);
  assert.deepEqual(result.previews, ['blob:a']);
});
