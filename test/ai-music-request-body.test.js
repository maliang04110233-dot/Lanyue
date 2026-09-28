/**
 * AI 创作的请求体对齐 MiniMax music_generation 真实 schema
 *
 * 查 2026-09 官方文档（platform.minimaxi.com / platform.minimax.cn，
 * api-reference/music-generation 的 GenerateMusicReq）证实：请求字段是
 *   model / prompt / lyrics / stream / output_format / audio_setting /
 *   aigc_watermark / lyrics_optimizer / is_instrumental /
 *   audio_url / audio_base64 / cover_feature_id
 * —— **其中没有 timbre**。而 src/api/ai-music.js 一直在发
 *   timbre: timbre || 'female'
 * 值来自视图层的 18 个真人歌手名，于是「选音色」这个控件从写下那天起
 * 就没进过上游的视野；同时接口本已有的纯音乐（is_instrumental）、
 * 换模型（music-3.0）、一句话直出（lyrics_optimizer）三项能力我们一个都没发。
 *
 * 本增量先把「到底发出去什么」收成一处纯函数，让它可以离线断言——
 * 计费接口不适合拿真 key 反复试，请求体正确性必须能在测试里成立。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildMusicRequestBody } = require('../src/api/ai-music');

const API_JS = path.join(__dirname, '../src/api/ai-music.js');
const VIEW_JS = path.join(__dirname, '../src/renderer/js/views/ai-music.js');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const OK = { apiKey: 'k-test', lyrics: '第一段歌词\n第二段歌词', musicPrompt: '抒情流行，钢琴铺底' };

test('器乐：发 is_instrumental，且不带 lyrics 键', () => {
  const body = buildMusicRequestBody({ apiKey: 'k-test', musicPrompt: '雨后钢琴独奏', instrumental: true });
  assert.equal(body.is_instrumental, true);
  assert.ok(!('lyrics' in body), '器乐请求不应带 lyrics');
});

test('器乐优先于一句话直出：只发 is_instrumental', () => {
  const body = buildMusicRequestBody({
    apiKey: 'k-test', musicPrompt: '雨后钢琴独奏', instrumental: true, autoLyrics: true,
  });
  assert.equal(body.is_instrumental, true);
  assert.ok(!('lyrics_optimizer' in body), '器乐时 lyrics_optimizer 无意义，不该一起发');
});

test('一句话直出：发 lyrics_optimizer，不带 lyrics', () => {
  const body = buildMusicRequestBody({ apiKey: 'k-test', musicPrompt: '写给夏天的民谣', autoLyrics: true });
  assert.equal(body.lyrics_optimizer, true);
  assert.ok(!('lyrics' in body));
  assert.ok(!('is_instrumental' in body));
});

test('任何情况下都不发 timbre（视图层塞什么都一样）', () => {
  for (const extra of [{}, { timbre: '周深' }, { timbre: 'female' }]) {
    const body = buildMusicRequestBody({ ...OK, ...extra });
    assert.ok(!('timbre' in body), `请求体仍含 timbre: ${JSON.stringify(body)}`);
  }
});

test('人声选择并进 prompt，而不是独立字段', () => {
  const male = buildMusicRequestBody({ ...OK, voice: 'male' });
  const female = buildMusicRequestBody({ ...OK, voice: 'female' });
  assert.ok(male.prompt.includes('男声'), male.prompt);
  assert.ok(!male.prompt.includes('女声主唱'), male.prompt);
  assert.ok(female.prompt.includes('女声主唱'), female.prompt);
  assert.ok(male.prompt.includes('抒情流行，钢琴铺底'), '基础描述不能被音色后缀挤掉');
});

test('器乐时不追加人声描述', () => {
  const body = buildMusicRequestBody({ apiKey: 'k-test', musicPrompt: '弦乐四重奏', instrumental: true, voice: 'male' });
  assert.ok(!/男声|女声|合唱/.test(body.prompt), body.prompt);
});

test('model 只认白名单，其余退回默认（不给任意字符串上计费接口的机会）', () => {
  assert.equal(buildMusicRequestBody({ ...OK, model: 'music-3.0' }).model, 'music-3.0');
  assert.equal(buildMusicRequestBody({ ...OK, model: 'music-2.6' }).model, 'music-2.6');
  for (const junk of ['music-cover', 'evilmodel', '', 'Music-3.0', 'x; DROP TABLE']) {
    assert.equal(buildMusicRequestBody({ ...OK, model: junk }).model, 'music-2.6', `junk=${junk}`);
  }
});

test('默认口径：有词有人声 → 只发 model/prompt/lyrics/output_format/audio_setting', () => {
  const body = buildMusicRequestBody(OK);
  assert.deepEqual(
    Object.keys(body).sort(),
    ['audio_setting', 'lyrics', 'model', 'output_format', 'prompt'],
  );
  assert.equal(body.output_format, 'hex');
  assert.deepEqual(body.audio_setting, { sample_rate: 44100, bitrate: 256000, format: 'mp3' });
});

test('apiKey 永不进请求体（它只属于 Authorization 头）', () => {
  const body = buildMusicRequestBody(OK);
  assert.ok(!('apiKey' in body));
  assert.ok(!JSON.stringify(body).includes('k-test'));
});

test('缺 key / 非器乐又没词 → 明确抛错，不发请求', () => {
  assert.throws(() => buildMusicRequestBody({ lyrics: 'x' }), /API Key/);
  assert.throws(() => buildMusicRequestBody({ apiKey: 'k' }), /歌词/);
  assert.doesNotThrow(() => buildMusicRequestBody({ apiKey: 'k', instrumental: true, musicPrompt: 'p' }));
});

test('generateMusic 真的用这个纯函数，且 timbre 不再作为字段发出', () => {
  const src = read(API_JS);
  assert.ok(/generateMusic\s*\(params/.test(src), 'generateMusic 入口漂移');
  assert.ok(src.includes('buildMusicRequestBody(params'), 'generateMusic 仍在自己拼 body');
  // 允许在注释里讲这段历史，但不允许再把它当字段发出去
  assert.ok(!/timbre\s*:/.test(src), 'src/api/ai-music.js 仍以 timbre 作为请求字段');
  assert.ok(!/timbre\s*:/.test(read(VIEW_JS)), 'views/ai-music.js 仍以 timbre 作为请求字段');
});

// ── 视图层接线：这三项能力光有请求体不够，控件得真的把参数送到调用点 ──

test('视图层把 voice/instrumental/autoLyrics/model 四项都送上调用点', () => {
  const view = read(VIEW_JS);
  const call = view.slice(view.indexOf('api.aiGenerateMusic({'));
  assert.ok(call.length > 20, '找不到生成歌曲的调用点');
  for (const field of ['voice:', 'instrumental,', 'autoLyrics,', 'model:']) {
    assert.ok(call.includes(field), `调用点缺 ${field}`);
  }
});

test('明星歌手名单彻底退场（既不上接口，也不该再出现在界面上）', () => {
  const view = read(VIEW_JS);
  for (const name of ['周深', '邓紫棋', '王菲', '周杰伦', '李玟']) {
    assert.ok(!view.includes(name), `视图层还留着真人歌手名：${name}`);
  }
  const voices = view.slice(view.indexOf('const VOICES'), view.indexOf('const MUSIC_MODELS'));
  assert.equal((voices.match(/id: '/g) || []).length, 3, '人声偏好应当只有 3 项');
});

test('直出模式不再要求本机歌词，且空主题必须先挡住（不发计费请求）', () => {
  const view = read(VIEW_JS);
  const guard = view.slice(view.indexOf('async function generateAiMusic'),
    view.indexOf('aiState.generating = true'));
  assert.ok(guard.length > 100, 'generateAiMusic 入口漂移');
  assert.ok(guard.includes('directMode'), '没有直出分支');
  assert.ok(/if \(!directInput\)[\s\S]{0,160}return;/.test(guard), '空主题没挡住');
  assert.ok(guard.includes('toast.aiTopicRequired'), '空主题应复用既有提示词条');
  assert.ok(guard.includes('lyrics: null'), '直出模式仍在本机凑歌词');
});

test('模型白名单两处对齐：视图下拉里的 id 必须是接口层认的', () => {
  const view = read(VIEW_JS);
  const apiSrc = read(API_JS);
  const modelsStart = view.indexOf('const MUSIC_MODELS');
  const options = [...view.slice(modelsStart, view.indexOf('// ═', modelsStart))
    .matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(options.length >= 2, '模型下拉为空？');
  for (const id of options) {
    assert.ok(apiSrc.includes(`'${id}'`), `视图给了 ${id}，接口层白名单里没有`);
  }
});
