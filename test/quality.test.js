/**
 * 分平台音质：纯解析逻辑 + prefs 白名单一致性
 *
 * 1) pickQuality 是纯函数，不碰 DOM / api，直接测覆盖优先级与非法值回退。
 *    renderer 的 logger.js 在模块顶层读 window.location，所以 import 前先补桩。
 * 2) 白名单一致性：prefs 的 set-pref 对未列出的键**静默拒绝**（只记日志），
 *    最坑的地方就是「设置页写了、主进程不落盘、界面上还显示成功」。
 *    这里断言云同步可导入的每个用户键都进了白名单，防止再加键时漏改一处。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

// renderer logger 顶层即读 window.location，必须在 import 前补桩
globalThis.window = { location: { hostname: 'localhost', protocol: 'file:' }, __PLATFORMS: [] };
globalThis.document = undefined;
globalThis.fallbackPlatformIds = () => ['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda'];
globalThis.getPlatforms = () => [];

const QUALITY_JS = path.join(__dirname, '..', 'src', 'renderer', 'js', 'quality.js');
const MODULE_URL = 'file:///' + QUALITY_JS.split(path.sep).join('/');

let qmod;
test.before(async () => { qmod = await import(MODULE_URL); });

test('pickQuality: 无覆盖表 / 未知平台时回退默认档位', () => {
  const { pickQuality } = qmod;
  assert.equal(pickQuality({}, 'netease', 'hq'), 'hq');
  assert.equal(pickQuality(undefined, 'netease', 'lossless'), 'lossless');
  assert.equal(pickQuality(null, 'netease', 'standard'), 'standard');
  assert.equal(pickQuality({}, '', 'hq'), 'hq');
  assert.equal(pickQuality({}, undefined, 'hq'), 'hq');
});

test('pickQuality: 平台覆盖优先于全局默认', () => {
  const { pickQuality } = qmod;
  assert.equal(pickQuality({ netease: 'lossless' }, 'netease', 'standard'), 'lossless');
  assert.equal(pickQuality({ netease: 'lossless' }, 'qq', 'standard'), 'standard');
  assert.equal(pickQuality({ qq: 'hq' }, 'qq', 'lossless'), 'hq');
});

test('pickQuality: 非法档位被丢弃并回退默认', () => {
  const { pickQuality, QUALITY_DEFAULT } = qmod;
  for (const bad of ['', '320k', 'LOSSLESS', 'flac', 'null', 0, 320, {}, []]) {
    assert.equal(pickQuality({ netease: bad }, 'netease', 'hq'), 'hq');
  }
  for (const bad of ['', 'xxx', null, undefined, 42]) {
    assert.equal(pickQuality({}, 'netease', bad), QUALITY_DEFAULT);
  }
});

test('pickQuality: 档位键不区分大小写以外的字符串形式都算非法', () => {
  const { pickQuality } = qmod;
  assert.equal(pickQuality({ netease: '  hq  ' }, 'netease', 'standard'), 'standard');
});

test('QUALITY_OPTIONS 与 QUALITY_FIXED 契约', () => {
  const { QUALITY_OPTIONS, QUALITY_FIXED, QUALITY_DEFAULT } = qmod;
  const values = QUALITY_OPTIONS.map(o => o.value);
  assert.deepEqual(values, ['standard', 'hq', 'lossless']);
  assert.ok(values.includes(QUALITY_DEFAULT));
  // 服务端不区分音质的平台：清单里只有它们
  assert.deepEqual([...QUALITY_FIXED].sort(), ['migu', 'soda']);
  // 不支持音质的平台不应同时出现在「可覆盖」语义里
  for (const p of QUALITY_FIXED) assert.ok(!values.includes(p));
});

// ── prefs 白名单一致性 ──────────────────────────────────

const prefsMod = require('../src/main/ipc/prefs');
const cloudSyncMod = require('../src/main/ipc/cloudSync');
const { ALLOWED_PREF_KEYS } = prefsMod;
const { IMPORTABLE_PREF_KEYS } = cloudSyncMod;

/** 主进程内部维护的数据键：云同步单独收集/回写，不走 set-pref，故不必进白名单 */
const MAIN_INTERNAL_KEYS = new Set(['userPlaylists', 'activeDownloadTemplate']);

test('新增的分平台音质键已进入白名单', () => {
  assert.ok(ALLOWED_PREF_KEYS.has('qualityBySource'), 'qualityBySource 未加入 ALLOWED_PREF_KEYS');
  assert.ok(IMPORTABLE_PREF_KEYS.has('qualityBySource'), 'qualityBySource 未加入 IMPORTABLE_PREF_KEYS');
});

test('响度归一偏好键 convertLoudnorm 已进入双白名单（P0-B）', () => {
  assert.ok(ALLOWED_PREF_KEYS.has('convertLoudnorm'), 'convertLoudnorm 未加入 ALLOWED_PREF_KEYS');
  assert.ok(IMPORTABLE_PREF_KEYS.has('convertLoudnorm'), 'convertLoudnorm 未加入 IMPORTABLE_PREF_KEYS');
});

test('云同步可导入键 ⊆ prefs 白名单 ∪ 主进程内部键（防静默拒绝）', () => {
  const missing = [];
  for (const key of IMPORTABLE_PREF_KEYS) {
    if (!ALLOWED_PREF_KEYS.has(key) && !MAIN_INTERNAL_KEYS.has(key)) missing.push(key);
  }
  assert.deepEqual(missing, [], '这些键能导入却过不了 set-pref 白名单，渲染层写入会被静默丢弃: ' + missing.join(', '));
});

const ALL_PLATFORMS = new Set(['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda']);

test('cleanQualityMap: 只保留「已知平台 + 合法档位」', () => {
  const { cleanQualityMap } = qmod;
  const dirty = {
    netease: 'lossless',   // 合法 → 保留
    qq: 'bogus',           // 档位非法 → 丢
    migu: '',              // 空值 → 丢
    _evil: 'hq',           // 未知平台 → 丢（防云同步导入注入）
    kugou: 320,            // 数值 → 丢
    kuwo: 'hq',            // 合法 → 保留
    ' qq ': 'hq',          // 平台 id 带空白 → 丢
  };
  assert.deepEqual(cleanQualityMap(dirty, ALL_PLATFORMS), { netease: 'lossless', kuwo: 'hq' });
});

test('cleanQualityMap: 非对象输入一律返回空表', () => {
  const { cleanQualityMap } = qmod;
  assert.deepEqual(cleanQualityMap(null, ALL_PLATFORMS), {});
  assert.deepEqual(cleanQualityMap(undefined, ALL_PLATFORMS), {});
  assert.deepEqual(cleanQualityMap('', ALL_PLATFORMS), {});
  assert.deepEqual(cleanQualityMap(['netease'], ALL_PLATFORMS), {});
  assert.deepEqual(cleanQualityMap(42, ALL_PLATFORMS), {});
});

test('清洗后的覆盖表：非法条目回退默认，合法条目生效', () => {
  const { cleanQualityMap, pickQuality } = qmod;
  const cleaned = cleanQualityMap(
    { netease: 'lossless', qq: 'bogus', _evil: 'hq' }, ALL_PLATFORMS);
  assert.equal(pickQuality(cleaned, 'netease', 'standard'), 'lossless');
  assert.equal(pickQuality(cleaned, 'qq', 'standard'), 'standard');
  assert.equal(pickQuality(cleaned, '_evil', 'hq'), 'hq');
});

test('saveQualityBySource: 清洗 + 落盘 + 拒绝时仍回写内存态', async () => {
  const { saveQualityBySource } = qmod;
  const seen = [];
  globalThis.api = {
    setPref: async (key, val) => { seen.push([key, val]); return true; },
  };
  globalThis.getState = () => undefined;
  globalThis.setState = () => {};
  const r = await saveQualityBySource({ netease: 'lossless', _evil: 'hq' });
  assert.deepEqual(r, { netease: 'lossless' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'qualityBySource');
  assert.deepEqual(seen[0][1], { netease: 'lossless' });
});

// ── 播放音质徽标标签 ─────────────────────────
test('playedQualityLabel: 三档短标签，未知/空值返回空串', () => {
  const { playedQualityLabel } = qmod;
  assert.equal(playedQualityLabel('standard'), '128k');
  assert.equal(playedQualityLabel('hq'), '320k');
  assert.equal(playedQualityLabel('lossless'), '无损');
  for (const bad of ['', null, undefined, 'flac', 'LOSSLESS', 320]) {
    assert.equal(playedQualityLabel(bad), '');
  }
});
