/**
 * 大模型厂商配置 IPC
 *
 * 厂商配置只有两条通道：
 *   ai-provider-config  画下拉要的数据（厂商名单 + 当前回填 + 每家「配过 Key 没有」）
 *   ai-provider-save    保存（厂商/型号/自定义端点/该家的 Key）
 *
 * 这里刻意薄：判据（厂商是否在名单、端点形状、型号形状、Key 映射的合并语义）
 * 全在 src/api/aiProviders.js —— 那是唯一一处「往哪发、发什么、哪来的 Key」。
 * 界面 require 不到那个 CJS 文件，所以名单由本通道递过去，而不是在渲染层攒一份镜像。
 *
 * Key 本体不过界：providerConfig() 给的是布尔（配过没有）。升级前渲染层
 * getPref('aiMusicApiKey') 直接把计费 Key 拉进界面进程，如今没有必要。
 *
 * 错误一律回 ASCII 令牌，文案的家在渲染层词典（与 ai-assistant.js 同一条规矩）。
 */

const { handle } = require('./register');
const prefs = require('../../utils/prefs');
const logger = require('../../utils/logger');
const { providerConfig, applyConfigPatch } = require('../../api/aiProviders');

const _get = (key) => prefs.get(key);
// prefs.set 对凭证键在安全存储不可用时返回 false —— 如实上报，别对用户说「已保存」
const _set = (key, value) => prefs.set(key, value) !== false;

function register() {
  handle('ai-provider-config', () => providerConfig(_get));

  handle('ai-provider-save', (_, patch) => {
    const r = applyConfigPatch(patch, _get, _set);
    if (!r.ok) logger.warn('[ai-provider] 配置保存被拒:', r.error);
    return r;
  });
}

module.exports = { register };
