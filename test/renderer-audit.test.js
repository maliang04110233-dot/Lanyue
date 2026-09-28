/**
 * 渲染层审计回归（2026-09 全方位审查的高危功能 bug）
 *
 * 渲染层模块顶层碰 document，node:test 无法真跑 ——
 * 沿用 renderer-contract.test.js 的静态源码断言约定，
 * 每条断言都对应一个「修好前必然失败」的真实缺陷。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = (...p) => path.join(__dirname, '..', 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

test('search.js: doSearch 必须 await handleLinkInput 并以返回值为准（返回值即「已接管」信号）', () => {
  const src = read('js', 'views', 'search.js');
  assert.match(src, /async function doSearch\(/, 'doSearch 需为 async');
  // 识别首个语句就是网络请求 → 必须 await；接管与否以返回值为准。
  // 早前用模块级 _linkHandled 传递，被剪贴板识别条留在 true 后会把下一次搜索静默吞掉。
  assert.match(src, /if \(await handleLinkInput\(/, '必须先 await 链接识别并消费返回值');
});

test('app.js: mockApi 只允许在浏览器预览(http)上下文兜底，打包 file:// 环境禁止假成功', () => {
  const src = read('js', 'app.js');
  assert.match(src, /allowMock\s*=\s*location\.protocol\.startsWith\('http'\)/,
    'buildApi 需按协议门禁 mock');
  assert.match(src, /allowMock \? Object\.assign\(\{\}, mockApi/,
    'mockApi 合并必须以 allowMock 为条件');
});

test('updater.js: downloadUpdate 必须真正 invoke download-update 通道（否则是 0% 假进度条）', () => {
  const src = read('js', 'updater.js');
  assert.match(src, /invoke\('download-update'\)/, '需要调用主进程 download-update handler');
});

test('settings.js: 下载模板 id 进 innerHTML 必须过 escQ/escAttr（外部快照可控 id 的 XSS 注入面）', () => {
  const src = read('js', 'views', 'settings.js');
  assert.doesNotMatch(src, /="\$\{tpl\.id\}"/, 'data-id 不得裸插 tpl.id');
  assert.doesNotMatch(src, /'\$\{tpl\.id\}'\)/, 'onclick 实参不得裸插 tpl.id');
  assert.match(src, /escQ\(tpl\.id\)/, 'onclick 实参应走 escQ');
  assert.match(src, /escAttr\(tpl\.id\)/, 'data-id 应走 escAttr');
});

// ── 中危批次：竞态范式 / referer 单源 / reset 派生 ──────────────

test('search.js: doSearchByType 必须有请求序号守卫（旧结果晚到不得覆盖新列表）', () => {
  const src = read('js', 'views', 'search.js');
  assert.match(src, /let _typeSearchReqId = 0;/);
  assert.match(src, /if \(reqId !== _typeSearchReqId\) return/, 'await 后必须校验序号再写状态');
});

test('local.js: scanLocalDir 必须加重入锁（连点/fs.watch 推送并发只允许一次扫描）', () => {
  const src = read('js', 'views', 'local.js');
  assert.match(src, /let _scanRunning = false;/);
  assert.match(src, /if \(_scanRunning\) return;/);
});

test('取流 referer 单源：utils.js 提供 playReferer，5 处调用点不得再各写三元链', () => {
  const utils = read('js', 'utils.js');
  assert.match(utils, /function playReferer\(/, 'utils.js 需有唯一 referer 判定入口');
  assert.match(utils, /window\.playReferer = playReferer;/);
  const files = [
    ['js', 'app.js'],
    ['js', 'player.js'],
    ['js', 'views', 'home.js'],
    ['js', 'views', 'playlist.js'],
    ['js', 'views', 'search.js'],
  ];
  for (const f of files) {
    const src = read(...f);
    assert.match(src, /playReferer\(/, `${f.join('/')} 必须改走 playReferer`);
    assert.doesNotMatch(src, /=== 'bilibili' \? 'https:\/\/www\.bilibili\.com\//,
      `${f.join('/')} 不应再复制 referer 三元链`);
  }
});

test('settings.js: resetAllSettings 必须由 GENERAL_PREFS 表派生默认值（手抄必漏）', () => {
  const src = read('js', 'views', 'settings.js');
  assert.match(src, /Object\.values\(GENERAL_PREFS\)/, '恢复默认需遍历派生自表');
  assert.doesNotMatch(src, /const defaults = \{\n\s*quality:/, '不得再手写 defaults 清单');
});

test('settings.js: WebDAV 保存时非本机 http 地址必须提示明文风险（不阻断）', () => {
  const src = read('js', 'views', 'settings.js');
  assert.match(src, /startsWith\('http:\/\/'\)/, '以 http:// 前缀判定明文传输');
  assert.match(src, /localhost/, '本机地址（localhost/127.x/[::1]）应豁免提示');
  // 增量194：那句话的家从源码字面量搬进了词典 —— 判据跟着搬，但两截都要钉住：
  // 调用点得真的按 warn 级把它说出来，词典里那句得真的讲"明文"。
  assert.match(src, /showToast\(\s*t\('toast\.webdavInsecure'\)\s*,\s*'warn'/,
    '非本机 http:// 保存时应给 warn 级 toast 提示，而不是静默保存');
  assert.ok(String(require('../src/renderer/js/lang/zh.json')['toast.webdavInsecure']).includes('明文'),
    '词典里的 webdavInsecure 不再讲明文风险了？');
});

test('settings.js: filenameTmpl 默认值必须与 naming.js DEFAULT_TEMPLATE 等值（渲染层无法 import，用等值钉）', () => {
  const { DEFAULT_TEMPLATE } = require('../src/utils/naming');
  const src = read('js', 'views', 'settings.js');
  const m = src.match(/filenameTmpl:\s*\{[^}]*default:\s*'([^']*)'/);
  assert.ok(m, 'GENERAL_PREFS 应含 filenameTmpl 默认值');
  assert.strictEqual(m[1], DEFAULT_TEMPLATE,
    '设置页手抄的模板默认值已与主进程命名模块漂移');
});

// ── 批②：渲染层死功能（2026-09 第二轮审计 H3/H4/H5/H6a/H6b/M13/local转换）──

test('local.js: 批量重命名的 path.* 必须来自 pathLite（渲染层无裸 path 全局，import node:path 会变裸 require 崩溃）', () => {
  const src = read('js', 'views', 'local.js');
  assert.match(src, /import \* as path from ['"]\.\.\/pathLite\.js['"]/,
    'nodeIntegration:false 下裸 path 是 undefined；node:path 经插件会变成裸 require，加载即崩');
  assert.doesNotMatch(src, /from ['"]node:path['"]/,
    'vite-plugin-electron-renderer 不 polyfill node 内建模块（bundle 实测 require("node:path")）');
});

test('download.js: 导出歌单必须接受 savePath（主进程终态写 savePath，filter s.filePath 恒空）', () => {
  const src = read('js', 'views', 'download.js');
  assert.match(src, /status === 'done' && \(s\.filePath \|\| s\.savePath\)/,
    '完成的队列项只有 savePath，按 filePath 筛永远导出为空');
  assert.match(src, /filePath: s\.filePath \|\| s\.savePath/,
    '导出条目同样需要回落 savePath');
});

test('local-stats.js: toggleDupSelect 实参必须走 escQ（esc 不转义反斜杠，Windows 路径在 onclick JS 字符串里被吃）', () => {
  const src = read('js', 'views', 'local-stats.js');
  assert.doesNotMatch(src, /toggleDupSelect\('\$\{esc\(/,
    'esc 输出进的是 JS 字符串字面量上下文，必须用 escQ');
  assert.match(src, /toggleDupSelect\('\$\{escQ\(/);
});

test('player.js: _playQueueIdx 链路必须经 playSongByIdx 取流播放（队列行永不携带 url，旧判断恒假）', () => {
  const player = read('js', 'player.js');
  assert.match(player, /export async function playQueueIdx\(/,
    'player.js 需导出 playQueueIdx 供队列行点击复用切歌链路');
  const app = read('js', 'app.js');
  assert.match(app, /playQueueIdx/, 'app.js 的 _playQueueIdx 应转调 playQueueIdx');
  assert.doesNotMatch(app, /queue\[idx\]\.url/, '队列行没有 url 字段，该分支恒假（H6a）');
});

test('virtualList.js: setData 必须强制重绘（同可视区间换数据——排序/过滤——非 force 渲染会早退成旧行）', () => {
  const src = read('js', 'virtualList.js');
  // 断言锚在 setData 函数体内（body 无嵌套花括号，[^}] 恰好圈住函数体）
  assert.match(src, /setData\(data\) \{[^}]*_render\(true\)/,
    'setData 后可视范围不变时 _render 无 force 早退，本地库排序/过滤失效错位');
});

test('download.js: 勾选不得双触发（input onchange 与容器 onclick 各 toggle 一次，净零）', () => {
  const src = read('js', 'views', 'download.js');
  assert.doesNotMatch(src, /onchange="event\.stopPropagation\(\);toggleDlSelect\(/,
    'input 的 click 冒泡到容器 onclick 已 toggle，onchange 再 toggle 一次 = 永远选不中');
});

test('local.js: 转码选中必须读本视图的 _selectedLocal（selectedSongs 是搜索页的状态，本地页恒空）', () => {
  const src = read('js', 'views', 'local.js');
  assert.doesNotMatch(src, /getState\('selectedSongs'\)/,
    'local.js 不该引用搜索页的 selectedSongs 状态');
  assert.match(src, /function _selectedSongsToConvert\(\) \{[\s\S]{0,500}_selectedLocal/,
    '转码选中应来自本视图的 _selectedLocal');
});

// ── 批③：播放链竞态（2026-09 第二轮审计 M7/M8/M9 + 定时停止反恢复）──

test('player.js: 恢复进度监听必须先移除旧监听再挂新（once 监听跨歌泄漏，歌A metadata 慢会把歌B seek 到A的位置）', () => {
  const src = read('js', 'player.js');
  assert.match(src, /function attachResumeSeekListener\(/,
    'loadAndPlay 两个分支各自裸 addEventListener loadedmetadata，需要统一的先删后挂助手');
  const uses = src.match(/attachResumeSeekListener\(/g) || [];
  assert.ok(uses.length >= 3,
    '助手定义 + 本地分支 + 网络分支至少三处出现，确保两分支都换了');
  assert.match(src, /removeEventListener\('loadedmetadata', _pendingResumeHandler\)/,
    '助手内必须先移除上一首歌遗留的监听再挂新的（M7）');
});

test('player.js: 歌词加载必须带请求序号守卫（快速切歌时慢响应的旧歌词覆盖新歌）', () => {
  const src = read('js', 'player.js');
  assert.match(src, /let _lyricRequestId = 0/, 'M8：歌词请求序号计数器');
  // 本地分支与网络分支的歌词块都应在 await 之后比对 reqId
  const guards = src.match(/reqId !== _lyricRequestId/g) || [];
  assert.ok(guards.length >= 2, '本地 readLocalLrc 与网络 getLyrics 两条歌词路径都要有守卫');
});

test('search.js: playSong 必须支持队列覆盖参数（batchPlay 传入勾选列表，不能被整页覆盖）', () => {
  const src = read('js', 'views', 'search.js');
  assert.match(src, /async function playSong\(idx, queueOverride = null\)/,
    'M9：playSong 增加队列参数');
  assert.match(src, /const songs = queueOverride \|\| getState\('songs'\)/,
    'song 查找优先用覆盖队列');
  assert.match(src, /setState\('playQueue', queueOverride \|\| songs\)/,
    '队列写入同样尊重覆盖，否则 batchPlay 的勾选列表被整页覆盖');
  assert.match(src, /playSong\(0, playList\)/, 'batchPlay 应把勾选列表传给 playSong');
});

test('player-controls.js: 定时到期只能暂停，不得调用 togglePlay（暂停态下调 togglePlay 会恢复播放，定时反而"停止失败"）', () => {
  const src = read('js', 'player-controls.js');
  const timerBlock = src.match(/if \(remain <= 0\) \{[\s\S]*?clearSleepTimer\(\);/);
  assert.ok(timerBlock, '未找到定时到期处理块');
  assert.doesNotMatch(timerBlock[0], /togglePlay/,
    'audio.pause() 后再 togglePlay 会把刚暂停的播放又续上');
  assert.match(timerBlock[0], /audio\.pause\(\)/, '到期必须主动 pause');
});

// ── 增量129：换库路径必须重套筛选（与 refreshLocalLibrary 同一约定）──

/** 剥注释后再扫描：本仓库有「注释里写代码示例」的惯例，不剥会把说明文字当成代码证据 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

test('自检: stripComments 生效（注释里的 setState 示例不得被当成代码）', () => {
  assert.ok(!stripComments("// setState('localFiltered', x)").includes("setState('localFiltered'"), '行注释未剥离');
  assert.ok(!stripComments("/* setState('localFiltered') */ let a = 1;").includes("setState('localFiltered'"), '块注释未剥离');
  assert.ok(stripComments("setState('localFiltered', y);").includes("setState('localFiltered'"), '代码被误剥离');
});

test('local.js: 凡写 localSongs 的路径必须随后调 filterLocalSongs（只写 localFiltered 会静默丢掉全部过滤轴）', () => {
  const lines = stripComments(read('js', 'views', 'local.js')).split('\n');
  const sites = [];
  lines.forEach((line, i) => {
    if (!line.includes("setState('localSongs'")) return;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      if (lines[j].includes('filterLocalSongs()')) { sites.push({ at: i + 1, ok: true }); return; }
      if (lines[j].includes("setState('localFiltered'")) { sites.push({ at: i + 1, ok: false, badAt: j + 1 }); return; }
    }
    sites.push({ at: i + 1, ok: false, badAt: null });
  });
  assert.ok(sites.length >= 3,
    `应找到至少 3 条写入 localSongs 的路径（重扫 / 重选目录后重扫 / fs.watch 自动刷新），实际 ${sites.length}`);
  for (const s of sites) {
    assert.ok(s.ok, s.badAt
      ? `local.js:${s.at} 写了 localSongs，随后却直接写 localFiltered（第 ${s.badAt} 行）——重扫后收藏/格式/音质/完整度/关键词全部轴静默失效，按钮还亮着`
      : `local.js:${s.at} 写了 localSongs，但 8 行内没有 filterLocalSongs()，新库不会重套筛选`);
  }
});

test('local.js: localFiltered 只允许由 filterLocalSongs 写入（多一处就多一条绕过过滤轴的路径）', () => {
  const code = stripComments(read('js', 'views', 'local.js'));
  const writes = (code.match(/setState\('localFiltered'/g) || []).length;
  assert.strictEqual(writes, 1, `local.js 里应只有 filterLocalSongs 一处写 localFiltered，实际 ${writes} 处`);
});

// ── 增量133：删重后的库变更必须重跑管线（回调注入管线入口，不是裸渲染器）──

/** 用花括号配平抽函数体（含首尾大括号）；扫描前请先 stripComments */
function fnBodyL(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

/** 渲染层全部视图模块（派生，不硬编码文件名——新增视图自动纳入扫描） */
const VIEW_FILES = fs.readdirSync(R('js', 'views')).filter((f) => f.endsWith('.js'));

test('回归钉：localFiltered 只允许由 filterLocalSongs 写入（扫全部视图文件，不只看 local.js）', () => {
  const counts = {};
  for (const f of VIEW_FILES) {
    const n = (stripComments(read('js', 'views', f)).match(/setState\('localFiltered'/g) || []).length;
    if (n) counts[f] = n;
  }
  assert.deepStrictEqual(counts, { 'local.js': 1 },
    'localFiltered 是 filterLocalSongs 算出的派生状态，只允许 local.js 写一次。'
    + '别的视图模块写它 = 绕过收藏/格式/音质/完整度/关键词全部过滤轴，'
    + `且只写一个容器（网格视图下不重绘）。实际写入分布：${JSON.stringify(counts)}`);
});

test('回归钉：库变更回调必须注入过滤管线入口，不得注入裸渲染器', () => {
  const src = stripComments(read('js', 'views', 'local.js'));
  const m = /setLibraryChangeHandler\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(src);
  assert.ok(m, 'local.js 必须注册库变更回调 —— local-stats 删重后靠它刷新界面');
  const fn = m[1];
  assert.ok(!/^render/.test(fn),
    `注入的是裸渲染器 ${fn}()：它只写一个容器，网格视图下删重后界面毫无变化`
    + '（歌曲已删、格子还在），且不重套过滤轴与排序。必须注入 filterLocalSongs()。');
  const body = fnBodyL(src, fn);
  assert.ok(body.includes('renderLocalGrid(') && body.includes('renderLocalSongs('),
    `注入的 ${fn}() 必须同时兼顾网格与列表两种视图（它是管线入口，不是单容器渲染器）`);
});

test('回归钉：删重只改源数据，不得就地改派生状态 localFiltered', () => {
  const body = fnBodyL(stripComments(read('js', 'views', 'local-stats.js')), 'deleteSelectedDups');
  assert.ok(body.includes('deleteFile'),
    'deleteSelectedDups 需调用 api.deleteFile（哨兵缺失，钉可能已失效）');
  assert.ok(!body.includes('localFiltered'),
    'deleteSelectedDups 不得碰 localFiltered：它是 filterLocalSongs 由五个过滤轴 + 排序算出的派生状态，'
    + '就地 splice 既绕过全部过滤轴，又让网格视图完全不重绘（删了歌、格子还在）');
  assert.match(body, /_onLibraryChanged\(\)/,
    'deleteSelectedDups 删除成功后必须触发库变更回调，否则列表/网格不会刷新');
});

// ── 增量159（审计 F2 收尾）：删重确认框必须诚实 —— 点名影响 + 给出真实退路 ──
test('删重确认框：点名个数与总大小、告知进系统回收站可还原；"不可撤销"谎话不得复活', () => {
  const src = read('js', 'views', 'local-stats.js');
  const body = fnBodyL(stripComments(src), 'deleteSelectedDups');
  assert.ok(!body.includes('不可撤销'),
    '旧文案「此操作不可撤销！」是谎话：delete-file 走 shell.trashItem（libraryIpc 集成测试钉死"移入回收站后原路径消失"），吓阻话术禁止复活');
  assert.match(body, /确认删除 \$\{count\} 个重复文件（共 \$\{sizeTxt\}）/, '确认框必须点名个数与总大小（F2：删除必见影响）');
  assert.ok(body.includes('formatBytes(totalSize)'), '总大小必须来自选中项 fileSize 汇总，不许拍脑袋');
  assert.ok(body.includes('系统回收站'), '确认框必须告知真实退路（可随时还原），而不是笼统"不可撤销"');
  assert.ok(body.includes('保留音质最好的一个版本'), '必须说清每组保留策略——删重最有价值的承诺（152 的自动选差）要在确认框里可见');
  assert.ok(body.includes('随时可还原'), '成功 toast 必须点名去处');
});

// ── 增量134：首页分区列表与「查看完整榜单」弹窗必须共用同一个过滤词 ──

test('home.js: 分区列表的计数必须来自过滤结果（用未过滤的 data.length 会让「查看完整榜单」在筛选后仍报全量）', () => {
  const body = fnBodyL(stripComments(read('js', 'views', 'home.js')), 'renderSection');
  assert.ok(body.includes('filterHomeSection('),
    'renderSection 需走 filterHomeSection 收敛（哨兵缺失，钉可能已失效）');
  const call = /listHtml\(([^)]*)\)/.exec(body);
  assert.ok(call, 'renderSection 需调用 listHtml');
  assert.ok(call[1].includes('pairs.length'),
    `listHtml 的计数实参必须来自过滤结果 pairs.length，实际「${call[1]}」——`
    + '用 data.length（未过滤总量）会让筛选后仍显示「共 N 首」，'
    + '且 N > LIST_FOLD 时按钮明明该消失却还在（点开只看到 2 首）');
  assert.ok(!call[1].includes('data.length'),
    'listHtml 的计数实参不得引用未过滤的 data.length');
});

test('home.js: 「查看完整榜单」弹窗必须应用同一个过滤词', () => {
  const body = fnBodyL(stripComments(read('js', 'views', 'home.js')), 'openHomeChartModal');
  assert.ok(body.includes('_getSection('),
    'openHomeChartModal 需从 _getSection 取分区数据（哨兵缺失，钉可能已失效）');
  assert.ok(body.includes('filterHomeSection('),
    'openHomeChartModal 必须用 filterHomeSection 收敛歌曲 —— 分区列表已按过滤词收敛，'
    + '弹窗却渲染全量时，用户筛出 3 首、点「查看完整榜单」会看到 30 首，前后自相矛盾且无任何提示');
  const call = /songRowsHtml\(\s*meta\s*,\s*([^)]*)\)/.exec(body);
  assert.ok(call, 'openHomeChartModal 需调用 songRowsHtml');
  assert.ok(call[1].includes('pairs'),
    `songRowsHtml 的歌曲实参必须是过滤结果 pairs（保留原始下标，playRecommendById 的索引语义不变），实际「${call[1]}」`);
  assert.ok(body.includes('home.filteredCount'),
    '有过滤词时必须显式写出「命中/总量」与筛选词，否则用户会以为榜单被截断');
});

test('lang: zh/en 词条必须完全对齐（缺键或占位符不一致会让界面漏出 key 或原样显示 {n}）', () => {
  const dir = path.join(__dirname, '..', 'src', 'renderer', 'js', 'lang');
  const zh = JSON.parse(fs.readFileSync(path.join(dir, 'zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
  const onlyZh = Object.keys(zh).filter((k) => !(k in en));
  const onlyEn = Object.keys(en).filter((k) => !(k in zh));
  assert.deepStrictEqual([onlyZh, onlyEn], [[], []],
    `双语词条键必须一一对应 —— 仅 zh 有：${onlyZh.join(', ') || '无'}；仅 en 有：${onlyEn.join(', ') || '无'}`);
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const bad = Object.keys(zh).filter((k) => k in en && ph(zh[k]) !== ph(en[k]));
  assert.deepStrictEqual(bad, [],
    `以下词条中英占位符不一致（某语言下会原样显示 {n} 之类）：${bad.join(', ')}`);
});

// ── 增量135：渲染函数不得反向回写源状态 ──

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');

/** 递归收集渲染层全部 .js（派生，不硬编码文件名——新增文件自动纳入扫描） */
function walkRendererJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkRendererJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('回归钉：render* 函数不得写 state（渲染只读；写状态属反向回写）', () => {
  const files = walkRendererJs(RENDERER_DIR);
  assert.ok(files.length >= 20, `只扫到 ${files.length} 个渲染层文件，本钉可能已失效`);

  const offenders = [];
  let scanned = 0;
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    const seen = new Set();
    // 含 `_render*`（本仓库私有渲染器多用下划线前缀，漏掉它等于漏掉一半）
    for (const m of code.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+(_?render[A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      scanned++;
      const writes = [...fnBodyL(code, name).matchAll(/(?:state\.set|setState)\(/g)].length;
      if (writes) {
        offenders.push(`${path.relative(RENDERER_DIR, f).replace(/\\/g, '/')} :: ${name}() 内 ${writes} 处`);
      }
    }
  }
  assert.ok(scanned >= 40, `只扫到 ${scanned} 个 render* 函数，本钉可能已失效`);
  assert.deepStrictEqual(offenders, [],
    'render* 是渲染函数，只应读 state 并画 DOM。写 state 会让「一次纯 UI 重绘」'
    + '静默改写全局状态，并掩盖真正的写入点（数据流方向被反转）。'
    + `实际：${offenders.join(' | ')}`);
});

test('接线钉：queueSnapshot 的唯一写入点是队列事件回调（app.js onQueueUpdated）', () => {
  const writers = [];
  for (const f of walkRendererJs(RENDERER_DIR)) {
    const n = (stripComments(fs.readFileSync(f, 'utf8')).match(/state\.set\(\s*'queueSnapshot'/g) || []).length;
    if (n) writers.push(`${path.relative(RENDERER_DIR, f).replace(/\\/g, '/')}:${n}`);
  }
  assert.deepStrictEqual(writers, ['js/app.js:1'],
    'queueSnapshot 是队列事件（app.js onQueueUpdated）的产物，应只有一个写入点。'
    + '多一处就是一条「不来自队列事件」的路径 —— renderQueue 曾经就是（每次 UI 重绘回写一次），'
    + `且它是全仓 render* 里唯一写 state 的。实际：${writers.join(', ') || '无'}`);
});

test('接线钉：renderQueue 必须只读 queueSnapshot，不得回写', () => {
  const body = fnBodyL(stripComments(read('js', 'views', 'download.js')), 'renderQueue');
  assert.ok(body.includes('applyQueueFilter('),
    'renderQueue 需按筛选条件渲染（哨兵缺失，钉可能已失效）');
  assert.ok(!body.includes("state.set('queueSnapshot'"),
    'renderQueue 不得写 queueSnapshot：唯一写入点是队列事件（app.js:309）。'
    + '本函数同时被切筛选/分组/展开详情等纯 UI 路径调用，一旦传入子集就会静默改掉全局快照，'
    + '而 search.js 的徽标、app.js:740、本文件十余处 getState 全读它');
});

// ── 增量136：首页空分区降级（失败信号被上游两层抹平，渲染层只能诚实降级）──

test('回归钉：renderSection 的空数据分支必须走 renderSectionError（不得再写死「暂无数据」）', () => {
  const body = fnBodyL(stripComments(read('js', 'views', 'home.js')), 'renderSection');
  assert.ok(body.includes('renderSectionError('),
    'renderSection 的空数据分支必须调 renderSectionError —— 空数据**不等于**「这个榜真的没歌」：'
    + 'qq.js 各加载器 catch→return []，gateway.recommendCall 再经 safeRun(…, EMPTY.list()) 吞一次，'
    + '失败在到达渲染层前已被两层抹平（recommendations 只能包成 {ok:true,data:[]}，走成功分支）。'
    + '渲染层只能给「可能不可用」+ 重试入口，而不是一句「暂无数据」让人以为榜是空的、且无处可点');
  assert.ok(!body.includes('暂无数据'),
    'renderSection 不得再出现硬编码「暂无数据」——它把「源失败」与「真无数据」混为一谈，且没有重试入口');
});

test('接线钉：不可用分区必须带 is-unavailable 标记并被沉底（分区与页签同步）', () => {
  const src = stripComments(read('js', 'views', 'home.js'));
  assert.ok(fnBodyL(src, 'renderSectionError').includes("'is-unavailable'"),
    'renderSectionError 必须给分区加 is-unavailable 标记 —— 它是沉底后处理的唯一依据');
  const sink = fnBodyL(src, '_sinkUnavailableSections');
  assert.ok(sink.length > 0, '必须有 _sinkUnavailableSections 后处理');
  assert.ok(sink.includes('is-unavailable'), '沉底后处理需按 is-unavailable 分组');
  assert.ok(sink.includes('.plat-chip'),
    '沉底后处理需要认得出页签（.plat-chip）');
  assert.ok(sink.includes('rail.appendChild('),
    '沉底后处理必须把页签也重新 append 回页签栏 —— 只挪分区不挪页签的话，'
    + '页签次序与内容次序不一致：data-sec 仍能对上，但点第 3 个页签显示的是第 1 个分区的内容');
  for (const fn of ['renderSection', 'renderSectionError']) {
    // 恰好一次：早前 grid / list 两条分支各 return 各调一次，钉只能断言
    // 「函数里提到过它」，删掉其中一条的调用照样绿。改成单出口 + 计数钉堵住。
    const calls = (fnBodyL(src, fn).match(/_sinkUnavailableSections\(/g) || []).length;
    assert.strictEqual(calls, 1,
      `${fn}() 必须恰好触发一次沉底后处理，实际 ${calls} 次 —— `
      + '每个平台默认只显示**第一个**分区，第一个恰好为空时（QQ 九分区里 7 个空）'
      + '用户切过去只看到降级提示，会以为整个平台坏了；'
      + '散在多条 return 分支里则容易漏掉某一条');
  }
  // renderHomeShell 只画骨架（无 is-unavailable），无需沉底；数据到达一律经 renderSection
  assert.ok(fnBodyL(src, 'renderHomeShell').includes('home-sec'),
    'renderHomeShell 应仍在生成 .home-sec 骨架（哨兵缺失，钉可能已失效）');
});

test('接线钉：renderSection 成功路径必须清除 is-unavailable（否则一次失败就永久沉底）', () => {
  const body = fnBodyL(stripComments(read('js', 'views', 'home.js')), 'renderSection');
  const clear = body.indexOf("classList.remove('is-unavailable')");
  assert.ok(clear >= 0,
    'renderSection 拿到内容时必须清掉 is-unavailable —— 否则重试成功后该分区仍被当作不可用沉底');
  assert.ok(clear < body.indexOf('filterHomeSection('),
    '清除必须发生在渲染分支之前 —— 塞进某一个分支里会漏掉另一条路径（grid / list）');
});

// ── 增量160（IA 收敛第一步）：侧边栏聚为五组 → 增量164（第二步）：首页+搜索合为单一「搜歌」入口 ──

test('侧边栏分组：四个分区标题按序就位（164 起「搜歌」收敛为单条目，不再需要段头）', () => {
  const html = read('index.html');
  const sb = html.slice(html.indexOf('<div class="sidebar">'), html.indexOf('<div class="content">'));
  assert.ok(sb.length > 200, '侧边栏区块截取失败（锚点改名时同步本测试）');
  const titles = [...sb.matchAll(/class="sidebar-title"[^>]*>([^<]+)</g)].map(m => m[1].trim());
  assert.deepStrictEqual(titles, ['下载', '曲库', '工具', '操作'],
    '分区标题恰好这四个且按此序 —— 「搜歌」组头随 164 单条目化退役（组头+同名条目双份冗余），对齐 redesign sitemap 的分组语义');
  assert.ok(!sb.includes('nav.sidebar.title'),
    '「导航」单段旧头已退役：分组标题是纯中文硬写（改版决议：收缩为纯中文），不许再挂 i18n');
  assert.ok(sb.includes('data-i18n="nav.operations.title"'), '「操作」段沿用既有 i18n 键，不动');
  // 孤儿键清扫必须 zh/en 成对（增量93 教训），否则「键集合一致」钉会红
  for (const f of ['js/lang/zh.json', 'js/lang/en.json']) {
    assert.ok(!read(...f.split('/')).includes('nav.sidebar.title'), `${f} 残留 nav.sidebar.title`);
  }
});

test('侧边栏条目：七个 data-tab 且「搜歌」是唯一发现/搜索入口（164 合并：search 条目退役，页面路由保留）', () => {
  const html = read('index.html');
  const sb = html.slice(html.indexOf('<div class="sidebar">'), html.indexOf('<div class="content">'));
  const tabs = [...sb.matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(tabs, ['home', 'download', 'local', 'playlist', 'subscription', 'ai-music', 'converter'],
    '条目增删/换序会破坏 switchTab 兜底查询与 ⌘K/快捷键的 data-tab 反查 —— 164 只合并 home+search，余账不动');
  for (const t of tabs) {
    assert.ok(sb.includes(`onclick="switchTab('${t}',this)"`), `${t} 的 onclick 形状被改，切换链路可能断`);
  }
  assert.ok(!sb.includes('data-tab="search"'),
    '搜索不再是导航条目 —— 它是「搜歌」入口的第二个视图，高亮归属走 app.js 的 NAV_ALIAS');
  assert.ok(sb.includes('搜歌'), '合并后的入口就叫「搜歌」（与 ⌘K「前往 搜歌」、原分组名同一词汇）');
  assert.ok(!sb.includes('首页'), '导航条目退役后侧栏不许残留「首页」叫法（发现视图的说法留在 ⌘K 括注里）');
  // 按标题切段做归属核对（parts[0] = 首个标题之前的段落，即「搜歌」条目本体）
  const seg = {};
  const parts = sb.split(/class="sidebar-title"[^>]*>/);
  seg['搜歌'] = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const name = parts[i].slice(0, parts[i].indexOf('<'));
    seg[name] = parts[i];
  }
  assert.deepStrictEqual([...seg['搜歌'].matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]), ['home'],
    '首个条目必须只有搜歌一项（多出来的说明有页面绕过分组挂在了栏顶）');
  assert.deepStrictEqual([...seg['下载'].matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]), ['download']);
  assert.deepStrictEqual([...seg['曲库'].matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]), ['local', 'playlist', 'subscription']);
  assert.deepStrictEqual([...seg['工具'].matchAll(/data-tab="([^"]+)"/g)].map(m => m[1]), ['ai-music', 'converter']);
  assert.ok(!seg['操作'].includes('data-tab'), '「操作」两项是动作按钮不是页面，挂上 data-tab 会被 switchTab 兜底误高亮');
  // 「操作」段的打开目录按钮走 openFolderSafe（utils.js 的唯一出口）——
  // 裸调 api.openFolder 在主进程沙箱拒绝时是静默失败，用户点了没反应也没提示。
  assert.ok(seg['操作'].includes('openFolderSafe(') && seg['操作'].includes('openSettings()'));
  assert.ok(seg['曲库'].includes('id="subBadge"'), '订阅未读徽标必须仍长在订阅条目上，挪丢=红点静默消失');
});

test('侧边栏条目叫法统一：本地曲库 / 歌单（与首页统计、⌘K、快捷键浮层同一词汇）', () => {
  const html = read('index.html');
  const sb = html.slice(html.indexOf('<div class="sidebar">'), html.indexOf('<div class="content">'));
  assert.ok(sb.includes('本地曲库'), '侧栏本地条目应与全站通用叫法「本地曲库」一致');
  assert.ok(!sb.includes('本地歌曲'), '「本地歌曲」是第二套叫法（首页统计标签/排序按钮/⌘K 都叫本地曲库），不许复活');
  assert.ok(!sb.includes('我的歌单'), '侧栏条目精简为「歌单」（页面内大标题保留「我的歌单」不在此段）');
  const sc = read('js', 'shortcuts.js');
  assert.ok(sc.includes('跳到本地曲库'), '快捷键浮层文案跟着统一');
  assert.ok(!sc.includes('跳到本地歌曲'), '浮层旧叫法不许复活');
});

// ── 增量164（IA 收敛第二步）：首页+搜索合并为单一「搜歌」入口 —— 机制钉 ──

test('app.js：NAV_ALIAS 是高亮归属的唯一映射（search/history 都归到宿主条目），视图在场判定有唯一真相源', () => {
  const src = read('js', 'app.js');
  assert.ok(src.includes("const NAV_ALIAS = { search: 'home', history: 'download' };"),
    '页面路由→导航条目的归属集中在这一个映射 —— focusTab/命令面板不许再各自摸按钮存在性（映射的默认值只许有一个家）');
  assert.ok(src.includes('.nav-item[data-tab="${NAV_ALIAS[tab] || tab}"]'),
    'switchTab 兜底查询必须过别名 —— 裸查 search 会因条目退役找不到按钮，侧栏从此不高亮、也无报错');
  assert.ok(src.includes('function isTabPageVisible('), '视图在场判定函数必须存在');
  assert.ok(src.includes('window.isTabPageVisible = isTabPageVisible'),
    '必须挂 window —— shortcuts/home 两个独立模块都要问同一个真相源');
});

test('探针收口：键盘在场判定问「页面可见」而非「导航高亮」（反向钉禁回潮）', () => {
  const sc = read('js', 'shortcuts.js');
  assert.ok(!sc.includes('.nav-item.active[data-tab='),
    'shortcuts.js 里拿导航高亮做在场判定是 164 前的写法 —— 入口合并后 data-tab="search" 永不再出现，搜索结果键盘导航会静默死亡');
  assert.ok(sc.includes("window.isTabPageVisible?.('searchPage')"), '搜索结果列表导航改用页面可见探针');
  const hm = read('js', 'views', 'home.js');
  assert.ok(!hm.includes('.nav-item.active[data-tab='), 'home.js 同理 —— ←/→ 切平台的守卫若回潮成高亮探针，合并后会在搜索视图里偷切隐藏首页的平台 tab');
  assert.ok(hm.includes("window.isTabPageVisible?.('homePage')"));
});

test('调用点收口：谁都不许再摸已退役的 search 导航按钮（querySelector 返回 null 会让切换静默失灵）', () => {
  for (const f of [['js', 'app.js'], ['js', 'commandPalette.js'], ['js', 'shortcuts.js'], ['js', 'views', 'home.js'], ['js', 'views', 'search.js']]) {
    const src = read(...f);
    assert.ok(!src.includes('.nav-item[data-tab="search"]'),
      `${f.join('/')} 仍在查已删除的 data-tab="search" 按钮 —— querySelector 返回 null 后 "有按钮才切换" 的守卫会把「去搜索」变成无声空操作`);
  }
  const cp = read('js', 'commandPalette.js');
  const gotoBody = cp.slice(cp.indexOf('function _goto('), cp.indexOf('function _call('));
  assert.ok(gotoBody.length > 20 && !gotoBody.includes('querySelector'),
    '_goto 必须直接 switchTab(tab)，高亮归属交给 NAV_ALIAS');
});

test('词汇跟进：⌘K 与快捷键浮层不再把「首页」当导航条目名（发现/结果是两个视图，不是一个页面）', () => {
  const cp = read('js', 'commandPalette.js');
  assert.ok(cp.includes('前往 搜歌（发现') && cp.includes('前往 搜歌（结果'),
    '两个目的地都保留括注入口 —— 合并的是导航条目，不该弄丢直达结果视图的路径');
  assert.ok(!cp.includes("'前往 首页'"), '旧条目名「首页」不许回潮');
  const sc = read('js', 'shortcuts.js');
  assert.ok(!sc.includes('跳到首页'), '快捷键浮层改叫「跳到搜歌」，与侧栏同一词汇');
});
