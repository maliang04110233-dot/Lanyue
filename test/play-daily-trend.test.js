/**
 * 测试：每日听歌时长趋势
 * playDailyTrend 纯函数直调 + formatReportText 每日段 + stats.js 接线静态钉
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const STATS_JS = fs.readFileSync(path.join(__dirname, '../src/renderer/js/player/stats.js'), 'utf8');
const TREND_JS = fs.readFileSync(path.join(__dirname, '../src/renderer/js/playDailyTrend.js'), 'utf8');

async function fresh() {
  return import(`../src/renderer/js/playDailyTrend.js?v=${Math.random()}`);
}

function freshReport() {
  return import(`../src/renderer/js/playReportText.js?v=${Math.random()}`);
}

test('dayKey/addDailySeconds：本地日键、同日累加、纯函数、<=0 与脏输入守卫', async () => {
  const { dayKey, addDailySeconds } = await fresh();
  const morning = new Date(2026, 8, 19, 10, 0, 0).getTime();
  const evening = new Date(2026, 8, 19, 23, 59, 59).getTime();
  const nextDay = new Date(2026, 8, 20, 0, 0, 1).getTime();
  assert.equal(dayKey(morning), '2026-09-19');
  assert.equal(dayKey(nextDay), '2026-09-20');

  const base = { '2026-09-18': 100 };
  const r1 = addDailySeconds(base, morning, 60);
  const r2 = addDailySeconds(r1, evening, 1);
  assert.deepEqual(r2, { '2026-09-18': 100, '2026-09-19': 61 });
  assert.deepEqual(base, { '2026-09-18': 100 }, '入参不得被改动（纯）');
  // 非正数/非数字：只回浅拷贝
  assert.deepEqual(addDailySeconds(base, morning, 0), base);
  assert.deepEqual(addDailySeconds(base, morning, -30), base);
  assert.deepEqual(addDailySeconds(base, morning, 'x'), base);
  // 脏 daily 输入从空集起账
  assert.deepEqual(addDailySeconds(null, morning, 5), { '2026-09-19': 5 });
});

test('bucketDailySeconds：oldest→newest 对齐、跨月、窗口外/非正数不入账', async () => {
  const { bucketDailySeconds, PLAY_TREND_DAYS } = await fresh();
  const now = new Date(2026, 2, 2, 12, 0, 0).getTime(); // 2026-03-02（非闰年，2月28天）
  const daily = {
    '2026-02-28': 300,
    '2026-03-01': 60,
    '2026-03-02': 90,
    '2026-01-05': 999,   // 窗口外
    '2026-03-03': 999,   // 未来日
    '2026-02-27': 0,     // 非正数
  };
  const b3 = bucketDailySeconds(daily, now, 3);
  assert.deepEqual(b3.map(b => b.key), ['2026-02-28', '2026-03-01', '2026-03-02']);
  assert.deepEqual(b3.map(b => b.label), ['2/28', '3/1', '3/2']);
  assert.deepEqual(b3.map(b => b.secs), [300, 60, 90]);
  const full = bucketDailySeconds(daily, now);
  assert.equal(full.length, PLAY_TREND_DAYS);
  assert.equal(full[PLAY_TREND_DAYS - 1].key, '2026-03-02');
  assert.equal(full.reduce((a, b) => a + b.secs, 0), 450, '窗口外/未来/零值不入账');
});

test('formatReportText：每日段只列有账的天，全无则整段省略（110 旧形不回归）', async () => {
  const { formatReportText } = await freshReport();
  const daily = [
    { key: '2026-09-17', label: '9/17', secs: 0 },
    { key: '2026-09-18', label: '9/18', secs: 3600 },
    { key: '2026-09-19', label: '9/19', secs: 30 },
  ];
  const withDaily = formatReportText({ totalPlayTimeText: '1小时', daily });
  const lines = withDaily.split('\n');
  assert.ok(lines.includes('📅 每日听歌 · 近 3 天'));
  assert.ok(lines.includes('9/18：60分钟'));
  assert.ok(lines.includes('9/19：1分钟'), '不足 1 分钟也显 1，不显 0');
  assert.ok(!lines.some(l => l.startsWith('9/17')), '零天省略');
  // 全无账/缺键 → 与 110 的输出逐字一致
  assert.equal(formatReportText({ totalPlayTimeText: '1小时', daily: [] }),
    formatReportText({ totalPlayTimeText: '1小时' }));
  const zeroDaily = daily.map(b => ({ ...b, secs: 0 }));
  assert.ok(!formatReportText({ totalPlayTimeText: '1小时', daily: zeroDaily }).includes('每日听歌'), '有键全零也整段省略');
});

test('stats.js 接线：daily 初值/停表归集/载入守卫/重置清零/两条报告线共用桶', async () => {
  assert.ok(/import \{ addDailySeconds, bucketDailySeconds, weekSummary, monthSummary, PLAY_TREND_DAYS \} from '\.\.\/playDailyTrend\.js';/.test(STATS_JS));
  assert.ok(/import \{ barPct \} from '\.\.\/historyTrend\.js';/.test(STATS_JS), '柱高共用下载趋势 barPct');
  assert.ok(STATS_JS.includes('daily: {},'), '初值含 daily 桶');
  assert.ok(/_playStats\.totalPlayTime \+= elapsed;\n {4}_playStats\.daily = addDailySeconds\(_playStats\.daily, Date\.now\(\), elapsed\);/.test(STATS_JS), '停表即归集当日');
  assert.ok(STATS_JS.includes("typeof _playStats.daily !== 'object'"), '老数据载入守卫');
  assert.equal((STATS_JS.match(/_playStats\.daily = \{\};/g) || []).length, 2, '载入兜底 + 重置清零');
  assert.equal((STATS_JS.match(/bucketDailySeconds\(/g) || []).length, 2, '弹层与复制共用同一分桶');
  assert.ok(STATS_JS.includes('每日听歌 · 近'), '弹层段标题在位');
  assert.ok(STATS_JS.includes('dailyTotal > 0'), '零账省略段落');
  // 本模块必须零 DOM（stats.js 被 recent-played.test.js node 直 import）
  assert.ok(!/\bdocument\b/.test(TREND_JS) && !/\bwindow\b/.test(TREND_JS), 'playDailyTrend 顶层不得碰 DOM');
});
