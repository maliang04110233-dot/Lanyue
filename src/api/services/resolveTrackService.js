/**
 * 取流解析服务（ResolveTrackService）
 *
 * 架构定位（见 docs/REFACTOR_PLAN_2026-09-17.md 阶段 1 / Sprint B）：
 *   本服务回答一个业务问题：**「给定一首歌，怎么拿到能播/能下的 URL」**。
 *   它是「换源机制」的唯一实现处 —— 在此之前，这段策略混在 api/index.js 里，
 *   与搜索、歌词、链接识别等无关逻辑挤在同一个文件，且难以单测
 *   （依赖真实的 gateway / 匹配器 / 健康度三个模块的模块级单例）。
 *
 * 职责边界（明确划清，避免又变成一个万能类）：
 *   ✅ 负责：本源取流 → 判定是否值得换源 → 跨源找候选 → 逐个尝试 → 记账健康度
 *   ❌ 不负责：下载落盘、队列管理、ID3、进度推送（属 main/ 下载链路）
 *   ❌ 不负责：搜索接口本身（通过注入的 searchFn 调用，本服务不管平台协议）
 *   ❌ 不负责：候选怎么匹配（通过注入的 findCandidates 调用 matchMusic 纯逻辑）
 *
 * 依赖注入（四个依赖全部显式传入，无处藏单例）：
 *   - getUrl(id, source, quality)      取单曲直链（生产实现 = gateway.getUrl）
 *   - searchFn(platformId, keyword)    跨源搜索（生产实现 = gateway.search 适配）
 *   - hasCookie(platformId)            是否已配置该平台 Cookie（影响付费候选排序）
 *   - findCandidates(deps, song)       跨源同曲候选匹配（生产实现 = matchMusic）
 *   - sourceHealth                     { recordResult, rankByHealth }（可注入桩）
 *   - probeUrl(url, result)            候选直链可播性预检（生产实现 = request.testAudioLink）。
 *       可选；只作用于换源候选（happy path 零新增延迟），判定见 isDecisivelyDeadProbe。
 *
 * 为什么用注入而不是直接 require：
 *   1. 可测 —— 单测用桩就能覆盖「本源失败→换源成功／全失败／记忆命中」全部分支，
 *      不触网、不加载 8 个平台；
 *   2. 无环 —— 本模块不 require gateway / matchMusic，避免再造一处循环依赖；
 *   3. 可换 —— 将来取流策略变化（如加缓存层）只需换注入实现。
 */

const logger = require('../../utils/logger');
const { ERROR_CODES } = require('../../shared/errors');
const { normalizeSong, normalizeTrackResult, isTrackSuccess } = require('../../shared/dto');
const { shouldFallbackByCode, FALLBACK_CODES } = require('./fallbackCodes');
const { normalizeDisabledPlatforms, filterDisabledCandidates } = require('./fallbackPolicy');

/** CDN 签名过期类 HTTP 错误：无 code 但也值得换源（直链临时失效，换源常能拿到新链） */
const FALLBACK_HTTP_RE = /HTTP\s*(403|404|410)/i;

/**
 * 判定一次失败的取流结果是否值得跨源重试。
 *
 * 抽成导出的纯函数是刻意的：这是换源机制的**核心决策**，
 * 也是历史上最容易改错的地方（多换一次白费请求 / 少换一次用户听不了）。
 * 让它可被单独断言，比埋在长函数里安全。
 *
 * @param {import('../../shared/dto').TrackResult} result
 * @returns {boolean}
 */
function shouldFallbackToOtherSource(result) {
  if (isTrackSuccess(result)) return false;
  // 优先使用新模块的判定（白名单集中管理）
  if (shouldFallbackByCode(result && result.code)) return true;
  // 无 code 的失败（如 HTTP 403/404/410 CDN 签名过期）也换源重试
  if (result && FALLBACK_HTTP_RE.test(String(result.error || ''))) return true;
  // 未知数据源（B 站 id 传错等）不换——歌本身可能不存在
  return false;
}

/**
 * 探测结果是否构成**决定性死链证据**。
 *
 * 宁可漏判不可误杀：只有两类证据值得否决一条候选链 ——
 *   1. reason=not-audio：200 但返回 text/*（酷我 antiserver 的 "refuse request!" 形态），
 *      这条 URL 永远不会是音频；
 *   2. HTTP 404/410：资源明确不存在/已移除，重试同一 URL 无意义。
 * 其余失败（timeout、连接错误、5xx，甚至 403）都是**不定证据** ——
 * 可能只是探测请求缺了正确 Referer 或 CDN 抖动，播放器/下载器自己请求时
 * 未必失败，故一律保守接受（返回 false），由后续消费方的失败路径兜底。
 *
 * @param {{ok?:boolean, status?:number|null, reason?:string}} probe testAudioLink 形状
 * @returns {boolean}
 */
function isDecisivelyDeadProbe(probe) {
  if (!probe || typeof probe !== 'object' || probe.ok !== false) return false;
  if (probe.reason === 'not-audio') return true;
  return probe.status === 404 || probe.status === 410;
}

/**
 * 试听片段判定阈值：实测长度不足声明时长的**一半**才算片段。
 *
 * 刻意宽松（而不是 0.9 之类贴近的值）：无损/变码率文件的 `br` 常常是档位哨兵
 * （网易云 lossless 请求 br=999000）而非实测平均码率，`size*8/br` 会系统性低估
 * 时长。误杀一条能听的整曲，代价远大于放过一段试听 —— 实测两类片段的比值分别是
 * 0.04（酷我占位片 11s/269s）与 0.30（汽水 60s/199s），离 0.5 都有倍数级余量。
 */
const PREVIEW_MAX_RATIO = 0.5;

/** 判定为片段时对外给出的理由与错误码（NO_AUDIO_STREAM 在换源白名单内） */
const PREVIEW_REJECT = Object.freeze({
  reason: '仅有试听片段（无整曲音源）',
  code: ERROR_CODES.NO_AUDIO_STREAM,
});
/** 探测判死时对外给出的理由与错误码（沿用历史上的 CDN 空响应口径） */
const DEAD_LINK_REJECT = Object.freeze({
  reason: '候选直链预检不可播',
  code: ERROR_CODES.CDN_EMPTY,
});

/**
 * 一次成功的取流结果是否其实只是**试听片段**（非整曲）。
 *
 * 只用结果自带元数据判定，零网络开销 —— 因此可以挂在本源/记忆成功路径上，
 * 不必等换源候选才校验。缺任一证据（声明时长 / 字节数 / 码率）一律放过：
 * 咪咕、5sing 的 duration 恒为 0，酷狗 / QQ / B 站的取流结果不给 size 或 br。
 *
 * @param {{size?:number, sizeBytes?:number, br?:number, bitrate?:number}} result
 * @param {number} durationMs 所请求歌曲的声明时长（毫秒）
 * @returns {boolean}
 */
function isPreviewClip(result, durationMs) {
  if (!result || typeof result !== 'object') return false;
  const declaredSec = Math.floor(Number(durationMs) / 1000);
  if (!Number.isFinite(declaredSec) || declaredSec <= 0) return false;
  const sizeBytes = Number(result.size ?? result.sizeBytes);
  const bitrate = Number(result.br ?? result.bitrate);
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return false;
  if (!Number.isFinite(bitrate) || bitrate <= 0) return false;
  return (sizeBytes * 8) / bitrate < declaredSec * PREVIEW_MAX_RATIO;
}

/**
 * 创建取流解析服务实例。
 *
 * @param {Object} deps
 * @param {(id:string, source:string, quality:string) => Promise<Object>} deps.getUrl
 * @param {(platformId:string, keyword:string, page?:number) => Promise<Array>} deps.searchFn
 * @param {(platformId:string) => boolean} deps.hasCookie
 * @param {(deps:Object, song:Object) => Promise<Array>} deps.findCandidates
 * @param {{recordResult:(s:string,ok:boolean)=>void, rankByHealth:(a:Array)=>Array}} deps.sourceHealth
 * @param {(url:string, result:Object) => Promise<Object>} [deps.probeUrl] 候选直链预检（缺省不探测）
 * @param {() => unknown} [deps.getDisabledPlatforms] 换源禁用平台清单（prefs 原始值，每次解析至多读一次）
 * @param {() => boolean} [deps.fallbackEnabled] 跨源换源总开关（每次解析至多读一次；缺省=开）
 * @returns {Object} 冻结的服务实例
 */
function createResolveTrackService({
  getUrl,
  searchFn,
  hasCookie = () => false,
  findCandidates,
  sourceHealth,
  probeUrl,
  getDisabledPlatforms,
  fallbackEnabled,
} = {}) {
  if (typeof getUrl !== 'function') throw new Error('[ResolveTrack] 必须注入 getUrl');
  if (typeof findCandidates !== 'function') throw new Error('[ResolveTrack] 必须注入 findCandidates');
  if (!sourceHealth || typeof sourceHealth.recordResult !== 'function') {
    throw new Error('[ResolveTrack] 必须注入 sourceHealth.recordResult');
  }

  /** 安全记账：健康度统计失败绝不该影响取流主流程 */
  function record(source, ok) {
    try {
      sourceHealth.recordResult(source, !!ok);
    } catch (_e) { /* 统计不可用不影响取流 */ }
  }

  // 换源禁用平台清单：每次 resolve() 调用至多读一次 prefs（懒解析 + 单次缓存），
  // 本源成功的主流路径零开销；getter 抛错按「无禁用」处理，不阻断取流。
  let _disabledCache = null;
  function disabledPlatforms() {
    if (_disabledCache) return _disabledCache;
    let raw = null;
    try {
      if (typeof getDisabledPlatforms === 'function') raw = getDisabledPlatforms();
    } catch (_e) { /* 偏好不可读按未配置处理 */ }
    _disabledCache = normalizeDisabledPlatforms(raw);
    return _disabledCache;
  }

  // 跨源换源总开关：**服务本身不藏产品决策**，缺省按「开」，
  // 关掉与否由注入方（api/index.js 读 fallbackPolicy.crossSourceEnabled）决定。
  // getter 抛错同样按「开」处理 —— 读盘故障不该让本来能换源听到的歌彻底播不了。
  let _fallbackCache = null;
  function crossSourceOn() {
    if (_fallbackCache !== null) return _fallbackCache;
    let on = true;
    try {
      if (typeof fallbackEnabled === 'function') on = !!fallbackEnabled();
    } catch (_e) { /* 偏好不可读按开启处理 */ }
    _fallbackCache = on;
    return on;
  }

  /**
   * 尝试单个源的取流，并记账健康度。
   * @param {Function} [verify] 成功后的追加校验（async，返回 reject 对象=判死、null=接受）。
   *        判死时记健康度失败并返回失败对象 —— 错误码仅供内部，不外泄
   *        （全候选被否决时 resolve 返回的是本源错误）。
   * @returns {Promise<Object|null>} 成功返回结果，失败返回 null（错误由调用方从 result 取）
   */
  async function trySource(id, source, quality, verify) {
    try {
      const r = await getUrl(id, source, quality);
      if (isTrackSuccess(r) && verify) {
        let reject = null;
        try {
          reject = await verify(r);
        } catch (_e) { /* 探测自身故障按不定证据处理，不阻断换源 */ }
        if (reject) {
          logger.log(`[ResolveTrack] ${source} ${reject.reason}，跳过: ${r.url}`);
          record(source, false);
          return { error: `${source} ${reject.reason}`, code: reject.code };
        }
      }
      record(source, isTrackSuccess(r));
      return r;
    } catch (e) {
      record(source, false);
      // gateway 已做错误收敛，此处仅兜底注入实现直接抛错的情况
      logger.warn(`[ResolveTrack] ${source} 取流异常:`, (e && e.message) || e);
      return { error: (e && e.message) || '取流异常', code: 'INTERNAL_ERROR' };
    }
  }

  /**
   * 解析一首歌的取流地址（换源机制）。
   *
   * 流程（顺序即优先级）：
   *   0. 跨源换源总开关（注入的 fallbackEnabled）关闭 ⇒ 只走步骤 2，1 与 3 一并跳过；
   *   1. `_altSource` 记忆命中 —— 上次换源成功的源先试（lx toggleMusicInfo 模式），
   *      避免每次都在已知失败的源上浪费一次请求；
   *   2. 本源取流；
   *   3. 失败且**值得换源** ⇒ 跨源找同曲候选 → 按健康度重排（好源先试）→ 逐个尝试；
   *   4. 全失败 ⇒ **返回本源原始错误**（保证 UI 文案与「没换源时」一致）。
   *
   * @param {import('../../shared/dto').Song} rawSong
   * @param {string} [quality]
   * @returns {Promise<import('../../shared/dto').TrackResult>}
   */
  async function resolve(rawSong, quality) {
    const song = normalizeSong(rawSong);
    if (!song.id || !song.source) {
      return normalizeTrackResult({ error: '参数无效：缺少歌曲 id/source', code: 'INVALID_ARGS' });
    }
    _disabledCache = null; // 每次解析重读偏好：设置页改完即刻生效，无需重启队列
    _fallbackCache = null; // 同上：换源总开关改动即刻生效

    /**
     * 试听片段校验（纯元数据，零网络）：三条取流路径共用。
     * 参照系是**所请求歌曲**的声明时长 —— 候选自带元数据算出的码率可能自洽
     * （汽水的 br 就是拿片段时长反推的），只有对着原曲时长才露馅。
     */
    async function verifyPreviewClip(r) {
      return isPreviewClip(r, song.duration) ? PREVIEW_REJECT : null;
    }

    // 1. _altSource 记忆：上次换源成功的源先试。
    //    但本源已配置 Cookie 时跳过记忆、优先回试本源 —— 否则用户补了
    //    登录/Cookie 后，队列里带着旧换源记忆的歌（_altSource 随 play-queue
    //    持久化）会永远绕回别家源，本源 VIP 明明已可用却不再被尝试。
    //
    // 三条取流路径（记忆 / 本源 / 候选）一律过 verifyPreviewClip：试听片段判定只用
    // 元数据，零新增请求；记忆路径尤其不能免检 —— 一旦某次换源落在了酷我占位片上，
    // 记忆会让后续每次播放都直接回吐那段 11 秒。
    const alt = rawSong && rawSong._altSource;
    if (crossSourceOn() && alt && alt.source && alt.id && alt.source !== song.source && !hasCookie(song.source)
        && !disabledPlatforms().has(alt.source)) {
      const r = await trySource(String(alt.id), alt.source, quality, verifyPreviewClip);
      if (isTrackSuccess(r)) {
        return normalizeTrackResult({
          ...r, source: alt.source, matchedFrom: song.source, fromAltMemory: true,
        });
      }
      // 记忆失效则继续走正常流程（不返回，不记日志噪声）
    }

    // 2. 本源
    const result = await trySource(song.id, song.source, quality, verifyPreviewClip);
    if (isTrackSuccess(result)) {
      return normalizeTrackResult(result);
    }

    // 3. 失败且可换源 ⇒ 跨源候选逐个尝试
    //    总开关关闭时这一步整体跳过：用户诉求是「播放即本源，本源没有音源就诚实失败」，
    //    宁可少播一首，也不要拿别家平台的版本冒充这首歌。
    if (!crossSourceOn() || !shouldFallbackToOtherSource(result)) {
      return normalizeTrackResult(result);
    }

    let candidates = [];
    try {
      candidates = await findCandidates({
        searchFn: (platformId, keyword) => searchFn(platformId, keyword, 1),
        hasCookie,
      }, song);
    } catch (e) {
      logger.warn('[ResolveTrack] 跨源匹配失败:', (e && e.message) || e);
    }

    // 用户排除清单：先剔除再重排 —— 禁用的源连健康度投票权都没有。
    // 注意只过滤跨源候选，本源取流（步骤 2）永远不受限。
    candidates = filterDisabledCandidates(candidates, disabledPlatforms());

    // 源可用性自动降级：候选按健康度重排（好源先试）。稳定排序保住匹配分序。
    if (Array.isArray(candidates) && candidates.length > 1
        && typeof sourceHealth.rankByHealth === 'function') {
      try {
        candidates = sourceHealth.rankByHealth(candidates);
      } catch (_e) { /* 重排失败则用原序，不影响流程 */ }
    }

    // 候选直链预检（go-music-dl Range 探测思路）：只挂在候选上 ——
    // 本源/_alt 成功路径零新增延迟；换源路径本就在慢通道，多一次 HEAD 划算。
    // 片段判定先于探测：证据已在结果里，不必花一次网络请求。
    const verifyCandidate = probeUrl
      ? async (r) => (await verifyPreviewClip(r))
          || (isDecisivelyDeadProbe(await probeUrl(r.url, r)) ? DEAD_LINK_REJECT : null)
      : verifyPreviewClip;

    for (const cand of (Array.isArray(candidates) ? candidates : [])) {
      if (!cand || !cand.id || !cand.source) continue;
      const r = await trySource(String(cand.id), cand.source, quality, verifyCandidate);
      if (isTrackSuccess(r)) {
        logger.log(`[ResolveTrack] 换源成功: "${song.title}" ${song.source} → ${cand.source}`);
        return normalizeTrackResult({
          ...r, source: cand.source, matchedSong: cand, matchedFrom: song.source,
        });
      }
    }

    // 4. 全失败：返回本源原始错误（UI 文案与未换源时一致）
    return normalizeTrackResult(result);
  }

  return Object.freeze({
    resolve,
    // 导出决策函数便于消费方/测试直接断言（与模块级导出同源）
    shouldFallbackToOtherSource,
    FALLBACK_CODES,
  });
}

module.exports = {
  createResolveTrackService,
  shouldFallbackToOtherSource,
  isDecisivelyDeadProbe,
  isPreviewClip,
  FALLBACK_CODES,
};
