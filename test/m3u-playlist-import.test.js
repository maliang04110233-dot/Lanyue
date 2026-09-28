/**
 * 导入 m3u 为用户歌单（匹配本地曲库建单，零新通道）
 *
 * 的 m3u 导入走「解析→在线搜索→入队下载」，但本地玩家导出的 m3u
 * 里大多数歌本就躺在曲库——本增量补第二条路：路径/曲名两级匹配本地曲库，
 * 命中歌折叠成 source:'local'+id=filePath（与收藏红心/播放器 file:// 分支
 * 同键形，导入即可播），走既有 saveUserPlaylist 建单。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(
  path.join(__dirname, '../src/renderer/index.html'), 'utf8'
);
const PALETTE_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8'
);

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import('../src/renderer/js/m3uToPlaylist.js?tc=' + Math.random());
}

const LIB = [
  { title: '晴天', artist: '周杰伦', filePath: 'D:\\Music\\jay\\qingtian.mp3', duration: 269 },
  { title: 'Hello', artist: 'Adele', filePath: 'D:/music/hello.flac', duration: 295 },
];

test('parseM3uEntries：EXTINF 描述拆歌手/歌名，"-" 描述回退文件名，纯文本行按 " - " 拆', async () => {
  const { parseM3uEntries } = await fresh();
  const got = parseM3uEntries([
    '#EXTM3U',
    '#EXTINF:269,周杰伦 - 晴天',
    'D:\\Music\\jay\\qingtian.mp3',
    '#EXTINF:295,-',
    'D:/music/hello.flac',
    '#EXTINF:100,',
    'E:\\a\\只歌.m4a',
    '林俊杰 - 记得',
    '#EXTVLCOPT:whatever',
    '',
  ].join('\n'));
  assert.deepStrictEqual(got[0], { title: '晴天', artist: '周杰伦', filePath: 'D:\\Music\\jay\\qingtian.mp3' });
  assert.deepStrictEqual(got[1], { title: 'hello', artist: '', filePath: 'D:/music/hello.flac' });
  assert.deepStrictEqual(got[2], { title: '只歌', artist: '', filePath: 'E:\\a\\只歌.m4a' });
  assert.deepStrictEqual(got[3], { title: '记得', artist: '林俊杰', filePath: null });
  assert.strictEqual(got.length, 4, '指令行不产条目');
  assert.deepStrictEqual(parseM3uEntries(null), []);
  assert.strictEqual(parseM3uEntries('#EXTINF:1,X - Y\n#EXTINF:2,A - B\np.mp3', 99).length, 2,
    '连续 EXTINF 前一条先落袋不吞');
});

test('matchEntriesToLibrary：路径命中（大小写/分隔符归一）与曲名+歌手命中，折叠 local 键形，未命中归账', async () => {
  const { parseM3uEntries, matchEntriesToLibrary } = await fresh();
  const entries = parseM3uEntries([
    '#EXTINF:269,周杰伦 - 晴天',
    'd:\\music\\jay\\QINGTIAN.MP3',      // 路径命中（大小写不同）
    '#EXTINF:295,adele - hello',
    'somewhere\\else\\hello.flac',       // 路径不中（目录不同）→ 曲名+歌手命中
    'Someone - Else',                    // 两头都不中
  ].join('\n'));
  const { matched, unmatched } = matchEntriesToLibrary(entries, LIB);
  assert.strictEqual(matched.length, 2);
  assert.strictEqual(matched[0].title, '晴天');
  assert.strictEqual(matched[0].source, 'local', '折叠 source=local');
  assert.strictEqual(matched[0].id, 'D:\\Music\\jay\\qingtian.mp3', 'id=曲库原路径（不是 m3u 里的变体）');
  assert.strictEqual(matched[1].title, 'Hello');
  assert.strictEqual(matched[1].source, 'local');
  assert.deepStrictEqual(unmatched, ['Else']);
  assert.deepStrictEqual(matchEntriesToLibrary(entries, []), { matched: [], unmatched: ['晴天', 'hello', 'Else'] });
});

test('importM3uAsPlaylist：曲库空回退 loadLibraryIndex，建单走 saveUserPlaylist，desc/播报带未匹配数', async () => {
  const mod = await fresh();
  const toasts = [];
  const saved = [];
  global.showToast = (m, t) => toasts.push([t, m]);
  global.getState = (k) => (k === 'localSongs' ? LIB : null);
  global.window.loadUserPlaylists = async () => {};
  global.api = {
    loadLibraryIndex: async () => { throw new Error('不该走到'); },
    saveUserPlaylist: async (pl) => { saved.push(pl); return { success: true, playlist: { ...pl, id: 'pl9' } }; },
  };
  const text = '#EXTINF:269,周杰伦 - 晴天\nD:\\Music\\jay\\qingtian.mp3\nX - 没有这首歌\np:\\nope.mp3';
  await mod.importM3uAsPlaylist('我的最爱.m3u', text);
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].name, '我的最爱');
  assert.match(saved[0].desc, /m3u 导入 · 1 首，未匹配 2/);
  assert.strictEqual(saved[0].songs.length, 1);
  assert.strictEqual(saved[0].songs[0].source, 'local');
  assert.deepStrictEqual(toasts[toasts.length - 1][0], 'success');
  assert.match(toasts[toasts.length - 1][1], /导入歌单「我的最爱」：匹配 1 首，未匹配 2/);

  // 曲库未加载 → 回退索引通道；空文本/零命中只提示不建单
  const saved2 = [];
  global.getState = () => null;
  global.api = {
    loadLibraryIndex: async () => ({ songs: LIB }),
    saveUserPlaylist: async (pl) => { saved2.push(pl); return { success: true }; },
  };
  await mod.importM3uAsPlaylist('b.m3u8', '#EXTINF:1,adele - hello\nD:/music/hello.flac');
  assert.strictEqual(saved2.length, 1);
  assert.strictEqual(saved2[0].name, 'b', '扩展名 m3u8 也剥');
  await mod.importM3uAsPlaylist('c.m3u', '   ');
  assert.strictEqual(saved2.length, 1, '空文本不建单');
  assert.ok(toasts.some((t) => t[0] === 'warn'));
});

test('接线钉桩：歌单页工具栏按钮 + 模块 window 桥 + 命令面板 pl-m3uimp', async () => {
  const mod = await fresh();
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/js/m3uToPlaylist.js'), 'utf8');
  assert.match(src, /window\.pickM3uForPlaylist = pickM3uForPlaylist;/);
  assert.match(src, /window\.importM3uAsPlaylist = importM3uAsPlaylist;/);
  assert.match(HTML, /onclick="pickM3uForPlaylist\(\)"[^>]*>📥 导入 m3u</);
  assert.match(PALETTE_JS, /id: 'pl-m3uimp'[\s\S]{0,220}?_call\('pickM3uForPlaylist'\)/);
  assert.strictEqual(typeof mod.pickM3uForPlaylist, 'function');
});
