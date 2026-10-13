/**
 * 取流失败的统一分类（2026-10-13）
 *
 * 这批用例针对的是「提高取流成功率」里最关键、此前**完全缺失**的一环：
 * 失败信息在平台层丢掉了「这是不是一条只是签名过期的链」。
 *
 * 取证发现（逐个平台读过）：
 *   - request.js 只把 5xx/429 包成错误 reject，**403 是 resolve 掉的**
 *   - 8 个平台都没把 HTTP status 放进返回值
 *   - 于是 resolveTrackService 里那条专门为「CDN 签名过期就换源」写的
 *     `/HTTP\s*(403|404|410)/i` 文本匹配，实际几乎永不命中
 *
 * 所以这里的断言分三类：
 *   1. 分类本身（纯函数，穷举各平台的实际返回形态）
 *   2. **零回归**：没透出 status 的平台，行为必须与改造前逐字节一致
 *   3. 换源出口：一旦有 status，403/404/410 必须真的换源
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyStreamError, annotateStreamError, CATEGORY, FALLBACK_HTTP_STATUSES,
} = require('../src/api/services/streamFailure');
const { shouldFallbackToOtherSource } = require('../src/api/services/resolveTrackService');

test('分类：各平台实际返回形态都能落到正确的 category', () => {
  const cases = [
    // netease / qq（走 AppError，码表内）
    [{ error: '需要 VIP', code: 'VIP_REQUIRED' }, CATEGORY.PAYWALL],
    [{ error: '鉴权已过期', code: 'AUTH_EXPIRED' }, CATEGORY.AUTH],
    [{ error: '已下架', code: 'UNAVAILABLE' }, CATEGORY.DEAD],
    [{ error: '请求超时', code: 'NETWORK_TIMEOUT' }, CATEGORY.NETWORK],
    // kuwo/migu/soda/fivesing/kugou 的手写字面量
    [{ error: 'x', code: 'COPYRIGHT_RESTRICTED' }, CATEGORY.PAYWALL],
    [{ error: 'x', code: 'CDN_EMPTY' }, CATEGORY.DEAD],
    [{ error: 'x', code: 'NO_AUDIO_STREAM' }, CATEGORY.DEAD],
    [{ error: 'x', code: 'PLATFORM_CHANGED' }, CATEGORY.UNKNOWN],
    [{ error: 'x', code: 'FETCH_FAILED' }, CATEGORY.NETWORK],
    // 只有文案、既无 code 又无 status（kugou 改造前的形态）
    [{ error: 'socket hang up' }, CATEGORY.NETWORK],
    [{ error: '请重新登录获取 Cookie' }, CATEGORY.AUTH],
    [{ error: '该歌曲受版权限制' }, CATEGORY.PAYWALL],
    [{ error: '因地区限制不可用' }, CATEGORY.GEO],
    [{ error: '某个说不清的错误' }, CATEGORY.UNKNOWN],
  ];
  for (const [result, expected] of cases) {
    assert.strictEqual(classifyStreamError(result).category, expected,
      `${JSON.stringify(result)} 的分类不对`);
  }
});

test('分类：HTTP 状态能独立把结果救回来（此前完全丢失的信息）', () => {
  // 笼统文案 + 403：这正是真实形态（平台只说「暂不可用」，但链其实是过期的）
  const r = classifyStreamError({ error: '音源暂不可用' }, { httpStatus: 403 });
  assert.strictEqual(r.category, CATEGORY.EXPIRED);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.expiredLink, true, '403 必须被认成「这条链只是过期了」');

  assert.strictEqual(classifyStreamError({ error: 'x' }, { httpStatus: 404 }).category, CATEGORY.DEAD);
  assert.strictEqual(classifyStreamError({ error: 'x' }, { httpStatus: 410 }).category, CATEGORY.DEAD);
  assert.strictEqual(classifyStreamError({ error: 'x' }, { httpStatus: 401 }).category, CATEGORY.AUTH);
  assert.strictEqual(classifyStreamError({ error: 'x' }, { httpStatus: 503 }).category, CATEGORY.NETWORK);
});

test('分类：状态与 code 冲突时信状态（403 几乎总是「链不能用了」）', () => {
  // 平台给了 NETWORK_ERROR，但它同时报了 403 —— 403 才是更有价值的线索
  const r = classifyStreamError({ error: '失败', code: 'NETWORK_ERROR', status: 403 });
  assert.strictEqual(r.category, CATEGORY.EXPIRED);
});

test('分类：fatal 缺省按类别派生（重试只在换 URL 有意义时才划算）', () => {
  // 网络类：重试有意义 ⇒ 非 fatal
  assert.strictEqual(classifyStreamError({ error: 'socket hang up' }).fatal, false);
  assert.strictEqual(classifyStreamError({ error: 'x', code: 'NETWORK_TIMEOUT' }).fatal, false);
  // 墙/过期/下架/未知：换 URL 重试不会变好
  assert.strictEqual(classifyStreamError({ error: 'x', code: 'VIP_REQUIRED' }).fatal, true);
  assert.strictEqual(classifyStreamError({ error: 'x' }, { httpStatus: 403 }).fatal, true);
  // 平台显式给了就以平台的为准（不改既有行为）
  assert.strictEqual(classifyStreamError({ error: 'x', code: 'COPYRIGHT_RESTRICTED', fatal: false }).fatal,
    false, '平台的显式 fatal 必须被尊重');
});

test('成功结果不被误判成失败', () => {
  const r = classifyStreamError({ url: 'https://cdn/a.mp3', ext: 'mp3' });
  assert.strictEqual(r.isFailure, false);
  assert.strictEqual(r.category, 'ok');
});

test('annotate：只附加、不覆盖（零回归的保证）', () => {
  const original = { error: '音源暂不可用', code: 'UNAVAILABLE', fatal: false };
  const out = annotateStreamError(original, { platform: 'kugou' });
  assert.strictEqual(out.code, 'UNAVAILABLE', '既有 code 不动');
  assert.strictEqual(out.fatal, false, '既有 fatal 不动');
  assert.strictEqual(out.error, '音源暂不可用', '既有文案不动');
  assert.strictEqual(out.category, CATEGORY.DEAD, '只新增 category');
  assert.notStrictEqual(out, original, '返回新对象，不污染平台返回值');
  // 未开启落盘的失败时不该凭空多出 status
  assert.strictEqual(out.status, undefined);
});

test('annotate：成功结果原样返回（不多加字段）', () => {
  const ok = { url: 'https://cdn/a.mp3' };
  assert.strictEqual(annotateStreamError(ok), ok);
});

test('零回归：平台没透出 status 时，换源判定与改造前的旧逻辑逐条一致', () => {
  const { shouldFallbackByCode } = require('../src/api/services/fallbackCodes');
  const LEGACY_RE = /HTTP\s*(403|404|410)/i;
  // 「旧逻辑」在这里被独立复述一遍，而不是抄一份名单 ——
  // 抄名单会随白名单变动而失真，那就测不出「有没有改变判定」了。
  const legacyDecide = (r) => shouldFallbackByCode(r.code) || LEGACY_RE.test(String(r.error || ''));

  const before = [
    { error: '该歌曲受版权限制', code: 'COPYRIGHT_RESTRICTED' },
    { error: '音源暂不可用' },                      // 笼统、无 code、无 status
    { error: '接口已变更', code: 'PLATFORM_CHANGED' },
    { error: '需要 VIP', code: 'VIP_REQUIRED' },
    { error: 'HTTP 404: 不存在' },                  // 旧文本路径
    { error: 'CDN 地址为空', code: 'CDN_EMPTY' },
  ];
  for (const r of before) {
    assert.strictEqual(shouldFallbackToOtherSource(r), legacyDecide(r),
      `${JSON.stringify(r)} 的换源判定被改变了 —— 没透出 status 时不该有任何变化`);
  }
});

test('换源出口：一旦透出 status，403/404/410 真的会换源（此前是死路）', () => {
  for (const st of [403, 404, 410]) {
    assert.ok(FALLBACK_HTTP_STATUSES.has(st));
    assert.strictEqual(
      shouldFallbackToOtherSource({ error: '音源暂不可用', status: st }), true,
      `HTTP ${st} 是「这条链不能用了」，应当换源`);
  }
  // 服务端自己的问题换源也没用（同样打在同一批服务上）
  for (const st of [500, 502, 503, 429]) {
    assert.strictEqual(
      shouldFallbackToOtherSource({ error: '服务端开小差', status: st }), false,
      `HTTP ${st} 换源无意义，不应换`);
  }
});

test('换源出口：status 优先于文案（文案里没有那个数字也认得出）', () => {
  // 旧路径只认「文案里含 HTTP 403」；新路径只要有 status
  assert.strictEqual(shouldFallbackToOtherSource({ error: '暂不可用', status: 403 }), true);
  // 旧路径依然保留（平台若把状态写进文案也能认）
  assert.strictEqual(shouldFallbackToOtherSource({ error: 'HTTP 403: 失败' }), true);
});

test('非法 / 缺失输入不抛（分类在失败路径上，绝不能自己把链路搞崩）', () => {
  for (const v of [null, undefined, '', 0, false, [], 'x']) {
    assert.doesNotThrow(() => classifyStreamError(v));
    assert.doesNotThrow(() => annotateStreamError(v));
  }
  assert.strictEqual(classifyStreamError(null).category, CATEGORY.UNKNOWN);
  // 非法的 status 值不应污染
  assert.strictEqual(classifyStreamError({ error: 'x', status: 'abc' }).status, null);
  assert.strictEqual(classifyStreamError({ error: 'x', status: 99 }).status, null);
});
