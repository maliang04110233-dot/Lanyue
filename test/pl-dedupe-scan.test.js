/**
 * 我的歌单「🧮 跨歌单重复检测」
 *
 * 84 的清重复只在单歌单内部折叠；同一首歌散在收藏夹+自建单+导入单
 * 无人报警。本模块纯函数扫全量歌单出跨单重复组（本地认 filePath、
 * 在线认 source:id，与收藏线 88/92 同键约定），弹层+复制走 playlist.js
 * 既有 copyText，零新 IPC。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCAN_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/plDedupeScan.js'), 'utf8'
);
const PL_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/playlist.js'), 'utf8'
);
const HTML = fs.readFileSync(
  path.join(__dirname, '../src/renderer/index.html'), 'utf8'
);
const PALETTE_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8'
);

async function fresh() {
  return import('../src/renderer/js/plDedupeScan.js?tc=' + Math.random());
}

test('songDedupeKey：本地认 filePath、在线认 source:id（id=0 合法），drop/缺键/无题一律 null', async () => {
  const { songDedupeKey } = await fresh();
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'local', filePath: 'C:\\m\\a.mp3' }), 'L:C:\\m\\a.mp3');
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'netease', id: 42 }), 'O:netease:42');
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'qq', id: 0 }), 'O:qq:0', 'id=0 是合法曲 id');
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'drop', filePath: 'blob:x' }), null, 'drop 临时行不进报告');
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'local' }), null, '本地缺路径判不了身份');
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'netease' }), null, '在线缺 id 同上');
  assert.strictEqual(songDedupeKey({ source: 'netease', id: 1 }), null, '无题行跳过');
  assert.strictEqual(songDedupeKey(null), null);
});

test('findCrossPlaylistDupes：≥2 单才算跨、单内重复归 84、散落多的排前、同数按歌名', async () => {
  const { findCrossPlaylistDupes } = await fresh();
  const song = (id, title) => ({ id, source: 'netease', title, artist: 'A' });
  const pls = [
    { name: '收藏', songs: [song(1, '甲'), song(2, '乙'), song(2, '乙'), song(3, '丙')] },
    { name: '通勤', songs: [song(2, '乙'), song(1, '甲')] },
    { name: '导入', songs: [song(1, '甲')] },
    { name: '无歌单键', songs: '不是数组' },
    { name: '空' },
  ];
  const g = findCrossPlaylistDupes(pls);
  assert.deepStrictEqual(g.map(x => [x.title, x.where]), [
    ['甲', ['收藏', '通勤', '导入']],
    ['乙', ['收藏', '通勤']],
  ], '单内重复只算一次；×3 在前；丙只在收藏不出');
  assert.deepStrictEqual(g.map(x => x.key), ['O:netease:1', 'O:netease:2'],
    '组上带身份键，收拢才找得回这首歌');
  assert.deepStrictEqual(findCrossPlaylistDupes(null), []);
  assert.deepStrictEqual(findCrossPlaylistDupes([]), []);
});

test('planConsolidate：留扫描序首见单，其余单出整单更新载荷，单内多份一起计入 removed', async () => {
  const { planConsolidate } = await fresh();
  const song = (id, title) => ({ id, source: 'netease', title, artist: 'A' });
  const pls = [
    { id: 'p1', name: '收藏', desc: 'd1', cover: 'c1', songs: [song(1, '甲'), song(2, '乙'), song(2, '乙')] },
    { id: 'p2', name: '通勤', songs: [song(9, '丙'), song(1, '甲')] },
    { id: 'p3', name: '导入', songs: [song(1, '甲'), song(1, '甲'), song(8, '丁')] },
  ];
  const plan = planConsolidate(pls, 'O:netease:1');
  assert.strictEqual(plan.keepPlName, '收藏', '首见单即保留单');
  assert.strictEqual(plan.removed, 3, '通勤 1 份 + 导入 2 份');
  assert.deepStrictEqual(plan.updates.map(u => u.id), ['p2', 'p3'], '更新载荷按扫描序');
  const [u2, u3] = plan.updates;
  assert.strictEqual(u2.name, '通勤');
  assert.strictEqual(u2.desc, '', '缺 desc/cover 补空串：整单载荷字段齐，save-user-playlist 才不丢名');
  assert.strictEqual(u2.cover, '');
  assert.strictEqual(u3.desc, '');
  assert.deepStrictEqual(u2.songs.map(s => s.title), ['丙']);
  assert.deepStrictEqual(u3.songs.map(s => s.title), ['丁'], '保留单不动，其余只留非键行');
  assert.strictEqual(pls[1].songs.length, 2, '入参歌单原件不得被改动（纯）');
  assert.strictEqual(plan.updates[1].songs[0].title, '丁');
});

test('planConsolidate：键无效 / 只一个单有 / 歌已变 / 脏输入 → null（不动刀）', async () => {
  const { planConsolidate } = await fresh();
  const a = { id: 'p1', name: 'A', songs: [{ id: 1, source: 'netease', title: '甲' }] };
  assert.strictEqual(planConsolidate([a], 'O:netease:1'), null, '只一个单有 = 没有跨单可收');
  assert.strictEqual(planConsolidate([a], ''), null, '空键不处理');
  assert.strictEqual(planConsolidate([a], null), null);
  assert.strictEqual(planConsolidate([a], 'O:netease:999'), null, '键已不在任何单（数据变了）');
  assert.strictEqual(planConsolidate(null, 'O:netease:1'), null, '脏输入当空表');
  assert.strictEqual(planConsolidate('x', 'O:netease:1'), null);
});

test('planConsolidate：drop 行无键不参与，首见单缺名回退「未命名歌单」', async () => {
  const { planConsolidate } = await fresh();
  const pls = [
    { id: 'p1', name: '  ', songs: [{ title: '甲', source: 'drop', id: 1 }, { id: 1, source: 'netease', title: '甲' }] },
    { id: 'p2', name: 'B', songs: [{ id: 1, source: 'netease', title: '甲' }] },
  ];
  const plan = planConsolidate(pls, 'O:netease:1');
  assert.strictEqual(plan.keepPlName, '未命名歌单', '空名歌单也要有个能说的名字');
  assert.strictEqual(plan.removed, 1);
  assert.deepStrictEqual(plan.updates.map(u => u.id), ['p2']);
  assert.strictEqual(plan.updates[0].songs.length, 0, '整单清空也是合法载荷');
});

test('dedupeScanText：每组一行「歌 - 歌手 ×N: 单A、单B」，缺歌手不带横杠', async () => {
  const { dedupeScanText } = await fresh();
  const t = dedupeScanText([
    { title: '甲', artist: 'A', where: ['收藏', '通勤'] },
    { title: '乙', artist: '', where: ['X'] },
  ]);
  assert.strictEqual(t, '「甲 - A」×2: 收藏、通勤\n「乙」×1: X');
  assert.strictEqual(dedupeScanText(null), '');
});

test('接线钉桩：playlist.js 纯函数导入+三桥、HTML 按钮、面板 pl-dedupescan、扫描模块零 DOM', () => {
  assert.match(SCAN_JS, /export function songDedupeKey\(s\) \{/);
  assert.ok(!/document\.|window\./.test(SCAN_JS), '纯函数模块零 DOM');
  assert.match(PL_JS, /import \{ findCrossPlaylistDupes, dedupeScanText, planConsolidate \} from '\.\.\/plDedupeScan\.js';/);
  assert.match(PL_JS, /function scanCrossPlaylistDupes\(\) \{\n {2}const pls = \(getState\('userPlaylists'\)/);
  assert.match(PL_JS, /window\.scanCrossPlaylistDupes = scanCrossPlaylistDupes;/);
  assert.match(PL_JS, /window\.copyDedupeScanReport = copyDedupeScanReport;/);
  assert.match(PL_JS, /overlay\.id = 'dedupeScanModal';/, '动态弹层用专属 id，不与静态容器撞');
  assert.match(HTML, /<button class="tab"[^>]*onclick="scanCrossPlaylistDupes\(\)"[^>]*>🧮 跨单查重<\/button>/);
  assert.match(PALETTE_JS, /\{ id: 'pl-dedupescan'[\s\S]{0,160}?_call\('scanCrossPlaylistDupes'\) \},/);
});

test('接线钉桩：逐行 🧲 收拢按钮 + consolidateDup 走 save-user-playlist，零新通道', () => {
  assert.match(SCAN_JS, /export function planConsolidate\(playlists, key\) \{/);
  assert.match(PL_JS, /onclick="consolidateDup\(\$\{i\}\)"[^>]*>🧲 收拢<\/button>/, '每行一枚收拢按钮，下标随组走');
  assert.match(PL_JS, /groups\.map\(\(g, i\) =>/);
  assert.match(PL_JS, /async function consolidateDup\(i\) \{/);
  assert.match(PL_JS, /window\.consolidateDup = consolidateDup;/);
  assert.ok(PL_JS.includes('保留在首见歌单'), '按钮 title 说清留哪删哪');
  assert.ok(PL_JS.includes('（不删文件）'), '口径：只动歌单成员，不碰本地文件');
  assert.ok(PL_JS.includes('if (!await askConfirm('), '写盘前先确认');
  assert.ok(PL_JS.includes('const r = await api.saveUserPlaylist(u);'), '复用整单更新通道，不新增 IPC');
  assert.ok(!/\bipcRenderer\b|invoke\('/.test(PL_JS), 'playlist 视图从不直连 ipcRenderer');
});
