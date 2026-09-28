/**
 * 拖入音频文件即播（blob 队列行 source:'drop'，重启不残留，零新通道）
 *
 * dragdrop.js 此前只接管 .lrc，其余文件不处理；本增量把资源管理器里的
 * 音频文件（可多选）直接拖进窗口即入播放队列即播：URL.createObjectURL
 * 造 blob:（CSP media-src 放行 blob:），不取流、不进收藏（id:null →
 * queueFavSong 不出红心）。blob 出会话即死，恢复持久化队列前
 * sanitizeSavedQueue 滤掉拖放行并重排 playIdx（player-sync 守卫零 import，
 * 故消毒放 app.js 调用侧）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', 'src/renderer', rel), 'utf8');
}

async function fresh() {
  return import('../src/renderer/js/dropPlay.js?tc=' + Math.random());
}

test('planDropSongs：只挑音频扩展名，文件名拆歌手/歌名，行键形 source:drop + id:null', async () => {
  const { planDropSongs, isDropAudioName } = await fresh();
  assert.ok(isDropAudioName('a.MP3') && isDropAudioName('只歌.flac') && !isDropAudioName('x.lrc'));
  const got = planDropSongs([
    { name: '周杰伦 - 晴天.mp3', size: 1 },
    { name: 'cover.jpg', size: 1 },
    { name: '只歌.flac', size: 1 },
    { name: 'list.m3u', size: 1 },
  ]);
  assert.strictEqual(got.files.length, 2);
  assert.strictEqual(got.rows.length, 2);
  assert.strictEqual(got.truncated, 0);
  assert.deepStrictEqual(got.rows[0], {
    title: '晴天', artist: '周杰伦', source: 'drop', id: null,
    filePath: null, duration: null, cover: '', _dropIdx: 0,
  });
  assert.strictEqual(got.rows[1].title, '只歌');
  assert.strictEqual(got.rows[1].artist, '');
  assert.strictEqual(got.rows[1]._dropIdx, 1, '_dropIdx 回链挑出的 files 下标');
  assert.deepStrictEqual(planDropSongs(null).rows, []);
  assert.deepStrictEqual(planDropSongs([]).rows, []);
});

test('planDropSongs：封顶 MAX_DROP_FILES 并报 truncated', async () => {
  const { planDropSongs, MAX_DROP_FILES } = await fresh();
  const many = Array.from({ length: MAX_DROP_FILES + 10 }, (_, i) => ({ name: `歌${i}.mp3`, size: 1 }));
  const got = planDropSongs(many);
  assert.strictEqual(got.rows.length, MAX_DROP_FILES);
  assert.strictEqual(got.truncated, 10);
});

test('filterDropRows / sanitizeSavedQueue：无拖放行原对象直返，有则滤行并重排 playIdx', async () => {
  const { filterDropRows, sanitizeSavedQueue } = await fresh();
  const a = { title: 'a', source: 'netease' };
  const d = { title: 'd', source: 'drop' };
  const c = { title: 'c', source: 'qq' };
  assert.deepStrictEqual(filterDropRows([a, d, c]), [a, c]);
  assert.strictEqual(filterDropRows(null).length, 0);

  const clean = { queue: [a, c], playIdx: 1 };
  assert.strictEqual(sanitizeSavedQueue(clean), clean, '无拖放行必须原样返回（player-sync 行为零变化）');
  assert.strictEqual(sanitizeSavedQueue(null), null);
  assert.strictEqual(sanitizeSavedQueue({}).queue, undefined);

  const cur = sanitizeSavedQueue({ queue: [a, d, c], playIdx: 2 });
  assert.deepStrictEqual(cur.queue, [a, c]);
  assert.strictEqual(cur.playIdx, 1, '当前行存活则重映射到新下标');

  const gone = sanitizeSavedQueue({ queue: [a, d, c], playIdx: 1 });
  assert.strictEqual(gone.playIdx, 0, '当前行正是拖放行则回 0');

  const front = sanitizeSavedQueue({ queue: [d, c], playIdx: 1 });
  assert.deepStrictEqual(front.queue, [c]);
  assert.strictEqual(front.playIdx, 0);
});

test('接线：dragdrop 接管音频投放、player 走 blob 分支、app.js 恢复前消毒、m3u 桥 node 安全', () => {
  const dd = read('js/views/dragdrop.js');
  assert.ok(dd.includes("import { planDropSongs, isDropAudioName } from '../dropPlay.js';"), 'dragdrop 未接 dropPlay');
  assert.ok(dd.includes("import { playQueueIdx } from '../player.js';"), 'dragdrop 未接 playQueueIdx');
  assert.ok(dd.includes('URL.createObjectURL(picked[row._dropIdx])'), '未按 _dropIdx 回链造 blob');
  assert.ok(dd.includes('if (await _handleLrcDrop(e.dataTransfer)) return;'), 'lrc 优先接管后被绕过');
  assert.ok(dd.includes('_handleAudioDrop(e.dataTransfer);'), '音频分支未接入 drop 处理');
  assert.ok(dd.includes('松手拖入音频立即播放'), '悬停提示缺音频文案');
  assert.ok(dd.includes('拖入 ${rows.length} 首'), '缺拖入播报');

  const pl = read('js/player.js');
  assert.ok(pl.includes("if (song.source === 'drop')"), 'playSongByIdx 缺 drop 分支');
  assert.ok(pl.includes('await loadAndPlay(song, song._blobUrl, true);'), 'drop 分支未走 blob');
  assert.ok(pl.includes('拖放歌曲已失效'), '缺失效提示');

  const app = read('js/app.js');
  const m = app.match(/restorePlayQueueFromSaved\(sanitizeSavedQueue\(saved\)\);/g) || [];
  assert.strictEqual(m.length, 2, '两个恢复调用点必须都先消毒');

  const m3u = read('js/m3uToPlaylist.js');
  assert.ok(m3u.includes('export const AUDIO_EXT_RE'), 'AUDIO_EXT_RE 未导出');
  assert.ok(m3u.includes('export function splitTitleArtist'), 'splitTitleArtist 未导出');
  assert.ok(m3u.includes("if (typeof window !== 'undefined')"), 'window 桥未做 node 防护');

  const sync = read('js/player-sync.js');
  assert.ok(!/^\s*import\s/m.test(sync), 'player-sync 被其守卫测试禁止 import');
});
