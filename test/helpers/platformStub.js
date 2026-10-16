/**
 * 平台插件测试辅助工具
 *
 * 提供：
 *   - createPlatformStub()    创建桩平台（可注入自定义实现）
 *   - mockRequest()           mock request 模块
 *   - mockCookieStore()       mock cookie 存储
 *   - loadPlatformPlugin()    加载单个平台插件（隔离环境）
 */

const path = require('path');

// ── 桩平台构造器 ─────────────────────────────────────────

/**
 * 创建一个最小化的桩平台
 * @param {Object} overrides - 覆盖默认实现
 * @returns {Object} 桩平台对象
 */
function createPlatformStub(overrides = {}) {
  return {
    id: 'test-platform',
    name: 'Test Platform',
    hosts: { origins: ['example.com'] },
    search: async () => ({ songs: [], total: 0 }),
    getUrl: async () => ({ url: 'https://example.com/test.mp3' }),
    getLyrics: async () => ({ lrc: '' }),
    verifyCookie: async () => ({ valid: false, reason: '桩平台不支持验证' }),
    _caps: {},
    ...overrides,
  };
}

/**
 * 创建一组桩平台（用于 gateway 测试）
 * @param {Object} defs - { platformId: overrides }
 * @returns {Object} { id → platform }
 */
function createPlatformStubs(defs = {}) {
  const stubs = {};
  for (const [id, overrides] of Object.entries(defs)) {
    stubs[id] = createPlatformStub({ id, ...overrides });
  }
  return stubs;
}

// ── Mock 工具 ────────────────────────────────────────────

/**
 * mock request 模块
 * @param {Object} impl - (url, options) => Promise<body>
 * @returns {() => void} 恢复函数
 */
function mockRequest(impl) {
  const requestPath = require.resolve('../../src/api/request');
  const original = require.cache[requestPath];

  require.cache[requestPath] = {
    id: requestPath,
    filename: requestPath,
    loaded: true,
    exports: impl,
  };

  return () => {
    if (original) {
      require.cache[requestPath] = original;
    } else {
      delete require.cache[requestPath];
    }
  };
}

/**
 * mock cookie store 模块
 * @param {Object} cookies - { platformId: cookieString }
 * @returns {() => void} 恢复函数
 */
function mockCookieStore(cookies = {}) {
  const cookiePath = require.resolve('../../src/utils/cookieStore');
  const original = require.cache[cookiePath];

  require.cache[cookiePath] = {
    id: cookiePath,
    filename: cookiePath,
    loaded: true,
    exports: {
      getCookie: (platformId) => cookies[platformId] || '',
      setCookie: (platformId, val) => { cookies[platformId] = val; },
      clearCookie: (platformId) => { delete cookies[platformId]; },
      getAllCookies: () => ({ ...cookies }),
    },
  };

  return () => {
    if (original) {
      require.cache[cookiePath] = original;
    } else {
      delete require.cache[cookiePath];
    }
  };
}

// ── 平台加载器 ──────────────────────────────────────────

/**
 * 加载单个平台插件（不触发 pluginRegistry 自动发现）
 * @param {string} platformId - 平台 ID
 * @returns {Object} 平台插件模块
 */
function loadPlatformPlugin(platformId) {
  const pluginPath = path.join(__dirname, '..', '..', 'src', 'api', 'platforms', `${platformId}.js`);
  delete require.cache[require.resolve(pluginPath)];
  return require(pluginPath);
}

/**
 * 批量加载所有平台插件
 * @returns {Object} { platformId: plugin }
 */
function loadAllPlatformPlugins() {
  const ids = ['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda'];
  const plugins = {};
  for (const id of ids) {
    plugins[id] = loadPlatformPlugin(id);
  }
  return plugins;
}

// ── 断言辅助 ────────────────────────────────────────────

/**
 * 断言平台对象符合 manifest 契约
 * @param {Object} plugin - 平台插件
 * @param {string} [source] - 出错时用于定位
 */
function assertValidManifest(plugin, source) {
  const where = source || (plugin && plugin.id) || '未知平台';

  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`[${where}]: 平台模块必须导出一个对象`);
  }
  for (const field of ['id', 'name']) {
    if (typeof plugin[field] !== 'string' || !plugin[field].trim()) {
      throw new Error(`[${where}]: manifest 缺少 ${field}`);
    }
  }
  for (const field of ['search', 'getUrl']) {
    if (typeof plugin[field] !== 'function') {
      throw new Error(`[${where}]: 缺少必需实现方法 ${field}()`);
    }
  }
  if (!plugin.hosts || !Array.isArray(plugin.hosts.origins)) {
    throw new Error(`[${where}]: 缺少 hosts.origins（CORS 白名单由此派生）`);
  }
}

module.exports = {
  createPlatformStub,
  createPlatformStubs,
  mockRequest,
  mockCookieStore,
  loadPlatformPlugin,
  loadAllPlatformPlugins,
  assertValidManifest,
};
