/**
 * 取流回写码 → 诊断码表 的覆盖度门禁
 *
 * 症状（2026-09-22 静态走查实测，非猜测）：downloadQueue.js:335 把取流结果的
 * `code` 原样写进 song.errorCode，队列行/历史行的徽标（failureTag）和诊断弹层
 * （classifyFailure）都只认 diagnose.js 的 DIAG_TABLE。而取流层实际回写的码比表里多：
 * PLATFORM_CHANGED（酷狗反爬，就在发）、BAD_PARAMS、FETCH_FAILED、
 *   INTERNAL_ERROR、INVALID_ARGS、UNKNOWN_SOURCE、BILI_URL_ERROR —— 七个码在表里一个都没有。
 * 于是用户看到的是一律「未分类的失败 / 复制错误信息反馈」，而且行内连徽标都不戴。
 * 最刺眼的是 PLATFORM_CHANGED：它早已进换源白名单（fallbackCodes.js），
 * 说明系统认得它，唯独诊断这一侧漏了登记。
 *
 * 为什么钉成门禁而不是一次修完：码表加一个码要改两处（平台发码 / 诊断登记），
 * 162 已经把徽标收成一家，这次把「发码必登记」也收成一条机械断言 ——
 * 以后任何平台再加回写码，漏登记就直接红，不必等用户投诉。
 *
 * 扫描范围只取「回写层」：src/api/platforms/*.js、src/api/services/*.js、src/api/gateway.js。
 * src/api/request.js 排除在外 —— 它那些 code（ETIMEDOUT/ABORT_ERR）挂在抛出的 Error 上，
 * 由平台 catch 转成 FETCH_FAILED 才落到 errorCode，本身不会直接进取流结果对象。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/** AppError 工厂名 → 错误码（从 src/shared/errors.js 现推，不手抄第二份清单） */
function factoryToCode() {
  const src = read('src/shared/errors.js');
  const map = {};
  const re = /(\w+)\s*:\s*\(.*?\)\s*=>\s*create\w*Error\(ERROR_CODES\.(\w+)/g;
  let m;
  while ((m = re.exec(src)) !== null) map[m[1]] = m[2];
  return map;
}

function scanFiles() {
  const out = [];
  for (const dir of ['src/api/platforms', 'src/api/services']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (name.endsWith('.js')) out.push(`${dir}/${name}`);
    }
  }
  out.push('src/api/gateway.js');
  return out;
}

/** 回写层真实发出去的全部错误码 → 出现它的文件（用于失败信息里点名） */
function emittedCodes() {
  const fn2code = factoryToCode();
  const found = new Map();
  const add = (code, file) => {
    if (!found.has(code)) found.set(code, new Set());
    found.get(code).add(file);
  };
  for (const file of scanFiles()) {
    const src = read(file);
    let m;
    const reFactory = /AppError\.(\w+)\(/g;
    while ((m = reFactory.exec(src)) !== null) {
      if (fn2code[m[1]]) add(fn2code[m[1]], file);
    }
    const reLiteral = /\bcode:\s*'([A-Z][A-Z_0-9]{3,})'/g;
    while ((m = reLiteral.exec(src)) !== null) add(m[1], file);
  }
  return found;
}

const EMITTED = emittedCodes();
const fresh = () => import(`../src/renderer/js/diagnose.js?ck=${Math.random()}`);

test('扫描本身要有效：回写层至少扫出 12 个码，且不含小写/数字噪声', () => {
  assert.ok(EMITTED.size >= 12, `只扫出 ${EMITTED.size} 个码，多半是扫描规则失效了（门禁不能空转）`);
  for (const code of EMITTED.keys()) {
    assert.match(code, /^[A-Z][A-Z_0-9]{3,}$/, `扫出的不是错误码形状：${code}`);
  }
  // 已知必须被扫到的三个码，缺一即说明扫描面漏了目录
  for (const must of ['VIP_REQUIRED', 'PLATFORM_CHANGED', 'FETCH_FAILED']) {
    assert.ok(EMITTED.has(must), `扫描漏掉了 ${must}，门禁会假绿`);
  }
});

/**
 * 徽标颜色的判据从「长得像 var()」升级为「这个变量真在 base.css 里定义过」。
 * 老断言是空转的：--neon-red / --neon-orange / --neon-yellow 三枚被 DIAG_TABLE 和本地
 * 音质徽标共用了十几处，base.css 六个主题块里一个都没定义 —— CSS 变量解析失败后
 * color 继承正文字色，于是「需VIP」「断网」「CDN异常」全部长成同一个灰色，
 * 诊断徽标的颜色编码（橙=鉴权 / 红=接口 / 黄=网络）等于不存在。形状检查抓不到这个。
 */
function themeBlockProps() {
  const src = read('src/renderer/styles/base.css');
  const blocks = [];
  const re = /(^|\n)\s*(:root|\[data-theme="[^"]+"\])\s*\{([\s\S]*?)\n\s*\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const props = new Set();
    const rp = /--([a-z0-9-]+)\s*:/g;
    let p;
    while ((p = rp.exec(m[3])) !== null) props.add(p[1]);
    blocks.push({ name: m[2].trim(), props });
  }
  return blocks;
}

const THEME_BLOCKS = themeBlockProps();

test('扫描本身要有效：主题块至少解析出 6 个，否则颜色门禁空转', () => {
  assert.ok(THEME_BLOCKS.length >= 6, `只解析出 ${THEME_BLOCKS.length} 个主题块：${THEME_BLOCKS.map((b) => b.name).join(', ')}`);
  assert.ok(THEME_BLOCKS.some((b) => b.name === ':root'), '解析漏了 :root');
  assert.ok(THEME_BLOCKS.some((b) => b.name.includes('light')), '解析漏了 [data-theme="light"]');
});

test('取流回写的每个码都有行内徽标（failureTag 不返回 null）', async () => {
  const { failureTag } = await fresh();
  const missing = [];
  const malformed = [];
  for (const [code, files] of EMITTED) {
    const t = failureTag(code);
    if (!t) { missing.push(`${code} ← ${[...files].join(', ')}`); continue; }
    if (t.label.length > 8 || /[。，]/.test(t.label)) malformed.push(`${code}=${t.label}`);
    const mColor = /^var\(--([a-z0-9-]+)\)$/.exec(t.color || '');
    if (!mColor) { malformed.push(`${code} 颜色不是纯语义变量：${t.color}`); continue; }
    const token = mColor[1];
    const undef = THEME_BLOCKS.filter((b) => !b.props.has(token)).map((b) => b.name);
    if (undef.length) malformed.push(`${code} 的颜色 --${token} 在这些块里没定义（会掉成正文色）：${undef.join(', ')}`);
  }
  assert.deepStrictEqual(missing, [], `以下回写码在 DIAG_TABLE 没登记，用户看不到徽标：\n  ${missing.join('\n  ')}`);
  assert.deepStrictEqual(malformed, [], `徽标是行内短标签，不是句子：\n  ${malformed.join('\n  ')}`);
});

test('取流回写的每个码都不得掉进「未分类的失败」', async () => {
  const { classifyFailure } = await fresh();
  const missing = [];
  for (const [code] of EMITTED) {
    const c = classifyFailure(code, '');
    if (c.code !== code || !c.cause || c.cause.includes('未分类')) missing.push(code);
    else if (!c.advice || !('heal' in c)) missing.push(`${code}（缺 advice/heal 字段）`);
  }
  assert.deepStrictEqual(missing, [], `以下回写码没有真诊断，弹层只会说「未分类」：\n  ${missing.join('\n  ')}`);
});

test('诊断文案要能落到行动：鉴权类才把用户支去设置，接口类不得假装是 Cookie 问题', async () => {
  const { classifyFailure, isAuthFailure } = await fresh();
  for (const code of ['PLATFORM_CHANGED', 'BAD_PARAMS', 'UNKNOWN_SOURCE', 'FETCH_FAILED', 'INTERNAL_ERROR']) {
    const c = classifyFailure(code, '');
    assert.notStrictEqual(c.heal, 'settings', `${code} 不是 Cookie 问题，别把用户骗去设置页`);
    assert.ok(!isAuthFailure(code), `${code} 不该掉进鉴权清单（批量重试会白跑）`);
    assert.ok(!/cookie|登录/i.test(c.cause + c.advice), `${code} 的诊断文案在提 Cookie/登录，与根因无关`);
  }
  for (const code of ['VIP_REQUIRED', 'AUTH_EXPIRED', 'LOGIN_REQUIRED']) {
    assert.ok(isAuthFailure(code), `${code} 应仍在鉴权码清单里（162 的唯一一家）`);
  }
});
