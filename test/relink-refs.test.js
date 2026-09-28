/**
 * 文件重命名后把所有路径引用一起搬走
 *
 * 症状（用户视角）：本地曲库「✏ 批量重命名」把文件名改漂亮之后 ——
 *   下载历史 / 搜索结果里的「✔ 已下载」徽标成片消失，
 *   同一首歌下次搜索会被重新下载一遍（assets 去重索引自愈式删行），
 *   歌单与 ♥ 收藏夹里的本地歌全播不动，
 *   手写过 / 自动补过的 .lrc 歌词不再跟着歌走，
 *   播放进度记忆整片归零。
 * 机理：rename-file 只 fs.rename 磁盘文件，一处记录都不回写。
 *   findDownloaded 见 save_path 指向的文件不在，就地删掉 assets 行 —— 徽标
 *   消失 + 重复下载都是这一步造成的。
 * 这里全部走真件（真 sqlite / 真 prefs / 真临时文件），不用 mock。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sidecarPathFor,
  pathsEqual,
  relinkPlaylists,
  relinkProgressMap,
  relinkRecent,
} = require('../src/utils/relinkRefs');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

test('sidecarPathFor：沿用既有 .lrc 约定（换末段扩展名，无扩展名则追加）', () => {
  assert.equal(sidecarPathFor('D:/music/a.mp3'), 'D:/music/a.lrc');
  assert.equal(sidecarPathFor('D:/music/a.flac'), 'D:/music/a.lrc');
  // 与 library.js 现有写法逐字符一致：只替换最后一段扩展名
  assert.equal(sidecarPathFor('D:/music/a.tar.gz'), 'D:/music/a.tar.lrc');
  assert.equal(sidecarPathFor('D:/music/noext'), 'D:/music/noext.lrc');
});

test('pathsEqual：同一文件的两种写法算同一，不同文件算不同，脏入参不炸', () => {
  assert.ok(pathsEqual('D:\\music\\a.mp3', 'D:/music/a.mp3'), '分隔符不同必须算同一首歌，否则回写会漏');
  assert.ok(pathsEqual('/m/a.mp3', '/m//a.mp3'));
  assert.ok(!pathsEqual('/m/a.mp3', '/m/b.mp3'));
  assert.ok(!pathsEqual('/m/a.mp3', '/m/deep/a.mp3'));
  for (const bad of [null, undefined, '', 0, {}, []]) {
    assert.ok(!pathsEqual(bad, '/m/a.mp3'), '脏入参一律判不等，不能抛');
    assert.ok(!pathsEqual('/m/a.mp3', bad));
  }
  if (process.platform === 'win32') {
    assert.ok(pathsEqual('D:\\Music\\A.mp3', 'd:/music/a.mp3'), 'Windows 文件名不分大小写');
  }
});

test('relinkPlaylists：命中的歌曲换新路径，其他歌曲原样，入参不被就地改写', () => {
  const old = 'D:/music/old.mp3';
  const next = 'D:/music/new.mp3';
  const input = [
    { id: 'p1', name: '本地', songs: [{ title: 'A', filePath: 'D:\\music\\old.mp3' }, { title: 'B', filePath: 'D:/other.mp3' }] },
    { id: 'p2', songs: [{ title: 'C', filePath: old }] },
    { id: 'p3', songs: null },
  ];
  const { playlists, changed } = relinkPlaylists(input, old, next);
  assert.equal(changed, 2, '两条路径引用（含反斜杠写法）都该认出来');
  assert.equal(playlists[0].songs[0].filePath, next);
  assert.equal(playlists[0].songs[1].filePath, 'D:/other.mp3');
  assert.equal(playlists[1].songs[0].filePath, next);
  assert.deepEqual(playlists[2].songs, null);
  // 入参保真：返回新数组新对象，原结构一字未动（渲染层可能还持有旧引用）
  assert.equal(input[0].songs[0].filePath, 'D:\\music\\old.mp3');
  assert.notEqual(playlists, input);
  for (const bad of [null, undefined, 'x', [{}]]) {
    assert.deepEqual(relinkPlaylists(bad, old, next).playlists, bad || []);
    assert.equal(relinkPlaylists(bad, old, next).changed, 0);
  }
});

test('relinkProgressMap：键跟着搬家，撞车时 savedAt 新者胜', () => {
  const old = 'D:/music/old.mp3';
  const next = 'D:/music/new.mp3';
  const { map, changed } = relinkProgressMap(
    { [old]: { time: 42, savedAt: 100 }, '/m/keep.mp3': { time: 7, savedAt: 5 } },
    old, next,
  );
  assert.equal(changed, 1);
  assert.ok(!(old in map), '旧键必须清掉，否则清不掉的僵尸键会一直占 200 首上限的名额');
  assert.deepEqual(map[next], { time: 42, savedAt: 100 });
  assert.deepEqual(map['/m/keep.mp3'], { time: 7, savedAt: 5 });

  // 目标位置已有更新的进度（用户在新文件名下又听过）⇒ 不能被旧进度覆盖
  const r2 = relinkProgressMap(
    { [old]: { time: 10, savedAt: 100 }, [next]: { time: 99, savedAt: 200 } }, old, next,
  );
  assert.deepEqual(r2.map[next], { time: 99, savedAt: 200 });
  assert.ok(!(old in r2.map));
  for (const bad of [null, undefined, 'x', 0, []]) {
    assert.deepEqual(relinkProgressMap(bad, old, next).map, {});
  }
});

test('relinkRecent：JSON 串里的 filePath 跟着改，坏串原样退回', () => {
  const old = 'D:/music/old.mp3';
  const next = 'D:/music/new.mp3';
  const raw = JSON.stringify([
    { title: 'A', filePath: old },
    { title: 'B', filePath: '' },
    { title: 'C', id: 'x', source: 'netease' },
  ]);
  const { value, changed } = relinkRecent(raw, old, next);
  assert.equal(changed, 1);
  const back = JSON.parse(value);
  assert.equal(back[0].filePath, next);
  assert.equal(back[1].filePath, '', '空 filePath 是在线歌的正常值，不该被当成命中');
  assert.deepEqual(Object.keys(back[2]).sort(), ['id', 'source', 'title']);
  for (const bad of ['not json', '', null, undefined, '{"a":1}']) {
    const r = relinkRecent(bad, old, next);
    assert.equal(r.changed, 0);
    assert.equal(r.value, bad, '解析不了就原样退回，不销毁用户数据');
  }
});

test('history.relinkPath：真 sqlite 回写 save_path + data，徽标与去重索引同时自愈', () => {
  const history = require('../src/utils/history');
  const dir = tmp('musicdl-relink-his-');
  const songDir = tmp('musicdl-relink-songs-');
  const oldPath = path.join(songDir, 'old name.mp3');
  const newPath = path.join(songDir, 'new name.mp3');
  // 只在新文件名处有实体文件 —— 正是"改名后"的真实状态
  fs.writeFileSync(newPath, 'x');
  fs.writeFileSync(path.join(songDir, 'other.flac'), 'y');

  history.init(dir);
  history.clear();
  history.add({ id: '1', source: 'netease', title: 'A', status: 'done', savePath: oldPath, filePath: oldPath, finishedAt: 1000 });
  history.add({ id: '2', source: 'qq', title: 'B', status: 'done', savePath: path.join(songDir, 'other.flac'), finishedAt: 2000 });

  // 先复现 bug：改名后旧记录指向不存在的文件，findDownloaded 会顺手删掉 assets 行
  assert.equal(history.findDownloaded('1', 'netease'), null, '改名后徽标消失（本增量的靶子）');

  assert.equal(history.relinkPath(oldPath, newPath), 1);
  const e = history.findDownloaded('1', 'netease');
  assert.ok(e, '回写之后必须重新认账（含 assets 行自愈）');
  assert.equal(e.savePath, newPath);
  assert.equal(e.filePath, newPath);
  const other = history.findDownloaded('2', 'qq');
  assert.equal(other.savePath, path.join(songDir, 'other.flac'), '没中的记录不能被顺手改掉');

  // 分隔符写法不同也算同一首歌
  assert.equal(history.relinkPath(newPath, newPath.replace(/\\/g, '/')), 1);
  assert.equal(history.findDownloaded('1', 'netease').savePath, newPath.replace(/\\/g, '/'));
  assert.equal(history.relinkPath(path.join(songDir, 'gone.mp3'), newPath), 0, '未命中要如实返回 0');
  history.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(songDir, { recursive: true, force: true });
});

test('relinkFileRefs：一次改名的全部落库回写 + .lrc sidecar 跟着搬', async () => {
  const prefs = require('../src/utils/prefs');
  const history = require('../src/utils/history');
  const { relinkFileRefs } = require('../src/utils/fileRelink');
  const dir = tmp('musicdl-relink-prefs-');
  const hisDir = tmp('musicdl-relink-his2-');
  const songDir = tmp('musicdl-relink-songs2-');
  const oldPath = path.join(songDir, 'old.mp3');
  const newPath = path.join(songDir, 'new.mp3');
  fs.writeFileSync(newPath, 'x');
  const oldLrc = sidecarPathFor(oldPath);
  fs.writeFileSync(oldLrc, '[00:00.00]词');

  prefs.init(dir);
  prefs.set('userPlaylists', [
    { id: 'p1', songs: [{ title: 'A', filePath: oldPath }, { title: 'B', filePath: '/m/keep.mp3' }] },
    { id: 'p2', songs: [{ title: 'C', filePath: '/m/keep.mp3' }] },
  ]);
  prefs.set('recentlyPlayed', JSON.stringify([{ title: 'A', filePath: oldPath }]));
  prefs.set('playProgressMap', { [oldPath]: { time: 30, savedAt: 1 } });
  history.init(hisDir);
  history.clear();
  history.add({ id: '1', source: 'netease', title: 'A', status: 'done', savePath: oldPath, finishedAt: 1000 });

  const r = await relinkFileRefs(oldPath, newPath);
  assert.equal(r.history, 1);
  assert.equal(r.playlists, 1);
  assert.equal(r.recent, 1);
  assert.equal(r.progress, 1);
  assert.equal(r.lyricRenamed, true);

  assert.equal(prefs.get('userPlaylists')[0].songs[0].filePath, newPath);
  assert.equal(prefs.get('userPlaylists')[0].songs[1].filePath, '/m/keep.mp3');
  assert.equal(prefs.get('userPlaylists')[1].songs[0].filePath, '/m/keep.mp3');
  assert.equal(JSON.parse(prefs.get('recentlyPlayed'))[0].filePath, newPath);
  assert.ok(sidecarPathFor(newPath) && fs.existsSync(sidecarPathFor(newPath)), '歌词要跟到新文件名旁');
  assert.ok(!fs.existsSync(oldLrc), '旧 .lrc 不能留着当孤儿');
  assert.ok(!fs.existsSync(oldPath), '旧路径不该被本次操作造出文件');
  assert.equal(history.findDownloaded('1', 'netease').savePath, newPath);

  // 目标旁已有 .lrc（用户在新名下另存过词）⇒ 绝不覆盖，旧词留在原处
  fs.writeFileSync(oldPath, 'x');
  fs.writeFileSync(oldLrc, '[00:00.00]旧词');
  fs.writeFileSync(sidecarPathFor(newPath), '[00:00.00]新词');
  const r2 = await relinkFileRefs(oldPath, newPath);
  assert.equal(r2.lyricRenamed, false);
  assert.equal(fs.readFileSync(sidecarPathFor(newPath), 'utf8'), '[00:00.00]新词');
  assert.ok(fs.existsSync(oldLrc), '撞车时不删任何用户的歌词');

  prefs.destroy();
  history.destroy();
  for (const d of [dir, hisDir, songDir]) fs.rmSync(d, { recursive: true, force: true });
});

test('接线：rename-file 成功后必走 relink，且没有为它开新通道', () => {
  const lib = read('src/main/ipc/library.js');
  const renameBlock = lib.slice(lib.indexOf("handle('rename-file'"), lib.indexOf("handle('convert-audio'"));
  assert.ok(renameBlock.includes('relinkFileRefs('), 'rename-file 没接回写');
  assert.ok(renameBlock.indexOf('fsp.rename') < renameBlock.indexOf('relinkFileRefs('), '回写必须在文件真的改成功之后');
  assert.match(lib, /success:\s*true,\s*relink/, '回写结果要随返回值上去，前端才能如实说');

  const contract = read('src/shared/ipcContract.js');
  assert.ok(!/'[a-z-]*(relink|rename-refs|rename-sync|sync-refs|relink-path)'/.test(contract), '不该为此功能新增通道名');
  assert.match(
    contract,
    /'rename-file':\s*\{ invoke: MAIN, args: \[\['oldPath', t\.str\(1024\)\], \['newPath', t\.str\(1024\)\]\] \}/,
    '回写不需要新参数、更不需要新通道（契约形状变了就是走偏了）',
  );

  // .lrc 命名约定收成一处：library.js 自己那两处内联表达式必须换用 sidecarPathFor
  assert.ok(!lib.includes("replace(/\\.[^.]+$/, '.lrc')"), 'library.js 还在内联拼 .lrc 路径（第 4 份约定必然漂移）');
  assert.ok(/const \{ sidecarPathFor \} = require\('\.\.\/\.\.\/utils\/relinkRefs'\)/.test(lib), '没引 sidecarPathFor');
  assert.equal((lib.match(/sidecarPathFor\(/g) || []).length, 2, '读写两侧都走同一个约定函数');
});

test('接线：批量重命名后刷新内存歌单，并把回写失败如实说出口', () => {
  const local = read('src/renderer/js/views/local.js');
  const block = local.slice(local.indexOf('async function executeBatchRename'), local.indexOf('async function batchDownloadCovers'));
  // 主进程回写的是盘上的 prefs；渲染层还攥着一份旧的 userPlaylists，
  // 不刷新的话用户下次收藏/建歌单就把刚回写的路径又覆盖回去（回写白做）
  assert.ok(block.indexOf('api.renameFile') < block.indexOf('loadUserPlaylists'), '改名之后必须重拉歌单');
  assert.ok(block.includes('relink'), '主进程如实上报的回写结果得被用上：失败要提示，不能闷声');
  // 仍然只用既有那一条通道，不给渲染层新开口子
  assert.ok(!/api\.(relink|syncPath|renameRefs)/.test(local), '不该为此功能新增前端 API');
});
