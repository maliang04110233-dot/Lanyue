/**
 * 接线钉：记忆播放进度默认**关闭**，并做一次从旧默认 true → false 的迁移。
 *
 * 背景（2026-10-16 用户反馈「还是从中间开始播放」）：
 *   播放页弹「从 1:05 继续播放」是记忆播放进度的**预期行为**——上次把同一首歌
 *   听到 1:05 后暂停/切走，进度被存进 playProgressMap，这次重播就从断点继续。
 *   设置默认值原为 true，用户并未主动开启却被默认开启，导致「重播想从头听」
 *   的诉求被续播功能拦截。
 *
 * 用户决策：关闭记忆播放进度（重播一律从头）。本文件钉住四条：
 *   1. GENERAL_PREFS 里 playProgressMemory 的 default 是 **false**（不是 true）；
 *   2. index.html 的 checkbox 不再写静态 checked（默认态由 loadGeneralSettings
 *      用偏好值/默认值动态设置，静态 checked 会误导阅读者以为默认是开）；
 *   3. app.js 的 init() 里有一次性迁移：偏好值非 false（true 旧默认，或从未写过的
*      undefined）→ 写 false，且用 playProgressMemoryMigrated 标记，只跑一次，
*      用户后续手动开启不被覆盖。
 *   4. player.js（读取端）与 progressStore.js（写入端）都用 falsy 判定
 *      （`!enabled`），而不是 `=== false`——否则 getPref 返回 undefined
 *      （用户从没改过该项、prefs.json 里没有该键）时，`undefined === false`
 *      为 false，会漏过判定继续续播/继续存进度，等于默认关闭根本没生效。
 *
 * 用静态断言（readFileSync + includes），与 test/prefs-key-reconciliation.test.js
 * 同一套路：general.js / app.js 顶层依赖 DOM 与 api，node 下 import 不可行。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const GENERAL = read('src/renderer/js/views/settings/general.js');
const HTML = read('src/renderer/index.html');
const PLAYER = read('src/renderer/js/player.js');
const STORE = read('src/renderer/js/player/progressStore.js');

test('记忆播放进度默认关闭：GENERAL_PREFS 里 default 是 false', () => {
  const line = GENERAL.match(/playProgressMemory:\s*\{[^}]+\}/);
  assert.ok(line, 'general.js 缺 playProgressMemory 条目');
  assert.match(line[0], /default:\s*false/, `默认应为 false，实得：${line[0]}`);
});

test('index.html 的 checkbox 不写死静态 checked（默认态由 JS 动态设置）', () => {
  const tag = HTML.match(/<input type="checkbox" id="settingPlayProgressMemory"[^>]*>/);
  assert.ok(tag, 'index.html 缺 settingPlayProgressMemory checkbox');
  assert.ok(!/\bchecked\b/.test(tag[0]),
    '静态 checked 会让源码读起来默认是开，且与 GENERAL_PREFS.default=false 打架');
});

test('启动路径有一次一次性迁移：偏好值非 false（true 或 undefined）都写成 false，且用迁移标记只跑一次', () => {
  // 迁移块自 app.js init() 提出，落在 boot-restore.js（restoreStartupPrefs）
  const BOOT = read('src/renderer/js/boot-restore.js');
  // 迁移必须存在
  assert.match(BOOT, /playProgressMemoryMigrated/, '缺迁移标记（playProgressMemoryMigrated）');
  assert.match(BOOT, /await\s+api\.setPref\(\s*ppmKey\s*,\s*false\s*\)/,
    '迁移必须把偏好写成 false');
  // 迁移条件：不是显式 false 就固化（覆盖 true 旧默认，以及从未写过的 undefined）
  assert.match(BOOT, /if\s*\(\s*cur\s*!==\s*false\s*\)\s*await\s+api\.setPref\(\s*ppmKey\s*,\s*false\s*\)/,
    '迁移必须是 cur !== false 才写 false——undefined（从未写过）也要固化为 false，让设置页 checkbox 正确显示关闭态');
  // 迁移要有守卫：只在从未迁移过时执行
  assert.match(BOOT, /if\s*\(!\s*\(\s*await\s+api\.getPref\(\s*ppmMigratedKey\s*\)\s*\)\s*\)/,
    '迁移必须只在未迁移过时执行一次');
  // 迁移要写标记，避免用户手动开启后被反复覆盖
  assert.match(BOOT, /await\s+api\.setPref\(\s*ppmMigratedKey\s*,\s*true\s*\)/,
    '迁移后要写迁移标记，否则每次启动都覆盖用户手动开启的选择');
});

test('读取/写入两端都用 falsy 判定：getPref 返回 undefined 也按关闭处理', () => {
  // 读取端（player.js restorePlayProgress）：undefined 必须走「从头」
  const readBranch = PLAYER.match(/const enabled = await api\.getPref\('playProgressMemory'\)[\s\S]{0,120}/);
  assert.ok(readBranch, 'player.js 缺 playProgressMemory 读取');
  assert.match(readBranch[0], /if\s*\(!\s*enabled\)\s*return 0/,
    `读取端必须用 falsy 判定（undefined/false/0 都从头），实得：${readBranch[0]}`);
  assert.ok(!/enabled\s*===\s*false/.test(readBranch[0]),
    '读取端不得用 === false——undefined 会漏过并续播，等于默认关闭没生效');
  // 写入端（progressStore.js）：undefined 必须不写进度
  const writeBranch = STORE.match(/const enabled = await getPref\('playProgressMemory'\)[\s\S]{0,120}/);
  assert.ok(writeBranch, 'progressStore.js 缺 playProgressMemory 读取');
  assert.match(writeBranch[0], /if\s*\(!\s*enabled\)\s*return/,
    `写入端必须用 falsy 判定（undefined 不写进度），实得：${writeBranch[0]}`);
  assert.ok(!/enabled\s*===\s*false/.test(writeBranch[0]),
    '写入端不得用 === false——undefined 会继续累积进度数据');
});
