/**
 * i18n.js 的 node 可加载替身（仅供测试图使用）。
 *
 * 为什么不能直接 import 真的 i18n.js：真身静态 import 了 lang/*.json，而 node 的
 * ESM 加载器要求 JSON 写 `import … with { type: 'json' }` —— 本仓 eslint 解析不了
 * with 写法（见 test/toast-i18n.test.js:866 那枚哨兵的来龙去脉）。于是 i18n.js
 * 被判为"不许进入可测模块图"，视图文件却都静态 import 它。
 *
 * 折中：靠 resolve 钩子（i18n-redirect-hooks.js）把整张模块图里的 i18n.js 指向本文件。
 * 取词语义与真身**逐字一致**（同一份 zh/en 语言包、同一套 {占位符} 替换），
 * 所以行为测试里 t() 取到的就是界面上的那句话 —— 不是"测试专用假词典"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LANG = path.join(HERE, '..', '..', 'src', 'renderer', 'js', 'lang');
const zh = JSON.parse(fs.readFileSync(path.join(LANG, 'zh.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(LANG, 'en.json'), 'utf8'));

const LANGS = { zh, en };
let _lang = 'zh';

export function loadLanguage(code) { _lang = LANGS[code] ? code : 'zh'; }
export function getLang() { return _lang; }

/** 与 i18n.js 的 t() 逐字同形：缺键回落成键名，占位符全局替换 */
export function t(key, params = {}) {
  let result = LANGS[_lang]?.[key] || key;
  for (const [k, v] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return result;
}

/** 行为测试只关心"接了词典就有译文"，值匹配兜底不参与本轮断言 */
export function translateMessage(msg) { return msg; }
export async function applyTranslations() {}
export async function setLanguage(code) { loadLanguage(code); }
