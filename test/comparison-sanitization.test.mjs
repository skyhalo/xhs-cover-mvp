import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

async function loadServerInternals(options = {}) {
  const root = path.resolve(import.meta.dirname, '..');
  const sourcePath = path.join(root, 'server.mjs');
  const source = await fs.readFile(sourcePath, 'utf8');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhs-cover-test-'));
  if (typeof options.setupTempDir === 'function') {
    await options.setupTempDir(tempDir);
  }
  const modulePath = path.join(root, `.server-under-test-${process.pid}-${Date.now()}.mjs`);
  const transformed = source.replace(
    /app\.listen\(port,[\s\S]*?\n\}\);\s*$/,
    'export { buildComparisonEmphasisPlan, buildComparisonImagePrompt, buildComparisonInlineEmphasisRanges, buildSingleProductImageSections, createComparisonGenerationReference, createStopServerHandler, formatComparisonDataForPrompt, getComparisonTextFill, getComparisonTitlePalette, isNarrativeReviewStyle, mergeComparisonStyleAnalysis, normalizeComparisonData, readComparisonStyles, shouldCropNonReusableTemplateHeader, shouldUseSplitComparisonTitleColor, svgRichTextBlock, svgTextBlock };'
  );

  process.env.XHS_DATA_DIR = path.join(tempDir, 'data');
  process.env.PORT = '0';
  await fs.writeFile(modulePath, transformed);
  try {
    return await import(pathToFileURL(modulePath).href);
  } finally {
    await fs.rm(modulePath, { force: true });
  }
}

test('comparison normalization removes model-returned html tags from table fields', async () => {
  const { normalizeComparisonData, svgTextBlock } = await loadServerInternals();

  const data = normalizeComparisonData({
    title: '预算6K左右，准大学生轻薄本到底怎么选？',
    products: [
      {
        name: '荣耀MagicBook14 2026',
        battery: '<span style="color:red">92Wh 大电池</span> + HONOR Turbo X整机调优，100W快充',
        highlights: '<span style="color:red">最高85W 性能释放</span>、<span style="color:red">LPDDR5X-9600高速内存</span>'
      }
    ]
  });

  assert.equal(data.products[0].battery, '92Wh 大电池 + HONOR Turbo X整机调优，100W快充');
  assert.equal(data.products[0].highlights, '最高85W 性能释放、LPDDR5X-9600高速内存');

  const svg = svgTextBlock({
    text: data.products[0].highlights,
    x: 0,
    y: 0,
    width: 300,
    height: 100
  });

  assert.ok(!svg.includes('&lt;span'));
  assert.ok(!svg.includes('style=&quot;color:red&quot;'));
  assert.ok(svg.includes('最高85W'));
});

test('comparison prompt uses slash for a missing product value when another product has that field', async () => {
  const { formatComparisonDataForPrompt, normalizeComparisonData } = await loadServerInternals();

  const data = normalizeComparisonData({
    title: '轻薄本参数对比',
    products: [
      {
        name: '产品 A',
        processor: 'Ultra X7',
        extraFields: [{ label: '接口', value: 'USB-C x2，HDMI x1' }]
      },
      {
        name: '产品 B',
        processor: 'U7 356H'
      }
    ]
  });

  const promptText = formatComparisonDataForPrompt(data);

  assert.match(promptText, /产品2：产品 B[\s\S]*接口：\//);
  assert.doesNotMatch(promptText, /接口：未提供/);
  assert.doesNotMatch(promptText, /接口：未提及/);
});

test('comparison normalization removes dimensions that have no source-copy evidence', async () => {
  const { formatComparisonDataForPrompt, normalizeComparisonData } = await loadServerInternals();
  const sourceText = [
    '产品1：产品 A',
    '芯片：Ultra X7 358H',
    '内存：LPDDR5X-9600，1TB',
    '接口：USB-C x2，HDMI x1',
    '产品2：产品 B',
    '芯片：U7 356H',
    '内存：DDR5-5600MT/s，1TB'
  ].join('\n');

  const data = normalizeComparisonData({
    title: '轻薄本参数对比',
    products: [
      {
        name: '产品 A',
        processor: 'Ultra X7 358H',
        memoryStorage: 'LPDDR5X-9600，1TB',
        highlights: '性能释放强，适合重度学习',
        audience: '准大学生首选',
        extraFields: [{ label: '接口', value: 'USB-C x2，HDMI x1' }]
      },
      {
        name: '产品 B',
        processor: 'U7 356H',
        memoryStorage: 'DDR5-5600MT/s，1TB',
        highlights: 'OLED屏幕，AI功能体系',
        audience: '准大学生可选'
      }
    ]
  }, '轻薄本参数对比', sourceText);

  const rowLabels = data.rows.map((row) => String(row.label || '').replace(/\n/g, ''));
  assert.deepEqual(rowLabels, ['处理器', '内存硬盘', '接口']);

  const promptText = formatComparisonDataForPrompt(data);
  assert.match(promptText, /产品2：产品 B[\s\S]*接口：\//);
  assert.doesNotMatch(promptText, /核心亮点/);
  assert.doesNotMatch(promptText, /适合人群/);
});

test('stop server handler responds without scheduling process exit', async () => {
  const { createStopServerHandler } = await loadServerInternals();
  let scheduledExit = false;
  const payloads = [];
  const handler = createStopServerHandler();

  handler({}, {
    json(payload) {
      payloads.push(payload);
    }
  });

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].ok, true);
  assert.equal(scheduledExit, false);
});

test('comparison style model analysis replaces generic uploaded-template metadata', async () => {
  const { mergeComparisonStyleAnalysis } = await loadServerInternals();

  const merged = mergeComparisonStyleAnalysis({
    id: 'style-1',
    name: '参数对比表',
    layout: 'classic-table',
    previewImage: '/outputs/example.png',
    mood: '来自用户上传的参数对比参考图',
    titleColor: '#111111',
    headerBg: '#eeeeee',
    audienceBg: '#eeeeee',
    cellBg: '#ffffff',
    rowAlt: '#fafafa',
    gridColor: '#222222',
    textColor: '#111827'
  }, {
    styleName: '红白竖评参数卡',
    layout: 'series-bands',
    bestFor: '数码电脑、轻薄本和性能本横向测评',
    mood: '红色强调、白底科技感、密集参数说明',
    composition: '标题在顶部，产品参数分区排列，重点数据用红色强调。',
    visualRules: '保留大标题、分区参数、产品图右侧展示和红色重点数字。',
    copyStructure: '主标题 + 产品定位 + 参数分区 + 购买建议'
  }, 0);

  assert.equal(merged.name, '红白竖评参数卡');
  assert.equal(merged.layout, 'series-bands');
  assert.equal(merged.bestFor, '数码电脑、轻薄本和性能本横向测评');
  assert.match(merged.mood, /红色强调/);
  assert.match(merged.visualRules, /产品图右侧展示/);
});

test('comparison generation uses selected template preview as a style reference', async () => {
  const { createComparisonGenerationReference } = await loadServerInternals();
  const outputDir = path.join(process.env.XHS_DATA_DIR, 'outputs');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="#fff"/><rect x="10" y="10" width="100" height="140" fill="#e11d48"/></svg>';
  const layoutPath = path.join(outputDir, 'layout.svg');
  const stylePath = path.join(outputDir, 'style.svg');
  await fs.writeFile(layoutPath, svg);
  await fs.writeFile(stylePath, svg);

  const reference = await createComparisonGenerationReference({
    layoutReferencePath: layoutPath,
    style: {
      name: '红白轻薄本点评',
      previewImage: '/outputs/style.svg'
    }
  });

  assert.equal(reference.file.originalname, 'comparison-style-and-layout-reference.png');
  assert.notEqual(reference.file.path, layoutPath);
  assert.equal(reference.styleReferenceUrl, '/outputs/style.svg');
  assert.match(reference.combinedReferenceUrl, /^\/outputs\/comparison-reference-/);
});

test('single product with multiple uploaded images becomes multiple in-card sections', async () => {
  const { buildSingleProductImageSections } = await loadServerInternals();

  const sections = buildSingleProductImageSections({
    name: '荣耀MagicBook14 2026',
    processor: 'Ultra X7 358H / U5 336H',
    memoryStorage: 'LPDDR5X-9600，1TB',
    screen: '14寸2.8K 120Hz LCD，430nits',
    weightThickness: '1.30kg / 16.0mm',
    battery: '92Wh大电池，100W快充'
  }, [{}, {}, {}]);

  assert.equal(sections.length, 3);
  assert.deepEqual(sections.map((section) => section.imageIndex), [0, 1, 2]);
  assert.deepEqual(sections.map((section) => section.title), ['轻薄便携', '性能核心', '屏幕体验']);
  assert.match(sections[0].body, /1\.30kg/);
  assert.match(sections[1].body, /Ultra X7/);
  assert.match(sections[2].body, /120Hz/);
});

test('uploaded style references crop non-reusable source headers before image generation', async () => {
  const { shouldCropNonReusableTemplateHeader } = await loadServerInternals();

  assert.equal(shouldCropNonReusableTemplateHeader('/outputs/user-uploaded-template.jpg'), true);
  assert.equal(shouldCropNonReusableTemplateHeader('/template-previews/comparison-major-rows.png'), false);
});

test('comparison image prompt forbids copying template source metadata and invented parameter cards', async () => {
  const { buildComparisonImagePrompt, normalizeComparisonData } = await loadServerInternals();
  const data = normalizeComparisonData({
    title: 'MagicBook14 2026冰川值得入手吗？',
    products: [{ name: 'MagicBook14 2026', processor: 'Ultra X7 358H' }]
  });

  const prompt = buildComparisonImagePrompt({
    data,
    style: { name: '红白三段点评', previewImage: '/outputs/template.jpg' },
    aspectRatio: '3:4',
    hasStyleReference: true
  });

  assert.match(prompt, /禁止复制.*头像.*作者.*About/);
  assert.match(prompt, /不要新增右侧参数卡/);
  assert.match(prompt, /产品图.*下半部分/);
});

test('built-in comparison templates keep their original prompt behavior', async () => {
  const { buildComparisonImagePrompt, normalizeComparisonData } = await loadServerInternals();
  const data = normalizeComparisonData({
    title: '预算6K轻薄本怎么选',
    products: [{ name: '产品 A', processor: 'Ultra X7' }]
  });

  const prompt = buildComparisonImagePrompt({
    data,
    style: { name: '参数对比 | 专业天选清单', previewImage: '/template-previews/comparison-major-rows.png' },
    aspectRatio: '3:4',
    hasStyleReference: true
  });

  assert.doesNotMatch(prompt, /顶部来源栏/);
  assert.doesNotMatch(prompt, /不要新增右侧参数卡/);
  assert.doesNotMatch(prompt, /主标题不要变成灰色/);
});

test('vertical review template uses narrative reviews instead of parameter lists', async () => {
  const { buildComparisonImagePrompt, isNarrativeReviewStyle, normalizeComparisonData } = await loadServerInternals();
  const style = { id: 'style-1786525186423-mspuyw6v-1', name: '竖排点评横评', previewImage: '/template-previews/user-comparison-style.png' };
  const data = normalizeComparisonData({
    title: '三款游戏本怎么选',
    products: [{
      name: '产品 A',
      processor: 'U9 290HX Plus',
      review: '屏幕素质出色，接口丰富，不过价格在三款里相对较高。'
    }]
  });

  const prompt = buildComparisonImagePrompt({ data, style, aspectRatio: '3:4', hasStyleReference: true });

  assert.equal(isNarrativeReviewStyle(style), true);
  assert.match(prompt, /一段完整、连贯的自然语言点评/);
  assert.match(prompt, /禁止拆成处理器、显卡、屏幕、接口等参数清单/);
  assert.match(prompt, /点评：屏幕素质出色/);
});

test('vertical review uploaded templates keep the whole title in one color when requested', async () => {
  const {
    buildComparisonEmphasisPlan,
    buildComparisonImagePrompt,
    normalizeComparisonData,
    shouldUseSplitComparisonTitleColor
  } = await loadServerInternals();
  const style = {
    id: 'style-1786525186423-mspuyw6v-1',
    name: '竖排点评横评',
    previewImage: '/outputs/user-template.png',
    titleColor: '#6d7169',
    visualRules: '标题采用黑色/近黑粗体为主，型号或关键词用红色强调；左侧竖线和分区小标题使用红色。'
  };
  const data = normalizeComparisonData({
    title: 'WIN游戏本H9/拯救者Y9000P/暗影精灵Pro',
    products: [{ name: 'WIN游戏本 H9', review: '综合性价比突出。' }]
  });
  const emphasisPlan = buildComparisonEmphasisPlan(data, '原始标题这一行生成后需要都是红色');
  const prompt = buildComparisonImagePrompt({
    data,
    style,
    aspectRatio: '3:4',
    hasStyleReference: true,
    emphasisPlan
  });

  assert.equal(shouldUseSplitComparisonTitleColor(style), false);
  assert.match(prompt, /主标题必须整行同色/);
  assert.match(prompt, /用户要求标题统一颜色/);
  assert.match(prompt, /禁止把标题里的品牌、型号、品类词拆成不同颜色/);
  assert.doesNotMatch(prompt, /红色只用于型号、关键词/);
});

test('red black uploaded templates do not use extracted gray as the main title color', async () => {
  const { getComparisonTitlePalette, shouldUseSplitComparisonTitleColor } = await loadServerInternals();
  const style = {
    name: '红黑标题参数卡',
    previewImage: '/outputs/template.png',
    titleColor: '#67716c',
    gridColor: '#67716c',
    mood: '浅色清爽背景搭配深色粗体文字和红色大标题',
    visualRules: '红色竖线，红黑标题，红色小标题'
  };

  const palette = getComparisonTitlePalette(style);

  assert.equal(shouldUseSplitComparisonTitleColor(style), true);
  assert.equal(palette.main, '#111827');
  assert.equal(palette.accent, '#e11d2e');
  assert.equal(palette.section, '#e11d2e');
});

test('bundled comparison templates are merged when old user data exists', async () => {
  const oldUserStyles = [
    { id: 'digital-rtx-vertical-review', name: '参数对比 | Digital性能横评', layout: 'classic-table' }
  ];
  const { readComparisonStyles } = await loadServerInternals({
    async setupTempDir(tempDir) {
      const dataDir = path.join(tempDir, 'data');
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(path.join(dataDir, 'comparison-table-styles.json'), `${JSON.stringify(oldUserStyles, null, 2)}\n`);
    }
  });

  const styles = readComparisonStyles();
  assert.equal(styles.length, 16);
  assert.equal(styles.filter((style) => style.id === 'digital-rtx-vertical-review').length, 1);
  assert.ok(styles.some((style) => style.name === '竖排点评横评'));
  assert.ok(styles.some((style) => style.name === '参数对比 | 深色大标题密表'));
});

test('topic direction creates a red bold emphasis plan for the requested product', async () => {
  const { buildComparisonEmphasisPlan, normalizeComparisonData } = await loadServerInternals();
  const data = normalizeComparisonData({
    title: '预算6K轻薄本怎么选',
    products: [
      { name: '荣耀MagicBook14 2026（冰川）', processor: 'Ultra X7 358H / U5 336H', battery: '92Wh大电池，100W快充' },
      { name: '联想小新Pro14 2026', processor: 'U7 356H', battery: '60Wh，100W PD快充' }
    ]
  });

  const plan = buildComparisonEmphasisPlan(data, '在选购指南中去突出荣耀的优势，主要推荐荣耀，荣耀相关重点数据都要红色标注加粗');

  assert.equal(plan.active, true);
  assert.equal(plan.color, '#e11d2e');
  assert.deepEqual(plan.primaryProductIndexes, [0]);
  assert.match(plan.promptText, /荣耀MagicBook14 2026/);
  assert.match(plan.promptText, /红色加粗/);
});

test('topic direction keeps the text block base color while inline fragments carry red emphasis', async () => {
  const { buildComparisonEmphasisPlan, buildComparisonInlineEmphasisRanges, getComparisonTextFill, normalizeComparisonData } = await loadServerInternals();
  const data = normalizeComparisonData({
    title: '预算6K轻薄本怎么选',
    products: [
      { name: '荣耀MagicBook14 2026（冰川）', processor: 'Ultra X7 358H / U5 336H' },
      { name: '联想小新Pro14 2026', processor: 'U7 356H' }
    ]
  });
  const row = { key: 'processor', label: '处理器' };
  const plan = buildComparisonEmphasisPlan(data, '主要推荐荣耀，荣耀相关重点数据都要红色标注加粗');

  assert.equal(getComparisonTextFill({ product: data.products[0], productIndex: 0, row, value: data.products[0].processor, style: {}, emphasisPlan: plan }), '#111827');
  assert.equal(getComparisonTextFill({ product: data.products[1], productIndex: 1, row, value: data.products[1].processor, style: {}, emphasisPlan: plan }), '#111827');
  assert.ok(buildComparisonInlineEmphasisRanges({ product: data.products[0], productIndex: 0, row, value: data.products[0].processor, emphasisPlan: plan }).length > 0);
  assert.equal(buildComparisonInlineEmphasisRanges({ product: data.products[1], productIndex: 1, row, value: data.products[1].processor, emphasisPlan: plan }).length, 0);
});

test('topic direction highlights only key fragments instead of the whole sentence', async () => {
  const { buildComparisonEmphasisPlan, buildComparisonInlineEmphasisRanges, normalizeComparisonData, svgRichTextBlock } = await loadServerInternals();
  const data = normalizeComparisonData({
    title: '预算6K轻薄本怎么选',
    products: [
      { name: '荣耀MagicBook14 2026（冰川）', price: '暑促叠加国补+教育优惠，U5 16G版最低到手5524.15元' }
    ]
  });
  const product = data.products[0];
  const row = { key: 'price', label: '到手价' };
  const plan = buildComparisonEmphasisPlan(data, '主要推荐荣耀，荣耀相关重点数据都要红色标注加粗');
  const ranges = buildComparisonInlineEmphasisRanges({
    product,
    productIndex: 0,
    row,
    value: product.price,
    emphasisPlan: plan
  });

  assert.ok(ranges.some((range) => product.price.slice(range.start, range.end) === '5524.15'));
  assert.ok(ranges.some((range) => product.price.slice(range.start, range.end) === 'U5 16G'));
  assert.ok(!ranges.some((range) => range.start === 0 && range.end === product.price.length));

  const svg = svgRichTextBlock({
    text: product.price,
    x: 0,
    y: 0,
    width: 520,
    height: 120,
    size: 24,
    weight: 760,
    fill: '#111827',
    emphasisFill: plan.color,
    emphasisWeight: 950,
    emphasisRanges: ranges,
    align: 'left',
    maxLines: 2
  });

  assert.match(svg, /fill="#111827"[\s\S]*暑促叠加国补/);
  assert.match(svg, /fill="#e11d2e"[\s\S]*5524\.15/);
  assert.doesNotMatch(svg, /fill="#e11d2e"[^>]*>暑促叠加国补/);
});

test('comparison image prompt treats topic direction as required generation logic', async () => {
  const { buildComparisonEmphasisPlan, buildComparisonImagePrompt, normalizeComparisonData } = await loadServerInternals();
  const data = normalizeComparisonData({
    title: '预算6K轻薄本怎么选',
    products: [
      { name: '荣耀MagicBook14 2026（冰川）', processor: 'Ultra X7 358H / U5 336H', battery: '92Wh大电池，100W快充' },
      { name: '联想小新Pro14 2026', processor: 'U7 356H', battery: '60Wh，100W PD快充' }
    ]
  });
  const emphasisPlan = buildComparisonEmphasisPlan(data, '在选购指南中去突出荣耀的优势，主要推荐荣耀，荣耀相关重点数据都要红色标注加粗');

  const prompt = buildComparisonImagePrompt({
    data,
    style: { name: '参数对比表', previewImage: '/template-previews/comparison-major-rows.png' },
    aspectRatio: '3:4',
    emphasisPlan,
    hasStyleReference: true
  });

  assert.match(prompt, /选题方向 \/ 画面目标/);
  assert.match(prompt, /不是备注/);
  assert.match(prompt, /荣耀MagicBook14 2026/);
  assert.match(prompt, /红色加粗/);
  assert.match(prompt, /不要整句/);
  assert.match(prompt, /执行优先级/);
});

test('objective comparison mode highlights only the lowest price in the price row', async () => {
  const { buildComparisonEmphasisPlan, buildComparisonInlineEmphasisRanges, normalizeComparisonData } = await loadServerInternals();
  const data = normalizeComparisonData({
    title: '预算6K轻薄本怎么选',
    products: [
      { name: '荣耀MagicBook14 2026', price: '暑促叠加国补+教育优惠，最低到手5524.15元' },
      { name: '联想小新Pro14 2026', price: '到手7224.15元' },
      { name: 'ThinkBook14 2026', price: '到手6629.15元' }
    ]
  });
  const row = { key: 'price', label: '到手价' };
  const plan = buildComparisonEmphasisPlan(data, '每一行参数都先比较三者差异，再将该项中最突出的优势信息用红色加粗呈现');
  const rangesByProduct = data.products.map((product, productIndex) => buildComparisonInlineEmphasisRanges({
    products: data.products,
    product,
    productIndex,
    row,
    value: product.price,
    emphasisPlan: plan
  }).map((range) => product.price.slice(range.start, range.end)));

  assert.equal(plan.comparativeMode, true);
  assert.deepEqual(rangesByProduct[0], ['5524.15']);
  assert.deepEqual(rangesByProduct[1], []);
  assert.deepEqual(rangesByProduct[2], []);
});

test('objective comparison mode highlights only the strongest tdp in the processor row', async () => {
  const { buildComparisonEmphasisPlan, buildComparisonInlineEmphasisRanges, normalizeComparisonData } = await loadServerInternals();
  const data = normalizeComparisonData({
    title: '预算6K轻薄本怎么选',
    products: [
      { name: '荣耀MagicBook14 2026', processor: 'Ultra X7 358H / U5 336H | TDP最高85W，双风扇散热' },
      { name: '联想小新Pro14 2026', processor: 'U7 356H / U5 336H | TDP 46W' },
      { name: 'ThinkBook14 2026', processor: 'U7 356H / U5 336H | TDP 40W' }
    ]
  });
  const row = { key: 'processor', label: '处理器' };
  const plan = buildComparisonEmphasisPlan(data, '基于三款电脑在同一配置维度下的客观对比结果来决定。每一行参数都先比较三者差异，再将该项中最突出的优势信息用红色加粗呈现');
  const rangesByProduct = data.products.map((product, productIndex) => buildComparisonInlineEmphasisRanges({
    products: data.products,
    product,
    productIndex,
    row,
    value: product.processor,
    emphasisPlan: plan
  }).map((range) => product.processor.slice(range.start, range.end)));

  assert.deepEqual(rangesByProduct[0], ['85W']);
  assert.deepEqual(rangesByProduct[1], []);
  assert.deepEqual(rangesByProduct[2], []);
});
