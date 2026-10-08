/**
 * 在线播放 D-35：同源重取回调
 *
 * 为什么重取放在主进程而不是让渲染层传回调过来
 * --------------------------------------------
 * 签名 URL 的解析发生在渲染层链路（getDownloadUrlSmart → 平台插件），
 * 403 的观测发生在主进程（protocol.handle）。让渲染层注册一个
 * resolveFresh 回调需要**函数穿过 IPC** —— 结构化克隆做不到函数。
 * 主进程本来就持有 api.getDownloadUrl（**单源**取流，不含换源逻辑），
 * 由它实现同源重解析是最小改动，也不产生跨层 require（D-32 的先例）。
 *
 * 为什么不复用 getDownloadUrlSmart
 * --------------------------------
 * 那是跨源换源入口，而自动兜底换源是 admin 明令保持关闭的产品开关。
 * 重取只解决「同一条流的链接过期了」这一个确定性问题；两者混起来会
 * 悄悄越过那条产品决策（P-11 的纪律）。
 *
 * 因此这里只认 desc.source 指定的**同一个源**：渲染层传回的 desc.source
 * 已经是「当初真正出流的那个源」（换源成功时它与 song.source 不同），
 * 主进程不参与「该去哪个源取」这个决策。
 */

const api = require('../api');
const logger = require('../utils/logger');

/**
 * 造一个同源重取回调
 *
 * @param {{id:string, source:string, quality?:string}} desc 重取描述
 * @param {string} [quality] 音质档位，缺省 standard
 * @returns {() => Promise<{url:string, referer?:string}|null>}
 *          重取失败/取不到流时返回 null，由调用方落终态失败
 */
function makeStreamRefresh(desc, quality) {
  return async () => {
    const id = String((desc && desc.id) || '').trim();
    const source = String((desc && desc.source) || '').trim();
    // 只在有完整标识时给能力：本地曲（无 id/source）本来也不走在线取流
    if (!id || !source) return null;
    let r = null;
    try {
      r = await api.getDownloadUrl(id, source, quality || 'standard');
    } catch (e) {
      logger.warn('[stream] 同源重取失败:', (e && e.message) || e);
      return null;
    }
    if (!r || !r.url) return null;
    return { url: r.url, referer: r.referer || '' };
  };
}

module.exports = { makeStreamRefresh };
