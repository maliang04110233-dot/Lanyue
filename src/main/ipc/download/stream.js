/**
 * 下载 IPC —— 取流域
 *
 * 注册：get-download-url / get-download-url-smart / proxy-play
 *
 * 拆分说明（等价迁移）：自 ipc/download.js 的 register 提出。
 * proxy-play 是播放链路的入口，钉在 test/stream-protocol.test.js /
 * stream-latency.test.js / streamSignedUrlRefresh.test.js。
 */

const api = require('../../../api');
const { handle } = require('../register');
const logger = require('../../../utils/logger');

// M9: IPC 边界参数形状校验——id/source/quality 会拼进平台 API URL，
// 渲染层被 XSS 后可传任意字符串，这里兜底拦截控制字符与超长值
const safeId = (v) => {
  const s = String(v ?? '').trim();
  // 仅允许可见 ASCII（无空白/控制字符）且长度受限
  return s.length && s.length <= 128 && /^[ -~]+$/.test(s) ? s : null;
};
const safeToken = (v) => {
  const s = String(v ?? '');
  return /^[a-z0-9_-]{1,32}$/i.test(s) ? s : null;
};

function register() {
  // 获取下载 URL（渲染层位置参数调用：api.getDownloadUrl(id, source, quality)）
  handle('get-download-url', async (_, rawId, rawSource, rawQuality) => {

    const id = safeId(rawId);
    const source = safeToken(rawSource);
    const quality = ['lossless', 'hq', 'standard'].includes(rawQuality) ? rawQuality : 'standard';
    if (!id || !source) return { error: '非法参数', fatal: true };
    try {
      return await api.getDownloadUrl(id, source, quality);
    } catch (e) {
      logger.warn('获取下载URL失败:', e.message || e);
      return { error: e.message || e };
    }
  });

  // 智能取流（换源）：渲染层播放链路用——本源失败自动跨源找同曲
  //
  // options 是 2026-10-22 新增的第三参（P0 换源参数化，见
  // docs/design/P0-fallback-params.md）：
  //   { allowToggleSource?, isRefresh?, onToggleSource? }
  //
  // 安全约束：
  //   · onToggleSource 是**函数**，无法跨进程传递，因此这个键**永远不该出现**
  //     在渲染层发来的 options 里 —— 主进程收到就丢弃并告警。函数回调只能在
  //     主进程侧构造（见 MCP 工具面），或渲染层自己持有（不经过本通道）。
  //   · 允许透传的是 allowToggleSource / isRefresh 两个布尔值。
  //   · 契约规格是 t.obj()（只做形状检查），内部字段的语义校验放在这里。
  handle('get-download-url-smart', async (_, song, quality, rawOptions) => {

    // 只摘取并校验可透传的两个布尔键。onToggleSource 若是函数，
    // 序列化后已经变成 null/丢失，这里再加一道防线防止未来调用方传错。
    // 初始值是 undefined 而非 null：service 层 resolve() 的第三参默认值
    // `options = {}` 只对 undefined 生效 —— 传 null 会让
    // `options.allowToggleSource` 直接抛 TypeError。
    let options = undefined;
    if (rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)) {
      const cleaned = {};
      if (typeof rawOptions.allowToggleSource === 'boolean') {
        cleaned.allowToggleSource = rawOptions.allowToggleSource;
      }
      if (rawOptions.isRefresh === true) {
        cleaned.isRefresh = true;
      }
      if (typeof rawOptions.onToggleSource === 'function') {
        logger.warn('[stream] onToggleSource 是函数，无法跨 IPC 传递，已忽略');
      }
      if (Object.keys(cleaned).length > 0) options = cleaned;
    }

    try {
      return await api.getDownloadUrlSmart(song, quality, options);
    } catch (e) {
      logger.warn('智能取流失败:', e.message || e);
      return { error: e.message || e };
    }
  });

  // 在线播放：把跨域音频以流式代理喂给 audio 元素（根因 1）
  const { assertPublicHttpUrl } = require('../../../utils/urlGuard');
  const streamRegistry = require('../../streamRegistry');
  const { makeStreamRefresh } = require('../../streamRefresh');
  handle('proxy-play', async (_, url, referer, refresh) => {

    // C10: SSRF protection — full guard via urlGuard:
    //   scheme/userinfo 校验 + DNS 全记录解析 + 内网 IP 判定（含
    //   2130706433 / 0x7f.0.0.1 / 0177.0.0.1 / [::ffff:127.0.0.1] 等编码绕过）
    //   原正则黑名单已删除（可被 IP 编码与 DNS rebinding 绕过）
    const check = await assertPublicHttpUrl(url);
    if (!check.ok) {
      return { error: `URL 校验失败: ${check.reason}` };
    }
    // 登记后立即返回 scheme URL：不再等整首落盘。渲染层拿到就能播，
    // duration 由首个响应头给出，seek 从此可用。
    //
    // SSRF 校验的**位置**（2026-10-13 调整）：此前这里是「登记前先拒掉明显非法
    // 入参、少占一条登记位」，protocol.handle 里再真正校验一次，于是同一次播放
    // 解析两次 DNS、只用第二次的结果。现在把这次已经拿到的 check 一起登记，
    // protocol.handle 直接复用（URL 被 refresh 换过时会自动重新校验）——
    // 少一次 DNS 往返，且连接本来就固定在校验时的 IP 上，安全等价。
    //
    // D-35：登记时一并挂上同源重取回调。签名 URL 过期后上游一律 403，
    // 主进程靠它要一条新 URL 并用原始 Range 重放（见 streamProtocol.js）。
    // 缺省（老调用方 / 本地曲）不给回调，403 时如实失败。
    const refreshFn = refresh ? makeStreamRefresh(refresh, refresh.quality) : null;
    const streamUrl = streamRegistry.registerStream(url, referer, refreshFn, check);
    if (!streamUrl) return { error: 'no url' };
    return { fileUrl: streamUrl, streaming: true };
  });
}

module.exports = { register };
