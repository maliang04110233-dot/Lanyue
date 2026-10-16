/**
 * 歌曲讲解（候选方向 1）—— 服务纯函数 + 主进程行为（缓存/凭据/错误令牌）
 *
 * 单测不触网：chat 经 setStoryChat 注入，缓存目录经 setStoryStoreDir 注入临时目录。
 * 盯四条不变量：
 *   ① 同一首歌第二次点不再出网（计费调用不因重复点击重复扣费）；
 *   ② 没配 Key → NO_KEY（不发起任何出网）；
 *   ③ 配置类令牌原样透传（用户要改的是配置页，不是重试）；
 *   ④ 回复裁剪到上限（坏回复不刷爆界面）。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SERVICE = require(path.join(ROOT, 'src/api/services/songStoryService'));
const { getStory, setStoryChat, setStoryStoreDir, setStoryKeyReader, cacheKey } = require(path.join(ROOT, 'src/main/ipc/songStory'));
const { CHANNELS } = require(path.join(ROOT, 'src/shared/ipcContract'));

// ── 服务纯函数 ──────────────────────────────────────────

test('buildStoryMessages：提示带歌名与歌手，输出语言按界面语言', () => {
  const msgs = SERVICE.buildStoryMessages({ title: '晴天', artist: '周杰伦', lang: 'zh' });
  assert.equal(msgs.length, 2);
  assert.ok(msgs[1].content.includes('晴天'), '用户请求缺歌名');
  assert.ok(msgs[1].content.includes('周杰伦'), '用户请求缺歌手');
  assert.ok(msgs[1].content.includes('简体中文'), '输出语言措辞缺失');
  const en = SERVICE.buildStoryMessages({ title: '晴天', artist: '', lang: 'en' });
  assert.ok(en[1].content.includes('English'), '英文界面应要求英文回答');
  // 红线：系统提示里必须有不编造不确定事实的约束
  assert.ok(msgs[0].content.includes('不写'), '系统提示缺「不确定的事实不写」红线');
});

test('extractStoryText：裁剪到上限，空回复归空串', () => {
  assert.equal(SERVICE.extractStoryText('  hello  '), 'hello');
  assert.equal(SERVICE.extractStoryText(null), '');
  assert.equal(SERVICE.extractStoryText('a'.repeat(3000)).length, SERVICE.MAX_STORY_CHARS);
});

// ── 契约 ────────────────────────────────────────────────

test('契约：get-song-story 已登记为 invoke 通道', () => {
  const e = CHANNELS['get-song-story'];
  assert.ok(e, '契约缺 get-song-story 通道');
  assert.ok((e.invoke || []).length > 0, 'get-song-story 未声明 invoke 方向');
});

// ── 主进程行为 ──────────────────────────────────────────

test('getStory：同一首歌第二次点不再出网（缓存命中）', async () => {
  setStoryStoreDir(fs.mkdtempSync(path.join(os.tmpdir(), 'songstory-')));
  setStoryKeyReader(() => 'test-key');
  let calls = 0;
  setStoryChat(async () => { calls += 1; return '  这是讲解正文。  '; });
  const first = await getStory({ title: '晴天', artist: '周杰伦', lang: 'zh' });
  assert.equal(first.ok, true);
  assert.equal(first.story, '这是讲解正文。', '回复未裁剪首尾空白');
  const second = await getStory({ title: '晴天', artist: '周杰伦', lang: 'zh' });
  assert.equal(second.ok, true);
  assert.equal(second.cached, true, '第二次点应标记为缓存命中');
  assert.equal(calls, 1, '同一首歌第二次点又出网了 —— 计费会重复扣费');
});

test('getStory：没配 Key → NO_KEY，且不发起任何出网', async () => {
  setStoryStoreDir(fs.mkdtempSync(path.join(os.tmpdir(), 'songstory-')));
  // 模块状态跨用例持久：先清掉前一用例注入的凭据读取器
  setStoryKeyReader(null);
  let calls = 0;
  setStoryChat(async () => { calls += 1; return 'x'; });
  const r = await getStory({ title: '没配Key的歌', artist: '', lang: 'zh' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'NO_KEY');
  assert.equal(calls, 0, '没配 Key 却发起了出网');
});

test('getStory：配置类令牌原样透传，其它失败归 LLM_FAILED', async () => {
  setStoryStoreDir(fs.mkdtempSync(path.join(os.tmpdir(), 'songstory-')));
  setStoryKeyReader(() => 'test-key');
  setStoryChat(async () => { throw new Error('ENDPOINT_BLOCKED'); });
  const blocked = await getStory({ title: 'A歌', artist: '', lang: 'zh' });
  assert.equal(blocked.error, 'ENDPOINT_BLOCKED', '配置类令牌被压成 LLM_FAILED 就读不出该改配置');

  setStoryChat(async () => { throw new Error('socket hang up'); });
  const net = await getStory({ title: 'B歌', artist: '', lang: 'zh' });
  assert.equal(net.error, 'LLM_FAILED', '网络失败未归 LLM_FAILED');
});

test('getStory：回复裁剪到上限，空回复判 EMPTY_REPLY', async () => {
  setStoryStoreDir(fs.mkdtempSync(path.join(os.tmpdir(), 'songstory-')));
  setStoryKeyReader(() => 'test-key');
  setStoryChat(async () => 'x'.repeat(5000));
  const long = await getStory({ title: '长回复', artist: '', lang: 'zh' });
  assert.equal(long.ok, true);
  assert.equal(long.story.length, SERVICE.MAX_STORY_CHARS, '回复未裁剪到上限');

  setStoryChat(async () => '   ');
  const empty = await getStory({ title: '空回复', artist: '', lang: 'zh' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'EMPTY_REPLY');
});

test('cacheKey：同歌不同语言是不同键', () => {
  assert.notEqual(
    cacheKey({ title: '晴天', artist: '周杰伦', lang: 'zh' }),
    cacheKey({ title: '晴天', artist: '周杰伦', lang: 'en' }),
    '切换语言后应重新生成对应语言的讲解');
});
