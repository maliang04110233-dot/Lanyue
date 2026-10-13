/**
 * 日志脱敏（src/utils/redact.js）
 *
 * 为什么这些断言值得写死：脱敏的**失效方向是不对称的** —— 多脱一点只是让日志
 * 少几个字符，少脱一点就是把登录态抄送进日志文件（而日志文件是用户贴进 issue、
 * 存进网盘、传进工单系统的东西）。所以这里逐条钉住「必须被抹掉」，
 * 同时也钉住「不该被抹掉」（过度脱敏会让日志失去诊断价值，同样是缺陷）。
 *
 * 真实泄漏源（复审时逐个 grep 出来的）：
 *   downloader 重定向/超时、soda/migu/kuwo 直链预检、resolveTrack 候选跳过
 *   —— 它们都直接打印平台返回的直链，而网易云/QQ/B 站把签名放在查询串里。
 */

const test = require('node:test');
const assert = require('node:assert');

const { redactText, redactUrl, redactValue, isSensitiveKey } = require('../src/utils/redact');

test('URL 查询串：签名类参数必须抹掉，其余参数保留（保留才能定位是哪个接口）', () => {
  const url = 'https://m.music.163.com/song/enhance/player/url?data=ENC%3Dbase64blob&br=128000&sign=abc123XYZ';
  const out = redactUrl(url);
  assert.ok(!out.includes('ENC%3Dbase64blob'), '网易云 data 参数泄漏');
  assert.ok(!out.includes('abc123XYZ'), 'sign 参数泄漏');
  assert.ok(out.includes('br=128000'), '无害参数应保留 —— 否则日志失去定位能力');
  assert.ok(out.startsWith('https://m.music.163.com/song/enhance/player/url?'), '路径应保留');
});

test('平台各自的鉴权参数名都要覆盖（历史上局部实现只列了 6 个）', () => {
  const cases = [
    ['网易云', 'https://y.music.163.com/x?data=LEAK1&sign=LEAK2'],
    ['QQ', 'https://u.y.qq.com/cgi-bin/x?sign=LEAK3&guid=LEAK4&songmid=LEAK5'],
    ['B 站', 'https://api.bilibili.com/x?token=LEAK6&authst=LEAK7'],
    ['酷狗', 'https://kugou.com/x?key=LEAK8&authst=LEAK9'],
    ['汽水', 'https://soda.com/x?musicid=LEAK10&userid=LEAK11'],
  ];
  for (const [name, url] of cases) {
    const out = redactUrl(url);
    assert.ok(!/LEAK\d+/.test(out), `${name} 的鉴权参数泄漏了：${out}`);
  }
});

test('Authorization / Cookie / Bearer 头形态', () => {
  assert.ok(!redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig').includes('eyJ'),
    'Authorization 头泄漏');
  assert.ok(!redactText('cookie: MUSIC_U=abcdef123456; __csrf=xyz789').includes('abcdef123456'),
    'Cookie 头泄漏');
  assert.ok(!redactText('请求失败，header 是 Bearer sk-proj-ABCDEFGH12345678').includes('sk-proj'),
    '裸 Bearer 令牌泄漏');
});

test('键值形态：apiKey / token / secret / password', () => {
  const samples = [
    'apiKey: "sk-live-0123456789abcdef"',
    'aiMusicApiKey=mm-key-abcdef123456',
    '{"access_token":"AT-xyz789","model":"MiniMax-Text-01"}',
    'client_secret = "cs_9988776655"',
    'password: hunter2000',
  ];
  for (const s of samples) {
    const out = redactText(s);
    assert.ok(!/sk-live-|mm-key-|AT-xyz|cs_9988|hunter2000/.test(out), `泄漏：${s} → ${out}`);
  }
});

test('幂等：已脱敏的内容再过一次不应变化（否则重复脱敏会啃掉内容）', () => {
  const once = redactText('url?sign=abc&data=def');
  assert.strictEqual(redactText(once), once);
});

test('不该被脱敏的东西必须保留（过度脱敏也是缺陷）', () => {
  // 哈希 / 校验值是排障关键线索：「是不是同一个文件」「latest.yml 对不对」
  const hashLine = 'latest.yml sha512: 9tXk2vQ8mNbR7pL1sW4yZ6aB3cD5eF7gH9jK1lM3nO5pQ7rS9tU1vW3xY5zA';
  assert.strictEqual(redactText(hashLine), hashLine, 'sha512 校验值不该被抹');

  const idLine = '下载完成 id=186016 size=3.9MB path=D:/Music/周杰伦 - 晴天.mp3';
  assert.strictEqual(redactText(idLine), idLine, '歌曲 id / 路径 / 大小是诊断依据');

  const errLine = 'HTTP 404: 下载失败';
  assert.strictEqual(redactText(errLine), errLine);
});

test('redactValue：敏感键整值抹掉，其余结构保留', () => {
  const prefs = {
    saveDir: 'D:/Music',
    concurrency: 3,
    aiMusicApiKey: 'sk-live-should-not-appear',
    mcpToken: 'enc:v1:AAAABBBB',
    nested: { cookie: 'MUSIC_U=zzz', eqPreset: 'pop' },
    list: [1, 2, 'sign=LEAK'],
  };
  const out = redactValue(prefs);
  assert.strictEqual(out.saveDir, 'D:/Music');
  assert.strictEqual(out.concurrency, 3);
  assert.strictEqual(out.aiMusicApiKey, '[redacted]');
  assert.strictEqual(out.mcpToken, '[redacted]');
  assert.strictEqual(out.nested.cookie, '[redacted]');
  assert.strictEqual(out.nested.eqPreset, 'pop', '非敏感键要保留');
  assert.ok(!out.list[2].includes('LEAK'), '数组里的签名参数同样要脱敏');
});

test('过度脱敏也要避免：data / uid / key 这类通用词在非 URL 上下文保留', () => {
  // 理由写在这里而不是代码里：日志里 `data=data`、`key=title`、`uid=1` 太常见，
  // 一律抹掉会让诊断信息被 [redacted] 淹没 —— 那是另一种缺陷。
  // URL 形态（?data=xxx）仍由 RE_QUERY 抹掉，因为那里有 ?/& 锚点，不会误伤。
  for (const s of ['统计行 data=data', '排序 key=title', '用户 uid=1', 'payload {data: 123}']) {
    assert.strictEqual(redactText(s), s, `不该被过度脱敏：${s}`);
  }
  // 但 URL 形态下同样这些参数必须抹掉
  assert.ok(!redactText('https://x/y?data=LEAK').includes('LEAK'));
  assert.ok(!redactText('https://x/y?key=LEAK&br=128').includes('LEAK'));
});

test('redactValue：深度/长度截断（防环形引用与超大对象把诊断包撑爆）', () => {
  let deep = { v: 'x' };
  for (let i = 0; i < 12; i++) deep = { n: deep };
  assert.ok(JSON.stringify(redactValue(deep)).includes('深度截断'));

  const big = { arr: Array.from({ length: 120 }, (_, i) => i) };
  const out = redactValue(big);
  assert.strictEqual(out.arr.length, 51, '数组截断到 50 项 + 1 条说明');
  assert.ok(String(out.arr[50]).includes('共 120 项'));
});

test('isSensitiveKey：大小写与分隔符无关，且不误伤 hotkey 之类', () => {
  for (const k of ['apiKey', 'API_KEY', 'api-key', 'mcpToken', 'Password', 'sessionId', 'clientSecret']) {
    assert.ok(isSensitiveKey(k), `${k} 应判为敏感`);
  }
  for (const k of ['saveDir', 'concurrency', 'namingTemplate', 'hotkey', 'monkey', 'eqPreset', 'title']) {
    assert.ok(!isSensitiveKey(k), `${k} 不该判为敏感（过度脱敏会毁掉诊断信息）`);
  }
});

test('空值与非法输入不抛（脱敏在日志路径上，绝不能自己把日志搞崩）', () => {
  for (const v of [null, undefined, '', 0, false, {}, []]) {
    assert.doesNotThrow(() => redactText(v));
    assert.doesNotThrow(() => redactValue(v));
  }
  const circular = { a: 1 };
  circular.self = circular;
  assert.doesNotThrow(() => redactValue(circular), '循环引用不该导致栈溢出');
});
