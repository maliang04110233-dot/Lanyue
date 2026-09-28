/**
 * 更新失败的「说什么」与「什么时候说」
 *
 * 抽成独立模块的原因（与 updateMirror.js 同源）：updater.js 顶层 require
 * electron-updater 与 electron，测试环境里加载不动，而这两条判据恰恰是
 * 出过事的逻辑，必须能被单测钉住。
 *
 * 背景（2026-09-21 用户截图「更新失败：net::ERR_CONNECTION_RESET」）：
 *   1. electron-updater 每次 checkForUpdates() 失败都 emit('error') 再 reject
 *      （node_modules/electron-updater/out/AppUpdater.js:269-272）。我们一次
 *      用户主动检查要跑「直连×3 + 镜像×2」，事件若无条件转发，第 1 次失败就
 *      会弹「更新失败」，而兜底还在跑 —— 弹窗冒充了最终结果。
 *   2. 旧码表按 Node socket 码写（ECONNRESET / ETIMEDOUT），但 electron 抛的是
 *      Chromium 的 net:: 名字：`net::ERR_CONNECTION_RESET` 不含子串 `ECONNRESET`，
 *      一条都不匹配 ⇒ 内部 token 直接印到普通用户脸上。
 *
 * 两条判据都刻意保持「不确定就不说」：非网络错误原样返回（翻成"网络问题"会
 * 掩盖真因），事件级错误缺字段一律不打扰用户。
 */
'use strict';

// 两支正则的家在 src/shared/netClass.js：同一判据在更新器、传输层、
// 队列终态三处各写一遍必然漂，这里只是消费方 —— 迁移前后 isNetworkFailure 的口径一字未动。
const { isTlsFailure, isTransportFailure, messageOf } = require('../shared/netClass');

/**
 * 这条失败是不是"网络类"——即弹层该不该给用户一个「打开下载页」按钮。
 *
 * 判据与 shared/netClass 严格同源（不是另起一张表）：正因为这两类的文案本来就写着
 * "或到 GitHub Releases 页面手动下载"，它们才是该给按钮的；非网络错误
 * （"Please check update first" 之类）给个下载页按钮是把人往错方向支。
 * 注意这里 TLS 也算：证书被拦时"稍后再试"没用，但"手动下最新版本"依然是一条走得通的路。
 */
function isNetworkFailure(err) {
  return isTlsFailure(err) || isTransportFailure(err);
}

/**
 * 手动下载那句话说的是"按钮"还是"你自己去找页面"，取决于按钮在不在。
 * 有按钮还写着「或到 GitHub Releases 页面手动下载」，等于让用户去猜哪条路可行；
 * 没按钮（开发环境 / yml 解析不出来）却提按钮，就是假话——与 mirrorTried 同一条纪律。
 */
function manualDownloadHint(opts) {
  return opts.manualAvailable
    ? '，或点下方「打开下载页」按钮手动下载最新版本'
    : '，或到 GitHub Releases 页面手动下载最新版本';
}

/**
 * 把裸的网络错误翻译成用户能行动的一句话。
 *
 * @param {Error|string|null} err
 * @param {{mirrorTried?:boolean, mirrorBlocked?:boolean}} [opts]
 *        mirrorTried —— 镜像兜底是否真的跑过；措辞必须跟着事实走，
 *        否则「已自动重试多次」会在用户面前变成假话（实际还试了镜像）。
 *        mirrorBlocked —— 镜像是被信任闸门拦下的（产物未签名，签名校验空转），
 *        这时**不能**说「镜像源均已试过」：压根没试过，说了就是假话。
 *        这种情况给手动下载入口反而更重要 —— 那是唯一走得通的路。
 * @returns {string} 非网络错误原样返回（无 message 时返回空串）
 */
function describeUpdateError(err, opts = {}) {
  const msg = messageOf(err);
  if (isTlsFailure(err)) {
    return '更新连接被证书校验挡住（常见于代理、VPN 或安全软件拦截），'
      + '请检查这类网络中间件后再试' + manualDownloadHint(opts);
  }
  if (isTransportFailure(err)) {
    let scope;
    if (opts.mirrorBlocked) {
      scope = '已自动重试多次；镜像源因当前版本未做代码签名、'
        + '无法验证安装包来源而未启用';
    } else if (opts.mirrorTried) {
      scope = 'GitHub 直连与镜像源均已试过';
    } else {
      scope = '已自动重试多次';
    }
    return `网络连不上更新服务器（${scope}），请稍后再试` + manualDownloadHint(opts);
  }
  return msg;
}

/**
 * 事件级（autoUpdater.on('error')）错误是否该打扰用户。
 *
 * 只有「用户主动触发」且「我们自己的重试/镜像流程已经收尾」两者同时成立才报：
 * 流程在飞时每次尝试失败都会 emit 一次事件，而收尾时 IPC 返回值会把最终结论
 * 报给 UI（渲染层措辞是「检查失败：」/「下载失败：」），事件再报一次就是抢跑。
 *
 * @param {{userInitiated?:boolean, flowInFlight?:boolean}} state
 * @returns {boolean}
 */
function shouldReportEventError(state) {
  if (!state) return false;
  return state.userInitiated === true && state.flowInFlight !== true;
}

module.exports = {
  describeUpdateError,
  isNetworkFailure,
  shouldReportEventError,
};
