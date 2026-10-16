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

const { readSettingsView, isSettingsViewPath } = require('./helpers/settingsViewSource.js');
const R = (...p) => path.join(__dirname, '..', 'src', 'renderer', ...p);
const _readFile = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');
// 设置视图已拆成多文件：读到 settings 相关路径时返回整视图（兼容层 + 子模块）源码
const read = (...p) => (isSettingsViewPath(p.join('/')) ? readSettingsView() : _readFile(...p));
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

// ── ③ 播放流程只有报错才提示（2026-10-13）────────────────────
// 原先这里钉的是另一件事：「播放取流 toast 的『音源』不许被无差别替换改成『平台』」
// （防病句被误伤）。产品决策变成「只有报错才提示」后，那两条正常态提示
// （正在准备音源 / 正在播放）与它们的词条一起被删掉，钉子的前提不复存在。
//
// 于是把它改写成一条**约束力更强**的钉子：播放与取链接这两条自动流程里，
// 不许再出现任何正常态 toast。原来的钉子防"文案被改坏"，现在这条防"提示被加回来"
// —— 后者正是用户实际抱怨的东西（每切一首歌弹两条，糊住半屏）。
//
// 保留的仍是「用户主动操作的回执」（已复制 / 已删除 / 下载完成…）：那些是
// "你点的那一下到底生效没有"的答案，不是自动流程的播报。判据写在这里，
// 免得下一次又有人按"提示越少越好"把它们一起清掉。

test('播放/取链接流程不得再弹正常态 toast（只有报错才提示）', () => {
  const BANNED = ['toast.preparingSource', 'toast.nowPlaying',
    'toast.fetchingLink', 'toast.linkReady'];
  for (const f of [
    ['js', 'app.js'],
    ['js', 'views', 'home.js'],
    ['js', 'views', 'search.js'],
    ['js', 'views', 'playlist.js'],
  ]) {
    const src = read(...f);
    for (const key of BANNED) {
      assert.ok(!src.includes(key), `${f.join('/')} 又出现了 ${key}：自动流程不该播报正常态`);
    }
    // 字面量那一侧同样：早先 home/search 用的是中文字面量，不是词典键。
    // 匹配前必须剥注释 —— app.js 里有一条**注释**叫「队列面板定位正在播放：…」，
    // 直接扫原文会命中那段说明文字而误报（同本仓"注释中的 :hover 被计入统计"那一类坑）。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
    for (const lit of ['正在准备音源', '正在播放：', '正在获取', '已获取下载链接']) {
      assert.ok(!code.includes(lit), `${f.join('/')} 又出现了「${lit}」这条自动流程播报`);
    }
  }
  // 词条也必须清干净（toast-i18n 的孤儿词条门禁会再兜一层，这里先说清意图）
  for (const key of BANNED) {
    assert.strictEqual(dict('zh')[key], undefined, `zh.json 仍留着已废弃的 ${key}`);
    assert.strictEqual(dict('en')[key], undefined, `en.json 仍留着已废弃的 ${key}`);
  }
});
