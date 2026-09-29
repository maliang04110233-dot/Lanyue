/**
 * 揽乐 渲染端日志工具
 * 生产环境下 console.warn/error 保留，console.log 静默
 * 
 * ES Module — export 供其他模块 import，同时保留 window 全局
 */

const _isDev = window.location.hostname === 'localhost' || window.location.protocol === 'file:';

const logger = {
  /** 开发环境输出，生产环境静默 */
  log: (...args) => { if (_isDev) console.log('[揽乐]', ...args); },
  /** 始终输出（生产环境也保留） */
  warn: (...args) => console.warn('[揽乐]', ...args),
  /** 始终输出 + 堆栈 */
  error: (...args) => console.error('[揽乐]', ...args),
  /** 开发环境调试信息 */
  debug: (...args) => { if (_isDev) console.debug('[揽乐][debug]', ...args); },
};

window.logger = logger;
export { logger };
