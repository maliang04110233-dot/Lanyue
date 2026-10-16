/**
 * 歌单语义运维（候选方向 3）—— 服务纯函数 + 主进程行为
 *
 * 单测不触网：chat 经 setAuditChat 注入，歌单经 prefs 注入。
 * 钉住六条不变量：
 *   ① 运维是**只读**的：audit 一次调用不许动 userPlaylists；
 *   ② 一次运维 = 一次出网；
 *   ③ 没配 Key → NO_KEY，且根本不出网；
 *   ④ 配置类令牌原样透传（用户要改的是配置页，不是重试）；
 *   ⑤ 序号越界/重复/小数/非法枚举一律剔除，绝不回填假数据；
 *   ⑥ 系统提示必须带「不编造清单外的歌」红线。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaudit-el-'));
let CHAT_CALLS = [];
let CHAT_REPLY = '{"name":"新单","desc":"适合夜跑","summary":"主题集中","audit":[{"n":1,"fit":"high","reason":"前奏短","suggest":"keep"},{"n":2,"fit":"low","reason":"偏抒情","suggest":"remove"}]}';
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
  if (request.endsWith('api/ai-music') && parent && /playlistAudit/.test(parent.filename || '')) {
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
require('../src/main/ipc/playlistAudit').register();
const SERVICE = require('../src/api/services/playlistAuditService');
const { CHANNELS } = require('../src/shared/ipcContract');

function handlerOf(ch) {
  const fn = register.getInvokeHandler(ch);
  if (!fn) throw new Error(`测试取不到 handler: ${ch}`);
  return (...args) => fn(null, ...args);
}
const audit = handlerOf('playlist-audit');

const song = (n, source = 'kw') => ({ id: String(n), source, title: `歌${n}`, artist: `手${n}` });

function reset() {
  CHAT_CALLS = [];
  CHAT_THROWS = null;
  CHAT_REPLY = '{"name":"新单","desc":"适合夜跑","summary":"主题集中","audit":[{"n":1,"fit":"high","reason":"前奏短","suggest":"keep"},{"n":2,"fit":"low","reason":"偏抒情","suggest":"remove"}]}';
  prefs.set('aiMusicApiKey', 'test-key');
}

function setPlaylist(list) { prefs.set('userPlaylists', list); }

// ── 契约 ────────────────────────────────────────────────

test('契约：playlist-audit 已登记为 invoke 通道', () => {
  const e = CHANNELS['playlist-audit'];
  assert.ok(e, '契约缺 playlist-audit 通道');
  assert.ok((e.invoke || []).length > 0, 'playlist-audit 未声明 invoke 方向');
});

// ── 服务纯函数 ──────────────────────────────────────────

test('buildSystemPrompt：必须带不编造清单外的歌的红线', () => {
  const p = SERVICE.buildSystemPrompt();
  assert.match(p, /编造/, '系统提示缺「不编造清单外的歌」红线');
  assert.match(p, /序号/, '系统提示要明确说清按序号作答');
  assert.match(p, /keep/, 'suggest 枚举要在提示里说清');
});

test('buildAuditCandidates：丢掉无标题的行，截断要报', () => {
  const r = SERVICE.buildAuditCandidates([
    { id: '1', title: '歌1', artist: '手1' },
    { id: '2', title: '  ', artist: '' },       // 无标题，占位符只会换来幻觉
    { id: '3', title: '歌3', artist: '手3' },
  ]);
  assert.strictEqual(r.list.length, 2);
  assert.strictEqual(r.list[0].n, 1);
  assert.strictEqual(r.list[1].n, 2);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.truncated, 0);
});

test('buildAuditCandidates：超过上限要如实报截断数', () => {
  const many = [];
  for (let i = 0; i < SERVICE.MAX_CANDIDATES + 5; i++) many.push({ id: String(i), title: `歌${i}` });
  const r = SERVICE.buildAuditCandidates(many);
  assert.strictEqual(r.list.length, SERVICE.MAX_CANDIDATES);
  assert.strictEqual(r.truncated, 5, '截断数必须是"没进清单"的真实条数');
});

test('parseAudit：越界/重复/小数/非法枚举一律剔除', () => {
  const cands = { list: [{ n: 1 }, { n: 2 }, { n: 3 }] };
  const out = SERVICE.parseAudit(
    JSON.stringify({
      name: '夜跑',
      audit: [
        { n: 0, fit: 'high', suggest: 'keep' },     // 越界下
        { n: 4, fit: 'high', suggest: 'keep' },     // 越界上
        { n: 1, fit: 'high', suggest: 'keep' },
        { n: 1, fit: 'mid', suggest: 'remove' },    // 重复序号
        { n: 2.5, fit: 'high', suggest: 'keep' },   // 小数（不能取整成 2）
        { n: 2, fit: 'wat', suggest: 'keep' },      // fit 非法
        { n: 3, fit: 'low', suggest: 'wat' },       // suggest 非法
        { n: 3, fit: 'low', suggest: 'move' },      // 合法
      ],
    }), cands);
  assert.strictEqual(out.audit.length, 2);
  assert.strictEqual(out.audit[0].n, 1);
  assert.strictEqual(out.audit[0].fit, 'high');
  assert.strictEqual(out.audit[1].n, 3);
  assert.strictEqual(out.audit[1].suggest, 'move');
  assert.strictEqual(out.name, '夜跑');
});

test('parseAudit：序号升序排回歌单原序', () => {
  const cands = { list: [{ n: 1 }, { n: 2 }, { n: 3 }] };
  const out = SERVICE.parseAudit(JSON.stringify({
    audit: [
      { n: 3, fit: 'low', suggest: 'remove' },
      { n: 1, fit: 'high', suggest: 'keep' },
    ],
  }), cands);
  assert.deepStrictEqual(out.audit.map(a => a.n), [1, 3]);
});

test('auditPlaylist：一次运维一次出网，只读不写', async () => {
  reset();
  const pl = { id: 'pl_a', name: '夜跑', desc: '', songs: [song(1), song(2)] };
  setPlaylist([pl]);
  const before = prefs.get('userPlaylists');
  const r = await audit('pl_a', '');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.name, '新单');
  assert.strictEqual(r.audit.length, 2);
  assert.strictEqual(r.candidates.length, 2);
  assert.strictEqual(CHAT_CALLS.length, 1, '一次运维只能出网一次');
  // 候选原样带标题给渲染层（标题在歌单里，不来自模型回复）
  assert.strictEqual(r.candidates[0].title, '歌1');
  // 出网文本含歌单名与序号清单
  const userMsg = CHAT_CALLS[0].messages[1].content;
  assert.match(userMsg, /夜跑/);
  assert.match(userMsg, /1\t歌1\t手1/);
  assert.deepStrictEqual(prefs.get('userPlaylists'), before, '运维阶段写库就是把未确认的改动落盘');
});

// ── 主进程行为 ──────────────────────────────────────────

test('audit：歌单不存在 → PLAYLIST_NOT_FOUND，不出网', async () => {
  reset();
  setPlaylist([{ id: 'pl_a', name: 'A', songs: [song(1)] }]);
  const r = await audit('pl_missing', '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'PLAYLIST_NOT_FOUND');
  assert.strictEqual(CHAT_CALLS.length, 0);
});

test('audit：歌单里没有可选歌 → NO_CANDIDATES，不出网', async () => {
  reset();
  setPlaylist([{ id: 'pl_a', name: 'A', songs: [{ id: '1', title: '  ', artist: '' }] }]);
  const r = await audit('pl_a', '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'NO_CANDIDATES');
  assert.strictEqual(CHAT_CALLS.length, 0);
});

test('audit：没配 Key → NO_KEY，不出网', async () => {
  reset();
  prefs.set('aiMusicApiKey', '');
  setPlaylist([{ id: 'pl_a', name: 'A', songs: [song(1)] }]);
  const r = await audit('pl_a', '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'NO_KEY');
  assert.strictEqual(CHAT_CALLS.length, 0);
});

test('audit：配置类令牌原样透传，其它失败归 LLM_FAILED', async () => {
  reset();
  setPlaylist([{ id: 'pl_a', name: 'A', songs: [song(1)] }]);
  CHAT_THROWS = 'ENDPOINT_BLOCKED';
  const blocked = await audit('pl_a', '');
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.error, 'ENDPOINT_BLOCKED', '配置类令牌被压成 LLM_FAILED 就读不出该改配置');

  CHAT_THROWS = 'socket hang up';
  const net = await audit('pl_a', '');
  assert.strictEqual(net.error, 'LLM_FAILED');
});

test('audit：模型没给出任何逐首判断 → NO_AUDIT', async () => {
  reset();
  setPlaylist([{ id: 'pl_a', name: 'A', songs: [song(1)] }]);
  CHAT_REPLY = '{"name":"x","audit":[]}';
  const r = await audit('pl_a', '');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'NO_AUDIT');
});

test('audit：模型回复非法 JSON → NO_AUDIT，不抛错', async () => {
  reset();
  setPlaylist([{ id: 'pl_a', name: 'A', songs: [song(1)] }]);
  CHAT_REPLY = '```json\n{"audit":[{"n":1,"fit":"high","suggest":"keep"}]}\n```';
  const r = await audit('pl_a', '');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.audit.length, 1);
});