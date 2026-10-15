/**
 * 四处文本调用（歌词 / 翻译 / 关键词改写 / 助手）真的按当前厂商出网
 *
 * 为什么非要真起 socket：厂商接入的全部风险都在「到底发给了谁」这一件事上 ——
 * 路径写错是 404（界面上和 Key 无效一个长相），Key 取错厂商会把 A 家的凭据发给
 * B 家，而自定义 Base URL 更是用户可控的出网目标。这些都只能靠「抓下发出去的
 * 那一条请求」来证明，读源码形状钉不够。
 *
 * 桩的做法沿用 test/ai-music-abort.test.js：把 https.request 换成本机 http
 * 服务（协议不同、行为一致），落点改到本机端口。
 *
 * 两处刻意的取舍：
 *   · **DNS 打桩**：出网闸（urlGuard）对域名要走 DNS。用例要验的是闸的判定与
 *     「过闸以后发给了谁」，不是本机解析器，所以把 dns.promises.lookup 固定成
 *     一个公网 IP。IP 字面量那两条**不打桩** —— 它们本来就不查 DNS，正好连真闸
 *     一起验（169.254.169.254 那条若被放行，就是云上偷元数据的路子）。
 *   · **零出网也要断言**：非 MiniMax 厂商点「生成音乐」、以及被闸拒掉的地址，
 *     证据是「服务端一次连接都没接到」。只断言抛错不够 —— 抛错之前请求可能已经
 *     发出去了，而那是计费接口。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

const aiMusic = require('../src/api/ai-music');
const { writeKeyMap } = require('../src/api/aiProviders');

const realHttpsRequest = https.request;
const realDnsLookup = dns.promises.lookup;

/** 每次请求落这里的 {path, host, auth, body} */
let captured = [];
let connections = 0;
/** 应答内容按用例改；默认给一个能过解析的最小说服 */
let reply = () => ({ choices: [{ message: { content: '["轻快 中文 晨跑"]' } }] });

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', () => {
    captured.push({
      path: req.url,
      host: req.headers.host,
      auth: req.headers.authorization,
      body: raw ? JSON.parse(raw) : null,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply()));
  });
});
server.on('connection', () => { connections++; });

let port = 0;
test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  https.request = (opts, cb) => http.request({ ...opts, hostname: '127.0.0.1', port, agent: false }, cb);
  // 域名一律"解析到公网"，让闸真的走完判定流程（IP 字面量的用例不经过这里）
  dns.promises.lookup = async () => [{ address: '1.1.1.1', family: 4 }];
});
test.after(() => {
  https.request = realHttpsRequest;
  dns.promises.lookup = realDnsLookup;
  server.closeAllConnections?.();
  server.close();
});

const reset = (prefs = {}) => {
  captured = [];
  connections = 0;
  reply = () => ({ choices: [{ message: { content: '["轻快 中文 晨跑"]' } }] });
  aiMusic.setPrefsGetter((key) => prefs[key]);
};
test.afterEach(() => { aiMusic.setPrefsGetter(null); });

const FOUR_TEXT_CALLS = [
  ['generateLyrics', () => aiMusic.generateLyrics({ topic: '夏天', style: 'pop', apiKey: 'sk-call' })],
  ['translateLyrics', () => aiMusic.translateLyrics({ lyrics: 'hello', targetLang: 'zh', apiKey: 'sk-call' })],
  ['rewriteSearchQueries', () => aiMusic.rewriteSearchQueries({ phrase: '适合夜跑', apiKey: 'sk-call' })],
  ['assistantChat', () => aiMusic.assistantChat({ messages: [{ role: 'user', content: 'hi' }], apiKey: 'sk-call' })],
];

test('没配过厂商的老口径一字不变：MiniMax 老地址 + 推荐型号 + 调用方给的 Key', async () => {
  reset({});
  for (const [name, call] of FOUR_TEXT_CALLS) {
    captured = [];
    await call();
    assert.equal(captured.length, 1, `${name} 没发请求`);
    assert.equal(captured[0].host, `127.0.0.1:${port}`, '桩的落点（真主机名见下面一条）');
    assert.match(captured[0].path, /^\/v1\/text\/chatcompletion_v2$/, `${name} 的路径漂了: ${captured[0].path}`);
    assert.equal(captured[0].body.model, 'MiniMax-Text-01', `${name} 的型号漂了`);
    assert.equal(captured[0].auth, 'Bearer sk-call', `${name} 没用调用方给的 Key`);
  }
});

test('选了 DeepSeek：四处的路径都跟着换，Key 取当前厂商那根', async () => {
  reset({
    aiProvider: 'deepseek',
    aiProviderModel: 'deepseek-reasoner',
    aiMusicApiKey: writeKeyMap({ minimax: 'sk-M', deepseek: 'sk-D' }),
  });
  for (const [name, call] of FOUR_TEXT_CALLS) {
    captured = [];
    await call();
    assert.equal(captured[0].path, '/chat/completions', `${name} 还打在老路径上: ${captured[0].path}`);
    assert.equal(captured[0].body.model, 'deepseek-reasoner', `${name} 的型号没跟厂商走`);
    // 调用方传的是 'sk-call'（旧界面残留），prefs 里 deepseek 的 Key 优先 ——
    // 把别处的串当 Key 发给厂商，只会得到一条读不懂的 401。
    assert.equal(captured[0].auth, 'Bearer sk-D', `${name} 的 Bearer 没取当前厂商的 Key`);
  }
});

test('调用方误传整包 Key 映射时，只发当前厂商那一根（绝不把三家凭据一起送出去）', async () => {
  reset({
    aiProvider: 'kimi',
    aiMusicApiKey: writeKeyMap({ minimax: 'sk-M', kimi: 'sk-K', glm: 'sk-G' }),
  });
  // 旧渲染层口径：把 prefs 里读到的原值整个传下来。加了厂商以后这就是
  // 「一个 Bearer 头带三家 Key」的事故，必须在出网前拆出来。
  await aiMusic.assistantChat({ messages: [], apiKey: '{"minimax":"sk-M","kimi":"sk-K","glm":"sk-G"}' });
  assert.equal(captured[0].auth, 'Bearer sk-K', captured[0].auth);
  assert.ok(!captured[0].auth.includes('sk-M') && !captured[0].auth.includes('sk-G'), '别的厂商的 Key 漏进了请求头');
  assert.ok(!JSON.stringify(captured[0].body).includes('sk-'), 'Key 漏进了请求体');
});

test('界面不再把 Key 交下来也能跑：四处只靠 prefs 就能出网（这是新界面侧的口径）', async () => {
  // 加了厂商以后，Key 存在 {厂商:Key} 的映射里，界面不该再把它拉进渲染层进程
  // 一路传回主进程。若这四条链上还留着「调用方不交 Key 就报缺 Key」的判据，
  // 界面就会在明明配好 Key 的情况下收到 NO_KEY —— 那是接线的洞，不是用户没配。
  reset({ aiProvider: 'deepseek', aiMusicApiKey: writeKeyMap({ deepseek: 'sk-D' }) });
  const noCallerKey = [
    ['generateLyrics', () => aiMusic.generateLyrics({ topic: '夏天', style: 'pop' })],
    ['translateLyrics', () => aiMusic.translateLyrics({ lyrics: 'hello', targetLang: 'zh' })],
    ['rewriteSearchQueries', () => aiMusic.rewriteSearchQueries({ phrase: '适合夜跑' })],
    ['assistantChat', () => aiMusic.assistantChat({ messages: [{ role: 'user', content: 'hi' }] })],
  ];
  for (const [name, call] of noCallerKey) {
    captured = [];
    await call();
    assert.equal(captured.length, 1, `${name} 没出网（ prefs 里有 Key 却像没配 ）`);
    assert.equal(captured[0].auth, 'Bearer sk-D', `${name} 的 Bearer 没从 prefs 取`);
  }
});

test('prefs 与调用方都没 Key：四处一律 NO_KEY 且零出网（不拿空 Bearer 去打计费接口）', async () => {
  reset({});
  const calls = [
    () => aiMusic.generateLyrics({ topic: '夏天' }),
    () => aiMusic.translateLyrics({ lyrics: 'hello' }),
    () => aiMusic.rewriteSearchQueries({ phrase: '夜跑' }),
    () => aiMusic.assistantChat({ messages: [] }),
  ];
  for (const call of calls) {
    captured = [];
    await assert.rejects(call, /NO_KEY/);
    assert.equal(connections, 0, '没 Key 还是出网了');
  }
});

test('自定义 Base URL 换 host，路径仍用该厂商登记的那条', async () => {
  reset({ aiProvider: 'glm', aiProviderBaseUrl: 'https://gw.example.com/v4', aiMusicApiKey: writeKeyMap({ glm: 'sk-G' }) });
  await aiMusic.assistantChat({ messages: [] });
  assert.equal(captured[0].path, '/v4/chat/completions', captured[0].path);
});

test('Base URL 填内网地址：闸拒掉且一次都不出网（只断言抛错不够，请求可能已经发出去了）', async () => {
  reset({ aiProvider: 'deepseek', aiProviderBaseUrl: 'https://169.254.169.254', aiMusicApiKey: writeKeyMap({ deepseek: 'sk-D' }) });
  await assert.rejects(() => aiMusic.assistantChat({ messages: [] }), /ENDPOINT_BLOCKED/);
  assert.equal(connections, 0, '被拒的请求还是发出去了');
});

test('http 明文地址不发（Key 不该裸奔在链路上）', async () => {
  reset({ aiProvider: 'custom', aiProviderBaseUrl: 'http://gw.example.com', aiMusicApiKey: writeKeyMap({ custom: 'sk-C' }) });
  await assert.rejects(() => aiMusic.assistantChat({ messages: [] }), /BAD_BASE_URL/);
  assert.equal(connections, 0);
});

test('计费调用没有因为换厂商而松开禁重试：失败应答只跳一次', async () => {
  reset({ aiProvider: 'deepseek', aiMusicApiKey: writeKeyMap({ deepseek: 'sk-D' }) });
  reply = () => ({ error: { message: 'quota exceeded' } });
  await assert.rejects(() => aiMusic.assistantChat({ messages: [] }));
  assert.equal(connections, 1, `禁自动重试松了：接了 ${connections} 条`);
});

test('非 MiniMax 厂商点「生成音乐」：零出网并给 MUSIC_UNSUPPORTED', async () => {
  reset({
    aiProvider: 'deepseek',
    aiMusicApiKey: writeKeyMap({ minimax: 'sk-M', deepseek: 'sk-D' }),
  });
  await assert.rejects(
    () => aiMusic.generateMusic({ apiKey: 'sk-M', musicPrompt: '雨后钢琴', instrumental: true }),
    /MUSIC_UNSUPPORTED/,
  );
  assert.equal(connections, 0, '音乐合成请求还是发出去了（那是计费接口）');
});

test('MiniMax 厂商下音乐合成照常出网（gating 不许把老功能闸死）', async () => {
  reset({ aiProvider: 'minimax', aiMusicApiKey: writeKeyMap({ minimax: 'sk-M' }) });
  reply = () => ({ base_resp: { status_code: 0, status_msg: '' }, data: { status: 0, audio: 'deadbeef' }, extra_info: { music_duration: 180000 } });
  const r = await aiMusic.generateMusic({ apiKey: 'sk-M', musicPrompt: '雨后钢琴', instrumental: true });
  assert.equal(r.audioHex, 'deadbeef');
  assert.equal(captured[0].auth, 'Bearer sk-M');
});

test('没 Key 的口径不变：助手仍报 NO_KEY（界面据此出词典文案）', async () => {
  reset({ aiProvider: 'deepseek', aiMusicApiKey: writeKeyMap({ minimax: 'sk-M' }) });
  await assert.rejects(() => aiMusic.assistantChat({ messages: [] }), /NO_KEY/);
  assert.equal(connections, 0);
});
