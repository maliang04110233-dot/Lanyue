/**
 * 听歌报告「🗓 本周/本月听歌汇总」
 *
 * 113 的每日图只看近 14 天，daily 桶本身只攒不清 —— 周/月聚合把
 * 长窗口的账折成两行摘要（周一起始，含上周期对比基数）。纯函数进
 * playDailyTrend.js（零 DOM），复制文本段落进 playReportText.js，
 * 弹层与复制共用同一对函数，零新 IPC。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TREND_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/playDailyTrend.js'), 'utf8'
);
const STATS_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/player/stats.js'), 'utf8'
);
const PRT_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/playReportText.js'), 'utf8'
);

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function fresh() {
  return import('../src/renderer/js/playDailyTrend.js?tc=' + Math.random());
}
async function freshText() {
  return import('../src/renderer/js/playReportText.js?tc=' + Math.random());
}

const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime();

test('sumDailyBetween：闭区间字典序求和，脏值/负数/非对象不进账', async () => {
  const { sumDailyBetween } = await fresh();
  const daily = {
    '2026-09-01': 10, '2026-09-30': 20, '2026-08-31': 99, '2026-10-01': 99,
    '2026-09-15': -5, '2026-09-16': 'x',
  };
  assert.strictEqual(sumDailyBetween(daily, '2026-09-01', '2026-09-30'), 30);
  assert.strictEqual(sumDailyBetween(null, '2026-09-01', '2026-09-30'), 0);
  assert.strictEqual(sumDailyBetween(daily, '2026-08-31', '2026-08-31'), 99, '端点含入');
});

test('weekSummary：周一起始含首尾日，上周只作基数，label 为 M/D-M/D', async () => {
  const { weekSummary } = await fresh();
  // 2026-09-19 是周六 → 本周一 9/14、本周日 9/20；上周 9/7–9/13
  const daily = {
    '2026-09-14': 60, '2026-09-19': 30, '2026-09-20': 7,
    '2026-09-13': 99, '2026-09-07': 1, '2026-09-06': 50,
  };
  const w = weekSummary(daily, at(2026, 9, 19));
  assert.strictEqual(w.secs, 97, '周一到周日含端点');
  assert.strictEqual(w.prevSecs, 100, '上周 9/7–9/13');
  assert.strictEqual(w.label, '9/14-9/20');
  // 周一当天与周日当天都折进同一周
  assert.strictEqual(weekSummary({ '2026-09-14': 5 }, at(2026, 9, 14)).secs, 5);
  assert.strictEqual(weekSummary({ '2026-09-20': 5 }, at(2026, 9, 20)).secs, 5);
});

test('monthSummary：整月含首末日，上月界跨年进位，label 带年月', async () => {
  const { monthSummary } = await fresh();
  const daily = {
    '2026-09-01': 5, '2026-09-30': 10, '2026-08-31': 7, '2026-10-01': 100,
  };
  const m = monthSummary(daily, at(2026, 9, 19));
  assert.strictEqual(m.secs, 15);
  assert.strictEqual(m.prevSecs, 7);
  assert.strictEqual(m.label, '2026年9月');
  const jan = monthSummary({ '2025-12-31': 3 }, at(2026, 1, 15));
  assert.strictEqual(jan.secs, 0);
  assert.strictEqual(jan.prevSecs, 3, '上月界跨年');
  assert.strictEqual(jan.label, '2026年1月');
});

test('formatReportText 周期段：账到才出段，零账周/月整行省略，上周期基数按需', async () => {
  const { formatReportText } = await freshText();
  const wk = { label: '9/14-9/20', secs: 3600, prevSecs: 1800 };
  const mo = { label: '2026年9月', secs: 7200, prevSecs: 0 };
  const t = formatReportText({ totalPlayTimeText: '3小时', week: wk, month: mo });
  assert.match(t, /🗓 周期听歌/);
  assert.match(t, /本周（9\/14-9\/20）：60分钟 · 上周 30分钟/);
  assert.match(t, /本月（2026年9月）：120分钟$/m, 'prevSecs=0 不带「· 上月」');
  const noWk = formatReportText({ week: { secs: 0, prevSecs: 99, label: '' }, month: mo });
  assert.ok(!noWk.includes('本周'), '零账周省略且上周基数不造假');
  assert.ok(noWk.includes('🗓 周期听歌'), 'month 有账则段落仍在');
  const none = formatReportText({ week: { secs: 0 }, month: null });
  assert.ok(!none.includes('🗓'), '全无账整段省略');
});

test('接线钉桩：弹层与复制共用周/月函数，🗓 段落在位，playDailyTrend 保持零 DOM', () => {
  assert.ok(/export function weekSummary\(daily, now = Date\.now\(\)\) \{/.test(TREND_JS));
  assert.ok(/export function monthSummary\(daily, now = Date\.now\(\)\) \{/.test(TREND_JS));
  assert.ok(!/document\.|window\./.test(TREND_JS), '纯函数模块零 DOM');
  assert.ok(/import \{ addDailySeconds, bucketDailySeconds, weekSummary, monthSummary, PLAY_TREND_DAYS \} from '\.\.\/playDailyTrend\.js';/.test(STATS_JS));
  assert.equal((STATS_JS.match(/weekSummary\(stats\.daily\)/g) || []).length, 2, '弹层与复制同源');
  assert.equal((STATS_JS.match(/monthSummary\(stats\.daily\)/g) || []).length, 2);
  assert.ok(STATS_JS.includes('🗓 周期听歌 · 本周/本月'), '弹层段标题');
  assert.ok(STATS_JS.includes('(wk.secs > 0 || mo.secs > 0)'), '零账省略门槛');
  assert.ok(PRT_JS.includes("'🗓 周期听歌'"), '复制文本段落标题');
});
