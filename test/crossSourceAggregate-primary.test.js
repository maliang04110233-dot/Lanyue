/**
 * 守卫：跨源簇的「代表条目」在主进程里真的被算出来
 *
 * 背景（两个真实缺陷，都出在 aggregate-cross-source handler 的同一段里）
 * ------------------------------------------------------------------------
 * 1. pickRepresentative(members) 漏传第二参数
 *    登录态准则恒为空集 ⇒ 退化为「时长已知优先 + 原顺序」。
 *    后果不是取错条目，而是**已登录的源可能排在未登录的源之后**，
 *    用户点了下载才在取流阶段失败。
 *
 * 2. songKey 用了两套互不相等的键格式
 *    ipc/playlist.js 顶部局部 `songKey(s) = id + ':' + source`（歌单去重用），
 *    而 utils/crossSourceAggregate.js 导出的是 `source + '␟' + id`。
 *    两者**永不相等**，于是 s._primary 恒为 false，
 *    渲染层 `_primary === false` 的判断对**每一个**条目都成立，
 *    「换用另一条音源」的提示挂满了整屏，包括那条本该被推荐的。
 *
 * 本文件走**行为**路径（真调 handler），不靠 grep 源码：
 * 文本断言改个变量名就红、而代码其实是对的，这种守卫比没有更糟。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// ── Electron 打桩：让 ipc/playlist 能在纯 Node 下装载 ──
// safeStorage 必须可用：否则 secretStore 进入 insecure 态，cookieStore.set
// 拒绝写入（返回 false），测试会看到"没登录"而误判成接线缺陷。
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-aggp-'));
const handlers = new Map();
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: () => userDataDir },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(s, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
      shell: { trashItem: async () => {}, showItemInFolder() {} },
    };
  }
  return originalLoad(request, parent, isMain);
};

const prefs = require('../src/utils/prefs');
const cookieStore = require('../src/utils/cookieStore');
const ipcPlaylist = require('../src/main/ipc/playlist');
ipcPlaylist.register();

const { ENVELOPE_KEY } = require('../src/shared/ipcContract');
const invoke = (channel) => {
  const fn = handlers.get(channel);
  assert.ok(fn, `IPC handler 未注册: ${channel}`);
  return async (...args) => {
    const env = await fn(...args);
    if (env && typeof env === 'object' && env[ENVELOPE_KEY] === 1) {
      if (!env.ok) throw new Error(env.error);
      return env.data;
    }
    return env;
  };
};

const agg = invoke('aggregate-cross-source');

/** 每例前换干净的 userData + 干净的登录态，避免用例间泄漏 */
let dirSeq = 0;
function fresh(cookies = {}) {
  // prefs 与 cookieStore 必须指向**同一个** userData：登录态单独放一个目录，
  // handler 读到的就会是另一份空 cookieStore，测出来的是"没登录"而非接线缺陷。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `musictest-aggp-${dirSeq++}-`));
  prefs.init(dir);
  cookieStore.init(dir);
  for (const k of Object.keys(cookies)) {
    assert.equal(cookieStore.set(k, cookies[k]), true, `登录态写入失败: ${k}`);
  }
}

/** 往本地红心塞一首歌 */
async function addFavorite(song) {
  await invoke('get-user-playlists')();
  const list = prefs.get('userPlaylists');
  const fav = list.find((p) => p.id === 'favorites');
  fav.songs.push(song);
  prefs.set('userPlaylists', list);
}

const NETEASE = { id: '1', source: 'netease', title: '晴天', artist: '周杰伦', duration: 269000 };
const QQ = { id: '9', source: 'qq', title: '晴天', artist: '周杰伦', duration: 269000 };

// ── 1. 登录态真的参与了代表条目挑选 ───────────────────

test('已登录的源排在前面（登录态漏传时本用例会失败）', async () => {
  fresh({ qq: 'qq-cookie' });
  await addFavorite({ ...NETEASE });
  await addFavorite({ ...QQ });

  const r = await agg({});
  const neteaseRow = r.songs.find((s) => s.source === 'netease');
  const qqRow = r.songs.find((s) => s.source === 'qq');
  assert.ok(neteaseRow._crossSource && qqRow._crossSource, '两首应被判为跨源同曲');
  assert.equal(qqRow._primary, true, '已登录的 qq 应被选为代表条目');
  assert.equal(neteaseRow._primary, false, '未登录的 netease 不该是代表条目');
});

test('换登录态则代表条目跟着换（证明确实读了真实登录态）', async () => {
  fresh({ netease: 'ne-cookie' });
  await addFavorite({ ...NETEASE });
  await addFavorite({ ...QQ });

  const r = await agg({});
  assert.equal(r.songs.find((s) => s.source === 'netease')._primary, true);
  assert.equal(r.songs.find((s) => s.source === 'qq')._primary, false);
});

test('两个源都登录 ⇒ 回落到时长已知优先，两边时长都有则取原顺序首条', async () => {
  fresh({ netease: 'a', qq: 'b' });
  await addFavorite({ ...NETEASE });
  await addFavorite({ ...QQ });

  const r = await agg({});
  const primaries = r.songs.filter((s) => s._primary === true);
  assert.equal(primaries.length, 1, '每簇有且仅有一个代表条目');
  assert.equal(primaries[0].source, 'netease', '同分时应保持原顺序');
});

test('两个源都没登录 ⇒ 仍应产出恰好一个代表条目（不得全为 false）', async () => {
  fresh({});
  await addFavorite({ ...NETEASE });
  await addFavorite({ ...QQ });

  const r = await agg({});
  const primaries = r.songs.filter((s) => s._crossSource && s._primary === true);
  assert.equal(primaries.length, 1, '无登录态时也必须选出一个代表条目');
});

// ── 2. _primary 的键格式一致（第二个缺陷） ─────────────

test('代表条目的 key 两侧算法一致：簇内恰好一个 true，其余 false', async () => {
  // 用两套 songKey 格式互不相等的历史 bug 会让这里 primaries.length === 0
  fresh({ qq: 'qq-cookie' });
  await addFavorite({ ...NETEASE });
  await addFavorite({ ...QQ });

  const r = await agg({});
  const cross = r.songs.filter((s) => s._crossSource);
  assert.equal(cross.length, 2);
  const trues = cross.filter((s) => s._primary === true);
  const falses = cross.filter((s) => s._primary === false);
  assert.equal(trues.length, 1, `应恰好 1 个 true，实际 ${trues.length}（键格式不一致时为 0）`);
  assert.equal(falses.length, 1, '另一个条目应为 false');
});

test('非跨源条目不带 _primary（渲染层据此判断是否提示）', async () => {
  fresh({});
  await addFavorite({ id: 'x', source: 'kugou', title: '稻香', artist: '周杰伦', duration: 223000 });

  const r = await agg({});
  const solo = r.songs.find((s) => s.source === 'kugou');
  assert.equal(solo._crossSource, undefined);
  assert.equal(solo._primary, undefined, '非跨源条目不该被标成"非代表条目"');
});

// ── 3. 否定对照：两套键格式确实互不相等 ───────────────

test('否定对照：模块 songKey 与旧局部格式永不相等（守卫前提成立）', () => {
  const { songKey } = require('../src/utils/crossSourceAggregate');
  const legacy = (s) => String(s && s.id) + ':' + String((s && s.source) || '');
  const song = { id: '1001', source: 'netease' };
  assert.notEqual(songKey(song), legacy(song),
    '两套键格式若相等，上面几条守卫的前提就变了，需要重新评估 _primary 比对');
});

test('否定对照：把登录态参数拿掉，代表条目的选择确实会变（证明该参数有意义）', async () => {
  fresh({ qq: 'qq-cookie' });
  await addFavorite({ ...NETEASE });
  await addFavorite({ ...QQ });

  const withAuth = await agg({});
  const { pickRepresentative } = require('../src/utils/crossSourceAggregate');
  const members = withAuth.songs;
  // 漏传第二参数 ⇒ 已登录优先准则失效
  const repWithoutAuth = pickRepresentative(members).source;
  const repWithAuth = pickRepresentative(members, new Set(['qq'])).source;
  assert.equal(repWithAuth, 'qq');
  assert.equal(repWithoutAuth, 'netease', '漏传时确实退化为原顺序——这正是要防的回归');
  // 且聚合器本身不受影响（只读）
  assert.equal(withAuth.songs.length, 2);
});
