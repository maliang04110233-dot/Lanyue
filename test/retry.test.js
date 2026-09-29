/**
 * withRetry 单元测试 + 自动更新 feed 契约守卫
 *
 * 背景：用户报「更新失败 net::ERR_TIMED_OUT，不能从 GitHub 更新」。
 * 两个根因，都在这里防回归：
 *
 *   A. electron-updater 的 HttpExecutor 只在 5xx / EPIPE 上重试，
 *      网络超时不在其列——一次失败就抛给 UI。GitHub 控制面在部分网络下
 *      会间歇性丢 TCP（实测同一时刻约 80% 连接超时），必须自己包重试。
 *   B. src/main/updater.js 曾硬编码 setFeedURL({ repo: 'MusicDL' })，
 *      而仓库 2026-09-10 已改名为 MM-Music-Destop。setFeedURL 会覆盖掉
 *      electron-builder 写入 app-update.yml 的正确配置，让每次检查都先在
 *      github.com 上多吃一个改名重定向。单一真源必须是 build/config.cjs
 *      的 publish 段。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { withRetry } = require(path.join(ROOT, 'src', 'utils', 'retry'));

// ── withRetry 行为 ────────────────────────────────────────

test('withRetry: 首次成功即返回，不重试', async () => {
  let calls = 0;
  const out = await withRetry(async () => { calls++; return 'ok'; });
  assert.strictEqual(out, 'ok');
  assert.strictEqual(calls, 1);
});

test('withRetry: 空 delays = 只执行一次', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new Error('boom'); }, { delays: [] }),
    /boom/,
  );
  assert.strictEqual(calls, 1, 'delays 为空时不该重试');
});

test('withRetry: 中间成功则返回该次结果', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('fail ' + calls);
    return 'finally';
  }, { delays: [1, 1] });
  assert.strictEqual(out, 'finally');
  assert.strictEqual(calls, 3);
});

test('withRetry: 全部失败抛最后一次错误', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry(async () => { calls++; throw new Error('err' + calls); }, { delays: [1, 1] }),
    (e) => e.message === 'err3',
    '应该抛最后一次错误，而不是第一次',
  );
  assert.strictEqual(calls, 3);
});

test('withRetry: 每次尝试都重新调用 fn（不是复用同一个 promise）', async () => {
  const promises = [];
  let calls = 0;
  await assert.rejects(
    () => withRetry(() => {
      calls++;
      const p = Promise.reject(new Error('x' + calls));
      promises.push(p);
      return p;
    }, { delays: [1] }),
    /x2/,
  );
  assert.strictEqual(calls, 2);
  assert.strictEqual(promises.length, 2);
  assert.notStrictEqual(promises[0], promises[1], '必须是两次独立调用');
});

test('withRetry: onAttempt 收到 (err, attempt, total)，含最后一次', async () => {
  const seen = [];
  await assert.rejects(
    () => withRetry(async () => { throw new Error('nope'); }, {
      delays: [1, 1],
      onAttempt: (err, attempt, total) => seen.push([err.message, attempt, total]),
    }),
  );
  assert.deepStrictEqual(seen, [['nope', 1, 3], ['nope', 2, 3], ['nope', 3, 3]]);
});

test('withRetry: onAttempt 不抛错（回调异常不能吞掉重试结果）', async () => {
  let calls = 0;
  const out = await withRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('first');
    return 'recovered';
  }, {
    delays: [1],
    onAttempt: () => { throw new Error('callback boom'); },
  }).catch((e) => 'caught:' + e.message);
  // 回调抛错会打断流程，这是已知取舍：调用方必须给无副作用的回调
  assert.strictEqual(out, 'caught:callback boom');
});

test('withRetry: 按 delays 顺序退避（间隔可观测）', async () => {
  // 用 onAttempt 的时间戳差反推实际等待时长
  const stamps = [];
  let prev = null;
  const waits = [];
  await assert.rejects(
    () => withRetry(async () => { throw new Error('x'); }, {
      delays: [30, 60],
      onAttempt: () => {
        const now = Date.now();
        stamps.push(now);
        if (prev !== null) waits.push(now - prev);
        prev = now;
      },
    }),
  );
  assert.strictEqual(stamps.length, 3, '应有 3 次尝试');
  assert.strictEqual(waits.length, 2);
  assert.ok(waits[0] >= 25, '第一个间隔应约等于 delays[0]，实测 ' + waits[0]);
  assert.ok(waits[1] >= 50, '第二个间隔应约等于 delays[1]，实测 ' + waits[1]);
  assert.ok(waits[1] >= waits[0], '退避间隔应递增');
});

test('withRetry: options 缺省时当作空对象', async () => {
  const out = await withRetry(async () => 'no-options');
  assert.strictEqual(out, 'no-options');
});

// ── 契约守卫：不许再出现第二份 feed 配置 ───────────────────

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, out);
    } else if (/\.(js|cjs|json)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

// 仓库改过两次名：MusicDL → MM-Music-Destop（2026-09-10）→ Lanyue（2026-09-29）。
// 两个旧名一律算 stale —— 只该出现在历史说明里，不该出现在代码里。
const STALE_REPOS = ['MusicDL', 'MM-Music-Destop'];

/**
 * 守卫只查代码，不查散文。
 * updater.js 里保留了一段历史说明，引用了被删掉的那句 setFeedURL 来解释为什么删——
 * 不去注释的话守卫会自我误报，然后下次没人敢再写这类说明了，反而丢掉上下文。
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('守卫：updater.js 不再 setFeedURL 覆盖 app-update.yml', () => {
  const src = stripComments(read('src/main/updater.js'));
  assert.doesNotMatch(
    src,
    /setFeedURL\s*\(/,
    'setFeedURL 会覆盖 electron-builder 写入 app-update.yml 的正确配置，' +
      '单一真源必须是 build/config.cjs 的 publish 段',
  );
});

test('守卫：src/ 与 build/ 里不再有旧仓库名字面量', () => {
  const files = walk(path.join(ROOT, 'src'), []).concat(walk(path.join(ROOT, 'build'), []));
  const hits = [];
  for (const f of files) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    // repo: 'MusicDL' 是仓库改名前的值，只该出现在历史说明里，不该出现在代码里
    if (staleRepoPattern.test(s)) hits.push(path.relative(ROOT, f));
  }
  assert.deepStrictEqual(hits, [], '发现硬编码旧仓库名: ' + hits.join(', '));
});

/**
 * 拼正则只能用 new RegExp。写成 /...['"]' + VAR + "['"]/ 会被解析成**一个**
 * 正则字面量（首个 ['"] 字符类提前闭合，VAR 被吞进 pattern），守卫静默失效。
 */
const staleRepoPattern = new RegExp("repo\\s*:\\s*['\"](?:" + STALE_REPOS.join('|') + ")['\"]");

// 防止上面的正则自己失效（正则写坏了会静默变成永不匹配，守卫形同虚设）
test('守卫自检：staleRepoPattern 真的能匹配', () => {
  assert.ok(staleRepoPattern.test("repo: 'MusicDL'"), '单引号');
  assert.ok(staleRepoPattern.test('repo: "MusicDL"'), '双引号');
  assert.ok(staleRepoPattern.test('repo:\t"MusicDL"'), '带空白');
  assert.ok(staleRepoPattern.test("repo: 'MM-Music-Destop'"), '上一个名字同样算 stale');
  assert.ok(!staleRepoPattern.test("repo: 'Lanyue'"), '现用仓库名不应命中');
});

test('守卫：build/config.cjs 的 publish 指向真实仓库', () => {
  const cfg = read('build/config.cjs');
  assert.match(cfg, /repo:\s*['"]Lanyue['"]/, 'publish.repo 应为 Lanyue');
  assert.match(cfg, /owner:\s*['"]maliang04110233-dot['"]/, 'publish.owner 缺失');
  assert.ok(
    !staleRepoPattern.test(stripComments(cfg)),
    'publish.repo 仍是旧仓库名 ' + STALE_REPOS.join(' / '),
  );
});

test('守卫：检查与下载都走了 withRetry（超时不能一次失败就放弃）', () => {
  const src = stripComments(read('src/main/updater.js'));
  assert.match(src, /require\(['"]\.\.\/utils\/retry['"]\)/, '必须引入 withRetry');
  assert.match(
    src,
    /withRetry\(\s*\(\s*\)\s*=>\s*autoUpdater\.checkForUpdates\(\)/,
    'check-for-update 必须在 withRetry 里，否则网络超时会一次失败就抛给 UI',
  );
  assert.match(
    src,
    /withRetry\(\s*\(\s*\)\s*=>\s*autoUpdater\.downloadUpdate\(\)/,
    'download-update 也必须有重试（下载首跳同样要过 github.com）',
  );
  // 重试次数不该是 0
  assert.match(src, /CHECK_DELAYS\s*=\s*\[\s*\d+/, '应有非空退避序列');
});

test('守卫：初始静默自检也走重试', () => {
  const src = stripComments(read('src/main/updater.js'));
  const fn = src.slice(src.indexOf('function initUpdater'));
  assert.match(fn, /checkForUpdatesWithRetry\(\)/, 'initUpdater 应走带重试的入口');
  assert.doesNotMatch(fn, /autoUpdater\.checkForUpdates\(\)/, 'initUpdater 不应直接调用原始 checkForUpdates');
});
