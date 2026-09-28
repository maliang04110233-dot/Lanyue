/**
 * 歌单回收站 + 撤销删除（增量156/157，审计 F2「删除必见影响 → 5 秒撤销 → 回收站兜底」）
 *
 * 三层覆盖（沿用本仓惯例）：
 *  1. 纯函数：utils/playlistTrash.js 的挪站/放回/过期清/列表视图/彻底删除，零 IO；
 *  2. 真 prefs 端到端：删→查站→撤销→冲突清理→启动清过期→opts.trash 换视图→彻底删除（electron 打桩，同 favorites.test.js）；
 *  3. 接线钉：主进程挂点必须真的调纯函数、渲染层确认框必须点名影响、
 *     撤销/恢复必须走既有 save-user-playlist、彻底删除必须走 delete-user-playlist 再删一次 ——
 *     契约三个频道的 args 形状逐字钉死，
 *     并反向钉「不许出现回收站新通道」。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  trashRemove, trashRestore, purgeExpired, trashView, trashPurge, TRASH_TTL_MS, MAX_TRASH,
} = require('../src/utils/playlistTrash');

const DAY = 24 * 60 * 60 * 1000;
const PL_A = { id: 'pl_a', name: 'A', songs: [{ id: 1, source: 'netease' }] };
const PL_B = { id: 'pl_b', name: 'B', songs: [] };

// ── 1. 纯函数 ─────────────────────────────────────────

test('trashRemove: 挪进回收站并盖 deletedAt，入参数组零突变', () => {
  const list = [PL_A, PL_B];
  const trash = [];
  const r = trashRemove(list, trash, 'pl_a', 1234);
  assert.deepEqual(r.playlists.map(p => p.id), ['pl_b']);
  assert.equal(r.trash.length, 1);
  assert.equal(r.trash[0].playlist, PL_A);
  assert.equal(r.trash[0].deletedAt, 1234);
  assert.equal(r.removed, PL_A);
  // 入参原封不动（调用方手里可能还有同一份引用）
  assert.equal(list.length, 2);
  assert.equal(trash.length, 0);
});

test('trashRemove: 找不到 id ⇒ removed=null 且两个数组原样退回', () => {
  const list = [PL_B];
  const r = trashRemove(list, [], 'nope', 1);
  assert.equal(r.removed, null);
  assert.equal(r.playlists, list);
});

test('trashRemove: 超上限只留最近 MAX_TRASH 条', () => {
  const big = Array.from({ length: MAX_TRASH }, (_, i) => ({ playlist: { id: 'x' + i }, deletedAt: i }));
  const r = trashRemove([PL_A], big, 'pl_a', 999);
  assert.equal(r.trash.length, MAX_TRASH);
  assert.equal(r.trash[0].playlist.id, 'pl_a');
  assert.equal(r.trash[MAX_TRASH - 1].playlist.id, 'x' + (MAX_TRASH - 2)); // 最老那条被挤掉
});

test('trashRestore: 放回队首、id 不变、条目离开回收站', () => {
  const tr = [{ playlist: PL_A, deletedAt: 5 }];
  const r = trashRestore([PL_B], tr, { ...PL_A, name: 'A 改名了' });
  assert.equal(r.restored, r.playlists[0]);
  assert.equal(r.playlists[0].id, 'pl_a');
  assert.equal(r.playlists[0].name, 'A 改名了'); // 以调用方递来的内容为准
  assert.equal(r.trash.length, 0);
  assert.equal(r.inPlaylist, false);
});

test('trashRestore: id 已在列表（云同步先带回来了）⇒ 只清条目，不重复插入', () => {
  const tr = [{ playlist: PL_A, deletedAt: 5 }];
  const list = [PL_A, PL_B];
  const r = trashRestore(list, tr, PL_A);
  assert.equal(r.restored, null);
  assert.equal(r.inPlaylist, true);
  assert.equal(r.playlists.length, 2);
  assert.equal(r.trash.length, 0);
});

test('trashRestore: 回收站里也没有 ⇒ 两个 false，调用方走原新建逻辑', () => {
  const r = trashRestore([PL_B], [], PL_A);
  assert.equal(r.restored, null);
  assert.equal(r.inPlaylist, false);
  assert.equal(r.playlists.length, 1);
});

test('trashRestore: 无 id 入参直接退回（撤销分支不该收到这种货）', () => {
  const list = [PL_B];
  const r = trashRestore(list, [{ playlist: { id: 'pl_b' }, deletedAt: 1 }], { name: '无名' });
  assert.equal(r.restored, null);
  assert.equal(r.playlists, list);
});

test('purgeExpired: 30 天整判过期（>=TTL 即清），脏条目按最老处理一并清', () => {
  const now = 1_000_000 * DAY;
  const fresh = { playlist: PL_A, deletedAt: now - TRASH_TTL_MS + 1 };
  const exact = { playlist: PL_B, deletedAt: now - TRASH_TTL_MS };
  const garbage = [{ playlist: PL_A }, { deletedAt: now }]; // 缺 deletedAt / 缺 playlist
  const r = purgeExpired([fresh, exact, ...garbage], now);
  assert.deepEqual(r.trash, [fresh]);
  assert.equal(r.purged.length, 3);
});

test('purgeExpired: 非数组入参退回空站（prefs 键被写坏也不炸启动）', () => {
  const r = purgeExpired(undefined, 1);
  assert.deepEqual(r.trash, []);
  assert.deepEqual(r.purged, []);
});

test('trashView: 脏条目丢弃、新删的排前面、playlist 原样嵌套不摊平', () => {
  const now = 1_000_000 * DAY;
  const old = { playlist: PL_A, deletedAt: now - 10 * DAY };
  const fresh = { playlist: PL_B, deletedAt: now - DAY };
  const view = trashView([{ playlist: PL_A }, { deletedAt: now }, garbage2(), fresh, old], now);
  assert.deepEqual(view.map(e => e.playlist.id), ['pl_b', 'pl_a']);
  assert.equal(view[0].playlist, PL_B, 'playlist 必须是原引用 —— 恢复时传的就是这份原货，摊平/加视图字段会污染 userPlaylists');
  assert.deepEqual(Object.keys(view[0]).sort(), ['daysLeft', 'deletedAt', 'playlist']);
});

function garbage2() { return null; } // 数组里的裸 null 也不许炸

test('trashView: daysLeft 按 TTL 上取整、临期钳到 1、非数组入参退回空表', () => {
  const now = 1_000_000 * DAY;
  const view = trashView([
    { playlist: PL_A, deletedAt: now - DAY },              // 删了一天整 ⇒ 剩 29 天
    { playlist: PL_B, deletedAt: now - TRASH_TTL_MS + 1 }, // 还剩 1 毫秒 → 钳到 1
  ], now);
  assert.equal(view[0].daysLeft, 29);
  assert.equal(view[1].daysLeft, 1);
  assert.deepEqual(trashView(undefined, now), []);
});

test('trashPurge: 命中 ⇒ 条目离站并回传，未命中 ⇒ purged=null 且数组原样', () => {
  const tr = [{ playlist: PL_A, deletedAt: 5 }, { playlist: PL_B, deletedAt: 6 }];
  const hit = trashPurge(tr, 'pl_a');
  assert.equal(hit.purged.playlist.id, 'pl_a');
  assert.equal(hit.trash.length, 1);
  const miss = trashPurge(tr, 'nope');
  assert.equal(miss.purged, null);
  assert.equal(miss.trash, tr);
  assert.equal(trashPurge(undefined, 'x').purged, null);
});

// ── 2. 真 prefs 端到端（electron 打桩，同 favorites.test.js） ──

const handlers = new Map();
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-trash-'));

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      app: { getPath: () => userDataDir },
      shell: { trashItem: async () => {}, showItemInFolder() {} },
      dialog: {
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
        showSaveDialog: async () => ({ canceled: true }),
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const prefs = require('../src/utils/prefs');
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

function fresh() {
  prefs.init(fs.mkdtempSync(path.join(os.tmpdir(), 'musictest-trash-')));
}

const getIds = async () => (await invoke('get-user-playlists')()).map(p => p.id);

test('端到端：删除→进回收站→撤销原 id 找回，全程零新通道', async () => {
  fresh();
  const created = await invoke('save-user-playlist')(null, { name: '下班听的', songs: [{ id: 7, source: 'netease', title: 'x' }] });
  assert.ok(created.success && created.playlist.id);
  const pl = created.playlist;

  const del = await invoke('delete-user-playlist')(null, pl.id);
  assert.equal(del.success, true);
  assert.ok(!(await getIds()).includes(pl.id), '列表里不该再看得见');
  const tr = prefs.get('playlistTrash');
  assert.equal(tr.length, 1);
  assert.equal(tr[0].playlist.id, pl.id);
  assert.ok(typeof tr[0].deletedAt === 'number');

  // 撤销 = 渲染层攥着副本走既有 save-user-playlist（模拟浏览器端传法）
  const back = await invoke('save-user-playlist')(null, pl);
  assert.equal(back.success, true);
  assert.equal(back.restored, true);
  assert.equal(back.playlist.id, pl.id, 'id 必须原样，收藏/封面等按 id 记的东西才不断链');
  assert.ok((await getIds()).includes(pl.id));
  assert.equal(prefs.get('playlistTrash').length, 0);
});

test('端到端：列表里已有同 id（云端先带回来）⇒ 保存走更新分支并顺手清掉回收站陈旧条目，不出现两份', async () => {
  fresh();
  const created = await invoke('save-user-playlist')(null, { name: '撞上云', songs: [] });
  const pl = created.playlist;
  await invoke('delete-user-playlist')(null, pl.id);
  // 模拟云同步把原歌单灌回 userPlaylists（回收站条目仍挂着）
  const list = prefs.get('userPlaylists');
  list.unshift(pl);
  prefs.set('userPlaylists', list);

  const r = await invoke('save-user-playlist')(null, pl);
  assert.equal(r.success, true);
  assert.equal((await getIds()).filter(id => id === pl.id).length, 1);
  assert.equal(prefs.get('playlistTrash').length, 0, '复活后的陈旧回收站条目必须被清掉');
});

test('端到端：收藏系统单依然删不动，且不会误进回收站', async () => {
  fresh();
  await invoke('get-user-playlists')();
  const r = await invoke('delete-user-playlist')(null, 'favorites');
  assert.equal(r.success, false);
  assert.match(r.error, /不能删除/);
  assert.ok((await getIds()).includes('favorites'));
  assert.ok(!prefs.get('playlistTrash'));
});

test('端到端：带陌生 id 的保存（导入场景）保持旧行为 —— 另发新 id 新建，不去回收站碰瓷', async () => {
  fresh();
  const r = await invoke('save-user-playlist')(null, { id: 'pl_from_elsewhere', name: '导入的', songs: [] });
  assert.equal(r.success, true);
  assert.notEqual(r.playlist.id, 'pl_from_elsewhere');
  assert.equal(r.restored, undefined);
});

test('端到端：register() 启动清过期 —— 31 天前的条目没了，新鲜的留着', async () => {
  fresh();
  const now = Date.now();
  prefs.set('playlistTrash', [
    { playlist: PL_A, deletedAt: now - 31 * DAY },
    { playlist: PL_B, deletedAt: now - DAY },
  ]);
  ipcPlaylist.register();
  const tr = prefs.get('playlistTrash');
  assert.equal(tr.length, 1);
  assert.equal(tr[0].playlist.id, 'pl_b');
});

test('端到端（增量157）：get-user-playlists({trash:true}) 返回带倒计时的视图，普通调用不受影响', async () => {
  fresh();
  const created = await invoke('save-user-playlist')(null, { name: '删了看看', songs: [{ id: 1, source: 'netease' }] });
  const pl = created.playlist;
  await invoke('delete-user-playlist')(null, pl.id);

  const view = await invoke('get-user-playlists')(null, { trash: true });
  assert.equal(view.length, 1);
  assert.equal(view[0].playlist.id, pl.id);
  assert.equal(view[0].playlist.name, '删了看看');
  assert.equal(view[0].daysLeft, 30, '刚删的应显示剩余 30 天（上取整）');
  // 普通调用（不带 opts）照旧返回歌单列表本体，不含被删者
  const plain = await invoke('get-user-playlists')();
  assert.ok(Array.isArray(plain));
  assert.ok(!plain.some(p => p.id === pl.id));
});

test('端到端（增量157）：回收站里"再删一次"= 彻底删除；此后既不在列表也不在回收站', async () => {
  fresh();
  const created = await invoke('save-user-playlist')(null, { name: '彻底删', songs: [] });
  const pl = created.playlist;
  await invoke('delete-user-playlist')(null, pl.id);

  const purge = await invoke('delete-user-playlist')(null, pl.id);
  assert.equal(purge.success, true);
  assert.equal(purge.purged, true);
  assert.deepEqual(prefs.get('playlistTrash'), []);
  // 第三次同 id 删除：列表没有、回收站也没有 ⇒ 如实报"歌单不存在"，绝不静默成功
  const third = await invoke('delete-user-playlist')(null, pl.id);
  assert.equal(third.success, false);
  assert.match(third.error, /不存在/);
});

test('端到端（增量157）：回收站视图条目走 save-user-playlist = 恢复，id 内容原样回列表', async () => {
  fresh();
  const created = await invoke('save-user-playlist')(null, { name: '从站内回', songs: [{ id: 9, source: 'netease', title: 'y' }] });
  const pl = created.playlist;
  await invoke('delete-user-playlist')(null, pl.id);
  const view = await invoke('get-user-playlists')(null, { trash: true });

  const r = await invoke('save-user-playlist')(null, view[0].playlist);
  assert.equal(r.success, true);
  assert.equal(r.restored, true);
  assert.ok((await getIds()).includes(pl.id));
  assert.deepEqual(prefs.get('playlistTrash'), []);
});

// ── 3. 接线钉：链路不许断 ─────────────────────────────

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('主进程挂点：启动清过期 / 删除走 trashRemove / 保存分支走 trashRestore / 视图与彻底删除各就各位', () => {
  const src = read('src/main/ipc/playlist.js');
  assert.match(src, /require\('\.\.\/\.\.\/utils\/playlistTrash'\)/, '纯函数模块没接上');
  assert.match(src, /const \{ trashRemove, trashRestore, purgeExpired, trashView, trashPurge \}/);
  assert.match(src, /purgeExpired\(trashNow, Date\.now\(\)\)/, 'register() 里没做启动清过期');
  assert.match(src, /trashRemove\(playlists, _trash\(\), playlistId/, '删除 handler 又写回硬删 filter 了');
  assert.match(src, /trashRestore\(playlists, _trash\(\), playlist\)/, '保存 handler 没接撤销分支');
  assert.match(src, /if \(opts && opts\.trash\) return trashView\(_trash\(\), Date\.now\(\)\);/, 'get-user-playlists 没接回收站视图 opts');
  assert.match(src, /trashPurge\(_trash\(\), playlistId\)/, 'delete handler 没接"再删一次=彻底删除"分支');
  assert.ok(!/playlists\.filter\(p => p\.id !== playlistId\)/.test(src), '硬删 filter 复活');
});

test('渲染层：确认框点名歌单与歌数，删除后走带「撤销」按钮的 toast，撤销复用 save-user-playlist', () => {
  const src = read('src/renderer/js/views/playlist.js');
  const dict = require('../src/renderer/js/lang/zh.json');
  const fn = src.match(/async function deletePlaylist[\s\S]*?\n}\n/);
  assert.ok(fn, 'deletePlaylist 找不到了（改名/挪走时同步本测试）');
  // 文案已收进词典（增量210 一批）：断言从「源码里有中文模板串」改成
  // 「源码把 name / count 传进去了，且词典那一格真的点得着名与数」。
  // 只钉 t('toast.plConfirmDelete' 是不够的 —— 那只证明接了词典，
  // 不证明这条文案还守着 F2 纪律。两侧都要钉。
  assert.match(fn[0], /askConfirm\(t\(\s*'toast\.plConfirmDelete',\s*\{[^}]*name:\s*pl\.name[^}]*count:\s*n[^}]*\}\s*\)\)/,
    '确认框必须走词典且带上歌名与歌数');
  assert.match(dict['toast.plConfirmDelete'] || '', /\{name\}/,
    '词典 toast.plConfirmDelete 丢了 {name} —— 确认框点不出是哪张歌单（F2 纪律）');
  assert.match(dict['toast.plConfirmDelete'] || '', /\{count\}/,
    '词典 toast.plConfirmDelete 丢了 {count} —— 确认框亮不出影响范围（歌数）');
  assert.match(fn[0], /showActionToast\(\{/, '没走带按钮的 toast');
  assert.match(fn[0], /btnLabel: t\('toast\.undo'\)/, '撤销按钮文案要走词典');
  assert.match(dict['toast.undo'] || '', /撤销/, '词典 toast.undo 应是「撤销」');
  assert.match(fn[0], /ttl: 5000/, '撤销窗口必须是 5 秒（审计 F2）');
  const undo = src.match(/async function undoDeletePlaylist[\s\S]*?\n}\n/);
  assert.ok(undo, 'undoDeletePlaylist 没了');
  assert.match(undo[0], /api\.saveUserPlaylist\(pl\)/, '撤销必须走既有保存通道，不许另开通道');
});

test('渲染层（增量157）：回收站入口/弹窗/四个函数接线齐全，恢复与彻底删除都走既有通道', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /id="plTrashBtn"[^>]*onclick="openPlaylistTrash\(\)"/, '工具条回收站按钮没接上');
  assert.match(html, /id="playlistTrashModal"/, '回收站弹窗没了');
  const src = read('src/renderer/js/views/playlist.js');
  for (const fn of ['refreshPlTrash', 'openPlaylistTrash', 'closePlaylistTrash', 'restoreTrashedPlaylist', 'purgeTrashedPlaylist']) {
    assert.ok(new RegExp('function ' + fn + '\\b').test(src), `${fn} 没了`);
    assert.match(src, new RegExp('window\\.' + fn + ' = ' + fn + ';'), `${fn} 没挂 window（onclick 全局调用会断）`);
  }
  assert.match(src, /function renderPlTrashList\b/, '列表渲染函数没了');
  assert.match(src, /api\.getUserPlaylists\(\{ trash: true \}\)/, '徽标刷新没走 opts.trash 换视图');
  assert.match(src, /loadUserPlaylists\(\)[\s\S]*?\n\}\n[\s\S]*?refreshPlTrash\(\);/, 'loadUserPlaylists 末尾没跟着刷回收站徽标');
  const restore = src.match(/async function restoreTrashedPlaylist[\s\S]*?\n}\n/);
  assert.match(restore[0], /api\.saveUserPlaylist\(e\.playlist\)/, '恢复必须把视图里嵌套的原货交给既有保存通道');
  const purge = src.match(/async function purgeTrashedPlaylist[\s\S]*?\n}\n/);
  assert.match(purge[0], /askConfirm\(t\(\s*'toast\.plConfirmPurge',\s*\{[^}]*name:\s*pl\.name[^}]*count:\s*n[^}]*\}\s*\)\)/,
    '彻底删除确认框必须走词典且带上歌名与歌数（F2 纪律）');
  const dict = require('../src/renderer/js/lang/zh.json');
  assert.match(dict['toast.plConfirmPurge'] || '', /\{name\}/, '词典 toast.plConfirmPurge 丢了 {name}');
  assert.match(dict['toast.plConfirmPurge'] || '', /\{count\}/, '词典 toast.plConfirmPurge 丢了 {count}');
  assert.match(dict['toast.plConfirmPurge'] || '', /无法再找回|不可恢复|不可逆/,
    '彻底删除的确认文案必须说清这是不可逆的一层（词典侧丢了这句 = F2 纪律失守）');
  assert.match(purge[0], /api\.deleteUserPlaylist\(playlistId\)/, '彻底删除必须走 delete 频道的再删一次分支，不许新开通道');
  // daysLeft 由主进程算好（TTL 默认值只有一家），渲染层不许自己拿 30 去减
  assert.ok(!/30 \* 24|TRASH_TTL/.test(src), '渲染层私自重算了 TTL');
});

test('契约反向钉：三个频道 args 形状逐字未动，且没冒出回收站/撤销新通道', () => {
  const contract = read('src/shared/ipcContract.js');
  assert.match(contract, /'delete-user-playlist':\s*\{ invoke: MAIN, args: \[\['playlistId', t\.str\(64\)\]\] \}/);
  assert.match(contract, /'save-user-playlist':\s*\{ invoke: MAIN, args: \[\['playlist', t\.obj\(\)\]\] \}/);
  assert.match(contract, /'get-user-playlists':\s*\{ invoke: MAIN \}/);
  assert.ok(!/trash|recycle|undo/i.test(contract.replace(/\/\/.*$/gm, '')), '契约里出现了回收站/撤销类新通道 —— 撤销应走 save-user-playlist');
});

test('回收站是主进程内部键：不进 set-pref 白名单，也不进云同步的键清单', () => {
  const mainPrefs = read('src/main/ipc/prefs.js');
  assert.ok(!/'playlistTrash'/.test(mainPrefs), 'playlistTrash 不该出现在 set-pref 白名单（渲染层不该直接写它）');
  const sync = read('src/main/ipc/cloudSync.js');
  assert.ok(!/playlistTrash/.test(sync), '回收站不该被云同步 —— 撤销是本机 5 秒内的事');
});
