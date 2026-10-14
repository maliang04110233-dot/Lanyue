/**
 * 智能歌单主进程侧：范围取歌 → 一次出网 → 回真歌曲对象
 *
 * 钉住的都不是"能不能跑"，而是"跑歪了会不会被听见"：
 *   ① 生成**只读**。用户点「存为歌单」之前，prefs 里的 userPlaylists 一个字节都不许变 ——
 *      这一条要是漏了，AI 就成了未经同意的写操作，而它偏偏没走工具白名单，
 *      轨道二那套逐条确认闸门管不到它，只能由本文件自己守住；
 *   ② 范围参数不许把用户没有的歌带进来（不存在的歌单 id 要如实报错，不能退化成全库）；
 *   ③ 一次生成 = 一次出网。回合数不受控的话，一个坏提示能把 Key 的额度刷穿；
 *   ④ Key 缺失走 NO_KEY，且根本不出网。
 *
 * Electron 打桩套路同 test/ai-assistant-e2e.test.js：ipcMain 空转、
 * app.getPath 指向临时目录、safeStorage 必须可用（aiMusicApiKey 是 SECRET_KEY）。
 * ai-music 换假实现：这里要验的是接线与次数，不是厂商返回长什么样。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-el-'));
let CHAT_CALLS = [];
let CHAT_REPLY = '{"name":"夜跑","reason":"快","picks":[1]}';
let CHAT_THROWS = null;

const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: () => stubDir, getVersion: () => '1.0.0' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(s, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    };
  }
  // 只换智能歌单这一条出网口：助手那边仍走真的 ai-music，避免一 stub 起来就满盘皆假
  if (request.endsWith('api/ai-music') && parent && /smart-playlist/.test(parent.filename || '')) {
    return {
      assistantChat: async ({ messages, apiKey }) => {
        CHAT_CALLS.push({ messages, apiKey });
        if (CHAT_THROWS) throw new Error(CHAT_THROWS);
        return CHAT_REPLY;
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const register = require('../src/main/ipc/register');
const prefs = require('../src/utils/prefs');
require('../src/main/ipc/smart-playlist').register();

function handlerOf(ch) {
  const fn = register.getInvokeHandler(ch);
  if (!fn) throw new Error(`测试取不到 handler: ${ch}`);
  return (...args) => fn(null, ...args);
}
const generate = handlerOf('smart-playlist-generate');

const song = (n, source = 'kw') => ({ id: String(n), source, title: `歌${n}`, artist: `手${n}` });

function reset() {
  CHAT_CALLS = [];
  CHAT_THROWS = null;
  CHAT_REPLY = '{"name":"夜跑","reason":"快","picks":[1]}';
  prefs.set('aiMusicApiKey', 'test-key');
}

function setPlaylists(list) { prefs.set('userPlaylists', list); }

test('范围 library：取所有歌单的歌并去重，一次出网，回真歌曲对象', async () => {
  reset();
  setPlaylists([
    { id: 'favorites', name: '收藏', songs: [song(1), song(2)] },
    { id: 'pl_a', name: 'A', songs: [song(2), song(3)] }, // song(2) 两个歌单里都有
  ]);
  const r = await generate('随便', 'library');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, '夜跑');
  assert.deepStrictEqual(r.songs.map(s => s.id), ['1']);
  assert.strictEqual(CHAT_CALLS.length, 1, '一次生成只能出网一次');
  // 去重后的三首都在候选里（清单是喂给模型的全部世界）
  const userMsg = CHAT_CALLS[0].messages[1].content;
  assert.match(userMsg, /1\t歌1\t手1/);
  assert.match(userMsg, /2\t歌2\t手2/);
  assert.match(userMsg, /3\t歌3\t手3/);
});

test('范围 favorites：只看红心歌单，不把别的歌单塞给模型', async () => {
  reset();
  setPlaylists([
    { id: 'favorites', name: '收藏', songs: [song(1)] },
    { id: 'pl_a', name: 'A', songs: [song(9)] },
  ]);
  await generate('夜跑', 'favorites');
  const userMsg = CHAT_CALLS[0].messages[1].content;
  assert.match(userMsg, /歌1/);
  assert.ok(!/歌9/.test(userMsg), '收藏外的歌不该进候选');
});

test('范围 playlist:<id>：只取那一单；不存在的 id 如实报错，不退化成全库', async () => {
  reset();
  setPlaylists([
    { id: 'pl_a', name: 'A', songs: [song(1), song(2)] },
    { id: 'pl_b', name: 'B', songs: [song(8)] },
  ]);
  const ok = await generate('夜跑', 'playlist:pl_b');
  assert.strictEqual(ok.ok, true);
  assert.ok(!/歌1/.test(CHAT_CALLS[0].messages[1].content), 'A 单的歌不该出现在 B 单的候选里');

  CHAT_CALLS = [];
  const bad = await generate('夜跑', 'playlist:pl_missing');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error, 'PLAYLIST_NOT_FOUND');
  assert.strictEqual(CHAT_CALLS.length, 0, '范围都取不到，不该花钱');
});

test('生成是只读的：没点「存为歌单」之前 userPlaylists 不许变', async () => {
  reset();
  const before = [{ id: 'favorites', name: '收藏', songs: [song(1)] }, { id: 'pl_a', name: 'A', songs: [song(2)] }];
  setPlaylists(before);
  CHAT_REPLY = '{"name":"新单","reason":"","picks":[1,2]}';
  const r = await generate('随便', 'library');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, '新单');
  assert.deepStrictEqual(prefs.get('userPlaylists'), before, '生成阶段写库就是把未确认的改动落盘');
});

test('没配 Key：NO_KEY 且不出网', async () => {
  reset();
  prefs.set('aiMusicApiKey', '');
  setPlaylists([{ id: 'favorites', name: '收藏', songs: [song(1)] }]);
  const r = await generate('夜跑', 'library');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'NO_KEY');
  assert.strictEqual(CHAT_CALLS.length, 0);
});

test('曲库里一首能选的歌都没有：NO_CANDIDATES，也不出网', async () => {
  reset();
  setPlaylists([{ id: 'favorites', name: '收藏', songs: [] }]);
  const r = await generate('夜跑', 'library');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'NO_CANDIDATES');
  assert.strictEqual(CHAT_CALLS.length, 0);
});

test('空主题：EMPTY_PROMPT，不出网（点一下按钮不该先扣费再告诉用户没写主题）', async () => {
  reset();
  setPlaylists([{ id: 'favorites', name: '收藏', songs: [song(1)] }]);
  const r = await generate('   ', 'library');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'EMPTY_PROMPT');
  assert.strictEqual(CHAT_CALLS.length, 0);
});

test('出网异常收敛成 LLM_FAILED；模型没选出来是 NO_PICKS —— 令牌必须分得开', async () => {
  reset();
  setPlaylists([{ id: 'favorites', name: '收藏', songs: [song(1), song(2)] }]);
  CHAT_THROWS = 'socket hang up';
  assert.strictEqual((await generate('夜跑', 'library')).error, 'LLM_FAILED');

  CHAT_THROWS = null;
  CHAT_REPLY = '{"name":"","reason":"","picks":[]}';
  assert.strictEqual((await generate('夜跑', 'library')).error, 'NO_PICKS');
});

test('截断要如实回传：界面得告诉用户 AI 只看了一部分', async () => {
  reset();
  const many = Array.from({ length: 450 }, (_, i) => song(i + 1));
  setPlaylists([{ id: 'favorites', name: '收藏', songs: many }]);
  CHAT_REPLY = '{"name":"大单","reason":"","picks":[1]}';
  const r = await generate('随便', 'library');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.candidateCount, 400);
  assert.strictEqual(r.truncated, 50);
});

test('候选只带挑选要用的字段：整首歌的元数据没必要过一遍模型再回来', async () => {
  reset();
  setPlaylists([{ id: 'favorites', name: '收藏', songs: [{ ...song(1), coverBase64: 'x'.repeat(2000) }] }]);
  const r = await generate('随便', 'library');
  // 回来的就是原对象引用（存单时要完整字段），但喂给模型的清单里没有封面
  assert.strictEqual(r.songs[0].coverBase64.length, 2000);
  assert.ok(!CHAT_CALLS[0].messages[1].content.includes('xxxxx'));
});
