/**
 * 设置页搜索 —— settingsSearch.js 纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_JS = readFileSync(path.join(ROOT, 'src/renderer/js/views/settings.js'), 'utf8');
const HTML = readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const CSS = readFileSync(path.join(ROOT, 'src/renderer/styles/overlays.css'), 'utf8');
const PALETTE_JS = readFileSync(path.join(ROOT, 'src/renderer/js/commandPalette.js'), 'utf8');
const ZH = JSON.parse(readFileSync(path.join(ROOT, 'src/renderer/js/lang/zh.json'), 'utf8'));
const EN = JSON.parse(readFileSync(path.join(ROOT, 'src/renderer/js/lang/en.json'), 'utf8'));

async function fresh() {
  return import('../src/renderer/js/settingsSearch.js?tc=' + Math.random());
}

function mkPages() {
  return [
    [
      {
        title: '下载',
        blocks: [
          { kind: 'row', text: '默认音质 搜索和下载时的默认音质' },
          { kind: 'row', text: '下载限速 (KB/s) 每任务下载速度上限，0 表示不限速' },
          { kind: 'other', text: '' }, // 卡片容器：只随节显隐
        ],
      },
      {
        title: '元数据',
        blocks: [{ kind: 'other', text: '下载完成后自动获取歌词存为同目录 .lrc（已有歌词不覆盖）' }],
      },
    ],
    [
      { title: '限速与并发', blocks: [{ kind: 'row', text: '最大并发下载数 同时下载的任务数量（1~10）' }] },
    ],
  ];
}

test('sTokens/sMatch：分词小写 AND，空词返回 null', async () => {
  const { sTokens, sMatch } = await fresh();
  assert.deepEqual(sTokens('  限速 KB '), ['限速', 'kb']);
  assert.equal(sTokens(''), null);
  assert.equal(sTokens(null), null);
  assert.equal(sMatch('下载限速 (KB/s)', ['限速', 'kb']), true);
  assert.equal(sMatch('下载限速', ['限速', 'kb']), false);
  assert.equal(sMatch('', ['x']), false);
});

test('planSettingsSearch：行命中留节隐行；标题命中全显；other 命中记 1；容器随节', async () => {
  const { planSettingsSearch } = await fresh();
  assert.equal(planSettingsSearch(mkPages(), '  '), null);

  let plan = planSettingsSearch(mkPages(), '限速');
  // p0: 行「下载限速」命中 → 节 keep，未命中行隐藏，other 容器随节可见；hits=1
  assert.equal(plan.pages[0].sections[0].keep, true);
  assert.deepEqual(plan.pages[0].sections[0].visible, [false, true, true]);
  assert.equal(plan.pages[0].sections[1].keep, false);
  assert.equal(plan.pages[0].hits, 1);
  // p1: 标题「限速与并发」命中 → 节内行全显（标题即整节语义）
  assert.equal(plan.pages[1].sections[0].visible[0], true);
  assert.equal(plan.pages[1].hits, 1);
  assert.equal(plan.total, 2);

  // 多词 AND：kb 只在 p0 一行上，p1 标题/行都不含 → p1 全隐
  plan = planSettingsSearch(mkPages(), '限速 kb');
  assert.equal(plan.pages[1].sections[0].keep, false);
  assert.equal(plan.total, 1);

  // 仅 other 命中（歌词）：无行可数 → 记 1 防徽标假 0；另一节 keep=false
  plan = planSettingsSearch(mkPages(), '歌词');
  assert.equal(plan.pages[0].sections[1].keep, true);
  assert.equal(plan.pages[0].hits, 1);
  assert.equal(plan.total, 1);

  // 标题命中词：元数据节整节保留（other 随节）
  plan = planSettingsSearch(mkPages(), '元数据');
  assert.equal(plan.pages[0].sections[1].keep, true);
  assert.equal(plan.pages[0].sections[0].keep, false);

  // 全空命中 → total 0，供空态提示
  plan = planSettingsSearch(mkPages(), '不存在的词');
  assert.equal(plan.total, 0);

  // 畸形输入不炸：sec 无 blocks、pages 非数组
  assert.deepEqual(planSettingsSearch([[{ title: null }]], 'x').total, 0);
  assert.equal(planSettingsSearch(null, 'x').total, 0);
});

test('接线钉：设置面板搜索框/空态/桥接/CSS/双语键/命令面板入口', async () => {
  assert.match(SETTINGS_JS, /import \{ planSettingsSearch \} from '\.\.\/settingsSearch\.js';/);
  assert.match(SETTINGS_JS, /window\.runSettingsSearch = runSettingsSearch;/);
  assert.match(SETTINGS_JS, /window\.focusSettingsSearch = focusSettingsSearch;/);
  // 只加减 srch-hide 类，绝不碰行内 display
  assert.match(SETTINGS_JS, /classList\.toggle\('srch-hide'/);
  assert.ok(!/function runSettingsSearch[\s\S]{0,2000}?\.style\.display/.test(SETTINGS_JS));
  // 打开面板先复位上次的过滤
  assert.match(SETTINGS_JS, /if \(searchInput\) searchInput\.value = '';\s*\n\s*clearSettingsSearch\(\);/);

  assert.match(HTML, /id="settingsSearchInput"[\s\S]{0,200}oninput="runSettingsSearch\(this\.value\)"/);
  assert.match(HTML, /<div class="settings-search-empty hidden" id="settingsSearchEmpty" data-i18n="settings\.searchEmpty">/);

  assert.match(CSS, /\.settings-page \.srch-hide \{ display: none !important; \}/);

  // 教训：data-i18n 键必须 zh/en 双文件同增
  for (const k of ['settings.searchPh', 'settings.searchEmpty']) {
    assert.ok(typeof ZH[k] === 'string' && ZH[k], 'zh missing ' + k);
    assert.ok(typeof EN[k] === 'string' && EN[k], 'en missing ' + k);
  }

  assert.match(PALETTE_JS, /\{ id: 'set-search'/);
  assert.match(PALETTE_JS, /_call\('focusSettingsSearch'\)/);
});
