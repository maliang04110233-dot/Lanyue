'use strict';
/**
 * 发给厂商的文本里不许出现本机路径与凭据（spec 第五节）。
 *
 * 为什么是一道新闸而不是「渲染层少塞点」：
 *   - 工具返回值是第二条出网路，形状由主进程 handler 产出，界面管不着；
 *   - 判据放在桥的出口一处，加新工具不必各自记得剥，也不存在「剥了两份、各漏一处」；
 *   - 闸只装助手这一条（裁定 R-14）：外部 Agent 是本机用户自己配的进程，
 *     它读本机数据不是「我们替它出网」，那条不过这道闸；
 *   - 刻意不含 `lyric`：`get_lyrics` 的存在理由就是把歌词取回来给用户看，
 *     把它一起剥掉是砍功能不是堵泄漏。
 */

/** 发给大模型厂商的文本里不许出现的键名（本机路径与凭据类）。唯一出处。 */
const LEAK_KEYS = ['path', 'localPath', 'filePath', 'dir', 'cookie', 'cookies', 'token', 'accessToken', 'apiKey', 'secret', 'savePath'];

function scrubOutbound(value) {
  if (Array.isArray(value)) return value.map(scrubOutbound);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (LEAK_KEYS.includes(k)) continue;
      out[k] = scrubOutbound(v);
    }
    return out;
  }
  return value;
}

/**
 * 桥返回的 text 是 JSON 文本；解析不动就回空串 —— 一条读不出来的返回值
 * 不该带着看不见的原文出网。截断仍由调用方那枚 8000 的闸管，这里只负责剥。
 */
function scrubToolText(text) {
  if (typeof text !== 'string' || !text.trim()) return '';
  try {
    return JSON.stringify(scrubOutbound(JSON.parse(text)));
  } catch (_e) {
    return '';
  }
}

module.exports = { LEAK_KEYS, scrubOutbound, scrubToolText };
