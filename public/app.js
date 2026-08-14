const imageInput = document.querySelector('#imageInput');
const folderInput = document.querySelector('#folderInput');
const imageInputSummary = document.querySelector('#imageInputSummary');
const uploadZone = document.querySelector('#uploadZone');
const sourceOrderList = document.querySelector('#sourceOrderList');
const pickImagesBtn = document.querySelector('#pickImagesBtn');
const pickFolderBtn = document.querySelector('#pickFolderBtn');
const previewImage = document.querySelector('#previewImage');
const emptyPreview = document.querySelector('#emptyPreview');
const loadingOverlay = document.querySelector('#loadingOverlay');
const loadingTitle = document.querySelector('#loadingTitle');
const loadingText = document.querySelector('#loadingText');
const stopGenerationBtn = document.querySelector('#stopGenerationBtn');
const restoreConfigBtn = document.querySelector('#restoreConfigBtn');
const promptBtn = document.querySelector('#promptBtn');
const generateBtn = document.querySelector('#generateBtn');
const batchGenerateBtn = document.querySelector('#batchGenerateBtn');
const revisionPromptBtn = document.querySelector('#revisionPromptBtn');
const regenerateCurrentBtn = document.querySelector('#regenerateCurrentBtn');
const applyFutureBtn = document.querySelector('#applyFutureBtn');
const clearFutureRulesBtn = document.querySelector('#clearFutureRulesBtn');
const refreshUsageBtn = document.querySelector('#refreshUsageBtn');
const copyPromptBtn = document.querySelector('#copyPromptBtn');
const copyBatchPromptBtn = document.querySelector('#copyBatchPromptBtn');
const promptOutput = document.querySelector('#promptOutput');
const message = document.querySelector('#message');
const downloadLink = document.querySelector('#downloadLink');
const downloadAllBtn = document.querySelector('#downloadAllBtn');
const downloadHistoryBtn = document.querySelector('#downloadHistoryBtn');
const batchList = document.querySelector('#batchList');
const futureRules = document.querySelector('#futureRules');
const queueSummary = document.querySelector('#queueSummary');
const usageLog = document.querySelector('#usageLog');
const styleTemplateInput = document.querySelector('#styleTemplateInput');
const styleTemplateName = document.querySelector('#styleTemplateName');
const styleTemplateNotes = document.querySelector('#styleTemplateNotes');
const pickStyleTemplateBtn = document.querySelector('#pickStyleTemplateBtn');
const analyzeStyleTemplateBtn = document.querySelector('#analyzeStyleTemplateBtn');
const extractImageCopyBtn = document.querySelector('#extractImageCopyBtn');
const extractImageCopyInput = document.querySelector('#extractImageCopyInput');
const styleTemplateSummary = document.querySelector('#styleTemplateSummary');
const styleTemplatePreview = document.querySelector('#styleTemplatePreview');

let batchItems = [];
let batchPlanningPrompt = '';
let selectedBatchIndex = 0;
let currentResultUrl = '';
let futureProductionRules = '';
let imageAnalysis = null;
let sourceFiles = [];
let sourcePreviews = [];
let styleTemplates = [];
let selectedStyleTemplate = null;
let comparisonStyles = [];
let selectedComparisonStyleIds = [];
let stopGenerationRequested = false;
let activeGenerationControllers = new Set();
let isRestoringConfig = false;
let pendingRestoreVisualMode = '';

const fields = {
  noteTitle: document.querySelector('#noteTitle'),
  noteBody: document.querySelector('#noteBody'),
  topicDirection: document.querySelector('#topicDirection'),
  batchCount: document.querySelector('#batchCount'),
  size: document.querySelector('#size'),
  visualMode: document.querySelector('#visualMode'),
  concurrency: document.querySelector('#concurrency'),
  revisionFeedback: document.querySelector('#revisionFeedback')
};

function getSelectedRatioLabel() {
  const selected = fields.size.options[fields.size.selectedIndex];
  return selected?.dataset?.ratio || selected?.textContent || '3:4 小红书竖图';
}

function isPosterMode() {
  return fields.visualMode.value === 'poster';
}

function isComparisonMode() {
  return fields.visualMode.value === 'comparison';
}

function isReviewMode() {
  return fields.visualMode.value === 'review';
}

function isProductLayoutMode() {
  return isComparisonMode() || isReviewMode();
}

function getVisibleProductStyles() {
  const category = isReviewMode() ? 'review' : 'comparison';
  return comparisonStyles.filter((style) => (style.category || 'comparison') === category);
}

function isTemplateMode() {
  return fields.visualMode.value.startsWith('template:');
}

function getSelectedStyleTemplateId() {
  return isTemplateMode() ? fields.visualMode.value.replace(/^template:/, '') : '';
}

function ensureTemplateSelection() {
  if (isTemplateMode() || isPosterMode() || isProductLayoutMode() || !styleTemplates.length) return;
  fields.visualMode.value = `template:${styleTemplates[0].id}`;
  selectedStyleTemplate = styleTemplates[0];
}

function getPayload() {
  ensureTemplateSelection();
  return {
    noteTitle: fields.noteTitle.value.trim(),
    noteBody: fields.noteBody.value.trim(),
    topicDirection: fields.topicDirection.value.trim(),
    huaziText: '',
    count: fields.batchCount.value,
    topic: fields.noteTitle.value.trim(),
    size: fields.size.value,
    visualMode: fields.visualMode.value,
    styleTemplateId: getSelectedStyleTemplateId(),
    comparisonStyleIds: selectedComparisonStyleIds,
    concurrency: fields.concurrency.value,
    quality: 'medium',
    style: selectedStyleTemplate
      ? `小红书爆款封面模版：${selectedStyleTemplate.name}。迁移参考图的构图、字体层级、配色和视觉元素，但不照搬具体素材。`
      : fields.visualMode.value === 'review'
      ? '小红书产品点评横评封面，每款产品使用一段完整自然语言点评，左图右文，不做参数罗列'
      : fields.visualMode.value === 'comparison'
      ? '小红书参数对比表封面，蓝白表格，产品图和参数本地精确排版，不改写参数'
      : fields.visualMode.value === 'poster'
      ? '小红书大字报卡片封面，纸感/手账/纯色引号模板，大字号中文排版，关键词克制高亮'
      : fields.visualMode.value === 'atmosphere'
      ? '小红书家庭生活方式封面，基于原图做自然氛围改造，真实照片质感，轻智能家居感，花字干净醒目但不做成广告海报'
      : '小红书家庭生活方式封面，保留真实照片质感，轻智能家居感，花字干净醒目但不做成广告海报',
    optimizedRules: futureProductionRules,
    aspectRatio: getSelectedRatioLabel(),
    imageAnalysis,
    styleTemplate: selectedStyleTemplate
  };
}

function setMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
}

function getCurrentConfigValues() {
  return {
    visualMode: fields.visualMode.value,
    comparisonStyleIds: selectedComparisonStyleIds,
    noteTitle: fields.noteTitle.value,
    noteBody: fields.noteBody.value,
    topicDirection: fields.topicDirection.value,
    batchCount: fields.batchCount.value,
    size: fields.size.value,
    concurrency: fields.concurrency.value,
    futureProductionRules
  };
}

function updateRestoreConfigButton() {
  if (!restoreConfigBtn) return;
  const saved = window.XhsConfigState.readConfig();
  restoreConfigBtn.disabled = !saved;
  restoreConfigBtn.title = saved?.savedAt
    ? `上次保存：${new Date(saved.savedAt).toLocaleString('zh-CN')}`
    : '暂无可恢复配置';
}

function saveLastConfig() {
  if (isRestoringConfig) return;
  window.XhsConfigState.writeConfig(getCurrentConfigValues());
  updateRestoreConfigButton();
}

function optionExists(select, value) {
  return Array.from(select.options || []).some((option) => option.value === value);
}

function applyVisualModeValue(value) {
  if (!value) return false;
  if (!optionExists(fields.visualMode, value)) {
    pendingRestoreVisualMode = value;
    return false;
  }
  fields.visualMode.value = value;
  pendingRestoreVisualMode = '';
  selectedStyleTemplate = styleTemplates.find((template) => template.id === getSelectedStyleTemplateId()) || null;
  return true;
}

function applyPendingRestoredVisualMode() {
  if (!pendingRestoreVisualMode) return;
  if (applyVisualModeValue(pendingRestoreVisualMode)) {
    renderStyleTemplatePreview();
    syncVisualModeUi();
  }
}

async function restoreLastConfig() {
  const saved = window.XhsConfigState.readConfig();
  if (!saved) {
    setMessage('还没有可恢复的上次配置。', true);
    updateRestoreConfigButton();
    return;
  }
  isRestoringConfig = true;
  try {
    applyVisualModeValue(saved.visualMode);
    selectedComparisonStyleIds = Array.isArray(saved.comparisonStyleIds)
      ? saved.comparisonStyleIds
      : (saved.comparisonStyleId ? [saved.comparisonStyleId] : []);
    fields.noteTitle.value = saved.noteTitle || '';
    fields.noteBody.value = saved.noteBody || '';
    fields.topicDirection.value = saved.topicDirection || '';
    fields.batchCount.value = saved.batchCount || fields.batchCount.value;
    if (saved.size && optionExists(fields.size, saved.size)) fields.size.value = saved.size;
    if (saved.concurrency && optionExists(fields.concurrency, saved.concurrency)) fields.concurrency.value = saved.concurrency;
    futureProductionRules = saved.futureProductionRules || '';
    batchItems = [];
    selectedBatchIndex = 0;
    currentResultUrl = '';
    imageAnalysis = null;
    renderStyleTemplatePreview();
    syncVisualModeUi();
    renderFutureRules();
    renderBatchList();
    downloadLink.hidden = true;
    setMessage('已恢复上次配置。图片需要重新选择，内容队列需要重新生成。');
    await generatePrompt().catch(() => {});
  } finally {
    isRestoringConfig = false;
  }
}

function setLoading(isLoading, title = '生成中', text = '正在提交任务，请稍等。', options = {}) {
  loadingTitle.textContent = title;
  loadingText.textContent = text;
  loadingOverlay.hidden = !isLoading;
  if (stopGenerationBtn) {
    stopGenerationBtn.hidden = !isLoading || !options.canStop;
    if (isLoading && options.canStop && !stopGenerationRequested) {
      stopGenerationBtn.disabled = false;
      stopGenerationBtn.textContent = '停止生成';
    }
  }
}

function makeAbortError() {
  const error = new Error('已停止生成');
  error.name = 'AbortError';
  return error;
}

function isGenerationStopError(error) {
  return stopGenerationRequested || error?.name === 'AbortError';
}

async function fetchGeneration(url, options = {}) {
  if (stopGenerationRequested) throw makeAbortError();
  const controller = new AbortController();
  activeGenerationControllers.add(controller);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    activeGenerationControllers.delete(controller);
  }
}

function requestGenerationStop() {
  stopGenerationRequested = true;
  for (const controller of activeGenerationControllers) {
    controller.abort();
  }
}

function markRunningItemsStopped() {
  batchItems = batchItems.map((item) => item.status === 'running'
    ? { ...item, status: 'pending', error: '已停止，可重新生成。' }
    : item
  );
  renderBatchList();
}

function getReadableError(error, fallback = '操作失败') {
  const message = error?.message || '';
  if (isGenerationStopError(error)) {
    return '已停止生成，可以调整参数后重新试做。';
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return '本地服务断开了，请刷新页面；如果还不行，需要重新启动本地服务。';
  }
  return message || fallback;
}

function getImageFiles(fileList) {
  return Array.from(fileList || []).filter((file) => /^image\/(png|jpe?g|webp)$/i.test(file.type));
}

function getSourceName(file) {
  return file?.webkitRelativePath || file?.name || '原图';
}

function assignSourceToBatchItems(items, files = sourceFiles) {
  if (!files.length) return items;
  return items.map((item, index) => ({
    ...item,
    sourceIndex: item.sourceIndex ?? (index % files.length),
    sourceName: item.sourceName || getSourceName(files[index % files.length])
  }));
}

function getCurrentSourceFile() {
  const item = batchItems[selectedBatchIndex];
  const index = Number.isInteger(item?.sourceIndex) ? item.sourceIndex : 0;
  return sourceFiles[index] || sourceFiles[0];
}

function refreshSourceAssignments() {
  batchItems = batchItems.map((item, index) => {
    const nextIndex = sourceFiles.length ? Math.min(index % sourceFiles.length, sourceFiles.length - 1) : 0;
    return {
      ...item,
      sourceIndex: nextIndex,
      sourceName: sourceFiles[nextIndex] ? getSourceName(sourceFiles[nextIndex]) : item.sourceName
    };
  });
}

function renderSourceOrderList() {
  if (!sourceOrderList) return;
  if (!sourceFiles.length) {
    sourceOrderList.innerHTML = '';
    return;
  }
  sourceOrderList.innerHTML = sourceFiles.map((file, index) => `
    <article class="source-card" data-index="${index}">
      <img src="${sourcePreviews[index] || ''}" alt="第 ${index + 1} 张原图预览" />
      <strong>第 ${index + 1} 张</strong>
      <span title="${escapeHtml(getSourceName(file))}">${escapeHtml(getSourceName(file))}</span>
      <div class="source-card-actions">
        <button class="ghost source-move-up" type="button" data-index="${index}" ${index === 0 ? 'disabled' : ''}>上移</button>
        <button class="ghost source-move-down" type="button" data-index="${index}" ${index === sourceFiles.length - 1 ? 'disabled' : ''}>下移</button>
        <button class="ghost source-remove" type="button" data-index="${index}">删除</button>
      </div>
    </article>
  `).join('');
}

function syncSourcePreviewAfterOrderChange() {
  if (!sourceFiles.length) {
    previewImage.removeAttribute('src');
    previewImage.style.display = 'none';
    emptyPreview.style.display = 'grid';
    imageInputSummary.textContent = '还没有选择原图。';
    renderSourceOrderList();
    renderBatchList();
    return;
  }
  previewImage.src = sourcePreviews[0];
  previewImage.style.display = 'block';
  emptyPreview.style.display = 'none';
  imageInputSummary.textContent = isProductLayoutMode()
    ? `已选择 ${sourceFiles.length} 张产品图，系统会严格按上方顺序对应产品信息。`
    : `已选择 ${sourceFiles.length} 张原图，批量时会按上方顺序自动分配。`;
  refreshSourceAssignments();
  renderSourceOrderList();
  renderBatchList();
}

function moveSourceFile(fromIndex, toIndex) {
  if (!sourceFiles[fromIndex] || toIndex < 0 || toIndex >= sourceFiles.length) return;
  const [file] = sourceFiles.splice(fromIndex, 1);
  const [preview] = sourcePreviews.splice(fromIndex, 1);
  sourceFiles.splice(toIndex, 0, file);
  sourcePreviews.splice(toIndex, 0, preview);
  imageAnalysis = null;
  currentResultUrl = '';
  syncSourcePreviewAfterOrderChange();
  setMessage('图片顺序已更新，后续生成会按界面顺序提交。');
}

function removeSourceFile(index) {
  if (!sourceFiles[index]) return;
  const [preview] = sourcePreviews.splice(index, 1);
  if (preview) URL.revokeObjectURL(preview);
  sourceFiles.splice(index, 1);
  imageAnalysis = null;
  currentResultUrl = '';
  syncSourcePreviewAfterOrderChange();
  setMessage(sourceFiles.length ? '已删除图片，顺序已更新。' : '已清空上传图片。');
}

async function analyzeCurrentImage({ silent = false } = {}) {
  if (isPosterMode() || isProductLayoutMode()) {
    imageAnalysis = null;
    return null;
  }
  const file = sourceFiles[0];
  if (!file) {
    throw new Error('请先上传一张封面原图。');
  }
  if (!silent) setMessage('正在分析原图...');
  const form = new FormData();
  const payload = getPayload();
  form.append('image', file);
  form.append('noteTitle', payload.noteTitle);
  form.append('noteBody', payload.noteBody);
  form.append('topicDirection', payload.topicDirection);
  form.append('visualMode', payload.visualMode);
  form.append('styleTemplateId', payload.styleTemplateId);
  const response = await fetch('/api/analyze-image', {
    method: 'POST',
    body: form
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || '分析原图失败');
  }
  imageAnalysis = data.analysis || null;
  await refreshUsageLog(data.usageLog);
  if (!silent) setMessage('原图分析完成。生成内容队列会基于这份分析规划画面。');
  return imageAnalysis;
}

function formatUsageEntry(entry) {
  if (!entry) return '还没有生成记录。';
  if (entry.type === 'text-batch-plan') {
    const usage = entry.usage || {};
    return `内容队列：${entry.model || '-'}，${entry.count || 0} 条；输入 ${usage.promptTokens ?? 0} tokens，输出 ${usage.completionTokens ?? 0} tokens，总计 ${usage.totalTokens ?? 0} tokens。`;
  }
  if (entry.type === 'text-rewrite-item') {
    const usage = entry.usage || {};
    return `单条重写：${entry.model || '-'}；输入 ${usage.promptTokens ?? 0} tokens，输出 ${usage.completionTokens ?? 0} tokens，总计 ${usage.totalTokens ?? 0} tokens。`;
  }
  if (entry.type === 'text-comparison-plan') {
    const usage = entry.usage || {};
    return `参数表整理：${entry.model || '-'}，产品 ${entry.count || 0} 个；输入 ${usage.promptTokens ?? 0} tokens，输出 ${usage.completionTokens ?? 0} tokens，总计 ${usage.totalTokens ?? 0} tokens。`;
  }
  if (entry.type === 'image-analysis') {
    const usage = entry.usage || {};
    return `原图分析：${entry.model || '-'}；输入 ${usage.promptTokens ?? 0} tokens，输出 ${usage.completionTokens ?? 0} tokens，总计 ${usage.totalTokens ?? 0} tokens。`;
  }
  if (entry.type === 'image-copy-extract') {
    const usage = entry.usage || {};
    return `图片提取正文：${entry.model || '-'}，图片 ${entry.count || 0} 张；输入 ${usage.promptTokens ?? 0} tokens，输出 ${usage.completionTokens ?? 0} tokens，总计 ${usage.totalTokens ?? 0} tokens。`;
  }
  if (entry.type === 'style-template-analysis') {
    const usage = entry.usage || {};
    return `爆款模版分析：${entry.model || '-'}，参考图 ${entry.count || 0} 张；输入 ${usage.promptTokens ?? 0} tokens，输出 ${usage.completionTokens ?? 0} tokens，总计 ${usage.totalTokens ?? 0} tokens。`;
  }
  if (entry.type === 'image-generate') {
    const usage = entry.usage || {};
    const coin = Number.isFinite(Number(usage.coinCost)) ? Number(usage.coinCost) : null;
    const money = Number.isFinite(Number(usage.moneyCost)) ? Number(usage.moneyCost) : null;
    const parts = [];
    if (coin !== null) parts.push(`R 币 ${coin}`);
    if (money !== null) parts.push(`${usage.currency || 'CNY'} ${money}`);
    return `图片生成：${entry.model || '-'}，任务 ${entry.taskId || '-'}；消耗 ${parts.join(' / ') || '暂未取到'}。`;
  }
  if (entry.type === 'image-batch-generate') {
    const usage = entry.usage || {};
    const coin = Number.isFinite(Number(usage.coinCost)) ? Number(usage.coinCost) : null;
    const money = Number.isFinite(Number(usage.moneyCost)) ? Number(usage.moneyCost) : null;
    const parts = [];
    if (coin !== null) parts.push(`R 币 ${coin}`);
    if (money !== null) parts.push(`${usage.currency || 'CNY'} ${money}`);
    return `批量图片：${entry.count || 0} 张，并发 ${entry.concurrency || '-'}；成功 ${entry.successCount || 0}，失败 ${entry.failedCount || 0}；总消耗 ${parts.join(' / ') || '暂未取到'}。`;
  }
  if (entry.type === 'poster-card-generate') {
    return `大字报卡片：本地生成，模板 ${entry.templateId || '-'}；消耗 0。`;
  }
  if (entry.type === 'comparison-table-generate') {
    return `参数表参考图：本地排版，产品 ${entry.count || 0} 个；消耗 0。`;
  }
  if (entry.type === 'comparison-style-analysis') {
    return `参数表风格：本地保存 ${entry.count || 0} 个；消耗 0。`;
  }
  return `${entry.type || '记录'}：${JSON.stringify(entry.usage || {})}`;
}

function renderStyleTemplateOptions() {
  const currentValue = fields.visualMode.value;
  Array.from(fields.visualMode.querySelectorAll('optgroup[data-template-group="true"]')).forEach((group) => group.remove());
  Array.from(fields.visualMode.querySelectorAll('option:not([data-template-option="true"])')).forEach((option) => option.remove());
  if (styleTemplates.length) {
    for (const template of styleTemplates) {
      const option = document.createElement('option');
      option.value = `template:${template.id}`;
      option.textContent = template.name;
      option.dataset.templateOption = 'true';
      fields.visualMode.appendChild(option);
    }
  }
  const posterOption = document.createElement('option');
  posterOption.value = 'poster';
  posterOption.textContent = '大字报卡片';
  posterOption.dataset.templateOption = 'true';
  fields.visualMode.appendChild(posterOption);
  const comparisonOption = document.createElement('option');
  comparisonOption.value = 'comparison';
  comparisonOption.textContent = '参数对比表';
  comparisonOption.dataset.templateOption = 'true';
  fields.visualMode.appendChild(comparisonOption);
  const reviewOption = document.createElement('option');
  reviewOption.value = 'review';
  reviewOption.textContent = '产品点评';
  reviewOption.dataset.templateOption = 'true';
  fields.visualMode.appendChild(reviewOption);
  const firstTemplateValue = styleTemplates[0] ? `template:${styleTemplates[0].id}` : '';
  const nextValue = styleTemplates.some((template) => `template:${template.id}` === currentValue)
    ? currentValue
    : currentValue === 'poster'
    ? 'poster'
    : currentValue === 'comparison'
    ? 'comparison'
    : currentValue === 'review'
    ? 'review'
    : firstTemplateValue || 'poster';
  fields.visualMode.value = nextValue;
  fields.visualMode.disabled = !styleTemplates.length && fields.visualMode.value !== 'poster';
  selectedStyleTemplate = styleTemplates.find((template) => template.id === getSelectedStyleTemplateId()) || null;
  applyPendingRestoredVisualMode();
  renderStyleTemplatePreview();
}

function renderStyleTemplatePreview() {
  selectedStyleTemplate = styleTemplates.find((template) => template.id === getSelectedStyleTemplateId()) || null;
  const visibleStyles = getVisibleProductStyles();
  const selectedComparisonStyles = visibleStyles.filter((style) => selectedComparisonStyleIds.includes(style.id));
  const typeLabel = isReviewMode() ? '点评' : '参数表';
  const comparisonStyleLabel = selectedComparisonStyles.length === 0
    ? `随机${typeLabel}风格`
    : selectedComparisonStyles.length === 1
    ? selectedComparisonStyles[0].name
    : `已选 ${selectedComparisonStyles.length} 个${typeLabel}风格`;
  styleTemplateSummary.textContent = isPosterMode()
    ? '当前：大字报卡片'
    : isProductLayoutMode()
    ? `当前：${comparisonStyleLabel}`
    : styleTemplates.length
    ? `${styleTemplates.length} 个爆款模版${selectedStyleTemplate ? `，当前：${selectedStyleTemplate.name}` : ''}`
    : '还没有保存模版';
  if (isPosterMode()) {
    styleTemplatePreview.innerHTML = `
      <div class="template-preview-card">
        <div class="template-preview-media">
          <img src="/template-previews/poster-card.webp" alt="大字报卡片参考封面" />
        </div>
        <div class="template-preview-copy">
          <strong>本地卡片模版</strong>
          <span>${escapeHtml([
            '适合领域：求助帖、选择困难、装修/数码/生活经验、避坑提醒、强观点标题。',
            '内容方向：用一句大字标题制造停留，不依赖产品实拍图。',
            '视觉要点：纸感、手账、引号、撕纸、纯色底，大字号中文排版。'
          ].join('\n'))}</span>
        </div>
      </div>
    `;
    return;
  }
  if (isProductLayoutMode()) {
    const styleCards = visibleStyles.length
      ? visibleStyles.map((style, index) => {
        const selected = selectedComparisonStyleIds.includes(style.id);
        return `
          <button class="comparison-style-card ${selected ? 'active' : ''}" type="button" data-comparison-style-id="${escapeHtml(style.id)}">
            <span class="comparison-style-index">${String(index + 1).padStart(2, '0')}</span>
            <span class="comparison-style-thumb">
              ${style.previewImage ? `<img src="${escapeHtml(style.previewImage)}" alt="${escapeHtml(style.name || `${typeLabel}风格 ${index + 1}`)}" />` : `<span>${typeLabel}</span>`}
            </span>
            <strong>${escapeHtml(style.name || `${typeLabel}风格 ${index + 1}`)}</strong>
            <em>${selected ? '已选' : '点击选择'}</em>
            <small>${escapeHtml(style.mood || style.layout || `${typeLabel}风格`)}</small>
          </button>
        `;
      }).join('')
      : `<div class="comparison-style-empty">还没有读取到${typeLabel}风格。</div>`;
    styleTemplatePreview.innerHTML = `
      <div class="comparison-style-browser">
        <div class="comparison-style-browser-head">
          <div>
            <strong>${typeLabel}风格浏览</strong>
            <span>${escapeHtml(`当前 ${visibleStyles.length || 0} 个风格；可选 1 个或多个，本次生成只会使用已选风格。`)}</span>
          </div>
          <button class="ghost comparison-style-random ${selectedComparisonStyleIds.length ? '' : 'active'}" type="button" data-comparison-style-id="">随机挑选</button>
        </div>
        <div class="comparison-style-grid">${styleCards}</div>
      </div>
    `;
    return;
  }
  if (!selectedStyleTemplate) {
    styleTemplatePreview.textContent = '选择一个爆款封面模版后，这里会显示参考图和关键规则。';
    return;
  }
  const lines = [
    selectedStyleTemplate.bestFor ? `适合领域：${selectedStyleTemplate.bestFor}` : '',
    selectedStyleTemplate.copywritingFormula?.length ? `内容方向：${selectedStyleTemplate.copywritingFormula.slice(0, 2).join('；')}` : '',
    selectedStyleTemplate.firstGlanceHook ? `停留钩子：${selectedStyleTemplate.firstGlanceHook}` : '',
    selectedStyleTemplate.emotionalEngine ? `情绪气质：${selectedStyleTemplate.emotionalEngine}` : '',
    selectedStyleTemplate.compositionRules?.length ? `视觉要点：${selectedStyleTemplate.compositionRules.slice(0, 2).join('；')}` : '',
    selectedStyleTemplate.graphicDevices?.length ? `常用元素：${selectedStyleTemplate.graphicDevices.slice(0, 4).join('、')}` : ''
  ].filter(Boolean);
  const previewImage = selectedStyleTemplate.previewImage
    ? `<img src="${escapeHtml(selectedStyleTemplate.previewImage)}" alt="${escapeHtml(selectedStyleTemplate.name)}参考封面" />`
    : `<div class="template-preview-placeholder">暂无参考图</div>`;
  styleTemplatePreview.innerHTML = `
    <div class="template-preview-card">
      <div class="template-preview-media">${previewImage}</div>
      <div class="template-preview-copy">
        <strong>${escapeHtml(selectedStyleTemplate.name)}</strong>
        <span>${escapeHtml(lines.join('\n'))}</span>
      </div>
    </div>
  `;
}

async function loadStyleTemplates() {
  const response = await fetch('/api/style-templates');
  const data = await response.json();
  styleTemplates = data.templates || [];
  renderStyleTemplateOptions();
}

async function loadComparisonStyles() {
  const response = await fetch('/api/comparison-styles');
  const data = await response.json();
  comparisonStyles = data.styles || [];
  const availableIds = new Set(comparisonStyles.map((style) => style.id));
  selectedComparisonStyleIds = selectedComparisonStyleIds.filter((id) => availableIds.has(id));
  renderStyleTemplatePreview();
}

async function refreshUsageLog(preferredEntry) {
  if (preferredEntry) {
    usageLog.textContent = formatUsageEntry(preferredEntry);
    return;
  }
  const response = await fetch('/api/usage');
  const data = await response.json();
  const last = data.logs?.[data.logs.length - 1];
  usageLog.textContent = formatUsageEntry(last);
}

function getCurrentItemPayload() {
  const item = batchItems[selectedBatchIndex];
  if (!item) {
    return getPayload();
  }
  return {
    ...getPayload(),
    id: item.id,
    noteTitle: item.noteTitle,
    noteBody: item.noteBody,
    huaziText: item.huaziText,
    imageBrief: item.imageBrief,
    cardText: item.cardText || item.noteTitle,
    accentWords: item.accentWords,
    cardTemplate: item.cardTemplate,
    comparisonData: item.comparisonData,
    sourceIndex: item.sourceIndex,
    sourceName: item.sourceName
  };
}

function syncVisualModeUi() {
  const poster = isPosterMode();
  uploadZone.classList.toggle('optional-upload', poster);
  uploadZone.querySelector('.drop-title').textContent = poster ? '上传原图（可选）' : isProductLayoutMode() ? '上传产品图' : '上传原图';
  uploadZone.querySelector('.drop-copy').textContent = poster
    ? '大字报卡片不需要原图；上传图片只用于参考'
    : isProductLayoutMode()
    ? '按产品顺序上传，可在下方预览里调整顺序'
    : '可多选图片，也可整批导入文件夹';
  if (poster && !sourceFiles.length && !currentResultUrl) {
    previewImage.style.display = 'none';
    emptyPreview.style.display = 'flex';
    emptyPreview.textContent = '大字报卡片会在这里预览';
    imageInputSummary.textContent = '大字报卡片模式无需上传原图。';
  } else if (!poster && !sourceFiles.length && !currentResultUrl) {
    emptyPreview.textContent = '上传图片后在这里预览';
    imageInputSummary.textContent = '还没有选择原图。';
  }
  if (isProductLayoutMode() && !sourceFiles.length && !currentResultUrl) {
    emptyPreview.textContent = `${isReviewMode() ? '产品点评' : '参数对比表'}会在这里预览`;
  }
  if (sourceFiles.length) {
    imageInputSummary.textContent = isProductLayoutMode()
      ? `已选择 ${sourceFiles.length} 张产品图，系统会严格按上方顺序对应产品信息。`
      : `已选择 ${sourceFiles.length} 张原图，批量时会按上方顺序自动分配。`;
  }
  renderSourceOrderList();
  renderBatchList();
}

function renderFutureRules() {
  futureRules.textContent = futureProductionRules || '暂无。点击“应用到后续生产”后，后面的单张/批量都会带上这条规则。';
}

function getStatusText(status) {
  if (status === 'done') return '已生成';
  if (status === 'failed') return '失败';
  if (status === 'running') return '生成中';
  return '待生成';
}

function getItemThumb(item) {
  if (item.imageUrl) return item.imageUrl;
  if (isPosterMode()) return '';
  return sourcePreviews[item.sourceIndex ?? 0] || '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderBatchList() {
  if (!batchItems.length) {
    queueSummary.textContent = '还没有生成';
    batchList.innerHTML = `<div class="empty-list">点击“生成内容队列”后，这里会自动准备任务。${isPosterMode() ? '大字报卡片模式只生成卡片文案和模板，不需要原图。' : '当前版本使用“标题即花字”，队列标题会直接上图。'}</div>`;
    downloadAllBtn.hidden = true;
    return;
  }
  const doneCount = batchItems.filter((item) => item.status === 'done').length;
  const failedCount = batchItems.filter((item) => item.status === 'failed').length;
  queueSummary.textContent = `${batchItems.length} 条，已完成 ${doneCount} 条${failedCount ? `，失败 ${failedCount} 条` : ''}`;
  downloadAllBtn.hidden = doneCount === 0;

  batchList.innerHTML = batchItems.map((item, index) => {
    const poster = isPosterMode();
    return `
    <article class="batch-item ${index === selectedBatchIndex ? 'active' : ''}" data-index="${index}">
      <div class="batch-thumb">
        ${getItemThumb(item) ? `<img src="${getItemThumb(item)}" alt="第 ${item.id || index + 1} 张预览" />` : '<span>未生成</span>'}
      </div>
      <div class="batch-item-head">
        <strong>#${String(item.id || index + 1).padStart(2, '0')}</strong>
        <span>${getStatusText(item.status)}</span>
      </div>
      <div class="batch-edit-fields">
        <label>
          <span>${poster ? '卡片文案' : '标题'}</span>
          <input class="batch-title-input" data-index="${index}" value="${escapeHtml(item.noteTitle || '')}" />
        </label>
        ${poster ? `
        <label>
          <span>强调词</span>
          <input class="batch-accent-input" data-index="${index}" value="${escapeHtml((item.accentWords || []).join('，'))}" />
        </label>
        <label>
          <span>模板</span>
          <input class="batch-template-input" data-index="${index}" value="${escapeHtml(item.cardTemplate || '')}" />
        </label>
        ` : `
        <label>
          <span>花字</span>
          <textarea class="batch-huazi-input" data-index="${index}" rows="2">${escapeHtml(item.huaziText || '')}</textarea>
        </label>
        <label>
          <span>画面描述</span>
          <textarea class="batch-brief-input" data-index="${index}" rows="3">${escapeHtml(item.imageBrief || '')}</textarea>
        </label>
        `}
        <button class="ghost rewrite-item-btn" type="button" data-index="${index}">重写整条任务</button>
        <button class="secondary generate-item-btn" type="button" data-index="${index}">${item.imageUrl ? '重产这张' : '生成这张'}</button>
      </div>
      <pre>${poster ? `模板：${item.cardTemplate || '自动'}${item.accentWords?.length ? `｜强调：${item.accentWords.join('、')}` : ''}` : (item.sourceName ? `原图：${item.sourceName}` : '')}</pre>
      ${item.imageUrl ? `<a href="${item.imageUrl}" target="_blank">查看图片</a>` : ''}
      ${item.error ? `<em>${item.error}</em>` : ''}
    </article>
  `;
  }).join('');
}

function handleSourceSelection(fileList) {
  const selectedFiles = getImageFiles(fileList);
  if (!selectedFiles.length) {
    imageInputSummary.textContent = sourceFiles.length
      ? `没有识别到新图片，已保留当前 ${sourceFiles.length} 张。`
      : '没有识别到图片，请选择 JPG / PNG / WebP 文件夹或图片';
    renderSourceOrderList();
    return;
  }
  const merged = window.XhsUploadUtils.mergeSourceSelection(
    sourceFiles,
    sourcePreviews,
    selectedFiles,
    (file) => URL.createObjectURL(file)
  );
  sourceFiles = merged.files;
  sourcePreviews = merged.previews;
  const file = sourceFiles[0];
  if (!file) {
    imageInputSummary.textContent = '没有识别到图片，请选择 JPG / PNG / WebP 文件夹或图片';
    renderSourceOrderList();
    return;
  }
  const url = sourcePreviews[0];
  previewImage.src = url;
  currentResultUrl = '';
  imageAnalysis = null;
  refreshSourceAssignments();
  previewImage.style.display = 'block';
  emptyPreview.style.display = 'none';
  downloadLink.hidden = true;
  imageInputSummary.textContent = isProductLayoutMode()
    ? `已选择 ${sourceFiles.length} 张产品图，系统会严格按上方顺序对应产品信息。`
    : `已选择 ${sourceFiles.length} 张原图，批量时会按上方顺序自动分配。`;
  setMessage(isProductLayoutMode()
    ? `已追加 ${selectedFiles.length} 张产品图，当前共 ${sourceFiles.length} 张，可以在上传框内调整顺序。`
    : `已追加 ${selectedFiles.length} 张原图，当前共 ${sourceFiles.length} 张，可以先生成内容队列或直接试做。`);
  renderSourceOrderList();
  renderBatchList();
}

imageInput.addEventListener('change', () => {
  handleSourceSelection(imageInput.files);
  imageInput.value = '';
});

folderInput.addEventListener('change', () => {
  handleSourceSelection(folderInput.files);
  folderInput.value = '';
});

stopGenerationBtn?.addEventListener('click', async () => {
  requestGenerationStop();
  stopGenerationBtn.disabled = true;
  stopGenerationBtn.textContent = '正在停止...';
  markRunningItemsStopped();
  setMessage('已停止继续生成。页面和服务保持可用，可以调整参数后重新试做。');
  setLoading(false);
});

restoreConfigBtn?.addEventListener('click', () => {
  restoreLastConfig().catch((error) => setMessage(error.message || '恢复上次配置失败', true));
});

styleTemplatePreview.addEventListener('click', (event) => {
  const styleBtn = event.target.closest('[data-comparison-style-id]');
  if (!styleBtn || !isProductLayoutMode()) return;
  const styleId = styleBtn.dataset.comparisonStyleId || '';
  if (!styleId) {
    selectedComparisonStyleIds = [];
  } else if (selectedComparisonStyleIds.includes(styleId)) {
    selectedComparisonStyleIds = selectedComparisonStyleIds.filter((id) => id !== styleId);
  } else {
    selectedComparisonStyleIds = [...selectedComparisonStyleIds, styleId];
  }
  renderStyleTemplatePreview();
  saveLastConfig();
  generatePrompt().catch(() => {});
  const selectedNames = getVisibleProductStyles()
    .filter((style) => selectedComparisonStyleIds.includes(style.id))
    .map((style) => style.name);
  setMessage(selectedNames.length
    ? `本次${isReviewMode() ? '产品点评' : '参数对比表'}将只使用已选 ${selectedNames.length} 个模版。`
    : `已切回随机挑选${isReviewMode() ? '点评' : '参数表'}风格。`);
});

fields.visualMode.addEventListener('change', () => {
  imageAnalysis = null;
  if (isProductLayoutMode()) {
    const availableIds = new Set(getVisibleProductStyles().map((style) => style.id));
    selectedComparisonStyleIds = selectedComparisonStyleIds.filter((id) => availableIds.has(id));
  }
  selectedStyleTemplate = styleTemplates.find((template) => template.id === getSelectedStyleTemplateId()) || null;
  renderStyleTemplatePreview();
  syncVisualModeUi();
  saveLastConfig();
  generatePrompt().catch(() => {});
});

[fields.noteTitle, fields.noteBody, fields.topicDirection, fields.batchCount].forEach((field) => {
  field.addEventListener('input', saveLastConfig);
});

[fields.size, fields.concurrency].forEach((field) => {
  field.addEventListener('change', saveLastConfig);
});

batchList.addEventListener('input', (event) => {
  const titleInput = event.target.closest('.batch-title-input');
  const huaziInput = event.target.closest('.batch-huazi-input');
  const briefInput = event.target.closest('.batch-brief-input');
  const accentInput = event.target.closest('.batch-accent-input');
  const templateInput = event.target.closest('.batch-template-input');
  if (!titleInput && !huaziInput && !briefInput && !accentInput && !templateInput) return;
  const index = Number((titleInput || huaziInput || briefInput || accentInput || templateInput).dataset.index);
  if (!batchItems[index]) return;
  const resetGeneratedState = {
    status: 'pending',
    imageUrl: '',
    prompt: '',
    taskId: '',
    error: ''
  };
  if (titleInput) {
    batchItems[index] = {
      ...batchItems[index],
      noteTitle: titleInput.value,
      cardText: isPosterMode() ? titleInput.value : batchItems[index].cardText,
      ...resetGeneratedState
    };
  }
  if (huaziInput) {
    batchItems[index] = {
      ...batchItems[index],
      huaziText: huaziInput.value,
      ...resetGeneratedState
    };
  }
  if (briefInput) {
    batchItems[index] = {
      ...batchItems[index],
      imageBrief: briefInput.value,
      ...resetGeneratedState
    };
  }
  if (accentInput) {
    batchItems[index] = {
      ...batchItems[index],
      accentWords: accentInput.value.split(/[，,、/|]+/).map((word) => word.trim()).filter(Boolean).slice(0, 2),
      ...resetGeneratedState
    };
  }
  if (templateInput) {
    batchItems[index] = {
      ...batchItems[index],
      cardTemplate: templateInput.value.trim(),
      ...resetGeneratedState
    };
  }
  const statusText = event.target.closest('.batch-item')?.querySelector('.batch-item-head span');
  if (statusText) statusText.textContent = '待生成';
});

batchList.addEventListener('click', async (event) => {
  const generateItemBtn = event.target.closest('.generate-item-btn');
  if (generateItemBtn) {
    event.stopPropagation();
    const index = Number(generateItemBtn.dataset.index);
    if (!batchItems[index]) return;
    selectedBatchIndex = index;
    batchItems[index] = {
      ...batchItems[index],
      status: 'running',
      error: ''
    };
    generateItemBtn.disabled = true;
    generateItemBtn.textContent = '生成中...';
    renderBatchList();
    stopGenerationRequested = false;
    setLoading(true, `正在生成第 ${batchItems[index].id || index + 1} 张`, '这次只生成当前这一条任务。', { canStop: true });
    setMessage(`正在生成第 ${batchItems[index].id || index + 1} 张...`);
    try {
      const data = await generateSingleItem(batchItems[index]);
      batchItems[index] = {
        ...batchItems[index],
        status: 'done',
        imageUrl: data.imageUrl,
        prompt: data.prompt,
        taskId: data.taskId,
        error: ''
      };
      previewImage.src = `${data.imageUrl}?t=${Date.now()}`;
      currentResultUrl = data.imageUrl;
      previewImage.style.display = 'block';
      emptyPreview.style.display = 'none';
      downloadLink.href = data.imageUrl;
      downloadLink.hidden = false;
      await refreshUsageLog(data.usageLog);
      renderBatchList();
      setMessage(`第 ${batchItems[index].id || index + 1} 张已生成。`);
    } catch (error) {
      batchItems[index] = {
        ...batchItems[index],
        status: isGenerationStopError(error) ? 'pending' : 'failed',
        error: getReadableError(error, '生成失败')
      };
      renderBatchList();
      setMessage(getReadableError(error, '生成失败'), !isGenerationStopError(error));
    } finally {
      setLoading(false);
    }
    return;
  }

  const rewriteBtn = event.target.closest('.rewrite-item-btn');
  if (!rewriteBtn) return;
  event.stopPropagation();
  const index = Number(rewriteBtn.dataset.index);
  if (!batchItems[index]) return;
  const originalText = rewriteBtn.textContent;
  rewriteBtn.disabled = true;
  rewriteBtn.textContent = '重写中...';
  setMessage(`正在重写第 ${batchItems[index].id || index + 1} 条任务：标题、花字、正文和画面描述都会更新...`);
  try {
    const rewriteResult = await rewriteBatchItem(batchItems[index], index);
    const rewritten = rewriteResult.item || {};
    batchItems[index] = {
      ...batchItems[index],
      ...rewritten,
      status: 'pending',
      imageUrl: '',
      prompt: '',
      taskId: '',
      error: ''
    };
    renderBatchList();
    if (index === selectedBatchIndex) {
      await generatePrompt();
    }
    await refreshUsageLog(rewriteResult.usageLog);
    setMessage(`第 ${batchItems[index].id || index + 1} 条任务已重写。`);
  } catch (error) {
    setMessage(getReadableError(error, '重写失败'), true);
  } finally {
    rewriteBtn.disabled = false;
    rewriteBtn.textContent = originalText;
  }
});

uploadZone.addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  if (event.target.closest('.source-order-list')) return;
  imageInput.click();
});

uploadZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    imageInput.click();
  }
});

pickImagesBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  imageInput.click();
});

pickFolderBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  folderInput.click();
});

sourceOrderList.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  event.stopPropagation();
  const index = Number.parseInt(button.dataset.index, 10);
  if (!Number.isFinite(index)) return;
  if (button.classList.contains('source-move-up')) {
    moveSourceFile(index, index - 1);
  } else if (button.classList.contains('source-move-down')) {
    moveSourceFile(index, index + 1);
  } else if (button.classList.contains('source-remove')) {
    removeSourceFile(index);
  }
});

pickStyleTemplateBtn.addEventListener('click', () => {
  styleTemplateInput.click();
});

async function extractCopyFromImageFiles(files, sourceLabel = '图片') {
  const imageFiles = getImageFiles(files);
  if (!imageFiles.length) {
    setMessage('没有识别到可读取的图片，请选择或粘贴 JPG / PNG / WebP。', true);
    return;
  }
  const originalText = extractImageCopyBtn.textContent;
  extractImageCopyBtn.disabled = true;
  extractImageCopyBtn.textContent = '提取中...';
  setLoading(true, '正在提取图片信息', '会读取图片里的文字、产品、参数和卖点，并整理成原始正文。');
  setMessage(`正在从 ${Math.min(imageFiles.length, 8)} 张${sourceLabel}里提取信息...`);
  try {
    const payload = getPayload();
    const form = new FormData();
    imageFiles.slice(0, 8).forEach((file) => form.append('images', file));
    form.append('noteTitle', payload.noteTitle);
    form.append('noteBody', payload.noteBody);
    form.append('topicDirection', payload.topicDirection);
    form.append('visualMode', payload.visualMode);
    const response = await fetch('/api/extract-image-copy', {
      method: 'POST',
      body: form
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || '图片信息提取失败');
    }
    if (data.titleSuggestion && (!fields.noteTitle.value.trim() || /^客厅智能氛围/.test(fields.noteTitle.value.trim()))) {
      fields.noteTitle.value = data.titleSuggestion;
    }
    fields.noteBody.value = data.noteBody || fields.noteBody.value;
    if (data.topicDirection && !fields.topicDirection.value.trim()) {
      fields.topicDirection.value = data.topicDirection;
    }
    imageAnalysis = data.imageAnalysis || imageAnalysis;
    batchItems = [];
    currentResultUrl = '';
    renderBatchList();
    saveLastConfig();
    await refreshUsageLog(data.usageLog);
    setMessage('图片信息已整理到原始正文，可以继续手动微调后生成内容队列。');
  } catch (error) {
    setMessage(getReadableError(error, '图片信息提取失败'), true);
  } finally {
    setLoading(false);
    extractImageCopyBtn.disabled = false;
    extractImageCopyBtn.textContent = originalText;
  }
}

extractImageCopyBtn.addEventListener('click', () => {
  extractImageCopyInput.click();
});

extractImageCopyInput.addEventListener('change', async () => {
  await extractCopyFromImageFiles(extractImageCopyInput.files, '待识别图片');
  extractImageCopyInput.value = '';
});

fields.noteBody.addEventListener('paste', async (event) => {
  const files = Array.from(event.clipboardData?.files || []).filter((file) => /^image\/(png|jpe?g|webp)$/i.test(file.type));
  if (!files.length) return;
  event.preventDefault();
  await extractCopyFromImageFiles(files, '粘贴图片');
});

styleTemplateInput.addEventListener('change', () => {
  const files = getImageFiles(styleTemplateInput.files);
  styleTemplatePreview.textContent = files.length
    ? isProductLayoutMode()
      ? `已选择 ${files.length} 张${isReviewMode() ? '产品点评' : '参数对比'}参考图。点击“分析并保存”后会加入当前类型模版库。`
      : `已选择 ${files.length} 张参考封面。点击“分析并保存”后会生成标准化模版。`
    : '没有识别到参考封面，请选择 JPG / PNG / WebP。';
});

analyzeStyleTemplateBtn.addEventListener('click', async () => {
  const files = getImageFiles(styleTemplateInput.files);
  if (!files.length) {
    setMessage('请先选择 1-8 张爆款参考封面。', true);
    return;
  }
  const originalText = analyzeStyleTemplateBtn.textContent;
  analyzeStyleTemplateBtn.disabled = true;
  analyzeStyleTemplateBtn.textContent = '分析中...';
  setLoading(true, '正在分析爆款模版', '会总结构图、字体、配色、视觉元素和可复用提示词。');
  setMessage(isProductLayoutMode() ? `正在保存 ${files.length} 张${isReviewMode() ? '产品点评' : '参数对比表'}风格...` : `正在分析 ${files.length} 张参考封面...`);
  try {
    const form = new FormData();
    files.slice(0, 8).forEach((file) => form.append('images', file));
    form.append('templateName', styleTemplateName.value.trim());
    form.append('notes', styleTemplateNotes.value.trim());
    if (isProductLayoutMode()) {
      form.append('category', isReviewMode() ? 'review' : 'comparison');
      const response = await fetch('/api/comparison-styles/analyze', {
        method: 'POST',
        body: form
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || '参数表风格保存失败');
      }
      comparisonStyles = data.styles || [];
      renderStyleTemplatePreview();
      saveLastConfig();
      await refreshUsageLog(data.usageLog);
      styleTemplateInput.value = '';
      styleTemplateName.value = '';
      setMessage(`已保存 ${data.created?.length || files.length} 个${isReviewMode() ? '产品点评' : '参数对比表'}风格。后续生成会在当前类型中挑选。`);
      return;
    }
    const response = await fetch('/api/style-templates/analyze', {
      method: 'POST',
      body: form
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || '分析爆款模版失败');
    }
    styleTemplates = data.templates || [];
    renderStyleTemplateOptions();
    fields.visualMode.value = `template:${data.template.id}`;
    selectedStyleTemplate = data.template;
    renderStyleTemplatePreview();
    syncVisualModeUi();
    saveLastConfig();
    await generatePrompt();
    await refreshUsageLog(data.usageLog);
    styleTemplateInput.value = '';
    styleTemplateName.value = '';
    setMessage(`已保存模版「${data.template.name}」，并切换到这个画面模式。`);
  } catch (error) {
    setMessage(getReadableError(error, '分析爆款模版失败'), true);
  } finally {
    analyzeStyleTemplateBtn.disabled = false;
    analyzeStyleTemplateBtn.textContent = originalText;
    setLoading(false);
  }
});

uploadZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  uploadZone.classList.add('dragging');
});

uploadZone.addEventListener('dragleave', () => {
  uploadZone.classList.remove('dragging');
});

uploadZone.addEventListener('drop', (event) => {
  event.preventDefault();
  uploadZone.classList.remove('dragging');
  handleSourceSelection(event.dataTransfer.files);
});

async function generatePrompt() {
  const payload = getCurrentItemPayload();
  const response = await fetch('/api/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  promptOutput.value = data.prompt || '';
  return data.prompt;
}

async function generateBatchPlan() {
  if (!imageAnalysis && sourceFiles[0]) {
    await analyzeCurrentImage({ silent: true });
  }
  const payload = getPayload();
  const response = await fetch('/api/batch-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      imageAnalysis
    })
  });
  const data = await response.json();
  batchItems = assignSourceToBatchItems(data.items || []);
  batchPlanningPrompt = data.prompt || '';
  selectedBatchIndex = 0;
  renderBatchList();
  await generatePrompt();
  return data;
}

async function generateRevisionPrompt() {
  const response = await fetch('/api/optimize-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...getCurrentItemPayload(),
      revisionMode: true,
      revisionFeedback: fields.revisionFeedback.value.trim()
    })
  });
  const data = await response.json();
  promptOutput.value = data.optimizedPrompt || '';
  return data.optimizedPrompt;
}

async function rewriteBatchItem(item, index) {
  const response = await fetch('/api/rewrite-item', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...getPayload(),
      item,
      itemIndex: index + 1,
      existingTitles: batchItems.map((entry) => entry.noteTitle).filter(Boolean),
      imageAnalysis
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || '重写失败');
  }
  return data;
}

async function applyFeedbackToFuture() {
  const feedback = fields.revisionFeedback.value.trim();
  if (!feedback) {
    throw new Error('先写一句批注，比如“字大一点，往左移一点”。');
  }

  const response = await fetch('/api/optimize-prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...getCurrentItemPayload(),
      promptFeedback: feedback
    })
  });
  const data = await response.json();
  futureProductionRules = data.optimizedRules || `- 后续生产统一遵循这条批注：${feedback}`;
  renderFutureRules();
  await generatePrompt();
  return futureProductionRules;
}

function clampClientConcurrency(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count)) return 3;
  return Math.max(1, Math.min(20, count));
}

function pickComparisonStyleIdForItem(item = {}) {
  if (item.comparisonStyleId) return item.comparisonStyleId;
  if (!selectedComparisonStyleIds.length) return '';
  const numericId = Number.parseInt(item.id, 10);
  const index = Number.isFinite(numericId) ? Math.max(0, numericId - 1) : 0;
  return selectedComparisonStyleIds[index % selectedComparisonStyleIds.length] || '';
}

async function runClientPool(items, concurrency, worker) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      if (stopGenerationRequested) break;
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex], currentIndex);
    }
  });
  await Promise.all(workers);
}

async function generateSingleItem(item) {
  const file = sourceFiles[item.sourceIndex] || sourceFiles[0];
  if (isProductLayoutMode()) {
    if (!sourceFiles.length) {
      throw new Error('请先按产品顺序上传产品图。');
    }
    const form = new FormData();
    sourceFiles.slice(0, 8).forEach((sourceFile) => form.append('images', sourceFile));
    form.append('id', item.id || '');
    form.append('noteTitle', item.noteTitle || getPayload().noteTitle);
    form.append('noteBody', item.noteBody || getPayload().noteBody);
    form.append('topicDirection', getPayload().topicDirection);
    form.append('comparisonData', JSON.stringify(item.comparisonData || {}));
    form.append('comparisonStyleId', pickComparisonStyleIdForItem(item));
    form.append('visualMode', isReviewMode() ? 'review' : 'comparison');
    form.append('aspectRatio', getPayload().aspectRatio);
    form.append('size', fields.size.value);
    form.append('quality', 'medium');
    form.append('resolution', '1k');
    const response = await fetchGeneration('/api/generate-comparison', {
      method: 'POST',
      body: form
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `${isReviewMode() ? '产品点评' : '参数对比表'}生成失败`);
    }
    return data;
  }
  if (!file && !isPosterMode()) {
    throw new Error('没有找到这条任务对应的原图。');
  }
  const form = new FormData();
  if (file) form.append('image', file);
  form.append('id', item.id || '');
  form.append('noteTitle', item.noteTitle);
  form.append('noteBody', item.noteBody);
  form.append('huaziText', item.huaziText || '');
  form.append('cardText', item.cardText || item.noteTitle || '');
  form.append('accentWords', Array.isArray(item.accentWords) ? item.accentWords.join('，') : (item.accentWords || ''));
  form.append('cardTemplate', item.cardTemplate || '');
  form.append('topicDirection', getPayload().topicDirection);
  form.append('imageBrief', item.imageBrief || '');
  form.append('visualMode', getPayload().visualMode);
  form.append('styleTemplateId', getPayload().styleTemplateId);
  form.append('size', fields.size.value);
  form.append('quality', 'medium');
  form.append('style', getPayload().style);
  form.append('optimizedRules', futureProductionRules);
  form.append('aspectRatio', getPayload().aspectRatio);
  form.append('sourceIndex', item.sourceIndex ?? 0);
  form.append('sourceName', item.sourceName || (file ? getSourceName(file) : '大字报卡片'));

  const response = await fetchGeneration('/api/generate', {
    method: 'POST',
    body: form
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || '生成失败');
  }
  return data;
}

async function getCurrentPreviewAsFile() {
  if (currentResultUrl) {
    const response = await fetch(currentResultUrl);
    const blob = await response.blob();
    return new File([blob], 'current-cover.png', { type: blob.type || 'image/png' });
  }
  const file = getCurrentSourceFile();
  if (!file) {
    throw new Error('请先上传一张封面原图。');
  }
  return file;
}

promptBtn.addEventListener('click', async () => {
  const originalText = promptBtn.textContent;
  promptBtn.disabled = true;
  promptBtn.textContent = '准备中...';
  setLoading(true, '正在准备内容队列', isPosterMode() ? '会先分析文案类型，再生成多条卡片文案和模板。' : '会先分析原图，再生成多条标题、花字和画面思路。');
  setMessage('正在生成内容队列...');
  try {
    const data = await generateBatchPlan();
    await refreshUsageLog(data.usageLog);
    const sourceText = data.source === 'text-model' ? `文本模型 ${data.model || ''}`.trim() : '本地兜底模板';
    const warning = data.warning ? ` ${data.warning}` : '';
    setMessage(`已准备 ${data.count} 条任务，来源：${sourceText}。${isPosterMode() ? '卡片文案和模板已生成，先试做第 1 张。' : '标题和花字会自动使用，先试做第 1 张。'}${warning}`);
  } catch (error) {
    setMessage(getReadableError(error, '生成内容队列失败'), true);
  } finally {
    promptBtn.disabled = false;
    promptBtn.textContent = originalText;
    setLoading(false);
  }
});

revisionPromptBtn.addEventListener('click', async () => {
  revisionPromptBtn.disabled = true;
  setMessage('正在把你的批注整理成新的单图修改提示词...');
  try {
    await generateRevisionPrompt();
    setMessage('批注提示词已生成。可以复制到 ChatGPT，上传当前结果图后重产这一张。');
  } catch (error) {
    setMessage(getReadableError(error, '生成批注提示词失败'), true);
  } finally {
    revisionPromptBtn.disabled = false;
  }
});

applyFutureBtn.addEventListener('click', async () => {
  applyFutureBtn.disabled = true;
  setMessage('正在把这条批注沉淀为后续生产规则...');
  try {
    await applyFeedbackToFuture();
    saveLastConfig();
    setMessage('已应用到后续生产。后面的单张生成和批量生成都会带上这条规则。');
  } catch (error) {
    setMessage(getReadableError(error, '应用到后续失败'), true);
  } finally {
    applyFutureBtn.disabled = false;
  }
});

clearFutureRulesBtn.addEventListener('click', async () => {
  futureProductionRules = '';
  renderFutureRules();
  saveLastConfig();
  await generatePrompt();
  setMessage('已清空后续生产规则。');
});

batchList.addEventListener('click', async (event) => {
  if (event.target.closest('input, textarea, button, a')) return;
  const item = event.target.closest('.batch-item');
  if (!item) return;
  selectedBatchIndex = Number(item.dataset.index || 0);
  renderBatchList();
  await generatePrompt();
  const selected = batchItems[selectedBatchIndex];
  if (selected?.imageUrl) {
    previewImage.src = `${selected.imageUrl}?t=${Date.now()}`;
    currentResultUrl = selected.imageUrl;
    previewImage.style.display = 'block';
    emptyPreview.style.display = 'none';
    downloadLink.href = selected.imageUrl;
    downloadLink.hidden = false;
  } else if (sourcePreviews[selected?.sourceIndex ?? 0]) {
    previewImage.src = sourcePreviews[selected.sourceIndex ?? 0];
    currentResultUrl = '';
    previewImage.style.display = 'block';
    emptyPreview.style.display = 'none';
    downloadLink.hidden = true;
  } else if (isPosterMode()) {
    previewImage.style.display = 'none';
    emptyPreview.style.display = 'flex';
    emptyPreview.textContent = '这条卡片还没有生成';
    downloadLink.hidden = true;
  }
  setMessage(`已选择第 ${selected?.id || selectedBatchIndex + 1} 条任务。`);
});

copyPromptBtn.addEventListener('click', async () => {
  if (!promptOutput.value.trim()) {
    await generatePrompt();
  }
  await navigator.clipboard.writeText(promptOutput.value);
  setMessage('提示词已复制。');
});

copyBatchPromptBtn.addEventListener('click', async () => {
  if (!batchPlanningPrompt) {
    await generateBatchPlan();
  }
  await navigator.clipboard.writeText(batchPlanningPrompt);
  setMessage('批量策划提示词已复制。你可以粘贴到 ChatGPT，让它生成更自然的 50 条 JSON 方案。');
});

downloadAllBtn.addEventListener('click', async () => {
  const readyItems = batchItems.filter((item) => item.status === 'done' && item.imageUrl);
  if (!readyItems.length) {
    setMessage('还没有可下载的图片。', true);
    return;
  }
  const originalText = downloadAllBtn.textContent;
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = '打包中...';
  try {
    const response = await fetch('/api/download-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: readyItems })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '下载失败');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `xiaohongshu-covers-${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage(`已打包 ${readyItems.length} 张图片。`);
  } catch (error) {
    setMessage(getReadableError(error, '下载失败'), true);
  } finally {
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = originalText;
  }
});

downloadHistoryBtn.addEventListener('click', async () => {
  const originalText = downloadHistoryBtn.textContent;
  downloadHistoryBtn.disabled = true;
  downloadHistoryBtn.textContent = '打包中...';
  try {
    const response = await fetch('/api/download-outputs', { method: 'POST' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || '下载历史图片失败');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `xiaohongshu-history-${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setMessage('已打包 outputs 里的历史图片。');
  } catch (error) {
    setMessage(getReadableError(error, '下载历史图片失败'), true);
  } finally {
    downloadHistoryBtn.disabled = false;
    downloadHistoryBtn.textContent = originalText;
  }
});

generateBtn.addEventListener('click', async () => {
  const file = getCurrentSourceFile();
  if (!file && !isPosterMode() && !isProductLayoutMode()) {
    setMessage('请先上传一张封面原图。', true);
    return;
  }
  if (isProductLayoutMode() && !sourceFiles.length) {
    setMessage('请先按产品顺序上传产品图。', true);
    return;
  }

  const originalText = generateBtn.textContent;
  generateBtn.disabled = true;
  generateBtn.textContent = '试做中...';
  promptBtn.disabled = true;
  stopGenerationRequested = false;
  downloadLink.hidden = true;
  setLoading(true, '正在试做第 1 张', isPosterMode() ? '会用本地模板生成大字报卡片，通常几秒内完成。' : '会先确认内容和画面思路，再提交图片生成，通常需要约 1 分钟。', { canStop: true });
  setMessage('已开始试做封面，请等待生成结果。');

  try {
    if (!batchItems.length) {
      setMessage('正在准备内容队列，然后试做第 1 张封面...');
      await generateBatchPlan();
    }
    if (stopGenerationRequested) throw makeAbortError();
    selectedBatchIndex = selectedBatchIndex || 0;
    if (batchItems[selectedBatchIndex]) {
      batchItems[selectedBatchIndex] = {
        ...batchItems[selectedBatchIndex],
        status: 'running',
        error: ''
      };
    }
    renderBatchList();
    setLoading(true, `正在试做第 ${selectedBatchIndex + 1} 张`, isProductLayoutMode() ? `正在生成${isReviewMode() ? '点评' : '参数表'}参考图，并调用生图 API 做爆款封面。` : isPosterMode() ? '正在本地生成卡片 PNG。' : 'RunningHub 正在生成图片，通常需要约 1 分钟。', { canStop: true });
    setMessage(`正在试做第 ${selectedBatchIndex + 1} 张封面...`);

    const prompt = await generatePrompt();
    if (stopGenerationRequested) throw makeAbortError();
    if (isProductLayoutMode()) {
      const data = await generateSingleItem(batchItems[selectedBatchIndex] || getCurrentItemPayload());
      previewImage.src = `${data.imageUrl}?t=${Date.now()}`;
      currentResultUrl = data.imageUrl;
      previewImage.style.display = 'block';
      emptyPreview.style.display = 'none';
      promptOutput.value = data.prompt || prompt;
      await refreshUsageLog(data.usageLog);
      downloadLink.href = data.imageUrl;
      downloadLink.hidden = false;
      if (batchItems[selectedBatchIndex]) {
        batchItems[selectedBatchIndex] = {
          ...batchItems[selectedBatchIndex],
          status: 'done',
          imageUrl: data.imageUrl,
          prompt: data.prompt,
          taskId: data.taskId
        };
        renderBatchList();
      }
      setMessage(`第 ${selectedBatchIndex + 1} 张${isReviewMode() ? '产品点评' : '参数对比表'}已用生图 API 生成。`);
      return;
    }
    const form = new FormData();
    const payload = getCurrentItemPayload();
    if (file) form.append('image', file);
    form.append('id', payload.id || batchItems[selectedBatchIndex]?.id || '');
    form.append('sourceIndex', payload.sourceIndex ?? 0);
    form.append('sourceName', payload.sourceName || (file ? getSourceName(file) : '大字报卡片'));
    form.append('noteTitle', payload.noteTitle);
    form.append('noteBody', payload.noteBody);
    form.append('huaziText', payload.huaziText || '');
    form.append('cardText', payload.cardText || payload.noteTitle || '');
    form.append('accentWords', Array.isArray(payload.accentWords) ? payload.accentWords.join('，') : (payload.accentWords || ''));
    form.append('cardTemplate', payload.cardTemplate || '');
    form.append('topicDirection', payload.topicDirection);
    form.append('imageBrief', payload.imageBrief || '');
    form.append('visualMode', payload.visualMode);
    form.append('styleTemplateId', payload.styleTemplateId);
    form.append('size', fields.size.value);
    form.append('quality', 'medium');
    form.append('style', getPayload().style);
    form.append('optimizedRules', futureProductionRules);
    form.append('aspectRatio', getPayload().aspectRatio);

    const response = await fetchGeneration('/api/generate', {
      method: 'POST',
      body: form
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || '生成失败');
    }

    previewImage.src = `${data.imageUrl}?t=${Date.now()}`;
    currentResultUrl = data.imageUrl;
    previewImage.style.display = 'block';
    emptyPreview.style.display = 'none';
    promptOutput.value = data.prompt || prompt;
    await refreshUsageLog(data.usageLog);
    downloadLink.href = data.imageUrl;
    downloadLink.hidden = false;
    if (batchItems[selectedBatchIndex]) {
      batchItems[selectedBatchIndex] = {
        ...batchItems[selectedBatchIndex],
        status: 'done',
        imageUrl: data.imageUrl,
        prompt: data.prompt,
        sourceIndex: payload.sourceIndex ?? 0,
        sourceName: payload.sourceName || (file ? getSourceName(file) : '大字报卡片')
      };
      renderBatchList();
    }
    setMessage(`第 ${selectedBatchIndex + 1} 张已生成。满意后可以继续生成剩余。`);
  } catch (error) {
    if (batchItems[selectedBatchIndex]?.status === 'running') {
      batchItems[selectedBatchIndex] = {
        ...batchItems[selectedBatchIndex],
        status: isGenerationStopError(error) ? 'pending' : 'failed',
        error: getReadableError(error, '生成失败')
      };
      renderBatchList();
    }
    setMessage(getReadableError(error, '生成失败'), !isGenerationStopError(error));
  } finally {
    generateBtn.disabled = false;
    generateBtn.textContent = originalText;
    promptBtn.disabled = false;
    setLoading(false);
  }
});

regenerateCurrentBtn.addEventListener('click', async () => {
  const feedback = fields.revisionFeedback.value.trim();
  if (!feedback) {
    setMessage('先写一句批注，比如“字大一点，往左移一点”。', true);
    return;
  }

  const originalText = regenerateCurrentBtn.textContent;
  regenerateCurrentBtn.disabled = true;
  regenerateCurrentBtn.textContent = '重产中...';
  revisionPromptBtn.disabled = true;
  stopGenerationRequested = false;
  downloadLink.hidden = true;
  if (batchItems[selectedBatchIndex]) {
    batchItems[selectedBatchIndex] = {
      ...batchItems[selectedBatchIndex],
      status: 'running',
      error: ''
    };
    renderBatchList();
  }
  setLoading(true, `正在重产第 ${selectedBatchIndex + 1} 张`, '会按你的批注重新生成当前封面。', { canStop: true });
  setMessage('正在按批注重产当前这张图...');

  try {
    const prompt = await generateRevisionPrompt();
    if (stopGenerationRequested) throw makeAbortError();
    const file = await getCurrentPreviewAsFile();
    const payload = getCurrentItemPayload();
    const form = new FormData();
    form.append('image', file);
    form.append('noteTitle', payload.noteTitle);
    form.append('noteBody', payload.noteBody);
    form.append('huaziText', payload.huaziText);
    form.append('topicDirection', payload.topicDirection);
    form.append('imageBrief', payload.imageBrief || '');
    form.append('visualMode', payload.visualMode);
    form.append('styleTemplateId', payload.styleTemplateId);
    form.append('size', fields.size.value);
    form.append('quality', 'medium');
    form.append('style', getPayload().style);
    form.append('optimizedRules', futureProductionRules);
    form.append('revisionMode', 'true');
    form.append('revisionFeedback', feedback);
    form.append('aspectRatio', getPayload().aspectRatio);

    const response = await fetchGeneration('/api/generate', {
      method: 'POST',
      body: form
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || '重产失败');
    }

    previewImage.src = `${data.imageUrl}?t=${Date.now()}`;
    currentResultUrl = data.imageUrl;
    previewImage.style.display = 'block';
    emptyPreview.style.display = 'none';
    promptOutput.value = data.prompt || prompt;
    await refreshUsageLog(data.usageLog);
    downloadLink.href = data.imageUrl;
    downloadLink.hidden = false;
    if (batchItems[selectedBatchIndex]) {
      batchItems[selectedBatchIndex] = {
        ...batchItems[selectedBatchIndex],
        status: 'done',
        imageUrl: data.imageUrl,
        prompt: data.prompt
      };
      renderBatchList();
    }
    setMessage('已按批注重产当前这张图。');
  } catch (error) {
    if (batchItems[selectedBatchIndex]?.status === 'running') {
      batchItems[selectedBatchIndex] = {
        ...batchItems[selectedBatchIndex],
        status: isGenerationStopError(error) ? 'pending' : 'failed',
        error: getReadableError(error, '重产失败')
      };
      renderBatchList();
    }
    setMessage(getReadableError(error, '重产失败'), !isGenerationStopError(error));
  } finally {
    regenerateCurrentBtn.disabled = false;
    regenerateCurrentBtn.textContent = originalText;
    revisionPromptBtn.disabled = false;
    setLoading(false);
  }
});

batchGenerateBtn.addEventListener('click', async () => {
  if (!sourceFiles.length && !isPosterMode() && !isProductLayoutMode()) {
    setMessage('请先上传一张封面原图。', true);
    return;
  }
  if (isProductLayoutMode() && !sourceFiles.length) {
    setMessage('请先按产品顺序上传产品图。', true);
    return;
  }
  const originalText = batchGenerateBtn.textContent;
  batchGenerateBtn.disabled = true;
  batchGenerateBtn.textContent = '批量生成中...';
  generateBtn.disabled = true;
  promptBtn.disabled = true;
  stopGenerationRequested = false;
  downloadLink.hidden = true;
  setLoading(true, '正在批量生成', isProductLayoutMode() ? `会先生成${isReviewMode() ? '点评' : '参数表'}参考图，再调用生图 API 输出封面。` : isPosterMode() ? '会并发生成本地大字报卡片，全部完成后统一刷新结果。' : '会并发提交多张图片，全部完成后统一刷新结果。', { canStop: true });
  setMessage('已开始批量生成，请等待结果。');

  try {
    if (!batchItems.length) {
      setMessage('正在准备内容队列，然后批量生成封面...');
      await generateBatchPlan();
    }
    if (stopGenerationRequested) throw makeAbortError();
    const itemsToGenerate = batchItems.filter((item) => item.status !== 'done');
    if (!itemsToGenerate.length) {
      setMessage('当前队列已经全部生成完成。');
      return;
    }
    const runningIds = new Set(itemsToGenerate.map((item) => item.id));
    batchItems = batchItems.map((item) => runningIds.has(item.id)
      ? { ...item, status: 'running', error: '' }
      : item
    );
    renderBatchList();
    const concurrency = clampClientConcurrency(fields.concurrency.value);
    let finished = 0;
    let success = 0;
    let failed = 0;
    setLoading(true, `正在并发生成 ${itemsToGenerate.length} 张`, `当前并发数 ${concurrency}，每完成一张会立刻显示。`, { canStop: true });
    setMessage(`准备并发生成剩余 ${itemsToGenerate.length} 张封面，并发数 ${fields.concurrency.value}。`);

    await runClientPool(itemsToGenerate, concurrency, async (item) => {
      try {
        const data = await generateSingleItem(item);
        success += 1;
        batchItems = batchItems.map((entry) => entry.id === item.id
          ? {
              ...entry,
              status: 'done',
              imageUrl: data.imageUrl,
              prompt: data.prompt,
              taskId: data.taskId,
              sourceIndex: item.sourceIndex,
              sourceName: item.sourceName
            }
          : entry
        );
        previewImage.src = `${data.imageUrl}?t=${Date.now()}`;
        currentResultUrl = data.imageUrl;
        previewImage.style.display = 'block';
        emptyPreview.style.display = 'none';
        downloadLink.href = data.imageUrl;
        downloadLink.hidden = false;
        await refreshUsageLog(data.usageLog);
      } catch (error) {
        if (!isGenerationStopError(error)) failed += 1;
        batchItems = batchItems.map((entry) => entry.id === item.id
          ? {
              ...entry,
              status: isGenerationStopError(error) ? 'pending' : 'failed',
              error: getReadableError(error, '生成失败')
            }
          : entry
        );
      } finally {
        finished += 1;
        renderBatchList();
        if (!stopGenerationRequested) {
          setLoading(true, `正在并发生成 ${itemsToGenerate.length} 张`, `已完成 ${finished}/${itemsToGenerate.length}，成功 ${success}，失败 ${failed}。`, { canStop: true });
          setMessage(`批量生成中：已完成 ${finished}/${itemsToGenerate.length}，成功 ${success}，失败 ${failed}。`);
        }
      }
    });

    const doneCount = batchItems.filter((item) => item.status === 'done').length;
    if (stopGenerationRequested) {
      markRunningItemsStopped();
      setMessage(`已停止生成：本轮成功 ${success} 张，未完成的任务保留为待生成。`);
    } else {
      setMessage(`批量生成完成：成功 ${doneCount} 张，失败 ${batchItems.length - doneCount} 张，并发数 ${concurrency}。`);
    }
  } catch (error) {
    batchItems = batchItems.map((item) => item.status === 'running'
      ? {
          ...item,
          status: isGenerationStopError(error) ? 'pending' : 'failed',
          error: getReadableError(error, '批量生成失败')
        }
      : item
    );
    renderBatchList();
    setMessage(getReadableError(error, '批量生成失败'), !isGenerationStopError(error));
  } finally {
    batchGenerateBtn.disabled = false;
    batchGenerateBtn.textContent = originalText;
    generateBtn.disabled = false;
    promptBtn.disabled = false;
    setLoading(false);
  }
});

renderBatchList();
renderFutureRules();
syncVisualModeUi();
updateRestoreConfigButton();
loadStyleTemplates().catch(() => {
  styleTemplateSummary.textContent = '模版库读取失败';
});
loadComparisonStyles().catch(() => {});
refreshUsageBtn.addEventListener('click', () => {
  refreshUsageLog().catch((error) => setMessage(error.message || '读取消耗日志失败', true));
});
refreshUsageLog().catch(() => {});
