/**
 * 设置页 MCP 卡片升级的静态守卫
 *
 * 三条钉：① 新入口都挂在 DOM 上且有 window 导出（漏一条 = 按钮点了没反应）；
 * ② 所有新文案走词典（settings.js 属 CONQUERED，欠账必须为 0）；
 * ③ 端口改动即时生效 —— 修掉既有缺陷：mcpPort 输入框没有 onchange，
 *    用户改完端口只点「启用服务」才应用，改完不点就等于没改。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { readSettingsView, isSettingsViewPath } = require('./helpers/settingsViewSource.js');
const ROOT = path.join(__dirname, '..');
const _readFile = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
// 设置视图已拆成多文件：读到 settings 相关路径时返回整视图（兼容层 + 子模块）源码
const read = (p) => (isSettingsViewPath(p) ? readSettingsView() : _readFile(p));
const HTML = read('src/renderer/index.html');
const SETTINGS = read('src/renderer/js/views/settings.js');
const ZH = JSON.parse(read('src/renderer/js/lang/zh.json'));
const EN = JSON.parse(read('src/renderer/js/lang/en.json'));

// 词典键抽取要防误伤：`addEventListener('change')`、`showToast('MCP: ')` 里的
// `t('...'` 会被裸正则当成取键，所以要求 t( 前面不是标识符字符，且键必须带点。
const usedKeys = (src) => [...src.matchAll(/(?:^|[^A-Za-z0-9_$.])t\('([^']+)'/g)]
  .map(m => m[1]).filter(k => /^[A-Za-z][\w]*([.\w]+)+$/.test(k));
const htmlKeys = (src) => [...src.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]);

test('新增宿主元素齐备且 id 唯一', () => {
  for (const id of ['mcpSnippetBox', 'mcpAuditList', 'mcpAuditLine', 'mcpPort']) {
    const n = (HTML.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert.strictEqual(n, 1, `id="${id}" 应恰好一处，实为 ${n}`);
  }
  assert.match(HTML, /onchange="applyMcpPort\(\)"/, '端口输入框没有即时生效入口');
});

test('四个新函数都定义了也都被挂上 window', () => {
  for (const fn of ['applyMcpPort', 'copyMcpSnippet', 'loadMcpAudit', 'clearMcpAudit']) {
    assert.match(SETTINGS, new RegExp(`function ${fn}\\(`), `${fn} 未定义`);
    assert.match(SETTINGS, new RegExp(`window\\.${fn} = ${fn};`), `${fn} 未挂 window，onclick 打不到`);
  }
});

test('设置页 MCP 段落不出现中文字面量（CONQUERED 欠账须为 0）', () => {
  // 拆分后「MCP 段落」就是 views/settings/mcp.js 这个物理文件，直接整文件当段落
  const seg = fs.readFileSync(path.join(ROOT, 'src/renderer/js/views/settings/mcp.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(seg.length > 200 && seg.length < 6000, `MCP 段落切片不靠谱（${seg.length} 字节），钉要重看`);
  // logger 的参数不是用户可见文案（全仓日志一律中文），注释也不算 —— 只抓界面串
  const bad = seg.split('\n')
    .filter(l => !/logger\./.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
    .flatMap(l => l.match(/['"`][^'"`\n]*[\u4e00-\u9fff][^'"`\n]*['"`]/g) || []);
  assert.deepStrictEqual(bad, [], 'MCP 段落里出现中文字面量，应走 t():\n' + bad.join('\n'));
});

test('用到的词典键在两本词典里都存在（漏一本 = 英文界面显示键名）', () => {
  const keys = new Set(usedKeys(SETTINGS).concat(htmlKeys(HTML)));
  const missing = [...keys].filter(k => ZH[k] === undefined || EN[k] === undefined);
  assert.deepStrictEqual(missing, [], '缺键：' + missing.join(', '));
});

test('新增 MCP 文案键确实存在且非空（防止只加键名不加译文）', () => {
  for (const k of ['settings.general.mcpSnippetLabel', 'settings.general.mcpSnippetCopy',
    'settings.general.mcpAuditTitle', 'settings.general.mcpAuditEmpty', 'settings.general.mcpAuditClear',
    'settings.general.mcpStatusRunning', 'settings.general.mcpStatusOff',
    'toast.mcpSnippetCopied', 'toast.mcpAuditCleared', 'toast.mcpPortApplied']) {
    assert.ok(typeof ZH[k] === 'string' && ZH[k].length > 1, `zh 缺键或空：${k}`);
    assert.ok(typeof EN[k] === 'string' && EN[k].length > 1, `en 缺键或空：${k}`);
  }
});

test('审计与片段走 IPC 而不是渲染层自己拼 JSON/读文件', () => {
  assert.match(SETTINGS, /invoke\('mcp-audit'/);
  assert.match(SETTINGS, /invoke\('mcp-audit-clear'/);
  assert.match(SETTINGS, /invoke\('mcp-connect-snippet'/);
});

test('审计文本用 textContent 渲染，绝不 innerHTML（外部 Agent 传进来的任意串）', () => {
  const start = SETTINGS.indexOf('function loadMcpAudit');
  assert.ok(start >= 0, 'loadMcpAudit 找不到，落点变了？');
  const body = SETTINGS.slice(start, SETTINGS.indexOf('\n}', SETTINGS.indexOf('mcpAuditList', start)));
  const code = body.split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.ok(body.length > 100 && body.length < 2500, `函数体切片不靠谱（${body.length} 字节），钉要重看`);
  assert.match(code, /textContent/, '审计列表没用 textContent');
  assert.ok(!/innerHTML/.test(code), '审计列表用了 innerHTML —— 设置页就成了外部进程注入 HTML 的入口');
});
