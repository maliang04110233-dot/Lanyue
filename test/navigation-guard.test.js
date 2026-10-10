/**
 * navigation-guard.test.js — Electron 导航/弹窗守卫回归（P2-11）
 *
 * 为什么是静态分析而非 Electron 集成测试：仓内 devDependencies 无 spectron/playwright，
 * node --test 也起不动 BrowserWindow。沿用 eq-behaviour/platform-contract 的手法：
 * 扫描源码文本断言结构（所有扫描前 stripComments，注释里的说明不算代码证据）。
 *
 * 被守卫的三个窗口（安全审计引入的 M1/M3 守卫）：
 *   1. 主窗口 index.js    —— will-navigate 白名单（包内 file: 或同源 http）+ setWindowOpenHandler 一律 deny
 *   2. 登录子窗口 loginWindow.js —— will-navigate 限 cookieDomains 域 + setWindowOpenHandler 限域
 *   3. 二级窗口 ipc/window.js（桌面歌词 / 迷你播放器）—— will-navigate 一律 preventDefault + setWindowOpenHandler 一律 deny
 *
 * 判据要点（防回退成「任意导航放行」）：
 *   · file: 导航必须经 fileURLToPath + path.relative 收窄到 app.getAppPath() 包内
 *     （原先任意本机 HTML 都能载入挂着全量特权 IPC 的主窗口 = 完整攻击链）
 *   · 同源判断不能写成 u.origin === cur.origin（file: 页 origin 恒为 'null'，会误放行）
 *   · 两处 deny 分支（非法 URL / !isLocal && !sameHttpOrigin）都要 preventDefault
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const LOGIN = stripComments(read('src/main/loginWindow.js'));
const WINDOW = stripComments(read('src/main/ipc/window.js'));
const WIN_MGR = stripComments(read('src/main/windowManager.js'));
// 主窗口的守卫已从 index.js 拆到 windowManager.js（v1.0.36 架构整理）
const MAIN_WIN_SRC = WIN_MGR;

// ── 主窗口：will-navigate 守卫 ─────────────────────────────
test('主窗口：注册了 will-navigate 监听', () => {
  assert.ok(
    /mainWindow\.webContents\.on\('will-navigate'/.test(MAIN_WIN_SRC),
    '主窗口 must attach will-navigate；没有它渲染层 location/window.open 可把窗口导向任意 URL',
  );
});

test('主窗口：非法 URL 分支会 preventDefault', () => {
  const m = /if\s*\(\s*!u\s*\)\s*\{[^}]*event\.preventDefault\(\)/.exec(MAIN_WIN_SRC);
  assert.ok(m, 'URL 解析失败时必须 event.preventDefault() 拒绝导航');
});

test('主窗口：file: 导航经 fileURLToPath + path.relative 收窄到应用包内（M1）', () => {
  assert.ok(/require\('url'\)/.test(MAIN_WIN_SRC) && /fileURLToPath/.test(MAIN_WIN_SRC),
    '必须用 fileURLToPath 把 file: URL 还原成真实路径');
  assert.match(MAIN_WIN_SRC, /path\.relative\(\s*path\.resolve\(app\.getAppPath\(\)\)/,
    '必须相对 app.getAppPath() 计算，禁止任意本机 file: 路径');
  // 收窄判据：相对路径不以 .. 开头且不是绝对路径
  assert.match(MAIN_WIN_SRC, /!rel\.startsWith\('\.\.'\)/, '包外路径（以 .. 开头）必须被排除');
  assert.match(MAIN_WIN_SRC, /!path\.isAbsolute\(rel\)/, '跨盘符绝对路径必须被排除');
});

test('主窗口：同源判断不是 u.origin === cur.origin（file: 页 origin 恒为 "null"）', () => {
  // 危险写法：直接比 origin 会把所有 file: 导航（origin==='null'）误判成同源
  assert.doesNotMatch(MAIN_WIN_SRC, /u\.origin\s*===\s*cur\.origin/,
    '不能直接比 origin：file: 页的 origin 恒为字符串 "null"，会把越界 file: 导航误放行');
  assert.match(MAIN_WIN_SRC, /sameHttpOrigin/,
    '必须有显式的 sameHttpOrigin 白名单（协议+host 都相等，且当前页必须是 http/https）');
  assert.match(MAIN_WIN_SRC, /cur\.protocol === 'http:' \|\| cur\.protocol === 'https:'|cur\.protocol === 'https:' \|\| cur\.protocol === 'http:'|cur\.protocol === 'http:'/,
    '当前页必须是 http(s) 才谈得上「同源」（dev 模式 vite 刷新需要）');
});

test('主窗口：非白名单分支 (!isLocal && !sameHttpOrigin) 会 preventDefault', () => {
  const m = /if\s*\(\s*!isLocal\s*&&\s*!sameHttpOrigin\s*\)\s*\{[^}]*event\.preventDefault\(\)/.exec(MAIN_WIN_SRC);
  assert.ok(m, '既不在包内、又不同源的导航必须 preventDefault 拒绝');
});

// ── 主窗口：setWindowOpenHandler ───────────────────────────
test('主窗口：setWindowOpenHandler 一律返回 { action: \'deny\' }', () => {
  const m = /mainWindow\.webContents\.setWindowOpenHandler\(\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\)/.exec(MAIN_WIN_SRC);
  assert.ok(m, '主窗口必须注册 setWindowOpenHandler');
  assert.match(m[1], /deny/, '主窗口不允许任何 window.open 弹出（渲染层被注入时 window.open 可指向钓鱼页）');
  assert.doesNotMatch(m[1], /action:\s*'allow'/, '主窗口绝不允许 allow');
});

// ── 登录子窗口（M3）─────────────────────────────────────────
test('登录窗口：will-navigate 限域（hostAllowed），非白名单域名 preventDefault', () => {
  assert.match(LOGIN, /loginWin\.webContents\.on\('will-navigate'/, '登录窗口必须挂 will-navigate');
  assert.match(LOGIN, /function hostAllowed|const hostAllowed/, '必须有 hostAllowed 白名单判据');
  // 判据基于 cookieDomains，不是裸 hostname 白名单
  assert.match(LOGIN, /config\.cookieDomains\.some/, '白名单必须来自该平台配置的 cookieDomains');
  // 拒绝分支
  const m = /if\s*\(\s*!ok\s*\)\s*\{[\s\S]*?event\.preventDefault\(\)/.exec(LOGIN);
  assert.ok(m, '越域导航必须 preventDefault（原先只有弹窗守卫，will-navigate 不设防 = 可被诱导读其他域 Cookie）');
});

test('登录窗口：setWindowOpenHandler 返回 deny，允许的弹出改为同窗口 loadURL', () => {
  const m = /loginWin\.webContents\.setWindowOpenHandler\(\([^)]*\)\s*=>\s*\{([\s\S]*?)\}\)/.exec(LOGIN);
  assert.ok(m, '登录窗口必须注册 setWindowOpenHandler');
  assert.match(m[1], /deny/, '弹出必须一律 deny');
  // 允许域内跳转时用 loadURL 在本窗口完成，而不是 allow 弹新窗
  assert.match(m[1], /loadURL/, '允许的域内跳转应改为同窗口 loadURL，而非 allow');
});

test('登录窗口：使用独立 partition 会话（M3，不共用 defaultSession）', () => {
  assert.match(LOGIN, /partition:\s*`login-\$\{platform\}`|partition:\s*'login-|partition:\s*`login-/,
    '登录 Cookie 必须隔离在 login-${platform} 分区，clearStorageData 才不会误清其他站点');
});

// ── 二级窗口：桌面歌词 + 迷你播放器（ipc/window.js）───────
test('二级窗口：桌面歌词 will-navigate 一律 preventDefault + setWindowOpenHandler deny', () => {
  assert.match(WINDOW, /desktopLyricWin\.webContents\.on\('will-navigate',\s*\(event\)\s*=>\s*event\.preventDefault\(\)\)/,
    '桌面歌词窗口只加载本地固定页面，任何导航一律拒绝');
  assert.match(WINDOW, /desktopLyricWin\.webContents\.setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/,
    '桌面歌词窗口必须 deny 所有弹窗');
});

test('二级窗口：迷你播放器 will-navigate 一律 preventDefault + setWindowOpenHandler deny', () => {
  assert.match(WINDOW, /miniPlayerWin\.webContents\.on\('will-navigate',\s*\(event\)\s*=>\s*event\.preventDefault\(\)\)/,
    '迷你播放器窗口只加载本地固定页面，任何导航一律拒绝');
  assert.match(WINDOW, /miniPlayerWin\.webContents\.setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/,
    '迷你播放器窗口必须 deny 所有弹窗');
});

test('二级窗口：使用最小 preload（preload-secondary），不暴露特权 IPC', () => {
  const count = (WINDOW.match(/preload-secondary\.js/g) || []).length;
  assert.ok(count >= 2, `桌面歌词与迷你播放器都必须走 preload-secondary（实际 ${count} 处）`);
  assert.doesNotMatch(WINDOW, /preload:\s*path\.join\(__dirname, '\.\.\/\.\.\/preload\/preload\.js'\)/,
    '二级窗口不得复用主窗口的全量特权 preload（含 delete-file/save-cookie 等通道）');
});

// ── 守卫自检：扫描器确实能匹配目标（防正则写坏静默失效）──
test('守卫自检：四个窗口的 will-navigate 计数 = 4（主+登录+歌词+迷你）', () => {
  const sources = [MAIN_WIN_SRC, LOGIN, WINDOW];
  let total = 0;
  for (const s of sources) total += (s.match(/\.on\('will-navigate'/g) || []).length;
  assert.strictEqual(total, 4,
    `will-navigate 应恰好出现在 4 个窗口（主/登录/歌词/迷你），实际 ${total} —— 多出即第二套窗口未守卫，少掉即守卫被删`);
});

test('守卫自检：setWindowOpenHandler 计数 = 4', () => {
  const sources = [MAIN_WIN_SRC, LOGIN, WINDOW];
  let total = 0;
  for (const s of sources) total += (s.match(/setWindowOpenHandler/g) || []).length;
  assert.strictEqual(total, 4,
    `setWindowOpenHandler 应恰好 4 处，实际 ${total}`);
});
