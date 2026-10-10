/**
 * 应用身份常量 —— 单一真源
 *
 * build/config.cjs 的 publish 段（owner/repo）和 main/updater.js 的完整性校验
 * 都必须引用同一份值，避免仓库改名时出现「两处漂移、一处硬编码」。
 */

module.exports = {
  /** GitHub 仓库所有者 */
  OWNER: 'maliang04110233-dot',
  /** GitHub 仓库名 */
  REPO: 'Lanyue',
  /** 应用 productName（与 build/config.cjs 保持一致） */
  PRODUCT_NAME: 'Lanyue',
};
