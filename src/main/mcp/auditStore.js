/**
 * MCP 调用审计存储（滚动 JSON 文件）
 *
 * 为什么要有这份审计：MCP 服务把「搜索 / 加入下载队列 / 改歌单 / 收藏」开给了
 * 本机任意一个拿到令牌的进程。没有审计时，用户只能在事后发现磁盘上多了 200 首
 * 下载，却查不到是谁干的 —— 「一等公民」不只是能连上要容易，还得能回答「它做了什么」。
 *
 * 三条纪律（都有对应测试）：
 *   1. 敏感值不落盘。参数名命中 SENSITIVE_ARG_RE 的一律只记键名，值丢弃：审计文件
 *      是不加密的普通 JSON，而工具面参数里可能出现 key/cookie/token。
 *   2. 容量封顶。桌面进程不能因一个坏客户端把磁盘写满 —— 与生成历史同口径
 *      （这里 200 条，一次调用约 200 B，最坏 40 KB）。
 *   3. 读-改-写串行 + tmp/rename 原子写。并发调用整文件覆盖会丢条目
 *      （`src/api/ai-music.js` 的生成历史踩过同一个坑，那里的 promise 链是同一个解法）。
 *
 * 损坏文件按空处理而不是抛：这是可观测性数据，读不出来时「什么都不显示」比
 * 「设置页整个打不开」更可接受；下一次成功写入会覆盖掉坏文件。
 */

'use strict';

const fs = require('fs');
const fsp = require('fs/promises');

const AUDIT_FILE_NAME = 'mcp-audit.json';
// 判据作用在「拆过段的键名」上，不直接测原始驼峰串：直接测原始串会把 keyword
// 当成敏感参数（它含 "key"），于是几乎每次搜索的摘要都是空的 —— 审计等于没记。
const SENSITIVE_ARG_RE = /(^|[-_\s])(key|token|cookie|password|secret|authorization|auth|session|credential)($|[-_\s])/i;
const SUMMARY_MAX = 60;

/** aiMusicApiKey / access_token → ['ai','music','api','key'] / ['access','token'] */
function _keySegments(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(s => s.toLowerCase());
}

/** 键名任一段命中敏感词即视为敏感参数 */
function isSensitiveArg(key) {
  return _keySegments(key).some(seg => SENSITIVE_ARG_RE.test(` ${seg} `));
}

/** 具名参数 → 可安全落盘的摘要（键名全留，值只取第一个非敏感字符串） */
function summarizeArgs(namedArgs) {
  const obj = (namedArgs && typeof namedArgs === 'object' && !Array.isArray(namedArgs)) ? namedArgs : {};
  const argsKeys = Object.keys(obj);
  let summary = '';
  for (const k of argsKeys) {
    if (isSensitiveArg(k)) continue;
    const v = obj[k];
    if (typeof v === 'string' && v) { summary = v.slice(0, SUMMARY_MAX); break; }
  }
  return { argsKeys, summary };
}

function createAuditStore({ filePath, maxEntries = 200 }) {
  let chain = Promise.resolve();

  async function _readRaw() {
    try {
      if (!fs.existsSync(filePath)) return [];
      const data = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch (_e) {
      return [];
    }
  }

  async function _writeRaw(list) {
    const tmp = `${filePath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
    await fsp.rename(tmp, filePath);
  }

  function _enqueue(run) {
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  async function record(entry) {
    return _enqueue(async () => {
      const list = await _readRaw();
      list.unshift(entry);
      if (list.length > maxEntries) list.length = maxEntries;
      await _writeRaw(list);
    });
  }

  async function list({ limit } = {}) {
    const all = await _readRaw();
    const n = Number(limit);
    return Number.isFinite(n) && n > 0 ? all.slice(0, n) : all.slice();
  }

  async function clear() { return _enqueue(async () => { await _writeRaw([]); }); }

  async function size() { return (await _readRaw()).length; }

  return { record, list, clear, size, maxEntries };
}

module.exports = { createAuditStore, summarizeArgs, isSensitiveArg, SENSITIVE_ARG_RE, AUDIT_FILE_NAME };
