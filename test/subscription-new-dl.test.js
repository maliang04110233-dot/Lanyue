/**
 * 增量104：订阅新歌行「⬇ 逐首下载 + ✔ 状态徽标」—— subNewDl.js 纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUB_JS = readFileSync(path.join(ROOT, 'src/renderer/js/views/subscriptions.js'), 'utf8');
const CSS = readFileSync(path.join(ROOT, 'src/renderer/styles/content.css'), 'utf8');
const PALETTE_JS = readFileSync(path.join(ROOT, 'src/renderer/js/commandPalette.js'), 'utf8');

function fresh() {
  return import('../src/renderer/js/subNewDl.js?tc=' + Math.random());
}

const qualityOf = (src) => src === 'netease' ? 'lossless' : 'exhigh';

test('subDlPayload/subDlPayloadList：原字段透传 + saveDir/quality 注入 + 脏项过滤', async () => {
  const { subDlPayload, subDlPayloadList } = await fresh();
  const song = { id: 1, source: 'netease', title: 'A', artist: 'B' };
  assert.deepEqual(subDlPayload(song, '/dl', qualityOf),
    { id: 1, source: 'netease', title: 'A', artist: 'B', saveDir: '/dl', quality: 'lossless' });
  assert.equal(subDlPayload(song, '/dl', qualityOf).title, 'A', '不改动原字段');
  const list = [song, { id: 2, source: 'qq' }, null, undefined];
  const out = subDlPayloadList(list, '/dl', qualityOf);
  assert.equal(out.length, 2);
  assert.equal(out[1].quality, 'exhigh');
  assert.equal(out[1].saveDir, '/dl');
  assert.deepEqual(subDlPayloadList(undefined, '/dl', qualityOf), []);
});

test('subNewSongById：id 字符串化匹配、失配/空列表返回 null', async () => {
  const { subNewSongById } = await fresh();
  const songs = [{ id: 7, title: 'X' }, { id: '8', title: 'Y' }];
  assert.equal(subNewSongById(songs, '7').title, 'X', '字符串点击中数字 id');
  assert.equal(subNewSongById(songs, 8).title, 'Y', '数字点击中字符串 id');
  assert.equal(subNewSongById(songs, 99), null);
  assert.equal(subNewSongById(null, 1), null);
  assert.equal(subNewSongById([null, { id: 1 }], 1).id, 1, '脏项不炸');
});

test('subActiveQueueDup：同 id+source 且未完成才算重复；done 行放行重下', async () => {
  const { subActiveQueueDup } = await fresh();
  const song = { id: 1, source: 'netease' };
  assert.equal(subActiveQueueDup([{ id: 1, source: 'netease', status: 'pending' }], song).status, 'pending');
  assert.equal(subActiveQueueDup([{ id: 1, source: 'netease', status: 'downloading' }], song).status, 'downloading');
  assert.equal(subActiveQueueDup([{ id: 1, source: 'netease', status: 'done' }], song), null, '已完成不算占位');
  assert.equal(subActiveQueueDup([{ id: 1, source: 'qq', status: 'pending' }], song), null, '异源不同曲');
  assert.equal(subActiveQueueDup([], song), null);
  assert.equal(subActiveQueueDup(undefined, song), null);
  assert.equal(subActiveQueueDup([{ id: 1 }], undefined), null);
});

test('接线钉：徽标渲染/逐首入队/防抖重渲染/palette/CSS 全部就位', async () => {
  assert.match(SUB_JS, /import \{ dlBadgeHtml, dlEnsureHistoryLoaded, addDlChangeListener \} from '\.\.\/dlStatus\.js';/);
  assert.match(SUB_JS, /import \{ subDlPayload, subDlPayloadList, subNewSongById, subActiveQueueDup \} from '\.\.\/subNewDl\.js';/);
  assert.match(SUB_JS, /const queue = getState\('queueSnapshot'\) \|\| \[\];/, '渲染期取队列快照');
  assert.match(SUB_JS, /\$\{dlBadgeHtml\(s, queue\)\}<button class="btn-sm sub-new-dl"/, '行内徽标+下载按钮');
  // ⚠️ 2026-09-28 修正：这里原先把 escAttr 当作「onclick 键控传参」的正确写法钉住，
  // 但那一版写法本身是**可注入的**（escAttr 把 ' 转成 &#39;，浏览器取出内联事件
  // 属性时会先把实体解码再当 JS 执行，' 于是又变回裸单引号、逃出字符串字面量）。
  // e.key 含平台返回的 targetId、s.id 来自平台数据，均为外部不可信输入。
  // 必须用 escQ（先转义反斜杠、再把 ' 转义成 \'）。详见 renderer-audit 的对照用例。
  assert.match(SUB_JS, /onclick="subscriptionDownloadNew\('\$\{escQ\(e\.key\)\}', '\$\{escQ\(String\(s\.id\)\)\}'\)"/, 'onclick 键控传参必须走 escQ');
  assert.match(SUB_JS, /subDlPayloadList\(songs, getState\('saveDir'\), resolveQuality\)/, '全部入队复用纯函数');
  assert.doesNotMatch(SUB_JS, /songs\.map\(s => \(\{ \.\.\.s, saveDir/, '旧内联 payload 已移除');
  assert.match(SUB_JS, /async function subscriptionDownloadNew\(key, songId\) \{/);
  assert.match(SUB_JS, /subNewSongById\(entry && entry\.newSongs, songId\)/, '按 id 防竞态定位');
  assert.match(SUB_JS, /subActiveQueueDup\(getState\('queueSnapshot'\), song\)/);
  assert.match(SUB_JS, /api\.addToQueue\(\{ \.\.\.payload, forceRedownload: true \}\)/, '已下载走重下确认');
  assert.match(SUB_JS, /window\.subscriptionDownloadNew = subscriptionDownloadNew;/);
  assert.match(SUB_JS, /dlEnsureHistoryLoaded\(\); \/\/ 徽标的「已下载」来自跨会话历史/, '加载时懒拉历史');
  assert.match(SUB_JS, /addDlChangeListener\(\(\) => \{\n {2}if \(!_subsLoaded\) return;\n {2}clearTimeout\(_subRenderTimer\);\n {2}_subRenderTimer = setTimeout\(\(\) => renderSubscriptionPage\(_subList\), 300\);/, '防抖重渲染订阅徽标');
  assert.match(PALETTE_JS, /\{ id: 'sub-check'/);
  assert.match(PALETTE_JS, /_call\('subscriptionCheckNow'\)/);
  assert.match(CSS, /\.sub-new-title \{ white-space: nowrap;/);
  assert.match(CSS, /\.sub-new-dl \{ flex-shrink: 0;/);
});
