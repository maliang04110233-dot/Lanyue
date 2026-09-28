/**
 * 守卫：本地库三种视图与筛选轴的**联动**（不只是各自能渲染）
 *
 * ── 背景（两个真实缺陷，同一批）────────────────────────────────
 *
 * 1) toggleLocalView 清了过滤轴，却拿**上一轮**的 localFiltered 去渲染
 *
 *    local.js 的 filterLocalSongs() 把结果写进 state.localFiltered，然后按
 *    _localViewMode 分发到 renderLocalSongs / renderLocalGrid /
 *    renderLocalAlbumWall。而这三个渲染函数**只读** getState('localFiltered')，
 *    自己不过滤。
 *
 *    旧版 toggleLocalView 在离开 album 模式时把 _localAlbumFilter 清空，
 *    紧接着直接调 renderLocalSongs()/renderLocalGrid()（不重算），同时
 *    _setViewChrome() 又把代表该过滤的 chip 藏了。于是复现路径：
 *
 *      专辑视图 → 点专辑卡（openAlbumFromWall 过滤到单专辑）→ 点视图切换
 *
 *    列表仍然只有那一张专辑的歌，chip 却不见了 —— 用户看到的是「曲库丢歌」，
 *    而且**没有任何入口**能把过滤清回来（clearAlbumFilter 早退，因为
 *    _localAlbumFilter 已经是空串）。
 *
 * 2) renderLocalAlbumWall 从未过滤的 localSongs 起算
 *
 *    于是封面墙视图下，搜索框（#localFilter）、格式/音质/完整度/收藏/文件夹
 *    这些筛选轴**全部无效** —— 界面毫无反应，看着像控件坏了。
 *
 * 这两条都不是「某个筛选轴算错了」，而是**视图与筛选轴之间的接线断了**，
 * 所以单测各自的纯函数（groupSongsForAlbumWall、filterByFmt…）全都绿。
 * 只有把「切视图 / 换筛选 → 渲染出什么」连起来看才暴露。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LOCAL = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'views', 'local.js'), 'utf8');

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
const CODE = stripComments(LOCAL);

// ── 缺陷 1：切视图必须重算，不能拿陈旧的 localFiltered ──────────
test('toggleLocalView: 走 filterLocalSongs() 重算，而不是直接调渲染函数', () => {
  const body = /function toggleLocalView\(\)\s*\{[\s\S]*?\n\}/.exec(CODE);
  assert.ok(body, '没找到 toggleLocalView');
  const fn = body[0];

  // 关键：切视图后必须重算筛选结果
  assert.match(
    fn, /filterLocalSongs\(\)/,
    'toggleLocalView 里没有 filterLocalSongs()：清掉 _localAlbumFilter 后直接渲染，'
      + '列表/网格会继续显示「只有那一张专辑」的上一轮 localFiltered，而 chip 已被藏掉。',
  );

  // 三个渲染函数都只读 localFiltered，所以在视图切换路径里直接调它们就是绕过重算
  for (const direct of ['renderLocalSongs(', 'renderLocalGrid(', 'renderLocalAlbumWall(']) {
    assert.doesNotMatch(
      fn, new RegExp(direct.replace('(', '\\s*\\(')),
      `toggleLocalView 里直接调了 ${direct} —— 它只读 localFiltered，不会重算筛选轴。`
        + '改走 filterLocalSongs()（它内部已按 _localViewMode 分发）。',
    );
  }
});

test('守卫：视图切换不再自己动 chip（显隐只归 _setViewChrome 管）', () => {
  // 旧实现在 toggleLocalView 尾部又写了一遍 chip 显隐，与 _setViewChrome()
  // 同源不同步过一次（切视图时一处按 _localAlbumFilter 显示、一处按
  // toggleLocalView 的局部判断隐藏）。现在收口：切视图只调 _setViewChrome()。
  const toggle = /function toggleLocalView\(\)\s*\{[\s\S]*?\n\}/.exec(CODE)[0];
  assert.match(
    toggle, /_setViewChrome\(\)/,
    'toggleLocalView 必须调 _setViewChrome()，由它统一同步 chrome（含 chip）',
  );
  assert.doesNotMatch(
    toggle, /localAlbumFilterChip/,
    'toggleLocalView 又开始自己动 chip 了：显隐应只在 _setViewChrome() 一处，否则两处判断会漂。',
  );

  // 全仓口径：chip 显隐只允许出现在 _setViewChrome 与 clearAlbumFilter
  const chipSites = [...CODE.matchAll(/localAlbumFilterChip/g)]
    .map((m) => CODE.slice(0, m.index).split('\n').length);
  assert.strictEqual(
    chipSites.length, 2,
    `localAlbumFilterChip 出现在第 ${chipSites.join('、')} 行，预期只有 2 处`
      + '（_setViewChrome 的统一同步 + clearAlbumFilter 的即时隐藏）',
  );
  const fnOf = (line) => {
    const head = CODE.slice(0, CODE.split('\n').slice(0, line - 1).join('\n').length + 1);
    const m = [...head.matchAll(/function\s+(\w+)\s*\(/g)].pop();
    return m ? m[1] : '(顶层)';
  };
  assert.deepStrictEqual(
    chipSites.map(fnOf).sort(), ['_setViewChrome', 'clearAlbumFilter'].sort(),
    'chip 显隐只允许出现在 _setViewChrome 与 clearAlbumFilter',
  );
});

test('clearAlbumFilter: 清完过滤后必须重算并同步 chip（早退分支不算数）', () => {
  const body = /function clearAlbumFilter\(\)\s*\{[\s\S]*?\n\}/.exec(CODE);
  assert.ok(body, '没找到 clearAlbumFilter');
  assert.match(body[0], /filterLocalSongs\(\)/, '清除专辑过滤后必须重算，否则列表仍是旧结果');
  assert.match(body[0], /localAlbumFilterChip/, '清除专辑过滤必须同步隐藏 chip');
});

// ── 缺陷 2：封面墙必须尊重筛选轴 ──────────────────────────────
test('renderLocalAlbumWall: 取 localFiltered，不是未过滤的 localSongs', () => {
  const body = /function renderLocalAlbumWall\(\)\s*\{[\s\S]*?\n\}/.exec(CODE);
  assert.ok(body, '没找到 renderLocalAlbumWall');
  const fn = body[0];
  assert.match(
    fn, /getState\(\s*'localFiltered'\s*\)/,
    'renderLocalAlbumWall 必须从 localFiltered 起算。取 localSongs 会让搜索框、'
      + '格式/音质/完整度/收藏/文件夹这些筛选轴在专辑视图下全部失效。',
  );
  assert.doesNotMatch(
    fn, /getState\(\s*'localSongs'\s*\)/,
    'renderLocalAlbumWall 又回到未过滤的 localSongs 了 —— 封面墙会无视全部筛选轴。',
  );
});

test('守卫：三个视图渲染函数的数据源统一（都只读 localFiltered）', () => {
  // 这条是本次两条缺陷的共同根因：渲染层不过滤、只消费过滤结果。
  // 只要有一个视图改回直接读 localSongs，筛选轴就会在那个视图上静默失效。
  for (const fn of ['renderLocalSongs', 'renderLocalGrid', 'renderLocalAlbumWall']) {
    const body = new RegExp(`function ${fn}\\(\\)[\\s\\S]*?\\n\\}`).exec(CODE);
    assert.ok(body, `没找到 ${fn}`);
    assert.match(
      body[0], /getState\(\s*'localFiltered'\s*\)/,
      `${fn} 必须读 localFiltered。渲染函数不过滤、只消费过滤结果 —— `
        + '这是三条筛选链能保持一致的前提。',
    );
  }
});

test('filterLocalSongs: 专辑过滤轴与其它筛选轴串在同一条链上', () => {
  const body = /function filterLocalSongs\(\)\s*\{[\s\S]*?\n\}/.exec(CODE);
  assert.ok(body, '没找到 filterLocalSongs');
  const fn = body[0];
  // 文件夹 → 收藏 → 格式 → 音质 → 完整度 → 专辑 → 关键词
  for (const axis of ['applyFolderToSongs', '_localFavOnly', '_localFmtMode', '_localQualMode',
    '_localMetaMode', '_localAlbumFilter']) {
    assert.ok(fn.includes(axis), `筛选链少了 ${axis}`);
  }
  assert.match(
    fn, /setState\(\s*'localFiltered'/,
    'filterLocalSongs 必须把结果写进 localFiltered —— 三个视图渲染函数全靠它',
  );
  // 且必须按当前视图分发
  assert.match(fn, /_localViewMode\s*===\s*'album'/, 'filterLocalSongs 未按视图分发');
});

// ── 顺带钉住同批修的 i18n 缺口 ──────────────────────────────
test('封面墙卡片歌数走词典（不再硬编码「首」）', () => {
  const body = /function renderLocalAlbumWall\(\)\s*\{[\s\S]*?\n\}/.exec(CODE)[0];
  assert.match(
    body, /t\(\s*'local\.albumSongCount'/,
    '封面墙卡片歌数应走词典 t(\'local.albumSongCount\', {count})',
  );
  assert.doesNotMatch(body, /grid-artist[^`]*\$\{g\.count\}\s*首/, '封面墙卡片歌数仍是硬编码中文「首」');
});

test('词典：local.albumSongCount 中英都在，且带 {count} 占位符', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'lang', 'zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'lang', 'en.json'), 'utf8'));
  assert.ok(zh['local.albumSongCount'], 'zh.json 缺 local.albumSongCount');
  assert.ok(en['local.albumSongCount'], 'en.json 缺 local.albumSongCount');
  for (const [name, dict] of [['zh', zh], ['en', en]]) {
    assert.match(
      dict['local.albumSongCount'], /\{count\}/,
      `${name} 的 local.albumSongCount 缺 {count} 占位符`,
    );
  }
  assert.match(en['local.albumSongCount'], /^\{count\}$/, '英文侧不该再带中文量词');
});
