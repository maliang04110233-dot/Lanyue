/**
 * 品味解读（候选方向 2：口味画像）—— 服务纯函数 + 主进程行为（缓存/凭据/错误令牌）
 *
 * 单测不触网：chat 经 setTasteChat 注入，缓存目录经 setTasteStoreDir 注入临时目录，
 * playStats 经 setTasteStatsReader 注入。
 * 盯六条不变量：
 *   ① buildDigest 只产出聚合量，**绝不**把具体歌名端出去（隐私红线）；
 *   ② 同一份统计摘要第二次点不再出网（计费调用不因重复点击重复扣费）；
 *   ③ 没配 Key → NO_KEY（不发起任何出网）；
 *   ④ 没播放数据 → NO_PLAYDATA（不出网、也不该报 LLM 失败）；
 *   ⑤ 配置类令牌原样透传（用户要改的是配置页，不是重试）；
 *   ⑥ 回复裁剪到上限（坏回复不刷爆界面）。
 *
 * 隐私校验方式：把 buildDigest 的产物序列化，断言其中**不出现**任何测试歌名。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'src/api/services/tasteProfileService'));
const {
  getProfile, setTasteChat, setTasteStoreDir, setTasteKeyReader, setTasteStatsReader,
  signatureOf, clearTasteCache,
} = require(path.join(ROOT, 'src/main/ipc/tasteProfile'));
const { CHANNELS } = require(path.join(ROOT, 'src/shared/ipcContract'));

/** 一份有内容的播放统计（歌名刻意避开"可被断言"的常见词） */
function sampleStats() {
  return {
    totalPlayTime: 7200,
    totalSongs: 12,
    playCount: {
      '秘密曲目A|||周杰伦': 30,
      '秘密曲目B|||周杰伦': 25,
      '秘密曲目C|||林俊杰': 18,
      '秘密曲目D|||孙燕姿': 10,
      '秘密曲目E|||陈奕迅': 6,
    },
    lastPlayed: { title: '秘密曲目B', artist: '周杰伦', time: Date.now() },
    daily: {
      '2026-10-01': 1200, '2026-10-02': 800, '2026-10-05': 1500,
      '2026-10-07': 600, '2026-10-10': 2100,
    },
  };
}

function freshTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tasteprofile-'));
}

// 用例隔离：每个用例清掉内存缓存与注入的读取器，避免上一用例的缓存/Key 泄漏
test.beforeEach(() => {
  clearTasteCache();
  setTasteKeyReader(null);
  setTasteStatsReader(null);
  setTasteChat(null);
});

// ── ① 服务纯函数 ────────────────────────────────────────

test('buildDigest：产出聚合量，绝不带出具体歌名（隐私红线）', () => {
  const { digest } = SERVICE.buildDigest(sampleStats());
  const blob = JSON.stringify(digest);
  assert.ok(!blob.includes('秘密曲目'), '摘要里泄漏了具体歌名');
  assert.equal(digest.distinctSongs, 5);
  assert.equal(digest.totalPlays, 89);
  assert.equal(digest.distinctArtists, 4);
  assert.equal(digest.totalPlayTimeSec, 7200);
  assert.equal(digest.mostRepeatedArtist, '周杰伦');
  assert.equal(digest.lastPlayedArtist, '周杰伦');
  assert.ok(digest.topArtists.length > 0 && digest.topArtists[0].artist === '周杰伦');
  assert.ok(Array.isArray(digest.slots), '应有周内作息分布');
  assert.equal(digest.activeDays, 5);
});

test('buildDigest：无播放数据 → NO_PLAYDATA，不产出摘要', () => {
  const r = SERVICE.buildDigest({ playCount: {}, totalSongs: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_PLAYDATA');
});

test('digestToText：摘要文本不含歌名，且带歌手聚合与作息', () => {
  const { digest } = SERVICE.buildDigest(sampleStats());
  const text = SERVICE.digestToText({ ok: true, digest });
  assert.ok(!text.includes('秘密曲目'), '出网文本泄漏了歌名');
  assert.ok(text.includes('周杰伦'), '歌手聚合应出现');
  assert.ok(text.includes('累计播放时长'), '时长段缺失');
});

test('buildProfileMessages：系统提示带隐私与不编造两条红线；输出语言按界面语言', () => {
  const { digest } = SERVICE.buildDigest(sampleStats());
  const msgs = SERVICE.buildProfileMessages({ digest, lang: 'zh' });
  assert.equal(msgs.length, 2);
  assert.ok(msgs[0].content.includes('不许推测'), '系统提示缺「不推测具体曲目」红线');
  assert.ok(msgs[0].content.includes('不许自己发明'), '系统提示缺「不发明数字」红线');
  assert.ok(msgs[1].content.includes('简体中文'), '输出语言措辞缺失');
  const en = SERVICE.buildProfileMessages({ digest, lang: 'en' });
  assert.ok(en[1].content.includes('English'), '英文界面应要求英文回答');
});

test('extractProfileText：裁剪到上限，空回复归空串', () => {
  assert.equal(SERVICE.extractProfileText('  hello  '), 'hello');
  assert.equal(SERVICE.extractProfileText(null), '');
  assert.equal(SERVICE.extractProfileText('a'.repeat(5000)).length, SERVICE.MAX_REPORT_CHARS);
});

// ── 契约 ────────────────────────────────────────────────

test('契约：get-taste-profile 已登记为 invoke 通道', () => {
  const e = CHANNELS['get-taste-profile'];
  assert.ok(e, '契约缺 get-taste-profile 通道');
  assert.ok((e.invoke || []).length > 0, 'get-taste-profile 未声明 invoke 方向');
});

// ── 主进程行为 ──────────────────────────────────────────

test('getProfile：同一份统计第二次点不再出网（缓存命中）', async () => {
  setTasteStoreDir(freshTmp());
  setTasteKeyReader(() => 'test-key');
  setTasteStatsReader(() => sampleStats());
  let calls = 0;
  setTasteChat(async () => { calls += 1; return '  你的画像。  '; });

  const first = await getProfile({ lang: 'zh' });
  assert.equal(first.ok, true);
  assert.equal(first.profile, '你的画像。', '回复未裁剪首尾空白');
  const second = await getProfile({ lang: 'zh' });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true, '第二次点应标记为缓存命中');
  assert.equal(calls, 1, '同一份统计第二次点又出网了 —— 计费会重复扣费');
});

test('getProfile：签名只含聚合量，不含歌名字符', () => {
  const { digest } = SERVICE.buildDigest(sampleStats());
  const sig = signatureOf(digest);
  assert.ok(!sig.includes('周'), '签名不能携带歌手名');
  assert.ok(!sig.includes('杰伦'), '签名不能携带歌手名');
  assert.equal(typeof sig, 'string');
  // 次数变了但歌手没变 → 签名变（聚合量参与），但歌手名不参与
  const mutated = SERVICE.buildDigest({ ...sampleStats(), playCount: { ...sampleStats().playCount, '秘密曲目A|||周杰伦': 31 } });
  assert.notEqual(signatureOf(mutated.digest), sig, '次数变化应换签名');
});

test('getProfile：没配 Key → NO_KEY，且不发起任何出网', async () => {
  setTasteStoreDir(freshTmp());
  setTasteKeyReader(null);
  setTasteStatsReader(() => sampleStats());
  let calls = 0;
  setTasteChat(async () => { calls += 1; return 'x'; });
  const r = await getProfile({ lang: 'zh' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_KEY');
  assert.equal(calls, 0, '没配 Key 却发起了出网');
});

test('getProfile：没播放数据 → NO_PLAYDATA，不出网', async () => {
  setTasteStoreDir(freshTmp());
  setTasteKeyReader(() => 'test-key');
  setTasteStatsReader(() => ({ playCount: {}, totalSongs: 0 }));
  let calls = 0;
  setTasteChat(async () => { calls += 1; return 'x'; });
  const r = await getProfile({ lang: 'zh' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_PLAYDATA');
  assert.equal(calls, 0, '没数据却发起了出网');
});

test('getProfile：配置类令牌原样透传，其它失败归 LLM_FAILED', async () => {
  setTasteStoreDir(freshTmp());
  setTasteKeyReader(() => 'test-key');
  setTasteStatsReader(() => sampleStats());
  setTasteChat(async () => { throw new Error('ENDPOINT_BLOCKED'); });
  const blocked = await getProfile({ lang: 'zh' });
  assert.equal(blocked.error, 'ENDPOINT_BLOCKED', '配置类令牌被压成 LLM_FAILED 就读不出该改配置');

  setTasteChat(async () => { throw new Error('socket hang up'); });
  const net = await getProfile({ lang: 'zh' });
  assert.equal(net.error, 'LLM_FAILED', '网络失败未归 LLM_FAILED');
});

test('getProfile：回复裁剪到上限，空回复判 EMPTY_REPLY', async () => {
  setTasteStoreDir(freshTmp());
  setTasteKeyReader(() => 'test-key');
  setTasteStatsReader(() => sampleStats());
  setTasteChat(async () => 'x'.repeat(6000));
  const long = await getProfile({ lang: 'zh' });
  assert.equal(long.ok, true);
  assert.equal(long.profile.length, SERVICE.MAX_REPORT_CHARS, '回复未裁剪到上限');

  // 上一步已把该签名写进缓存，先清掉再验证空回复分支
  clearTasteCache();
  setTasteChat(async () => '   ');
  const empty = await getProfile({ lang: 'zh' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'EMPTY_REPLY');
});