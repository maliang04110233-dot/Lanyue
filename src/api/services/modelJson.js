/**
 * 模型输出里的 JSON 抠取 —— 助手回合、智能歌单挑选、搜索关键词改写**共用的一份**
 *
 * 为什么要有这个文件：三处原来各自写着贪婪正则（`\{[\s\S]*\}` 与 `\[[\s\S]*?\]`，注释还互相指着「同一口径」），
 * 而真供应商最常见的第二种毛刺恰恰是**一条回复里出现两个对象**（模型先答一句又改口重来）：
 * 跨首尾的贪婪匹配会把两个对象连成一段非法 JSON，解析失败后
 *   · 助手侧把整坨花括号当成 reply 上屏，模型真正要执行的 steps 静默丢掉；
 *   · 歌单侧 picks 全丢，界面如实报「一首都没挑出来」，其实是模型答对了、只是答了两遍；
 *   · 关键词改写那条用的是 `\[[\s\S]*?\]`（短的、贪婪方向相反），于是拿到的是模型**已经丢掉的第一份草稿**
 *     —— 同一类毛刺的第三种表现，也是最不容易被发现的一种。
 * 口径分三处攒着，修一处就漏一处，所以抽成一份。
 *
 * 判据（什么算「模型在按协议答话」）留在各自服务里当入参 —— 助手认 reply/steps，
 * 歌单认非数组的对象，关键词改写认数组，这一层只管从文本里把候选值配平取出来。
 */

/**
 * 抠出文本里每个**配平**的顶层 JSON 值（`{…}` 或 `[…]`）。
 * 逐字符配平并认字符串，所以值里出现的 `{`、`}`、`]` 与转义引号都不会带偏。
 * 认 `[…]` 是因为关键词改写那条协议交出来的是数组（`parseSearchQueries`）。
 */
const CLOSER = { '{': '}', '[': ']' };

function jsonCandidates(text) {
  const out = [];
  const s = String(text == null ? '' : text);
  const stack = [];
  let start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; }
    else if (CLOSER[ch]) { if (stack.length === 0) start = i; stack.push(CLOSER[ch]); }
    else if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1] === ch) {
        stack.pop();
        if (stack.length === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; }
      }
    }
  }
  return out;
}

/**
 * 从一段可能有毛刺的模型输出里取出协议值；取**最后一个**合形的候选（改口之后的才是结论）。
 *
 * @param {string} text 模型原文
 * @param {(o:any)=>boolean} [isProtocol] 判据；不传则任何 JSON 值都算合形
 * @returns {Object|Array|null}
 */
function extractModelJson(text, isProtocol) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) return null;
  const ok = typeof isProtocol === 'function' ? isProtocol : (o) => !!o && typeof o === 'object';
  try {
    const whole = JSON.parse(s.trim());
    if (ok(whole)) return whole;
  } catch (_e) { /* 整段不是 JSON，走候选路径 */ }
  const cands = jsonCandidates(s);
  for (let i = cands.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(cands[i]);
      if (ok(v)) return v;
    } catch (_e2) { /* 这个候选不是 JSON，继续往前找 */ }
  }
  return null;
}

module.exports = { jsonCandidates, extractModelJson };
