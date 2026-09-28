/**
 * 歌词滚动跟随暂停
 *
 * 自动居中跟随在用户上翻看前文时强行拽回，是本作歌词面板的最后一个
 * 明显毛刺。本增量补「悬停即停 / 滚轮宽限期 / 跳播即恢复」三规则，
 * 判定逻辑抽 lyricFollow.js 纯函数（不可变小对象 + 注入 now），
 * lyrics.js 只做事件接线与滚动门控，零新 IPC 通道。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LYRICS_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/player/lyrics.js'), 'utf8'
);

async function fresh() {
  return import('../src/renderer/js/lyricFollow.js?tc=' + Math.random());
}

test('shouldAutoFollow：默认跟随，悬停一票否决，滚轮窗口到期自动恢复', async () => {
  const { createFollowState, shouldAutoFollow } = await fresh();
  const st = createFollowState();
  assert.ok(shouldAutoFollow(st, 1000));
  assert.ok(!shouldAutoFollow({ ...st, hover: true }, 1000), '悬停中不抢滚动');
  assert.ok(!shouldAutoFollow({ ...st, until: 5000 }, 4999), '宽限期内不抢');
  assert.ok(shouldAutoFollow({ ...st, until: 5000 }, 5000), '到点即恢复');
  assert.ok(!shouldAutoFollow(null, 0));
});

test('scrollPause：延长到 now+ms 且不缩短已有更长暂停，hover 态原样保留', async () => {
  const { scrollPause, FOLLOW_SCROLL_RESUME_MS } = await fresh();
  const a = scrollPause({ hover: false, until: 0 }, 1000, 5000);
  assert.deepStrictEqual(a, { hover: false, until: 6000 });
  const b = scrollPause(a, 2000, 1000);
  assert.strictEqual(b.until, 6000, '2000+1000 < 6000，不缩短');
  assert.strictEqual(scrollPause({ hover: true, until: 0 }, 0).until, FOLLOW_SCROLL_RESUME_MS,
    '缺省 ms 走常量');
  assert.strictEqual(scrollPause({ hover: true, until: 0 }, 0).hover, true, '滚出区外悬停态不丢');
});

test('hoverSet / followReset：进出歌词区与「跳播即回到当前」', async () => {
  const { hoverSet, followReset, shouldAutoFollow } = await fresh();
  const on = hoverSet({ hover: false, until: 9000 }, true);
  assert.deepStrictEqual(on, { hover: true, until: 9000 }, '悬停不清宽限期，离开后仍要到点');
  assert.deepStrictEqual(hoverSet(on, false), { hover: false, until: 9000 });
  const r = followReset();
  assert.deepStrictEqual(r, { hover: false, until: 0 });
  assert.ok(shouldAutoFollow(r, 0));
  assert.notStrictEqual(r, followReset(), '每次给新对象，不共享可变态');
});

test('接线钉：lyrics.js 门控滚动、三事件监听、跳播复位；纯模块不碰宿主', () => {
  assert.ok(LYRICS_JS.includes("from '../lyricFollow.js'"));
  assert.ok(LYRICS_JS.includes('if (la && shouldAutoFollow(_follow, Date.now()))'),
    '只门控滚动，active/逐字高亮照常');
  assert.ok(LYRICS_JS.includes("document.addEventListener('wheel'") &&
    LYRICS_JS.includes('scrollPause(_follow, Date.now(), FOLLOW_SCROLL_RESUME_MS)') &&
    LYRICS_JS.includes('{ passive: true }'), '滚轮暂停且不拦截原生滚动');
  assert.ok(LYRICS_JS.includes("document.addEventListener('mouseover'") &&
    LYRICS_JS.includes('hoverSet(_follow, true)') &&
    LYRICS_JS.includes("document.addEventListener('mouseout'") &&
    LYRICS_JS.includes('hoverSet(_follow, false)'), '悬停进/出（mouseover/out 冒泡捕获跨子元素）');
  assert.ok(/audio\.currentTime[\s\S]{0,120}_follow = followReset\(\);[\s\S]{0,40}_prevLyricIdx = -1;/.test(LYRICS_JS),
    '点行跳播立即恢复并强制重居中');
  const PURE = fs.readFileSync(path.join(__dirname, '../src/renderer/js/lyricFollow.js'), 'utf8')
    .replace(/^\/\*\*[\s\S]*?\*\//, '');
  assert.ok(!/api\.|window\.|document\./.test(PURE));
});
