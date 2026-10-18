/**
 * 单元测试：renderer/js/sourceError.js（音源失败原因 → 具体文案）
 *
 * 钉四条口径：
 *   1. 每种可识别错误码都映射到**具体** i18n 键，不再是笼统的 toast.noSource；
 *   2. 汽水平台走专属文案（会员/试听限制是它的高发原因）；
 *   3. AUTH_EXPIRED / COOKIE_INVALID 走 diagnose.js 的 isAuthFailure 判定（failure-tag 家法），
 *      字面量不进本文件；
 *   4. 未知错误码回落 fallbackKey（保持原兜底行为，不吞错）；
 *   5. isLowYield 只标记已知低命中平台，且不误伤主平台。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sourceErrorKey, sourceErrorText, isLowYield, LOW_YIELD_PLATFORMS, SOURCE_ERROR_CODES } from '../src/renderer/js/sourceError.js';
import errors from '../src/shared/errors.js';

const t = (key) => `{${key}}`;

test('每种可识别错误码都映射到具体键（不再是笼统 noSource）', () => {
  const cases = [
    ['VIP_REQUIRED', 'toast.vipRequired'],
    ['NO_AUDIO_STREAM', 'toast.srcNoStream'],
    ['CDN_EMPTY', 'toast.srcCdnEmpty'],
    ['UNAVAILABLE', 'toast.srcUnavailable'],
    ['COPYRIGHT_RESTRICTED', 'toast.srcCopyright'],
    ['LOGIN_REQUIRED', 'toast.srcLogin'],
  ];
  for (const [code, expected] of cases) {
    assert.equal(sourceErrorKey({ code }, 'netease'), expected, `${code} 应映射到 ${expected}`);
  }
});

test('AUTH_EXPIRED / COOKIE_INVALID 走 isAuthFailure 兜底（不写字面量）', () => {
  assert.equal(sourceErrorKey({ code: 'AUTH_EXPIRED' }, 'netease'), 'toast.srcCookie');
  assert.equal(sourceErrorKey({ code: 'COOKIE_INVALID' }, 'netease'), 'toast.srcCookie');
});

test('兼容服务层形态 { ok:false, error:{code} }', () => {
  assert.equal(
    sourceErrorKey({ ok: false, error: { code: 'CDN_EMPTY' } }, 'netease'),
    'toast.srcCdnEmpty',
  );
});

test('汽水专属：VIP/试听走汽水文案，其它平台回落通用', () => {
  assert.equal(sourceErrorKey({ code: 'VIP_REQUIRED' }, 'soda'), 'toast.srcVipSoda');
  assert.equal(sourceErrorKey({ code: 'VIP_REQUIRED' }, { source: 'soda' }), 'toast.srcVipSoda');
  assert.equal(sourceErrorKey({ code: 'NO_AUDIO_STREAM' }, 'soda'), 'toast.srcOnlySoda');
  // 非汽水平台照旧
  assert.equal(sourceErrorKey({ code: 'VIP_REQUIRED' }, 'netease'), 'toast.vipRequired');
  assert.equal(sourceErrorKey({ code: 'NO_AUDIO_STREAM' }, 'kugou'), 'toast.srcNoStream');
});

test('未知错误码回落 fallbackKey（不吞错）', () => {
  assert.equal(sourceErrorKey({ code: 'SOMETHING_NEW' }, 'netease'), null);
  assert.equal(sourceErrorText(t, { code: 'SOMETHING_NEW' }, 'netease', 'toast.noSource'), '{toast.noSource}');
});

test('sourceErrorText 走 t() 并回落 fallbackKey', () => {
  assert.equal(sourceErrorText(t, { code: 'CDN_EMPTY' }, 'netease'), '{toast.srcCdnEmpty}');
  assert.equal(sourceErrorText(t, { code: 'VIP_REQUIRED' }, 'soda'), '{toast.srcVipSoda}');
  assert.equal(sourceErrorText(t, null, 'netease', 'toast.noSource'), '{toast.noSource}');
  assert.equal(sourceErrorText(t, { code: 'X' }, 'netease', 'toast.noSource'), '{toast.noSource}');
});

test('isLowYield 只标记已知低命中平台', () => {
  assert.equal(isLowYield('soda'), true);
  assert.equal(isLowYield('kugou'), true);
  assert.equal(isLowYield('kuwo'), true);
  assert.equal(isLowYield({ source: 'soda' }), true);
  assert.equal(isLowYield('netease'), false);
  assert.equal(isLowYield('qq'), false);
  assert.equal(isLowYield(null), false);
  assert.ok(LOW_YIELD_PLATFORMS.size > 0, '清单不应为空');
});

test('sidecar 字面量错误码都合法（取值在 src/shared/errors.js 中）', () => {
  const ERROR_CODES = errors.ERROR_CODES;
  const sharedValues = new Set(Object.values(ERROR_CODES));
  for (const code of SOURCE_ERROR_CODES) {
    assert.ok(sharedValues.has(code), `${code} 不在 shared/errors.js 的 ERROR_CODES 取值中`);
  }
});

test('failure-tag 家法：AUTH_EXPIRED 与 LOGIN_REQUIRED 不同时出现在 sourceError.js', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src/renderer/js/sourceError.js'), 'utf8');
  const hasAuthExpired = /AUTH_EXPIRED/.test(src);
  const hasLoginRequired = /LOGIN_REQUIRED/.test(src);
  assert.ok(!(hasAuthExpired && hasLoginRequired),
    'sourceError.js 不应同时含 AUTH_EXPIRED 与 LOGIN_REQUIRED 字面量（failure-tag 家法）');
});
// ── 接线钉子：五处取流播放入口都要走这份集中映射 ──────────────
const ROOT = process.cwd();
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

const PLAY_ENTRIES = [
  'src/renderer/js/player.js',                    // 播放器主链
  'src/renderer/js/views/search.js',              // 搜索结果双击
  'src/renderer/js/views/home.js',                // 首页推荐
  'src/renderer/js/views/playlist/playback.js',   // 歌单详情
  'src/renderer/js/app.js',                       // 播放弹层
];

test('五处取流播放入口都接了 sourceErrorText，且不再自写 VIP 分支', () => {
  for (const rel of PLAY_ENTRIES) {
    const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.ok(/sourceErrorText\(/.test(src), `${rel} 没接 sourceErrorText —— 失败原因会退回笼统文案`);
    assert.ok(!/'VIP_REQUIRED'/.test(src), `${rel} 仍在自写 VIP_REQUIRED 判定：码表只许 sourceError.js 一处`);
  }
});
