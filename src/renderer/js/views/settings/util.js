/**
 * 设置视图 - 共享工具
 *
 * 拆分前这两段小工具住在同一个 settings.js 里、被账户与云同步两处引用；
 * 拆成多个模块后放这里，避免各自抄一份（抄两份必然漂移）。
 */

import { t } from '../../i18n.js';

/**
 * 主进程拒绝保存凭证时回的是错误码而非句子（见 utils/secretStore.js）。
 * 渲染层负责把它翻成用户能行动的中文；未知码原样透出，不吞信息。
 * @param {string} code
 * @returns {string}
 */
export function credentialErrorText(code) {
  if (code === 'SECRET_STORAGE_UNAVAILABLE') return t('toast.secretStorageUnavailable');
  return code;
}

/**
 * 把一段 Cookie 头解析成 { key, value } 列表（保留顺序，容忍空段）。
 * @param {string} cookieStr
 * @returns {Array<{key: string, value: string}>}
 */
export function parseCookieFields(cookieStr) {
  const fields = [];
  cookieStr.split(';').forEach(part => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) fields.push({ key: trimmed, value: '' });
    else fields.push({ key: trimmed.substring(0, eq).trim(), value: trimmed.substring(eq + 1).trim() });
  });
  return fields;
}
