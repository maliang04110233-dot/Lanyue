/**
 * 下载历史持久化（SQLite 后端）
 *
 * 存储路径：userData/history.db（node:sqlite，Node ≥23.4 / Electron ≥37 内置，
 * 零原生依赖 —— Electron 44 内嵌 Node 24 直接可用，单测与运行时同一份 ABI）。
 *
 * 表结构（PRAGMA user_version 版本化迁移，见 MIGRATIONS）：
 *   - history：展示历史，上限 MAX_ENTRIES 条，超出淘汰最旧。
 *     条目原文存 data 列（JSON），未知扩展字段（matchedFrom 等）保真往返；
 *     常用过滤字段提升为带索引的列。
 *   - assets：去重索引（id+source 主键），**不随展示上限淘汰** —— 文件还在
 *     磁盘就不该允许重复下载（go-music-dl 双表设计）。文件被用户删除时
 *     由 findDownloaded 顺手回收该行。
 *
 * 设计要点（相对旧 JSON 整写后端的改变，均有对应测试钉住）：
 *   - 每次 add 即时落盘（WAL），消灭旧版 2s 防抖窗口的丢数据可能；
 *   - 旧 history.json 在 init 时一次性迁移并改名 .imported（损坏则 .bak + 空起步）；
 *   - db 文件损坏/打不开：备份 .bak 重建，绝不拖死主进程。
 *
 * ⚠️ 行为契约：公开 API 与旧版逐字一致（init/add/query/stats/flush/clear/
 *   destroy/importEntries/findDownloaded/MAX_ENTRIES），六个消费方
 *   （downloadQueue、ipc/{download,history,cloudSync}、subscriptions、main）零改动。
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const logger = require('./logger');
const { safeReadJson } = require('./atomicFile');
const { resolveSortOrder } = require('../shared/historySort');
const { pathsEqual } = require('./relinkRefs');

const MAX_ENTRIES = 5000;

/** schema 版本 —— 加表/加列时在 MIGRATIONS 追加一步并 +1 */
const SCHEMA_VERSION = 1;

const MIGRATIONS = [
  // v1：初始双表
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS history(
        key_id TEXT NOT NULL,
        key_source TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        artist TEXT NOT NULL DEFAULT '',
        album TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        save_path TEXT NOT NULL DEFAULT '',
        finished_at INTEGER NOT NULL DEFAULT 0,
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS ux_history_key ON history(key_id, key_source);
      CREATE INDEX IF NOT EXISTS ix_history_status ON history(status);
      CREATE INDEX IF NOT EXISTS ix_history_finished ON history(finished_at);
      CREATE TABLE IF NOT EXISTS assets(
        key_id TEXT NOT NULL,
        key_source TEXT NOT NULL,
        save_path TEXT NOT NULL,
        finished_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(key_id, key_source)
      );
    `);
  },
];

let _db = null;
let _userDataPath = null;
let _count = 0; // history 行数缓存（避免每次 add 都全表 count）

/** 主键归一：数字/字符串 id 视为同一条（B 站 id 可能是数字） */
function _keyId(id) {
  return id == null ? '' : String(id);
}

function _migrate(db) {
  const row = db.prepare('PRAGMA user_version').get();
  let v = Number(row && row.user_version) || 0;
  while (v < SCHEMA_VERSION) {
    db.exec('BEGIN');
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    v += 1;
  }
}

function _openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 2000');
  _migrate(db);
  return db;
}

/** 单条写入（迁移/常规共用）：cols 派生 + data 原文保真 */
function _rowOf(entry) {
  return [
    _keyId(entry.id), String(entry.source ?? ''),
    String(entry.title ?? ''), String(entry.artist ?? ''), String(entry.album ?? ''),
    String(entry.status ?? ''), String(entry.savePath ?? ''),
    Number(entry.finishedAt) || 0, JSON.stringify(entry),
  ];
}

function _syncAsset(db, kid, ks, entry) {
  if (entry.status === 'done' && entry.savePath) {
    db.prepare('INSERT OR REPLACE INTO assets(key_id, key_source, save_path, finished_at) VALUES (?, ?, ?, ?)')
      .run(kid, ks, String(entry.savePath), Number(entry.finishedAt) || 0);
  } else {
    db.prepare('DELETE FROM assets WHERE key_id = ? AND key_source = ?').run(kid, ks);
  }
}

/**
 * 旧版 history.json 一次性迁移。
 * 成功：按旧数组顺序导入（首元素最新，显式降序 seq）后改名 .imported；
 * 损坏：safeReadJson 已备份 .bak，不再处理（与 JSON 时代行为一致）。
 */
function _importLegacy(db, jsonPath) {
  let arr;
  try {
    if (!fs.existsSync(jsonPath)) return;
    const res = safeReadJson(jsonPath);
    if (!res.ok || res.empty || !Array.isArray(res.data)) return;
    arr = res.data;
  } catch (e) {
    logger.warn('[history] 旧历史读取失败（不影响新库使用）:', e.message);
    return;
  }
  try {
    db.exec('BEGIN');
    try {
      const ins = db.prepare(`
        INSERT OR REPLACE INTO history
          (key_id, key_source, title, artist, album, status, save_path, finished_at, seq, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      // seq 从 arr.length 递减（≥1）：首元素 seq 最大 = 最新在前；
      // AUTOINCREMENT 表显式写 seq 后，后续新插入自增值必大于历史最大值
      let seq = arr.length + 1;
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue;
        seq -= 1;
        const row = _rowOf(entry);
        ins.run(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], seq, row[8]);
        _syncAsset(db, row[0], row[1], entry);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    fs.renameSync(jsonPath, `${jsonPath}.imported`);
    logger.log(`[history] 已从 history.json 迁移 ${arr.length} 条到 history.db`);
  } catch (e) {
    logger.warn('[history] 旧历史迁移失败（不影响新库使用）:', e.message);
  }
}

function _ensure() {
  if (_db) return;
  if (!_userDataPath) {
    _db = _openDb(':memory:');
    _count = 0;
    return;
  }
  const file = path.join(_userDataPath, 'history.db');
  try {
    _db = _openDb(file);
  } catch (e) {
    // db 损坏/被占用 → 备份重建（与 JSON 时代 .bak 约定一致），仍失败则退内存库
    logger.warn('[history] history.db 打不开，备份重建:', e.message);
    try { fs.renameSync(file, `${file}.bak`); } catch (_e) { /* 可能本就不存在 */ }
    // 伴生的 WAL/SHM 若留着，会与重建出的新库错配，必须一并清走
    for (const suffix of ['-wal', '-shm']) {
      try { fs.renameSync(file + suffix, `${file}.bak${suffix}`); } catch (_e) { /* 本就不存在 */ }
    }
    try {
      _db = _openDb(file);
    } catch (e2) {
      logger.warn('[history] 重建仍失败，退化为内存历史（本次会话不落盘）:', e2.message);
      _db = _openDb(':memory:');
    }
  }
  _importLegacy(_db, path.join(_userDataPath, 'history.json'));
  _count = _db.prepare('SELECT count(*) AS c FROM history').get().c;
}

function init(userDataPath) {
  if (_db) {
    try { _db.close(); } catch (_e) { /* 已关闭 */ }
    _db = null;
  }
  _userDataPath = userDataPath;
  _ensure();
}

/** 淘汰超出上限的最旧展示记录（assets 去重索引不淘汰） */
function _trim() {
  if (_count <= MAX_ENTRIES) return;
  const cutoff = _db.prepare('SELECT seq FROM history ORDER BY seq DESC LIMIT 1 OFFSET ?').get(MAX_ENTRIES - 1);
  if (!cutoff) return;
  const r = _db.prepare('DELETE FROM history WHERE seq < ?').run(cutoff.seq);
  _count -= r.changes;
}

/**
 * 添加/更新一条历史记录（同 id+source 合并更新，保持原位置）。
 * @param {Object} entry
 */
function add(entry) {
  if (!entry || typeof entry !== 'object') return;
  _ensure();
  const kid = _keyId(entry.id);
  const ks = String(entry.source ?? '');

  const existing = _db.prepare('SELECT seq, data FROM history WHERE key_id = ? AND key_source = ?').get(kid, ks);
  const merged = existing ? { ...JSON.parse(existing.data), ...entry } : { ...entry };
  const row = _rowOf(merged);

  if (existing) {
    _db.prepare(`
      UPDATE history SET title=?, artist=?, album=?, status=?, save_path=?, finished_at=?, data=? WHERE seq=?
    `).run(row[2], row[3], row[4], row[5], row[6], row[7], row[8], existing.seq);
  } else {
    _db.prepare(`
      INSERT INTO history(key_id, key_source, title, artist, album, status, save_path, finished_at, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...row);
    _count += 1;
  }
  _syncAsset(_db, kid, ks, merged);
  _trim();
}

/** LIKE 模式串：转义 % _ \，其余按字面（与旧版 JS includes 语义对齐） */
function _likePattern(keyword) {
  return `%${String(keyword).toLowerCase().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
}

/**
 * 查询某首歌是否已成功下载过（跨会话去重）。
 *
 * 判定：assets 索引存在 且 savePath 文件仍在磁盘。
 * 文件已被用户删除 ⇒ 不算重复，并顺手回收索引行（重下后 add 会重新登记）。
 *
 * @param {string|number} id
 * @param {string} source
 * @returns {Object|null} 命中条目（历史已淘汰时由索引合成最小形状，savePath/finishedAt 恒在）
 */
function findDownloaded(id, source) {
  if (id == null || id === '' || !source) return null;
  _ensure();
  const kid = _keyId(id);
  const ks = String(source);
  const asset = _db.prepare('SELECT save_path, finished_at FROM assets WHERE key_id = ? AND key_source = ?').get(kid, ks);
  if (!asset) return null;
  if (!asset.save_path || !fs.existsSync(asset.save_path)) {
    _db.prepare('DELETE FROM assets WHERE key_id = ? AND key_source = ?').run(kid, ks);
    return null;
  }
  const hist = _db.prepare('SELECT data FROM history WHERE key_id = ? AND key_source = ?').get(kid, ks);
  if (hist) return JSON.parse(hist.data);
  return { id: kid, source: ks, savePath: asset.save_path, finishedAt: asset.finished_at, status: 'done' };
}

/** 组装查询条件（列过滤走索引，keyword 对 title/artist/album 做小写 LIKE） */
function _where(opts) {
  const parts = [];
  const params = [];
  if (opts.source) { parts.push('key_source = ?'); params.push(String(opts.source)); }
  if (opts.status) { parts.push('status = ?'); params.push(String(opts.status)); }
  if (opts.keyword) {
    const kw = _likePattern(opts.keyword);
    parts.push("(lower(title) LIKE ? ESCAPE '\\' OR lower(artist) LIKE ? ESCAPE '\\' OR lower(album) LIKE ? ESCAPE '\\')");
    params.push(kw, kw, kw);
  }
  return { ws: parts.length ? ` WHERE ${parts.join(' AND ')}` : '', params };
}

/**
 * 查询历史
 * @param {Object} opts - { limit, offset, source, status, keyword, sort }
 */
function query(opts = {}) {
  _ensure();
  const { limit = 50, offset = 0 } = opts;
  const { ws, params } = _where(opts);
  const orderBy = resolveSortOrder(opts.sort);
  const total = _db.prepare(`SELECT count(*) AS c FROM history${ws}`).get(...params).c;
  const rows = _db
    .prepare(`SELECT data FROM history${ws} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, Number(limit) || 50, Number(offset) || 0);
  return { items: rows.map(r => JSON.parse(r.data)), total };
}

/**
 * 统计
 */
function stats() {
  _ensure();
  const { total } = _db.prepare('SELECT count(*) AS total FROM history').get();
  const byStatus = {};
  for (const r of _db.prepare('SELECT status, count(*) AS c, sum(json_extract(data, \'$.size\')) AS s FROM history GROUP BY status').all()) {
    byStatus[r.status] = { count: r.c, size: r.s || 0 };
  }
  const bySource = {};
  for (const r of _db.prepare('SELECT key_source AS source, status, count(*) AS c FROM history GROUP BY key_source, status').all()) {
    if (!bySource[r.source]) bySource[r.source] = {};
    bySource[r.source][r.status] = r.c;
  }
  return {
    total,
    done: (byStatus.done && byStatus.done.count) || 0,
    error: (byStatus.error && byStatus.error.count) || 0,
    totalSize: (byStatus.done && byStatus.done.size) || 0,
    bySource,
  };
}

/**
 * 导入历史（备份恢复用）：合并去重；新条目排在现有历史之后（保持旧实现
 * 「当前记录在前、导入记录垫底」的顺序语义）。
 * @param {Array} entries - 备份文件里的历史数组
 * @returns {number} 实际新增条数
 */
function importEntries(entries) {
  _ensure();
  if (!Array.isArray(entries)) return 0;
  const valid = entries.filter(e => e && typeof e === 'object' && (e.id || e.title));
  let added = 0;
  const minSeq = (_db.prepare('SELECT min(seq) AS m FROM history').get().m) || 1;
  let below = minSeq;
  const sel = _db.prepare('SELECT seq, data FROM history WHERE key_id = ? AND key_source = ?');
  for (const e of valid) {
    const kid = _keyId(e.id);
    const ks = String(e.source ?? '');
    const existing = sel.get(kid, ks);
    if (existing) {
      const merged = { ...JSON.parse(existing.data), ...e };
      const row = _rowOf(merged);
      _db.prepare('UPDATE history SET title=?, artist=?, album=?, status=?, save_path=?, finished_at=?, data=? WHERE seq=?')
        .run(row[2], row[3], row[4], row[5], row[6], row[7], row[8], existing.seq);
      _syncAsset(_db, kid, ks, merged);
    } else {
      below -= 1;
      const row = _rowOf(e);
      _db.prepare(`
        INSERT INTO history(key_id, key_source, title, artist, album, status, save_path, finished_at, seq, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], below, row[8]);
      _syncAsset(_db, kid, ks, e);
      _count += 1;
      added += 1;
    }
  }
  _trim();
  return added;
}

/** WAL 落盘检查点（SQLite 每条写已即时提交，此处仅收敛 -wal 文件；退出时调用） */
function flush() {
  if (!_db) return;
  try { _db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { logger.warn('[history] checkpoint 失败:', e.message); }
}

/** 清空历史与去重索引 */
function clear() {
  _ensure();
  _db.exec('DELETE FROM history');
  _db.exec('DELETE FROM assets');
  _count = 0;
}

/**
 * 按 {id, source} 删除历史展示记录（不动磁盘文件）。
 * 刻意保留 assets 去重索引：徽标语义是「文件还在」而非「有历史记录」，
 * findDownloaded 对已删文件自愈回收，删记录不应把仍存在的文件的下载状态抹掉。
 * @param {Array<{id:string|number, source:string}>} entries
 * @returns {number} 实际删除的历史行数
 */
function remove(entries) {
  _ensure();
  if (!Array.isArray(entries) || !entries.length) return 0;
  const del = _db.prepare('DELETE FROM history WHERE key_id = ? AND key_source = ?');
  let removed = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const kid = _keyId(e.id);
    if (!kid) continue;
    removed += del.run(kid, String(e.source ?? '')).changes;
  }
  _count = Math.max(0, _count - removed);
  return removed;
}

/**
 * 磁盘文件改名/移动后把路径引用回写。
 *
 * 必须连 assets 一起修：findDownloaded 见到 save_path 指向的文件不在就顺手删掉
 * 那行索引，于是「✔ 已下载」徽标消失、同一首歌下次会被重新下一遍。历史行本身
 * 还在（_trim 只淘汰展示行），所以这里既补 save_path/data，也重建去重索引。
 *
 * 匹配用 REPLACE(save_path, '\', '/') 而不是等值比较：同一条记录可能由
 * path.join（反斜杠）或渲染层字符串（正斜杠）写入，判等太严会漏掉一半。
 * @returns {number} 改写的历史行数（未命中为 0）
 */
function relinkPath(oldPath, newPath) {
  _ensure();
  const like = typeof oldPath === 'string' ? oldPath.trim().replace(/\\/g, '/') : '';
  if (!like || typeof newPath !== 'string' || !newPath.trim()) return 0;
  const nocase = process.platform === 'win32' ? ' COLLATE NOCASE' : '';
  const param = process.platform === 'win32' ? like.toLowerCase() : like;

  const rows = _db.prepare(
    `SELECT seq, key_id, key_source, data FROM history WHERE REPLACE(save_path, '\\', '/') = ?${nocase}`,
  ).all(param);
  const upd = _db.prepare('UPDATE history SET save_path=?, data=? WHERE seq=?');
  let changed = 0;
  for (const r of rows) {
    let entry = null;
    try { entry = JSON.parse(r.data); } catch (_e) { /* 坏 data：只改列，保住徽标 */ }
    if (entry) {
      for (const f of ['savePath', 'filePath']) {
        if (pathsEqual(entry[f], oldPath)) entry[f] = newPath;
      }
    }
    upd.run(newPath, entry ? JSON.stringify(entry) : r.data, r.seq);
    if (entry) _syncAsset(_db, r.key_id, r.key_source, entry);
    changed += 1;
  }
  // 展示行已被 _trim 淘汰、只剩去重索引的孤儿：单独扫一遍 assets
  _db.prepare(`UPDATE assets SET save_path=? WHERE REPLACE(save_path, '\\', '/') = ?${nocase}`)
    .run(newPath, param);
  return changed;
}

/**
 * 列出「已完成」下载记录的路径引用（874fcfb 的对外改名对账用）。
 *
 * 只取 history 表里 status='done' 且有 save_path 的行：失败/进行中的记录本来就没有
 * 「✔ 已下载」徽标可修，把它们也拿去指认只会把不存在的文件认成"已经下好了"。
 * 被 _trim 淘汰、只剩 assets 索引孤儿的记录不在这里 —— 它们没有 title/artist 可比，
 * 本来也无法唯一指认。
 * @returns {Array<{id:string,source:string,title:string,artist:string,savePath:string}>}
 */
function donePathRefs() {
  _ensure();
  const rows = _db.prepare(
    "SELECT key_id, key_source, title, artist, save_path FROM history WHERE status = 'done' AND save_path <> ''",
  ).all();
  return rows.map(r => ({
    id: r.key_id, source: r.key_source, title: r.title, artist: r.artist, savePath: r.save_path,
  }));
}

function destroy() {
  if (_db) {
    try { _db.close(); } catch (_e) { /* 已关闭 */ }
    _db = null;
  }
  _userDataPath = null;
  _count = 0;
}

module.exports = {
  init, add, query, stats, flush, clear, remove, destroy, importEntries, findDownloaded,
  relinkPath, donePathRefs,
  MAX_ENTRIES,
};
