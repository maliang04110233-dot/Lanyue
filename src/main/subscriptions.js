/**
 * 订阅更新引擎
 *
 * 用户在歌单弹窗 / 歌手主页点「订阅」后，本模块周期性拉取目标曲目，
 * 与上次快照做差集得到「新增歌曲」，可选自动加入下载队列。
 *
 * 存储：prefs.json 的 'subscriptions' 键（随云同步备份，无需独立文件）。
 * 条目形状见 makeEntry。
 *
 * 设计约束（踩过的坑）：
 *   - gateway 失败时静默返回 []，不能把「本次拉取为空」当作「曲目被删光」，
 *     否则网络抖动会让老歌全部重新变「新增」。故 lastSeenIds 用**并集**语义，
 *     只进不出。
 *   - 首次检查静默播种（seed）：只记快照不产新增，避免订阅瞬间刷屏 +
 *     autoDownload 把整个歌单灌进队列。
 * - 「空清单」不等于「检查成功」：gateway 对缺能力/需登录/VIP
 *     歌单一律静默返回 []，若照单全收就会把首次播种播成空快照（下一次真数据
 *     到达时整单变「新增」，正是本文件头一条要防的刷屏）。判定收成
 *     applyCheckToEntry 一家：空/非数组只记账，不碰快照与未读。
 *   - 调度器与 playCache GC 同风格：unref 定时器，不阻止进程退出。
 *   - 检查间隔是用户可设的档位（设置页写 subscriptionCheckIntervalHours），本模块
 *     只信"有限、正数、夹在可用区间内"三个条件；不信任输入，因为写入口是 IPC 边界。
 */

const api = require('../api');
const prefs = require('../utils/prefs');
const history = require('../utils/history');
const logger = require('../utils/logger');
const { safeSend, getDownloadQueue } = require('./context');

const PREFS_KEY = 'subscriptions';
const MAX_NEW_SONGS = 100;          // 单订阅保留的新歌列表上限（防 prefs.json 膨胀）
const PLAYLIST_LIMIT = 200;
const SINGER_LIMIT = 50;
const DEFAULT_CHECK_INTERVAL_HOURS = 6;
// 间隔可由用户在设置页改（subscriptionCheckIntervalHours），夹在这里而不是信任输入：
// 下限取调度器醒来粒度的整数倍（比这更快也更快不了，等于给用户一个假档位），
// 上限一星期（再大就事实上关掉了自动检查，却没有任何地方写着"已关闭"）。
const MIN_CHECK_INTERVAL_HOURS = 1;
const MAX_CHECK_INTERVAL_HOURS = 168;
const INITIAL_CHECK_DELAY_MS = 30 * 1000;
const CHECK_TICK_MS = 60 * 1000;    // 调度器醒来的粒度
/** 一次"什么都没取到"的检查对用户说的那句话（渲染层直接显示，与 main 侧其它中文文案同源） */
const EMPTY_CHECK_ERROR = '未取到任何曲目（可能需要登录，或该歌单/歌手页受限）';

const TYPES = new Set(['playlist', 'singer']);

// ── 纯函数（单测覆盖）────────────────────────────────────

function buildKey(type, platform, targetId) {
  return `${type}:${platform}:${targetId}`;
}

/**
 * 校验订阅参数并给出用户可见的错误文案。
 * @returns {string|null} null = 合法
 */
function validateAdd(type, platform, targetId) {
  if (!TYPES.has(type)) return '不支持的订阅类型';
  if (!platform || !targetId) return '参数不完整';
  const plugin = api.registry.get(platform);
  if (!plugin) return `未知平台: ${platform}`;
  if (type === 'playlist' && typeof plugin.getPlaylistSongs !== 'function') {
    return `${platform} 暂不支持歌单订阅`;
  }
  if (type === 'singer' && typeof plugin.getSingerSongs !== 'function') {
    return `${platform} 暂不支持歌手订阅`;
  }
  return null;
}

/**
 * 与上次快照求差集。
 * @param {Array<object>} songs 本次拉取结果
 * @param {string[]|null} lastSeenIds null = 从未检查过（静默播种）
 * @param {number} cap 新增列表截断上限
 * @returns {{fresh: Array<object>, seenIds: string[], seeded: boolean}}
 */
function diffSongs(songs, lastSeenIds, cap = MAX_NEW_SONGS) {
  const list = Array.isArray(songs) ? songs.filter(s => s && s.id != null && s.id !== '') : [];
  const currentIds = list.map(s => String(s.id));
  if (lastSeenIds === null || lastSeenIds === undefined) {
    return { fresh: [], seenIds: Array.from(new Set(currentIds)), seeded: true };
  }
  const seen = new Set(lastSeenIds.map(String));
  const fresh = [];
  for (const s of list) {
    if (!seen.has(String(s.id))) {
      seen.add(String(s.id));       // 同批内重复 id 只算一次新增
      fresh.push(s);
    }
  }
  // 并集语义：只进不出，平台抽风返回空列表不会让老歌复活成「新增」
  const merged = [];
  for (const id of lastSeenIds.map(String)) if (!merged.includes(id)) merged.push(id);
  for (const id of currentIds) if (!merged.includes(id)) merged.push(id);
  return { fresh: fresh.slice(0, cap), seenIds: merged, seeded: false };
}

/**
 * 一次检查的写回（纯函数，无 I/O）：把「拿到了但没新歌」与「根本没拿到清单」分开记账。
 * 空数组 / 非数组 = 这次没取到数据 —— 只写 lastCheckError 并推进 lastCheckedAt
 * （不推进就会因为 _isDue 立刻到期，从默认档的每 6 小时退化成每 60s 打一次平台），
 * 快照与未读红点一字不动：前者不能被空播成"已播种"，后者归用户"看过了"管。
 * @param {number} now 本次写回的时间戳（由调用方给，测试可确定）
 * @returns {{entry: object, freshCount: number, toEnqueue: Array<object>, empty: boolean}}
 */
function applyCheckToEntry(entry, songs, now) {
  const next = { ...entry };
  if (!Array.isArray(songs) || songs.length === 0) {
    next.lastCheckError = EMPTY_CHECK_ERROR;
    next.lastCheckedAt = now;
    return { entry: next, freshCount: 0, toEnqueue: [], empty: true };
  }
  const { fresh, seenIds, seeded } = diffSongs(songs, entry.lastSeenIds);
  next.lastSeenIds = seenIds;
  next.lastCheckedAt = now;
  next.lastCheckError = '';
  if (seeded) return { entry: next, freshCount: 0, toEnqueue: [], empty: false };
  next.newSongs = fresh.slice(-MAX_NEW_SONGS).reverse();   // 新的在前
  const toEnqueue = entry.autoDownload ? fresh : [];
  return { entry: next, freshCount: fresh.length, toEnqueue, empty: false };
}

function makeEntry(type, platform, targetId, name) {
  return {
    key: buildKey(type, platform, targetId),
    type,
    platform,
    targetId: String(targetId),
    name: String(name || ''),
    lastSeenIds: null,              // null = 尚未播种
    lastCheckedAt: null,
    lastCheckError: '',
    newSongs: [],
    autoDownload: false,
    addedAt: Date.now(),
  };
}

// ── 存储 ─────────────────────────────────────────────────

function _loadAll() {
  const raw = prefs.get(PREFS_KEY);
  return Array.isArray(raw) ? raw.filter(e => e && typeof e === 'object' && e.key) : [];
}

function _saveAll(entries) {
  prefs.set(PREFS_KEY, entries);
}

function _emit() {
  safeSend('subscriptions-updated', _listView());
}

/** 发给渲染层的瘦身视图：新歌只留 DTO 必要字段 */
function _listView() {
  return _loadAll().map(e => ({
    key: e.key,
    type: e.type,
    platform: e.platform,
    targetId: e.targetId,
    name: e.name,
    hasSeeded: e.lastSeenIds !== null && e.lastSeenIds !== undefined,
    lastCheckedAt: e.lastCheckedAt || null,
    lastCheckError: e.lastCheckError || '',
    newCount: (e.newSongs || []).length,
    newSongs: (e.newSongs || []).slice(0, MAX_NEW_SONGS),
    autoDownload: !!e.autoDownload,
    addedAt: e.addedAt || null,
  }));
}

// ── 拉取 ─────────────────────────────────────────────────

async function _fetchSongs(entry) {
  if (entry.type === 'playlist') {
    return await api.getPlaylistSongs(entry.platform, entry.targetId, PLAYLIST_LIMIT);
  }
  // platform 必须透传：门面缺省会按 id 形态猜平台，数字 mid 的歌手会被路由错源
  return await api.getSingerSongs(entry.targetId, SINGER_LIMIT, entry.platform);
}

// ── 自动下载 ─────────────────────────────────────────────

/**
 * 把新增歌曲排进下载队列。与 add-to-queue 相同的两级去重：
 * 队列内在途任务 + 历史记录（文件仍在磁盘）。
 * @returns {number} 实际入队数
 */
function _autoEnqueue(entry, fresh) {
  let ctx;
  try {
    ctx = require('./context').getCtx();
  } catch (_e) {
    logger.warn('[subscriptions] 上下文未就绪，跳过自动下载');
    return 0;
  }
  const { persistQueue, processQueue } = ctx;
  const downloadQueue = getDownloadQueue();
  let queued = 0;
  for (const song of fresh) {
    const inQueue = downloadQueue.some(s =>
      s && String(s.id) === String(song.id) && s.source === song.source && s.status !== 'done');
    if (inQueue) continue;
    if (history.findDownloaded(song.id, song.source)) continue;
    downloadQueue.push({
      ...song,
      id: String(song.id),
      taskId: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      status: 'pending',
      progress: 0,
      addedAt: Date.now(),
    });
    queued++;
  }
  if (queued > 0) {
    logger.log(`[subscriptions] ${entry.name || entry.key} 自动下载 ${queued} 首`);
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    processQueue();
  }
  return queued;
}

// ── 检查 ─────────────────────────────────────────────────

let _checking = false;

/**
 * 检查一批订阅（顺序执行，避免同时打多个平台接口触发风控）。
 * @param {boolean} force true = 全部；false = 只查到期项
 * @returns {Promise<{checked:number, newTotal:number}>}
 */
async function runCheck(force = false) {
  if (_checking) return { checked: 0, newTotal: 0, skipped: true };
  _checking = true;
  const started = Date.now();
  let checked = 0;
  let newTotal = 0;
  try {
    const entries = _loadAll();
    let changed = false;
    for (const entry of entries) {
      if (!force && !_isDue(entry, started)) continue;
      checked++;
      try {
        const songs = await _fetchSongs(entry);
        const r = applyCheckToEntry(entry, songs, Date.now());
        Object.assign(entry, r.entry);
        if (r.toEnqueue.length) _autoEnqueue(entry, r.toEnqueue);
        newTotal += r.freshCount;
        changed = true;
      } catch (e) {
        // 抛错当瞬时故障：不动 lastCheckedAt（从未成功过的项下个 tick 即重试，成功过的按原间隔再来）。
        // 空清单则是稳定状态（受限歌单/未登录），重试再快也拿不到东西，故按检查间隔退避。
        entry.lastCheckError = (e && e.message) || '检查失败';
        changed = true;
        logger.warn(`[subscriptions] ${entry.key} 检查失败:`, e.message);
      }
    }
    if (changed) {
      _saveAll(entries);
      _emit();
    }
  } finally {
    _checking = false;
  }
  return { checked, newTotal };
}

function _isDue(entry, now) {
  const intervalMs = _intervalMs();
  return !entry.lastCheckedAt || (now - entry.lastCheckedAt) >= intervalMs;
}

function _intervalMs() {
  const raw = Number(prefs.get('subscriptionCheckIntervalHours', DEFAULT_CHECK_INTERVAL_HOURS));
  const hours = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CHECK_INTERVAL_HOURS;
  return Math.min(MAX_CHECK_INTERVAL_HOURS, Math.max(MIN_CHECK_INTERVAL_HOURS, hours)) * 3600 * 1000;
}

// ── 调度器（main/index.js 在 whenReady 里 start）─────────

let _timer = null;

function startScheduler() {
  if (_timer) return;
  const initial = setTimeout(() => {
    runCheck(false).catch(e => logger.warn('[subscriptions] 周期检查失败:', e.message));
  }, INITIAL_CHECK_DELAY_MS);
  if (initial.unref) initial.unref();
  _timer = setInterval(() => {
    runCheck(false).catch(e => logger.warn('[subscriptions] 周期检查失败:', e.message));
  }, CHECK_TICK_MS);
  if (_timer.unref) _timer.unref();
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// ── 对外操作（ipc/subscriptions.js 调用）─────────────────

function list() {
  return _listView();
}

function add(type, platform, targetId, name) {
  const t = String(type || '');
  const p = String(platform || '');
  const id = String(targetId || '');
  const err = validateAdd(t, p, id);
  if (err) return { success: false, error: err };
  const entries = _loadAll();
  const key = buildKey(t, p, id);
  const existing = entries.find(e => e.key === key);
  if (existing) return { success: true, entry: existing, duplicated: true };
  const entry = makeEntry(t, p, id, name);
  entries.push(entry);
  _saveAll(entries);
  _emit();
  return { success: true, entry };
}

function remove(key) {
  const entries = _loadAll();
  const next = entries.filter(e => e.key !== key);
  if (next.length === entries.length) return { success: false, error: '订阅不存在' };
  _saveAll(next);
  _emit();
  return { success: true };
}

/** patch 白名单：目前只允许切换 autoDownload */
function update(key, patch) {
  const entries = _loadAll();
  const entry = entries.find(e => e.key === key);
  if (!entry) return { success: false, error: '订阅不存在' };
  if (patch && typeof patch === 'object' && typeof patch.autoDownload === 'boolean') {
    entry.autoDownload = patch.autoDownload;
    _saveAll(entries);
    _emit();
  }
  return { success: true, entry };
}

/** 用户看完新歌后清空红点 */
function markSeen(key) {
  const entries = _loadAll();
  const entry = entries.find(e => e.key === key);
  if (!entry) return { success: false, error: '订阅不存在' };
  entry.newSongs = [];
  _saveAll(entries);
  _emit();
  return { success: true };
}

function checkNow() {
  return runCheck(true);
}

/** 导航红点总数：所有订阅未读新歌之和 */
function unreadCount() {
  return _loadAll().reduce((n, e) => n + (e.newSongs || []).length, 0);
}

module.exports = {
  list, add, remove, update, markSeen, checkNow, unreadCount,
  startScheduler, stopScheduler, runCheck,
  _internal: {
    buildKey, validateAdd, diffSongs, applyCheckToEntry, makeEntry, _isDue, _intervalMs,
    MAX_NEW_SONGS, EMPTY_CHECK_ERROR, CHECK_TICK_MS,
    DEFAULT_CHECK_INTERVAL_HOURS, MIN_CHECK_INTERVAL_HOURS, MAX_CHECK_INTERVAL_HOURS,
  },
};
