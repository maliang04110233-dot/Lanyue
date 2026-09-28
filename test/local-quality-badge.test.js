/**
 * 本地曲库行「音质徽标」—— qualityBadge 纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const LOCAL_JS = read('src/renderer/js/views/local.js');
const BADGE_JS = read('src/renderer/js/localQualityBadge.js');

function fresh() {
  return import('../src/renderer/js/localQualityBadge.js?QB=' + Math.random());
}

const song = (p) => ({ filePath: p, title: 'x' });
const FLAC = song('/m/a.flac');
const MP3 = song('/m/b.mp3');
const NOEXT = song('/m/c');

test('只认扩展名时：常见容器给显示名，未知扩展名大写，无扩展名不出徽标', async () => {
  const { qualityBadge } = await fresh();
  assert.deepEqual(
    { t: qualityBadge(FLAC, null).text, c: qualityBadge(FLAC, null).color },
    { t: 'FLAC', c: 'var(--text-muted)' },
  );
  assert.equal(qualityBadge(MP3, null).text, 'MP3');
  assert.equal(qualityBadge(song('/m/d.tta'), null).text, 'TTA', '表外扩展名直接大写');
  assert.equal(qualityBadge(NOEXT, null), null, '既无扩展名又无实测 ⇒ 不硬凑徽标');
  assert.equal(qualityBadge(null, null), null);
});

test('实测优先于标称：真无损给绿勾，标题同时留标称与实测两栏', async () => {
  const { qualityBadge } = await fresh();
  const q = qualityBadge(FLAC, { ok: true, codec: 'pcm', bitrateKbps: 1411, sampleRate: 44100, verdict: 'lossless' });
  assert.equal(q.text, 'PCM · 1411k ✓');
  assert.equal(q.color, 'var(--neon-green)');
  assert.equal(q.title, '标称：FLAC · 实测：PCM · 码率 1411k · 44kHz · 真无损');
});

test('伪无损 / 存疑 各有独立角标与配色，改扩挂名的 MP3 一眼可辨', async () => {
  const { qualityBadge } = await fresh();
  const fake = qualityBadge(FLAC, { ok: true, codec: 'mp3', bitrateKbps: 320, verdict: 'lossy' });
  assert.equal(fake.text, 'MP3 · 320k ✕');
  assert.equal(fake.color, 'var(--neon-orange)');
  assert.match(fake.title, /标称：FLAC.*伪无损/s);
  const susp = qualityBadge(FLAC, { ok: true, codec: 'flac', bitrateKbps: 180, verdict: 'suspicious' });
  assert.equal(susp.text, 'FLAC · 180k ?');
  assert.equal(susp.color, 'var(--neon-yellow)');
  assert.match(susp.title, /码率 180k/);
  assert.match(susp.title, /存疑/);
});

test('无损扩展名未实测时提示「去验」，有损扩展名不提示（验了也没意义）', async () => {
  const { qualityBadge } = await fresh();
  assert.match(qualityBadge(FLAC, null).title, /未实测/);
  assert.match(qualityBadge(song('/m/e.wav'), null).title, /未实测/);
  assert.ok(!qualityBadge(MP3, null).title.includes('未实测'));
  assert.match(qualityBadge(NOEXT, { ok: true, codec: 'aac', bitrateKbps: 256, verdict: 'lossy' }).title, /标称：无扩展名/);
});

test('脏输入不炸：失败探测对象回落到扩展名，缺字段只少那一段', async () => {
  const { qualityBadge } = await fresh();
  assert.equal(qualityBadge(FLAC, { ok: false, error: 'ffprobe 缺失' }).text, 'FLAC');
  const odd = qualityBadge(FLAC, { ok: true, verdict: 'weird' });
  assert.equal(odd.text, 'FLAC', '无编码信息时不硬凑实测串，未知判定不贴角标');
  assert.match(odd.title, /判定未知/);
  assert.equal(qualityBadge({}, { ok: true, bitrateKbps: -3 }), null, '无扩展名 + 无编码信息 ⇒ 不出徽标');
  assert.equal(qualityBadge(MP3, { ok: true, codec: 'mp3' }).text, 'MP3', '码率缺失只出编码');
});

test('接线钉：local.js 单行插入徽标且实测结果按 filePath 取，徽标模块零 DOM', () => {
  assert.match(LOCAL_JS, /import \{ qualityBadge \} from '\.\.\/localQualityBadge\.js';/);
  assert.ok(LOCAL_JS.includes(
    '    ${(() => { const q = qualityBadge(s, _probeCache.get(s.filePath));'
    + ' return q ? `<span class="local-row-quality"'
    + ' title="${escAttr(q.title)}" style="font-size:11px;color:${q.color};white-space:nowrap;">${esc(q.text)}</span>`'
    + " : ''; })()}",
  ), '行内徽标只此一处，取值走 _probeCache（同一缓存不会多起进程）');
  assert.ok(LOCAL_JS.includes('if (r && r.ok) { _probeCache.set(s.filePath, r); renderLocalSongs(); }'), '实测成功要让徽标立刻出现（含缓存写入）');
  assert.equal((LOCAL_JS.match(/local-row-quality/g) || []).length, 1);
  assert.ok(!BADGE_JS.includes('document') && !BADGE_JS.includes('innerHTML'), '纯函数模块不碰 DOM');
  assert.match(BADGE_JS, /import \{ extOf \} from '\.\/localFormatFilter\.js';/, '扩展名口径与 107 格式过滤同源');
});
