/**
 * 本地曲库「音质视图过滤」—— localQualityFilter 纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const LOCAL_JS = read('src/renderer/js/views/local.js');
const FILT_JS = read('src/renderer/js/localQualityFilter.js');
const HTML = read('src/renderer/index.html');
const PALETTE = read('src/renderer/js/commandPalette.js');

function fresh() {
  return import('../src/renderer/js/localQualityFilter.js?QF=' + Math.random());
}

const s = (filePath) => ({ filePath });
const FLAC = s('/m/a.flac');
const MP3 = s('/m/b.mp3');
const LOSSLESS = { ok: true, codec: 'flac', bitrateKbps: 900, verdict: 'lossless' };
const SUSPECT = { ok: true, codec: 'flac', bitrateKbps: 120, verdict: 'suspicious' };
const FAKE = { ok: true, codec: 'mp3', bitrateKbps: 320, verdict: 'lossy' };
const FAILED = { ok: false, error: 'no ffprobe' };

const LIST = [FLAC, MP3, s('/m/c.wav'), s('/m/d.m4a')];

test('模式循环：all→nominal→verified→suspect→unprobed→all，脏值回 all', async () => {
  const { nextQualMode, QUALITY_MODES } = await fresh();
  assert.deepEqual(QUALITY_MODES, ['all', 'nominal', 'verified', 'suspect', 'unprobed']);
  let m = 'all';
  const seen = [];
  for (let i = 0; i < 6; i++) { m = nextQualMode(m); seen.push(m); }
  assert.deepEqual(seen, ['nominal', 'verified', 'suspect', 'unprobed', 'all', 'nominal']);
  assert.equal(nextQualMode('garbage'), 'all');
  assert.equal(nextQualMode(undefined), 'all');
});

test('标称轴：nominal 只认无损容器扩展名，unprobed 只挑无损容器里没实测的', async () => {
  const { filterByQuality } = await fresh();
  const noProbe = () => null;
  assert.deepEqual(filterByQuality(LIST, noProbe, 'nominal').map(x => x.filePath), ['/m/a.flac', '/m/c.wav']);
  assert.deepEqual(filterByQuality(LIST, noProbe, 'unprobed').map(x => x.filePath), ['/m/a.flac', '/m/c.wav']);
  assert.deepEqual(filterByQuality(LIST, noProbe, 'all'), LIST.slice(), 'all 原样返回（顺序不动）');
});

test('实测轴：verified 只放真无损，suspect 收存疑与伪无损，未测一律出局', async () => {
  const { filterByQuality } = await fresh();
  const cache = new Map([['/m/a.flac', LOSSLESS], ['/m/c.wav', FAKE], ['/m/b.mp3', SUSPECT]]);
  const probeOf = (fp) => cache.get(fp) || null;
  assert.deepEqual(filterByQuality(LIST, probeOf, 'verified').map(x => x.filePath), ['/m/a.flac']);
  assert.deepEqual(filterByQuality(LIST, probeOf, 'suspect').map(x => x.filePath), ['/m/b.mp3', '/m/c.wav'],
    '存疑与伪无损并进同一把筛（都该重下），顺序按曲库原序');
  assert.deepEqual(filterByQuality(LIST, probeOf, 'unprobed').map(x => x.filePath), [], '已实测的不再进待验清单');
});

test('探测失败当「未测」处理（不让失败行混进 verified），脏输入不炸', async () => {
  const { filterByQuality, matchQualityMode, inLosslessContainer } = await fresh();
  assert.deepEqual(filterByQuality([FLAC], () => FAILED, 'verified'), []);
  assert.deepEqual(filterByQuality([FLAC], () => FAILED, 'unprobed').map(x => x.filePath), ['/m/a.flac']);
  assert.equal(matchQualityMode(FLAC, null, 'nope'), true, '未知 mode 不误伤（等价 all）');
  assert.equal(inLosslessContainer({}), false);
  assert.deepEqual(filterByQuality(null, null, 'nominal'), []);
  assert.deepEqual(filterByQuality([null, MP3], null, 'nominal'), []);
});

test('文案：每个 mode 一句话，未知 mode 回落全部（按钮文字来自函数，不散落字面量）', async () => {
  const { qualModeLabel, QUALITY_MODES } = await fresh();
  assert.equal(qualModeLabel('all'), '🧪 音质: 全部');
  assert.equal(qualModeLabel('unprobed'), '🧪 音质: 仅待验（无损容器未实测）');
  assert.equal(qualModeLabel('weird'), '🧪 音质: 全部');
  for (const m of QUALITY_MODES) assert.ok(qualModeLabel(m).startsWith('🧪 '), m);
});

test('接线钉：local.js 管线 + 循环函数 + window 桥 + HTML 按钮 + 面板项，纯函数模块零 DOM', () => {
  assert.ok(LOCAL_JS.includes("import { qualModeLabel, nextQualMode, filterByQuality } from '../localQualityFilter.js';"));
  assert.ok(LOCAL_JS.includes("  if (_localQualMode !== 'all') songs = filterByQuality(songs, (fp) => _probeCache.get(fp), _localQualMode);"));
  assert.ok(LOCAL_JS.includes([
    'function cycleLocalQual() {',
    "  _localQualMode = nextQualMode(_localQualMode);",
    "  const btn = document.getElementById('localQualBtn');",
    '  if (btn) btn.textContent = qualModeLabel(_localQualMode);',
    '  filterLocalSongs();',
    '}',
  ].join('\n')), '循环函数：换态 → 刷按钮字样 → 重过筛（必须 filterLocalSongs，renderLocalSongs 只重画旧数组，等于点了没用）');
  assert.ok(LOCAL_JS.indexOf('if (_localFmtMode !== ') < LOCAL_JS.indexOf('if (_localQualMode !== '),
    '格式轴先于音质轴（音质按已过滤的视图再切，与收藏/关键词同为 AND 叠加）');
  assert.equal((LOCAL_JS.match(/window\.cycleLocalQual = cycleLocalQual;/g) || []).length, 1);
  assert.ok(HTML.includes('id="localQualBtn" onclick="cycleLocalQual()"'));
  assert.ok(PALETTE.includes("id: 'loc-qual'") && PALETTE.includes("_call('cycleLocalQual')"));
  assert.ok(!FILT_JS.includes('document') && !FILT_JS.includes('innerHTML'));
  assert.match(FILT_JS, /import \{ extOf \} from '\.\/localFormatFilter\.js';/, '扩展名口径与 107 同源');
});
