/**
 * 单元测试：utils/downloadPath.js + naming.renderPathSegments —— 下载路径模板
 *
 * 背景：设置页的「下载路径模板」是个死开关 —— 模板能建、能校验、
 * 能标「使用中」、切换还弹 toast，但 downloadQueue 里没有一个字读它，
 * 所有文件一律平铺在下载根目录；而 naming.js 的注释又把「按目录组织」
 * 指向这个功能，等于文档指向了一个不存在的能力。本增量把它接通。
 *
 * 分工（一条规则只有一个家）：
 *   naming.renderPathSegments —— 变量渲染与清洗，和文件名模板共用同一张变量表
 *   downloadPath              —— 目录语义：相对片段推导、层级上限、越界回落
 *
 * 安全底线：模板来自用户输入 + 云同步/导入的外部数据，落盘目录必须永远落在
 * 下载根目录内。三道单点规则（缺值整段丢 / '.' 与 '..' 段丢弃 / 未知变量段丢弃）
 * 之外，拼完还要再过一次包含检查 —— 纵深防御，不假设前三条条条都对。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { renderPathSegments, previewPathPattern, previewTemplate } = require('../src/utils/naming');
const {
  planDownloadDir,
  subpathFromAbsolute,
  activePathTemplate,
  isInsideDir,
  MAX_SEGMENTS,
} = require('../src/utils/downloadPath');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
// 接线钉统计子串出现次数：比正则少一层转义，比 indexOf 数得清
const countOf = (s, sub) => s.split(sub).length - 1;

const NOW = new Date('2026-01-15T12:00:00');
const SONG = {
  title: '晴天', artist: '周杰伦', album: '叶惠美',
  source: 'netease', id: '12345', quality: 'hq',
  trackNo: '3', trackTotal: '12', playlistName: '周杰伦精选', year: '2003',
};
// 根目录用一个跨平台都成立的绝对路径（不碰真实磁盘，纯字符串规划）。
// 必须过 path.resolve：Windows 下 '/tmp/mq-root' 是「当前盘根」的相对写法，
// 不 resolve 的话 planDownloadDir 归一化后的结果和断言里的字面量对不上。
const BASE = path.resolve(path.join(path.sep + 'tmp', 'mq-root'));
const OTHER = path.resolve(path.join(path.sep + 'tmp', 'other-root'));

// ── 变量渲染（与文件名模板同一张表） ────────────────────

test('renderPathSegments: 基础变量逐段渲染，保留书写顺序', () => {
  assert.deepEqual(renderPathSegments('{artist}/{album}', SONG, { now: NOW }),
    ['周杰伦', '叶惠美']);
  assert.deepEqual(renderPathSegments('{artist}', SONG, { now: NOW }), ['周杰伦']);
  // 扩展变量同样可用（码率/年份/序号/日期）
  assert.deepEqual(renderPathSegments('{bitrate}/{year}/{trackNo}/{date}', SONG, { now: NOW }),
    ['320k', '2003', '03', '20260115']);
});

test('renderPathSegments: 两种分隔符与重复分隔符都算同一段边界', () => {
  const bs = String.fromCharCode(92);
  assert.deepEqual(renderPathSegments('{artist}' + bs + '{album}', SONG, { now: NOW }),
    ['周杰伦', '叶惠美']);
  assert.deepEqual(renderPathSegments('/{artist}//{album}/', SONG, { now: NOW }),
    ['周杰伦', '叶惠美']);
});

test('renderPathSegments: 缺值的段整段丢掉，不留「未知」目录', () => {
  // 文件名模板里缺值回退「未知」（那是文件名，总得有个名字）；
  // 目录里没有「未知」这首歌，凭空建一层 未知/ 只是垃圾。
  assert.deepEqual(renderPathSegments('{artist}/{album}', { title: 'x', artist: '周杰伦' }, { now: NOW }),
    ['周杰伦']);
  assert.deepEqual(renderPathSegments('{album}', { title: 'x' }, { now: NOW }), []);
  assert.deepEqual(renderPathSegments('{playlist}/{artist}', SONG, { now: NOW }),
    ['周杰伦精选', '周杰伦']);
});

test('renderPathSegments: 值里的分隔符与非法字符折成下划线，不新增层级', () => {
  const song = { ...SONG, artist: 'A/B:C*D' };
  assert.deepEqual(renderPathSegments('{artist}', song, { now: NOW }), ['A_B_C_D']);
});

test('renderPathSegments: 点号段与未知变量的段一律丢弃', () => {
  const bs = String.fromCharCode(92);
  assert.deepEqual(renderPathSegments('{artist}/../{album}', SONG, { now: NOW }),
    ['周杰伦', '叶惠美']);
  assert.deepEqual(renderPathSegments('./{artist}/.', SONG, { now: NOW }), ['周杰伦']);
  // 拼错的变量名不配生成一个名叫 {foo} 的目录（设置页另有 unknownPlaceholders 提示）
  assert.deepEqual(renderPathSegments('{artist}/{foo}', SONG, { now: NOW }), ['周杰伦']);
  // 值本身就是 .. 也算点号段（外部数据不可信）
  assert.deepEqual(renderPathSegments('{artist}', { ...SONG, artist: '..' }, { now: NOW }), []);
  assert.deepEqual(renderPathSegments(bs + '..' + bs + bs + '..' + bs + '{artist}', SONG, { now: NOW }), ['周杰伦']);
});

test('renderPathSegments: 空模板/非字符串输入不炸', () => {
  for (const bad of ['', null, undefined, '   ', '/']) {
    assert.deepEqual(renderPathSegments(bad, SONG, { now: NOW }), []);
  }
  assert.deepEqual(renderPathSegments('{artist}', null, { now: NOW }), []);
  assert.deepEqual(renderPathSegments('{artist}', {}, { now: NOW }), []);
});

// ── 相对片段推导（老模板只存了绝对路径） ────────────────

test('subpathFromAbsolute: 根目录内取相对片段，根本身算空，外面算不可用', () => {
  assert.equal(subpathFromAbsolute(path.join(BASE, '{artist}', '{album}'), BASE),
    path.join('{artist}', '{album}'));
  assert.equal(subpathFromAbsolute(BASE, BASE), '');
  assert.equal(subpathFromAbsolute(path.join(path.dirname(BASE), 'elsewhere'), BASE), null);
  assert.equal(subpathFromAbsolute(null, BASE), null);
  assert.equal(subpathFromAbsolute(BASE, ''), null);
});

// ── 目录规划 ────────────────────────────────────────────

test('planDownloadDir: 无模板/无根目录 ⇒ 原样回落根目录且标未生效', () => {
  assert.deepEqual(planDownloadDir(null, BASE, SONG, { now: NOW }),
    { dir: BASE, applied: false, reason: 'no-template' });
  assert.deepEqual(planDownloadDir({}, BASE, SONG, { now: NOW }),
    { dir: BASE, applied: false, reason: 'no-template' });
  const noRoot = planDownloadDir({ subpath: '{artist}' }, '', SONG, { now: NOW });
  assert.equal(noRoot.applied, false);
  assert.equal(noRoot.reason, 'no-root');
});

test('planDownloadDir: 相对片段渲染成根目录下的子目录', () => {
  const r = planDownloadDir({ subpath: '{artist}/{album}' }, BASE, SONG, { now: NOW });
  assert.equal(r.applied, true);
  assert.equal(r.reason, '');
  assert.equal(r.dir, path.join(BASE, '周杰伦', '叶惠美'));
});

test('planDownloadDir: 固定子目录（无变量）同样生效', () => {
  const r = planDownloadDir({ subpath: 'Pop/2026' }, BASE, SONG, { now: NOW });
  assert.equal(r.applied, true);
  assert.equal(r.dir, path.join(BASE, 'Pop', '2026'));
});

test('planDownloadDir: 空 subpath 表示就落在根目录（不是不可用）', () => {
  assert.deepEqual(planDownloadDir({ subpath: '' }, BASE, SONG, { now: NOW }),
    { dir: BASE, applied: false, reason: 'no-subpath' });
  assert.deepEqual(planDownloadDir({ subpath: '   ' }, BASE, SONG, { now: NOW }),
    { dir: BASE, applied: false, reason: 'no-subpath' });
});

test('planDownloadDir: 老模板没存 subpath 时按当前根目录现推绝对路径', () => {
  const legacy = { path: path.join(BASE, '{artist}') };
  assert.equal(planDownloadDir(legacy, BASE, SONG, { now: NOW }).dir,
    path.join(BASE, '周杰伦'));
  // 换了下载根目录：老模板存的绝对路径不再属于它 ⇒ 回落，不越界
  const moved = planDownloadDir(legacy, OTHER, SONG, { now: NOW });
  assert.equal(moved.applied, false);
  assert.equal(moved.reason, 'outside-save-dir');
  assert.equal(moved.dir, OTHER);
  // 新模板存的是相对片段，换根目录照样跟着走
  assert.equal(planDownloadDir({ subpath: '{artist}' }, OTHER, SONG, { now: NOW }).dir,
    path.join(OTHER, '周杰伦'));
});

test('planDownloadDir: 缺值把模板掏空后不建任何子目录', () => {
  const r = planDownloadDir({ subpath: '{album}' }, BASE, { title: 'x', artist: 'a' }, { now: NOW });
  assert.deepEqual(r, { dir: BASE, applied: false, reason: 'empty-after-render' });
});

test('planDownloadDir: 穿越写法永远出不去根目录', () => {
  const bs = String.fromCharCode(92);
  const evil = ['..' + bs + '..' + bs + 'escape', '../..', path.join('..', '{artist}', '..', '..')];
  for (const subpath of evil) {
    const r = planDownloadDir({ subpath }, BASE, SONG, { now: NOW });
    assert.ok(isInsideDir(BASE, r.dir), `${subpath} 渲染出了根目录外的路径: ${r.dir}`);
  }
});

test('planDownloadDir: 层级超上限整条模板作废（不静默截断到别处）', () => {
  const deep = Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => 'L' + i).join('/');
  const r = planDownloadDir({ subpath: deep }, BASE, SONG, { now: NOW });
  assert.deepEqual(r, { dir: BASE, applied: false, reason: 'too-deep' });
  const ok = Array.from({ length: MAX_SEGMENTS }, (_, i) => 'L' + i).join('/');
  assert.equal(planDownloadDir({ subpath: ok }, BASE, SONG, { now: NOW }).applied, true);
});

test('isInsideDir: 自身算在内，前缀撞名不算', () => {
  assert.equal(isInsideDir(BASE, BASE), true);
  assert.equal(isInsideDir(BASE, path.join(BASE, 'x')), true);
  assert.equal(isInsideDir(BASE, BASE + 'Evil'), false);
  assert.equal(isInsideDir(BASE, path.dirname(BASE)), false);
});

test('activePathTemplate: 只按 id 取活动模板，缺 id/查不到都算没有', () => {
  const tpls = [{ id: 'a', subpath: '{artist}' }, { id: 'b', subpath: '{album}' }];
  assert.equal(activePathTemplate(tpls, 'b'), tpls[1]);
  assert.equal(activePathTemplate(tpls, null), null);
  assert.equal(activePathTemplate(tpls, ''), null);
  assert.equal(activePathTemplate(tpls, 'zzz'), null);
  assert.equal(activePathTemplate(null, 'a'), null);
  const withHole = [null, { id: 'a', subpath: '{artist}' }];
  assert.deepEqual(activePathTemplate(withHole, 'a'), { id: 'a', subpath: '{artist}' });
});

// ── 接线钉：链路每一环都得真的接上（死开关就是这么死的） ──

test('downloadQueue: 落盘目录取自 planDownloadDir，mkdir/statfs/下载路径三者同源', () => {
  const src = read('src/main/downloadQueue.js');
  assert.match(src, /require\('\.\.\/utils\/downloadPath'\)/, '要接上目录规划模块');
  assert.match(src, /activePathTemplate\(/, '要读活动模板');
  assert.match(src, /planDownloadDir\(/, '要按模板规划目录');
  // mkdir 的必须是规划出来的目录，不是根目录 —— 否则子目录永远不会被创建（ENOENT）
  assert.match(src, /mkdir\(dirPlan\.dir/, '要 mkdir 规划目录');
  assert.match(src, /statfs\(dirPlan\.dir/, '容量预检也要看真实落盘目录');
  const m = src.match(/const savePath = path\.join\(([^,]+),/);
  assert.ok(m, 'savePath 拼接处形状变了，检查接线');
  assert.equal(m[1].trim(), 'dirPlan.dir');
  assert.doesNotMatch(src, /path\.join\(saveDir,\s*sanitizeFilename\(renderFileName/, '不应再无条件平铺在根目录');
});

test('downloadTemplates IPC: 保存时落子路径，且沿用同一份推导', () => {
  const src = read('src/main/ipc/downloadTemplates.js');
  assert.match(src, /require\('\.\.\/\.\.\/utils\/downloadPath'\)/);
  assert.match(src, /subpathFromAbsolute\(/);
  assert.match(src, /subpath:/, '模板记录里要存上相对片段');
  // 校验与推导必须共用同一个根，否则「校验说在内、推导说在外」会静默废掉模板
  assert.match(src, /currentSaveDir\(\)/);
  assert.match(src, /sanitizeDownloadPath\(template\.path\.trim\(\), root\)/);
  // 相对写法按「相对下载目录」解释（照设置页提示写 {artist}/{album} 才存得下来）
  assert.match(src, /path\.resolve\(base, raw\)/);
});

test('设置页: 展示相对片段并说明它是「相对下载目录」', () => {
  const src = read('src/renderer/js/views/settings.js');
  assert.match(src, /tpl\.subpath/, '列表要显示相对片段');
  assert.match(src, /相对下载目录/, '要说清口径，别让用户以为要写绝对路径');
});

test('下载队列行: 📂 定位真实文件所在目录，不再打开全局下载目录', () => {
  const src = read('src/renderer/js/views/download.js');
  // 三个入口统一走 openFolderSafe（utils.js 的唯一出口）而不是裸调 api.openFolder：
  // 主进程 open-folder 有 approvedDirs 沙箱，裸调会让「被拒」变成静默失败 ——
  // 用户点了没反应也没有提示。判据见 test/open-folder-entry.test.js。
  const openSites = src.match(/\bopenFolderSafe\(/g) || [];
  assert.equal(openSites.length, 3, 'openFolderSafe 调用点数量变了，复核一遍归属');
  assert.doesNotMatch(src, /api\.openFolder\(/, '裸调 api.openFolder 会静默失败');
  // 行内按钮与右键菜单：都按该行的 savePath 定位（和历史页同一口径 —— 显示的就是那首歌）
  assert.equal(countOf(src, "openFolderSafe('${escQ(s.savePath)}')"), 1);
  assert.equal(countOf(src, 'openFolderSafe(s.savePath)'), 1);
  // 工具栏那个「打开下载目录」按钮仍指向全局目录，属另一个语义，不许被顺手改掉
  assert.equal(countOf(src, 'openFolderSafe(saveDir)'), 1);
  // 也不许把全局目录按钮改成「按当前行的 savePath 定位」——那是本条要防的回归
  assert.equal(countOf(src, "openFolderSafe('${escQ(getState('saveDir')"), 0);
});

test('零新 IPC 通道：本增量只用既有方法', () => {
  const { METHODS, CHANNELS } = require('../src/shared/ipcContract');
  const files = [
    'src/renderer/js/views/settings.js',
    'src/renderer/js/views/download.js',
  ];
  const used = new Set();
  const invoked = new Set();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/\bapi\.([A-Za-z0-9_]+)\s*\(/g)) used.add(m[1]);
    // api.invoke 是通用逃生口（通道名是实参，不在 METHODS 里），单独按字面量收
    for (const m of src.matchAll(/\bapi\.invoke\(\s*'([^']+)'/g)) invoked.add(m[1]);
  }
  const unknown = Array.from(used).filter((k) => k !== 'invoke' && !(k in METHODS));
  assert.deepEqual(unknown, [], '出现契约外方法: ' + unknown.join(', '));
  const unknownCh = Array.from(invoked).filter((c) => !(c in CHANNELS));
  assert.deepEqual(unknownCh, [], '出现契约外通道: ' + unknownCh.join(', '));
});

// ── 路径模板实时预览（编辑器里当场看见「下一首歌会落到哪」）────────
//
// 为什么要有：169 之后模板真的生效了，但用户在编辑器里仍然只能靠想象 —— 写完
// {artist}/{album} 存下、下载一首、再去目录里核对。文件名模板早就有实时预览
// （设置页 filenameTmplPreview 那条），路径模板是这条线上唯一的例外。
// 预览必须在主进程算：renderer 是 Vite 打包的 ESM，拿不到 src/utils/*（CJS），
// 而"样例歌曲"这份 fixture 也只许有一个家（previewTemplate 用的就是它）。

test('previewPathPattern 用与文件名预览同一份样例歌曲渲染落点', () => {
  assert.equal(typeof previewPathPattern, 'function', 'naming.js 应导出 previewPathPattern');
  const r = previewPathPattern('{artist}/{album}');
  assert.deepStrictEqual(r.segments, ['周杰伦', '叶惠美']);
  assert.deepStrictEqual(r.dropped, []);
  // 同一份 fixture：文件名预览里出现的歌手，路径预览里也必须是同一个
  assert.equal(previewTemplate('{artist} - {title}'), '周杰伦 - 晴天.mp3');
});

test('样例歌曲字面量在 naming.js 里只许出现一次（两份必然漂移）', () => {
  assert.equal(countOf(read('src/utils/naming.js'), "'晴天'"), 1);
});

test('被丢弃的段进 dropped，用户看得见"我写的这段没了"', () => {
  // 样例歌曲各项齐全，所以预览里能触发丢段的只有"变量名不认识"这一类；
  // 真实下载时缺值（例如非歌单来源没有 {playlist}）走的是同一条丢弃分支。
  const r = previewPathPattern('{artist}/{playlistX}/{album}');
  assert.deepStrictEqual(r.segments, ['周杰伦', '叶惠美']);
  assert.deepStrictEqual(r.dropped, ['{playlistX}']);
  // 同一个变量写对就不该出现在 dropped 里（防止把 dropped 实现成"未知变量清单"）
  assert.deepStrictEqual(previewPathPattern('{playlist}').dropped, []);
});

test('预览是确定性的：{date} 走固定渲染时间，不跟系统时钟漂移', () => {
  assert.deepStrictEqual(previewPathPattern('{date}').segments, ['20260115']);
});

test('纯文本段照原样算落点，且和变量段混排也按顺序出', () => {
  assert.deepStrictEqual(previewPathPattern('Music/{year}').segments, ['Music', '2003']);
});

test('空 pattern 出空结果而不是报错', () => {
  assert.deepStrictEqual(previewPathPattern(''), { segments: [], dropped: [] });
  assert.deepStrictEqual(previewPathPattern(null), { segments: [], dropped: [] });
});

test('renderPathSegments 仍返回字符串数组（downloadQueue 直接 path.join 用它）', () => {
  const segs = renderPathSegments('{artist}/{album}', SONG, { now: NOW });
  assert.ok(Array.isArray(segs));
  assert.deepStrictEqual(segs, ['周杰伦', '叶惠美']);
});

// ── 接线钉：预览走既有 'preview-naming-template' 通道，不为预览再开一条 ──
// 主进程那一侧不在这里钉：handler 真调得动（契约校验 + 信封 + prefs），
// 已有 test/downloadTemplatePreview.test.js 覆盖，字符串钉只会重复且更弱。

test('设置页路径模板编辑器接上实时预览（元素由 JS 造，不动 index.html）', () => {
  const src = read('src/renderer/js/views/settings.js');
  assert.ok(/function ensureDlTemplatePreview\(/.test(src), '预览节点要有生成的地方');
  assert.ok(/function updateDlPathPreview\(/.test(src), '预览刷新要有函数');
  assert.ok(/addEventListener\('input'/.test(src), '输入要绑到刷新（不靠 HTML 内联 oninput）');
  assert.ok(/api\.previewNamingTemplate\(\s*\{/.test(src), '跨进程取预览值');
  assert.ok(/示例落点/.test(src), '预览文案要用人话');
  assert.ok(/textContent/.test(src.slice(src.indexOf('function updateDlPathPreview'))), '预览写 textContent 不写 innerHTML');
  // 元素不写进 index.html：模态框是本增量自己造壳，避免与并发会话抢同一份 HTML
  assert.equal(read('src/renderer/index.html').includes('dlTemplatePathPreview'), false);
});
