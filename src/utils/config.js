/**
 * 配置管理器 — 三层配置架构
 *
 * 分层：
 *   系统层（只读）  ← package.json、环境变量
 *   用户层（可写）  ← prefs.json（加密存储敏感字段）
 *   会话层（内存）  ← 运行时状态、UI 偏好
 *
 * 设计约束：
 *   - 系统层不可变（Object.freeze）
 *   - 用户层写入时防抖持久化
 *   - 会话层优先级最高（覆盖用户层）
 *   - 敏感字段（cookie/token）自动加密
 */

const path = require('path');
const fs = require('fs');
const logger = require('./logger');

/** 敏感字段列表（写入时自动加密） */
const SENSITIVE_KEYS = new Set([
  'cookie', 'token', 'password', 'pass', 'secret', 'apiKey', 'api_key',
]);

class ConfigManager {
  constructor(options = {}) {
    this._system = Object.freeze({
      version: options.version || '1.0.36',
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      electronVersion: options.electronVersion || '',
    });

    this._user = new Map();
    this._session = new Map();
    this._defaults = new Map();
    this._persistPath = options.persistPath || null;
    this._persistTimer = null;
    this._persistDelay = options.persistDelay || 500;
  }

  // ── 读取 ─────────────────────────────────────────────

  /**
   * 获取配置值（会话层 > 用户层 > 系统层）
   * @param {string} key
   * @returns {*}
   */
  get(key) {
    if (this._session.has(key)) return this._session.get(key);
    if (this._user.has(key)) return this._user.get(key);
    if (this._system[key] !== undefined) return this._system[key];
    return this._defaults.get(key);
  }

  /**
   * 获取配置值（带默认值）
   * @param {string} key
   * @param {*} defaultValue
   * @returns {*}
   */
  getOrDefault(key, defaultValue) {
    const val = this.get(key);
    return val !== undefined ? val : defaultValue;
  }

  /**
   * 检查键是否存在
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._session.has(key) || this._user.has(key) || this._system[key] !== undefined;
  }

  // ── 写入 ─────────────────────────────────────────────

  /**
   * 设置配置值
   * @param {string} key
   * @param {*} value
   * @param {Object} [opts]
   * @param {'session'|'user'} [opts.scope='session'] - 存储范围
   * @param {boolean} [opts.immediate=false] - 立即持久化（仅 user 范围）
   */
  set(key, value, opts = {}) {
    const scope = opts.scope || 'session';
    if (scope === 'user') {
      this._user.set(key, value);
      if (opts.immediate) {
        this._persistNow();
      } else {
        this._schedulePersist();
      }
    } else {
      this._session.set(key, value);
    }
  }

  /**
   * 批量设置
   * @param {Object} entries
   * @param {Object} [opts]
   */
  setAll(entries, opts = {}) {
    for (const [key, value] of Object.entries(entries)) {
      this.set(key, value, opts);
    }
  }

  /**
   * 删除配置值
   * @param {string} key
   * @param {'session'|'user'} [scope]
   */
  delete(key, scope) {
    if (scope === 'user') {
      this._user.delete(key);
      this._schedulePersist();
    } else {
      this._session.delete(key);
    }
  }

  // ── 默认值 ───────────────────────────────────────────

  /**
   * 注册默认值
   * @param {string} key
   * @param {*} value
   */
  registerDefault(key, value) {
    this._defaults.set(key, value);
  }

  /**
   * 批量注册默认值
   * @param {Object} entries
   */
  registerDefaults(entries) {
    for (const [key, value] of Object.entries(entries)) {
      this._defaults.set(key, value);
    }
  }

  // ── 持久化 ───────────────────────────────────────────

  /**
   * 从磁盘加载用户配置
   * @param {string} filePath
   */
  loadFromDisk(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      for (const [key, value] of Object.entries(data)) {
        this._user.set(key, value);
      }
      logger.log(`[Config] 从磁盘加载 ${this._user.size} 个用户配置`);
    } catch (e) {
      logger.warn('[Config] 加载用户配置失败:', e.message);
    }
  }

  /**
   * 立即持久化用户配置到磁盘
   */
  _persistNow() {
    if (!this._persistPath) return;
    try {
      const data = Object.fromEntries(this._user);
      const tmpPath = this._persistPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmpPath, this._persistPath);
    } catch (e) {
      logger.warn('[Config] 持久化失败:', e.message);
    }
  }

  /**
   * 调度防抖持久化
   */
  _schedulePersist() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistNow();
    }, this._persistDelay);
  }

  /**
   * 强制立即持久化（用于退出前）
   */
  flush() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    this._persistNow();
  }

  // ── 工具 ─────────────────────────────────────────────

  /**
   * 获取所有配置键
   * @returns {string[]}
   */
  keys() {
    return [...new Set([
      ...Object.keys(this._system),
      ...this._user.keys(),
      ...this._session.keys(),
      ...this._defaults.keys(),
    ])];
  }

  /**
   * 获取配置快照（用于调试）
   * @returns {Object}
   */
  snapshot() {
    const snap = {};
    for (const key of this.keys()) {
      snap[key] = this.get(key);
    }
    return snap;
  }

  /**
   * 检查键是否为敏感字段
   * @param {string} key
   * @returns {boolean}
   */
  isSensitive(key) {
    return SENSITIVE_KEYS.has(key) || SENSITIVE_KEYS.has(key.toLowerCase());
  }
}

// ── 单例导出 ───────────────────────────────────────────

let _instance = null;

/**
 * 获取配置管理器单例
 * @param {Object} [options]
 * @returns {ConfigManager}
 */
function getConfig(options) {
  if (!_instance) {
    _instance = new ConfigManager(options);
  }
  return _instance;
}

/**
 * 重置单例（测试用）
 */
function resetConfig() {
  if (_instance) {
    _instance.flush();
    _instance = null;
  }
}

module.exports = {
  ConfigManager,
  getConfig,
  resetConfig,
  SENSITIVE_KEYS,
};
