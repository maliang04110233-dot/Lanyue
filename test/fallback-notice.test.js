/**
 * 单元测试：renderer/js/fallbackNotice.js（换源提示统一）
 *
 * 钉三条口径：
 *   1. fresh 换源（matchedSong）与记忆命中（fromAltMemory）都有文案，
 *      记忆命中不再是零提示（该缺口是用户「怎么莫名其妙换成别家源」困惑之源）；
 *   2. 平台名走注入的 nameOf（生产端传 platformName，显示中文不是裸 id）；
 *   3. 本源直出/失败结果返回 null —— 正常播放绝不弹多余 toast。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFallbackNotice } from '../src/renderer/js/fallbackNotice.js';

const nameOf = (id) => ({ netease: '网易云', kuwo: '酷我', qq: 'QQ音乐' }[id] || id);

test('失败/空结果不提示', () => {
  assert.equal(buildFallbackNotice(null, 'netease', nameOf), null);
  assert.equal(buildFallbackNotice({ error: 'x', code: 'VIP_REQUIRED' }, 'netease', nameOf), null);
});

test('本源直出不提示（无 matchedSong 无 fromAltMemory）', () => {
  assert.equal(buildFallbackNotice({ url: 'u', source: 'netease' }, 'netease', nameOf), null);
});

test('fresh 换源：文案含双方平台中文名与原源错误语义', () => {
  const t = buildFallbackNotice(
    { url: 'u', source: 'kuwo', matchedFrom: 'netease', matchedSong: { source: 'kuwo', id: '9' } },
    'netease', nameOf,
  );
  assert.equal(t, '🎵 网易云源不可用，已切换到酷我音源');
});

test('记忆命中：🔁 文案（此前零提示的缺口）', () => {
  const t = buildFallbackNotice(
    { url: 'u', source: 'kuwo', matchedFrom: 'netease', fromAltMemory: true },
    'netease', nameOf,
  );
  assert.match(t, /^🔁 沿用上次的换源结果，正在播放酷我音源/);
  assert.ok(t.includes('网易云'), '应带原源名解释为何不是原平台');
});

test('matchedFrom 缺失时回落 ownSource（防御归一化字段不全）', () => {
  const t = buildFallbackNotice(
    { url: 'u', matchedSong: { source: 'kuwo', id: '9' } }, 'netease', nameOf,
  );
  assert.equal(t, '🎵 网易云源不可用，已切换到酷我音源');
});

test('记忆命中但源没变（异常数据）不提示', () => {
  assert.equal(
    buildFallbackNotice({ url: 'u', source: 'netease', fromAltMemory: true }, 'netease', nameOf),
    null,
  );
});

test('nameOf 缺省时走全局 platformName，都没有则原样 id（node 环境可测）', () => {
  const prev = globalThis.platformName;
  globalThis.platformName = (id) => `G:${id}`;
  try {
    const t = buildFallbackNotice(
      { url: 'u', matchedSong: { source: 'kuwo', id: '9' }, matchedFrom: 'netease' }, 'netease',
    );
    assert.ok(t.includes('G:kuwo'), '应优先用全局 platformName');
  } finally {
    globalThis.platformName = prev;
  }
});

test('接线钉：五处播放入口都改用 buildFallbackNotice，旧复制文案清零', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['player.js', 'app.js', 'views/search.js', 'views/playlist.js', 'views/home.js']) {
    const src = readFileSync(new URL(`../src/renderer/js/${f}`, import.meta.url), 'utf8');
    assert.ok(!src.includes('本源不可用，已切换到'), `${f} 仍残留手抄换源文案`);
    assert.ok(src.includes('buildFallbackNotice'), `${f} 未接共享文案`);
    // referer 口径统一：实际出流平台优先（记忆命中时 result.source 才是别家源）
    assert.ok(!src.includes('matchedSong?.source ||'), `${f} playSource 仍是旧口径`);
  }
});
