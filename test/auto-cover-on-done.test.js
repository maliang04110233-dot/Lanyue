/**
 * 下载完成自动嵌封面（把死开关 autoCover 做实）
 *
 * 观察 queue-updated 的新完成行：read-local-metadata 探测文件已有封面则跳过
 * （零盲写），否则 fetch-online-cover 取 data URL → update-id3-cover 嵌入。
 * 全程复用现有通道，零新 IPC。
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
  return import('../src/renderer/js/autoCoverOnDone.js?tc=' + Math.random());
}

const ROW = (over) => ({
  status: 'done', id: 11, source: 'netease', title: 'T', artist: 'A',
  savePath: 'D:\\dl\\t.mp3', ...over,
});

test('pickCoverTargets：只挑未处理过的完成行，filePath/savePath 兜底，坏数据出空', async () => {
  const { pickCoverTargets } = await fresh();
  const seen = new Set();
  const got = pickCoverTargets([
    ROW({}),
    ROW({ id: 12, status: 'downloading' }),
    ROW({ id: 13, title: '' }),
    ROW({ id: 14, savePath: '', filePath: 'E:\\x\\e.mp3' }),
    ROW({ id: null }),
    null,
  ], seen);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].filePath, 'D:\\dl\\t.mp3');
  assert.strictEqual(got[0].artist, 'A');
  assert.strictEqual(got[1].id, 14);
  assert.strictEqual(pickCoverTargets([ROW({})], seen).length, 0, 'seen 去重');
  assert.deepStrictEqual(pickCoverTargets(null, seen), []);
  assert.deepStrictEqual(pickCoverTargets([ROW({ id: 99 })], null), []);
});

test('hasExistingCover / coverFromFetch：trim 后非空才算有；形状异常一律无', async () => {
  const { hasExistingCover, coverFromFetch } = await fresh();
  assert.strictEqual(hasExistingCover({ coverBase64: ' data:image/jpeg;base64,AA' }), true);
  assert.strictEqual(hasExistingCover({ coverBase64: ' \n\t ' }), false);
  assert.strictEqual(hasExistingCover({ coverBase64: null }), false);
  assert.strictEqual(hasExistingCover({ error: '路径不可访问' }), false);
  assert.strictEqual(hasExistingCover(null), false);
  assert.strictEqual(coverFromFetch({ success: true, coverBase64: 'data:image/png;base64,BB' }),
    'data:image/png;base64,BB');
  assert.strictEqual(coverFromFetch({ success: false, error: '未找到' }), null);
  assert.strictEqual(coverFromFetch({ success: true, coverBase64: '  ' }), null);
  assert.strictEqual(coverFromFetch(null), null);
});

test('开关开：无封面行探测→在线取→嵌入，已有封面行不触在线 fetch，重推 seen 去重，聚合播报', async () => {
  const mod = await fresh();
  const toasts = [];
  global.showToast = (m) => toasts.push(m);
  const calls = { fetch: [], embed: [], read: [] };
  global.api = {
    getPref: async () => true,
    readLocalMetadata: async (p) => {
      calls.read.push(p);
      return p === 'D:\\dl\\b.mp3' ? { coverBase64: 'data:image/jpeg;base64,OLD' } : { coverBase64: null };
    },
    fetchOnlineCover: async (title, artist) => {
      calls.fetch.push([title, artist]);
      return { success: true, coverBase64: 'data:image/png;base64,NEW' };
    },
    updateId3Cover: async (p, dataUrl) => {
      calls.embed.push([p, dataUrl]);
      return { success: true };
    },
  };
  const rows = [ROW({}), ROW({ id: 22, savePath: 'D:\\dl\\b.mp3' })];
  await mod.autoCoverObserve(rows);
  assert.strictEqual(calls.read.length, 2, '两行都要先探测');
  assert.deepStrictEqual(calls.fetch, [['T', 'A']], '已有封面的行不应在线取图');
  assert.strictEqual(calls.embed.length, 1);
  assert.strictEqual(calls.embed[0][0], 'D:\\dl\\t.mp3');
  assert.strictEqual(calls.embed[0][1], 'data:image/png;base64,NEW', '传的是 data URL 整串');
  await mod.autoCoverObserve(rows);
  assert.strictEqual(calls.embed.length, 1, 'seen 去重：重推不重嵌');
  await new Promise((r) => setTimeout(r, 1400)); // 等防抖聚合 toast
  assert.strictEqual(toasts.length, 1);
  assert.match(toasts[0], /已自动嵌入 1 张封面/);
});

test('开关行为 + 失败静默 + 接线钉桩：pref=false 全程零调用；取图失败不嵌；app.js 接线与设置页新文案落位', async () => {
  const mod = await fresh();
  const noop = [];
  global.showToast = (m) => noop.push(m);
  const calls = { read: 0, embed: 0 };
  global.api = {
    getPref: async () => false,
    readLocalMetadata: async () => { calls.read++; return {}; },
    fetchOnlineCover: async () => ({ success: false, error: '未找到匹配的封面' }),
    updateId3Cover: async () => { calls.embed++; return { success: true }; },
  };
  await mod.autoCoverObserve([ROW({})]);
  assert.strictEqual(calls.read, 0, 'pref=false：连探测都不做');
  assert.strictEqual(calls.embed, 0);

  // 取图失败分支单独一个新实例（_enabled 是模块级缓存，不能在同实例上翻开关）
  const mod2 = await fresh();
  global.api = {
    ...global.api,
    getPref: async () => true,
  };
  await mod2.autoCoverObserve([ROW({ id: 77, savePath: 'D:\\dl\\c.mp3' })]);
  assert.strictEqual(calls.read, 1, '取图链路失败也要先探测');
  assert.strictEqual(calls.embed, 0, '取图失败静默不嵌');

  assert.match(APP_JS, /import '\.\/autoCoverOnDone\.js';/);
  assert.match(APP_JS, /if \(typeof window\.autoCoverObserve === 'function'\) window\.autoCoverObserve\(queue\);/);
  assert.match(HTML, /下载完成后自动获取封面嵌入音频文件（已有封面不覆盖）/);
  // 语言包同步（曾漏改词典，切语言会把旧文案盖回来）
  const ZH = fs.readFileSync(path.join(__dirname, '../src/renderer/js/lang/zh.json'), 'utf8');
  assert.match(ZH, /"settings\.general\.autoLyric": "下载完成后自动获取歌词存为同目录 \.lrc（已有歌词不覆盖）"/);
  assert.match(ZH, /"settings\.general\.autoCover": "下载完成后自动获取封面嵌入音频文件（已有封面不覆盖）"/);
});
