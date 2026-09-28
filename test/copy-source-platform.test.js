/**
 * 「音源 / 平台」用词收敛（设计走查 check-3 回写真 app）
 *
 * 来龙去脉：走查发现同一批服务（网易云/QQ/酷狗…）有两个称呼——结果过滤/取流
 * 语境叫「音源」，账号/配置语境叫「平台」，新手无法建立对应关系。
 * 真 app 走查实况后确认这个区分是刻意的（平台=服务本身；音源=一次取流的来源），
 * 处理按走查建议的分支一执行：区分保留，但
 * ① 账号语境里混进来的「音源」全部改回「平台」（设置页摘要两行就在
 *    「平台账号」标题下，两行内换词最刺眼；首页区块降级提示同理）；
 * ② 「音源」作为小标题级概念首次成规模出现处（设置页·源可用性）给桥接句
 *    「音源（即歌曲所在的平台）」；
 * ③ 顺手消灭一处腐烂文案：probeHint 在 zh/en 词典里写死「四个音源/four music
 *    sources」，而 v3 起平台清单由 manifest 自动发现，数量早已不是四个——
 *    词典值会覆盖 index.html 行内默认值，用户看到的正是陈旧的那份。
 *
 * 本测试锁三件事：账号语境零「音源」、桥接与去硬数字在 zh/en/HTML 三处同源、
 * 流语境的「音源」不许被无差别替换波及（"正在准备平台"是病句）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = (...p) => path.join(__dirname, '..', 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');
const dict = (lang) => JSON.parse(read('js', 'lang', `${lang}.json`));

// ── ① 账号语境：统一回「平台」 ─────────────────────────────

test('settings.js 全文不再出现「音源」——账号小节在「平台账号」标题下，两行内不许换词', () => {
  const src = read('js', 'views', 'settings.js');
  assert.ok(!src.includes('音源'),
    'settings.js 仍有「音源」：账号语境应叫「平台」（check-3 收敛点）');
});

test('设置页摘要与免登录标题的正向钉', () => {
  const src = read('js', 'views', 'settings.js');
  assert.ok(src.includes("' 个平台：'"), '摘要行应为「共 N 个平台：」');
  assert.ok(src.includes("' 个平台免登录直接下载'"), '免登录标题应为「N 个平台免登录直接下载」');
});

test('首页区块降级提示改口「平台」（JS 兜底文案 + 词典值同改）', () => {
  const home = read('js', 'views', 'home.js');
  assert.ok(home.includes('该区块暂无内容（平台可能暂时不可用）'));
  assert.ok(!home.includes('音源可能暂时不可用'),
    'home.js 仍留着「音源可能暂时不可用」——词典没改到时 JS 兜底会先露出来');
  assert.strictEqual(dict('zh')['home.sectionUnavailable'],
    '该区块暂无内容（平台可能暂时不可用）');
  assert.match(dict('en')['home.sectionUnavailable'], /the platform may be temporarily unavailable/);
});

// ── ② 桥接：源可用性小节首次成规模出现「音源」处 ────────────

test('probeHint（zh）给出桥接「音源（即歌曲所在的平台）」', () => {
  assert.match(dict('zh')['settings.sources.probeHint'],
    /音源（即歌曲所在的平台）/);
});

test('probeHint（en）给出对应桥接', () => {
  assert.match(dict('en')['settings.sources.probeHint'],
    /audio source \(i\.e\. the platform a song is on\)/);
});

test('probeHint 不再写死平台数量（v3 起清单由 manifest 发现，"四个"是腐烂文案）', () => {
  assert.doesNotMatch(dict('zh')['settings.sources.probeHint'], /四个/);
  assert.doesNotMatch(dict('en')['settings.sources.probeHint'], /four/i);
});

test('probeHint：index.html 行内默认值与 zh.json 逐字相等（一个文案只许有一个家）', () => {
  const html = read('index.html');
  const m = html.match(
    /data-i18n="settings\.sources\.probeHint">([^<]*)<\/p>/);
  assert.ok(m, 'index.html 里找不到 probeHint 的 <p>（结构变了要连测试一起搬家）');
  assert.strictEqual(m[1], dict('zh')['settings.sources.probeHint'],
    'HTML 默认值与词典分叉：applyTranslations 后用户看到词典版，行内那份就成了谎话');
});

// ── ③ 流语境的「音源」不许被误伤 ───────────────────────────

test('播放取流 toast 的「音源」原样保留（防无差别替换把病句钉死）', () => {
  // 已收编进语言包的两处（app.js 增量191、playlist.js 增量223）：源码只许留键名，
  // 词典值单独钉（见下）。两处都钉 —— 只钉词典，源码可以悄悄换键；只钉源码，词典可以悄悄改词。
  // 增量223 记账：此处原写「playlist.js 增量210」，而 210 已被 3761a15（取流失败分类补齐）
  // 占用 —— 全量交叉引用撞号会让后续审查对不上账，故随本批修复一起改到 223。
  for (const [f, owner] of [
    [['js', 'app.js'], 'app.js'],
    [['js', 'views', 'playlist.js'], 'playlist.js'],
  ]) {
    assert.ok(read(...f).includes("t('toast.preparingSource'"),
      `${owner} 不再取 toast.preparingSource 键（取词旁路了？）`);
  }
  // home/search 还没收编（LEDGER 在账），仍是字面量 —— 字面量这一侧继续钉「音源」不许被改成「平台」
  for (const f of [
    ['js', 'views', 'home.js'],
    ['js', 'views', 'search.js'],
  ]) {
    assert.ok(read(...f).includes('正在准备音源：'),
      `${f.join('/')} 的「正在准备音源」被误改了`);
  }
  assert.ok(dict('zh')['toast.preparingSource'].includes('音源'),
    'toast.preparingSource 的「音源」被无差别替换改成了「平台」（病句）');
});
