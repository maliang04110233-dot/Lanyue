/**
 * 下载完成自动补歌词存 .lrc（把死开关 autoLyric 做实）
 *
 * 观察 queue-updated 的新完成行：已有歌词（sidecar/嵌入）跳过，
 * 否则 get-lyrics 取词 write-local-lrc 落盘。全程复用现有通道。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/app.js'), 'utf8'
);
const HTML = fs.readFileSync(
  path.join(__dirname, '../src/renderer/index.html'), 'utf8'
);

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import('../src/renderer/js/autoLyricOnDone.js?tc=' + Math.random());
}

const ROW = (over) => ({
  status: 'done', id: 11, source: 'netease', title: 'T', artist: 'A',
  savePath: 'D:\\dl\\t.mp3', ...over,
});

function apiStub(save) {
  const calls = { lyric: 0, write: [], read: [] };
  global.api = {
    getPref: async () => (save.pref === undefined ? true : save.pref),
    readLocalLrc: async (p) => { calls.read.push(p); return save.exists ? { lrc: '已有' } : { lrc: '' }; },
    getLyrics: async () => { calls.lyric++; return { lrc: '[00:01.00]词\n' }; },
    writeLocalLrc: async (p, lrc) => { calls.write.push([p, lrc]); },
  };
  global.showToast = save.toast || (() => {});
  return calls;
}

test('pickLyricTargets：只挑未处理过的完成行，filePath/savePath 兜底，坏数据出空', async () => {
  const { pickLyricTargets } = await fresh();
  const seen = new Set();
  const got = pickLyricTargets([
    ROW({}),
    ROW({ id: 12, status: 'downloading' }),
    ROW({ id: 13, title: '' }),
    ROW({ id: 14, savePath: '', filePath: 'E:\\x\\e.mp3' }),
    ROW({ id: null }),
    null,
  ], seen);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].filePath, 'D:\\dl\\t.mp3');
  assert.strictEqual(got[1].id, 14);
  assert.strictEqual(pickLyricTargets([{ ...ROW({}) }], seen).length, 0, 'seen 去重');
  assert.deepStrictEqual(pickLyricTargets(null, seen), []);
  assert.deepStrictEqual(pickLyricTargets([ROW({ id: 99 })], null), []);
});

test('hasExistingLyric：trim 后非空才算已有；形状异常一律 false', async () => {
  const { hasExistingLyric } = await fresh();
  assert.strictEqual(hasExistingLyric({ lrc: ' x' }), true);
  assert.strictEqual(hasExistingLyric({ lrc: ' \n\t ' }), false);
  assert.strictEqual(hasExistingLyric({ lrc: null }), false);
  assert.strictEqual(hasExistingLyric(null), false);
  assert.strictEqual(hasExistingLyric({}), false);
});

test('开关开：无词行取词落盘，已有词行不触 getLyrics，重推 seen 去重，聚合播报', async () => {
  const mod = await fresh();
  const toasts = [];
  global.showToast = (m) => toasts.push(m);
  const calls = { lyricIds: [], write: [] };
  global.api = {
    getPref: async () => true,
    readLocalLrc: async (p) => (p === 'D:\\dl\\b.mp3' ? { lrc: '已有歌词' } : { lrc: '' }),
    getLyrics: async (id) => { calls.lyricIds.push(id); return { lrc: '[00:01.00]词\n' }; },
    writeLocalLrc: async (p, lrc) => { calls.write.push([p, lrc]); },
  };
  const rows = [ROW({}), ROW({ id: 22, savePath: 'D:\\dl\\b.mp3' })];
  await mod.autoLyricObserve(rows);
  assert.deepStrictEqual(calls.lyricIds, [11], '已有歌词的行不应取词');
  assert.strictEqual(calls.write.length, 1);
  assert.strictEqual(calls.write[0][0], 'D:\\dl\\t.mp3');
  assert.match(calls.write[0][1], /\[00:01/);
  await mod.autoLyricObserve(rows);
  assert.strictEqual(calls.write.length, 1, 'seen 去重：重推不重写');
  await new Promise((r) => setTimeout(r, 1400)); // 等防抖聚合 toast
  assert.strictEqual(toasts.length, 1);
  assert.match(toasts[0], /已自动保存 1 首歌词/);
});

test('开关行为 + 接线钉桩：pref=false 静默；app.js 订阅接线与设置页新文案落位', async () => {
  const mod = await fresh();
  const calls = apiStub({ pref: false });
  await mod.autoLyricObserve([ROW({})]);
  assert.strictEqual(calls.lyric, 0);
  assert.strictEqual(calls.write.length, 0);
  assert.strictEqual(calls.read.length, 0);

  assert.match(APP_JS, /import '\.\/autoLyricOnDone\.js';/);
  assert.match(APP_JS, /if \(typeof window\.autoLyricObserve === 'function'\) window\.autoLyricObserve\(queue\);/);
  assert.match(HTML, /下载完成后自动获取歌词存为同目录 \.lrc（已有歌词不覆盖）/);
});
