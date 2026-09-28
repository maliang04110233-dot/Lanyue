/**
 * node ESM 解析钩子：把模块图里**任何** `i18n.js` 换成测试替身。
 *
 * 为什么用钩子而不是在入口文件里改源码：改源码只能救入口那一个文件，
 * 而它 import 的任何一层若也碰 i18n.js 就会照旧炸在 JSON import 上。
 * 钩子作用在**解析**这一层，整张图一次覆盖。
 *
 * 只认 URL 尾段 `/js/i18n.js`（真身只有那一个），换成同目录的 i18n-stub.js。
 * 语言包内容与取词语义与真身一致（见 i18n-stub.js 头注）。
 */
const STUB = new URL('./i18n-stub.js', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (typeof resolved.url === 'string' && /\/js\/i18n\.js$/.test(resolved.url)) {
    return { ...resolved, url: STUB, shortCircuit: true };
  }
  return resolved;
}
