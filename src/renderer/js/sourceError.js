/**
 * 音源失败原因 → 用户可见文案 的集中映射。
 *
 * 背景：不同平台在取直链那一步会抛不同的结构化错误码（见 src/shared/errors.js），
 * 其中「汽水」的失败大多是平台会员/试听限制，而「酷狗/酷我」多为 CDN 空或版权限制。
 * 过去所有平台都只落到一条笼统的 toast.noSource，用户看不出「为什么不播」。
 * 本模块把错误码 + 平台归一成具体、可解释的提示，供五处取流播放入口共用
 * （player.js / views/search.js / views/home.js / views/playlist/playback.js / app.js 的播放弹层；
 * 本地库那条不取流，不在内）。
 *
 * ⚠️ sidecar 家法：渲染层**不能** import src/shared（见 netRecovery.js 的判据之家注释），
 * 所以这里的错误码是一份字面量清单，由 test/source-error.test.js 钉着与
 * src/shared/errors.js 的 ERROR_CODES 取值一致。
 *
 * ⚠️ failure-tag 家法：鉴权码清单只许出现在 diagnose.js 一处（登录失效码与
 * 需登录码同时出现即判违规）。所以本文件**不写**登录失效类码（鉴权过期 / Cookie 无效）
 * 字面量，改用 diagnose.js 的 isAuthFailure() 兜底判定；只有「需登录」单独
 * 出现（不构成违规），用于给出更精确的「需要登录」提示。
 *
 * 注意：这是纯文案/展示逻辑，不改变跨源策略（crossSourceEnabled 仍为产品开关）。
 */

import { isAuthFailure } from './diagnose.js';

// ── 错误码字面量（与 src/shared/errors.js 取值一致，别手改）─────────────────
const VIP_REQUIRED = 'VIP_REQUIRED';
const LOGIN_REQUIRED = 'LOGIN_REQUIRED';
const COPYRIGHT_RESTRICTED = 'COPYRIGHT_RESTRICTED';
const UNAVAILABLE = 'UNAVAILABLE';
const NO_AUDIO_STREAM = 'NO_AUDIO_STREAM';
const CDN_EMPTY = 'CDN_EMPTY';

/**
 * 判断某个结果对象是否是「播放入口返回的结构化失败」。
 * 兼容两种形态：
 *   - { code: 'VIP_REQUIRED' }                          → 播放层
 *   - { ok: false, error: { code: 'NO_AUDIO_STREAM' } } → 服务层
 */
function _extractCode(result) {
  if (!result || typeof result !== 'object') return null;
  if (typeof result.code === 'string') return result.code;
  if (result.error && typeof result.error === 'object' && typeof result.error.code === 'string') {
    return result.error.code;
  }
  return null;
}

/**
 * 归一平台名，用于判定是否需要汽水专属文案。
 * 允许传入 { source, platform }、纯字符串，或直接传 source 字段。
 */
function _isSoda(source) {
  if (!source) return false;
  if (typeof source === 'string') {
    return source === 'soda' || source.toLowerCase() === '汽水';
  }
  const name = source.source || source.platform || source.name || '';
  return typeof name === 'string' && (name === 'soda' || name.toLowerCase() === '汽水');
}

/**
 * 返回该失败对应的 i18n 键名；没有可识别错误码时返回 null（调用方回落 toast.noSource）。
 * @param {object} result - 播放/加载失败结果（含 code 或 error.code）
 * @param {object|string} source - 当前平台（用于汽水专属文案）
 */
function sourceErrorKey(result, source) {
  const code = _extractCode(result);
  if (!code) return null;

  // 汽水专属（会员/试听限制高发）
  if (code === VIP_REQUIRED && _isSoda(source)) return 'toast.srcVipSoda';
  if (code === NO_AUDIO_STREAM && _isSoda(source)) return 'toast.srcOnlySoda';

  switch (code) {
    case VIP_REQUIRED:
      return 'toast.vipRequired';
    case NO_AUDIO_STREAM:
      return 'toast.srcNoStream';
    case CDN_EMPTY:
      return 'toast.srcCdnEmpty';
    case UNAVAILABLE:
      return 'toast.srcUnavailable';
    case COPYRIGHT_RESTRICTED:
      return 'toast.srcCopyright';
    case LOGIN_REQUIRED:
      return 'toast.srcLogin';
  }

  // 剩余鉴权码（登录失效/无效 Cookie 两码）：字面量不进本文件
  //（failure-tag.test 家法：鉴权码清单只许在 diagnose.js 一处），
  // 用 isAuthFailure() 兜底判定，统一提示「登录状态已过期」。
  if (isAuthFailure(code)) return 'toast.srcCookie';

  return null;
}

/** 便捷函数：拿 t() 后直接返回已翻译的文案；未命中时回落到 fallbackKey。 */
function sourceErrorText(t, result, source, fallbackKey) {
  const key = sourceErrorKey(result, source);
  if (!key) return fallbackKey ? t(fallbackKey) : null;
  return t(key);
}

/**
 * 已知「本源命中率偏低」的平台 id。
 *
 * 这不是逐个探测歌曲（那需要为每首歌都发一次分享页/直链请求，几十条并发既慢又易被风控），
 * 而是基于平台本身的版权/会员策略：这些平台的免费曲库覆盖不全，搜索命中后点播放
 * 大概率碰到 VIP 或下架。UI 据此在行尾挂一个「音源可能不全」的轻提示，提醒用户
 * 别抱太高预期；具体失败原因仍由 sourceErrorText 在播放那一刻给出。
 *
 * 若将来跨源开关（fallbackPolicy.crossSourceEnabled）打开，这套标记会自动失效，
 * 因为换源兜底会消化掉大部分失败 —— 到时把这个数组清空即可。
 */
const LOW_YIELD_PLATFORMS = new Set(['soda', 'kugou', 'kuwo']);

/** 是否属于已知低命中平台（用户可在列表上看到「音源可能不全」提示） */
function isLowYield(source) {
  if (!source) return false;
  const id = typeof source === 'string' ? source : (source.id || source.source || source.platform || '');
  return typeof id === 'string' && LOW_YIELD_PLATFORMS.has(id);
}

/** 本模块以字面量识别的错误码清单（sidecar，供测试核对取值合法） */
const SOURCE_ERROR_CODES = [
  VIP_REQUIRED,
  LOGIN_REQUIRED,
  COPYRIGHT_RESTRICTED,
  UNAVAILABLE,
  NO_AUDIO_STREAM,
  CDN_EMPTY,
];

/**
 * 声明这些 toast.* 键确实由本模块消费。
 *
 * 运行时 sourceErrorText 通过 t(key) 触达它们，但 test/toast-i18n 的孤儿扫描只认
 * `t('字面量')` 模式，认不出变量实参，于是把这些键误判成"没人按键读"。
 * 这里显式列一次，让扫描器能看见消费方；函数体从不执行（无调用方）。
 * 新增错误码映射时记得同步这里，否则孤儿测试会红。
 */
// eslint-disable-next-line no-unused-vars
function _declareToastKeys(t) {
  return [
    t('toast.vipRequired'),
    t('toast.noSource'),
    t('toast.srcNoStream'),
    t('toast.srcCdnEmpty'),
    t('toast.srcUnavailable'),
    t('toast.srcCopyright'),
    t('toast.srcLogin'),
    t('toast.srcCookie'),
    t('toast.srcVipSoda'),
    t('toast.srcOnlySoda'),
  ];
}

export { sourceErrorKey, sourceErrorText, LOW_YIELD_PLATFORMS, isLowYield, SOURCE_ERROR_CODES };