/**
 * 下载目录入口从侧栏搬进设置页「下载」模块
 *
 * 侧栏那块（label + 路径 + 更改目录按钮）是全站唯一能改 saveDir 的地方，但它占着侧栏贴底
 * 一整块位置。搬进设置页本身没有难点，难点全在**搬完还剩半条链**：
 *   · app.js 有两处按 id 写路径（启动回填 + 改完即时刷新），只要页面上还有第二个同名 id，
 *     getElementById 命中文档里第一个，另一处会永远停在「加载中...」——不报错，只是永远假。
 *   · renderer-audit 用 `<div class="save-dir">` 当侧栏区块的**右边界**，块一删 indexOf 返回 -1，
 * slice 就从末尾取，那三条侧栏结构钉会静默改变截取范围（c084172 那类"存在性钉"陷阱）。
 * · 词条改名必须 zh/en 成对，否则「键集合一致」钉红（教训）。
 * 所以这里的钉：入口位置 + 单一 id + 两处写入 + 键成对 + 旧样式清零。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const HTML = read('src/renderer/index.html');
const APP_JS = read('src/renderer/js/app.js');
const LAYOUT_CSS = read('src/renderer/styles/layout.css');
const OVERLAY_CSS = read('src/renderer/styles/overlays.css');
const ZH = read('src/renderer/js/lang/zh.json');
const EN = read('src/renderer/js/lang/en.json');

/** 侧栏区块：从 .sidebar 开标签到内容区开标签（右边界不再依赖已搬走的下载目录块） */
function sidebarSlice() {
  const start = HTML.indexOf('<div class="sidebar">');
  const end = HTML.indexOf('<div class="content">');
  assert.ok(start >= 0 && end > start, '侧栏区块截取失败（锚点改名时同步本测试）');
  return HTML.slice(start, end);
}

/** 设置页「下载」卡片区块 */
function downloadPageSlice() {
  const start = HTML.indexOf('id="settingsPageDownload"');
  const end = HTML.indexOf('id="settingsPageAppearance"');
  assert.ok(start >= 0 && end > start, '下载设置页截取失败');
  return HTML.slice(start, end);
}

// ── ① 入口位置：侧栏清干净，设置页接上 ──────────────────
test('侧栏不再有下载目录块（changeSaveDir / saveDirText / .save-dir 三者全退）', () => {
  const sb = sidebarSlice();
  assert.ok(!sb.includes('changeSaveDir'), '侧栏还留着更改目录按钮 = 没搬走');
  assert.ok(!sb.includes('saveDirText'), '侧栏还留着路径节点');
  assert.ok(!sb.includes('class="save-dir"'), '侧栏还留着 save-dir 容器');
});

test('设置页下载卡片：路径节点 + 更改目录按钮 + 提示，且路径在默认音质之前', () => {
  const dl = downloadPageSlice();
  const at = dl.indexOf('data-i18n="settings.general.downloadDir"');
  assert.ok(at >= 0, '下载目录行没找到');
  const row = dl.slice(at, at + 400); // 窗口刻意小于到「默认音质」的距离：三样必须都在本行内
  assert.match(row, /id="saveDirText"/, '路径节点没搬进设置页');
  assert.match(row, /onclick="changeSaveDir\(\)"/, '更改目录按钮没搬进设置页');
  assert.match(row, /data-i18n="settings\.general\.downloadDirHint"/, '缺提示：换目录不搬旧文件这件事得说明');
  const quality = dl.indexOf('data-i18n="settings.general.defaultQuality"');
  assert.ok(at < quality, '下载目录应是下载模块第一行（落点先于音质与命名）');
});

// ──  单一 id：两处写入必须命中同一个节点 ────────────────
test('#saveDirText 全页只有一处（两处会让 app.js 只写中第一个，另一处永远停在「加载中...」）', () => {
  assert.strictEqual((HTML.match(/id="saveDirText"/g) || []).length, 1);
});

test('app.js 两处写入仍指向 saveDirText：启动回填 + 改完即时刷新', () => {
  const writes = APP_JS.match(/getElementById\('saveDirText'\)\.textContent/g) || [];
  assert.strictEqual(writes.length, 2, `写入点应为 2 处（启动回填 + changeSaveDir 后刷新），实际 ${writes.length}`);
  const changeBody = APP_JS.slice(APP_JS.indexOf('async function changeSaveDir()'));
  assert.match(changeBody.slice(0, 600), /getElementById\('saveDirText'\)\.textContent = d;/,
    '改完目录没刷新界面 = 用户以为没生效，又点一次');
  assert.match(changeBody.slice(0, 600), /api\.setPref\('saveDir', d\)/, '改了不存 = 重启回退');
});

// ── ③ 词条：旧键扫净，新键 zh/en 成对 ───────────────────
test('lang：sidebar.downloadDir/changeDir 已退役，settings.general.* 三键中英成对', () => {
  for (const [name, src] of [['zh', ZH], ['en', EN]]) {
    assert.ok(!src.includes('"sidebar.downloadDir"'), `${name} 残留 sidebar.downloadDir（孤儿键）`);
    assert.ok(!src.includes('"sidebar.changeDir"'), `${name} 残留 sidebar.changeDir（孤儿键）`);
    for (const k of ['settings.general.downloadDir', 'settings.general.changeDir', 'settings.general.downloadDirHint']) {
      assert.ok(src.includes(`"${k}"`), `${name} 缺 ${k}`);
    }
  }
});

// ── ④ 样式随入口搬家，不留死规则 ───────────────────────
test('layout.css 不再定义 .save-dir / .sidebar .btn-sm；路径样式落在设置样式里', () => {
  assert.ok(!/\.save-dir\b/.test(LAYOUT_CSS), '侧栏样式里留着已不存在的 .save-dir 规则');
  assert.ok(!LAYOUT_CSS.includes('.sidebar .btn-sm'), '该规则只服务于搬走的按钮');
  assert.match(OVERLAY_CSS, /\.setting-path\s*\{[^}]*word-break:\s*break-all/, '路径要能折行看全（省略号会藏掉落点）');
});

// ──  反漂移：侧栏结构钉的右边界不许指回已删掉的块 ──────
test('renderer-audit 的侧栏右边界不再依赖 .save-dir（删块会让 indexOf 返回 -1，slice 从末尾取）', () => {
  const audit = read('test/renderer-audit.test.js');
  assert.ok(!audit.includes("html.indexOf('<div class=\"save-dir\">')"),
    '侧栏区块右边界还钉在已删除的 .save-dir 上 —— 三条侧栏结构钉的截取范围会静默变形');
  assert.ok(audit.includes("html.indexOf('<div class=\"content\">')"),
    '右边界应改为内容区开标签');
});
