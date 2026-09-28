/**
 * 单元测试：汽水取流的「整曲 vs 试听片段」判据
 *
 * 为什么必须在 soda 这一层判（2026-09-21 第四轮实测）：
 *   汽水分享页 `audioWithLyricsOption.duration` 给的是**曲目标称时长**，
 *   而 `url` 指向的字节常常只是片段 —— 实测三例：
 *     孤勇者 声称 251s / 实长 29s（471 KB）
 *     起风了 声称 324s / 实长 60s（950 KB）
 *     晴天   声称 240s / 实长 240s（整曲，正常）
 *   旧代码用 `estimateBr(实测字节, 声称秒数)` 反推码率再一并上报，等于把
 *   「声称时长」洗成了自洽的 br：任何下游拿 size*8/br 去核对长度都必然吻合，
 *   片段判定在这一层被结构性地屏蔽掉了（换源层再聪明也看不到破绽）。
 *
 *   剩下的**独立**证据只有物理量：音乐流的码率不可能低到十几 kbps。
 *   声称时长与实测字节反推出的码率一旦低于音乐编码下限，说明这两者不匹配，
 *   即「这些字节装不下那么久的歌」⇒ 手里的就是片段。
 *
 * 打桩方式与 test/qq-geturl-transport.test.js 同：改 require.cache 里
 * src/api/request 的导出（含 testAudioLink —— soda 模块顶层解构了它），
 * 再清掉平台模块缓存重新 require。全程零网络。
 */

const test = require('node:test');
const assert = require('node:assert');

const reqPath = require.resolve('../src/api/request');

let share = null;      // 当前用例喂给分享页解析器的 audioWithLyricsOption
let probeResult = null; // 当前用例 testAudioLink 的返回

function stubRequest(url) {
  if (!String(url).includes('/qishui/share/track')) throw new Error('不该请求其它地址: ' + url);
  return Promise.resolve(`<html><script>window._ROUTER_DATA = ${JSON.stringify({
    loaderData: { track_page: { audioWithLyricsOption: share } },
  })}</script></html>`);
}
stubRequest.testAudioLink = async () => probeResult;
require.cache[reqPath] = { id: reqPath, filename: reqPath, loaded: true, exports: stubRequest };

const sodaPath = require.resolve('../src/api/platforms/soda');
delete require.cache[sodaPath];
const soda = require(sodaPath);

let seq = 0;
/** @param {{url:string,duration:number}} s 分享页 audioWithLyricsOption */
async function getUrlWith(s, probe) {
  share = { trackName: 'T', artistName: 'A', lyrics: { sentences: [] }, ...s };
  probeResult = probe;
  return soda.sodaGetUrl(`track-${++seq}`);
}

test('汽水取流：声称时长与字节数自洽（实测整曲 129kbps）⇒ 正常给出直链', async () => {
  const r = await getUrlWith(
    { url: 'https://v5-luna.douyinvod.com/full/', duration: 65.019 },
    { ok: true, sizeBytes: 1052196, ext: 'm4a' },
  );
  assert.strictEqual(r.url, 'https://v5-luna.douyinvod.com/full/');
  assert.strictEqual(r.br, 129000, '整曲的估算码率口径不能变（音质徽标要用）');
  assert.strictEqual(r.size, 1052196);
});

test('汽水取流：声称 251s 却只有 29s 的字节（反推 15kbps）⇒ 判为试听片段', async () => {
  const r = await getUrlWith(
    { url: 'https://v5-luna.douyinvod.com/clip/', duration: 251 },
    { ok: true, sizeBytes: 471040, ext: 'm4a' },
  );
  assert.ok(!r.url, '片段绝不能当整曲交出去');
  assert.strictEqual(r.code, 'NO_AUDIO_STREAM', '错误码须在换源白名单内，好让上层换源');
  assert.strictEqual(r.fatal, true);
  assert.match(String(r.error), /试听/);
});

test('汽水取流：声称 324s 却只有 60s 的字节（反推 24kbps）⇒ 同样判片段', async () => {
  const r = await getUrlWith(
    { url: 'https://v5-luna.douyinvod.com/clip2/', duration: 324 },
    { ok: true, sizeBytes: 972800, ext: 'm4a' },
  );
  assert.ok(!r.url);
  assert.strictEqual(r.code, 'NO_AUDIO_STREAM');
});

test('汽水取流：片段比 60s/199s（反推 39kbps）也必须判片段 —— 本机实测漏网的那一档', async () => {
  // 这一档是 32kbps 下限版本的漏网之鱼：整曲实测码率 ≥126kbps，
  // 片段反推只会是「整曲码率 × 片段占比」，199s 的曲子给 60s 就是 39kbps。
  const r = await getUrlWith(
    { url: 'https://v5-luna.douyinvod.com/clip3/', duration: 199 },
    { ok: true, sizeBytes: 972800, ext: 'm4a' },
  );
  assert.ok(!r.url, '39kbps 不可能是整曲，必须判片段');
  assert.strictEqual(r.code, 'NO_AUDIO_STREAM');
});

test('汽水取流：边界 —— 64kbps 及以上视为整曲，以下视为片段', async () => {
  // 判据本身单独钉：阈值挪动必须留下失败痕迹。
  // 下限取 64k 的依据：本应用所有免费档实测都是 128kbps 量级（汽水整曲 126~129k、
  // 酷我/咪咕/网易云 standard 128k），64k 已留一倍余量；反过来说，任何低于 64k 的
  // 「平均码率」只能是「字节数装不下声称时长」，即手里的字节是片段。
  const at = (kbps, sec) => (kbps * 1000 * sec) / 8;
  const ok65 = await getUrlWith({ url: 'https://x/a/', duration: 100 },
    { ok: true, sizeBytes: at(65, 100), ext: 'm4a' });
  assert.strictEqual(ok65.url, 'https://x/a/');
  const bad63 = await getUrlWith({ url: 'https://x/b/', duration: 100 },
    { ok: true, sizeBytes: at(63, 100), ext: 'm4a' });
  assert.ok(!bad63.url, '63kbps 不是任何一档音乐编码的码率');
});

test('汽水取流：探不到字节数或分享页不给时长 ⇒ 无证据不判片段（保守放过）', async () => {
  const noSize = await getUrlWith(
    { url: 'https://v5-luna.douyinvod.com/x/', duration: 251 },
    { ok: true, sizeBytes: null, ext: 'm4a' },
  );
  assert.strictEqual(noSize.url, 'https://v5-luna.douyinvod.com/x/');
  assert.strictEqual(noSize.br, null, '无字节数时不得凭空造码率');

  const noDur = await getUrlWith(
    { url: 'https://v5-luna.douyinvod.com/y/', duration: 0 },
    { ok: true, sizeBytes: 471040, ext: 'm4a' },
  );
  assert.strictEqual(noDur.url, 'https://v5-luna.douyinvod.com/y/');
});
