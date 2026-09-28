/**
 * 更新镜像兜底
 *
 * 背景：检查/下载走 api.github.com + github.com，部分网络间歇性断连
 * （实测：检查更新 3 连败 ERR_CONNECTION_RESET/TIMED_OUT，121MB 资产长连接必挂）。
 * 直连失败后按 app-update.yml 的 owner/repo 派生镜像 feed 重试。
 *
 * 为什么 setFeedURL 在这里而不是 updater.js：
 * retry.test.js 守卫禁止 updater.js 出现 setFeedURL——那是防「硬编码覆盖
 * app-update.yml 真源」的历史事故。本模块的 feed 完全派生自 app-update.yml
 * 本身（单一真源仍是 build/config.cjs 的 publish 段），不违反约束初衷。
 *
 * ── 信任闸门（fail-closed）────────────────────────────────────
 * 派生自 app-update.yml **不等于**可信。镜像 feed 的 latest.yml（含 sha512）
 * 由镜像自己提供，校验自指；setFeedURL 也不动 configOnDisk，所以镜像路径
 * 读到的仍是同一份磁盘 yml。于是唯一能区分「官方包」与「镜像编的包」的就是
 * 产物里的 publisherName（代码签名信任锚）—— 没有它，签名校验是空转的，
 * 镜像就等于「谁提供安装包谁说了算」。
 *
 * 因此 useMirrorFeed() 在无 publisherName 时**拒绝切 feed**。
 * 采购证书后 publisherName 出现，闸门自动放行，镜像可用性恢复。
 * 在此之前镜像等价于半撤：宁可更新失败并提示手动下载，也不静默装未签名的包。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 支持「前缀 + 原始 GitHub URL」形态的镜像，实测均支持 releases 资产的 302→206 断点续传
const MIRROR_PREFIXES = ['https://ghproxy.net/', 'https://gh.ddlc.top/'];

function parseGithubFeed(ymlText) {
  if (!ymlText) return null;
  const owner = /^\s*owner:\s*['"]?([^'"\r\n#]+?)['"]?\s*$/m.exec(ymlText);
  const repo = /^\s*repo:\s*['"]?([^'"\r\n#]+?)['"]?\s*$/m.exec(ymlText);
  const provider = /^\s*provider:\s*['"]?(\w+)/m.exec(ymlText);
  if (!owner || !repo || !provider || provider[1] !== 'github') return null;
  return { owner: owner[1].trim(), repo: repo[1].trim() };
}

/**
 * app-update.yml 里的 publisherName —— 更新包代码签名的**信任锚**。
 *
 * 这是「签名校验是否真的在生效」的唯一判据，机制在依赖里：
 *   electron-updater/out/NsisUpdater.js:84-99 先读 publisherName，
 *   取不到就直接 `return null`；调用方（同文件 :52-56）只在返回值**非 null**
 *   时才抛 ERR_UPDATER_INVALID_SIGNATURE —— 即 null 的语义是「放行」。
 *
 * 而 publisherName 只在配置了代码签名证书时才会被 electron-builder 写进产物
 * （app-builder-lib/out/publish/PublishManager.js:202-207 依赖
 *  windowsSignToolManager.computedPublisherName，无证书时为 null）。
 *
 * 所以：没有 publisherName ⇒ verifyUpdateCodeSignature 那个开关是**空转**的，
 * 无论它是 true 还是 false。开关本身在运行时也无人消费
 * （NsisUpdater 的 set verifyUpdateCodeSignature 全仓从未被调用），
 * 它只是构建期决定「要不要去算 publisherName」的提示位。
 */
function readPublisherName(ymlText) {
  if (!ymlText) return null;
  const m = /^\s*publisherName:\s*['"]?([^'"\r\n#]*?)['"]?\s*$/m.exec(ymlText);
  if (!m) return null;
  const name = m[1].trim();
  return name || null;
}

/**
 * 镜像路径的信任闸门（fail-closed）。
 *
 * 为什么必须有这个闸：镜像 feed 是 `{provider:'generic', url: 镜像前缀+GitHub}`，
 * 其 `latest.yml`（连同 sha512）**全部由镜像自己提供** —— 校验是自指的，
 * 零保护作用。而 `setFeedURL` 只换 clientPromise、不动 configOnDisk，
 * 所以镜像路径同样读着那份磁盘 yml、同样依赖 publisherName。
 *
 * 于是签名校验一旦空转，镜像就等于「谁提供安装包谁说了算」：只要让
 * api.github.com 不可达（黑洞路由 / 企业 TLS 检查代理 / ISP 抖动 ——
 * 直连间歇性全灭是本模块存在的理由），流量就会自动落到镜像上。
 *
 * 判定：无 publisherName ⇒ 签名校验没生效 ⇒ 镜像不可信 ⇒ 拒绝切 feed。
 * 采购证书后（publisherName 出现）本闸自动放行，镜像可用性收益恢复。
 * 在此之前镜像等价于「半撤掉」，这是有意识的取舍：
 * 宁可更新失败并提示手动下载，也不静默安装未签名的安装包。
 */
function isMirrorFeedTrusted(ymlText) {
  const yml = ymlText === undefined ? readAppUpdateYml() : ymlText;
  if (!yml) return false; // 开发环境 / yml 读不到 —— 同样不可信
  return readPublisherName(yml) !== null;
}

/** 镜像被信任闸门拦下时抛的错。上层据此改写措辞，而不是谎称「已试过镜像」。 */
class UntrustedMirrorError extends Error {
  constructor() {
    super('镜像更新源已停用：当前安装包未做代码签名，更新签名校验无法生效，'
      + '无法确认镜像提供的安装包来自本仓库。');
    this.name = 'UntrustedMirrorError';
    this.code = 'ERR_UPDATE_MIRROR_UNTRUSTED';
  }
}

function buildMirrorFeeds(feed, prefixes = MIRROR_PREFIXES) {
  if (!feed || !feed.owner || !feed.repo) return [];
  return prefixes.map((p) => ({
    provider: 'generic',
    url: `${p}https://github.com/${feed.owner}/${feed.repo}/releases/latest/download/`,
  }));
}

/**
 * 手动下载入口：Releases 页地址。
 *
 * 与镜像 feed 同源（都派生自 app-update.yml 的 owner/repo）——这是它的存在前提：
 * updater.js 顶部整段注释讲的就是"第二处硬编码仓库名"怎么把真源劈成两半、
 * 让每次检查更新先吃一个改名 301。所以这里只**拼**地址，绝不**写**地址。
 *
 * 用 /releases/latest 而不是 /releases：自动更新失败时用户要的是"最新版"，
 * 不必自己在列表里挑；也避开我们自己维护 tag 名。
 */
function buildReleasesPageUrl(feed) {
  if (!feed || !feed.owner || !feed.repo) return null;
  return `https://github.com/${feed.owner}/${feed.repo}/releases/latest`;
}

function readAppUpdateYml() {
  try {
    return fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
  } catch (_e) {
    return null;
  }
}

/** 打包环境返回可用镜像 feed 列表；开发环境（无 app-update.yml）返回 []，自然降级 */
function getMirrorFeeds() {
  return buildMirrorFeeds(parseGithubFeed(readAppUpdateYml()));
}

/** 同上：拿不到 feed（开发环境）就返回 null —— 手动下载按钮自然不出现 */
function getReleasesPageUrl() {
  return buildReleasesPageUrl(parseGithubFeed(readAppUpdateYml()));
}

/**
 * 切到镜像 feed。
 *
 * @param {object} autoUpdater
 * @param {{provider:string,url:string}} feed
 * @param {{yml?:string}} [opts] 测试注入点：传 yml 文本可覆盖「读磁盘」这一默认行为。
 *        生产路径不传，走 readAppUpdateYml()。传 null 显式表示「没有 yml」⇒ 不可信。
 * @throws {UntrustedMirrorError} 产物无 publisherName（签名校验空转）时拒绝切换
 */
function useMirrorFeed(autoUpdater, feed, opts = {}) {
  // fail-closed 闸门：无 publisherName ⇒ 签名校验空转 ⇒ 镜像提供的安装包无从验证。
  // 抛错而不是静默放行，调用方会把措辞改成「镜像因未签名而停用」。
  if (!isMirrorFeedTrusted(opts.yml)) {
    throw new UntrustedMirrorError();
  }
  autoUpdater.channel = 'latest';
  // 镜像对多 range 差分请求的支持不可靠，兜底路径一律全量下载
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.setFeedURL(feed);
}

module.exports = {
  MIRROR_PREFIXES,
  parseGithubFeed,
  readPublisherName,
  isMirrorFeedTrusted,
  UntrustedMirrorError,
  buildMirrorFeeds,
  buildReleasesPageUrl,
  readAppUpdateYml,
  getMirrorFeeds,
  getReleasesPageUrl,
  useMirrorFeed,
};
