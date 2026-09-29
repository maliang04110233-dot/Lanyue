/**
 * 守卫：3-B 跨源聚合的 IPC 接线
 *
 * 纯函数层在 test/crossSourceAggregate.test.js；本文件钉**接线事实**：
 *   1. 通道在契约里声明，且是 main invoke；
 *   2. preload 从契约**动态**生成 API（buildContractArg 注入白名单），
 *      所以「是否暴露」取决于契约与 register 的对账，而不是 grep preload；
 *   3. handler 已注册（契约声明却没人注册 ⇒ assertContractCoverage 启动即抛）；
 *   4. 聚合是**只读**的：不得写 prefs、不得改歌单数组；
 *   5. 单源失败要降级回报，而不是整体失败；
 *   6. 默认路径零网络（聚合本地红心）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const CONTRACT = read('src/shared/ipcContract.js');
const IPC = read('src/main/ipc/playlist.js');
const PRELOAD = read('src/main/preload.js');

const CH = 'aggregate-cross-source';
const METHOD = 'aggregateCrossSource';

/** 剥掉块注释与行注释：handler 里解释「为什么这么写」的注释含有
 *  禁用词（prefs.set / ensureFavorites），裸 grep 会把注释当成代码。 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * handler 函数体（已剥注释）
 *
 * 结尾必须靠**花括号配对**找，不能用 indexOf('\n  });')：本文件 handler 里
 * 有嵌套块，第一个 '  });' 往往落在函数体内部，切片会一路吃进下一个 handler，
 * 把别人的写操作算到自己头上（误报过一次）。深度归零的 } 才是真结尾。
 */
function handlerBody() {
  const i = IPC.indexOf(`handle('${CH}'`);
  assert.ok(i > -1, `ipc/playlist.js 未注册 ${CH}`);
  let depth = 0;
  let started = false;
  for (let k = i; k < IPC.length; k++) {
    const ch = IPC[k];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') {
      depth--;
      if (started && depth === 0) return stripComments(IPC.slice(i, k + 1));
    }
  }
  throw new Error('handler 花括号不配对，源文件可能被改坏');
}

// ── 1. 契约声明 ───────────────────────────────────────

test('契约：通道已声明且为 main invoke', () => {
  const m = CONTRACT.match(new RegExp(`'${CH}':\\s*\\{[^}]*\\}`));
  assert.ok(m, `契约里找不到 ${CH}`);
  assert.match(m[0], /invoke:\s*MAIN/, '应为 main invoke');
});

test('契约：参数规格已声明（opts 走 t.obj，不放行任意值）', () => {
  const m = CONTRACT.match(new RegExp(`'${CH}':\\s*\\{[^}]*\\}`));
  assert.match(m[0], /'opts',\s*t\.obj\(\)/, 'opts 应声明为 t.obj()，与仓库其他对象参数一致');
});

test('契约：METHODS 里已挂上 camelCase 方法名（preload 靠它生成 api.<method>）', () => {
  assert.match(CONTRACT, new RegExp(`${METHOD}:\\s*'${CH}'`), `METHODS 缺 ${METHOD}`);
});

// ── 2. preload 暴露：动态生成，不是静态清单 ────────────

test('preload：从契约动态生成 API（因此新增通道自动暴露，无需改 preload）', () => {
  // 判据是「preload 不该有手写通道清单」这条纪律本身
  assert.match(PRELOAD, /--ipc-contract=/, 'preload 应从 argv 读契约');
  assert.match(PRELOAD, /new Set\(contract\.invoke\)/, 'preload 应用契约构建 invoke 白名单');
  // 确认 preload 里没有硬编码的 aggregate 通道（那会与契约脱钩）
  assert.ok(!PRELOAD.includes(CH), `preload 不该硬编码 ${CH}：它是契约派生的`);
});

test('preload：契约里的每个 main invoke 都会成为 api 上的方法', () => {
  // 粗粒度但有效：preload 必须遍历 contract.methods 生成 api
  assert.match(PRELOAD, /contract\.methods|methods\)/, 'preload 应遍历契约 methods 生成 API');
});

// ── 3. handler 已注册 ─────────────────────────────────

test('主进程：handler 已注册（契约声明却没人注册 ⇒ assertContractCoverage 启动即抛）', () => {
  assert.match(IPC, new RegExp(`handle\\('${CH}'`), `ipc/playlist.js 未注册 ${CH}`);
});

test('主进程：playlist 模块确实被装载（否则 handler 白写）', () => {
  // ipc/playlist 由 main/index.js require 并调 register()；
  // src/main/ipc/register.js 只做契约对账与 envelope 包装，不装载业务模块。
  const MAIN = read('src/main/index.js');
  assert.match(MAIN, /require\('\.\/ipc\/playlist'\)/, 'main/index.js 应 require ipc/playlist');
  assert.match(MAIN, /ipcPlaylist\.register\(\)/, 'main/index.js 应调用 ipcPlaylist.register()');
});

// ── 4. 只读纪律 ───────────────────────────────────────

test('只读：聚合 handler 不得写 prefs', () => {
  const body = handlerBody();
  assert.ok(!/prefs\.set\(/.test(body), '聚合不得写 prefs');
  assert.ok(!/ensureFavorites\(\)/.test(body),
    'ensureFavorites() 会在红心单缺失时建单（写操作），只读路径不该用它');
});

test('只读：聚合 handler 不得改动歌单数组', () => {
  const body = handlerBody();
  assert.ok(!/\.splice\(|\.unshift\(/.test(body), '聚合不得改动歌单数组');
});

test('只读：不得注册任何写类通道', () => {
  const body = handlerBody();
  for (const bad of ['save-user-playlist', 'delete-user-playlist', 'add-to-user-playlist',
    'remove-from-user-playlist', 'toggle-favorite', 'set-pref']) {
    assert.ok(!body.includes(`handle('${bad}'`), `聚合是只读的，不该注册 ${bad}`);
  }
});

// ── 5. 降级纪律 ───────────────────────────────────────

test('降级：单个来源失败按空列表处理，并在 failed 里回报（不整体失败）', () => {
  const body = handlerBody();
  assert.match(body, /catch\s*\(/, '必须有 catch');
  assert.match(body, /failed\.push\(/, '失败来源应记入 failed 回报给渲染层');
  assert.ok(!/throw\s+/.test(body), '单个源失败不该向上抛（会让整个聚合白屏）');
});

test('降级：opts 垃圾值不得让 handler 崩', () => {
  const body = handlerBody();
  assert.match(body, /!Array\.isArray\(opts\)/, 'opts 应先做类型守卫再取属性');
});

// ── 6. 默认路径零网络 ─────────────────────────────────

test('默认路径零网络：只有显式传 playlists 才拉平台歌单', () => {
  const body = handlerBody();
  assert.match(body, /if\s*\(Array\.isArray\(o\.playlists\)\s*&&\s*o\.playlists\.length\)/,
    '只有显式指定歌单才应走网络拉取');
  assert.match(body, /FAVORITES_ID/, '默认应聚合本地红心');
});

// ── 7. 与纯函数层的接线 ───────────────────────────────

test('接线：handler 真的调用了聚合器与代表条目挑选', () => {
  const body = handlerBody();
  assert.match(body, /aggregateAcrossSources\(/, '未调用聚合器');
  assert.match(body, /pickRepresentative\(/, '未挑代表条目');
});

test('接线：ipc/playlist.js 已 require 聚合器', () => {
  assert.match(IPC, /require\('\.\.\/\.\.\/utils\/crossSourceAggregate'\)/, '未 require 聚合器');
});
