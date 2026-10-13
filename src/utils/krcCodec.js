/**
 * 酷狗 KRC 逐字歌词解码（pure codec，零网络）
 *
 * KRC 是酷狗官方歌词的封装格式，携带**逐字时间戳**（桌面歌词/卡拉OK 的数据基础）。
 * 封装链（实测钉验，样本见 test/fixtures/platforms/kugou.qingtian.krc.txt）：
 *   base64 → 跳过 4 字节魔数（"krc1"）→ 16 字节定长 key 循环 XOR → zlib inflate → 私有标记文本。
 * XOR 方案源自 lx-music-desktop 的 decodeKrc（同格式互操作常量，非安全用途）。
 *
 * 标记语法：
 *   [ti:..] [ar:..] [al:..]        元信息
 *   [startMs,durMs]<o,d,x>字<o,d,x>字…   行 + 词数组（o 为相对行起的偏移 ms）
 *   个别文件带 [id:$..] 头与 [language:base64] 翻译块，此处跳过翻译块。
 *
 * 分层约束：本模块只做格式解码，不 require 平台/网络模块，渲染层不直接依赖。
 */

const zlib = require('zlib');

/** KRC XOR 密钥（格式互操作常量，不是安全密钥） */
const XOR_KEY = Buffer.from([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47,
  0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
]);

/** 文件头魔数（4 字节 ASCII "krc1"） */
const MAGIC = Buffer.from('krc1', 'latin1');

/**
 * 解压输出上限。
 *
 * P2-11（2026-10-13 复审）：zlib.inflateSync 默认**没有**输出上限，而本模块
 * 跑在主进程（= UI 线程）。一段构造的压缩炸弹（几百 KB 输入能膨胀上百 MB）
 * 就能一次性吃满内存，把整个应用顶死。对照 src/utils/webdav.js:31 的
 * MAX_RESPONSE_BYTES —— 同一仓库里另一条解压/读取路径早就有上限，这里没有。
 * 取 8 MiB：真实逐字歌词文本在几十 KB 量级，8 MiB 已有两个数量级余量。
 */
const MAX_INFLATE_BYTES = 8 * 1024 * 1024;

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function decodeEntities(text) {
  return text.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m]);
}

/**
 * 解码 KRC content（download 接口 content 字段的 base64 文本）为标记文本。
 * @param {string} contentBase64
 * @returns {string} 标记文本；空输入 ⇒ 空串
 * @throws {Error} 魔数不符 / base64 非法 / 非 deflate 流 / 解压输出超限
 *         （调用方决定降级策略）
 */
function decryptKrc(contentBase64) {
  if (!contentBase64) return '';
  const raw = Buffer.from(contentBase64, 'base64');
  // P2-11：旧实现直接 subarray(4) 跳过「魔数」，从不核对它。于是内容被网关或
  // 代理截断后，解出来的 4 字节是随机数据 —— 要么 XOR 出乱码、要么 inflate
  // 抛错，报错信息里没有一个字提到「这不是 KRC」，排查只能靠猜。现在先校验魔数，
  // 把「不是 KRC 文件」与「KRC 坏了」分成两种可分辨的失败。
  if (raw.length < MAGIC.length + 1) {
    throw new Error('[krcCodec] 内容过短，不是 KRC 格式（连 4 字节魔数都不够）');
  }
  if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('[krcCodec] 魔数不符，期望 "krc1" —— 这不是 KRC 歌词内容');
  }
  const buf = Buffer.from(raw.subarray(MAGIC.length));
  for (let i = 0; i < buf.length; i++) buf[i] ^= XOR_KEY[i % XOR_KEY.length];
  try {
    return zlib.inflateSync(buf, { maxOutputLength: MAX_INFLATE_BYTES }).toString('utf8');
  } catch (e) {
    // maxOutputLength 触发时 Node 抛 ERR_BUFFER_TOO_LARGE，单独说清楚，
    // 别让「压缩炸弹」与「文件损坏」共用一句话。
    if (e && e.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`[krcCodec] 解压输出超过 ${MAX_INFLATE_BYTES} 字节上限，已拒绝（疑似异常内容）`);
    }
    throw new Error(`[krcCodec] KRC 解压失败: ${e.message}`);
  }
}

/**
 * 解析 KRC 标记文本为结构化数据。
 * @param {string} xml
 * @returns {{ meta: Object, lines: Array<{startMs:number,durMs:number,words:Array<{text:string,startMs:number,durMs:number}>}> }}
 */
function parseKrcXml(xml) {
  const meta = {};
  const lines = [];
  if (!xml) return { meta, lines };

  const text = String(xml).replace(/\r/g, '')
    .replace(/^.*\[id:\$\w+\]\n/, '')
    // P2-11：旧写法只删掉 `[language:...]` 那一**行**（且无 /g），翻译块的正文
    // 会被当成歌词行解析进来 —— 与文件头「此处跳过翻译块」的声明不符。
    // 改成：整块（标记行 + 直到下一个时间轴行为止的正文）全部跳过。
    .replace(/\[language:[^\]\n]*\]\n(?:(?!\[\d+,\d+\]).*\n)*/g, '');

  for (const rawLine of text.split('\n')) {
    const lineMatch = rawLine.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!lineMatch) {
      const m = rawLine.match(/^\[(ti|ar|al|by):([^\]]*)\]$/);
      if (m) meta[m[1]] = decodeEntities(m[2]);
      continue;
    }
    const startMs = Number(lineMatch[1]);
    const words = [];
    const wordRe = /<(\d+),(\d+),(\d+)>([^<]*)/g;
    let wm;
    while ((wm = wordRe.exec(lineMatch[3])) !== null) {
      if (!wm[4]) continue;
      words.push({
        text: decodeEntities(wm[4]),
        startMs: startMs + Number(wm[1]),
        durMs: Number(wm[2]),
      });
    }
    if (words.length) lines.push({ startMs, durMs: Number(lineMatch[2]), words });
  }
  // P2-11：行按时间戳升序排一次。旧实现完全依赖「源文件本来就是有序的」这个
  // 假设，一旦行序错乱（部分导出工具会把翻译块、附赠行插在中间），输出的 .lrc
  // 时间戳非递增，逐行歌词 UI 就会来回跳。排序是纯本地操作，成本可忽略。
  //
  // ⚠️ 只排**行**、绝不排**词**：KRC 里词的顺序就是逐字显示的顺序，而 offset
  // 未必严格递增（拖腔、叠音时后一个词的绝对时间可能更早）。按绝对时间重排词
  // 会把「句中尾」显示成「中尾句」—— 歌词读起来是错的。
  // 行内顺序一律以源文件为准。
  lines.sort((a, b) => a.startMs - b.startMs);
  return { meta, lines };
}

/** 毫秒 → [mm:ss.SSS] */
function formatLrcTime(ms) {
  const total = Math.max(0, Math.round(ms));
  const m = String(Math.floor(total / 60000)).padStart(2, '0');
  const s = String(Math.floor(total / 1000) % 60).padStart(2, '0');
  const sss = String(total % 1000).padStart(3, '0');
  return `[${m}:${s}.${sss}]`;
}

/**
 * 降级合成普通 LRC（下游 .lrc 落盘与现有逐行 UI 直接可用）。
 * @param {Object|string} parsedOrXml parseKrcXml 结果或 KRC 标记文本
 * @returns {string}
 */
function krcToLrc(parsedOrXml) {
  const parsed = typeof parsedOrXml === 'string' ? parseKrcXml(parsedOrXml) : parsedOrXml;
  if (!parsed || !Array.isArray(parsed.lines)) return '';
  return parsed.lines
    .map(l => `${formatLrcTime(l.startMs)}${l.words.map(w => w.text).join('')}`)
    .join('\n');
}

/**
 * 一步解码：content(base64) → { xml, parsed, lrc }。
 * @param {string} contentBase64
 */
function decodeKrc(contentBase64) {
  if (!contentBase64) return { xml: '', parsed: { meta: {}, lines: [] }, lrc: '' };
  const xml = decryptKrc(contentBase64);
  const parsed = parseKrcXml(xml);
  return { xml, parsed, lrc: krcToLrc(parsed) };
}

module.exports = { decryptKrc, parseKrcXml, krcToLrc, decodeKrc };
