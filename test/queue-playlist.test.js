/**
 * queuePlaylist 单元测试：默认名格式 + 死代码退役静态钉
 * （判可持久/盖 addedAt 的行为测试在 queue-pl-sel.test.js，函数同一份）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '../src/renderer/js/app.js'), 'utf8');
const QP_JS = fs.readFileSync(path.join(__dirname, '../src/renderer/js/queuePlaylist.js'), 'utf8');
// 45838e3 起，用户反馈文案住在语言包里（源码只留键名），接线钉要两侧都看得见的东西才能钉稳
const ZH = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/renderer/js/lang/zh.json'), 'utf8'));

async function fresh() {
  return import(`../src/renderer/js/queuePlaylist.js?ck=${Math.random()}`);
}

test('queueToSongs 退役，76 整单存为改走 pickPlSavableRows 死行守卫', async () => {
  const mod = await fresh();
  assert.equal(mod.queueToSongs, undefined, '退役函数不再导出');
  assert.equal(typeof mod.pickPlSavableRows, 'function');
  assert.ok(!/\bqueueToSongs\s*\(/.test(APP_JS), 'app 里不留调用点');
  assert.ok(!/export function queueToSongs/.test(QP_JS), 'queuePlaylist 源码不再定义');
  assert.ok(APP_JS.includes("const songs = pickPlSavableRows(getState('playQueue') || []);"), '整单存为链收口到判形函数');
  // 这句空表提示搬进了语言包（英文界面才翻得出来）。判据跟着搬，源码与词典两侧都钉：
  // 只钉源码，词典能悄悄把话说回「队列为空」；只钉词典，源码能悄悄换成别的键。
  assert.ok(APP_JS.includes("showToast(t('toast.queueNotSavable'), 'warn', 2800)"),
    '整单存为的空表分支仍取 toast.queueNotSavable 键');
  assert.ok(ZH['toast.queueNotSavable'].includes('没有可保存的歌'),
    '空表提示说清「没有可保存的歌」而非「队列为空」');
});

test('defaultQueuePlaylistName：月/日/时/分补零，可注入 Date', async () => {
  const { defaultQueuePlaylistName } = await fresh();
  assert.equal(defaultQueuePlaylistName(new Date(2026, 8, 19, 9, 5)), '播放队列 · 09-19 09:05');
  assert.equal(defaultQueuePlaylistName(new Date(2026, 11, 1, 23, 59)), '播放队列 · 12-01 23:59');
});
