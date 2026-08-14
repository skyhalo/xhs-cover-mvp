import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import express from 'express';
import multer from 'multer';
import OpenAI, { toFile } from 'openai';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ZipArchive } = require('archiver');
const app = express();
const port = Number(process.env.PORT || 5177);
const dataDir = process.env.XHS_DATA_DIR ? path.resolve(process.env.XHS_DATA_DIR) : __dirname;
const uploadDir = path.join(dataDir, 'uploads');
const outputDir = path.join(dataDir, 'outputs');
const logDir = path.join(dataDir, 'logs');
const usageLogPath = path.join(logDir, 'usage.ndjson');
const styleTemplatePath = path.join(dataDir, 'style-templates.json');
const bundledStyleTemplatePath = path.join(__dirname, 'style-templates.json');
const comparisonStylePath = path.join(dataDir, 'comparison-table-styles.json');
const bundledComparisonStylePath = path.join(__dirname, 'comparison-table-styles.json');
const cardTemplateDir = path.join(__dirname, 'assets', 'card-templates');
const cardFontDir = path.join(__dirname, 'assets', 'fonts');
const maxBatchCount = 60;
const textApiKey = process.env.OPENAI_TEXT_API_KEY || process.env.OPENAI_API_KEY;
const textBaseUrl = process.env.OPENAI_TEXT_BASE_URL;
const imageApiKey = process.env.OPENAI_IMAGE_API_KEY || process.env.OPENAI_API_KEY;
const runningHubImageApiKey = process.env.RUNNINGHUB_IMAGE_API_KEY;
const runningHubBaseUrl = (process.env.RUNNINGHUB_BASE_URL || 'https://www.runninghub.ai').replace(/\/+$/, '');
const runningHubModelName = process.env.RUNNINGHUB_MODEL_NAME || 'gpt-image-2.0/edit/economy';
const runningHubImageEndpoint = normalizeRunningHubOpenApiEndpoint(process.env.RUNNINGHUB_IMAGE_ENDPOINT || '/rhart-image-g-2/image-to-image');
const runningHubQueryEndpoint = normalizeRunningHubOpenApiEndpoint(process.env.RUNNINGHUB_QUERY_ENDPOINT || '/query');
const runningHubUploadEndpoint = normalizeRunningHubOpenApiEndpoint(process.env.RUNNINGHUB_UPLOAD_ENDPOINT || '/media/upload/binary');

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

app.use(express.json({ limit: '1mb' }));
app.use('/outputs', express.static(outputDir));
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

function createStopServerHandler() {
  return (_req, res) => {
    res.json({
      ok: true,
      message: '已请求停止当前生成。服务会继续保持可用。'
    });
  };
}

app.post('/api/stop-server', createStopServerHandler());

const cardTemplateFiles = fs.existsSync(cardTemplateDir)
  ? fs.readdirSync(cardTemplateDir)
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .sort()
    .map((name) => path.join(cardTemplateDir, name))
  : [];

function firstExistingPath(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || paths[0];
}

const cardFonts = {
  hiragino: {
    label: '冬青黑体 W6',
    family: 'XhsHiragino',
    cssFamily: '"Hiragino Sans GB", "Heiti SC", sans-serif',
    file: firstExistingPath([
      path.join(cardFontDir, 'HiraginoSansGB.ttc'),
      '/System/Library/Fonts/Hiragino Sans GB.ttc',
      path.join(cardFontDir, 'AlimamaFangYuanTiVF.ttf')
    ])
  },
  yuanti: {
    label: '圆体-简 粗体',
    family: 'XhsYuanti',
    cssFamily: '"Yuanti SC", "STYuanti-SC-Bold", "Heiti SC", sans-serif',
    file: firstExistingPath([
      path.join(cardFontDir, 'Yuanti.ttc'),
      '/System/Library/AssetsV2/com_apple_MobileAsset_Font8/4a418d1fa4860652a3241e8ee457806c8557fc64.asset/AssetData/Yuanti.ttc',
      path.join(cardFontDir, 'AlimamaFangYuanTiVF.ttf')
    ])
  },
  alimama: {
    label: '阿里妈妈方圆体',
    family: 'XhsAlimama',
    cssFamily: 'XhsAlimama, "Yuanti SC", "Heiti SC", sans-serif',
    file: path.join(cardFontDir, 'AlimamaFangYuanTiVF.ttf')
  },
  hanzipen: {
    label: '翩翩体-简 粗体',
    family: 'XhsHanzipen',
    cssFamily: '"HanziPen SC", "HanziPenSC-W5", "Kaiti SC", cursive',
    file: firstExistingPath([
      path.join(cardFontDir, 'Hanzipen.ttc'),
      '/System/Library/AssetsV2/com_apple_MobileAsset_Font8/a3c69464b629577766c23bcdb12ffbfe3759b923.asset/AssetData/Hanzipen.ttc',
      path.join(cardFontDir, 'AlimamaFangYuanTiVF.ttf')
    ])
  }
};

const curatedCardTemplateConfigs = [
  {
    id: 'paper_final',
    name: '纸张求助',
    assetIndex: 0,
    font: 'alimama',
    box: { x: 145, y: 420, width: 850, height: 560 },
    align: 'left',
    mainColor: '#2d221c',
    accentColor: '#269170',
    highlightMode: 'color',
    startSize: 154
  },
  {
    id: 'purple_vs',
    name: '紫色引号',
    assetIndex: 21,
    font: 'yuanti',
    box: { x: 140, y: 455, width: 910, height: 580 },
    align: 'left',
    mainColor: '#ffffff',
    accentColor: '#c9ff48',
    highlightMode: 'color',
    startSize: 154
  },
  {
    id: 'orange_advice',
    name: '橙色强对比',
    assetIndex: 6,
    font: 'hiragino',
    box: { x: 130, y: 450, width: 940, height: 570 },
    align: 'left',
    mainColor: '#fffdf8',
    accentColor: '#ffeb56',
    highlightMode: 'marker',
    startSize: 150
  },
  {
    id: 'green_note',
    name: '浅绿手账',
    assetIndex: 12,
    font: 'yuanti',
    box: { x: 135, y: 450, width: 910, height: 590 },
    align: 'left',
    mainColor: '#165644',
    accentColor: '#ffdb42',
    highlightMode: 'marker',
    startSize: 154
  },
  {
    id: 'clean_handwrite',
    name: '手写留白',
    assetIndex: 16,
    font: 'hanzipen',
    box: { x: 145, y: 450, width: 920, height: 610 },
    align: 'left',
    mainColor: '#232f36',
    accentColor: '#2a88d2',
    highlightMode: 'color',
    startSize: 150
  },
  {
    id: 'magenta_quote',
    name: '玫红引号',
    assetIndex: 22,
    font: 'alimama',
    box: { x: 120, y: 455, width: 950, height: 590 },
    align: 'left',
    mainColor: '#fffefa',
    accentColor: '#ffec4b',
    highlightMode: 'color',
    startSize: 150
  },
  {
    id: 'torn_paper',
    name: '撕纸网格',
    assetIndex: 7,
    font: 'alimama',
    box: { x: 145, y: 410, width: 860, height: 570 },
    align: 'left',
    mainColor: '#2c211b',
    accentColor: '#eec430',
    highlightMode: 'marker',
    startSize: 150
  },
  {
    id: 'soft_blue',
    name: '浅蓝留白',
    assetIndex: 15,
    font: 'hiragino',
    box: { x: 140, y: 430, width: 900, height: 590 },
    align: 'left',
    mainColor: '#1d4158',
    accentColor: '#238fd0',
    highlightMode: 'color',
    startSize: 150
  }
];

const generatedCardTemplateStyles = [
  {
    name: '纸感留白',
    font: 'alimama',
    box: { x: 135, y: 420, width: 900, height: 590 },
    align: 'left',
    mainColor: '#2d221c',
    accentColor: '#218365',
    highlightMode: 'color',
    startSize: 154
  },
  {
    name: '奶油手账',
    font: 'yuanti',
    box: { x: 140, y: 445, width: 900, height: 590 },
    align: 'left',
    mainColor: '#31423b',
    accentColor: '#f0bd30',
    highlightMode: 'marker',
    startSize: 152
  },
  {
    name: '橙色高亮',
    font: 'hiragino',
    box: { x: 125, y: 430, width: 940, height: 600 },
    align: 'left',
    mainColor: '#fffdf8',
    accentColor: '#ffe45a',
    highlightMode: 'marker',
    startSize: 150
  },
  {
    name: '蓝色清爽',
    font: 'hiragino',
    box: { x: 140, y: 430, width: 910, height: 600 },
    align: 'left',
    mainColor: '#1d4158',
    accentColor: '#238fd0',
    highlightMode: 'color',
    startSize: 150
  },
  {
    name: '手写便签',
    font: 'hanzipen',
    box: { x: 145, y: 450, width: 910, height: 600 },
    align: 'left',
    mainColor: '#25323a',
    accentColor: '#2a88d2',
    highlightMode: 'color',
    startSize: 148
  },
  {
    name: '强情绪引号',
    font: 'alimama',
    box: { x: 120, y: 450, width: 950, height: 590 },
    align: 'left',
    mainColor: '#fffefa',
    accentColor: '#ffec4b',
    highlightMode: 'color',
    startSize: 150
  }
];

const cardTemplateConfigs = cardTemplateFiles.map((_, assetIndex) => {
  const curated = curatedCardTemplateConfigs.find((template) => template.assetIndex === assetIndex);
  if (curated) return curated;
  const style = generatedCardTemplateStyles[assetIndex % generatedCardTemplateStyles.length];
  return {
    ...style,
    id: `template_${String(assetIndex + 1).padStart(2, '0')}`,
    name: `${style.name} ${assetIndex + 1}`,
    assetIndex
  };
});

function isPosterMode(value) {
  return value === 'poster' || value === 'card' || value === 'dazibao';
}

function isComparisonMode(value) {
  return value === 'comparison' || value === 'compare' || value === 'parameter-table';
}

function isReviewMode(value) {
  return value === 'review' || value === 'product-review' || value === 'commentary';
}

function isProductLayoutMode(value) {
  return isComparisonMode(value) || isReviewMode(value);
}

function parseComparisonStyleIds(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\n，、/|]+/);
  return Array.from(new Set(source.map((id) => String(id || '').trim()).filter(Boolean)));
}

function pickSelectedComparisonStyleId(styleIds = [], index = 0) {
  return styleIds.length ? styleIds[index % styleIds.length] : '';
}

function isStyleTemplateMode(value) {
  return String(value || '').startsWith('template:');
}

function getStyleTemplateId(value) {
  return String(value || '').replace(/^template:/, '').trim();
}

function slugifyTemplateId(value) {
  const ascii = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42);
  return ascii || `style-${Date.now()}`;
}

function readStyleTemplates() {
  const readablePath = fs.existsSync(styleTemplatePath) ? styleTemplatePath : bundledStyleTemplatePath;
  if (!fs.existsSync(readablePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(readablePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStyleTemplates(templates) {
  fs.writeFileSync(styleTemplatePath, `${JSON.stringify(templates, null, 2)}\n`);
}

const defaultComparisonStyle = {
  id: 'default-blue-table',
  name: '蓝白清爽表格',
  layout: 'classic-table',
  previewImage: '',
  titleColor: '#3f7fdc',
  headerBg: '#95b8f2',
  audienceBg: '#95b8f2',
  cellBg: '#f8fafc',
  rowAlt: '#eef4ff',
  gridColor: '#4b5563',
  textColor: '#0b1220',
  titleSize: 64,
  gridWidth: 1.5,
  mood: '清晰、理性、保姆级选购建议'
};
const comparisonLayouts = new Set(['classic-table', 'student-grid', 'major-rows', 'three-cards', 'series-bands']);

function readComparisonStyles() {
  const readStylesFile = (filePath) => {
    if (!fs.existsSync(filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const userStyles = readStylesFile(comparisonStylePath);
  const bundledStyles = readStylesFile(bundledComparisonStylePath);
  const merged = [];
  const seen = new Set();
  for (const style of [...userStyles, ...bundledStyles]) {
    const normalized = normalizeComparisonStyle(style, merged.length);
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    merged.push(normalized);
  }
  return merged.length ? merged : [defaultComparisonStyle];
}

function writeComparisonStyles(styles) {
  fs.writeFileSync(comparisonStylePath, `${JSON.stringify(styles, null, 2)}\n`);
}

function normalizeColor(value, fallback) {
  const text = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
}

function isLowSaturationGrayColor(value = '') {
  const match = String(value || '').match(/^#([0-9a-fA-F]{6})$/);
  if (!match) return false;
  const hex = match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return Math.max(r, g, b) - Math.min(r, g, b) < 28;
}

function styleMentionsRedBlackTitle(style = {}) {
  const text = `${style.name || ''} ${style.mood || ''} ${style.visualRules || ''} ${style.composition || ''}`.toLowerCase();
  return /红黑标题|红黑|标题.{0,12}红|型号.{0,12}红色强调|关键词.{0,12}红色强调|red.{0,12}title/.test(text);
}

function isUploadedComparisonStyle(style = {}) {
  return String(style.previewImage || '').startsWith('/outputs/');
}

function isNarrativeReviewStyle(style = {}) {
  const id = String(style.id || '').toLowerCase();
  const name = String(style.name || '');
  return id === 'style-1786525186423-mspuyw6v-1' || /竖排点评横评|逐款点评/.test(name);
}

function shouldUseSplitComparisonTitleColor(style = {}) {
  if (!isUploadedComparisonStyle(style)) return false;
  if (isNarrativeReviewStyle(style)) return false;
  return styleMentionsRedBlackTitle(style);
}

function topicDirectionRequestsUniformTitleColor(emphasisPlan = null) {
  const text = cleanComparisonText(emphasisPlan?.rawText || '');
  return /标题.{0,16}(整行|这一行|同一|统一|都|都是|全部).{0,16}(颜色|色|红色)|标题.{0,16}(同色|一种颜色)|整行.{0,8}(同色|同一种颜色)/.test(text);
}

function resolveUniformTitleColor(style = {}, emphasisPlan = null) {
  const text = cleanComparisonText(emphasisPlan?.rawText || '');
  if (topicDirectionRequestsUniformTitleColor(emphasisPlan) && /红色|标红|红字|红/.test(text)) {
    return emphasisPlan?.color || '#e11d2e';
  }
  return normalizeColor(style.titleColor, '#68408f');
}

function getComparisonTitlePalette(style = {}) {
  const titleColor = normalizeColor(style.titleColor, '#111827');
  const redBlack = shouldUseSplitComparisonTitleColor(style);
  const mainFallback = redBlack && isLowSaturationGrayColor(titleColor) ? '#111827' : titleColor;
  const accentFallback = redBlack ? '#e11d2e' : titleColor;
  return {
    main: normalizeColor(style.titleMainColor, mainFallback),
    accent: normalizeColor(style.titleAccentColor, accentFallback),
    section: normalizeColor(style.sectionTitleColor, accentFallback)
  };
}

function normalizeComparisonStyle(style = {}, index = 0) {
  const presets = [
    defaultComparisonStyle,
    { titleColor: '#176b4d', headerBg: '#b8dbc6', audienceBg: '#b8dbc6', cellBg: '#fbfdf9', rowAlt: '#edf6ef', gridColor: '#315344', textColor: '#12251c', mood: '绿色高级、清爽参数表' },
    { titleColor: '#2563eb', headerBg: '#bfdbfe', audienceBg: '#dbeafe', cellBg: '#ffffff', rowAlt: '#f1f5f9', gridColor: '#334155', textColor: '#0f172a', mood: '科技蓝、干净理性' },
    { titleColor: '#c2410c', headerBg: '#fed7aa', audienceBg: '#fdba74', cellBg: '#fff7ed', rowAlt: '#ffedd5', gridColor: '#7c2d12', textColor: '#1c1917', mood: '橙色种草、强推荐感' }
  ];
  const preset = presets[index % presets.length];
  const name = String(style.name || style.styleName || `参数表风格 ${index + 1}`).trim();
  return {
    id: String(style.id || slugifyTemplateId(name)).trim(),
    name,
    category: String(style.category || (isNarrativeReviewStyle(style) ? 'review' : 'comparison')).toLowerCase() === 'review' ? 'review' : 'comparison',
    layout: comparisonLayouts.has(style.layout) ? style.layout : (preset.layout || defaultComparisonStyle.layout),
    previewImage: String(style.previewImage || '').trim(),
    titleColor: normalizeColor(style.titleColor, preset.titleColor),
    titleMainColor: normalizeColor(style.titleMainColor, ''),
    titleAccentColor: normalizeColor(style.titleAccentColor, ''),
    sectionTitleColor: normalizeColor(style.sectionTitleColor, ''),
    headerBg: normalizeColor(style.headerBg, preset.headerBg),
    audienceBg: normalizeColor(style.audienceBg, preset.audienceBg),
    cellBg: normalizeColor(style.cellBg, preset.cellBg),
    rowAlt: normalizeColor(style.rowAlt, preset.rowAlt),
    gridColor: normalizeColor(style.gridColor, preset.gridColor),
    textColor: normalizeColor(style.textColor, preset.textColor),
    titleSize: Math.max(46, Math.min(76, Number(style.titleSize) || preset.titleSize || 64)),
    gridWidth: Math.max(1, Math.min(3, Number(style.gridWidth) || preset.gridWidth || 1.5)),
    mood: String(style.mood || preset.mood || '').trim(),
    bestFor: String(style.bestFor || '').trim(),
    composition: String(style.composition || '').trim(),
    visualRules: String(style.visualRules || '').trim(),
    copyStructure: String(style.copyStructure || '').trim(),
    createdAt: style.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function normalizeAnalysisText(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanComparisonText(item)).filter(Boolean).join('；');
  }
  return cleanComparisonText(value || '');
}

function pickComparisonLayoutFromAnalysis(value, fallback = defaultComparisonStyle.layout) {
  const text = cleanComparisonText(value || '').toLowerCase();
  if (comparisonLayouts.has(text)) return text;
  if (/series|band|横条|横向|彩带|分区/.test(text)) return 'series-bands';
  if (/student|grid|宫格|货架|平铺|学生/.test(text)) return 'student-grid';
  if (/major|row|清单|纵向|分层|专业/.test(text)) return 'major-rows';
  if (/three|card|三列|卡片|并列/.test(text)) return 'three-cards';
  if (/table|表格|密表|参数表/.test(text)) return 'classic-table';
  return comparisonLayouts.has(fallback) ? fallback : defaultComparisonStyle.layout;
}

function mergeComparisonStyleAnalysis(baseStyle = {}, analysis = {}, index = 0) {
  const base = normalizeComparisonStyle(baseStyle, index);
  const name = normalizeAnalysisText(analysis.styleName || analysis.name || analysis.templateName);
  return normalizeComparisonStyle({
    ...base,
    name: name || base.name,
    layout: pickComparisonLayoutFromAnalysis(analysis.layout || analysis.layoutType || analysis.compositionType, base.layout),
    mood: normalizeAnalysisText(analysis.mood || analysis.visualMood || analysis.styleMood) || base.mood,
    bestFor: normalizeAnalysisText(analysis.bestFor || analysis.suitableFor || analysis.useCases) || base.bestFor,
    composition: normalizeAnalysisText(analysis.composition || analysis.compositionRules || analysis.layoutRules) || base.composition,
    visualRules: normalizeAnalysisText(analysis.visualRules || analysis.graphicRules || analysis.designRules || analysis.doList) || base.visualRules,
    copyStructure: normalizeAnalysisText(analysis.copyStructure || analysis.copywritingFormula || analysis.informationStructure) || base.copyStructure,
    titleMainColor: normalizeColor(analysis.titleMainColor || analysis.mainTitleColor, base.titleMainColor),
    titleAccentColor: normalizeColor(analysis.titleAccentColor || analysis.accentTitleColor || analysis.accentColor, base.titleAccentColor),
    sectionTitleColor: normalizeColor(analysis.sectionTitleColor || analysis.sectionAccentColor, base.sectionTitleColor)
  }, index);
}

function pickComparisonStyle(styleId = '', category = '') {
  const requestedCategory = category === 'review' ? 'review' : category === 'comparison' ? 'comparison' : '';
  const styles = readComparisonStyles().filter((style) => !requestedCategory || style.category === requestedCategory);
  if (styleId) {
    const found = styles.find((style) => style.id === styleId);
    if (found) return found;
  }
  return styles[Math.floor(Math.random() * styles.length)] || (requestedCategory === 'review'
    ? readComparisonStyles().find((style) => style.category === 'review')
    : defaultComparisonStyle);
}

function normalizeStyleTemplate(template = {}) {
  const name = String(template.styleName || template.name || '爆款封面模版').trim();
  return {
    id: String(template.id || slugifyTemplateId(name)).trim(),
    name,
    bestFor: String(template.bestFor || '').trim(),
    firstGlanceHook: String(template.firstGlanceHook || '').trim(),
    emotionalEngine: String(template.emotionalEngine || '').trim(),
    compositionRules: Array.isArray(template.compositionRules) ? template.compositionRules : [],
    typographyRules: Array.isArray(template.typographyRules) ? template.typographyRules : [],
    colorRules: Array.isArray(template.colorRules) ? template.colorRules : [],
    graphicDevices: Array.isArray(template.graphicDevices) ? template.graphicDevices : [],
    productMappingRules: Array.isArray(template.productMappingRules) ? template.productMappingRules : [],
    copywritingFormula: Array.isArray(template.copywritingFormula) ? template.copywritingFormula : [],
    doList: Array.isArray(template.doList) ? template.doList : [],
    avoidList: Array.isArray(template.avoidList) ? template.avoidList : [],
    imagePromptBlock: String(template.imagePromptBlock || '').trim(),
    sourceCount: Number(template.sourceCount) || 0,
    createdAt: template.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function resolveStyleTemplate(body = {}) {
  const requested = getStyleTemplateId(body.styleTemplateId || body.visualMode);
  if (!requested) return null;
  return readStyleTemplates().find((template) => template.id === requested) || null;
}

function formatStyleTemplateForPrompt(template) {
  if (!template) return '';
  const lineList = (label, values) => {
    const list = Array.isArray(values) ? values.filter(Boolean) : [];
    return list.length ? `${label}\n${list.map((item) => `- ${item}`).join('\n')}` : '';
  };
  return [
    `## 已选爆款封面模版：${template.name}`,
    template.bestFor ? `适用方向：${template.bestFor}` : '',
    template.firstGlanceHook ? `0.5 秒钩子：${template.firstGlanceHook}` : '',
    template.emotionalEngine ? `情绪引擎：${template.emotionalEngine}` : '',
    lineList('构图规则：', template.compositionRules),
    lineList('字体规则：', template.typographyRules),
    lineList('配色规则：', template.colorRules),
    lineList('视觉元素：', template.graphicDevices),
    lineList('新素材映射规则：', template.productMappingRules),
    lineList('文案公式：', template.copywritingFormula),
    lineList('必须保留：', template.doList),
    lineList('必须避免：', template.avoidList),
    template.imagePromptBlock ? `可复用图片提示词：\n${template.imagePromptBlock}` : '',
    '生成时只迁移该模版的构图语法、信息层级、字体气质、配色和注意力机制；不要复刻参考图中的具体人物、商标、水印或独有素材。'
  ].filter(Boolean).join('\n');
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cleanComparisonText(value) {
  return String(value ?? '')
    .replace(/\r/g, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isMissingComparisonText(value) {
  const text = cleanComparisonText(value)
    .replace(/[。.!！\s]/g, '')
    .toLowerCase();
  return !text || /^(未提供|未提及|未写|没写|无|暂无|不详|未知|n\/a|na|null|none|-)$/.test(text);
}

function visualCharWidth(char) {
  if (/^[\x00-\x7F]$/.test(char) && !/[，。？！：；、]/.test(char)) return 0.55;
  return 1;
}

function cleanCardText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function wrapCardText(text, maxUnits, maxLines = 4) {
  const cleaned = cleanCardText(text);
  if (!cleaned) return ['小红书封面文案'];
  if (cleaned.includes('\n')) {
    return cleaned.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, maxLines);
  }
  const source = cleaned.replace(/[，。！？；、]/g, ' ').replace(/\s+/g, '');
  const lines = [];
  let current = '';
  let units = 0;
  for (const char of Array.from(source)) {
    const width = visualCharWidth(char);
    if (current && units + width > maxUnits && lines.length < maxLines - 1) {
      lines.push(current);
      current = char;
      units = width;
    } else {
      current += char;
      units += width;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

function approximateTextWidth(text, size) {
  return Array.from(String(text || '')).reduce((sum, char) => sum + visualCharWidth(char) * size * 0.92, 0);
}

function fitCardText({ text, box, startSize = 154, minSize = 86, maxLines = 4 }) {
  for (let size = startSize; size >= minSize; size -= 4) {
    const maxUnits = Math.max(5, Math.floor(box.width / (size * 0.92)));
    const lines = wrapCardText(text, maxUnits, maxLines);
    const gap = Math.round(size * 0.22);
    const totalHeight = lines.length * size + (lines.length - 1) * gap;
    if (totalHeight <= box.height && lines.every((line) => approximateTextWidth(line, size) <= box.width)) {
      return { lines, size, gap };
    }
  }
  const size = minSize;
  return {
    lines: wrapCardText(text, Math.max(5, Math.floor(box.width / (size * 0.92))), maxLines),
    size,
    gap: Math.round(size * 0.22)
  };
}

function parseAccentWords(value, text = '') {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(/[,\n，、/|]+/);
  const words = raw
    .map((word) => String(word || '').trim())
    .filter((word) => word && word.length <= 6);
  if (words.length) return words.slice(0, 2);
  const preferred = ['美的', '华为', '全屋智能', '新装修', '灯光', '氛围感', '生活习惯', '顺手', '舒服', '后悔'];
  const found = preferred.filter((word) => String(text || '').includes(word));
  if (found.length) return found.slice(0, 2);
  const candidates = Array.from(new Set(String(text || '').match(/[\u4e00-\u9fa5A-Za-z0-9]{2,6}/g) || []));
  return candidates
    .filter((word) => !/^(真的|到底|怎么|还是|全屋|智能|求助|建议|新家)$/.test(word))
    .slice(0, 1);
}

function pickCardTemplate(item = {}) {
  const id = String(item.cardTemplate || item.templateId || '').trim();
  if (id) {
    const byId = cardTemplateConfigs.find((template) => template.id === id);
    if (byId) return byId;
  }
  const numericId = Number(item.id);
  const index = Number.isFinite(numericId) ? numericId - 1 : 0;
  return cardTemplateConfigs[((index % cardTemplateConfigs.length) + cardTemplateConfigs.length) % cardTemplateConfigs.length];
}

function posterTopicHasMideaHuawei(context = {}) {
  const text = `${context.topic || ''}${context.noteBody || ''}${context.topicDirection || ''}`;
  return /美的/.test(text) && /华为/.test(text) && /全屋智能/.test(text);
}

function mideaHuaweiPosterVariant(index = 0) {
  const variants = [
    '决赛圈了\n全屋智能\n美的还是华为',
    '全屋智能决赛圈\n美的还是华为\n求建议',
    '新装修做全屋智能\n美的华为二选一\n求真实建议',
    '决赛圈求助\n全屋智能选美的\n还是选华为',
    '新家全屋智能\n卡在最后一步\n美的还是华为',
    '决赛圈真的来了\n全屋智能\n美的还是华为'
  ];
  return variants[index % variants.length];
}

function repairPosterCardText(cardText, context = {}, index = 0) {
  const cleaned = cleanCardText(cardText);
  const compact = cleaned.replace(/\n/g, '');
  if (posterTopicHasMideaHuawei(context) && (compact.length > 24 || !cleaned.includes('\n'))) {
    return mideaHuaweiPosterVariant(index);
  }
  if (cleaned.includes('\n')) return cleaned;
  if (compact.length <= 12) return compact;
  const maxUnits = compact.length > 24 ? 8 : 9;
  return wrapCardText(compact, maxUnits, 4).join('\n');
}

function fontCssForCard(fontKey) {
  const font = cardFonts[fontKey];
  if (!font || !fs.existsSync(font.file)) return '';
  if (!font.file.startsWith(cardFontDir)) return '';
  const b64 = fs.readFileSync(font.file).toString('base64');
  return `@font-face{font-family:${font.family};src:url(data:font/ttf;base64,${b64}) format('truetype');font-weight:700;font-style:normal;}`;
}

function splitLineByAccents(line, accents) {
  const parts = [];
  let rest = line;
  while (rest) {
    const found = accents
      .map((word) => ({ word, index: rest.indexOf(word) }))
      .filter((entry) => entry.word && entry.index >= 0)
      .sort((a, b) => a.index - b.index || b.word.length - a.word.length)[0];
    if (!found) {
      parts.push({ text: rest, accent: false });
      break;
    }
    if (found.index > 0) parts.push({ text: rest.slice(0, found.index), accent: false });
    parts.push({ text: found.word, accent: true });
    rest = rest.slice(found.index + found.word.length);
  }
  return parts.filter((part) => part.text);
}

function renderCardTextSvg({ text, template, accentWords }) {
  const box = template.box;
  const { lines, size, gap } = fitCardText({
    text,
    box,
    startSize: template.startSize || 154,
    maxLines: template.maxLines || 4
  });
  const font = cardFonts[template.font] || cardFonts.alimama;
  const totalHeight = lines.length * size + (lines.length - 1) * gap;
  let y = box.y + Math.round((box.height - totalHeight) / 2) + size;
  const elements = [];

  for (const line of lines) {
    const width = approximateTextWidth(line, size);
    const x = template.align === 'center' ? box.x + Math.round((box.width - width) / 2) : box.x;
    if (template.highlightMode === 'marker' || template.highlightMode === 'pill') {
      for (const word of accentWords) {
        const index = line.indexOf(word);
        if (index >= 0) {
          const beforeWidth = approximateTextWidth(line.slice(0, index), size);
          const wordWidth = approximateTextWidth(word, size);
          const markerY = template.highlightMode === 'pill' ? y - size * 0.82 : y - size * 0.28;
          const markerHeight = template.highlightMode === 'pill' ? size * 0.82 : size * 0.24;
          const radius = template.highlightMode === 'pill' ? 30 : 16;
          elements.push(`<rect x="${Math.round(x + beforeWidth - 14)}" y="${Math.round(markerY)}" width="${Math.round(wordWidth + 28)}" height="${Math.round(markerHeight)}" rx="${radius}" fill="${template.accentColor}" opacity="0.96"/>`);
        }
      }
    }
    const parts = splitLineByAccents(line, accentWords);
    let textSvg = `<text x="${Math.round(x)}" y="${Math.round(y)}" font-family="${escapeXml(font.cssFamily || font.family)}" font-size="${size}" font-weight="700" fill="${template.mainColor}" dominant-baseline="alphabetic">`;
    for (const part of parts) {
      const fill = part.accent && template.highlightMode === 'color' ? template.accentColor : template.mainColor;
      textSvg += `<tspan fill="${fill}">${escapeXml(part.text)}</tspan>`;
    }
    textSvg += '</text>';
    elements.push(textSvg);
    y += size + gap;
  }

  return elements.join('\n');
}

const comparisonRows = [
  { key: 'price', label: '到手价', height: 76 },
  { key: 'processor', label: '处理器', height: 108 },
  { key: 'memoryStorage', label: '内存\n硬盘', height: 108 },
  { key: 'screen', label: '屏幕\n参数', height: 144 },
  { key: 'weightThickness', label: '重量\n厚度', height: 108 },
  { key: 'battery', label: '电池\n续航', height: 108 },
  { key: 'highlights', label: '核心\n亮点', height: 164 },
  { key: 'audience', label: '适合\n人群', height: 152 }
];

const comparisonKnownKeys = new Set(['name', 'price', 'processor', 'memoryStorage', 'screen', 'weightThickness', 'battery', 'highlights', 'audience', 'review']);
const comparisonEvidenceKeywords = {
  price: ['到手价', '价格', '售价', '促销', '优惠', '预算', '元'],
  processor: ['处理器', 'CPU', '芯片', 'TDP', '性能释放'],
  memoryStorage: ['内存', '硬盘', '存储', 'SSD', 'DDR', 'LPDDR'],
  screen: ['屏幕', '刷新率', '分辨率', 'OLED', 'LCD', 'Hz', 'nits', 'nit', '护眼'],
  weightThickness: ['重量', '厚度', '轻薄', 'kg', 'mm'],
  battery: ['电池', '续航', 'Wh', '快充', 'PD'],
  highlights: ['核心亮点', '亮点', '优势', '卖点', '特点'],
  audience: ['适合人群', '目标人群', '适用人群', '人群']
};
const strictDimensionEvidenceKeys = new Set(['highlights', 'audience']);

function isComparisonDataUseful(data) {
  return Array.isArray(data?.products) && data.products.some((product) => product?.name);
}

function normalizeComparisonExtraFields(fields = []) {
  if (!Array.isArray(fields)) return [];
  const seen = new Set();
  return fields.map((field) => ({
    label: cleanComparisonText(field.label || field.name || ''),
    value: isMissingComparisonText(field.value || field.text || '') ? '' : cleanComparisonText(field.value || field.text || '')
  })).filter((field) => {
    if (!field.label || !field.value || seen.has(field.label)) return false;
    seen.add(field.label);
    return true;
  }).slice(0, 8);
}

function normalizeComparisonData(data = {}, fallbackTitle = '') {
  const products = Array.isArray(data.products) ? data.products : [];
  const sourceText = arguments.length >= 3 ? arguments[2] : '';
  let normalizedProducts = products.slice(0, 6).map((product, index) => {
    const extraFields = normalizeComparisonExtraFields(product.extraFields);
    for (const [key, value] of Object.entries(product || {})) {
      if (comparisonKnownKeys.has(key) || key === 'extraFields' || value == null) continue;
      const text = typeof value === 'string' || typeof value === 'number'
        ? isMissingComparisonText(value) ? '' : cleanComparisonText(value)
        : '';
      if (text) extraFields.push({ label: key, value: text });
    }
    return {
      name: cleanComparisonText(product.name || `产品 ${index + 1}`),
      price: isMissingComparisonText(product.price || '') ? '' : cleanComparisonText(product.price || ''),
      processor: isMissingComparisonText(product.processor || '') ? '' : cleanComparisonText(product.processor || ''),
      memoryStorage: isMissingComparisonText(product.memoryStorage || product.memory || '') ? '' : cleanComparisonText(product.memoryStorage || product.memory || ''),
      screen: isMissingComparisonText(product.screen || '') ? '' : cleanComparisonText(product.screen || ''),
      weightThickness: isMissingComparisonText(product.weightThickness || product.weight || '') ? '' : cleanComparisonText(product.weightThickness || product.weight || ''),
      battery: isMissingComparisonText(product.battery || '') ? '' : cleanComparisonText(product.battery || ''),
      highlights: isMissingComparisonText(product.highlights || '') ? '' : cleanComparisonText(product.highlights || ''),
      audience: isMissingComparisonText(product.audience || '') ? '' : cleanComparisonText(product.audience || ''),
      review: isMissingComparisonText(product.review || product.comment || product.commentary || '') ? '' : cleanComparisonText(product.review || product.comment || product.commentary || ''),
      extraFields: normalizeComparisonExtraFields(extraFields)
    };
  });
  if (sourceText) {
    normalizedProducts = filterComparisonProductsBySourceEvidence(normalizedProducts, sourceText);
  }
  const rows = buildComparisonRows(normalizedProducts);
  return {
    title: cleanComparisonText(data.title || fallbackTitle || '参数对比表'),
    subtitle: cleanComparisonText(data.subtitle || ''),
    products: normalizedProducts,
    rows
  };
}

function getProductFieldValue(product, row) {
  if (!product || !row) return '';
  if (row.key) return String(product[row.key] || '').trim();
  const field = normalizeComparisonExtraFields(product.extraFields).find((item) => item.label === row.label);
  return String(field?.value || '').trim();
}

function compactComparisonEvidenceText(value) {
  return cleanComparisonText(value).replace(/\s+/g, '').toLowerCase();
}

function hasSourceKeywordEvidence(sourceCompact, keywords = []) {
  return keywords.some((keyword) => sourceCompact.includes(compactComparisonEvidenceText(keyword)));
}

function comparisonValueEvidenceTokens(value) {
  const text = cleanComparisonText(value);
  return Array.from(new Set(text.match(/[A-Za-z0-9][A-Za-z0-9.+/-]{1,}|[\u4e00-\u9fa5]{2,}/g) || []))
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !/^(产品|参数|适合|推荐|支持|提供|使用|不同|配置|场景|体系)$/.test(token))
    .slice(0, 12);
}

function hasSourceValueEvidence(sourceCompact, products, row) {
  for (const product of products) {
    const value = getProductFieldValue(product, row);
    for (const token of comparisonValueEvidenceTokens(value)) {
      if (sourceCompact.includes(compactComparisonEvidenceText(token))) return true;
    }
  }
  return false;
}

function hasComparisonRowSourceEvidence(row, products, sourceText) {
  const sourceCompact = compactComparisonEvidenceText(sourceText);
  if (!sourceCompact) return true;
  const labelText = String(row.label || '').replace(/\n/g, '');
  const keywords = row.key
    ? comparisonEvidenceKeywords[row.key] || [labelText]
    : [labelText];
  const labelEvidence = hasSourceKeywordEvidence(sourceCompact, keywords);
  if (row.key && strictDimensionEvidenceKeys.has(row.key)) {
    return labelEvidence;
  }
  return labelEvidence || hasSourceValueEvidence(sourceCompact, products, row);
}

function filterComparisonProductsBySourceEvidence(products = [], sourceText = '') {
  const filtered = products.map((product) => ({
    ...product,
    extraFields: normalizeComparisonExtraFields(product.extraFields)
  }));
  for (const row of comparisonRows) {
    if (!filtered.some((product) => getProductFieldValue(product, row))) continue;
    if (hasComparisonRowSourceEvidence(row, filtered, sourceText)) continue;
    for (const product of filtered) product[row.key] = '';
  }
  const extraLabels = [];
  for (const product of filtered) {
    for (const field of normalizeComparisonExtraFields(product.extraFields)) {
      if (!extraLabels.includes(field.label)) extraLabels.push(field.label);
    }
  }
  for (const label of extraLabels) {
    const row = { label };
    if (hasComparisonRowSourceEvidence(row, filtered, sourceText)) continue;
    for (const product of filtered) {
      product.extraFields = normalizeComparisonExtraFields(product.extraFields)
        .filter((field) => field.label !== label);
    }
  }
  return filtered;
}

function getProductFieldDisplayValue(product, row) {
  const value = getProductFieldValue(product, row);
  return isMissingComparisonText(value) ? '/' : value;
}

function extractComparisonEmphasisTerms(topicDirection = '') {
  const text = cleanComparisonText(topicDirection);
  const terms = [];
  const knownBrands = ['荣耀', '联想', 'ThinkBook', '小新', 'MagicBook', '华为', '苹果', '小米', '惠普', '戴尔', '华硕', '宏碁'];
  for (const brand of knownBrands) {
    if (text.includes(brand) && !terms.includes(brand)) terms.push(brand);
  }
  for (const match of text.matchAll(/(?:突出|推荐|主推|强调|重点看|优先选)\s*([\u4e00-\u9fa5A-Za-z0-9+ -]{2,18})/g)) {
    const term = cleanComparisonText(match[1]).replace(/[，。；、\s].*$/, '');
    if (term && term.length <= 18 && !terms.includes(term)) terms.push(term);
  }
  return terms.slice(0, 6);
}

function buildComparisonEmphasisPlan(data = {}, topicDirection = '') {
  const text = cleanComparisonText(topicDirection);
  const wantsRed = /红色|标红|红字|红标|红色标注|加红|红色突出|红色强调/.test(text);
  const wantsBold = /加粗|粗体|突出|强调|重点/.test(text);
  const comparativeMode = /同一.{0,8}(配置|参数|维度)|客观对比|每一行|逐行|三者差异|先比较|横向比较|最突出|优势信息/.test(text);
  const terms = extractComparisonEmphasisTerms(text);
  const products = Array.isArray(data.products) ? data.products : [];
  const primaryProductIndexes = products
    .map((product, index) => ({ product, index }))
    .filter(({ product }) => terms.some((term) => compactComparisonEvidenceText(product.name).includes(compactComparisonEvidenceText(term))))
    .map(({ index }) => index);
  const active = Boolean((wantsRed || wantsBold || comparativeMode) && (terms.length || comparativeMode || /重点数据|优势|核心参数|推荐/.test(text)));
  const color = wantsRed || /红/.test(text) ? '#e11d2e' : '#111827';
  const primaryNames = primaryProductIndexes.map((index) => products[index]?.name).filter(Boolean);
  const promptText = active ? [
    `用户画面目标：${text}`,
    terms.length ? `重点对象/关键词：${terms.join('、')}` : '',
    primaryNames.length ? `主推产品：${primaryNames.join('、')}` : '',
    comparativeMode ? '客观对比模式：每一行参数必须先横向比较所有产品在同一维度下的差异，只把该行中客观最有优势的具体数值/规格标红加粗；例如同为价格维度，只标最低价；同为 TDP 维度，85W、46W、40W 中只标 85W。' : '',
    `视觉执行：${primaryNames.length ? '主推产品相关的' : ''}重点数字、价格、型号、规格值、优势参数必须用红色加粗突出；不要把整句或整段全部标红，普通解释文字保持黑/深灰；其他产品作为对照。`
  ].filter(Boolean).join('\n') : '';
  return {
    active,
    color,
    bold: wantsBold || active,
    comparativeMode,
    rawText: text,
    terms,
    primaryProductIndexes,
    promptText
  };
}

function isComparisonImportantRow(row = {}) {
  return ['price', 'processor', 'memoryStorage', 'screen', 'battery', 'weightThickness', 'highlights'].includes(row.key)
    || /价格|到手价|处理器|芯片|内存|硬盘|屏幕|电池|续航|重量|厚度|亮点|优势|核心|显卡|接口/.test(row.label || '');
}

function isComparisonEmphasisTarget({ product = {}, productIndex = -1, row = {}, value = '', emphasisPlan = null }) {
  if (!emphasisPlan?.active || !isComparisonImportantRow(row)) return false;
  if (emphasisPlan.comparativeMode) return true;
  const isPrimaryProduct = emphasisPlan.primaryProductIndexes.includes(productIndex);
  const text = `${product.name || ''} ${row.label || ''} ${value || ''}`;
  const matchesTerm = emphasisPlan.terms.some((term) => compactComparisonEvidenceText(text).includes(compactComparisonEvidenceText(term)));
  return isPrimaryProduct || matchesTerm;
}

function mergeComparisonRanges(ranges = []) {
  return ranges
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .reduce((merged, range) => {
      const last = merged[merged.length - 1];
      if (!last || range.start > last.end) {
        merged.push({ start: range.start, end: range.end });
      } else {
        last.end = Math.max(last.end, range.end);
      }
      return merged;
    }, []);
}

function metricDirectionForRow(row = {}, metricKey = '') {
  const label = `${row.key || ''} ${row.label || ''}`;
  if (metricKey === 'price-yuan') return 'min';
  if (/weight|thickness|重量|厚度/.test(label) && /^(kg|g|mm|cm)$/.test(metricKey)) return 'min';
  return 'max';
}

function addComparisonMetric(matches, text, pattern, metricKey, { highlightGroup = 1, valueGroup = 2, valueTransform = Number } = {}) {
  for (const match of text.matchAll(pattern)) {
    const raw = match[highlightGroup] || match[0];
    const offset = match[0].indexOf(raw);
    const start = (match.index || 0) + Math.max(0, offset);
    const numericText = match[valueGroup] || raw.match(/\d+(?:\.\d+)?/)?.[0] || raw;
    const numericValue = valueTransform(String(numericText).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(numericValue)) continue;
    matches.push({
      key: metricKey,
      value: numericValue,
      start,
      end: start + raw.length
    });
  }
}

function mergeComparisonMetricMatches(metrics = []) {
  const merged = [];
  for (const metric of metrics.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const overlapping = merged.find((item) => metric.start < item.end && metric.end > item.start);
    if (overlapping) {
      const existingLength = overlapping.end - overlapping.start;
      const nextLength = metric.end - metric.start;
      if (nextLength > existingLength) Object.assign(overlapping, metric);
    } else {
      merged.push(metric);
    }
  }
  return merged;
}

function extractComparisonMetricsForRow(text = '', row = {}) {
  const cleaned = cleanComparisonText(text);
  const metrics = [];
  addComparisonMetric(metrics, cleaned, /(?:到手|最低|低至|仅需|约|￥|¥)?\s*(\d+(?:\.\d+)?)\s*元/g, 'price-yuan', { highlightGroup: 1, valueGroup: 1 });
  addComparisonMetric(metrics, cleaned, /TDP\s*(?:最高|可达|约)?\s*((\d+(?:\.\d+)?)\s*W)/gi, 'tdp-w', { highlightGroup: 1, valueGroup: 2 });
  addComparisonMetric(metrics, cleaned, /((?:LPDDR|DDR)\dX?[-\s]?(\d{3,5})(?:MT\/s)?)/gi, 'memory-speed');
  addComparisonMetric(metrics, cleaned, /(\d+(?:\.\d+)?\s*Wh)/gi, 'wh');
  addComparisonMetric(metrics, cleaned, /(\d+(?:\.\d+)?\s*W)(?!h)/gi, row.key === 'processor' ? 'tdp-w' : 'w');
  addComparisonMetric(metrics, cleaned, /(\d+(?:\.\d+)?\s*Hz)/gi, 'hz');
  addComparisonMetric(metrics, cleaned, /(\d+(?:\.\d+)?\s*nits?)/gi, 'nits');
  addComparisonMetric(metrics, cleaned, /(\d+(?:\.\d+)?\s*K)/gi, 'k');
  addComparisonMetric(metrics, cleaned, /(\d+(?:\.\d+)?\s*kg)/gi, 'kg');
  addComparisonMetric(metrics, cleaned, /(\d+(?:\.\d+)?\s*g)/gi, 'g');
  addComparisonMetric(metrics, cleaned, /(\d+(?:\.\d+)?\s*mm)/gi, 'mm');
  addComparisonMetric(metrics, cleaned, /(\d+(?:\.\d+)?\s*cm)/gi, 'cm');
  return mergeComparisonMetricMatches(metrics);
}

function buildObjectiveComparisonRanges({ products = [], productIndex = -1, row = {}, value = '' }) {
  if (!Array.isArray(products) || products.length < 2) return [];
  const currentMetrics = extractComparisonMetricsForRow(value, row);
  if (!currentMetrics.length) return [];
  const metricsByProduct = products.map((product) => extractComparisonMetricsForRow(getProductFieldDisplayValue(product, row), row));
  const ranges = [];
  for (const metric of currentMetrics) {
    const candidates = metricsByProduct
      .map((items, index) => ({ index, item: items.find((candidate) => candidate.key === metric.key) }))
      .filter(({ item }) => item && Number.isFinite(item.value));
    if (candidates.length < 2) continue;
    const values = candidates.map(({ item }) => item.value);
    if (Math.max(...values) === Math.min(...values)) continue;
    const direction = metricDirectionForRow(row, metric.key);
    const bestValue = direction === 'min' ? Math.min(...values) : Math.max(...values);
    const isBest = Math.abs(metric.value - bestValue) < 0.000001;
    if (!isBest) continue;
    ranges.push({ start: metric.start, end: metric.end });
  }
  return mergeComparisonRanges(ranges);
}

function buildComparisonInlineEmphasisRanges({ products = [], product = {}, productIndex = -1, row = {}, value = '', emphasisPlan = null }) {
  const text = cleanComparisonText(value);
  if (!text || !isComparisonEmphasisTarget({ product, productIndex, row, value: text, emphasisPlan })) return [];
  if (emphasisPlan?.comparativeMode) {
    return buildObjectiveComparisonRanges({ products, productIndex, row, value: text });
  }
  const ranges = [];
  const addMatches = (pattern, groupIndex = 0) => {
    for (const match of text.matchAll(pattern)) {
      const target = groupIndex ? match[groupIndex] : match[0];
      if (!target) continue;
      const offset = match[0].indexOf(target);
      const start = (match.index || 0) + Math.max(0, offset);
      ranges.push({ start, end: start + target.length });
    }
  };

  addMatches(/\b[A-Z]\d\s*\d+G(?=版)?/gi);
  addMatches(/Ultra\s*[A-Z]\d\s*\d{3,4}[A-Z]?/gi);
  addMatches(/\b[A-Z]\d\s*\d{3,4}[A-Z]?\b/gi);
  addMatches(/\b(?:RTX|GTX|RX)\s*\d{3,5}(?:\s*Ti)?\b/gi);
  addMatches(/\b(?:LPDDR|DDR)\dX?[-\s]?\d{3,5}(?:MT\/s)?\b/gi);
  addMatches(/\d+(?:\.\d+)?(?=\s*元)/g);
  addMatches(/(?:到手|最低|低至|仅需|约|￥|¥)\s*(\d+(?:\.\d+)?)/g, 1);
  addMatches(/\d+(?:\.\d+)?\s*(?:Wh|W|GB|TB|Hz|nits?|kg|g|mm|cm|英寸|寸|K|核|线程|%)/gi);
  return mergeComparisonRanges(ranges).filter((range) => {
    const fragment = text.slice(range.start, range.end);
    return /\d/.test(fragment) && fragment.length >= 2 && fragment.length < Math.max(12, text.length * 0.8);
  });
}

function getComparisonTextFill({ product = {}, productIndex = -1, row = {}, value = '', style = {}, emphasisPlan = null }) {
  const defaultFill = /5070|5060|RTX|Ultra|¥|元|Wh|GB|TB|Hz|nits|W/i.test(value) ? '#e11d48' : (style.textColor || '#111827');
  if (!emphasisPlan?.active) return defaultFill;
  return style.textColor || '#111827';
}

function getComparisonTextWeight({ product = {}, productIndex = -1, row = {}, value = '', emphasisPlan = null, fallback = 850 }) {
  if (!emphasisPlan?.active || !emphasisPlan.bold) return fallback;
  return isComparisonEmphasisTarget({ product, productIndex, row, value, emphasisPlan }) ? Math.max(fallback, 950) : fallback;
}

function buildComparisonRows(products = []) {
  const rows = comparisonRows.filter((row) => products.some((product) => getProductFieldValue(product, row)));
  const extraLabels = [];
  for (const product of products) {
    for (const field of normalizeComparisonExtraFields(product.extraFields)) {
      if (!extraLabels.includes(field.label)) extraLabels.push(field.label);
    }
  }
  for (const label of extraLabels) {
    if (products.some((product) => getProductFieldValue(product, { label }))) {
      rows.push({ label, height: 118 });
    }
  }
  return rows.slice(0, 9);
}

function parseComparisonFallback({ title, body }) {
  const source = String(body || '').trim();
  const blocks = source
    .split(/(?=产品\s*\d+\s*[：:])|(?=\n\s*[-*]?\s*[\u4e00-\u9fa5A-Za-z0-9][^\n]{0,34}(?:：|:))/)
    .map((block) => block.trim())
    .filter(Boolean);
  const products = [];
  let current = null;
  const ensureCurrent = () => {
    if (!current) {
      current = {};
      products.push(current);
    }
    return current;
  };
  const assignField = (key, value) => {
    const target = ensureCurrent();
    target[key] = [target[key], value].filter(Boolean).join('，');
  };
  const assignExtraField = (label, value) => {
    if (!label || !value) return;
    const target = ensureCurrent();
    target.extraFields = normalizeComparisonExtraFields([
      ...(target.extraFields || []),
      { label, value }
    ]);
  };
  for (const rawBlock of blocks.length ? blocks : source.split(/\n+/)) {
    const block = rawBlock.trim();
    if (!block) continue;
    const productMatch = block.match(/^产品\s*\d*\s*[：:]\s*(.+)$/);
    if (productMatch) {
      current = { name: productMatch[1].trim() };
      products.push(current);
      continue;
    }
    const nameMatch = block.match(/^(?:产品名|名称|型号)\s*[：:]\s*(.+)$/);
    if (nameMatch) {
      current = { name: nameMatch[1].trim() };
      products.push(current);
      continue;
    }
    const value = block.replace(/^[^：:]{1,12}[：:]\s*/, '').trim();
    if (/到手价|价格|售价/.test(block)) assignField('price', value);
    else if (/处理器|CPU|芯片/.test(block)) assignField('processor', value);
    else if (/内存|硬盘|存储|SSD/.test(block)) assignField('memoryStorage', value);
    else if (/屏幕|刷新率|色域|分辨率/.test(block)) assignField('screen', value);
    else if (/重量|厚度|轻薄/.test(block)) assignField('weightThickness', value);
    else if (/电池|续航|Wh/.test(block)) assignField('battery', value);
    else if (/亮点|优势|核心/.test(block)) assignField('highlights', value);
    else if (/适合人群|目标人群|适用人群/.test(block)) assignField('audience', value);
    else {
      const fieldMatch = block.match(/^([^：:]{1,12})[：:]\s*(.+)$/);
      if (fieldMatch && current?.name) assignExtraField(fieldMatch[1].trim(), fieldMatch[2].trim());
      else if (!current?.name) {
        current = { name: block.slice(0, 30) };
        products.push(current);
      }
    }
  }
  return normalizeComparisonData({ title, products: products.filter((product) => product.name) }, title);
}

function buildComparisonPlanningPrompt({ topic, noteBody, topicDirection }) {
  return `你是小红书参数对比表整理助手。请把用户提供的一段自然文案整理成“产品参数对比表”的结构化 JSON。必须忠实保留用户给出的产品名、价格、型号、参数和人群，不要编造、不要补全用户没写的信息。

封面标题：
${topic || '未提供'}

原始文案：
${noteBody || '未提供'}

补充要求：
${topicDirection || '未提供'}

整理规则：
- products 按用户文案中出现顺序排列。
- 如果某项参数没写，留空字符串，不要猜；不要写“未提供”“未提及”“暂无”等占位词。
- 只能输出原始文案中明确出现过的比较维度/字段分类。原文没有写“核心亮点”“适合人群”“推荐理由”等分类时，不要自己总结或新增这些维度。
- 不要为了让表格更完整而给所有产品生成原文没有提供的共同维度。
- 只整理原始文案真实出现的信息。不要为了套模板硬补“适合人群”“核心亮点”等字段。
- 每个产品额外生成 review：把原文中与该产品有关的信息整合成一段自然、连贯的导购点评。先说最突出的优势，再自然带出短板、价格或适合人群；不要写成“处理器：/显卡：/屏幕：”这样的参数罗列，不要逐字段换行。只能使用原文已有事实，不得补造参数。建议 55-110 个汉字。
- 把同一产品的屏幕、重量、电池、亮点、人群整理到对应字段；如果原文没有人群信息，audience 必须为空字符串。
- 如果原文出现了标准字段之外的分类，例如显卡、接口、摄像头、散热、上市时间、系统、材质等，放进 extraFields，格式为 {"label":"分类名","value":"参数值"}。
- 字段内容可以保留换行，但不要改数字、单位、型号。
- 不要输出任何 HTML/XML/Markdown 标记；如果用户要求“红色突出”，只保留纯文字内容，不要写 <span>、<b>、** 等标记。
- 输出合法 JSON 对象，不要 Markdown，不要解释。

输出格式：
{
  "title": "封面标题",
  "subtitle": "可选副标题",
  "products": [
    {
      "name": "产品名",
      "price": "到手价",
      "processor": "处理器",
      "memoryStorage": "内存硬盘",
      "screen": "屏幕参数",
      "weightThickness": "重量厚度",
      "battery": "电池续航",
      "highlights": "核心亮点",
      "audience": "适合人群",
      "review": "一段完整、自然的产品点评，不使用参数标签逐项罗列",
      "extraFields": [
        { "label": "显卡", "value": "RTX 5070" }
      ]
    }
  ]
}`;
}

async function generateComparisonDataWithTextModel({ topic, noteBody, topicDirection }) {
  const prompt = buildComparisonPlanningPrompt({ topic, noteBody, topicDirection });
  const client = getTextClient();
  if (!client) {
    return {
      comparisonData: parseComparisonFallback({ title: topic, body: noteBody }),
      prompt,
      source: 'local-fallback',
      warning: '未配置文本模型 key，已用本地规则整理。'
    };
  }
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini';
  const response = await client.chat.completions.create({
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: '你只输出合法 JSON 对象，不输出 Markdown，不输出解释。' },
      { role: 'user', content: prompt }
    ]
  });
  const rawText = response.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(rawText);
  const sourceText = [topic, noteBody, topicDirection].filter(Boolean).join('\n');
  const comparisonData = normalizeComparisonData(parsed || parseComparisonFallback({ title: topic, body: noteBody }), topic, sourceText);
  const usage = response.usage ? {
    promptTokens: response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0,
    completionTokens: response.usage.completion_tokens ?? response.usage.completionTokens ?? 0,
    totalTokens: response.usage.total_tokens ?? response.usage.totalTokens ?? 0
  } : null;
  const usageLog = appendUsageLog({
    type: 'text-comparison-plan',
    provider: textBaseUrl ? 'openai-compatible-proxy' : 'openai',
    model,
    count: comparisonData.products.length,
    usage
  });
  return { comparisonData, prompt, model, usage, usageLog, rawText, source: 'text-model' };
}

async function makeComparisonStyleFromImage(file, index = 0, templateName = '', category = 'comparison') {
  const inferredLayouts = ['classic-table', 'student-grid', 'major-rows', 'three-cards', 'series-bands'];
  const metadata = await sharp(file.path).resize(32, 32, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true });
  const channels = metadata.info.channels;
  const pixels = metadata.data;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += channels) {
    r += pixels[offset];
    g += pixels[offset + 1];
    b += pixels[offset + 2];
    count += 1;
  }
  const avg = {
    r: Math.round(r / Math.max(1, count)),
    g: Math.round(g / Math.max(1, count)),
    b: Math.round(b / Math.max(1, count))
  };
  const toHex = (value) => value.toString(16).padStart(2, '0');
  const mix = (color, target, amount) => ({
    r: Math.round(color.r * (1 - amount) + target.r * amount),
    g: Math.round(color.g * (1 - amount) + target.g * amount),
    b: Math.round(color.b * (1 - amount) + target.b * amount)
  });
  const hex = (color) => `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
  const dark = hex(mix(avg, { r: 20, g: 35, b: 28 }, 0.55));
  const header = hex(mix(avg, { r: 245, g: 250, b: 245 }, 0.35));
  const light = hex(mix(avg, { r: 255, g: 255, b: 255 }, 0.78));
  const rowAlt = hex(mix(avg, { r: 255, g: 255, b: 255 }, 0.9));
  const previewName = `comparison-style-${Date.now()}-${index + 1}${path.extname(file.originalname || '.png') || '.png'}`;
  fs.copyFileSync(file.path, path.join(outputDir, previewName));
  const baseName = templateName || `参数表风格 ${new Date().toLocaleDateString('zh-CN')} ${index + 1}`;
  return normalizeComparisonStyle({
    id: `${slugifyTemplateId(baseName)}-${Date.now().toString(36)}-${index + 1}`,
    name: baseName,
    category: category === 'review' ? 'review' : 'comparison',
    layout: inferredLayouts[index % inferredLayouts.length],
    previewImage: `/outputs/${previewName}`,
    titleColor: dark,
    headerBg: header,
    audienceBg: header,
    cellBg: '#ffffff',
    rowAlt,
    gridColor: dark,
    textColor: '#111827',
    mood: '来自用户上传的参数对比参考图'
  }, index);
}

function buildComparisonStyleAnalysisPrompt({ templateName, notes, index, category = 'comparison' }) {
  const reviewMode = category === 'review';
  return `你是小红书“${reviewMode ? '产品点评' : '参数对比表'}”封面模版分析师。用户会上传 1 张${reviewMode ? '产品点评/横评' : '参数对比'}参考图，请认真看图，把它总结成后续可复用的${reviewMode ? '点评' : '参数表'}风格配置。

用户填写的模版名：
${templateName || '未填写，请你自动命名'}

用户备注：
${notes || '未提供'}

请重点分析：
- 这个参数表适合什么品类和内容场景。
- 版式结构：标题、产品图、参数表/卡片/横条、购买建议分别怎么摆。
- 视觉风格：主色、强调色、科技感/种草感/清爽感、字体层级、边框和图标。
- 标题配色：请区分主标题主色、标题强调色、分区小标题色；如果是红黑标题，请明确黑/近黑为主、红色为强调。
- 可迁移规则：换成新产品、新参数、新标题以后，哪些结构必须保留。
- 信息结构：${reviewMode ? '标题、产品名称、产品图、完整点评段落如何组织；不要默认拆成参数表。' : '标题、产品名称、价格、核心参数、亮点、建议如何组织。'}

layout 只能从下面 5 个里选择一个：
- classic-table：标准多列表格，适合密集参数。
- student-grid：产品宫格/货架感，适合导购推荐。
- major-rows：纵向分层清单/横向行卡，适合专业、人群、用途分类。
- three-cards：三列或多列产品卡片，适合一图看懂。
- series-bands：彩色横条/分区带，适合系列机型横评。

不要复刻参考图里的商标、水印、二维码或不可复用素材。输出合法 JSON 对象，不要 Markdown，不要解释。

输出格式：
{
  "styleName": "短中文模版名，4-12 字，方便用户选择",
  "layout": "classic-table|student-grid|major-rows|three-cards|series-bands",
  "bestFor": "适合的品类/选题",
  "mood": "一句话视觉气质",
  "composition": "版式结构说明",
  "visualRules": "生成时必须保留的视觉规则",
  "copyStructure": "信息/文案组织方式",
  "titleMainColor": "#111827",
  "titleAccentColor": "#e11d2e",
  "sectionTitleColor": "#e11d2e"
}

这是本批第 ${Number(index) + 1 || 1} 张参考图。`;
}

async function analyzeComparisonStyleWithTextModel({ file, templateName, notes, index = 0, category = 'comparison' }) {
  const client = getTextClient();
  if (!client) return null;
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini';
  const prompt = buildComparisonStyleAnalysisPrompt({ templateName, notes, index, category });
  const response = await client.chat.completions.create({
    model,
    temperature: 0.3,
    max_tokens: 1200,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: '你只输出合法 JSON 对象，不输出 Markdown，不输出解释，不要把 JSON 放进代码块。'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${file.mimetype || 'image/jpeg'};base64,${fs.readFileSync(file.path).toString('base64')}`
            }
          }
        ]
      }
    ]
  });
  const rawText = response.choices?.[0]?.message?.content || '';
  const analysis = extractJsonObject(rawText);
  if (!analysis) throw new Error('模型没有返回合法的参数表模版 JSON。');
  const usage = response.usage ? {
    promptTokens: response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0,
    completionTokens: response.usage.completion_tokens ?? response.usage.completionTokens ?? 0,
    totalTokens: response.usage.total_tokens ?? response.usage.totalTokens ?? 0
  } : null;
  const usageLog = appendUsageLog({
    type: 'comparison-style-analysis',
    provider: textBaseUrl ? 'openai-compatible-proxy' : 'openai',
    model,
    count: 1,
    usage
  });
  return { analysis, rawText, prompt, model, usage, usageLog };
}

function wrapSvgText(text, maxUnits, maxLines = 3) {
  const cleaned = String(text || '').replace(/\r/g, '').trim();
  if (!cleaned) return [''];
  const explicit = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (explicit.length > 1) return explicit.slice(0, maxLines);
  const chars = Array.from(cleaned.replace(/\s+/g, ' '));
  const lines = [];
  let current = '';
  let units = 0;
  for (const char of chars) {
    const width = visualCharWidth(char);
    if (current && units + width > maxUnits && lines.length < maxLines - 1) {
      lines.push(current.trim());
      current = char;
      units = width;
    } else {
      current += char;
      units += width;
    }
  }
  if (current) lines.push(current.trim());
  return lines.slice(0, maxLines);
}

function wrapSvgTextWithOffsets(text, maxUnits, maxLines = 3) {
  const cleaned = String(text || '').replace(/\r/g, '').trim();
  if (!cleaned) return [{ text: '', start: 0, end: 0 }];
  if (cleaned.includes('\n')) {
    const lines = [];
    let searchFrom = 0;
    for (const rawLine of cleaned.split(/\n+/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const start = cleaned.indexOf(line, searchFrom);
      lines.push({ text: line, start, end: start + line.length });
      searchFrom = start + line.length;
      if (lines.length >= maxLines) break;
    }
    return lines.length ? lines : [{ text: cleaned, start: 0, end: cleaned.length }];
  }
  const normalized = cleaned.replace(/\s+/g, ' ');
  const chars = Array.from(normalized);
  const lines = [];
  let current = '';
  let start = 0;
  let units = 0;
  let offset = 0;
  for (const char of chars) {
    const width = visualCharWidth(char);
    if (current && units + width > maxUnits && lines.length < maxLines - 1) {
      const trimmed = current.trim();
      const trimLeft = current.length - current.trimStart().length;
      lines.push({ text: trimmed, start: start + trimLeft, end: start + trimLeft + trimmed.length });
      current = char;
      start = offset;
      units = width;
    } else {
      current += char;
      units += width;
    }
    offset += char.length;
  }
  if (current) {
    const trimmed = current.trim();
    const trimLeft = current.length - current.trimStart().length;
    lines.push({ text: trimmed, start: start + trimLeft, end: start + trimLeft + trimmed.length });
  }
  return lines.slice(0, maxLines);
}

function svgTextBlock({ text, x, y, width, height, size = 30, weight = 800, fill = '#111827', align = 'center', maxLines = 3 }) {
  const maxUnits = Math.max(4, Math.floor(width / (size * 0.62)));
  const lines = wrapSvgText(text, maxUnits, maxLines);
  const lineHeight = Math.round(size * 1.25);
  const totalHeight = lines.length * lineHeight;
  let startY = y + Math.max(size, Math.round((height - totalHeight) / 2) + size);
  const anchor = align === 'left' ? 'start' : 'middle';
  const textX = align === 'left' ? x + 12 : x + width / 2;
  return lines.map((line, index) => `<text x="${Math.round(textX)}" y="${Math.round(startY + index * lineHeight)}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif">${escapeXml(line)}</text>`).join('\n');
}

function sliceLineIntoRichTextParts(line, emphasisRanges = [], baseStart = 0) {
  const parts = [];
  let cursor = 0;
  const localRanges = emphasisRanges
    .map((range) => ({
      start: Math.max(0, range.start - baseStart),
      end: Math.min(line.length, range.end - baseStart)
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  for (const range of localRanges) {
    if (range.start > cursor) parts.push({ text: line.slice(cursor, range.start), emphasized: false });
    parts.push({ text: line.slice(range.start, range.end), emphasized: true });
    cursor = range.end;
  }
  if (cursor < line.length) parts.push({ text: line.slice(cursor), emphasized: false });
  return parts.filter((part) => part.text);
}

function svgRichTextBlock({ text, x, y, width, height, size = 30, weight = 800, fill = '#111827', emphasisFill = '#e11d2e', emphasisWeight = 950, emphasisRanges = [], align = 'center', maxLines = 3 }) {
  const maxUnits = Math.max(4, Math.floor(width / (size * 0.62)));
  const lines = wrapSvgTextWithOffsets(text, maxUnits, maxLines);
  const lineHeight = Math.round(size * 1.25);
  const totalHeight = lines.length * lineHeight;
  const startY = y + Math.max(size, Math.round((height - totalHeight) / 2) + size);
  const anchor = align === 'left' ? 'start' : 'middle';
  const textX = align === 'left' ? x + 12 : x + width / 2;
  return lines.map((lineInfo, index) => {
    const parts = sliceLineIntoRichTextParts(lineInfo.text, emphasisRanges, lineInfo.start);
    const body = parts.length
      ? parts.map((part) => `<tspan fill="${part.emphasized ? emphasisFill : fill}" font-weight="${part.emphasized ? emphasisWeight : weight}">${escapeXml(part.text)}</tspan>`).join('')
      : escapeXml(lineInfo.text);
    return `<text x="${Math.round(textX)}" y="${Math.round(startY + index * lineHeight)}" text-anchor="${anchor}" font-size="${size}" font-weight="${weight}" fill="${fill}" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif">${body}</text>`;
  }).join('\n');
}

function imageDataHref(file) {
  if (!file?.path || !fs.existsSync(file.path)) return '';
  const mime = file.mimetype || 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(file.path).toString('base64')}`;
}

async function saveComparisonSvg({ svg, products, data, style, model = 'template-svg-sharp', trackUsage = true }) {
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const fileName = `comparison-${Date.now()}.png`;
  fs.writeFileSync(path.join(outputDir, fileName), pngBuffer);
  const usageLog = trackUsage ? appendUsageLog({
    type: 'comparison-table-generate',
    provider: 'local',
    model,
    count: products.length,
    usage: { moneyCost: 0, coinCost: 0, currency: 'CNY' }
  }) : null;
  return {
    imageUrl: `/outputs/${fileName}`,
    prompt: `参数对比表本地生成：${data.title}，产品 ${products.length} 个，风格=${style.name}，参数来自原始正文结构化整理。`,
    model: '本地参数对比表模板',
    taskId: null,
    usage: { moneyCost: 0, coinCost: 0, currency: 'CNY' },
    usageLog,
    comparisonData: data,
    comparisonStyle: style
  };
}

function outputPathFromUrl(imageUrl = '') {
  const name = path.basename(String(imageUrl || '').split('?')[0]);
  if (!name || name === '.' || name === '/') return '';
  const outputPath = path.join(outputDir, name);
  return fs.existsSync(outputPath) ? outputPath : '';
}

function localPathFromAppImageUrl(imageUrl = '') {
  const cleanUrl = String(imageUrl || '').split('?')[0];
  if (cleanUrl.startsWith('/outputs/')) return outputPathFromUrl(cleanUrl);
  if (!cleanUrl.startsWith('/template-previews/') && !cleanUrl.startsWith('/assets/')) return '';
  const publicRoot = path.resolve(__dirname, 'public');
  const localPath = path.resolve(publicRoot, cleanUrl.replace(/^\/+/, ''));
  if (!localPath.startsWith(`${publicRoot}${path.sep}`)) return '';
  return fs.existsSync(localPath) ? localPath : '';
}

function shouldCropNonReusableTemplateHeader(previewImage = '') {
  return String(previewImage || '').startsWith('/outputs/');
}

async function createComparisonGenerationReference({ layoutReferencePath, style = {} }) {
  const layoutReferenceUrl = `/outputs/${path.basename(layoutReferencePath)}`;
  const layoutFile = {
    path: layoutReferencePath,
    originalname: 'comparison-layout-reference.png',
    mimetype: 'image/png'
  };
  const styleReferencePath = localPathFromAppImageUrl(style.previewImage);
  if (!styleReferencePath) {
    return { file: layoutFile, layoutReferenceUrl, styleReferenceUrl: '', combinedReferenceUrl: '' };
  }
  try {
    if (fs.realpathSync(styleReferencePath) === fs.realpathSync(layoutReferencePath)) {
      return { file: layoutFile, layoutReferenceUrl, styleReferenceUrl: style.previewImage, combinedReferenceUrl: '' };
    }
  } catch {
    return { file: layoutFile, layoutReferenceUrl, styleReferenceUrl: '', combinedReferenceUrl: '' };
  }

  const width = 1024;
  const height = 1536;
  const inset = 32;
  const imageWidth = width - inset * 2;
  const styleMeta = await sharp(styleReferencePath).metadata();
  const cropTop = shouldCropNonReusableTemplateHeader(style.previewImage)
    ? Math.round((styleMeta.height || 0) * 0.105)
    : 0;
  const reusableStyleInput = cropTop > 0 && styleMeta.width && styleMeta.height && styleMeta.height > cropTop + 10
    ? sharp(styleReferencePath).extract({
      left: 0,
      top: cropTop,
      width: styleMeta.width,
      height: styleMeta.height - cropTop
    })
    : sharp(styleReferencePath);
  const styleBuffer = await reusableStyleInput
    .resize(imageWidth, 700, { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();
  const layoutBuffer = await sharp(layoutReferencePath)
    .resize(imageWidth, 740, { fit: 'contain', background: '#ffffff' })
    .png()
    .toBuffer();
  const fileName = `comparison-reference-${Date.now()}.png`;
  const combinedPath = path.join(outputDir, fileName);
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#ffffff'
    }
  })
    .composite([
      { input: styleBuffer, left: inset, top: 24 },
      { input: layoutBuffer, left: inset, top: 772 }
    ])
    .png()
    .toFile(combinedPath);

  return {
    file: {
      path: combinedPath,
      originalname: 'comparison-style-and-layout-reference.png',
      mimetype: 'image/png'
    },
    layoutReferenceUrl,
    styleReferenceUrl: style.previewImage,
    combinedReferenceUrl: `/outputs/${fileName}`
  };
}

function formatComparisonDataForPrompt(data = {}) {
  const products = Array.isArray(data.products) ? data.products : [];
  const rows = Array.isArray(data.rows) && data.rows.length ? data.rows : buildComparisonRows(products);
  return [
    `标题：${data.title || '参数对比表'}`,
    data.subtitle ? `副标题：${data.subtitle}` : '',
    ...products.map((product, index) => [
      `产品${index + 1}：${product.name || '-'}`,
      ...rows.map((row) => `${String(row.label || '').replace(/\n/g, '')}：${getProductFieldDisplayValue(product, row)}`)
    ].join('\n'))
  ].filter(Boolean).join('\n\n');
}

function buildProductReviewFallback(product = {}) {
  const facts = [
    product.highlights,
    product.screen,
    product.processor,
    product.memoryStorage,
    product.weightThickness,
    product.battery,
    ...normalizeComparisonExtraFields(product.extraFields).map((field) => field.value),
    product.price ? `价格为${product.price}` : '',
    product.audience ? `更适合${product.audience}` : ''
  ].map((value) => cleanComparisonText(value)).filter(Boolean);
  return facts.length ? `${facts.join('，').replace(/[，。]+$/g, '')}。` : '请结合正文补充这款产品的主要优势、短板和适合人群。';
}

function formatNarrativeReviewDataForPrompt(data = {}) {
  const products = Array.isArray(data.products) ? data.products : [];
  return [
    `标题：${data.title || '逐款点评'}`,
    ...products.map((product, index) => [
      `产品${index + 1}：${product.name || '-'}`,
      `点评：${product.review || buildProductReviewFallback(product)}`
    ].join('\n'))
  ].filter(Boolean).join('\n\n');
}

function buildComparisonImagePrompt({ data, style, aspectRatio, hasStyleReference = false, emphasisPlan = null }) {
  const narrativeReview = isNarrativeReviewStyle(style);
  const uploadedStyle = isUploadedComparisonStyle(style || {});
  const splitTitleColor = shouldUseSplitComparisonTitleColor(style || {});
  const uniformTitleRequested = topicDirectionRequestsUniformTitleColor(emphasisPlan);
  const referenceInstruction = hasStyleReference
    ? `用户提供的输入图由上下两部分组成：上半部分是“目标模版主体风格参考图”，下半部分是“本次产品和${narrativeReview ? '点评' : '参数'}内容草稿”。请严格模仿上半部分主体内容区的构图、标题层级、色彩、信息密度、留白、光影和视觉气质，把下半部分的产品图和${narrativeReview ? '点评' : '参数'}文字准确迁移进去。最终只输出一张完整封面，不要保留上下拼接结构。`
    : `用户提供的输入图是一张已经排好产品图和${narrativeReview ? '点评' : '参数'}文字的版式参考图，请基于这张参考图生成一张完整的小红书爆款${narrativeReview ? '逐款点评横评' : '参数对比'}封面。`;
  const titlePalette = getComparisonTitlePalette(style || {});
  const titleColorRule = splitTitleColor && !uniformTitleRequested
    ? '- 如果用户新增模版明确是红黑标题结构，主标题黑色/近黑粗体为主，红色只用于参考图中已经存在的标题强调段。'
    : '- 主标题必须整行同色，严格沿用参考图顶部标题的统一配色；如果用户要求标题统一颜色或整行红色，必须整行统一执行，禁止把标题里的品牌、型号、品类词拆成不同颜色。';
  const uploadedStyleRules = uploadedStyle ? [
    '- 这是用户新增模版，请根据该模版主体内容区提取页面元素：模块数量、图文位置、色彩层级、卡片质感、留白、阴影、标题强调方式。',
    '- 只参考用户新增模版的可迁移主体画面语言；禁止复制参考图里的顶部来源栏、头像、作者名、Design By、About、账号信息、数据来源、水印、二维码或任何参考图原文案。',
    '- 产品图必须来自输入图下半部分的内容草稿，尽量保持原产品外观、颜色、角度和屏幕画面，不要换成其他型号或重新发明产品外观。',
    `- 不要新增右侧参数卡、图标参数块、徽章、标签或卖点，除非“已确认${narrativeReview ? '逐款点评文本' : '参数文本'}”里明确出现这些信息。`,
    titleColorRule
  ].join('\n') : '';
  return `你是小红书${narrativeReview ? '逐款点评横评' : '参数对比'}封面设计师。${referenceInstruction}

## 绝对要求
- 必须使用选中模版的版式作为结构参考，${narrativeReview ? '保持顶部标题和纵向左图右文的固定节奏。' : '不要打乱表格/卡片/分栏/横条/信息块的整体布局。'}
- 如果输入图包含目标模版风格参考图，最终构图必须明显贴近目标模版，不要只照搬内容草稿的蓝白表格。
- 如果本次是单个产品但内容草稿里有多张产品图，必须把这些图作为同一张封面的多行/多模块素材全部保留，不要只保留第一张。
${uploadedStyleRules}
- 必须保留每个产品图的对应关系和位置，不要把产品 A 的图片放到产品 B 下。
- ${narrativeReview ? '每款产品右侧必须保留为一段完整、连贯的自然语言点评，禁止拆成处理器、显卡、屏幕、接口等参数清单，禁止增加参数标签或表格。' : '参数文字必须逐字准确，禁止编造、替换、删减或改写型号、价格、CPU、内存、硬盘、屏幕、重量、电池、接口等信息。'}
${narrativeReview ? '- 只显示产品名、产品图和完整点评段落，不显示参数分类名。' : '- 只展示“已确认参数文本”里出现的分类；如果某个产品在现有分类下是“/”，最终图也必须保持“/”，不要改成“未提供”“未提及”“暂无”或空白。'}
- “选题方向 / 画面目标”是本次真实生图必须执行的内容策略，不是备注；必须影响重点数据的取舍、颜色、粗细和推荐倾向。
- 如果模型无法稳定重写小字，请尽量保持输入图中文字原样清晰呈现，只做背景、色块、标题层级、描边、阴影和装饰优化。
- 不要出现乱码、错别字、重复字、多余英文、水印、二维码、品牌伪标识或虚构认证。
- ${narrativeReview ? '产品图尺寸统一，点评段落行距规整，各行靠留白分隔，文字不得溢出或互相遮挡。' : '表格线、列宽、行距和文字层级要规整，所有文字不得溢出格子或互相遮挡。'}

## 已确认${narrativeReview ? '逐款点评文本' : '参数文本'}
${narrativeReview ? formatNarrativeReviewDataForPrompt(data) : formatComparisonDataForPrompt(data)}

${emphasisPlan?.active ? `## 选题方向 / 画面目标
${emphasisPlan.promptText}
- 执行优先级：这些强调规则高于通用配色建议；如果与模版原有颜色冲突，以用户画面目标为准。
- 只强调已确认参数文本里真实存在的数据，禁止为了强调而新增不存在的卖点、参数或图标。
- 标红方式要像参数表参考图：黑色句子中穿插红色关键数字/型号/规格值，例如价格数字、U5 16G、85W、92Wh、LPDDR5X-9600、2.8K、120Hz、430nits；不要整句、整段、整格全部变红。
${emphasisPlan.comparativeMode ? '- 当前是客观逐行比较模式：同一行里必须先比较所有产品，只标该行最优值，不要把每一列同类数字都标红。价格/到手价行只标最低价格；TDP/性能释放/电池容量/屏幕亮度/内存频率等越高越好时只标最高值；重量/厚度越低越好时只标最低值；如果同一项数值相同或没有明显优劣，不标红。' : ''}
` : ''}

## 风格参考
- 当前抽取风格：${style?.name || '参数对比表'}
- 版式类型：${style?.layout || 'classic-table'}
- 风格气质：${style?.mood || '清晰、理性、参数可信'}
- 适合内容：${style?.bestFor || '数码、家电、产品选购、型号横评'}
- 构图规则：${style?.composition || '根据参考图保留主要表格/卡片结构，标题清晰，产品图和参数一一对应'}
- 视觉规则：${style?.visualRules || '保持表格线、卡片、色块、标签、强调色和信息密度的风格特征'}
- 文案结构：${style?.copyStructure || '按真实输入字段动态组织，不新增缺失字段'}
- 参考图配色：主标题主色 ${titlePalette.main}，标题/关键词强调色 ${titlePalette.accent}，分区小标题 ${titlePalette.section}，表头 ${style?.headerBg || '#dbeafe'}，底色 ${style?.cellBg || '#ffffff'}。
- 标题颜色规则：${splitTitleColor && !uniformTitleRequested ? '标题可以按参考图做红黑分段，但不能自行新增拆色。' : `主标题必须整行同色，颜色使用 ${uniformTitleRequested && /红/.test(emphasisPlan?.rawText || '') ? '红色' : titlePalette.main}；禁止把品牌、型号、品类词拆成不同颜色。${uniformTitleRequested ? '用户要求标题统一颜色，这条优先级高于旧模版分析。' : ''}`}

## 视觉目标
- 输出像小红书爆款“${narrativeReview ? '逐款点评 / 横评建议' : '参数对比 / 选购建议 / 一图看懂'}”封面。
- 比输入参考图更精致，但不能牺牲可读性和参数准确性。
- 标题醒目，产品图清晰，重点参数可适度用红/蓝/绿色强调；主标题颜色必须遵守上面的标题颜色规则。
- 保持干净高级，不要做成杂乱广告图。
- 推荐画幅：${aspectRatio || '3:4 小红书竖图'}。

输出一张最终封面图。`;
}

async function generateComparisonWithImageApi({ comparisonData, files = [], noteTitle, noteBody = '', topicDirection = '', comparisonStyleId = '', visualMode = 'comparison', aspectRatio = '3:4 小红书竖图', resolution = '1k', quality = 'medium' }) {
  if (!runningHubImageApiKey && !imageApiKey) {
    throw new Error('还没有配置 RUNNINGHUB_IMAGE_API_KEY 或 OPENAI_IMAGE_API_KEY，参数对比表现在需要调用生图 API。');
  }
  const layoutResult = await generateComparisonTableImage({
    comparisonData,
    files,
    noteTitle,
    sourceText: [noteTitle, noteBody, topicDirection].filter(Boolean).join('\n'),
    topicDirection,
    comparisonStyleId,
    visualMode,
    trackUsage: false
  });
  const referencePath = outputPathFromUrl(layoutResult.imageUrl);
  if (!referencePath) {
    throw new Error('参数表参考图生成失败，无法提交生图 API。');
  }
  const referenceFile = {
    path: referencePath,
    originalname: 'comparison-layout-reference.png',
    mimetype: 'image/png'
  };
  const generationReference = await createComparisonGenerationReference({
    layoutReferencePath: referencePath,
    style: layoutResult.comparisonStyle
  });
  const prompt = buildComparisonImagePrompt({
    data: layoutResult.comparisonData,
    style: layoutResult.comparisonStyle,
    aspectRatio,
    emphasisPlan: layoutResult.comparisonEmphasisPlan,
    hasStyleReference: Boolean(generationReference.styleReferenceUrl)
  });
  const model = runningHubImageApiKey ? `RunningHub ${runningHubModelName}` : (process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2');

  if (runningHubImageApiKey) {
    const result = await generateImageWithRunningHub({
      file: generationReference.file || referenceFile,
      prompt,
      aspectRatio,
      resolution,
      prefix: 'comparison-ai'
    });
    return {
      imageUrl: result.imageUrl,
      prompt,
      model,
      taskId: result.taskId,
      usage: result.usage,
      usageLog: result.usageLog,
      comparisonData: layoutResult.comparisonData,
      comparisonStyle: layoutResult.comparisonStyle,
      comparisonEmphasisPlan: layoutResult.comparisonEmphasisPlan,
      layoutReferenceUrl: layoutResult.imageUrl,
      styleReferenceUrl: generationReference.styleReferenceUrl,
      combinedReferenceUrl: generationReference.combinedReferenceUrl
    };
  }

  const client = getImageClient();
  const editReferenceFile = generationReference.file || referenceFile;
  const image = await toFile(fs.createReadStream(editReferenceFile.path), editReferenceFile.originalname, {
    type: editReferenceFile.mimetype
  });
  const response = await client.images.edit({
    model,
    image,
    prompt,
    quality,
    size: '1024x1536'
  });
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error('模型没有返回图片，请重试或调整提示词。');
  const fileName = `comparison-ai-${Date.now()}.png`;
  fs.writeFileSync(path.join(outputDir, fileName), Buffer.from(b64, 'base64'));
  const usageLog = appendUsageLog({
    type: 'image-generate',
    provider: 'openai',
    model,
    taskId: null,
    aspectRatio: normalizeAspectRatio(aspectRatio),
    resolution,
    usage: response.usage || null
  });
  return {
    imageUrl: `/outputs/${fileName}`,
    prompt,
    model,
    taskId: null,
    usage: response.usage || null,
    usageLog,
    comparisonData: layoutResult.comparisonData,
    comparisonStyle: layoutResult.comparisonStyle,
    comparisonEmphasisPlan: layoutResult.comparisonEmphasisPlan,
    layoutReferenceUrl: layoutResult.imageUrl,
    styleReferenceUrl: generationReference.styleReferenceUrl,
    combinedReferenceUrl: generationReference.combinedReferenceUrl
  };
}

function comparisonFieldLines(product) {
  return buildComparisonRows([product]).map((row) => [
    String(row.label || '').replace(/\n/g, ''),
    getProductFieldValue(product, row)
  ]).filter(([, value]) => value);
}

function joinComparisonFacts(items = []) {
  return items
    .map(([label, value]) => [label, cleanComparisonText(value)])
    .filter(([, value]) => value && !isMissingComparisonText(value))
    .map(([label, value]) => `${label}：${value}`)
    .join('；');
}

function buildSingleProductImageSections(product = {}, files = []) {
  const sectionPlans = [
    {
      title: '轻薄便携',
      fields: [
        ['重量/厚度', product.weightThickness],
        ['电池续航', product.battery],
        ['到手价', product.price]
      ]
    },
    {
      title: '性能核心',
      fields: [
        ['处理器', product.processor],
        ['内存硬盘', product.memoryStorage],
        ['核心亮点', product.highlights]
      ]
    },
    {
      title: '屏幕体验',
      fields: [
        ['屏幕参数', product.screen],
        ['适合人群', product.audience]
      ]
    },
    {
      title: '接口扩展',
      fields: normalizeComparisonExtraFields(product.extraFields).map((field) => [field.label, field.value])
    }
  ];
  const fallbackFacts = comparisonFieldLines(product);
  const count = Math.max(1, Math.min(4, files.length || sectionPlans.length));
  return Array.from({ length: count }, (_, index) => {
    const plan = sectionPlans[index] || sectionPlans[sectionPlans.length - 1];
    return {
      title: plan.title,
      body: joinComparisonFacts(plan.fields) || joinComparisonFacts(fallbackFacts.slice(index * 2, index * 2 + 2)) || product.highlights || product.price || product.name || '/',
      imageIndex: index
    };
  });
}

function shouldUseStrictLocalComparisonRender(data = {}, files = []) {
  const products = Array.isArray(data.products) ? data.products.filter((product) => product?.name) : [];
  return products.length === 1 && Array.isArray(files) && files.length > 1;
}

async function renderSingleProductMultiImageReview({ data, product, files, style, noteTitle, emphasisPlan = null, trackUsage = true }) {
  const width = 1200;
  const height = 1600;
  const margin = 44;
  const sections = buildSingleProductImageSections(product, files);
  const sectionGap = 28;
  const sectionTop = 315;
  const sectionH = Math.min(360, Math.floor((height - sectionTop - 64 - sectionGap * (sections.length - 1)) / sections.length));
  const titlePalette = getComparisonTitlePalette(style);
  const titleColor = titlePalette.main;
  const accent = titlePalette.accent;
  const elements = [
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    `<rect x="${margin}" y="126" width="14" height="112" rx="7" fill="${accent}"/>`,
    svgTextBlock({ text: data.title || noteTitle || product.name, x: margin + 36, y: 112, width: width - margin * 2 - 36, height: 100, size: style.titleSize || 58, weight: 950, fill: titleColor, align: 'left', maxLines: 2 }),
    svgTextBlock({ text: '参数速览 | 优势解析 | 选购参考', x: margin + 36, y: 220, width: width - margin * 2 - 36, height: 42, size: 28, weight: 760, fill: style.textColor || '#374151', align: 'left', maxLines: 1 })
  ];
  sections.forEach((section, index) => {
    const y = sectionTop + index * (sectionH + sectionGap);
    const imageX = margin + 520;
    const imageW = width - margin * 2 - 540;
    elements.push(`<rect x="${margin}" y="${y}" width="${width - margin * 2}" height="${sectionH}" rx="22" fill="${style.cellBg || '#ffffff'}" stroke="${style.rowAlt || '#e5e7eb'}" stroke-width="1.4"/>`);
    elements.push(svgTextBlock({ text: section.title, x: margin + 28, y: y + 38, width: 420, height: 54, size: 40, weight: 950, fill: titlePalette.section, align: 'left', maxLines: 1 }));
    const bodyRanges = buildComparisonInlineEmphasisRanges({
      product,
      productIndex: 0,
      row: { key: 'highlights', label: section.title },
      value: section.body,
      emphasisPlan
    });
    elements.push(svgRichTextBlock({ text: section.body, x: margin + 28, y: y + 108, width: 438, height: sectionH - 132, size: 28, weight: 760, fill: style.textColor || '#111827', emphasisFill: emphasisPlan?.color || '#e11d2e', emphasisWeight: 950, emphasisRanges: bodyRanges, align: 'left', maxLines: 5 }));
    const href = imageDataHref(files[section.imageIndex]);
    if (href) {
      elements.push(`<image href="${href}" x="${imageX}" y="${y + 22}" width="${imageW}" height="${sectionH - 44}" preserveAspectRatio="xMidYMid meet"/>`);
    }
  });
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${elements.join('\n')}</svg>`;
  const result = await saveComparisonSvg({ svg, products: [product], data, style, trackUsage });
  return {
    ...result,
    comparisonEmphasisPlan: emphasisPlan,
    singleProductMultiImageLayout: true
  };
}

async function renderComparisonCardColumnsImage({ data, products, files, style, noteTitle, emphasisPlan = null, trackUsage = true }) {
  const width = 1200;
  const height = 1600;
  const margin = 34;
  const top = 142;
  const cardGap = 26;
  const labelW = 116;
  const cardW = (width - margin * 2 - labelW - cardGap * products.length) / products.length;
  const cardH = 1310;
  const grid = style.gridColor || '#2f4858';
  const elements = [
    `<defs><linearGradient id="cardGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${style.headerBg || '#c7e8ff'}"/><stop offset="58%" stop-color="${style.rowAlt || '#dff5ff'}"/><stop offset="100%" stop-color="#ffffff"/></linearGradient></defs>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    svgTextBlock({ text: data.title || noteTitle, x: margin, y: 16, width: width - margin * 2, height: 118, size: style.titleSize || 58, weight: 950, fill: style.titleColor || '#111827', align: 'left', maxLines: 2 })
  ];
  const rows = data.rows?.length ? data.rows : buildComparisonRows(products);
  const labelRows = rows.map((row) => row.label);
  const rowH = 72;
  const labelsTop = top + 330;
  labelRows.forEach((label, index) => {
    elements.push(svgTextBlock({ text: label, x: 0, y: labelsTop + index * rowH, width: labelW, height: rowH, size: 28, weight: 900, fill: grid, align: 'left', maxLines: 2 }));
  });
  products.forEach((product, index) => {
    const x = margin + labelW + cardGap + index * (cardW + cardGap);
    elements.push(`<rect x="${x}" y="${top}" width="${cardW}" height="${cardH}" rx="38" fill="url(#cardGrad)" stroke="${grid}" stroke-width="1.2" opacity="0.98"/>`);
    const href = imageDataHref(files[index]);
    if (href) elements.push(`<image href="${href}" x="${x + 22}" y="${top + 22}" width="${cardW - 44}" height="230" preserveAspectRatio="xMidYMid meet"/>`);
    elements.push(svgTextBlock({ text: product.name, x, y: top + 260, width: cardW, height: 82, size: 27, weight: 950, fill: style.textColor || '#111827', maxLines: 2 }));
    rows.forEach((row, rowIndex) => {
      const y = labelsTop + rowIndex * rowH;
      const value = getProductFieldDisplayValue(product, row);
      const emphasisRanges = buildComparisonInlineEmphasisRanges({ products, product, productIndex: index, row, value, emphasisPlan });
      const fallbackFill = !emphasisRanges.length && !emphasisPlan?.active
        ? getComparisonTextFill({ product, productIndex: index, row, value, style, emphasisPlan })
        : (style.textColor || '#111827');
      elements.push(svgRichTextBlock({ text: value || '', x, y, width: cardW, height: rowH, size: row.key === 'highlights' || row.key === 'audience' ? 22 : 25, weight: 800, fill: fallbackFill, emphasisFill: emphasisPlan?.color || '#e11d2e', emphasisWeight: 950, emphasisRanges, maxLines: 2 }));
    });
  });
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${elements.join('\n')}</svg>`;
  const result = await saveComparisonSvg({ svg, products, data, style, trackUsage });
  return {
    ...result,
    comparisonEmphasisPlan: emphasisPlan
  };
}

async function renderNarrativeReviewImage({ data, products, files, style, noteTitle, emphasisPlan = null, trackUsage = true }) {
  const width = 1200;
  const height = 1600;
  const margin = 40;
  const titleTop = 42;
  const titleH = 130;
  const contentTop = 205;
  const rowGap = 22;
  const rowH = Math.floor((height - contentTop - margin - rowGap * (products.length - 1)) / products.length);
  const imageW = 330;
  const textX = margin + imageW + 24;
  const textW = width - textX - margin;
  const title = products.length >= 2
    ? products.map((product) => product.name).filter(Boolean).join(' / ')
    : (data.title || noteTitle || products[0]?.name || '逐款点评');
  const titleColor = resolveUniformTitleColor(style, emphasisPlan);
  const elements = [
    `<rect width="${width}" height="${height}" fill="#f8f8f4"/>`,
    svgTextBlock({ text: title, x: margin, y: titleTop, width: width - margin * 2, height: titleH, size: Math.min(68, style.titleSize || 64), weight: 950, fill: titleColor, align: 'left', maxLines: 2 })
  ];
  products.forEach((product, index) => {
    const y = contentTop + index * (rowH + rowGap);
    const href = imageDataHref(files[index]);
    if (href) {
      elements.push(`<image href="${href}" x="${margin}" y="${y + 12}" width="${imageW - 20}" height="${rowH - 24}" preserveAspectRatio="xMidYMid meet"/>`);
    }
    const review = product.review || buildProductReviewFallback(product);
    const reviewText = `点评：${review}`;
    const reviewRanges = buildComparisonInlineEmphasisRanges({
      products,
      product,
      productIndex: index,
      row: { key: 'highlights', label: '点评' },
      value: reviewText,
      emphasisPlan
    });
    elements.push(`<text x="${textX}" y="${y + 45}" font-size="35" font-weight="950" fill="#e9bd22" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif">☀</text>`);
    elements.push(svgRichTextBlock({
      text: reviewText,
      x: textX + 42,
      y: y + 12,
      width: textW - 42,
      height: rowH - 24,
      size: products.length >= 5 ? 25 : 29,
      weight: 780,
      fill: style.textColor || '#111111',
      emphasisFill: emphasisPlan?.color || '#e11d2e',
      emphasisWeight: 950,
      emphasisRanges: reviewRanges,
      align: 'left',
      maxLines: products.length >= 5 ? 5 : 7
    }));
  });
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${elements.join('\n')}</svg>`;
  const result = await saveComparisonSvg({ svg, products, data, style, model: 'narrative-review-svg-sharp', trackUsage });
  return {
    ...result,
    comparisonEmphasisPlan: emphasisPlan,
    narrativeReviewLayout: true
  };
}

async function renderComparisonBandImage({ data, products, files, style, noteTitle, emphasisPlan = null, trackUsage = true }) {
  const width = 1200;
  const height = 1600;
  const margin = 36;
  const titleH = 150;
  const bandGap = 16;
  const bandH = Math.min(250, Math.floor((height - titleH - margin * 2 - bandGap * (products.length - 1)) / products.length));
  const accentPalette = [style.headerBg || '#7c3aed', '#228be6', '#34a853', '#f59e0b', '#ef4444'];
  const elements = [
    `<rect width="${width}" height="${height}" fill="#fbfdfb"/>`,
    svgTextBlock({ text: data.title || noteTitle, x: margin, y: 18, width: width - margin * 2, height: 105, size: style.titleSize || 58, weight: 950, fill: style.titleColor || '#0f172a', align: 'center', maxLines: 2 })
  ];
  products.forEach((product, index) => {
    const y = titleH + index * (bandH + bandGap);
    const accent = accentPalette[index % accentPalette.length];
    elements.push(`<rect x="${margin}" y="${y}" width="${width - margin * 2}" height="${bandH}" rx="22" fill="${style.cellBg || '#ffffff'}" stroke="${style.gridColor || '#d1d5db'}" stroke-width="1.2"/>`);
    elements.push(`<rect x="${margin}" y="${y}" width="220" height="${bandH}" rx="22" fill="${accent}"/>`);
    elements.push(svgTextBlock({ text: product.name, x: margin + 16, y: y + 20, width: 188, height: 90, size: 27, weight: 950, fill: '#ffffff', maxLines: 3 }));
    elements.push(svgTextBlock({ text: product.price || '按需推荐', x: margin + 22, y: y + bandH - 88, width: 176, height: 58, size: 25, weight: 900, fill: '#ffffff', maxLines: 2 }));
    const textX = margin + 250;
    const info = comparisonFieldLines(product).slice(1, 6);
    info.forEach(([label, value], lineIndex) => {
      const rowY = y + 24 + lineIndex * 38;
      elements.push(`<text x="${textX}" y="${rowY}" font-size="21" font-weight="800" fill="${accent}" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif">${escapeXml(label)}</text>`);
      const row = comparisonRows.find((candidate) => candidate.label === label) || { label };
      const emphasisRanges = buildComparisonInlineEmphasisRanges({ products, product, productIndex: index, row, value, emphasisPlan });
      const fallbackFill = !emphasisRanges.length && !emphasisPlan?.active
        ? getComparisonTextFill({ product, productIndex: index, row, value, style, emphasisPlan })
        : (style.textColor || '#111827');
      elements.push(svgRichTextBlock({ text: value, x: textX + 92, y: rowY - 30, width: 420, height: 36, size: 21, weight: 760, fill: fallbackFill, emphasisFill: emphasisPlan?.color || '#e11d2e', emphasisWeight: 950, emphasisRanges, align: 'left', maxLines: 1 }));
    });
    const footerValue = product.audience || product.highlights || '';
    const footerRow = product.audience ? { key: 'audience', label: '适合人群' } : { key: 'highlights', label: '核心亮点' };
    const footerRanges = buildComparisonInlineEmphasisRanges({ products, product, productIndex: index, row: footerRow, value: footerValue, emphasisPlan });
    elements.push(svgRichTextBlock({ text: footerValue, x: textX, y: y + bandH - 66, width: 520, height: 44, size: 20, weight: 760, fill: style.textColor || '#111827', emphasisFill: emphasisPlan?.color || '#e11d2e', emphasisWeight: 950, emphasisRanges: footerRanges, align: 'left', maxLines: 2 }));
    const href = imageDataHref(files[index]);
    if (href) elements.push(`<image href="${href}" x="${width - margin - 310}" y="${y + 26}" width="280" height="${bandH - 52}" preserveAspectRatio="xMidYMid meet"/>`);
  });
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${elements.join('\n')}</svg>`;
  const result = await saveComparisonSvg({ svg, products, data, style, trackUsage });
  return {
    ...result,
    comparisonEmphasisPlan: emphasisPlan
  };
}

async function renderComparisonGridImage({ data, products, files, style, noteTitle, emphasisPlan = null, trackUsage = true }) {
  const width = 1200;
  const height = 1600;
  const margin = 48;
  const cols = products.length <= 4 ? 2 : 3;
  const colGap = cols === 2 ? 64 : 44;
  const rowGap = cols === 2 ? 84 : 82;
  const tileW = (width - margin * 2 - colGap * (cols - 1)) / cols;
  const tileH = products.length <= 4 ? 360 : 245;
  const imageH = products.length <= 4 ? 194 : 128;
  const firstTileY = products.length <= 4 ? 290 : 250;
  const elements = [
    `<rect width="${width}" height="${height}" fill="${style.rowAlt || '#e8f5ff'}"/>`,
    `<rect x="${margin}" y="38" width="${width - margin * 2}" height="92" rx="42" fill="${style.titleColor || '#1f5f82'}"/>`,
    svgTextBlock({ text: data.title || noteTitle, x: margin + 20, y: 48, width: width - margin * 2 - 40, height: 70, size: 48, weight: 950, fill: '#ffffff', maxLines: 1 }),
    svgTextBlock({ text: data.summary || '按预算、用途和核心参数整理推荐', x: margin, y: 146, width: width - margin * 2, height: 62, size: 34, weight: 850, fill: style.textColor || '#111827', maxLines: 2 })
  ];
  products.forEach((product, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = margin + col * (tileW + colGap);
    const y = firstTileY + row * (tileH + rowGap);
    elements.push(`<rect x="${x}" y="${y}" width="${tileW}" height="${tileH}" rx="16" fill="#ffffff" stroke="${style.gridColor || '#a7c8dc'}" stroke-width="1"/>`);
    const href = imageDataHref(files[index]);
    if (href) elements.push(`<image href="${href}" x="${x + 28}" y="${y + 24}" width="${tileW - 56}" height="${imageH}" preserveAspectRatio="xMidYMid meet"/>`);
    elements.push(svgTextBlock({ text: product.name, x, y: y + imageH + 42, width: tileW, height: 56, size: products.length <= 4 ? 29 : 23, weight: 900, fill: style.textColor || '#111827', maxLines: 2 }));
    const value = product.audience || product.highlights || product.price;
    const rowInfo = product.audience ? { key: 'audience', label: '适合人群' } : product.highlights ? { key: 'highlights', label: '核心亮点' } : { key: 'price', label: '到手价' };
    const emphasisRanges = buildComparisonInlineEmphasisRanges({ products, product, productIndex: index, row: rowInfo, value, emphasisPlan });
    const fill = !emphasisRanges.length && !emphasisPlan?.active
      ? getComparisonTextFill({ product, productIndex: index, row: rowInfo, value, style: { ...style, textColor: style.titleColor || '#1f5f82' }, emphasisPlan })
      : (style.titleColor || '#1f5f82');
    elements.push(svgRichTextBlock({ text: value, x: x + 18, y: y + imageH + 112, width: tileW - 36, height: 78, size: products.length <= 4 ? 22 : 18, weight: 760, fill, emphasisFill: emphasisPlan?.color || '#e11d2e', emphasisWeight: 950, emphasisRanges, maxLines: 3 }));
  });
  const footerY = height - 118;
  elements.push(`<rect x="${margin + 70}" y="${footerY}" width="${width - margin * 2 - 140}" height="70" rx="35" fill="#ffffff" stroke="${style.titleColor || '#1f5f82'}" stroke-width="4"/>`);
  elements.push(svgTextBlock({ text: '新品放价 | 参数已整理', x: margin + 90, y: footerY + 10, width: width - margin * 2 - 180, height: 48, size: 32, weight: 950, fill: style.titleColor || '#1f5f82', maxLines: 1 }));
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${elements.join('\n')}</svg>`;
  const result = await saveComparisonSvg({ svg, products, data, style, trackUsage });
  return {
    ...result,
    comparisonEmphasisPlan: emphasisPlan
  };
}

async function generateComparisonTableImage({ comparisonData, files = [], noteTitle, sourceText = '', topicDirection = '', comparisonStyleId = '', visualMode = 'comparison', trackUsage = true }) {
  const data = normalizeComparisonData(comparisonData, noteTitle, sourceText);
  if (!isComparisonDataUseful(data)) {
    throw new Error('没有识别到产品参数。请在原始正文里写明产品名、价格和参数。');
  }
  const style = pickComparisonStyle(comparisonStyleId, isReviewMode(visualMode) ? 'review' : 'comparison');
  const products = data.products.slice(0, Math.max(2, Math.min(5, data.products.length)));
  const dynamicRows = data.rows?.length ? data.rows : buildComparisonRows(products);
  const emphasisPlan = buildComparisonEmphasisPlan(data, topicDirection);
  if (products.length === 1 && files.length > 1) {
    return renderSingleProductMultiImageReview({ data, product: products[0], files, style, noteTitle, emphasisPlan, trackUsage });
  }
  if (style.layout === 'three-cards') {
    return renderComparisonCardColumnsImage({ data, products: products.slice(0, 4), files, style, noteTitle, emphasisPlan, trackUsage });
  }
  if (isNarrativeReviewStyle(style)) {
    return renderNarrativeReviewImage({ data, products, files, style, noteTitle, emphasisPlan, trackUsage });
  }
  if (style.layout === 'series-bands' || style.layout === 'major-rows') {
    return renderComparisonBandImage({ data, products, files, style, noteTitle, emphasisPlan, trackUsage });
  }
  if (style.layout === 'student-grid') {
    return renderComparisonGridImage({ data, products, files, style, noteTitle, emphasisPlan, trackUsage });
  }
  const width = 1200;
  const height = 1600;
  const margin = 28;
  const titleY = 44;
  const tableX = margin;
  const tableY = 210;
  const tableW = width - margin * 2;
  const labelW = 128;
  const colW = (tableW - labelW) / products.length;
  const headerBlue = style.headerBg || '#95b8f2';
  const grid = style.gridColor || '#4b5563';
  const cellBg = style.cellBg || '#f8fafc';
  const rowAlt = style.rowAlt || '#eef4ff';
  const elements = [
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
    svgTextBlock({ text: data.title || noteTitle, x: margin, y: titleY, width: width - margin * 2, height: 120, size: style.titleSize || 64, weight: 900, fill: style.titleColor || '#3f7fdc', align: 'left', maxLines: 2 })
  ];
  let y = tableY;
  const rows = [
    { key: 'name', label: '产品', height: 136, bg: headerBlue, isHeader: true },
    { key: 'image', label: '图片', height: 160, bg: cellBg },
    ...dynamicRows
  ];
  for (const row of rows) {
    elements.push(`<rect x="${tableX}" y="${y}" width="${tableW}" height="${row.height}" fill="${row.bg || cellBg}" stroke="${grid}" stroke-width="${style.gridWidth || 1.5}"/>`);
    elements.push(`<rect x="${tableX}" y="${y}" width="${labelW}" height="${row.height}" fill="${row.bg || cellBg}" stroke="${grid}" stroke-width="${style.gridWidth || 1.5}"/>`);
    elements.push(svgTextBlock({ text: row.label, x: tableX, y, width: labelW, height: row.height, size: row.isHeader ? 30 : 31, weight: 900, fill: style.textColor || '#0f172a', maxLines: 2 }));
    products.forEach((product, index) => {
      const x = tableX + labelW + index * colW;
      const fill = row.key === 'audience' ? (style.audienceBg || headerBlue) : (row.bg || (index % 2 ? rowAlt : cellBg));
      elements.push(`<rect x="${x}" y="${y}" width="${colW}" height="${row.height}" fill="${fill}" stroke="${grid}" stroke-width="${style.gridWidth || 1.5}"/>`);
      if (row.key === 'image') {
        const href = imageDataHref(files[index]);
        if (href) {
          const imageW = colW - 34;
          const imageH = row.height - 28;
          elements.push(`<image href="${href}" x="${x + 17}" y="${y + 14}" width="${imageW}" height="${imageH}" preserveAspectRatio="xMidYMid meet"/>`);
        }
      } else {
        const value = row.key === 'name' ? product.name : getProductFieldDisplayValue(product, row);
        const size = row.key === 'name' ? 28 : row.key === 'highlights' || row.key === 'audience' ? 28 : 30;
        const maxLines = row.key === 'screen' || row.key === 'highlights' || row.key === 'audience' ? 4 : 3;
        const emphasisRanges = row.key === 'name' ? [] : buildComparisonInlineEmphasisRanges({ products, product, productIndex: index, row, value, emphasisPlan });
        const textFill = row.key === 'name' || emphasisRanges.length || emphasisPlan?.active
          ? (style.textColor || '#0b1220')
          : getComparisonTextFill({ product, productIndex: index, row, value, style, emphasisPlan });
        elements.push(svgRichTextBlock({ text: value || '', x, y, width: colW, height: row.height, size, weight: 850, fill: textFill, emphasisFill: emphasisPlan?.color || '#e11d2e', emphasisWeight: 950, emphasisRanges, maxLines }));
      }
    });
    y += row.height;
  }
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${elements.join('\n')}</svg>`;
  const result = await saveComparisonSvg({ svg, products, data, style, trackUsage });
  return {
    ...result,
    comparisonEmphasisPlan: emphasisPlan
  };
}

async function generatePosterCardImage({ item = {}, aspectRatio = '3:4 小红书竖图' }) {
  if (!cardTemplateFiles.length) {
    throw new Error('还没有配置大字报卡片模板资产。');
  }
  const template = pickCardTemplate(item);
  const templateFile = cardTemplateFiles[Math.min(template.assetIndex, cardTemplateFiles.length - 1)] || cardTemplateFiles[0];
  const cardText = cleanCardText(item.cardText || item.noteTitle || item.huaziText || '小红书封面文案');
  const accentWords = parseAccentWords(item.accentWords, cardText);
  const backgroundB64 = fs.readFileSync(templateFile).toString('base64');
  const backgroundMime = /\.(png)$/i.test(templateFile) ? 'image/png' : 'image/jpeg';
  const svg = `<svg width="1200" height="1600" viewBox="0 0 1200 1600" xmlns="http://www.w3.org/2000/svg">
<defs>
<style>
${fontCssForCard(template.font)}
text{letter-spacing:0}
</style>
</defs>
<image href="data:${backgroundMime};base64,${backgroundB64}" x="0" y="0" width="1200" height="1600" preserveAspectRatio="xMidYMid slice"/>
${renderCardTextSvg({ text: cardText, template, accentWords })}
</svg>`;
  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const fileName = `card-${String(item.id || 1).padStart(2, '0')}-${Date.now()}.png`;
  fs.writeFileSync(path.join(outputDir, fileName), pngBuffer);
  const usageLog = appendUsageLog({
    type: 'poster-card-generate',
    provider: 'local',
    model: 'template-svg-sharp',
    templateId: template.id,
    font: cardFonts[template.font]?.label || template.font,
    usage: { moneyCost: 0, coinCost: 0, currency: 'CNY' }
  });
  return {
    imageUrl: `/outputs/${fileName}`,
    prompt: `大字报卡片本地生成：模板=${template.name}，字体=${cardFonts[template.font]?.label || template.font}，文案=${cardText}，强调词=${accentWords.join('、') || '无'}，画幅=${aspectRatio || '3:4'}`,
    model: '本地大字报卡片模板',
    taskId: null,
    usage: { moneyCost: 0, coinCost: 0, currency: 'CNY' },
    usageLog,
    templateId: template.id,
    accentWords
  };
}

function buildCoverPrompt({ noteTitle, noteBody, huaziText, aspectRatio, style, promptFeedback, optimizedRules, revisionMode, revisionFeedback, topicDirection, imageBrief, visualMode, styleTemplate }) {
  const textRule = huaziText?.trim()
    ? `用户指定的花字文案如下，必须逐字准确使用，不得增删改任何汉字、数字、英文或标点：\n${huaziText.trim()}`
    : `请根据用户提供的小红书标题和正文，自动提炼适合封面的花字文案。花字总字数控制在 6-18 个中文字符，可分为主标题和副标题；不要加入无根据的促销词、价格、品牌名。`;
  const allowAtmosphere = visualMode === 'atmosphere';
  const tuningRules = buildPromptTuningRules({ promptFeedback, optimizedRules });
  const styleTemplateRules = formatStyleTemplateForPrompt(styleTemplate);
  const revisionRules = revisionMode && revisionFeedback?.trim()
    ? `## 本次只修改当前生成结果\n你会收到一张已经生成过的小红书封面图。请不要重新设计整张图，只按以下批注做局部调整：\n${revisionFeedback.trim()}\n\n修改要求：\n- 只调整批注中提到的文字大小、位置、层级、颜色、装饰或轻微修图问题。\n- 没被批注提到的画面内容、家具、场景、构图和花字文案尽量保持不变。\n- 不要新增任何文字，不要改写既有花字文案。\n- 输出一张修改后的完整封面图。`
    : '';

  return `你是一个帮用户生成小红书素人笔记封面图片的助手。你会收到一张家庭/家居/智能家居场景照片，用于小红书笔记封面。

用户笔记标题：
${noteTitle || '未提供'}

用户笔记正文/卖点：
${noteBody || '未提供'}

本批选题方向/画面目标：
${topicDirection || '未提供'}

本张封面的画面生成思路：
${imageBrief || '未提供，请基于标题和正文选择自然留白和合适花字样式。'}

${textRule}

## 任务一：图片修正
- 画面倾斜时，轻微校正水平。
- 曝光明显过暗/过曝时，做基础明暗修正。
- 其他情况不处理，保留手机实拍质感。
- 不要把照片做成品牌宣传海报、电商详情页、数码发布会 KV 或产品精修图。
${allowAtmosphere
    ? `- 当前允许“氛围改造”：可以在不破坏原图主体空间、透视关系和真实感的前提下，加入与选题相关的轻量环境元素、智能家居状态、光线氛围或生活化道具。例如根据用户主题加入真实自然的小道具、灯光状态、生活痕迹或场景暗示，但不要把画面做成夸张合成海报。
- 不要凭空替换核心家具、家电或空间结构；新增元素必须自然融入照片，像真实家庭生活现场。`
    : `- 不改变家具、家电、摆件、墙面、地面、窗户、空间结构等真实内容。`}

## 任务二：花字叠加
将花字文案叠加到图片上，输出带花字的吸引人的小红书封面图。

文字要求：
- 图片中新增的花字只能来自上面的花字文案。
- 不得新增英文、水印、编号、营销口号、虚构品牌名或其他说明文字。
- 如果原图中已有屏幕文字、设备界面、墙面装饰文字或其他真实文字，请尽量保持原样，不要改写。

花字风格：
- 整体是小红书家庭生活方式/智能家居种草封面风，像手机修图 App 里叠加的轻量花字，不是品牌广告、智能硬件发布会、电商详情页或科技海报。
- 主标题必须醒目，使用粗体中文标题字，短句分 2-3 行；副标题与主标题形成明显层级。
- 字体要清晰、亲和、生活化，可以有一点轻科技感，但不要做成厚重 UI 面板或赛博风。
- 每张图只选择一种花字变体，不要混搭过多效果：
  1. 便签贴纸款：浅色纸贴/便签底，粗体标题，少量胶带角标、小圆点或手绘符号。
  2. 杂志标题款：粗标题 + 细线/细边框标签，排版克制，适合干净家庭场景。
  3. 关键词高亮款：只突出 1 个关键词，用色块、细描边或半透明底托强调，其余文字保持干净。
  4. 手绘标注款：主标题清晰，副标题可用细箭头、圆圈或下划线指向智能设备、灯光、电视、沙发区等细节。
- 可以使用半透明标签、细线框、便签、轻量贴纸、手绘箭头、小圆点、小短线、小闪光等元素；装饰只做点缀，不能抢主体。
- 不要使用厚重投影、霓虹发光、彩虹渐变、复杂贴纸、大面积遮罩、强商业海报底板。

配色规则：
- 必须先判断图片的主色调、背景明暗和家庭场景风格，再选择花字颜色；不要固定套用某一组颜色。
- 不要默认套用固定的家具门店暖色系；只有当原图本身色系适合时，才可使用相近的低饱和暖色。
- 浅色背景使用低饱和深色文字，必要时加浅色底托或细描边保证可读。
- 深色背景使用浅色文字，必要时加深色细描边、半透明底托或细线框保证可读。
- 现代/智能家居场景优先使用干净、低饱和、高对比的生活化配色，例如灰白、炭黑、雾蓝、浅银、低饱和绿、柔和橙等，但必须根据原图色系选择，不能生硬套色。
- 家庭生活场景配色要自然、亲和，不要像数码发布会、科技广告或电商促销图。
- 每张图最多 2 个主色，装饰色不超过 1 个；文字与背景必须有明显明暗对比。

排版规则：
- 文字放在自然留白处，或在画面视觉中心附近，避免遮挡人物、电视画面、智能设备、核心家具、家电和重要空间信息。
- 花字区域占图片面积尽量不超过 22%，生活氛围图可更克制。
- 如果背景复杂，优先使用半透明底托、细描边、便签底或局部浅色纸贴来保证可读，不要大面积盖住画面。

输出要求：
- 生成一张完整封面图。
- 保持原图的真实家庭/生活场景照片质感。
- 推荐画幅：${aspectRatio || '保持原图比例'}。
- 用户偏好的风格补充：${style || '家庭生活方式/智能家居/真实照片质感/干净醒目'}。
- 画面模式：${allowAtmosphere ? '允许轻量氛围改造' : '仅实拍轻修和花字叠加'}。

${styleTemplateRules}

${revisionRules}

${tuningRules}`;
}

function buildPromptTuningRules({ promptFeedback, optimizedRules }) {
  const parts = [];
  if (optimizedRules?.trim()) {
    parts.push(`## 已锁定的图片提示词优化策略\n${optimizedRules.trim()}`);
  }
  if (promptFeedback?.trim()) {
    parts.push(`## 本轮测试反馈/新增需求\n${promptFeedback.trim()}\n\n请优先满足以上反馈，但不能违反“文字准确、原图内容不改变、保留实拍质感”的核心要求。`);
  }
  return parts.join('\n\n');
}

function buildPromptOptimizerPrompt({ basePrompt, feedback }) {
  return `你是一个图片生成提示词调参 agent。请根据用户对测试封面的反馈，优化下面这段“小红书封面图片编辑提示词”。

用户反馈/新需求：
${feedback || '未提供'}

原始图片提示词：
${basePrompt || '未提供'}

优化目标：
- 只优化图片生成提示词，不生成帖子文案。
- 保留原提示词的大框架：轻度修图、花字叠加、实拍质感、文字准确。
- 将反馈转成明确、可执行的视觉约束。
- 如果反馈涉及错误结果，例如“太像广告”“字太大”“遮挡产品”“原图被改了”，请加入避免再次发生的约束。
- 不要让提示词变得过长或互相矛盾。

输出格式：
1. 先输出“优化策略”，用 3-8 条短规则。
2. 再输出“优化后的完整图片提示词”。`;
}

function makeOptimizedRules(feedback) {
  const text = (feedback || '').trim();
  const rules = [];
  if (!text) {
    return '- 保持默认策略，先用一张图测试花字位置、文字准确性和原图保真度。';
  }
  rules.push(`- 本轮用户反馈：${text}`);
  if (/字|文字|花字|标题/.test(text)) {
    rules.push('- 更严格控制花字：文字必须逐字准确，避免变形、错字、漏字、多字，文字区域不要过大。');
  }
  if (/大|太大|遮挡|挡/.test(text)) {
    rules.push('- 缩小花字占比，优先放在墙面、窗边、沙发旁、桌面边缘或其他自然留白处，不遮挡人物、电视画面、智能设备、核心家电和空间主体。');
  }
  if (/广告|海报|商业|电商|精修/.test(text)) {
    rules.push('- 降低海报感和商业感，保留手机实拍质感，装饰元素更克制。');
  }
  if (/原图|改动|变了|家具|场景/.test(text)) {
    rules.push('- 强化原图保真：不要改变核心家具/家电结构、智能设备位置、真实生活陈设和空间布局。');
  }
  if (/颜色|配色|突兀|跳/.test(text)) {
    rules.push('- 配色必须先判断原图色系和背景明暗，自适应选择低饱和高对比颜色，避免固定套用家具门店暖色系。');
  }
  if (/高级|质感|小红书|醒图|黄油/.test(text)) {
    rules.push('- 花字风格向小红书家庭生活方式种草靠拢，像手机修图 App 的轻量花字，但不要做成品牌物料、科技发布会或电商广告。');
  }
  if (rules.length === 1) {
    rules.push('- 将反馈转化为更明确的版式、字体、颜色、装饰和原图保真约束。');
  }
  return rules.join('\n');
}

function clampBatchCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count)) return 50;
  return Math.max(1, Math.min(maxBatchCount, count));
}

function clampConcurrency(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isFinite(count)) return 5;
  return Math.max(1, Math.min(20, count));
}

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeTopic({ topic, noteTitle }) {
  return (topic || noteTitle || '智能家居生活方式灵感').trim();
}

function extractTopicKeywords({ topic, noteBody, topicDirection }) {
  const source = `${topic || ''}\n${topicDirection || ''}\n${noteBody || ''}`;
  const normalized = source
    .replace(/[，。！？、,.!?；;：:“”"'‘’（）()【】\[\]《》]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [];
  const stopWords = new Set([
    '这个', '那个', '一种', '一下', '真的', '很有', '感觉', '氛围', '模式', '适合', '希望', '生成',
    '封面', '图片', '素材', '文案', '标题', '正文', '画面', '方向', '目标', '我的', '一个', '一些',
    '但是', '因为', '所以', '如果', '可以', '不能', '不要', '需要', '结合', '根据', '小红书'
  ]);
  const matches = normalized.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,12}/g) || [];
  const keywords = [];
  for (const token of matches) {
    if (stopWords.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (!keywords.includes(token)) keywords.push(token);
    if (keywords.length >= 8) break;
  }
  return keywords;
}

function makeFallbackCoverText(title, topicKeywords = []) {
  const cleanTitle = String(title || '')
    .replace(/[，。！？、,.!?；;：:“”"'‘’（）()【】\[\]《》]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const titleClauses = String(title || '')
    .split(/[，。！？、,.!?；;]/)
    .map((part) => part.trim())
    .filter(Boolean);
  let preferred = titleClauses.find((part) => topicKeywords.some((keyword) => part.includes(keyword) || keyword.includes(part)))
    || titleClauses[0]
    || topicKeywords[0]
    || cleanTitle;
  preferred = preferred
    .replace(/(别再|不用|不要|不必|无需|再也不用|终于不用).+$/g, '')
    .replace(/(开赛前|出门前|回家后|下班后|睡前|周末).*(就够了|搞定|准备好)$/g, '$1')
    .replace(/(真的|直接|马上|立刻|一秒|瞬间|轻松|也能|就能|可以|很有|超有|更有|有点|满满).+$/g, '')
    .replace(/[，。！？、,.!?；;：:“”"'‘’（）()【】\[\]《》]/g, '')
    .trim();
  if (preferred.length < 2) {
    preferred = topicKeywords[0] || cleanTitle.slice(0, 8);
  }
  if (preferred.length > 8) {
    const shortKeyword = topicKeywords
      .filter((keyword) => keyword.length >= 2 && keyword.length <= 6)
      .find((keyword) => preferred.includes(keyword) || cleanTitle.includes(keyword));
    preferred = shortKeyword || preferred.slice(0, 8);
  }
  const suffixes = ['氛围到位', '一秒进入', '真的有感', '直接拉满', '刚刚好'];
  const suffix = suffixes[Math.abs(cleanTitle.length + preferred.length) % suffixes.length];
  const text = `${preferred}\n${suffix}`.trim();
  return text;
}

function coverTextLooksUnsafe(text) {
  const lines = String(text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return true;
  if (lines.some((line) => line.length > 9)) return true;
  if (lines.join('').length > 16) return true;
  return false;
}

function enforceTopicFocus(items, context) {
  if (isPosterMode(context.visualMode)) {
    return items.map((item, index) => {
      const cardText = repairPosterCardText(item.cardText || item.noteTitle || context.topic || '小红书卡片封面', context, index);
      const templateHint = String(item.templateHint || item.cardTemplate || '').trim();
      const template = cardTemplateConfigs.find((entry) => entry.id === templateHint) || cardTemplateConfigs[index % cardTemplateConfigs.length];
      return {
        ...item,
        noteTitle: cardText,
        cardText,
        huaziText: '',
        imageBrief: '',
        accentWords: parseAccentWords(item.accentWords, cardText),
        cardTemplate: template.id
      };
    });
  }
  return items.map((item) => {
    return {
      ...item,
      huaziText: item.noteTitle || context.topic || item.huaziText || ''
    };
  });
}

function getTextClient() {
  return textApiKey ? new OpenAI({ apiKey: textApiKey, baseURL: textBaseUrl || undefined }) : null;
}

function getImageClient() {
  return imageApiKey ? new OpenAI({ apiKey: imageApiKey }) : null;
}

function appendUsageLog(event) {
  const entry = { time: new Date().toISOString(), ...event };
  fs.appendFileSync(usageLogPath, `${JSON.stringify(entry)}\n`);
  console.log('[usage]', JSON.stringify(entry));
  return entry;
}

function readRecentUsage(limit = 20) {
  if (!fs.existsSync(usageLogPath)) return [];
  return fs.readFileSync(usageLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeAspectRatio(value) {
  const match = String(value || '').match(/\d+\s*:\s*\d+/);
  return match ? match[0].replace(/\s+/g, '') : '3:4';
}

function sanitizeFilePart(value) {
  return String(value || 'cover')
    .replace(/[\\/:*?"<>|\r\n]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48) || 'cover';
}

function normalizeRunningHubOpenApiEndpoint(endpoint) {
  const value = String(endpoint || '').trim();
  if (!value) return '/openapi/v2';
  if (/^https?:\/\//i.test(value)) return value;
  const withSlash = value.startsWith('/') ? value : `/${value}`;
  if (/^\/openapi(\/|$)/i.test(withSlash)) return withSlash;
  return `/openapi/v2${withSlash}`;
}

function isRunningHubSuccessCode(code) {
  return code === undefined || code === null || String(code) === '0';
}

function getRunningHubUrl(endpoint) {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${runningHubBaseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
}

async function runningHubJson(endpoint, body) {
  const response = await fetch(getRunningHubUrl(endpoint), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${runningHubImageApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body || {})
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data?.message || data?.msg || data?.errorMessage || `RunningHub HTTP ${response.status}`);
  }
  if (!isRunningHubSuccessCode(data?.code)) {
    const error = new Error(data?.message || data?.msg || data?.errorMessage || `RunningHub code ${data.code}`);
    error.runningHubCode = data.code;
    throw error;
  }
  return data;
}

async function getRunningHubAccountUsageSnapshot() {
  if (!runningHubImageApiKey) return null;
  const data = await runningHubJson('/uc/openapi/accountStatus', { apikey: runningHubImageApiKey });
  const payload = data?.data || {};
  return {
    remainCoins: Number(payload.remainCoins ?? 0),
    remainMoney: Number(payload.remainMoney ?? 0),
    currentTaskCounts: Number(payload.currentTaskCounts ?? 0),
    currency: payload.currency || 'CNY',
    apiType: payload.apiType
  };
}

function buildRunningHubCost(before, after) {
  if (!before || !after) return null;
  return {
    coinCost: Number((before.remainCoins - after.remainCoins).toFixed(6)),
    moneyCost: Number((before.remainMoney - after.remainMoney).toFixed(6)),
    currency: after.currency || before.currency || 'CNY',
    before,
    after
  };
}

async function uploadToRunningHub(file) {
  const form = new FormData();
  const bytes = fs.readFileSync(file.path);
  const blob = new Blob([bytes], { type: file.mimetype || 'application/octet-stream' });
  form.append('file', blob, file.originalname || 'cover.jpg');

  const response = await fetch(getRunningHubUrl(runningHubUploadEndpoint), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${runningHubImageApiKey}`
    },
    body: form
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.message || data?.msg || data?.errorMessage || `RunningHub 上传失败 HTTP ${response.status}`);
  }
  if (!isRunningHubSuccessCode(data?.code)) {
    throw new Error(data?.message || data?.msg || data?.errorMessage || `RunningHub 上传失败 code ${data.code}`);
  }
  const payload = data?.data || data;
  const downloadUrl = payload?.download_url || payload?.downloadUrl || payload?.url;
  if (!downloadUrl) {
    throw new Error('RunningHub 上传成功但没有返回 download_url。');
  }
  return { downloadUrl, raw: data };
}

function findRunningHubValueByKey(value, keys = new Set()) {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findRunningHubValueByKey(item, keys);
      if (found) return found;
    }
    return '';
  }
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key) && (typeof nested === 'string' || typeof nested === 'number')) {
      return String(nested);
    }
  }
  for (const nested of Object.values(value)) {
    const found = findRunningHubValueByKey(nested, keys);
    if (found) return found;
  }
  return '';
}

function getTaskId(data) {
  return data?.taskId
    || data?.data?.taskId
    || data?.data?.task_id
    || data?.task_id
    || data?.result?.taskId
    || data?.result?.task_id
    || data?.data?.id
    || data?.id
    || findRunningHubValueByKey(data, new Set(['taskId', 'task_id', 'taskID']));
}

function getRunningHubResponseMessage(data) {
  const direct = data?.message
    || data?.msg
    || data?.errorMessage
    || data?.error
    || data?.data?.message
    || data?.data?.msg
    || data?.data?.errorMessage
    || data?.data?.error;
  if (direct) return String(direct);
  return findRunningHubValueByKey(data, new Set(['message', 'msg', 'errorMessage', 'error', 'reason']));
}

function summarizeRunningHubResponse(data) {
  try {
    return JSON.stringify(data).slice(0, 500);
  } catch {
    return String(data || '').slice(0, 500);
  }
}

function getTaskStatus(data) {
  return String(data?.status || data?.data?.status || data?.taskStatus || data?.data?.taskStatus || '').toUpperCase();
}

function collectUrls(value, urls = []) {
  if (!value) return urls;
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) urls.push(value);
    return urls;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectUrls(item, urls));
    return urls;
  }
  if (typeof value === 'object') {
    for (const key of ['fileUrl', 'url', 'imageUrl', 'download_url', 'downloadUrl']) {
      if (typeof value[key] === 'string' && /^https?:\/\//i.test(value[key])) {
        urls.push(value[key]);
      }
    }
    for (const item of Object.values(value)) {
      collectUrls(item, urls);
    }
  }
  return [...new Set(urls)];
}

async function waitForRunningHubResult(taskId) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const data = await runningHubJson(runningHubQueryEndpoint, { taskId });
    const status = getTaskStatus(data);
    const urls = collectUrls(data?.results || data?.data?.results || data?.data || data);
    if ((status === 'SUCCESS' || status === 'COMPLETED' || status === 'FINISHED') && urls.length) {
      return { imageUrl: urls[0], status, raw: data };
    }
    if (status === 'FAILED' || status === 'FAIL' || status === 'ERROR' || status === 'CANCELED' || status === 'CANCELLED') {
      throw new Error(data?.errorMessage || data?.data?.errorMessage || data?.msg || 'RunningHub 任务失败');
    }
    if (urls.length && !status) {
      return { imageUrl: urls[0], status: 'SUCCESS', raw: data };
    }
    await sleep(3000);
  }
  throw new Error('RunningHub 任务超时，还没有返回图片。');
}

async function saveRemoteImage(remoteUrl, prefix = 'cover') {
  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`下载 RunningHub 结果失败 HTTP ${response.status}`);
  }
  const contentType = response.headers.get('content-type') || '';
  const ext = contentType.includes('jpeg') ? 'jpg' : contentType.includes('webp') ? 'webp' : 'png';
  const fileName = `${prefix}-${Date.now()}.${ext}`;
  const outputPath = path.join(outputDir, fileName);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  return `/outputs/${fileName}`;
}

async function generateImageWithRunningHub({ file, prompt, aspectRatio, resolution = '1k', prefix, trackUsage = true }) {
  if (!runningHubImageApiKey) {
    throw new Error('还没有配置 RUNNINGHUB_IMAGE_API_KEY。');
  }
  const usageBefore = trackUsage ? await getRunningHubAccountUsageSnapshot().catch(() => null) : null;
  const uploaded = await uploadToRunningHub(file);
  const submitData = await runningHubJson(runningHubImageEndpoint, {
    prompt,
    imageUrls: [uploaded.downloadUrl],
    aspectRatio: normalizeAspectRatio(aspectRatio),
    resolution
  });
  const taskId = getTaskId(submitData);
  if (!taskId) {
    const urls = collectUrls(submitData);
    if (urls.length) {
      const localUrl = await saveRemoteImage(urls[0], prefix);
      const usageAfter = trackUsage ? await getRunningHubAccountUsageSnapshot().catch(() => null) : null;
      const usage = buildRunningHubCost(usageBefore, usageAfter);
      const usageLog = trackUsage ? appendUsageLog({
        type: 'image-generate',
        provider: 'runninghub',
        model: runningHubModelName,
        endpoint: runningHubImageEndpoint,
        taskId: null,
        aspectRatio: normalizeAspectRatio(aspectRatio),
        resolution,
        usage
      }) : null;
      return { imageUrl: localUrl, taskId: null, raw: submitData, usage, usageLog };
    }
    const message = getRunningHubResponseMessage(submitData);
    const error = new Error(message
      ? `RunningHub 没有返回 taskId：${message}`
      : `RunningHub 没有返回 taskId。可能是接口临时失败、排队/限流、余额不足或返回格式变化。返回摘要：${summarizeRunningHubResponse(submitData)}`);
    error.runningHubRaw = submitData;
    throw error;
  }
  const result = await waitForRunningHubResult(taskId);
  const localUrl = await saveRemoteImage(result.imageUrl, prefix);
  const usageAfter = trackUsage ? await getRunningHubAccountUsageSnapshot().catch(() => null) : null;
  const usage = buildRunningHubCost(usageBefore, usageAfter);
  const usageLog = trackUsage ? appendUsageLog({
    type: 'image-generate',
    provider: 'runninghub',
    model: runningHubModelName,
    endpoint: runningHubImageEndpoint,
    taskId,
    aspectRatio: normalizeAspectRatio(aspectRatio),
    resolution,
    usage
  }) : null;
  return { imageUrl: localUrl, taskId, raw: result.raw, usage, usageLog };
}

function buildBatchPlanningPrompt({ topic, noteBody, count, topicDirection, visualMode, imageAnalysis, styleTemplate }) {
  if (isPosterMode(visualMode)) {
    return buildPosterBatchPlanningPrompt({ topic, noteBody, count, topicDirection });
  }
  const safeCount = clampBatchCount(count);
  const analysisText = imageAnalysis ? JSON.stringify(imageAnalysis, null, 2) : '未提供。请只依据用户文字做保守规划，不要假设图片里一定有某个物体。';
  const topicKeywords = extractTopicKeywords({ topic, noteBody, topicDirection });
  const focusRule = `本批主题必须严格服从“原始标题 + 原始正文 + 本批选题方向/画面目标”的共同语义。系统抽取到的主题关键词为：${topicKeywords.join('、') || '未抽取到，请自行总结'}。你必须先总结本批核心主题，再围绕这个主题生成变体；不得把主题扩写成另一个生活场景。`;
  return `你是一个小红书家庭生活方式/智能家居内容策划助手。请基于用户提供的原始标题和原始正文，生成 ${safeCount} 条不同表述的小红书图文帖子方案，用于批量生成封面图。

原始标题：
${topic || '未提供'}

原始正文：
${noteBody || '未提供'}

本批选题方向/画面目标：
${topicDirection || '未提供'}

画面模式：
${visualMode === 'atmosphere' ? '允许轻量氛围改造：可以基于原始素材加入符合选题的生活化氛围、道具、光线或场景暗示，但不要做成夸张合成海报。' : '仅实拍轻修：只做轻度修图、花字和很克制的装饰，不改变原始场景内容。'}

原图视觉分析：
${analysisText}

${styleTemplate ? `${formatStyleTemplateForPrompt(styleTemplate)}\n` : ''}

要求：
- 最高优先级：${focusRule}
- 这 ${safeCount} 条是同一个选题方向的一组变体，不是 50 个新选题；只允许换标题说法、种草切入点、花字表达和画面小处理。
- 这 ${safeCount} 条都必须和原始标题、原始正文表达同一类内容，但标题、角度、花字文案不能重复。
- 可以换表达方式、换种草角度、换封面花字，但不要偏离原文事实，不要把用户给定主题改成其他相邻但不同的生活场景。
- 每条都要适合家庭/家居/智能家居真实场景图，不要写成品牌广告、电商详情页、数码发布会文案或硬广。
- 不要编造价格、品牌、优惠、材质认证、销量等未提供信息。
- huaziText 必须直接等于 noteTitle，逐字一致，不要另写短版，不要压缩，不要改写，不要分离出新的花字主题。
- noteTitle 本身要适合直接放到封面上：短、有画面感、语义完整，尽量控制在 10-18 个中文字符；如果需要分行，可以在 huaziText 里用换行，但换行前后的文字合起来必须与 noteTitle 完全一致。
- 每条都必须给出 imageBrief，说明这一张图应该如何处理画面：花字放哪里、是否需要轻微修图、是否需要加入选题氛围元素、哪些主体不能动。
- 如果已选爆款封面模版，imageBrief 必须体现该模版的构图、文字层级、视觉元素和配色逻辑，但不能照搬参考图的具体内容。
- imageBrief 必须严格依据“原图视觉分析”：只有 safeEditableAreas 或 mainObjects 里真实存在/合理可编辑的区域才能写入改造方案；如果素材和选题方向不完全一致，要先尊重原图结构，再给自然改造方案。
- 不要凭空大改空间布局、核心家具、家电或智能设备；不要把一个主题替换成另一个主题。
- 语气像小红书素人笔记，直接、有种草感，不要太夸张。
- 输出 JSON 数组，不要输出 Markdown，不要解释。

每一项格式：
{
  "id": 1,
  "angle": "本条差异角度",
  "noteTitle": "帖子标题",
  "noteBody": "帖子正文，40-80字",
  "huaziText": "封面花字，可包含换行",
  "imageBrief": "本张封面的画面生成/修图思路，40-90字"
}`;
}

function buildPosterBatchPlanningPrompt({ topic, noteBody, count, topicDirection }) {
  const safeCount = clampBatchCount(count);
  return `你是小红书“大字报卡片封面”文案改写助手。请基于用户提供的参考文案，生成 ${safeCount} 条适合卡片封面的改写版本。

参考标题：
${topic || '未提供'}

参考正文：
${noteBody || '未提供'}

补充方向/文案参考：
${topicDirection || '未提供'}

工作方式：
1. 先判断参考文案在表达什么，不要从固定类型列表中选择。请自行概括 contentType，例如“决赛圈求建议”“生活场景种草”“反常识经验总结”“真实吐槽”等。
2. 判断说话身份 speakerRole、语气 tone、传播目的 intent。
3. 所有改写必须保持同一个内容类型、说话身份、语气和传播目的。参考文案是在求助，就不要改成经验分享；是在种草，就不要改成避坑提醒；是在吐槽，就不要改成教程。

卡片文案要求：
- 只输出适合封面卡片的大字文案，不要输出花字、画面描述、修图思路。
- 每条 2-4 行；可以用 \\n 分行。
- 每条尽量 8-24 个中文，短、清楚、信息流里一眼能读懂。
- 不要凭空加入参考文案没有的信息、价格、品牌、功能或结论。
- 如果参考中有关键品牌/对象/场景，例如“美的”“华为”“全屋智能”“新装修”，必须保留。
- accentWords 只给 1-2 个关键词，优先保留品牌词、场景词或利益点。
- templateHint 可以为空；如果想给风格倾向，只写 paper / green / orange / blue / purple / handwrite / quote 这类风格词，不要指定具体底图。系统会自动轮换模板库里的不同底图。
- 输出 JSON 对象，不要 Markdown，不要解释。

输出格式：
{
  "contentType": "自行概括的内容类型",
  "speakerRole": "说话身份",
  "tone": "语气",
  "intent": "传播目的",
  "items": [
    {
      "id": 1,
      "cardText": "卡片文案，可包含换行",
      "accentWords": ["关键词1", "关键词2"],
      "templateHint": "paper"
    }
  ]
}`;
}

function buildRewriteItemPrompt({ topic, noteBody, topicDirection, visualMode, imageAnalysis, item, itemIndex, existingTitles, styleTemplate }) {
  if (isPosterMode(visualMode)) {
    return buildPosterRewriteItemPrompt({ topic, noteBody, topicDirection, item, itemIndex, existingTitles });
  }
  const topicKeywords = extractTopicKeywords({ topic, noteBody, topicDirection });
  return `你是一个小红书家庭生活方式/智能家居内容策划助手。请只重写内容队列中的第 ${itemIndex || ''} 条任务。

原始标题：
${topic || '未提供'}

原始正文：
${noteBody || '未提供'}

本批选题方向/画面目标：
${topicDirection || '未提供'}

画面模式：
${visualMode === 'atmosphere' ? '允许轻量氛围改造' : '仅实拍轻修'}

原图视觉分析：
${imageAnalysis ? JSON.stringify(imageAnalysis, null, 2) : '未提供'}

${styleTemplate ? `${formatStyleTemplateForPrompt(styleTemplate)}\n` : ''}

当前有问题的任务：
${JSON.stringify(item || {}, null, 2)}

已有标题，避免重复：
${(existingTitles || []).slice(0, 80).map((title) => `- ${title}`).join('\n') || '无'}

要求：
- 只输出 1 条新任务，不要输出数组，不要解释。
- 新任务必须严格围绕本批主题，不要扩写成另一个生活场景。
- 系统抽取到的主题关键词为：${topicKeywords.join('、') || '未抽取到，请自行总结'}。
- noteTitle 要比当前标题更自然、完整、可读，不要出现半截词、病句、错别字。
- 当前版本使用“标题即花字”：huaziText 必须直接等于 noteTitle，逐字一致。
- noteBody 保持 40-80 字，像小红书素人笔记。
- imageBrief 说明画面如何处理，必须尊重原图分析，不要大改空间布局和核心家具家电。
- 如果已选爆款封面模版，新的标题和 imageBrief 要更贴近该模版的第一眼钩子、构图和文字层级。

输出 JSON 对象，格式：
{
  "id": ${Number(item?.id) || Number(itemIndex) || 1},
  "angle": "本条差异角度",
  "noteTitle": "新标题",
  "noteBody": "新正文",
  "huaziText": "必须与 noteTitle 完全一致",
  "imageBrief": "画面生成/修图思路"
}`;
}

function buildPosterRewriteItemPrompt({ topic, noteBody, topicDirection, item, itemIndex, existingTitles }) {
  return `你是小红书“大字报卡片封面”文案改写助手。请只重写内容队列中的第 ${itemIndex || ''} 条卡片任务。

参考标题：
${topic || '未提供'}

参考正文：
${noteBody || '未提供'}

补充方向/文案参考：
${topicDirection || '未提供'}

当前有问题的任务：
${JSON.stringify(item || {}, null, 2)}

已有卡片文案，避免重复：
${(existingTitles || []).slice(0, 80).map((title) => `- ${title}`).join('\n') || '无'}

要求：
- 先判断参考文案的内容类型、说话身份、语气和传播目的，再在同类型内改写。
- 不要把求助改成经验，不要把种草改成避坑，不要把吐槽改成教程。
- 只输出 1 条新任务，不要输出数组，不要解释。
- cardText 适合封面卡片，2-4 行，可用 \\n 分行。
- accentWords 只给 1-2 个关键词。
- templateHint 可以为空；如果想给风格倾向，只写 paper / green / orange / blue / purple / handwrite / quote 这类风格词，不要指定具体底图。系统会自动轮换模板库里的不同底图。

输出 JSON 对象：
{
  "id": ${Number(item?.id) || Number(itemIndex) || 1},
  "angle": "本条差异角度",
  "noteTitle": "同 cardText",
  "cardText": "新的卡片文案",
  "accentWords": ["关键词1", "关键词2"],
  "templateHint": "paper"
}`;
}

function makeLocalBatchItems({ topic, noteBody, count, topicDirection, visualMode }) {
  if (isPosterMode(visualMode)) {
    return makeLocalPosterBatchItems({ topic, noteBody, count, topicDirection, visualMode });
  }
  const safeCount = clampBatchCount(count);
  const baseTopic = normalizeTopic({ topic });
  const topicCore = baseTopic.replace(/[，,。.!！?？\s]+$/g, '');
  const subtitles = [
    '氛围感拉满',
    '宅家也舒服',
    '智能感在线',
    '生活更顺手',
    '一秒有感觉',
    '质感不将就',
    '家里更好住',
    '体验感拉满',
    '松弛又高级',
    '日常很实用'
  ];
  const angles = [
    '生活氛围',
    '智能体验',
    '家庭场景',
    '质感细节',
    '客厅参考',
    '宅家松弛感',
    '真实生活感',
    '不费力改造',
    '实用和颜值',
    '轻科技感'
  ];
  const titlePatterns = [
    '${topic}，家里一秒有氛围',
    '${topic}这样做，真的很顺手',
    '被这套${topic}拿捏了',
    '${topic}的氛围感，原来在这里',
    '想让家更有感觉，可以看这个',
    '这套${topic}，日常越用越舒服',
    '家里这样做，体验感很在线',
    '${topic}不用复杂，做对就好用',
    '这组${topic}，简单但不普通',
    '${topic}参考，照着做很稳'
  ];
  const bodySeeds = [
    '保留真实家庭照片质感，重点看生活场景、光线氛围和使用体验。',
    '适合想让家里更顺手、更有氛围的人，视觉上干净，也比较日常。',
    '不用做得很复杂，只要把场景、灯光和小细节处理好，体验感会明显很多。',
    '这类家庭场景不靠硬广出效果，更适合做真实的小红书种草内容。',
    '如果想让智能家居看起来更自然、更像真实生活，这个方向可以重点参考。'
  ];

  return Array.from({ length: safeCount }, (_, index) => {
    const angle = angles[index % angles.length];
    const subtitle = subtitles[index % subtitles.length];
    const titlePattern = titlePatterns[index % titlePatterns.length];
    const noteTitle = titlePattern.replace('${topic}', topicCore);
    return {
      id: index + 1,
      angle,
      noteTitle,
      noteBody: `${bodySeeds[index % bodySeeds.length]}${noteBody ? ` ${noteBody}` : ''}`.slice(0, 120),
      huaziText: noteTitle,
      imageBrief: visualMode === 'atmosphere'
        ? `基于原图主体空间做轻量氛围改造，围绕“${topicDirection || topicCore}”加入自然生活化道具、智能状态或光线暗示，保留主要空间布局，花字放在留白处。`
        : '保留原图真实家庭空间和主体设备，只做基础明暗修正，花字放在墙面、窗边或自然留白处，不遮挡核心信息。'
    };
  });
}

function makeLocalPosterBatchItems({ topic, count, topicDirection }) {
  const safeCount = clampBatchCount(count);
  const base = cleanCardText(topicDirection || topic || '小红书卡片封面');
  const compact = base.replace(/[，。！？；、]/g, ' ').replace(/\s+/g, '');
  const hasMideaHuawei = /美的/.test(compact) && /华为/.test(compact);
  const hasSmartHome = /全屋智能/.test(compact);
  if (hasMideaHuawei && hasSmartHome) {
    const variants = [
      '决赛圈了\n全屋智能\n美的还是华为',
      '全屋智能决赛圈\n美的还是华为\n求建议',
      '新装修做全屋智能\n美的华为二选一\n求真实建议',
      '决赛圈求助\n全屋智能选美的\n还是选华为',
      '新家全屋智能\n卡在最后一步\n美的还是华为',
      '决赛圈真的来了\n全屋智能\n美的还是华为'
    ];
    return Array.from({ length: safeCount }, (_, index) => {
      const text = variants[index % variants.length];
      const template = cardTemplateConfigs[index % cardTemplateConfigs.length];
      return {
        id: index + 1,
        angle: '决赛圈求建议',
        noteTitle: text,
        noteBody: '',
        cardText: text,
        accentWords: parseAccentWords([], text),
        cardTemplate: template.id,
        huaziText: '',
        imageBrief: ''
      };
    });
  }
  const cleaned = compact;
  const variants = [
    cleaned,
    `${cleaned}\n求真实建议`,
    `${cleaned}\n有人懂吗`,
    `${cleaned}\n怎么选`,
    `${cleaned}\n真的纠结`,
    `${cleaned}\n先别急`
  ];
  return Array.from({ length: safeCount }, (_, index) => {
    const text = variants[index % variants.length] || cleaned;
    const template = cardTemplateConfigs[index % cardTemplateConfigs.length];
    return {
      id: index + 1,
      angle: '大字报卡片',
      noteTitle: text,
      noteBody: '',
      cardText: text,
      accentWords: parseAccentWords([], text),
      cardTemplate: template.id,
      huaziText: '',
      imageBrief: ''
    };
  });
}

function extractJsonArray(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : parsed.items;
  } catch {
    const match = trimmed.match(/\[[\s\S]*\]/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function extractJsonObject(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function normalizeBatchItems(items, count, context = {}) {
  if (!Array.isArray(items)) return [];
  const normalized = items.slice(0, count).map((item, index) => {
    if (isPosterMode(context.visualMode)) {
      const cardText = repairPosterCardText(item.cardText || item.noteTitle || item.title || '', context, index);
      const templateHint = String(item.templateHint || item.cardTemplate || item.templateId || '').trim();
      return {
        id: Number(item.id) || index + 1,
        angle: String(item.angle || item.contentType || '大字报卡片').trim(),
        noteTitle: cardText,
        noteBody: String(item.noteBody || item.body || '').trim(),
        cardText,
        accentWords: parseAccentWords(item.accentWords, cardText),
        cardTemplate: templateHint,
        huaziText: '',
        imageBrief: ''
      };
    }
    return {
      id: Number(item.id) || index + 1,
      angle: String(item.angle || '封面方案').trim(),
      noteTitle: String(item.noteTitle || item.title || '').trim(),
      noteBody: String(item.noteBody || item.body || '').trim(),
      huaziText: String(item.huaziText || item.coverText || '').trim(),
      imageBrief: String(item.imageBrief || item.visualBrief || item.imagePrompt || '').trim()
    };
  }).filter((item) => item.noteTitle);
  return enforceTopicFocus(normalized, context);
}

function buildImageAnalysisPrompt({ noteTitle, noteBody, topicDirection, visualMode }) {
  return `你是一个小红书封面图片策划和图像编辑顾问。请认真分析用户上传的原图，并结合选题方向，输出结构化 JSON。

原始标题：
${noteTitle || '未提供'}

原始正文：
${noteBody || '未提供'}

选题方向/画面目标：
${topicDirection || '未提供'}

画面模式：
${visualMode === 'atmosphere' ? '氛围改造：允许基于原图做自然、轻量、真实的生活化补充。' : '实拍轻修：尽量不改变原图内容，只做轻修和花字。'}

你必须基于图片真实内容判断，不要假设图片里一定有电视、沙发、餐桌、墙面等；只有看到了才写 hasTv:true 等。

输出 JSON，不要 Markdown，不要解释，格式如下：
{
  "sceneType": "空间类型，例如客厅/卧室/厨房/阳台/书房/玄关/家庭影音区/不确定",
  "mainObjects": ["图片中真实存在的主要物体"],
  "hasTv": true,
  "hasSofa": false,
  "hasTable": true,
  "safeEditableAreas": ["可自然编辑的位置，例如电视屏幕/桌面/墙面留白/窗外"],
  "protectedAreas": ["不应改动的主体，例如核心家具/家电结构、智能设备位置、真实生活陈设、空间透视"],
  "textPlacement": "最适合放花字的位置",
  "atmosphereOpportunities": ["如果要做氛围改造，最自然的轻量改造点"],
  "risks": ["容易出错或不建议改的点"],
  "recommendedImageStrategy": "一句话说明后续 imageBrief 应该遵循的策略"
}`;
}

async function analyzeImageWithTextModel({ file, noteTitle, noteBody, topicDirection, visualMode }) {
  const client = getTextClient();
  if (!client) {
    throw new Error('还没有配置 OPENAI_TEXT_API_KEY，不能分析原图。');
  }
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini';
  const mimeType = file.mimetype || 'image/jpeg';
  const b64 = fs.readFileSync(file.path).toString('base64');
  const prompt = buildImageAnalysisPrompt({ noteTitle, noteBody, topicDirection, visualMode });
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 1600,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: '你只输出合法 JSON 对象，不输出 Markdown，不输出解释，不要把 JSON 放进代码块。'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } }
        ]
      }
    ]
  });
  const content = response.choices?.[0]?.message?.content || '';
  const analysis = extractJsonObject(content) || {
    sceneType: '不确定',
    mainObjects: [],
    safeEditableAreas: [],
    protectedAreas: [],
    textPlacement: '',
    atmosphereOpportunities: [],
    risks: ['模型未返回合法 JSON'],
    recommendedImageStrategy: content.slice(0, 300)
  };
  const usage = response.usage ? {
    promptTokens: response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0,
    completionTokens: response.usage.completion_tokens ?? response.usage.completionTokens ?? 0,
    totalTokens: response.usage.total_tokens ?? response.usage.totalTokens ?? 0
  } : null;
  const usageLog = appendUsageLog({
    type: 'image-analysis',
    provider: textBaseUrl ? 'openai-compatible-proxy' : 'openai',
    model,
    usage
  });
  return { analysis, rawText: content, prompt, model, usage, usageLog };
}

function buildImageCopyExtractionPrompt({ noteTitle, noteBody, topicDirection, visualMode, count }) {
  const modeInstruction = isComparisonMode(visualMode)
    ? '用户很可能要做参数对比表。请优先提取图片中的产品名、价格、处理器、内存/硬盘、屏幕、重量/厚度、电池/续航、显卡、接口、散热等图片真实出现的分类。不要为了套模板硬补“适合人群”；只有图片里明确写了人群/用途时才提取。参数必须按图片真实文字整理，不能编造；看不清就写“未识别”。'
    : isReviewMode(visualMode)
    ? '用户要做产品点评横评。请按产品分别提取真实可见的产品名、优势、短板、价格和适合人群等信息，整理成后续可以写成完整点评段落的素材；不要强制改成处理器/显卡/屏幕等参数列表，不要编造看不清的信息。'
    : '请提取图片里的可见主体、品牌/产品、文字信息、卖点、场景氛围和适合的小红书表达角度。';
  return `你是小红书封面图片信息提取助手。用户上传了 ${count || 1} 张图片，需要你读取图片中的信息，并整理成后续可以直接放进“原始正文”的文案。

已有原始标题：
${noteTitle || '未提供'}

已有原始正文：
${noteBody || '未提供'}

选题方向/画面目标：
${topicDirection || '未提供'}

任务要求：
${modeInstruction}

输出要求：
- 只能依据图片可见信息和用户已给文字，不要臆测不可见参数。
- 如果图片是参数对比/表格/清单，请把每个产品单独成段，字段尽量完整，保留数字、单位、型号英文大小写。
- 如果图片是普通产品或场景图，请总结成 80-160 字小红书原始正文，包含主体、场景、卖点和封面生成重点。
- 文案要适合继续交给封面生成器使用，不要写“这张图片里”这种旁白。
- 总输出尽量控制在 1200 个中文字符以内，优先保证可读和可用。

输出合法 JSON 对象，不要 Markdown，不要解释，格式如下：
{
  "titleSuggestion": "可选的新标题，15-30字",
  "noteBody": "整理后的原始正文。参数对比图可用多段字段化文本；普通图用自然文案。",
  "topicDirection": "可选的画面目标补充",
  "extractedFacts": ["从图片确认的信息点"],
  "uncertainFacts": ["看不清或不确定的信息点"],
  "imageAnalysis": {
    "mainObjects": ["主要主体"],
    "visibleText": ["图片中识别到的重要文字"],
    "recommendedUse": "后续生成建议"
  }
}`;
}

async function extractImageCopyWithTextModel({ files = [], noteTitle, noteBody, topicDirection, visualMode }) {
  const client = getTextClient();
  if (!client) {
    throw new Error('还没有配置 OPENAI_TEXT_API_KEY，不能提取图片信息。');
  }
  const safeFiles = files.slice(0, 8);
  if (!safeFiles.length) {
    throw new Error('请先上传要读取的图片。');
  }
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini';
  const prompt = buildImageCopyExtractionPrompt({
    noteTitle,
    noteBody,
    topicDirection,
    visualMode,
    count: safeFiles.length
  });
  const contentParts = [{ type: 'text', text: prompt }];
  safeFiles.forEach((file, index) => {
    const mimeType = file.mimetype || 'image/jpeg';
    const b64 = fs.readFileSync(file.path).toString('base64');
    contentParts.push({ type: 'text', text: `图片 ${index + 1}：${file.originalname || ''}` });
    contentParts.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${b64}` } });
  });
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: 5000,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: '你只输出合法 JSON 对象，不输出 Markdown，不输出解释，不要把 JSON 放进代码块。'
      },
      {
        role: 'user',
        content: contentParts
      }
    ]
  });
  const content = response.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(content) || {};
  const noteBodyText = String(parsed.noteBody || parsed.body || content || '').trim();
  const usage = response.usage ? {
    promptTokens: response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0,
    completionTokens: response.usage.completion_tokens ?? response.usage.completionTokens ?? 0,
    totalTokens: response.usage.total_tokens ?? response.usage.totalTokens ?? 0
  } : null;
  const usageLog = appendUsageLog({
    type: 'image-copy-extract',
    provider: textBaseUrl ? 'openai-compatible-proxy' : 'openai',
    model,
    count: safeFiles.length,
    usage
  });
  return {
    titleSuggestion: String(parsed.titleSuggestion || parsed.title || '').trim(),
    noteBody: noteBodyText,
    topicDirection: String(parsed.topicDirection || '').trim(),
    extractedFacts: Array.isArray(parsed.extractedFacts) ? parsed.extractedFacts : [],
    uncertainFacts: Array.isArray(parsed.uncertainFacts) ? parsed.uncertainFacts : [],
    imageAnalysis: parsed.imageAnalysis || null,
    rawText: content,
    prompt,
    model,
    usage,
    usageLog
  };
}

function buildStyleTemplateAnalysisPrompt({ templateName, notes, count }) {
  return `你是小红书爆款封面模版分析师。用户会上传 ${count || 1} 张参考封面，请把它们总结成一个可复用的“封面模版”，用于后续生成同类型封面。

模版命名参考：
${templateName || '请根据图片自动命名，短、好选、中文 4-8 字'}

用户备注：
${notes || '未提供'}

请重点分析：
- 构图：主体/文字/留白/视觉动线/密度/裁切/层次
- 风格：情绪、平台感、真实或拼贴、质感、画面节奏
- 视觉元素：字体、描边、色块、箭头、贴纸、纸张、图标、边框、纹理、人物或产品摆法
- 可迁移规则：换成新的标题、产品图、生活场景后，哪些规则必须保留

不要复制参考图里的具体人物、商标、水印、独有插画或不可复用素材。输出合法 JSON 对象，不要 Markdown，不要解释。

输出格式：
{
  "styleName": "短中文模版名",
  "bestFor": "适合的品类/选题/用户",
  "firstGlanceHook": "0.5 秒停留机制",
  "emotionalEngine": "情绪引擎",
  "compositionRules": ["构图规则 1", "构图规则 2"],
  "typographyRules": ["字体和字号层级规则"],
  "colorRules": ["背景/主色/强调色/对比规则"],
  "graphicDevices": ["常见视觉装置"],
  "productMappingRules": ["新产品或新原图如何放进来"],
  "copywritingFormula": ["标题公式，可含占位符"],
  "doList": ["必须做"],
  "avoidList": ["必须避免"],
  "imagePromptBlock": "一段可复用图片生成提示词，必须可接受新的标题、正文、原图和画幅"
}`;
}

async function analyzeStyleTemplateWithTextModel({ files, templateName, notes }) {
  const client = getTextClient();
  if (!client) {
    throw new Error('还没有配置 OPENAI_TEXT_API_KEY，不能分析爆款参考图。');
  }
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini';
  const prompt = buildStyleTemplateAnalysisPrompt({ templateName, notes, count: files.length });
  const content = [
    { type: 'text', text: prompt },
    ...files.map((file) => ({
      type: 'image_url',
      image_url: {
        url: `data:${file.mimetype || 'image/jpeg'};base64,${fs.readFileSync(file.path).toString('base64')}`
      }
    }))
  ];
  const response = await client.chat.completions.create({
    model,
    temperature: 0.35,
    max_tokens: 2400,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: '你只输出合法 JSON 对象，不输出 Markdown，不输出解释，不要把 JSON 放进代码块。'
      },
      {
        role: 'user',
        content
      }
    ]
  });
  const rawText = response.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(rawText);
  if (!parsed) throw new Error('模型没有返回合法的模版 JSON。');
  const usage = response.usage ? {
    promptTokens: response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0,
    completionTokens: response.usage.completion_tokens ?? response.usage.completionTokens ?? 0,
    totalTokens: response.usage.total_tokens ?? response.usage.totalTokens ?? 0
  } : null;
  const usageLog = appendUsageLog({
    type: 'style-template-analysis',
    provider: textBaseUrl ? 'openai-compatible-proxy' : 'openai',
    model,
    count: files.length,
    usage
  });
  return {
    template: normalizeStyleTemplate({
      ...parsed,
      id: slugifyTemplateId(templateName || parsed.styleName || parsed.name),
      sourceCount: files.length
    }),
    rawText,
    prompt,
    model,
    usage,
    usageLog
  };
}

async function generateBatchItemsWithTextModel({ topic, noteBody, count, prompt, topicDirection, visualMode, imageAnalysis, styleTemplate }) {
  const client = getTextClient();
  if (!client) return null;

  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini';
  const request = {
    model,
    temperature: 0.8,
    messages: [
      {
        role: 'system',
        content: isPosterMode(visualMode)
          ? '你只输出合法 JSON 对象，不输出 Markdown，不输出解释。'
          : '你只输出合法 JSON 数组，不输出 Markdown，不输出解释。'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  };
  if (isPosterMode(visualMode)) {
    request.response_format = { type: 'json_object' };
  }
  const response = await client.chat.completions.create(request);

  const content = response.choices?.[0]?.message?.content || '';
  const usage = response.usage ? {
    promptTokens: response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0,
    completionTokens: response.usage.completion_tokens ?? response.usage.completionTokens ?? 0,
    totalTokens: response.usage.total_tokens ?? response.usage.totalTokens ?? 0
  } : null;
  const parsed = extractJsonArray(content);
  const normalized = normalizeBatchItems(parsed, count, { topic, noteBody, topicDirection, visualMode, styleTemplate });
  for (const item of normalized) {
    if (!item.imageBrief) {
      item.imageBrief = visualMode === 'atmosphere'
        ? `参考原图分析做轻量氛围改造，围绕“${topicDirection || topic}”只编辑安全区域，保留核心家具/家电、智能设备和空间布局。`
        : '保留原图真实家庭空间和主体设备，只做基础明暗修正，花字放在自然留白处。';
    }
  }
  if (normalized.length < count) {
    const fallback = makeLocalBatchItems({ topic, noteBody, count, topicDirection, visualMode });
    const existingIds = new Set(normalized.map((item) => item.id));
    for (const item of fallback) {
      if (normalized.length >= count) break;
      if (!existingIds.has(item.id)) normalized.push(item);
    }
  }
  const logEntry = appendUsageLog({
    type: 'text-batch-plan',
    provider: textBaseUrl ? 'openai-compatible-proxy' : 'openai',
    model,
    count,
    usage
  });
  return { items: normalized.slice(0, count), model, usage, usageLog: logEntry };
}

async function rewriteItemWithTextModel({ topic, noteBody, topicDirection, visualMode, imageAnalysis, item, itemIndex, existingTitles, styleTemplate }) {
  const client = getTextClient();
  if (!client) {
    const fallbackTitle = item?.noteTitle || topic || '这条内容重新写一下';
    if (isPosterMode(visualMode)) {
      return {
        item: {
          ...item,
          noteTitle: fallbackTitle,
          cardText: fallbackTitle,
          accentWords: parseAccentWords(item?.accentWords, fallbackTitle),
          cardTemplate: item?.cardTemplate || pickCardTemplate(item).id,
          huaziText: '',
          imageBrief: ''
        },
        source: 'local-fallback',
        warning: '未配置文本模型 key，只能保留原卡片文案。'
      };
    }
    return {
      item: {
        ...item,
        noteTitle: fallbackTitle,
        huaziText: fallbackTitle
      },
      source: 'local-fallback',
      warning: '未配置文本模型 key，只能保留原标题。'
    };
  }
  const model = process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini';
  const prompt = buildRewriteItemPrompt({ topic, noteBody, topicDirection, visualMode, imageAnalysis, item, itemIndex, existingTitles, styleTemplate });
  const response = await client.chat.completions.create({
    model,
    temperature: 0.8,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: '你只输出合法 JSON 对象，不输出 Markdown，不输出解释。'
      },
      {
        role: 'user',
        content: prompt
      }
    ]
  });
  const content = response.choices?.[0]?.message?.content || '';
  const parsed = extractJsonObject(content) || {};
  if (isPosterMode(visualMode)) {
    const cardText = cleanCardText(parsed.cardText || parsed.noteTitle || parsed.title || item?.cardText || item?.noteTitle || topic || '');
    const rewritten = {
      id: Number(item?.id) || Number(itemIndex) || 1,
      angle: String(parsed.angle || item?.angle || '重写卡片文案').trim(),
      noteTitle: cardText,
      noteBody: '',
      cardText,
      accentWords: parseAccentWords(parsed.accentWords || item?.accentWords, cardText),
      cardTemplate: String(parsed.templateHint || parsed.cardTemplate || item?.cardTemplate || pickCardTemplate(item).id).trim(),
      huaziText: '',
      imageBrief: ''
    };
    const usage = response.usage ? {
      promptTokens: response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0,
      completionTokens: response.usage.completion_tokens ?? response.usage.completionTokens ?? 0,
      totalTokens: response.usage.total_tokens ?? response.usage.totalTokens ?? 0
    } : null;
    const usageLog = appendUsageLog({
      type: 'text-rewrite-item',
      provider: textBaseUrl ? 'openai-compatible-proxy' : 'openai',
      model,
      usage
    });
    return { item: rewritten, prompt, model, usage, usageLog, rawText: content };
  }
  const title = String(parsed.noteTitle || parsed.title || item?.noteTitle || topic || '').trim();
  const rewritten = {
    id: Number(item?.id) || Number(itemIndex) || 1,
    angle: String(parsed.angle || item?.angle || '重写文案').trim(),
    noteTitle: title,
    noteBody: String(parsed.noteBody || parsed.body || item?.noteBody || noteBody || '').trim(),
    huaziText: title,
    imageBrief: String(parsed.imageBrief || parsed.visualBrief || item?.imageBrief || '').trim()
  };
  const usage = response.usage ? {
    promptTokens: response.usage.prompt_tokens ?? response.usage.promptTokens ?? 0,
    completionTokens: response.usage.completion_tokens ?? response.usage.completionTokens ?? 0,
    totalTokens: response.usage.total_tokens ?? response.usage.totalTokens ?? 0
  } : null;
  const usageLog = appendUsageLog({
    type: 'text-rewrite-item',
    provider: textBaseUrl ? 'openai-compatible-proxy' : 'openai',
    model,
    usage
  });
  return { item: rewritten, prompt, model, usage, usageLog, rawText: content };
}

app.post('/api/prompt', (req, res) => {
  if (isProductLayoutMode(req.body?.visualMode)) {
    const reviewMode = isReviewMode(req.body?.visualMode);
    const prompt = buildComparisonPlanningPrompt({
      topic: req.body?.noteTitle || req.body?.topic,
      noteBody: req.body?.noteBody,
      topicDirection: req.body?.topicDirection
    });
    return res.json({
      prompt: `${prompt}\n\n说明：${reviewMode ? '产品点评会先把每款产品的信息整理成一段完整自然语言点评，再生成左图右文的版式参考图' : '参数对比表会先把原始正文整理为结构化字段，再生成一张参数表版式参考图'}，最后调用生图 API 做爆款封面美化。`
    });
  }
  if (isPosterMode(req.body?.visualMode)) {
    const template = pickCardTemplate(req.body || {});
    const cardText = cleanCardText(req.body?.cardText || req.body?.noteTitle || '');
    const accentWords = parseAccentWords(req.body?.accentWords, cardText);
    return res.json({
      prompt: `大字报卡片本地生成\n模板：${template.name}\n字体：${cardFonts[template.font]?.label || template.font}\n卡片文案：${cardText || '未提供'}\n强调词：${accentWords.join('、') || '无'}\n说明：本模式不调用图片模型，不需要原图，生成 PNG。`
    });
  }
  const styleTemplate = resolveStyleTemplate(req.body || {});
  const prompt = buildCoverPrompt({ ...(req.body || {}), styleTemplate });
  res.json({ prompt });
});

app.get('/api/usage', (req, res) => {
  res.json({ logs: readRecentUsage(30) });
});

app.get('/api/style-templates', (req, res) => {
  res.json({ templates: readStyleTemplates() });
});

app.post('/api/style-templates/analyze', upload.array('images', 8), async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: '请先上传 1-8 张爆款参考封面。' });
  }
  try {
    const result = await analyzeStyleTemplateWithTextModel({
      files,
      templateName: req.body.templateName,
      notes: req.body.notes
    });
    const templates = readStyleTemplates();
    let nextTemplate = result.template;
    const existing = templates.find((template) => template.id === nextTemplate.id);
    if (existing) {
      nextTemplate = {
        ...nextTemplate,
        id: `${nextTemplate.id}-${Date.now().toString(36).slice(-4)}`
      };
    }
    templates.unshift(nextTemplate);
    writeStyleTemplates(templates);
    res.json({ ...result, template: nextTemplate, templates });
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.error?.message || error?.message || '分析爆款模版失败' });
  } finally {
    for (const file of files) fs.rm(file.path, { force: true }, () => {});
  }
});

app.get('/api/comparison-styles', (req, res) => {
  res.json({ styles: readComparisonStyles() });
});

app.post('/api/comparison-styles/analyze', upload.array('images', 12), async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: '请先上传 1-12 张参数对比参考图。' });
  }
  try {
    const category = req.body.category === 'review' ? 'review' : 'comparison';
    const existing = readComparisonStyles().filter((style) => style.id !== defaultComparisonStyle.id);
    const created = [];
    const analysisUsageLogs = [];
    for (let index = 0; index < files.length; index += 1) {
      const suffix = files.length > 1 ? ` ${index + 1}` : '';
      const baseStyle = await makeComparisonStyleFromImage(files[index], index, `${req.body.templateName || (category === 'review' ? '产品点评' : '参数对比表')}${suffix}`, category);
      let style = baseStyle;
      try {
        const analyzed = await analyzeComparisonStyleWithTextModel({
          file: files[index],
          templateName: req.body.templateName,
          notes: req.body.notes,
          index,
          category
        });
        if (analyzed?.analysis) {
          style = { ...mergeComparisonStyleAnalysis(baseStyle, analyzed.analysis, index), category };
          if (analyzed.usageLog) analysisUsageLogs.push(analyzed.usageLog);
        }
      } catch (error) {
        console.warn('[comparison-style-analysis] fallback to local extract:', error?.message || error);
      }
      created.push(style);
    }
    const nextStyles = [...created, ...existing].slice(0, 40);
    writeComparisonStyles(nextStyles);
    const usageLog = analysisUsageLogs.at(-1) || appendUsageLog({
      type: 'comparison-style-analysis',
      provider: 'local',
      model: 'image-palette-extract',
      count: created.length,
      usage: { moneyCost: 0, coinCost: 0, currency: 'CNY' }
    });
    res.json({ styles: nextStyles, created, usageLog, usageLogs: analysisUsageLogs });
  } catch (error) {
    res.status(500).json({ error: error?.message || '参数对比表风格保存失败' });
  } finally {
    for (const file of files) fs.rm(file.path, { force: true }, () => {});
  }
});

app.post('/api/analyze-image', upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '请先上传一张封面原图。' });
  }
  try {
    const result = await analyzeImageWithTextModel({
      file: req.file,
      noteTitle: req.body.noteTitle,
      noteBody: req.body.noteBody,
      topicDirection: req.body.topicDirection,
      visualMode: req.body.visualMode
    });
    res.json(result);
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.error?.message || error?.message || '分析原图失败' });
  } finally {
    if (req.file?.path) {
      fs.rm(req.file.path, { force: true }, () => {});
    }
  }
});

app.post('/api/extract-image-copy', upload.array('images', 8), async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: '请先上传要读取的图片。' });
  }
  try {
    const result = await extractImageCopyWithTextModel({
      files,
      noteTitle: req.body.noteTitle,
      noteBody: req.body.noteBody,
      topicDirection: req.body.topicDirection,
      visualMode: req.body.visualMode
    });
    res.json(result);
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.error?.message || error?.message || '图片信息提取失败' });
  } finally {
    for (const file of files) fs.rm(file.path, { force: true }, () => {});
  }
});

app.post('/api/optimize-prompt', (req, res) => {
  const body = req.body || {};
  const basePrompt = buildCoverPrompt(body);
  const optimizedRules = makeOptimizedRules(body.promptFeedback);
  const optimizedPrompt = buildCoverPrompt({ ...body, optimizedRules, promptFeedback: '' });
  const optimizerPrompt = buildPromptOptimizerPrompt({
    basePrompt,
    feedback: body.promptFeedback
  });
  res.json({ optimizedRules, optimizedPrompt, optimizerPrompt });
});

app.post('/api/batch-plan', async (req, res) => {
  const body = req.body || {};
  const count = clampBatchCount(body.count);
  const topic = normalizeTopic(body);
  const styleTemplate = resolveStyleTemplate(body);
  if (isProductLayoutMode(body.visualMode)) {
    const reviewMode = isReviewMode(body.visualMode);
    const comparisonStyleIds = parseComparisonStyleIds(body.comparisonStyleIds || body.comparisonStyleId);
    const prompt = buildComparisonPlanningPrompt({ topic, noteBody: body.noteBody, topicDirection: body.topicDirection });
    try {
      const result = await generateComparisonDataWithTextModel({
        topic,
        noteBody: body.noteBody,
        topicDirection: body.topicDirection
      });
      const items = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        angle: reviewMode ? '产品点评' : '参数对比表',
        noteTitle: result.comparisonData.title || topic,
        noteBody: body.noteBody || '',
        huaziText: result.comparisonData.title || topic,
        imageBrief: `${reviewMode ? '产品点评' : '参数对比表'}第 ${index + 1} 版：先生成版式参考图，再调用生图 API 美化成爆款封面；${comparisonStyleIds.length ? '使用当前选中的模板' : '每次会随机抽取当前类型模板'}，共 ${result.comparisonData.products.length} 个产品。`,
        comparisonStyleId: pickSelectedComparisonStyleId(comparisonStyleIds, index),
        comparisonData: result.comparisonData
      }));
      return res.json({
        count,
        prompt,
        items,
        source: result.source || 'text-model',
        model: result.model,
        usage: result.usage,
        usageLog: result.usageLog,
        warning: result.warning
      });
    } catch (error) {
      const comparisonData = parseComparisonFallback({ title: topic, body: body.noteBody });
      const items = Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        angle: reviewMode ? '产品点评' : '参数对比表',
        noteTitle: comparisonData.title || topic,
        noteBody: body.noteBody || '',
        huaziText: comparisonData.title || topic,
        imageBrief: `${reviewMode ? '产品点评' : '参数对比表'}第 ${index + 1} 版：先生成版式参考图，再调用生图 API 美化成爆款封面；${comparisonStyleIds.length ? '使用当前选中的模板' : '每次会随机抽取当前类型模板'}，共 ${comparisonData.products.length} 个产品。`,
        comparisonStyleId: pickSelectedComparisonStyleId(comparisonStyleIds, index),
        comparisonData
      }));
      return res.json({
        count,
        prompt,
        items,
        source: 'local-fallback',
        warning: error?.error?.message || error?.message || '文本模型整理失败，已使用本地规则整理。'
      });
    }
  }
  let imageAnalysis = null;
  if (body.imageAnalysis) {
    try {
      imageAnalysis = typeof body.imageAnalysis === 'string' ? JSON.parse(body.imageAnalysis) : body.imageAnalysis;
    } catch {
      imageAnalysis = null;
    }
  }
  const prompt = buildBatchPlanningPrompt({ ...body, topic, count, imageAnalysis, styleTemplate });
  try {
    const generated = await generateBatchItemsWithTextModel({ ...body, topic, count, prompt, imageAnalysis, styleTemplate });
    if (generated?.items?.length) {
      return res.json({
        count,
        prompt,
        items: generated.items,
        source: 'text-model',
        model: generated.model,
        usage: generated.usage,
        usageLog: generated.usageLog
      });
    }
  } catch (error) {
    const items = makeLocalBatchItems({ ...body, topic, count });
    return res.json({
      count,
      prompt,
      items,
      source: 'local-fallback',
      warning: error?.error?.message || error?.message || '文本模型生成失败，已使用本地兜底模板。'
    });
  }

  const items = makeLocalBatchItems({ ...body, topic, count });
  res.json({ count, prompt, items, source: 'local-fallback', warning: '未配置 OPENAI_TEXT_API_KEY，已使用本地兜底模板。' });
});

app.post('/api/rewrite-item', async (req, res) => {
  const body = req.body || {};
  const topic = normalizeTopic(body);
  const styleTemplate = resolveStyleTemplate(body);
  let imageAnalysis = null;
  if (body.imageAnalysis) {
    try {
      imageAnalysis = typeof body.imageAnalysis === 'string' ? JSON.parse(body.imageAnalysis) : body.imageAnalysis;
    } catch {
      imageAnalysis = null;
    }
  }
  try {
    const result = await rewriteItemWithTextModel({
      ...body,
      topic,
      imageAnalysis,
      styleTemplate
    });
    res.json(result);
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.error?.message || error?.message || '重写文案失败' });
  }
});

app.post('/api/generate-comparison', upload.array('images', 8), async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: '请先按产品顺序上传产品图。' });
  }
  let comparisonData = null;
  try {
    comparisonData = req.body.comparisonData ? JSON.parse(req.body.comparisonData) : null;
  } catch {
    comparisonData = null;
  }
  try {
    const visualMode = isReviewMode(req.body.visualMode) ? 'review' : 'comparison';
    const selectedStyle = pickComparisonStyle(req.body.comparisonStyleId, visualMode);
    const needsNarrativeReviews = isNarrativeReviewStyle(selectedStyle)
      && (!isComparisonDataUseful(comparisonData) || comparisonData.products.some((product) => !cleanComparisonText(product?.review)));
    if (!isComparisonDataUseful(comparisonData) || needsNarrativeReviews) {
      const result = await generateComparisonDataWithTextModel({
        topic: req.body.noteTitle,
        noteBody: req.body.noteBody,
        topicDirection: req.body.topicDirection
      });
      comparisonData = result.comparisonData;
    }
    const result = await generateComparisonWithImageApi({
      comparisonData,
      files,
      noteTitle: req.body.noteTitle,
      noteBody: req.body.noteBody,
      topicDirection: req.body.topicDirection,
      comparisonStyleId: req.body.comparisonStyleId,
      visualMode,
      aspectRatio: req.body.aspectRatio,
      resolution: req.body.resolution || '1k',
      quality: req.body.quality || 'medium'
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error?.error?.message || error?.message || '参数对比表生成失败' });
  } finally {
    for (const file of files) fs.rm(file.path, { force: true }, () => {});
  }
});

app.post('/api/generate', upload.single('image'), async (req, res) => {
  if (isPosterMode(req.body.visualMode)) {
    try {
      const result = await generatePosterCardImage({
        item: {
          id: req.body.id,
          noteTitle: req.body.noteTitle,
          cardText: req.body.cardText || req.body.noteTitle,
          accentWords: req.body.accentWords,
          cardTemplate: req.body.cardTemplate || req.body.templateId
        },
        aspectRatio: req.body.aspectRatio
      });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({ error: error?.message || '大字报卡片生成失败' });
    } finally {
      if (req.file?.path) {
        fs.rm(req.file.path, { force: true }, () => {});
      }
    }
  }

  if (!runningHubImageApiKey && !imageApiKey) {
    if (req.file?.path) {
      fs.rm(req.file.path, { force: true }, () => {});
    }
    return res.status(400).json({
      error: '还没有配置 RUNNINGHUB_IMAGE_API_KEY 或 OPENAI_IMAGE_API_KEY。'
    });
  }

  if (!req.file) {
    return res.status(400).json({ error: '请先上传一张封面原图。' });
  }

  const fields = {
    noteTitle: req.body.noteTitle,
    noteBody: req.body.noteBody,
    huaziText: req.body.huaziText,
    aspectRatio: req.body.aspectRatio,
    style: req.body.style,
    promptFeedback: req.body.promptFeedback,
    optimizedRules: req.body.optimizedRules,
    topicDirection: req.body.topicDirection,
    imageBrief: req.body.imageBrief,
    visualMode: req.body.visualMode,
    revisionMode: req.body.revisionMode === 'true' || req.body.revisionMode === true,
    revisionFeedback: req.body.revisionFeedback,
    styleTemplate: resolveStyleTemplate(req.body)
  };
  const prompt = buildCoverPrompt(fields);
  const model = runningHubImageApiKey ? `RunningHub ${runningHubModelName}` : (process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2');

  try {
    if (runningHubImageApiKey) {
      const result = await generateImageWithRunningHub({
        file: req.file,
        prompt,
        aspectRatio: req.body.aspectRatio,
        resolution: req.body.resolution || '1k',
        prefix: 'cover'
      });
      return res.json({
        imageUrl: result.imageUrl,
        prompt,
        model,
        taskId: result.taskId,
        usage: result.usage,
        usageLog: result.usageLog
      });
    }

    const client = getImageClient();
    const image = await toFile(fs.createReadStream(req.file.path), req.file.originalname, {
      type: req.file.mimetype || 'image/jpeg'
    });
    const response = await client.images.edit({
      model,
      image,
      prompt,
      quality: req.body.quality || 'medium',
      size: req.body.size || '1024x1536'
    });
    const b64 = response.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error: '模型没有返回图片，请重试或调整提示词。' });
    const fileName = `cover-${Date.now()}.png`;
    fs.writeFileSync(path.join(outputDir, fileName), Buffer.from(b64, 'base64'));
    res.json({ imageUrl: `/outputs/${fileName}`, prompt, model, usage: response.usage || null });
  } catch (error) {
    const message = error?.error?.message || error?.message || '生成失败';
    res.status(error?.status || 500).json({ error: message });
  } finally {
    if (req.file?.path) {
      fs.rm(req.file.path, { force: true }, () => {});
    }
  }
});

app.post('/api/generate-batch', upload.array('images', maxBatchCount), async (req, res) => {
  if (!runningHubImageApiKey && !imageApiKey) {
    for (const file of req.files || []) fs.rm(file.path, { force: true }, () => {});
    return res.status(400).json({
      error: '还没有配置 RUNNINGHUB_IMAGE_API_KEY 或 OPENAI_IMAGE_API_KEY。'
    });
  }

  const sourceFiles = req.files || [];
  if (!sourceFiles.length) {
    return res.status(400).json({ error: '请先上传至少一张封面原图。' });
  }

  let items = [];
  try {
    items = JSON.parse(req.body.items || '[]');
  } catch {
    return res.status(400).json({ error: '内容队列格式不正确。' });
  }

  if (!Array.isArray(items) || items.length === 0) {
    for (const file of sourceFiles) fs.rm(file.path, { force: true }, () => {});
    return res.status(400).json({ error: '请先生成内容队列。' });
  }

  items = items.slice(0, maxBatchCount).map((item, index) => {
    const sourceIndex = Number.isInteger(item.sourceIndex)
      ? item.sourceIndex
      : Number.parseInt(item.sourceIndex, 10);
    const normalizedSourceIndex = Number.isFinite(sourceIndex) && sourceFiles[sourceIndex]
      ? sourceIndex
      : index % sourceFiles.length;
    return {
      ...item,
      sourceIndex: normalizedSourceIndex,
      sourceName: item.sourceName || sourceFiles[normalizedSourceIndex]?.originalname || `原图 ${normalizedSourceIndex + 1}`
    };
  });
  const concurrency = clampConcurrency(req.body.concurrency);
  const client = runningHubImageApiKey ? null : getImageClient();
  const model = runningHubImageApiKey ? `RunningHub ${runningHubModelName}` : (process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2');
  const batchUsageBefore = runningHubImageApiKey ? await getRunningHubAccountUsageSnapshot().catch(() => null) : null;

  try {
    const results = await runWithConcurrency(items, concurrency, async (item, index) => {
      const sourceFile = sourceFiles[item.sourceIndex] || sourceFiles[index % sourceFiles.length] || sourceFiles[0];
      const fields = {
        noteTitle: item.noteTitle,
        noteBody: item.noteBody,
        huaziText: item.huaziText,
        aspectRatio: req.body.aspectRatio,
        style: req.body.style,
        promptFeedback: req.body.promptFeedback,
        optimizedRules: req.body.optimizedRules,
        topicDirection: req.body.topicDirection,
        imageBrief: item.imageBrief,
        visualMode: req.body.visualMode,
        styleTemplate: resolveStyleTemplate(req.body)
      };
      const prompt = buildCoverPrompt(fields);

      try {
        if (runningHubImageApiKey) {
          let result;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              result = await generateImageWithRunningHub({
                file: sourceFile,
                prompt,
                aspectRatio: req.body.aspectRatio,
                resolution: req.body.resolution || '1k',
                prefix: `cover-${String(item.id || index + 1).padStart(2, '0')}`,
                trackUsage: false
              });
              break;
            } catch (error) {
              if (attempt === 0 && (error.runningHubCode === 421 || /QUEUE|并发|concurrency|max/i.test(error.message || ''))) {
                await sleep(15000);
                continue;
              }
              throw error;
            }
          }
          return {
            id: item.id,
            status: 'done',
            imageUrl: result.imageUrl,
            taskId: result.taskId,
            noteTitle: item.noteTitle,
            huaziText: item.huaziText,
            imageBrief: item.imageBrief,
            sourceIndex: item.sourceIndex,
            sourceName: item.sourceName,
            prompt
          };
        } else {
          const image = await toFile(fs.createReadStream(sourceFile.path), sourceFile.originalname, {
            type: sourceFile.mimetype || 'image/jpeg'
          });
          const response = await client.images.edit({
            model,
            image,
            prompt,
            quality: req.body.quality || 'medium',
            size: req.body.size || '1024x1536'
          });
          const b64 = response.data?.[0]?.b64_json;
          if (!b64) {
            throw new Error('模型没有返回图片');
          }
          const fileName = `cover-${String(item.id || index + 1).padStart(2, '0')}-${Date.now()}.png`;
          fs.writeFileSync(path.join(outputDir, fileName), Buffer.from(b64, 'base64'));
          return {
            id: item.id,
            status: 'done',
            imageUrl: `/outputs/${fileName}`,
            noteTitle: item.noteTitle,
            huaziText: item.huaziText,
            imageBrief: item.imageBrief,
            sourceIndex: item.sourceIndex,
            sourceName: item.sourceName,
            prompt
          };
        }
      } catch (error) {
        return {
          id: item.id,
          status: 'failed',
          error: error?.error?.message || error?.message || '生成失败',
          noteTitle: item.noteTitle,
          huaziText: item.huaziText,
          imageBrief: item.imageBrief,
          sourceIndex: item.sourceIndex,
          sourceName: item.sourceName,
          prompt
        };
      }
    });

    const batchUsageAfter = runningHubImageApiKey ? await getRunningHubAccountUsageSnapshot().catch(() => null) : null;
    const usage = buildRunningHubCost(batchUsageBefore, batchUsageAfter);
    const usageLog = runningHubImageApiKey ? appendUsageLog({
      type: 'image-batch-generate',
      provider: 'runninghub',
      model: runningHubModelName,
      endpoint: runningHubImageEndpoint,
      count: items.length,
      concurrency,
      successCount: results.filter((item) => item.status === 'done').length,
      failedCount: results.filter((item) => item.status === 'failed').length,
      usage
    }) : null;

    res.json({ model, concurrency, usage, usageLog, results });
  } finally {
    for (const file of sourceFiles) fs.rm(file.path, { force: true }, () => {});
  }
});

app.post('/api/download-batch', express.json({ limit: '1mb' }), async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const readyItems = items.filter((item) => typeof item.imageUrl === 'string' && item.imageUrl.startsWith('/outputs/'));
  if (!readyItems.length) {
    return res.status(400).json({ error: '还没有可下载的图片。' });
  }

  res.attachment(`xiaohongshu-covers-${Date.now()}.zip`);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', (error) => {
    if (!res.headersSent) res.status(500).json({ error: error.message || '打包失败' });
    else res.end();
  });
  archive.pipe(res);

  for (const item of readyItems) {
    const relativeName = item.imageUrl.replace(/^\/outputs\//, '');
    const safeName = path.basename(relativeName);
    const filePath = path.join(outputDir, safeName);
    if (!filePath.startsWith(outputDir) || !fs.existsSync(filePath)) continue;
    const id = String(item.id || readyItems.indexOf(item) + 1).padStart(2, '0');
    const ext = path.extname(safeName) || '.png';
    archive.file(filePath, { name: `${id}-${sanitizeFilePart(item.noteTitle || 'cover')}${ext}` });
  }

  await archive.finalize();
});

app.post('/api/download-outputs', async (req, res) => {
  const files = fs.readdirSync(outputDir)
    .filter((name) => /\.(png|jpe?g|webp)$/i.test(name))
    .sort();
  if (!files.length) {
    return res.status(400).json({ error: 'outputs 文件夹里还没有图片。' });
  }

  res.attachment(`xiaohongshu-history-${Date.now()}.zip`);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('error', (error) => {
    if (!res.headersSent) res.status(500).json({ error: error.message || '打包失败' });
    else res.end();
  });
  archive.pipe(res);

  for (const name of files) {
    archive.file(path.join(outputDir, name), { name });
  }

  await archive.finalize();
});

app.listen(port, () => {
  console.log(`XHS cover workflow running at http://localhost:${port}`);
});
