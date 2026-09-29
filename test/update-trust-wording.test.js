/**
 * 守卫：更新信任链的**对外表述**必须与代码事实一致（W3）
 *
 * 这条守卫防的是一种特定的静默失效：措辞说「已启用签名校验 / 防线已立」，
 * 而代码里 verifyUpdateCodeSignature 因产物无 publisherName 而空转。
 * 后来的维护者读文档，不读 electron-updater 源码，于是判错风险已关闭。
 *
 * 钉三件事：
 *   1. 设置页常驻提示存在、中英双语齐备，且不含「已启用」类表述；
 *   2. 失败路径**不得**显示「已是最新版本」；
 *   3. 上述两条的判据本身有效（否定对照）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const HTML = read('src/renderer/index.html');
const ZH = JSON.parse(read('src/renderer/js/lang/zh.json'));
const EN = JSON.parse(read('src/renderer/js/lang/en.json'));
const CONFIG = read('build/config.cjs');
const UPDATER_SRC = read('src/main/updater.js');

const KEY = 'settings.about.updateSecurityHint';

// ── 1. 设置页常驻提示 ─────────────────────────────────

test('设置页「关于」有常驻的更新安全提示', () => {
  assert.match(HTML, new RegExp(`data-i18n="${KEY.replace(/\./g, '\\.')}"`),
    `index.html 里没有 ${KEY} 的挂载点`);
});

test('常驻提示挂在检查更新按钮所在的卡片里（不是浮在别处）', () => {
  const i = HTML.indexOf('id="checkUpdateBtn"');
  assert.ok(i > -1, '找不到检查更新按钮');
  const window = HTML.slice(i, i + 2000);
  assert.match(window, new RegExp(KEY.replace(/\./g, '\\.')),
    '提示未与检查更新按钮同处一张卡片，用户在更新相关位置看不到它');
});

test('中英双语都提供该提示', () => {
  assert.ok(typeof ZH[KEY] === 'string' && ZH[KEY].trim(), `zh.json 缺 ${KEY}`);
  assert.ok(typeof EN[KEY] === 'string' && EN[KEY].trim(), `en.json 缺 ${KEY}`);
});

test('提示如实写明「未启用」，且不出现「已启用签名」类表述', () => {
  // 「当前未启用」里的「启用」二字不等于「已启用」——用完整短语判，别用单词判
  for (const [name, text] of [['zh', ZH[KEY]], ['en', EN[KEY]]]) {
    assert.match(text, /未启用|not currently/i, `${name} 提示未写明当前未启用`);
    for (const banned of ['已启用签名', '签名校验已', '已加固更新', '已修复', '防线已立']) {
      assert.ok(!text.includes(banned), `${name} 提示含禁用表述「${banned}」（事实相反）`);
    }
  }
});

test('配置注释不得把「开关开着」写成「防护有效」', () => {
  // 事实：无证书 ⇒ 产物无 publisherName ⇒ 该开关不产生实际约束
  assert.match(CONFIG, /当前未启用安装包签名校验/,
    'build/config.cjs 的 verifyUpdateCodeSignature 旁缺少「当前未启用」的如实说明');
});

// ── 2. 失败路径不得显示「已是最新版本」 ─────────────────

test('「已是最新版本」只挂在 update-not-available 事件上', () => {
  // 危险写法：把「已是最新版本」也用作检查失败的兜底文案。
  // 正确做法：失败走 showFailure，把原因念给用户听。
  const src = read('src/renderer/js/updater.js');
  const occurrences = (src.match(/已是最新版本/g) || []).length;
  assert.equal(occurrences, 1, `「已是最新版本」出现 ${occurrences} 次，应只出现在 update-not-available 分支`);
  assert.match(src, /handleUpdateNotAvailable\(\)\s*\{[\s\S]{0,300}已是最新版本/,
    '「已是最新版本」应只由 handleUpdateNotAvailable 渲染');
});

test('检查失败走 showFailure，措辞带原因前缀而非成功语义', () => {
  const src = read('src/renderer/js/updater.js');
  assert.match(src, /if\s*\(!result\.success\)\s*\{\s*\n?\s*showFailure\(/,
    '检查失败未走 showFailure');
  assert.match(src, /result\.error\s*\|\|\s*'未知错误'/,
    '失败文案未带上主进程给的原因');
});

// ── 3. 否定对照：判据本身有效 ─────────────────────────

test('否定对照：禁用词检测确实能抓住「已启用签名校验」', () => {
  const banned = ['已启用签名', '签名校验已', '已加固更新', '已修复', '防线已立'];
  const bad = '已启用签名校验，请放心安装';
  assert.ok(banned.some((b) => bad.includes(b)), '禁用词表漏了这条典型错误表述');
});

test('否定对照：「未启用」不该被误判为禁用表述', () => {
  // 单用「启用」二字判会把正确文案也拦下，所以判据必须是完整短语
  const banned = ['已启用签名', '签名校验已', '已加固更新', '已修复', '防线已立'];
  const good = '当前更新包未启用安装包签名校验，请仅从官方渠道获取。';
  assert.ok(!banned.some((b) => good.includes(b)), '正确文案被禁用词表误伤');
});

test('否定对照：设置页提示检测对缺失的 key 确实会红', () => {
  const probe = (h) => new RegExp(KEY.replace(/\./g, '\\.')).test(h);
  assert.equal(probe(HTML), true, '当前 HTML 应当命中');
  assert.equal(probe('<div>没有这段</div>'), false, '判据对缺失挂载点必须不命中');
});

// ── 4. 事实钉仍与配置一致 ─────────────────────────────

test('事实钉：配置开关与 RECORDED_STATE 仍一致（采购证书后此处会红）', () => {
  const src = read('test/update-signature-guard.test.js');
  const m = src.match(/verificationEffective:\s*(true|false)/);
  assert.ok(m, 'update-signature-guard.test.js 里找不到 RECORDED_STATE.verificationEffective');
  const hasCert = /certificateFile|certificateSubjectName|cscLink|signtoolOptions|azureSignOptions/
    .test(CONFIG);
  assert.equal(
    m[1] === 'true',
    hasCert,
    `RECORDED_STATE 说校验${m[1] === 'true' ? '已生效' : '未生效'}，但配置里${hasCert ? '有' : '没有'}证书配置。`
      + '证书到位时请一并更新 RECORDED_STATE、配置注释与设置页提示。',
  );
  assert.ok(UPDATER_SRC.includes('update-error'), '失败事件通道仍在，守卫的前提成立');
});
