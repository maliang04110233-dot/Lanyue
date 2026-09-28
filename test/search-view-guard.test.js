/**
 * 搜索页视图管线回归钉
 *
 * 「非单曲视图被陈旧单曲列表覆盖」：
 * 缺陷：`_dlLastList` 只在 renderSongList 里被赋值、**从不置空**；而四处重绘入口
 *   search.js:171（隐藏已下载）、:179（排序）、:888（队列变化，300ms 防抖）、
 *   :893（屏蔽变化）
 * 一律只判 `if (_dlLastList)`，**不判当前视图类型**。
 * 偏偏 renderSingerList / renderAlbumList / openSingerDetail / openAlbumDetail
 * 都写同一个容器 #songList（index.html:219）。于是「歌手/专辑视图」下任何一次队列
 * 变化（app.js:308-311 每次 queue-updated 都触发）都会把专辑列表盖成上次的单曲
 * 搜索结果，并按单曲排序模式重排。
 *
 * 修法：保持 renderSongList 为 `_dlLastList` 的唯一「= list」写入者；所有非单曲
 * 写 #songList 的路径一律清空（= null）。四处重绘入口即天然安全，无需再加类型判断。
 * （不选「重绘入口加 _searchType === 'song' 守卫」：loadSingerDetail 的 albums 分支
 *   search.js:855 不改 _searchType，守卫会放行、仍被覆盖。）
 *
 * 「异步渲染缺请求序号守卫」：
 * 缺陷：`_typeSearchReqId` 只在 doSearchByType 内部占号，而它是在 doSearch
 *   **await 完 handleLinkInput 之后**才被调用 —— 序号由「谁的响应先回来」分配，
 *   不是由「谁后发起」分配。先发起的搜索若后返回，反而拿到更大的号，用陈旧结果
 *   覆盖新视图（输入框是新词、列表是旧词）。doNaturalSearch / openAlbumDetail /
 *   loadSingerDetail 则完全没占号，任何在途搜索都会被它们覆盖。
 *   附带：`_linkHandled` 是模块级「已接管」标志，剪贴板识别条（clipboard.js:69）
 *   绕开 doSearch 直接调 handleLinkInput 会把它留在 true，用户下一次搜索被
 *   doSearch 里那句 `if (_linkHandled) return` 静默吞掉（点搜索没反应，再点一次才行）。
 *
 * 修法：号在**发起时**占（doSearch 开头），同一次搜索的链接识别与类型搜索共用
 *   一个号（doSearchByType 接收 reqId 参数）；接管与否改用返回值传递，无悬挂状态。
 *
 * 「歌手详情头部自毁」：
 * 缺陷：openSingerDetail 把「头部（返回/订阅）+ 页签 + #singerDetailContent」整块写进
 *   #songList；而 loadSingerDetail 的 el 取的是 #singerDetailContent，却调
 *   renderSongList / renderAlbumList —— 这两个函数写的是 **#songList**。
 *   于是 innerHTML 一替换，头部与页签（连同 #singerDetailContent 本身）全被销毁，
 *   紧接着那句「把内容移入 songList」里 `getElementById('singerDetailContent')`
 *   返回 null → 读 .innerHTML 抛 TypeError → 被 catch 写进一个已脱离文档的节点。
 *   净效果：点进歌手后**返回按钮与页签消失，用户被卡在详情页**，switchSingerTab 不可达。
 *   （commit 4d06dbc 初版导入即如此，不是近期回归。）
 *
 * 修法：renderSongList / renderAlbumList 增加 targetEl 参数（默认回退 #songList），
 *   loadSingerDetail 把列表渲染进 #singerDetailContent，删掉内容搬运 hack。
 *   注意锚点：传 targetEl 时必须清空 _dlLastList —— 四处重绘入口一律按默认容器重绘，
 *   内嵌列表若也设锚点，一次队列变化就会把详情页连壳覆盖。
 *
 * 渲染层模块顶层碰 document，node:test 无法真跑 —— 沿用本仓库的静态源码断言约定。
 * 扫描前一律 stripComments（本仓库有「注释里写代码示例」的惯例）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'views', 'search.js'), 'utf8');

/** 剥注释：块注释换成等长空格（保留换行，行号不漂），行注释整段去掉 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

const CODE = stripComments(RAW);

/** 用花括号配平抽函数体（含首尾大括号） */
function fnBody(src, name) {
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

/**
 * 抽「签名 + 函数体」整段。
 * 需要它：请求序号可以写在参数默认值里（`reqId = ++_typeSearchReqId`），
 * 只在函数体内找「占号」会漏掉这一形态，从而把正确写法误判为缺陷。
 */
function fnSrc(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
  }
  return '';
}

// ── 自检 ────────────────────────────────────────────────

test('自检: stripComments 生效（注释里提到的 _dlLastList 不得被当成代码）', () => {
  assert.ok(!stripComments("// _dlLastList = null; 说明文字").includes('_dlLastList'), '行注释未剥离');
  assert.ok(!stripComments('/* _dlLastList = null; */ let a = 1;').includes('_dlLastList'), '块注释未剥离');
  assert.ok(stripComments('_dlLastList = null;').includes('_dlLastList'), '代码被误剥离');
});

test('自检: fnBody 能正确抽到四个目标函数的函数体（哨兵守卫，防配平被字符串干扰）', () => {
  const sentinels = {
    renderSingerList: 'singer-row',
    renderAlbumList: 'album-row',
    openSingerDetail: 'singer-detail-header',
    backToSearch: 'currentKeyword',
  };
  for (const [fn, token] of Object.entries(sentinels)) {
    const body = fnBody(CODE, fn);
    assert.ok(body.length > 0, `fnBody 未抽到 ${fn}`);
    assert.ok(body.includes(token),
      `fnBody 抽到的 ${fn} 函数体不含哨兵「${token}」——花括号配平被字符串/模板字面量干扰，本文件的钉已失效`);
  }
});

// ── 回归钉 ──────────────────────────────────────────────

test('回归钉：写 #songList 的非单曲渲染函数必须清空 _dlLastList', () => {
  const sentinels = {
    renderSingerList: 'singer-row',
    renderAlbumList: 'album-row',
    openSingerDetail: 'singer-detail-header',
    backToSearch: 'currentKeyword',
  };
  for (const fn of Object.keys(sentinels)) {
    const body = fnBody(CODE, fn);
    assert.ok(body.includes("getElementById('songList')"),
      `${fn}() 应当仍在写 #songList（前提已变？若已改渲染目标，请更新本钉）`);
    assert.ok(body.includes('_dlLastList = null'),
      `${fn}() 写 #songList 却没清空 _dlLastList —— 队列/屏蔽变化（:171/:179/:888/:893 只判 if(_dlLastList)）会把它盖成上次的单曲搜索结果`);
  }
});

test('接线钉：_dlLastList 的赋值形态受限（= list 仅 renderSongList 一处，= null 为非单曲清空点）', () => {
  const code = CODE.replace(/^\s*let\s+_dlLastList\s*=\s*null;\s*$/m, ''); // 排除声明行
  const assigns = [...code.matchAll(/_dlLastList\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(assigns.length >= 5, `_dlLastList 赋值点过少（${assigns.length}），本钉可能已失效`);

  const unexpected = assigns.filter((v) => v !== 'list' && v !== 'null');
  assert.deepStrictEqual(unexpected, [],
    `_dlLastList 出现非约定赋值：${unexpected.join(' | ')}（只允许 list / null）`);

  const asList = assigns.filter((v) => v === 'list');
  assert.strictEqual(asList.length, 1,
    `「= list」只允许 renderSongList 一处，实际 ${asList.length} 处 —— 多一处就多一个会被队列变化重绘的陈旧锚点`);

  const asNull = assigns.filter((v) => v === 'null');
  assert.ok(asNull.length >= 4,
    `非单曲视图清空点应 ≥4（歌手列表/专辑列表/歌手详情/返回），实际 ${asNull.length}`);
});

test('回归钉：renderSongList 必须是 _dlLastList 的唯一「= list」写入者', () => {
  const body = fnBody(CODE, 'renderSongList');
  assert.ok(body.includes('_dlLastList = list'),
    'renderSongList 需把本次列表记为徽标重绘锚点');
  const others = ['renderSingerList', 'renderAlbumList', 'openSingerDetail', 'backToSearch']
    .filter((fn) => fnBody(CODE, fn).includes('_dlLastList = list'));
  assert.deepStrictEqual(others, [], `这些函数不应把自身列表设为徽标锚点：${others.join(', ')}`);
});

// ── 请求序号域 ─────────────────────────────────

/** 凡「渲染列表」的痕迹：三种列表渲染函数的引用（含 renderMap 里的裸引用） */
const RENDERS_LIST = /\brender(Song|Album|Singer)List\b/;

/** 关注的函数及其哨兵（用于自检抽段是否被字符串/模板字面量干扰配平） */
const REQID_TARGETS = {
  doSearch: 'handleLinkInput',
  doSearchByType: '_searchCacheKey',
  handleLinkInput: 'shortLink',
  doNaturalSearch: 'nlSearchMusic',
  openAlbumDetail: 'getAlbumSongs',
  loadSingerDetail: 'getSingerAlbums',
};

test('自检: fnSrc 能抽到六个目标函数的「签名+函数体」，且含哨兵', () => {
  for (const [fn, token] of Object.entries(REQID_TARGETS)) {
    const full = fnSrc(CODE, fn);
    assert.ok(full.length > 0, `fnSrc 未抽到 ${fn}`);
    assert.ok(full.includes(token),
      `fnSrc 抽到的 ${fn} 不含哨兵「${token}」——花括号配平被字符串/模板字面量干扰，本组钉已失效`);
  }
  // fnSrc 必须包含签名（占号可能写在参数默认值里）
  assert.ok(fnSrc(CODE, 'doSearchByType').includes('reqId = ++_typeSearchReqId'),
    'fnSrc 应包含函数签名（参数默认值里的占号是合法形态）');
});

test('回归钉：凡 async 且会渲染列表的函数，必须「先占号、await 后比较号」', () => {
  const names = [...CODE.matchAll(/async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  assert.ok(names.length >= 10, `只扫到 ${names.length} 个 async 函数，本钉可能已失效`);

  const renderers = names.filter((n) => RENDERS_LIST.test(fnBody(CODE, n)));
  assert.ok(renderers.length >= 5,
    `应至少扫到 5 个「async 且渲染列表」的函数，实际 ${renderers.length}：${renderers.join(', ')}`);

  for (const fn of renderers) {
    const full = fnSrc(CODE, fn);
    const body = fnBody(CODE, fn);
    const alloc = full.indexOf('++_typeSearchReqId');
    const firstAwait = full.indexOf('await ');
    const lastAwait = full.lastIndexOf('await ');
    const firstCmp = body.indexOf('!== _typeSearchReqId');
    const lastCmp = body.lastIndexOf('!== _typeSearchReqId');

    assert.ok(alloc >= 0,
      `${fn}() 会渲染列表却没占请求序号（++_typeSearchReqId）—— 它 await 期间发起的更新搜索，会被它这次迟到渲染覆盖`);
    assert.ok(firstAwait >= 0,
      `${fn}() 已不再是「await 后渲染」的形态，请复核本钉是否仍有意义`);
    assert.ok(alloc < firstAwait,
      `${fn}() 的占号排在首个 await 之后 —— 并发的两次调用会由「谁先返回」决定谁赢，先发起的后返回就会覆盖新视图`);
    assert.ok(firstCmp > firstAwait,
      `${fn}() 缺「await 之后比较序号」的守卫（!== _typeSearchReqId）—— 迟到结果会覆盖更新的视图`);
    // 一处比较只能守一处 await：多分支函数（loadSingerDetail 的 songs/albums）
    // 每个分支各自 await，就必须各自比较，否则后一个分支的迟到结果照样落地。
    assert.ok(lastCmp > lastAwait,
      `${fn}() 有 await 落在最后一次序号比较之后 —— 该分支的迟到结果没人拦（每个 await 分支都要有自己的比较）`);
  }
});

test('回归钉：doSearch 必须在 await handleLinkInput 之前占号，并把号传给下游', () => {
  const full = fnSrc(CODE, 'doSearch');
  const alloc = full.indexOf('++_typeSearchReqId');
  const call = full.indexOf('await handleLinkInput');

  assert.ok(alloc >= 0, 'doSearch() 未占请求序号');
  assert.ok(call >= 0, 'doSearch() 未 await handleLinkInput（链接搜索永不生效）');
  assert.ok(alloc < call,
    'doSearch() 在 handleLinkInput 之后才占号 —— 并发的两次搜索会由「谁先返回」决定谁赢，先发起的后返回就会用陈旧结果覆盖新视图');
  // [^;] 限定在同一条语句内：早前用 [\s\S]*? 会跨语句懒匹配，
  // 把后面 doSearchByType(..., reqId) 里的 reqId 当成实参，实参被删也照样绿。
  assert.match(full, /if\s*\(\s*await\s+handleLinkInput\([^;]*?reqId\s*\)/,
    'doSearch() 必须把本次 reqId 传给 handleLinkInput（同一次搜索共用一个号，识别不再自行占新号）');
  assert.match(full, /doSearchByType\([^;]*?reqId\s*\)/,
    'doSearch() 必须把 reqId 传给 doSearchByType，否则类型搜索会另占新号、整次搜索的号不统一');
  assert.match(full, /if\s*\(\s*reqId\s*!==\s*_typeSearchReqId\s*\)\s*return/,
    'doSearch() 需在「识别未接管且已被更新搜索取代」时整体作废，不得再拿链接文本做关键词搜索');
});

test('回归钉：不得再有模块级「已接管」悬挂标志（_linkHandled 类），接管走返回值', () => {
  assert.ok(!CODE.includes('_linkHandled'),
    'search.js 又出现了 _linkHandled：剪贴板识别条（clipboard.js:69）绕开 doSearch 直接调 handleLinkInput，'
    + '会把标志留在 true，用户下一次搜索被 doSearch 静默吞掉。接管与否必须走返回值。');
  const full = fnSrc(CODE, 'handleLinkInput');
  assert.match(full, /return\s+true/, 'handleLinkInput 需用 return true 表示「已接管本次输入」');
  assert.match(full, /return\s+false/, 'handleLinkInput 需用 return false 表示「未接管，调用方继续关键词搜索」');
});

test('回归钉：搜索类型页签高亮只允许由 _syncSearchTypeTabs 单点写入', () => {
  const hits = [...CODE.matchAll(/querySelectorAll\(\s*'\.search-type-tabs/g)];
  assert.strictEqual(hits.length, 1,
    `'.search-type-tabs' 查询应只出现在 _syncSearchTypeTabs 一处，实际 ${hits.length} 处 —— `
    + '多一处就是一处会与 _searchType 脱钩的散装高亮（改类型的地方漏改，页签就停在上一个类型）');
  assert.ok(fnBody(CODE, '_syncSearchTypeTabs').includes('.search-type-tabs'),
    '唯一那处应位于 _syncSearchTypeTabs 内');

  for (const fn of ['searchArtistSongs', 'doNaturalSearch']) {
    const body = fnBody(CODE, fn);
    assert.ok(body.includes('_searchType ='),
      `${fn}() 已不再改 _searchType，请复核本钉是否仍有意义`);
    assert.ok(body.includes('_syncSearchTypeTabs('),
      `${fn}() 改了 _searchType 却没同步页签 —— 列表已是新类型、页签仍停在上一个类型，用户会以为结果错了`);
  }
});

// ── 歌手详情头部自毁 ───────────────────────────

/** 枚举 function 声明名（本文件的渲染函数都是声明式；箭头函数形态本钉扫不到，见文末说明） */
function allFnNames(src) {
  return [...src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((m) => m[1]);
}

test('自检: allFnNames 能列出本文件全部函数声明', () => {
  const names = allFnNames(CODE);
  assert.ok(names.length >= 30, `只列出 ${names.length} 个函数声明，本钉可能已失效`);
  for (const n of ['renderSongList', 'renderAlbumList', 'loadSingerDetail', 'openSingerDetail']) {
    assert.ok(names.includes(n), `allFnNames 漏了 ${n}`);
  }
});

test('回归钉：loadSingerDetail 必须把列表渲染进 #singerDetailContent，不得重写 #songList', () => {
  const body = fnBody(CODE, 'loadSingerDetail');
  assert.ok(body.includes('singerDetailContent'),
    'loadSingerDetail 需以 #singerDetailContent 为渲染目标（哨兵缺失，钉可能已失效）');

  // 两个分支各自都要把 targetEl 传下去
  assert.match(body, /renderSongList\([^;]*?,/,
    'loadSingerDetail 的 songs 分支必须传 targetEl —— 否则 renderSongList 写 #songList，'
    + '会把详情页头部（返回/订阅）与页签一起 innerHTML 掉，用户被卡在详情页出不来');
  assert.match(body, /renderAlbumList\([^;]*?,/,
    'loadSingerDetail 的 albums 分支必须传 targetEl（同上，否则切「全部专辑」后头部消失）');

  assert.doesNotMatch(body, /getElementById\(\s*'songList'\s*\)/,
    'loadSingerDetail 不得直接碰 #songList：它是子区域渲染函数，整块重写会连头部/页签一起销毁'
    + '（旧的「把内容移入 songList」搬运 hack 就是这么来的）');
});

test('回归钉：写 #songList 的函数集合受限（子区域渲染函数不得重写整个容器）', () => {
  const writers = allFnNames(CODE).filter((n) => {
    const body = fnBody(CODE, n);
    return body.includes("getElementById('songList')") && body.includes('innerHTML');
  }).sort();

  // 视图级渲染函数：它们渲染/清空的就是整个 #songList，属正常。
  // backToSearch 属此类：它退出详情视图，清空整个容器（含详情壳）正是预期行为。
  // 若确需新增，请先确认它渲染的是整个容器而不是其中一块 —— 后者必须走 targetEl。
  const EXPECTED = ['backToSearch', 'openAlbumDetail', 'openSingerDetail',
    'renderAlbumList', 'renderSingerList', 'renderSongList'];
  assert.deepStrictEqual(writers, EXPECTED,
    '写 #songList 的函数集合发生变化。新增者若只渲染容器内的一块（如详情页列表），'
    + '必须改为渲染进自己的子容器，否则会把同级的头部/页签一起覆盖');
});

test('接线钉：renderSongList/renderAlbumList 的 targetEl 必须回退到 #songList', () => {
  for (const fn of ['renderSongList', 'renderAlbumList']) {
    const full = fnSrc(CODE, fn);
    assert.match(full, new RegExp(`function\\s+${fn}\\([^)]*,[^)]*=\\s*null\\s*\\)`),
      `${fn} 需有默认 null 的 targetEl 参数（不传时行为不变）`);
    const body = fnBody(CODE, fn);
    assert.match(body, /targetEl\s*\|\|\s*document\.getElementById\(\s*'songList'\s*\)/,
      `${fn} 未传 targetEl 时必须仍渲染到 #songList —— 默认容器变了会让所有既有调用方渲染到空处`);
  }
});

test('接线钉：内嵌渲染（传 targetEl）不得设置徽标重绘锚点', () => {
  const body = fnBody(CODE, 'renderSongList');
  const anchor = body.indexOf('_dlLastList = list');
  assert.ok(anchor >= 0, 'renderSongList 需把本次列表记为徽标重绘锚点');
  assert.ok(body.includes('targetEl'), 'renderSongList 需有 targetEl 判断（哨兵缺失，钉可能已失效）');
  assert.ok(body.indexOf('targetEl') < anchor,
    '锚点赋值必须受 targetEl 约束：传 targetEl（内嵌渲染）时不得设锚点 —— '
    + '四处重绘入口（:171/:179/:936/:941）一律按默认容器重绘，'
    + '内嵌列表若也设锚点，一次队列变化就会把详情页头部/页签连壳覆盖，本缺陷原地复活');
});

// 已知残余：allFnNames 只扫 `function 名(` 声明式写法。若将来用箭头函数新增
// 一个「写 #songList」的渲染器，上面那条集合钉扫不到 —— 新增渲染器时请一并复核。
