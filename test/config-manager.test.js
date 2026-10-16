/**
 * 配置管理器测试
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { ConfigManager } = require('../src/utils/config');

// ── 基础读取 ────────────────────────────────────────────

test('get: 系统层值可读取', () => {
  const cm = new ConfigManager({ version: '1.0.36' });
  assert.strictEqual(cm.get('version'), '1.0.36');
  assert.strictEqual(cm.get('platform'), process.platform);
});

test('get: 未设置的键返回 undefined', () => {
  const cm = new ConfigManager();
  assert.strictEqual(cm.get('nonexistent'), undefined);
});

test('getOrDefault: 未设置的键返回默认值', () => {
  const cm = new ConfigManager();
  assert.strictEqual(cm.getOrDefault('nonexistent', 'default'), 'default');
});

test('has: 检查键是否存在', () => {
  const cm = new ConfigManager({ version: '1.0.36' });
  assert.strictEqual(cm.has('version'), true);
  assert.strictEqual(cm.has('nonexistent'), false);
});

// ── 会话层 ─────────────────────────────────────────────

test('set: 会话层值可读取', () => {
  const cm = new ConfigManager();
  cm.set('theme', 'dark');
  assert.strictEqual(cm.get('theme'), 'dark');
});

test('set: 会话层覆盖系统层', () => {
  const cm = new ConfigManager({ version: '1.0.36' });
  cm.set('version', '2.0.0', { scope: 'session' });
  assert.strictEqual(cm.get('version'), '2.0.0');
});

test('delete: 删除会话层值', () => {
  const cm = new ConfigManager();
  cm.set('theme', 'dark');
  cm.delete('theme');
  assert.strictEqual(cm.get('theme'), undefined);
});

// ── 用户层 ─────────────────────────────────────────────

test('set: 用户层值可读取', () => {
  const cm = new ConfigManager();
  cm.set('language', 'zh', { scope: 'user' });
  assert.strictEqual(cm.get('language'), 'zh');
});

test('set: 用户层覆盖系统层', () => {
  const cm = new ConfigManager({ version: '1.0.36' });
  cm.set('version', '2.0.0', { scope: 'user' });
  assert.strictEqual(cm.get('version'), '2.0.0');
});

test('set: 会话层覆盖用户层', () => {
  const cm = new ConfigManager();
  cm.set('theme', 'dark', { scope: 'user' });
  cm.set('theme', 'light', { scope: 'session' });
  assert.strictEqual(cm.get('theme'), 'light');
});

// ── 默认值 ─────────────────────────────────────────────

test('registerDefault: 默认值可读取', () => {
  const cm = new ConfigManager();
  cm.registerDefault('concurrency', 3);
  assert.strictEqual(cm.get('concurrency'), 3);
});

test('registerDefault: 用户层覆盖默认值', () => {
  const cm = new ConfigManager();
  cm.registerDefault('concurrency', 3);
  cm.set('concurrency', 5, { scope: 'user' });
  assert.strictEqual(cm.get('concurrency'), 5);
});

test('registerDefaults: 批量注册默认值', () => {
  const cm = new ConfigManager();
  cm.registerDefaults({ a: 1, b: 2, c: 3 });
  assert.strictEqual(cm.get('a'), 1);
  assert.strictEqual(cm.get('b'), 2);
  assert.strictEqual(cm.get('c'), 3);
});

// ── 持久化 ─────────────────────────────────────────────

test('loadFromDisk: 从磁盘加载用户配置', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  const configPath = path.join(tmpDir, 'prefs.json');
  fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark', language: 'zh' }));

  const cm = new ConfigManager();
  cm.loadFromDisk(configPath);
  assert.strictEqual(cm.get('theme'), 'dark');
  assert.strictEqual(cm.get('language'), 'zh');

  fs.unlinkSync(configPath);
  fs.rmdirSync(tmpDir);
});

test('persist: 用户配置持久化到磁盘', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  const configPath = path.join(tmpDir, 'prefs.json');

  const cm = new ConfigManager({ persistPath: configPath });
  cm.set('theme', 'dark', { scope: 'user', immediate: true });

  const content = fs.readFileSync(configPath, 'utf8');
  const data = JSON.parse(content);
  assert.strictEqual(data.theme, 'dark');

  fs.unlinkSync(configPath);
  fs.rmdirSync(tmpDir);
});

test('flush: 强制立即持久化', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  const configPath = path.join(tmpDir, 'prefs.json');

  const cm = new ConfigManager({ persistPath: configPath });
  cm.set('theme', 'dark', { scope: 'user' });
  cm.flush();

  const content = fs.readFileSync(configPath, 'utf8');
  const data = JSON.parse(content);
  assert.strictEqual(data.theme, 'dark');

  fs.unlinkSync(configPath);
  fs.rmdirSync(tmpDir);
});

// ── 工具方法 ───────────────────────────────────────────

test('keys: 返回所有配置键', () => {
  const cm = new ConfigManager({ version: '1.0.36' });
  cm.set('theme', 'dark');
  cm.registerDefault('concurrency', 3);
  const keys = cm.keys();
  assert.ok(keys.includes('version'));
  assert.ok(keys.includes('theme'));
  assert.ok(keys.includes('concurrency'));
});

test('snapshot: 返回配置快照', () => {
  const cm = new ConfigManager({ version: '1.0.36' });
  cm.set('theme', 'dark');
  const snap = cm.snapshot();
  assert.strictEqual(snap.version, '1.0.36');
  assert.strictEqual(snap.theme, 'dark');
});

test('isSensitive: 敏感字段检测', () => {
  const cm = new ConfigManager();
  assert.strictEqual(cm.isSensitive('cookie'), true);
  assert.strictEqual(cm.isSensitive('token'), true);
  assert.strictEqual(cm.isSensitive('password'), true);
  assert.strictEqual(cm.isSensitive('theme'), false);
});

// ── 批量操作 ───────────────────────────────────────────

test('setAll: 批量设置', () => {
  const cm = new ConfigManager();
  cm.setAll({ a: 1, b: 2, c: 3 });
  assert.strictEqual(cm.get('a'), 1);
  assert.strictEqual(cm.get('b'), 2);
  assert.strictEqual(cm.get('c'), 3);
});

test('setAll: 批量设置用户层', () => {
  const cm = new ConfigManager();
  cm.setAll({ a: 1, b: 2 }, { scope: 'user' });
  assert.strictEqual(cm.get('a'), 1);
  assert.strictEqual(cm.get('b'), 2);
});
