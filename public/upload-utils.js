(function attachUploadUtils(global) {
  function mergeSourceSelection(currentFiles, currentPreviews, selectedFiles, createPreviewUrl) {
    const previousFiles = Array.from(currentFiles || []);
    const previousPreviews = Array.from(currentPreviews || []);
    const incomingFiles = Array.from(selectedFiles || []);
    const makePreview = typeof createPreviewUrl === 'function' ? createPreviewUrl : () => '';
    return {
      files: [...previousFiles, ...incomingFiles],
      previews: [...previousPreviews, ...incomingFiles.map((file) => makePreview(file))]
    };
  }

  global.XhsUploadUtils = {
    mergeSourceSelection
  };
})(globalThis);
