/**
 * 批④ 低危清扫 + 中危余项（2026-09 第二轮审计 M2/M6/M11/M12 + 低危余项）
 *
 * 行为可测的进各自领域测试文件（urlGuard/bilibili/playCache）；
 * 本文件收静态结构断言 —— 锚定修复后的结构特征防回归，不证明行为。
 * 坑：doesNotMatch 断言会被修复说明注释里的字面量绊倒，注释措辞避开锚点。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');

// ── 主进程 ──────────────────────────────────────────────────

test('checkLocal: catch 内 items 必须先验数组（非数组入参时 catch 自身二抛，IPC 整体 reject）', () => {
  const src = read('main', 'ipc', 'checkLocal.js');
  assert.match(src, /catch \(e\) \{[\s\S]{0,250}Array\.isArray\(items\)/,
    'catch 里的兜底返回本身要先防 items 非数组');
});

test('cookieStore: 写盘必须 tmp+rename 原子化（崩溃留半截 JSON 丢全部登录态）', () => {
  const src = read('utils', 'cookieStore.js');
  assert.match(src, /\.tmp/, '先写临时文件');
  assert.match(src, /renameSync/, '再原子改名');
});

test('history: 损坏重建必须处置 -shm（旧 WAL/SHM 与新库错配）', () => {
  const src = read('utils', 'history.js');
  assert.match(src, /-shm/, '重建路径要清理或一并迁移 wal/shm 伴生文件');
});

test('downloader: 跨 host 重定向必须剥 Referer/Cookie（登录态不随 302 扩散，对齐 playCache B22）', () => {
  const src = read('utils', 'downloader.js');
  assert.match(src, /function stripCrossHostHeaders\(/, '需要跨站头过滤助手');
  assert.match(src, /stripCrossHostHeaders\(extraHeaders, url, nextUrl\)/,
    '重定向递归处调用');
});

test('onlineCover: 每跳过 urlGuard、重定向有上限、body 有体积上限', () => {
  const src = read('utils', 'onlineCover.js');
  assert.match(src, /assertPublicHttpUrl/, '封面源 URL 不可信，需 SSRF 校验');
  assert.match(src, /MAX_REDIRECTS/, '重定向递归要有次数上限');
  assert.match(src, /MAX_IMAGE_BYTES/, '图片 body 要有大小上限');
});

test('ai-music: 计费 LLM 调用禁自动重试（chatcompletion_v2 三处都要 retries:0）', () => {
  const src = read('api', 'ai-music.js');
  const n = (src.match(/retries: 0/g) || []).length;
  assert.ok(n >= 4, `计费接口 retries:0 应至少 4 处（music_generation + 3 处 chatcompletion），当前 ${n}`);
});

test('ai-music: 历史写入必须串行化（并发生成多版本时读改写互相覆盖丢条目）', () => {
  const src = read('api', 'ai-music.js');
  assert.match(src, /_historyChain/, 'addToHistory 走 promise 链串行化');
});

test('ai-music 取消链路：request 支持 signal + IPC cancel 通道 + 渲染层传 requestId', () => {
  assert.match(read('api', 'request.js'), /options\.signal/,
    '请求层要能被 AbortSignal 打断');
  const contract = read('shared', 'ipcContract.js');
  assert.match(contract, /'ai-cancel-generation'/, '契约要注册取消通道');
  assert.match(contract, /aiCancelGeneration/, 'METHODS 映射要暴露给渲染层');
  const ipc = read('main', 'ipc', 'ai-music.js');
  assert.match(ipc, /ai-cancel-generation/, '主进程要注册取消 handler');
  assert.match(ipc, /AbortController/, 'ai-generate-music 期间持有可中止的 controller');
  const view = read('renderer', 'js', 'views', 'ai-music.js');
  assert.match(view, /requestId/, '生成调用要带 requestId');
  assert.match(view, /aiCancelGeneration\(/, '取消要通知主进程，不能只改 UI');
});

test('订阅：歌手检查更新必须透传 platform（否则按 id 形态猜平台会路由错源）', () => {
  assert.match(read('main', 'subscriptions.js'),
    /api\.getSingerSongs\(entry\.targetId, SINGER_LIMIT, entry\.platform\)/,
    '订阅条目带着 platform，丢弃它等于每次更新都换一次源');
  assert.match(read('api', 'recommendations.js'),
    /async function getSingerSongs\(singerMid, limit = 30, platform = ''\)/,
    '门面要接受 platform，显式指定时直达 gateway 不再按 SOURCE_PREFERENCE 猜');
});

test('退出时必须立即落盘挂起的播放队列（防抖窗口内的变更在退出时直接丢）', () => {
  const src = read('main', 'index.js');
  assert.match(src, /flushPlayQueueNow\(\);/, 'window-all-closed 里要同步冲刷');
});

// ── 渲染层 ──────────────────────────────────────────────────

test('home: fetchSection 在 await 后必须重读平台状态（reloadPlatform 会整体替换状态对象）', () => {
  const src = read('renderer', 'js', 'views', 'home.js');
  assert.match(src, /const st2 = _platState\(plat\);/, 'await 之后重新取当前状态对象');
  assert.match(src, /st2\.sections\[meta\.sec\] = data;/, '成功写当前对象');
  assert.match(src, /st2\.fail\+\+/, '失败计数同样写当前对象');
});

test('home: 榜单行回查必须带歌曲 id 校验（弹窗快照与 live 数组错位时点 A 播 B）', () => {
  const src = read('renderer', 'js', 'views', 'home.js');
  assert.match(src, /function _resolveSectionSong\(/, '按下标+id 双重解析的助手');
  assert.match(src, /playRecommendById\('\$\{escQ\(meta\.sec\)\}',\$\{i\},'\$\{escQ\(s\.id\)\}'\)/,
    '行模板要把歌曲 id 一起烘焙进回调');
});

test('nameBatch: 勾选态必须落在 _rows（换一换全量重绘会把用户取消的勾选复位）', () => {
  const src = read('renderer', 'js', 'views', 'nameBatch.js');
  assert.match(src, /onchange="_nbSetCheck\(/, 'checkbox 变更要回写数据');
  assert.match(src, /r\.checked/, '勾选态存行对象');
  assert.doesNotMatch(src, /\$\{c \? 'checked' : ''\}/,
    '模板恒写 checked = 忽略用户取消');
});

test('history: 下一页必须受总页数约束（可无限翻到空页）', () => {
  const src = read('renderer', 'js', 'views', 'history.js');
  assert.match(src, /function historyNextPage\(\) \{[^}]*Math\.min/,
    '翻页前按已知总页数钳制');
});

test('ai-music 历史 tab：迟到回包必须带序号守卫（切走后覆盖当前 tab 内容）', () => {
  const src = read('renderer', 'js', 'views', 'ai-music.js');
  const n = (src.match(/_historyRenderSeq/g) || []).length;
  assert.ok(n >= 2, '渲染入口自增 + 回包校验，至少两处引用');
});

test('converter: 行内格式下拉选中项必须跟随 item.format（此前恒显默认格式）', () => {
  const src = read('renderer', 'js', 'views', 'converter.js');
  assert.match(src, /f\.value === item\.format \? ' selected' : ''/);
});

test('shortcuts: 帮助弹窗要能切换且 Esc 可关；Ctrl 组合不得被输入框焦点挡掉', () => {
  const src = read('renderer', 'js', 'shortcuts.js');
  assert.match(src, /if \(overlay\) \{\s*overlay\.remove\(\);\s*return;/,
    '帮助开着时按 ? 应关闭（toggle），不是移除后无条件重建');
  // 重钉：closeActiveModal 不再点名 shortcutsHelp（手抄清单已拆），
  // 「Esc 关帮助」改由注册表承载——创建点必须自报关闭契约，实弹行为见 modal-registry ⑧。
  assert.match(src, /overlay\.setAttribute\('data-modal-close', '-'\)/,
    '帮助浮层须登记 Esc 关闭契约（短横哨兵 = 注册表摘除本体）');
  assert.match(src, /if \(inInput && !ctrlOrCmd\) return;/,
    '输入框中只跳过非组合键，Ctrl+F/切歌/音量照常');
});

test('songGroups: 弹层必须按当前 state.songs 重解析下标（构建期快照会点 A 播 B）', () => {
  const src = read('renderer', 'js', 'songGroups.js');
  assert.match(src, /function _resolveVariantIdx\(/,
    '打开/渲染弹层时按 source+id 在当前结果里重解析下标');
});
