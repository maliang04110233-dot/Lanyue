/**
 * 守卫：3-A 电台的接线
 *
 * 纯函数层在 test/radio.test.js、取数层在 test/radioPool.test.js；
 * 本文件钉**接线事实**：
 *   1. IPC 通道已声明/已注册/计数已对账；
 *   2. player.js 在「队列耗尽」处接管，而不是别处；
 *   3. 关掉开关时行为与改动前完全一致（保守优先是本功能的核心纪律）；
 *   4. import 路径正确（相对层级写错时，只有实际 import 才会炸）；
 *   5. 开关 pref 在白名单里（否则用户改不动 = 死旋钮）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const CONTRACT = read('src/shared/ipcContract.js');
const IPC_DOWNLOAD = read('src/main/ipc/download.js');
const PLAYER = read('src/renderer/js/player.js');
const RADIO_VIEW = read('src/renderer/js/radio.js');
const RADIO_CORE = read('src/renderer/js/radioCore.js');
const PREFS = read('src/main/ipc/prefs.js');

const CH = 'radio-pool';
const M = 'radioPool';

// ── 1. 契约 ────────────────────────────────────────────

test('契约：radio-pool 已声明且为 main invoke', () => {
  const m = CONTRACT.match(new RegExp(`'${CH}':\\s*\\{[^}]*\\}`));
  assert.ok(m, `契约里找不到 ${CH}`);
  assert.match(m[0], /invoke:\s*MAIN/, '应为 main invoke');
});

test('契约：参数走 t.obj（seed/opts 都不放行任意值）', () => {
  const m = CONTRACT.match(new RegExp(`'${CH}':\\s*\\{[^}]*\\}`));
  assert.match(m[0], /'seed',\s*t\.obj\(\)/, 'seed 应为 t.obj()');
  assert.match(m[0], /'opts',\s*t\.obj\(\)/, 'opts 应为 t.obj()');
});

test('契约：METHODS 里已挂上 camelCase 方法名（preload 靠它生成 api.<method>）', () => {
  assert.match(CONTRACT, new RegExp(`${M}:\\s*'${CH}'`), `METHODS 缺 ${M}`);
});

test('契约：通道计数守卫已同步（漏改会让 ipc-contract 测试红）', () => {
  const t = read('test/ipc-contract.test.js');
  assert.match(t, new RegExp(`MAIN_INVOKE\\.size, \\d+\\); // \\+${CH}`),
    'MAIN_INVOKE 期望数未同步');
  assert.match(t, new RegExp(`Object\\.keys\\(METHODS\\)\\.length, \\d+\\); // \\+${M}`),
    'METHODS 期望数未同步');
});

// ── 2. handler ─────────────────────────────────────────

test('主进程：handler 已注册', () => {
  assert.match(IPC_DOWNLOAD, new RegExp(`handle\\('${CH}'`), `ipc/download.js 未注册 ${CH}`);
});

test('主进程：seed 垃圾值在 handler 层就有守卫（不下沉到取数层）', () => {
  const i = IPC_DOWNLOAD.indexOf(`handle('${CH}'`);
  assert.ok(i > -1, '找不到 handler');
  // 花括号配对找真结尾（indexOf('\n  });') 会切进嵌套块）
  let depth = 0, started = false, end = -1;
  for (let k = i; k < IPC_DOWNLOAD.length; k++) {
    if (IPC_DOWNLOAD[k] === '{') { depth++; started = true; }
    else if (IPC_DOWNLOAD[k] === '}') { depth--; if (started && depth === 0) { end = k; break; } }
  }
  const body = IPC_DOWNLOAD.slice(i, end + 1);
  assert.match(body, /!seed/, 'seed 缺失要挡住');
  assert.match(body, /typeof seed !== 'object'/, 'seed 类型要挡');
  assert.match(body, /Array\.isArray\(seed\)/, '数组 seed 要挡');
  assert.match(body, /fetchRadioPool\(/, 'handler 应委托取数层');
});

// ── 3. player.js 接线位置 ──────────────────────────────

test('player：nextSong 的「队列末尾」分支里才有电台接管', () => {
  const i = PLAYER.indexOf('export async function nextSong()');
  assert.ok(i > -1, '找不到 nextSong');
  const fn = PLAYER.slice(i, PLAYER.indexOf('\nexport ', i + 10) > -1
    ? PLAYER.indexOf('\nexport ', i + 10) : PLAYER.length);

  // 末尾判据必须是「playIdx >= playQueue.length - 1」那一条
  const stop = fn.indexOf('if (playIdx >= playQueue.length - 1) {');
  assert.ok(stop > -1, '找不到队列末尾判据');
  const radio = fn.indexOf('radioContinue');
  assert.ok(radio > stop, '电台接管必须在末尾判据**之内**，而不是别处');

  // 关掉开关时走原样：updatePlayStatsOnStop + pause + currentTime=0 + return 仍在
  assert.match(fn, /updatePlayStatsOnStop\(\);/, '停下逻辑必须保留');
  assert.match(fn, /audio\.currentTime = 0;/, '停下时必须重置进度');
});

test('player：电台候选接在队尾（不改 playIdx，下一次自然落到新曲）', () => {
  assert.match(PLAYER, /playQueue\.push\(\.\.\.picked\)/,
    '候选应 push 到队列尾部');
});

test('player：已播 key 收集只算播放位置之前的条目', () => {
  const i = PLAYER.indexOf('function _playedTrackKeys');
  assert.ok(i > -1, '缺 _playedTrackKeys');
  const fn = PLAYER.slice(i, PLAYER.indexOf('\n}', i));
  assert.match(fn, /Math\.min\(upto, playQueue\.length\)/, '应按 min(upto, length) 截断');
  assert.match(fn, /trackKey\(/, '应用 trackKey 归一');
});

test('player：trackKey 从同目录的 radioCore 取（渲染层不碰 src/utils）', () => {
  assert.match(PLAYER, /from '\.\/radioCore\.js';/,
    "player.js 应从 './radioCore.js' 取（渲染层与主进程共用的纯逻辑放 renderer/js 下）");
  assert.ok(!/from '\.\.\/\.\.\/utils\//.test(PLAYER),
    "渲染层不 import src/utils：那里全是 CJS，rollup 解析不出具名导出");
});

// ── 4. 渲染层模块 ─────────────────────────────────────

test('radio.js：从同目录的 radioCore 取（渲染层不碰 src/utils）', () => {
  assert.match(RADIO_VIEW, /from '\.\/radioCore\.js';/);
  assert.ok(!/from '\.\.\/\.\.\/utils\//.test(RADIO_VIEW), '不应 import src/utils');
});

test('radio.js：保守优先的三条否定判据都在', () => {
  assert.match(RADIO_VIEW, /shouldAutoContinue\(/, '必须走 shouldAutoContinue 判据');
  const { shouldAutoContinue } = require('../src/utils/radio');
  assert.equal(shouldAutoContinue({ enabled: false, seed: { title: 'A', id: '1', source: 'x' } }), false);
  assert.equal(shouldAutoContinue({ enabled: true, loopMode: 2, seed: { title: 'A', id: '1', source: 'x' } }), false);
});

test('radio.js：开关缺失时默认关闭（新增功能不该自己动起来）', () => {
  assert.match(RADIO_VIEW, /getState\('radioEnabled'\) === true/,
    '只有显式 true 才算开启');
});

test('radio.js：取候选的异常不得冒到播放器（降级为空）', () => {
  assert.match(RADIO_VIEW, /catch\s*\(/, 'radioContinue 缺 catch');
  assert.match(RADIO_VIEW, /return null;/, '失败应返回 null 让播放器按原样停下');
});

test('radio.js：重复请求合并（_radioLoading 守卫）', () => {
  assert.match(RADIO_VIEW, /_radioLoading/, '并发请求应有单飞守卫');
});

test('radio.js：同一种子复用缓冲，不重复打网络', () => {
  assert.match(RADIO_VIEW, /_radioSeedKey === seedKey/, '同种子应命中缓冲');
});

test('radio.js：诊断函数已挂 window（设置页/调试要用）', () => {
  for (const fn of ['isRadioEnabled', 'setRadioEnabled', 'loadRadioEnabled', 'getRadioStatus']) {
    assert.match(RADIO_VIEW, new RegExp(`window\\.${fn} = ${fn};`),
      `${fn} 未挂 window`);
  }
});

// ── 5. pref 接线 ───────────────────────────────────────

test('radioEnabled 在 set-pref 白名单里（否则用户改不动 = 死旋钮）', () => {
  assert.match(PREFS, /'radioEnabled'/, '未注册进 ALLOWED_PREF_KEYS');
});