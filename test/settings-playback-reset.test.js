/**
 * 「恢复所有设置」真正清掉第二批播放偏好（音量/倍速/淡入淡出/队列完成后动作）
 *
 * 症状（承诺与兑现的落差，与 177 的表外语言、179 的表外均衡器同族）：
 * 确认弹窗写着「恢复所有设置为默认值」，而它实际只按 GENERAL_PREFS 那张表逐项写回默认 ——
 * 音量、倍速、淡入淡出、队列完成后动作这四个偏好压根不在表里（它们没有设置页控件，
 * 家在播放器上：音量滑条 / 倍速按钮 / 更多菜单的淡入淡出档位 / 🏁 完成后动作菜单），
 * 于是按完「恢复默认」：
 *   D1 音量仍停在用户上次拖到的 15%，重启后照旧（prefs.playerVolume 原样躺着）；
 *   D2 倍速仍是 2x —— 用户以为"恢复默认"会把播放速度还回来，其实没有；
 *   D3 淡入/淡出仍是他上一轮试出来的 2s；
 *   D4 最坏的一档：**队列完成后动作仍是「关机」** —— 清 pref 而不调 _action，
 *      下一次队列跑完照样倒计时关机；若按下恢复默认时 60 秒倒计时正在跑，
 *      恢复默认连那次关机都拦不住。
 *
 * 修法（179 的打法，一处行为一个家）：每个旋钮的"默认态"由它自己那份实现负责 ——
 * player.js 出 resetPlaybackPrefs()、fade.js 出 resetFadeSettings()、
 * afterQueueDone.js 出 resetAfterQueueAction()（顺手 cancelAfterQueueCountdown() 拦下在跑的倒计时），
 * resetAllSettings 只负责"叫各家归位"，不把键抄进重置清单（抄清单正是 158 干掉的东西）。
 *
 * 分工：fade.js（自带纪律「本文件不得 import 任何带顶层 window 的模块」）与 afterQueueDone.js
 * 在 Node 里可直接 import ⇒ 走真行为测；player.js 顶层造 Audio/读 DOM，伪不起整棵 DOM ⇒
 * 走源码形状钉（并顺手钉"默认值只有一处字面量、playerVolume 只有一个写盘家"）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const countOf = (s, sub) => s.split(sub).length - 1;

/** 取函数体（声明行到下一个顶层 `\n}\n`）—— 够用且失败会响 */
function fnBody(src, decl) {
  const at = src.indexOf(decl);
  assert.ok(at > -1, `源码里找不到 ${decl}`);
  const end = src.indexOf('\n}\n', at);
  assert.ok(end > -1, `${decl} 的结束括号没找到`);
  return src.slice(at, end + 3);
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

/** 淡入淡出只需要两个徽标节点 + 全局 api/showToast */
function fadeDom() {
  const badges = {
    fadeInVal: { textContent: '关' },
    fadeOutVal: { textContent: '关' },
  };
  global.document = { getElementById: (id) => badges[id] || null };
  global.window = { addEventListener: () => {} };
  const prefs = {};
  global.api = {
    setPref: async (k, v) => { prefs[k] = v; return true; },
    getPref: async (k) => prefs[k],
  };
  global.showToast = () => {};
  return { prefs, badges };
}

/** 完成后动作：标签节点 + 记 setPref/systemPower 的 api 桩 */
function aqdDom(seedAction) {
  const label = { textContent: '无' };
  global.document = {
    getElementById: (id) => (id === 'afterQueueLabel' ? label : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
    readyState: 'complete',
    body: { appendChild: () => {} },
  };
  const prefs = { afterQueueDone: seedAction };
  const calls = { setPref: [], systemPower: [] };
  global.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: '' },
    setTimeout,
    clearTimeout,
    api: {
      setPref: async (k, v) => { calls.setPref.push([k, v]); prefs[k] = v; return true; },
      getPref: async (k) => prefs[k],
      systemPower: async (a) => { calls.systemPower.push(a); return true; },
    },
  };
  global.api = global.window.api;
  global.showToast = () => {};
  return { prefs, calls, label };
}

const freshFade = () => import('../src/renderer/js/player/fade.js?tc=' + Math.random());
const freshAqd = () => import('../src/renderer/js/afterQueueDone.js?tc=' + Math.random());

// ── 真行为：淡入/淡出 ──────────────────────────────────────

test('淡入淡出试过档位后按恢复默认：两笔 pref 归零且两个徽标同时回到「关」', async () => {
  const dom = fadeDom();
  const fade = await freshFade();
  assert.equal(typeof fade.resetFadeSettings, 'function',
    'fade.js 没出默认态那份实现 —— 恢复默认就够不着它');
  fade.cycleFadeIn();
  fade.cycleFadeIn();          // 0 → 500 → 1000
  fade.cycleFadeOut();         // 0 → 500
  assert.equal(dom.prefs.fadeInMs, 1000, '前置条件：淡入确实被调到 1s');
  assert.equal(dom.badges.fadeInVal.textContent, '1s');

  fade.resetFadeSettings();
  await flush();
  assert.equal(dom.prefs.fadeInMs, 0, 'fadeInMs 必须写回默认 0');
  assert.equal(dom.prefs.fadeOutMs, 0, 'fadeOutMs 必须写回默认 0');
  assert.equal(dom.badges.fadeInVal.textContent, '关', '徽标要跟着改口，否则界面还在说 1s');
  assert.equal(dom.badges.fadeOutVal.textContent, '关');
});

test('resetFadeSettings 复用既有的两个徽标家，不自己写 textContent', () => {
  const src = read('src/renderer/js/player/fade.js');
  const body = fnBody(src, 'export function resetFadeSettings()');
  assert.match(body, /_setBadge\(\)/);
  assert.match(body, /_setOutBadge\(\)/);
  assert.ok(!/textContent/.test(body),
    '徽标文案的家在 _setBadge/_setOutBadge，抄第二份必然与档位表漂移');
});

// ── 真行为：队列完成后动作 ─────────────────────────────────

test('完成后动作是「关机」时恢复默认：pref 与内存里的 _action 一起归「无」，且绝不触发 systemPower', async () => {
  const dom = aqdDom('shutdown');
  const aqd = await freshAqd();
  assert.equal(typeof aqd.resetAfterQueueAction, 'function',
    'afterQueueDone.js 没出默认态那份实现');

  // 前置：走一次真实入口让模块把 pref 读进 _action（否则"标签显示无"是恒真的假钉）。
  // 用 afterQueueObserve 而不是 openAfterQueueMenu：后者要拉起 contextMenu 的浮层 DOM；
  // 前者与 _ensureAction 同路，空队列不会误触发动作
  aqd.afterQueueObserve([]);
  await flush();
  assert.equal(dom.label.textContent, '关机',
    '前置条件不成立：_action 没被装载，这条测就测不到"内存状态没跟着归零"那个真症状');

  aqd.resetAfterQueueAction();
  await flush();
  const wrote = dom.calls.setPref.find(([k]) => k === 'afterQueueDone');
  assert.ok(wrote, '没有写回 afterQueueDone —— 只清内存的话重启后仍是「关机」');
  assert.equal(wrote[1], 'none');
  assert.equal(dom.label.textContent, '无',
    '标签读的是 _action：它没跟着归零 = 本次会话内下一次队列跑完照样关机');
  assert.deepEqual(dom.calls.systemPower, [],
    '恢复默认本身绝不能执行那个被取消的动作');
});

test('resetAfterQueueAction 先拦下在跑的 60 秒倒计时，且标签走 _renderLabel 一家', () => {
  const src = read('src/renderer/js/afterQueueDone.js');
  const body = fnBody(src, 'function resetAfterQueueAction()');
  assert.match(body, /cancelAfterQueueCountdown\(\)/,
    '倒计时已在跑时按恢复默认，必须把这一次关机/睡眠也掐掉');
  assert.match(body, /_renderLabel\(\)/);
  assert.ok(!/textContent/.test(body), '标签文案的家是 _renderLabel');
});

// ── 源码形状：音量与倍速（player.js 伪不起整棵 DOM）──────────

test('音量/倍速的默认值只有一处字面量（0.8 与 1.0 不许再各抄一份）', () => {
  const src = read('src/renderer/js/player.js');
  assert.match(src, /const DEFAULT_VOLUME = 0\.8;/, '默认音量该有名字（它出现在初始化、静音回退、恢复默认三处）');
  assert.match(src, /const DEFAULT_PLAYBACK_RATE = 1(?:\.0)?;/, '默认倍速该有名字');
  assert.ok(!/audio\.volume = 0\.8/.test(src),
    '初始化处该写 DEFAULT_VOLUME，而不是第二份 0.8');
  assert.ok(!/\|\| 0\.8\)/.test(src),
    '静音回退处该写 DEFAULT_VOLUME');
});

test('resetPlaybackPrefs 委派既有的 setVolume/_applyPlaybackRate，不直接摸 audio.volume', () => {
  const src = read('src/renderer/js/player.js');
  const body = fnBody(src, 'export function resetPlaybackPrefs()');
  assert.match(body, /setVolume\(DEFAULT_VOLUME \* 100\)/,
    '音量滑条/百分比/图标的家在 setVolume，绕开它就是第四份实现');
  assert.match(body, /_applyPlaybackRate\(\)/, '倍速按钮文案与 aria 的家在 _applyPlaybackRate');
  assert.match(body, /api\.setPref\('playbackRate'/, '倍速要当场落盘（它没有防抖，写盘就在切换处）');
  assert.ok(!/audio\.volume\s*=/.test(body),
    '直接摸 audio.volume 会漏掉滑条与百分比标签（于是"恢复了但界面没说"）');
});

test('playerVolume 只有一个写盘家（防抖与退出前 flush 共用同一函数）', () => {
  const src = read('src/renderer/js/player.js');
  assert.equal(countOf(src, "setPref('playerVolume'"), 1,
    '两处内联写盘 = 恢复默认时不知道该叫哪一家落笔（防抖那 600ms 里的重置可能根本不落盘）');
  const body = fnBody(src, 'export function resetPlaybackPrefs()');
  assert.match(body, /_flushVolumePersist\(\)/,
    '恢复默认必须立刻落盘：音量是 600ms 防抖写的，按完就关窗会丢掉这次重置');
});

// ── 源码形状：设置页接线与承诺 ─────────────────────────────

test('resetAllSettings 叫齐四个家的默认态实现（音量倍速/淡入淡出/完成后动作/均衡器）', () => {
  const src = read('src/renderer/js/views/settings.js');
  const body = fnBody(src, 'async function resetAllSettings()');
  ['resetPlaybackPrefs', 'resetFadeSettings', 'resetAfterQueueAction', 'resetEq'].forEach((fn) => {
    assert.match(body, new RegExp('window\\.' + fn + '\\(\\)'),
      `少了 ${fn}()：这家住在表外，恢复默认就永远够不着它`);
  });
  assert.ok(!/setPref\('fadeInMs'|setPref\('playerVolume'|setPref\('playbackRate'|setPref\('afterQueueDone'/.test(body),
    '重置清单不许把表外键抄进来（158 的规矩：叫各家的 applyDefault，而不是替它写）');
});

test('确认弹窗点名它会复原哪些播放偏好（157 的 F2 纪律：承诺要说全）', () => {
  const src = read('src/renderer/js/views/settings.js');
  const body = fnBody(src, 'async function resetAllSettings()');
  // 文案的家搬到词典了，所以"叫什么"和"说了什么"分两截钉
  assert.match(body, /askConfirm\(\s*t\('toast\.resetConfirm'\)\s*\)/,
    '确认弹窗必须按键取词，不许在源码里手抄中文');
  const said = String(require('../src/renderer/js/lang/zh.json')['toast.resetConfirm']);
  assert.ok(said.length > 10, '词典里取不到确认弹窗的文案');
  ['音量', '倍速', '淡入', '淡出', '完成后', '均衡器'].forEach((w) => {
    assert.ok(said.includes(w), `确认文案少了「${w}」——用户会以为恢复默认不会动它`);
  });
});

test('播放控件与设置页的这几个接线不引入契约外的 api 调用（零新 IPC 通道）', () => {
  const { METHODS, CHANNELS } = require('../src/shared/ipcContract');
  const files = [
    'src/renderer/js/player.js',
    'src/renderer/js/player/fade.js',
    'src/renderer/js/afterQueueDone.js',
    'src/renderer/js/views/settings.js',
  ];
  for (const f of files) {
    const src = read(f);
    const used = [...src.matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)].map((m) => m[1])
      .filter((k) => k !== 'invoke');
    const bad = [...new Set(used.filter((k) => !(k in METHODS)))];
    assert.deepEqual(bad, [], `${f} 里契约外的 api 方法：${bad.join(', ')}`);
    const invoked = [...src.matchAll(/\bapi\.invoke\(\s*'([^']+)'/g)].map((m) => m[1]);
    const badCh = [...new Set(invoked.filter((c) => !(c in CHANNELS)))];
    assert.deepEqual(badCh, [], `${f} 里契约外的通道：${badCh.join(', ')}`);
  }
});

test('三个新的默认态实现都挂上 window（settings.js 靠这个名字找到它们）', () => {
  assert.match(read('src/renderer/js/player/fade.js'), /window\.resetFadeSettings = resetFadeSettings/);
  assert.match(read('src/renderer/js/afterQueueDone.js'), /window\.resetAfterQueueAction = resetAfterQueueAction/);
  assert.match(read('src/renderer/js/player.js'), /window\.resetPlaybackPrefs = resetPlaybackPrefs/);
});
