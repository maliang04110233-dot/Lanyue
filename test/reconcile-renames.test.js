/**
 * 外部改名/移动对账
 *
 * 症状（用户视角）：在资源管理器里把下载好的歌改了名（或者用了「✏ 批量重命名」之外的
 * 任何工具：音乐标签编辑器、另一台设备同步、手动整理），回到 app：
 *   「✔ 已下载」徽标没了、同一首歌会被重新下一遍、歌单/♥ 收藏里的本地歌播不动、
 *   播放进度归零。而且 app 全程一声不吭 —— 它压根不知道发生过改名。
 * 治的是"app 自己改的名"；这里治"别人改的名"：曲库扫描本来就握着磁盘上
 * 真实的文件列表和它们的 ID3 标题/歌手，拿它去对账下载历史里指向空路径的记录，
 * 唯一命中就接回来（回写复用 149 的 relinkFileRefs，一条通道都不新开）。
 *
 * 判"失联"用的是本次扫描结果本身（不再 stat 磁盘）：扫描目录之外的记录本来也无从指认。
 * 全部走真件（真 sqlite / 真 prefs），不用 mock。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { matchRenamedRefs } = require('../src/utils/reconcileRenames');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const ref = (o = {}) => ({ id: '1', source: 'netease', title: '晴天', artist: '周杰伦', savePath: 'D:/music/晴天 - 周杰伦.mp3', ...o });
const song = (o = {}) => ({ filePath: 'D:/music/周杰伦 - 晴天.mp3', title: '晴天', artist: '周杰伦', ...o });

test('matchRenamedRefs：同目录 + 标题歌手相等 + 唯一候选 ⇒ 指认到新文件（保留磁盘真实写法）', () => {
  const r = matchRenamedRefs([ref()], [song()]);
  assert.equal(r.fixes.length, 1, '改名后的文件必须被认回来');
  assert.equal(r.fixes[0].from, 'D:/music/晴天 - 周杰伦.mp3');
  assert.equal(r.fixes[0].to, 'D:/music/周杰伦 - 晴天.mp3', '回写要用扫描到的真实路径，不是归一化后的写法');
  assert.equal(r.fixes[0].id, '1');
  assert.equal(r.fixes[0].source, 'netease');

  // 标题/歌手的大小写与多余空白漂移不算不匹配（ID3 与历史记录各有各的写法）
  const r2 = matchRenamedRefs(
    [ref({ title: '  Sunny ', artist: 'JAY CHOU' })],
    [song({ title: 'sunny', artist: 'Jay  Chou' })],
  );
  assert.equal(r2.fixes.length, 1, '顺手清理空白/大小写，否则对账等于没做');
});

test('matchRenamedRefs：候选不唯一 ⇒ 一条都不修（宁可不认，也不能把 B 歌的账记到 A 歌头上）', () => {
  const r = matchRenamedRefs([ref()], [
    song(),
    song({ filePath: 'D:/music/重录版 - 晴天.mp3' }),
  ]);
  assert.deepEqual(r.fixes, [], '同目录两首同名同歌手，指认哪个都是赌');
  assert.equal(r.ambiguous, 1, '这种情况得如实计数，主进程好写日志');
});

test('matchRenamedRefs：两条记录抢同一个新文件（来源路径不同）⇒ 都不接；来源路径相同 ⇒ 都接', () => {
  // 两个平台的同一首歌，各自存过不同路径，磁盘只剩一个文件 ⇒ 认错概率对半，放弃
  const clash = matchRenamedRefs([
    ref({ id: '1', source: 'netease' }),
    ref({ id: '2', source: 'qq', savePath: 'D:/music/另一份 - 晴天.mp3' }),
  ], [song()]);
  assert.deepEqual(clash.fixes, []);
  assert.equal(clash.ambiguous, 2);

  // 同一首歌被重复登记（同一路径）时，两条记录本就该指向同一个文件
  const same = matchRenamedRefs([
    ref({ id: '1', source: 'netease' }),
    ref({ id: '2', source: 'qq' }),
  ], [song()]);
  assert.equal(same.fixes.length, 2, '同一个旧路径的两条记录一起接回，才不会留半条僵尸账');
  assert.equal(same.ambiguous, 0);
});

test('matchRenamedRefs：路径还在（哪怕写法不同）或压根没有候选 ⇒ 不动它', () => {
  const still = matchRenamedRefs(
    [ref({ savePath: 'd:\\music\\晴天 - 周杰伦.mp3' })],
    [song({ filePath: 'D:/music/晴天 - 周杰伦.mp3', title: '晴天 - 周杰伦', artist: '周杰伦' })],
  );
  assert.deepEqual(still.fixes, [], '文件没动过就不该"修"：判等漏了会把没改名的歌也重记一遍');
  assert.equal(still.ambiguous, 0);

  const gone = matchRenamedRefs([ref()], [song({ title: '稻香', artist: '周杰伦', filePath: 'D:/music/稻香.mp3' })]);
  assert.deepEqual(gone.fixes, [], '用户自己删了文件（或改名到别的目录）没有候选，不该硬凑');
  assert.equal(gone.ambiguous, 0);

  // 只认同目录：跨目录移动是"搬家"，同目录里有同名文件时才会撞车，这里保守处理
  const moved = matchRenamedRefs([ref()], [song({ filePath: 'D:/other/周杰伦 - 晴天.mp3' })]);
  assert.deepEqual(moved.fixes, [], '换了目录就不是改名，指认错的风险高得多');
});

test('matchRenamedRefs：脏入参与空标题不炸、也不认', () => {
  for (const bad of [null, undefined, 'x', 0, [null, {}]]) {
    const r = matchRenamedRefs(bad, [song()]);
    assert.deepEqual(r.fixes, []);
    assert.equal(r.ambiguous, 0);
    const r2 = matchRenamedRefs([ref()], bad);
    assert.deepEqual(r2.fixes, []);
  }
  // 标题为空的记录没有任何可指认特征，绝不能按"同目录唯一 mp3"就认下来
  assert.deepEqual(matchRenamedRefs([ref({ title: '  ', artist: '周杰伦' })], [song()]).fixes, []);
  assert.deepEqual(matchRenamedRefs([ref({ savePath: '' })], [song()]).fixes, []);
  assert.deepEqual(matchRenamedRefs([ref()], [song({ filePath: '' })]).fixes, []);
});

test('reconcileScannedRefs：真 sqlite + 真 prefs 走一遍，徽标/歌单/进度一起回来', async () => {
  const history = require('../src/utils/history');
  const prefs = require('../src/utils/prefs');
  const { reconcileScannedRefs } = require('../src/utils/fileRelink');
  const hisDir = tmp('musicdl-recon-his-');
  const prefDir = tmp('musicdl-recon-prefs-');
  const songDir = tmp('musicdl-recon-songs-');
  const stale = path.join(songDir, '晴天 - 周杰伦.mp3');
  const real = path.join(songDir, '周杰伦 - 晴天.flac');
  fs.writeFileSync(real, 'x');

  history.init(hisDir);
  history.clear();
  prefs.init(prefDir);
  prefs.set('userPlaylists', [{ id: 'p1', songs: [{ title: '晴天', filePath: stale }] }]);
  prefs.set('playProgressMap', { [stale]: { time: 61, savedAt: 9 } });
  history.add({ id: '1', source: 'netease', title: '晴天', artist: '周杰伦', status: 'done', savePath: stale, finishedAt: 1000 });
  // 同名同歌手的失败记录：候选完全一样，若被拉进对账就会把"没下成"的歌认成已下载
  history.add({ id: '2', source: 'qq', title: '晴天', artist: '周杰伦', status: 'error', savePath: stale, finishedAt: 1 });

  assert.equal(history.findDownloaded('1', 'netease'), null, '改名后徽标消失（本增量的靶子）');

  const out = await reconcileScannedRefs([
    { filePath: real, title: '晴天', artist: '周杰伦' },
    { filePath: path.join(songDir, '稻香.mp3'), title: '稻香', artist: '周杰伦' },
  ]);
  assert.equal(out.fixed, 1);
  assert.equal(history.findDownloaded('1', 'netease').savePath, real, '徽标与去重索引必须一起回来');
  assert.equal(history.findDownloaded('2', 'qq'), null, '失败记录没有徽标可修，不该被顺手认账');
  assert.equal(prefs.get('userPlaylists')[0].songs[0].filePath, real, '歌单里的本地歌重新能播');
  assert.deepEqual(prefs.get('playProgressMap')[real], { time: 61, savedAt: 9 });

  // 幂等：同一批扫描结果再对账一次，无账可改
  assert.equal((await reconcileScannedRefs([{ filePath: real, title: '晴天', artist: '周杰伦' }])).fixed, 0);

  history.destroy();
  prefs.destroy();
  for (const d of [hisDir, prefDir, songDir]) fs.rmSync(d, { recursive: true, force: true });
});

test('接线：扫描成功后对账并如实上报，前端不另开通道', () => {
  const lib = read('src/main/ipc/library.js');
  assert.match(lib, /require\('\.\.\/\.\.\/utils\/fileRelink'\)/, '没引对账函数');
  assert.equal((lib.match(/reconcileScannedRefs\(/g) || []).length, 2, '增量与全量两条扫描出口都得对账，漏一条就是半残功能');
  assert.equal((lib.match(/relinked/g) || []).length >= 2, true, '对账结果要随 scan-local-library 的返回值上去');

  const scanBlock = lib.slice(lib.indexOf("handle('scan-local-library'"), lib.indexOf("handle('load-library-index'"));
  assert.ok(!scanBlock.includes('history.add'), '对账只修路径引用，不许改历史内容');

  const local = read('src/renderer/js/views/local.js');
  assert.ok(/function _relinkNote/.test(local), '扫描提示里得把"接回了几个"说给用户听');
  assert.ok((local.match(/_relinkNote\(/g) || []).length >= 4, '手工扫描/换目录重试/自动刷新三条路径都要说');
  assert.ok(/async function _relinkNote[\s\S]{0,700}loadUserPlaylists/.test(local),
    '接回之后必须重拉歌单：渲染层还攥着旧路径的话，下次保存歌单就把主进程的回写覆盖回去了（0d07b92 同一个坑）');
  assert.ok(!/api\.(reconcile|relinkRefs|fixPath)/.test(local), '不该为此功能新增前端 API');

  const contract = read('src/shared/ipcContract.js');
  assert.ok(!/'[a-z-]*(reconcile|relink|refix|reattach)'/.test(contract), '不该为此功能新增通道名');
  assert.match(contract, /'scan-local-library':\s*\{ invoke: MAIN, args: \[\['dirPath', t\.str\(1024\)\]\] \}/,
    '对账复用扫描的返回值：参数形状不该变');

  // 路径归一只能有一份实现（/151 的教训：手抄的第二份必然漂移）
  const recon = read('src/utils/reconcileRenames.js');
  assert.ok(/require\('\.\/relinkRefs'\)/.test(recon), '自己另写一份路径归一 = 埋第二把雷');
  assert.ok(!/replace\(\/\\\\\/g/.test(recon), '不该在别处再抄一遍反斜杠归一');
});
