/**
 * 守卫：单源失败隔离必须真的成立（3-B E2E 走查 D 组）
 *
 * 问题
 * ----
 * 聚合 handler 逐源 try/catch，单源失败降级为空并记入 `failed`。
 * 这一层没问题（wiring 测试已钉）。但**平台插件那一层**可能把失败吞掉：
 * qqGetPlaylistSongs 整体包在 try 里，catch 后 `return []`。
 * 于是"QQ 接口挂了"与"QQ 这个歌单真的是空的"在 handler 看来完全一样，
 * failed 永远收不到 qq，用户看到的是"聚合成功，就是没歌"——
 * 失败被伪装成了空数据，正是更新信任链那条死代理掩盖网络问题的同一个坑。
 *
 * 本文件钉两件事：
 *   1. 有 try/catch 的平台插件必须把失败**向上抛**（否则 failed 形同虚设）；
 *   2. netease 作为对照，没有 try/catch，失败天然冒泡。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** 取出某个具名 async 函数的函数体（花括号配对，注释已剥） */
function fnBody(src, name) {
  const i = src.indexOf(`function ${name}`);
  assert.ok(i > -1, `找不到 ${name}`);
  let depth = 0;
  let started = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') { depth++; started = true; }
    else if (src[k] === '}') {
      depth--;
      if (started && depth === 0) {
        return src.slice(i, k + 1)
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
      }
    }
  }
  throw new Error(`${name} 花括号不配对`);
}

const QQ = read('src/api/platforms/qq.js');
const NETEASE = read('src/api/platforms/netease.js');

// ── 1. 平台插件不得把失败吞成空数组 ────────────────────

test('D 组：QQ 歌单拉取失败必须向上抛，不能 return [] 伪装成空歌单', () => {
  const body = fnBody(QQ, 'qqGetPlaylistSongs');
  assert.match(body, /catch\s*\(/, 'qqGetPlaylistSongs 应该有 catch（否则网络异常会炸穿 handler 之外的线程）');

  const catchIdx = body.indexOf('catch');
  const catchTail = body.slice(catchIdx);
  assert.ok(!/catch[\s\S]*?\breturn\s+\[\]\s*;/.test(catchTail),
    'catch 里 return [] 会把"接口失败"变成"该歌单为空"，'
    + 'failed 永远收不到 qq，用户看到的是聚合成功但没歌 —— 失败被伪装成了空数据');
});

test('D 组：抛出的错误要带上平台与歌单标识，否则 failed 无从定位', () => {
  const body = fnBody(QQ, 'qqGetPlaylistSongs');
  const catchIdx = body.indexOf('catch');
  const catchTail = body.slice(catchIdx);
  assert.match(catchTail, /throw\s+/, 'catch 后应重新抛出');
  assert.match(catchTail, /songlist|歌单|playlist/i,
    '错误信息要指出是哪个歌单，否则 failed 只剩一个平台名，定位不到具体歌单');
});

test('D 组：网易云作为对照，失败天然冒泡（无吞异常的 catch）', () => {
  const body = fnBody(NETEASE, 'neteaseGetPlaylistDetail');
  assert.ok(!/catch[\s\S]*?\breturn\s+\[\]\s*;/.test(body),
    'neteaseGetPlaylistDetail 若也吞异常，同 QQ 的问题');
  assert.ok(!/catch/.test(body),
    '该函数当前无 try/catch，失败直接冒泡到 handler —— 这是期望形态，改动需重新评估');
});

test('D 组：handler 侧对抛出的失败仍是降级而非整体失败', () => {
  const IPC = read('src/main/ipc/playlist.js');
  const i = IPC.indexOf("handle('aggregate-cross-source'");
  assert.ok(i > -1, '未注册 aggregate-cross-source');
  const body = IPC.slice(i, i + 3000);
  assert.match(body, /catch\s*\(/, 'handler 必须 catch 单源失败');
  assert.match(body, /failed\.push\(/, '必须把失败源记入 failed');
});

// ── 2. 改成抛错之后，另外两个调用方仍要活 ──────────────
//
// qqGetPlaylistSongs 从「吞异常返回空数组」改成「向上抛」，
// 调用方不止聚合一处。逐个确认它们本来就有处理抛错的能力，
// 否则这一改会把失败从"看起来正常"变成"崩在别处"。

test('D 组：订阅同步侧本来就把抛错当瞬时故障处理', () => {
  const SUBS = read('src/main/subscriptions.js');
  const i = SUBS.indexOf('await _fetchSongs(entry)');
  assert.ok(i > -1, '未找到 _fetchSongs 调用点');
  // 注释也剥掉：判别"空 vs 抛错"两态的说明写在 catch 前的注释里，
  // 不剥会把注释里的字当成代码匹配。
  const raw = SUBS.slice(Math.max(0, i - 700), i + 1200);
  const ctx = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

  assert.match(ctx, /catch\s*\(/, '订阅检查必须捕获单次拉取失败');
  assert.match(ctx, /lastCheckError/, '失败应记入 lastCheckError 供界面展示');
  // 抛错与"空清单"要分开处理：空是稳定状态，抛错是可重试的瞬时故障
  assert.match(ctx, /lastCheckedAt/, '抛错时不得推进 lastCheckedAt，否则瞬时故障会被当成已检查过');
  // 该语义写在 catch 前的注释里，剥注释后就查不到了 ——
  // 所以这里直接核 raw（未剥离），确保"空 vs 抛错"的区分说明还在。
  assert.match(raw, /空清单/, '应有"空清单 vs 抛错"两态的区分说明（当前写在注释里）');
});

test('D 组：渲染层歌单视图捕获拉取失败并给可读提示', () => {
  const APP = read('src/renderer/js/app.js');
  const i = APP.indexOf('await api.getPlaylistSongs(platform, id, 200)');
  assert.ok(i > -1, '未找到歌单视图的拉取调用');
  const ctx = APP.slice(i, i + 1200);
  assert.match(ctx, /catch\s*\(/, '歌单视图必须 catch 拉取失败');
});

test('D 组：失败降级路径不把异常文案当成曲目数据渲染', () => {
  const IPC = read('src/main/ipc/playlist.js');
  const i = IPC.indexOf("handle('aggregate-cross-source'");
  const body = IPC.slice(i, i + 3000);
  // 失败源记进 failed 后按空列表计入，不得把 catch 到的 error 对象塞进 songs
  assert.match(body, /groups\.push\(\{\s*source:\s*src,\s*songs:\s*\[\]\s*\}\)/,
    '失败源应按空列表计入');
  assert.ok(!/songs:\s*e\b/.test(body), '不得把 catch 到的异常对象当作曲目塞进结果');
});
