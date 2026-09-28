/**
 * 「📋 复制听歌报告」—— playReportText.js 纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATS_JS = readFileSync(path.join(ROOT, 'src/renderer/js/player/stats.js'), 'utf8');
const PLAYER_JS = readFileSync(path.join(ROOT, 'src/renderer/js/player.js'), 'utf8');
const PALETTE_JS = readFileSync(path.join(ROOT, 'src/renderer/js/commandPalette.js'), 'utf8');

async function fresh() {
  return import('../src/renderer/js/playReportText.js?tc=' + Math.random());
}

test('topArtistsFromPlayCount：||| 键还原聚合、空歌手归未知、脏计数剔除、降序同数 zh 序', async () => {
  const { topArtistsFromPlayCount, UNKNOWN_ARTIST_TEXT } = await fresh();
  assert.equal(UNKNOWN_ARTIST_TEXT, '未知');
  assert.deepEqual(topArtistsFromPlayCount(null), []);
  assert.deepEqual(topArtistsFromPlayCount({}), []);
  const pc = {
    'A song|||Zhou': 3,
    'B song|||Zhou': 3,      // Zhou 合计 6
    'C song|||': 4,          // 空歌手 → 未知
    'D song|||  ': 1,        // 纯空白也归未知（并进未知桶）
    'E song|||Ada': 4,       // 与 Zara 同为 4：zh 序 Ada 在前
    'H song|||Zara': 4,
    'F song|||Neg': 0,
    'G song|||Bad': 'x',     // 非数字计数整行剔除（不记 1）
  };
  const all = topArtistsFromPlayCount(pc);
  assert.deepEqual(all.map(x => `${x.artist}:${x.count}`), ['Zhou:6', '未知:5', 'Ada:4', 'Zara:4']);
  assert.deepEqual(topArtistsFromPlayCount(pc, 2).map(x => x.artist), ['Zhou', '未知']);
});

test('formatReportText：全段齐活逐行精确；空段整体省略不造假 0', async () => {
  const { formatReportText } = await fresh();
  const text = formatReportText({
    totalPlayTimeText: '3小时20分钟',
    totalSongs: 42,
    artistTotal: 9,
    mostPlayed: [
      { title: '晴天', artist: '周杰伦', count: 12 },
      { title: 'NoArtist', artist: '', count: 3 },
    ],
    topArtists: [{ artist: '周杰伦', count: 30 }],
    lastPlayed: { title: '稻香', artist: '周杰伦' },
  });
  assert.deepEqual(text.split('\n'), [
    '📊 揽乐 听歌报告',
    '⏱️ 总播放时长：3小时20分钟',
    '🎵 播放歌曲数：42',
    '🎤 收听歌手数：9',
    '',
    '🏆 最爱歌曲 TOP 2',
    '1. 晴天 - 周杰伦 (12 次)',
    '2. NoArtist (3 次)',
    '',
    '🎤 最爱歌手 TOP 1',
    '1. 周杰伦 (30 次)',
    '',
    '📀 最后播放：稻香 - 周杰伦',
  ]);
  const bare = formatReportText({});
  assert.deepEqual(bare.split('\n'), [
    '📊 揽乐 听歌报告',
    '⏱️ 总播放时长：0分钟',
    '🎵 播放歌曲数：0',
    '🎤 收听歌手数：0',
  ]);
});

test('formatReportText：标题为空的行剔除后 TOP 计数随之收缩；undefined 入参不炸', async () => {
  const { formatReportText } = await fresh();
  const t = formatReportText({
    totalPlayTimeText: '5分钟', totalSongs: 1, artistTotal: 1,
    mostPlayed: [{ title: '', artist: 'X', count: 9 }, { title: '唯四', artist: null, count: 4 }],
    topArtists: null,
    lastPlayed: null,
  });
  assert.match(t, /🏆 最爱歌曲 TOP 1/);
  assert.match(t, /1\. 唯四 \(4 次\)/);
  assert.ok(!t.includes('最爱歌手'));
  assert.ok(!t.includes('最后播放'));
  assert.equal(formatReportText(undefined).split('\n').length, 4);
});

test('接线钉：stats.js 聚合复用+复制入口+弹层📋钮，player.js 转出与窗桥，命令面板 pl-rcopy', async () => {
  assert.match(STATS_JS, /import \{ topArtistsFromPlayCount, formatReportText \} from '\.\.\/playReportText\.js';/);
  assert.match(STATS_JS, /import \{ copyText \} from '\.\.\/songShare\.js';/);
  assert.equal((STATS_JS.match(/topArtistsFromPlayCount\(stats\.playCount\)/g) || []).length, 2, '弹层与复制共用同一聚合');
  assert.match(STATS_JS, /export async function copyPlayReportText\(\) \{\n {2}const stats = getPlayStats\(\);/);
  assert.match(STATS_JS, /onclick="copyPlayReportText\(\)"[^>]*>📋</, '弹层头部复制钮');
  assert.match(PLAYER_JS, /window\.copyPlayReportText = copyPlayReportText;/);
  assert.match(PALETTE_JS, /\{ id: 'pl-rcopy',.*_call\('copyPlayReportText'\) \},/);
});
