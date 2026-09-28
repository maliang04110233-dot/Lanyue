/**
 * 自动更新 UI 模块
 * 监听主进程更新事件，显示更新提示弹窗
 */
import { errBrief } from './errBrief.js';
import { buildUpdateFailure } from './updateManual.js';

const _updateState = { checking: false, available: false, downloading: false, percent: 0 };

// 本轮失败弹层交回来的手动下载地址。它**只**活在这里，绝不进 HTML ——
// 按钮上只有一颗无值标记，点击时由委托从这里取，注入面因此不存在而非"被转义了"。
let _manualUrl = null;

// 三处失败出口（检查返回值 / 下载返回值 / 事件）共用：内容交给纯函数，URL 交给模块变量
function showFailure(label, message, manualUrl) {
  const r = buildUpdateFailure({ label, message, manualUrl });
  _manualUrl = r.manualUrl;
  showUpdate(r.html);
}

// 点击委托（宿主 = 弹层内容元素）：钮上只有无值标记，地址从模块变量取。
// 同一函数引用重复注册幂等，故直接挂在 showUpdate 每次拿到的宿主上。
function onToastClick(ev) {
  const t = ev.target;
  if (!t || typeof t.getAttribute !== 'function') return;
  if (t.getAttribute('data-update-manual') === null) return;
  if (!_manualUrl) return;
  // 走契约生成的 openExternal（主进程只放行 http/https），零新通道
  if (window.musicAPI && window.musicAPI.openExternal) {
    window.musicAPI.openExternal(_manualUrl);
  }
}

// 保留转发：更新流程需要 toast 但本模块不直接依赖 toast.js
function showToast(message, type = 'info') {
  if (window.showToast) {
    window.showToast(message, type);
  }
}
void showToast;

function createUpdateToast() {
  const toast = document.createElement('div');
  toast.id = 'update-toast';
  toast.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    width: 320px;
    padding: 16px;
    background: linear-gradient(135deg, var(--bg-elevated, #1a1a2e), var(--bg-overlay, #16213e));
    border: 1px solid var(--neon-cyan, #00d4ff);
    border-radius: 12px;
    box-shadow: 0 0 20px rgba(0, 212, 255, 0.3);
    z-index: 10000;
    font-family: inherit;
    font-size: 14px;
    color: var(--text-primary, #e0e0e0);
    display: none;
    animation: slideInRight 0.3s ease;
  `;
  toast.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
      <span style="font-weight:bold; color:var(--neon-cyan);">🔄 软件更新</span>
      <button onclick="window.closeUpdateToast()" style="background:none;border:none;color:var(--text-dim);cursor:pointer;font-size:18px;">×</button>
    </div>
    <div id="update-toast-content" style="min-height:60px;"></div>
  `;
  document.body.appendChild(toast);
  return toast;
}

function showUpdate(contentHtml) {
  let toast = document.getElementById('update-toast');
  if (!toast) {
    toast = createUpdateToast();
  }
  const contentEl = toast.querySelector('#update-toast-content');
  if (contentEl) {
    contentEl.innerHTML = contentHtml;
    // 手动下载钮走点击委托（同一函数引用，重复注册幂等）：按钮模板里没有地址，
    // 点击时才从 _manualUrl 取
    contentEl.addEventListener('click', onToastClick);
  }
  toast.style.display = 'block';
}

function closeUpdateToast() {
  const toast = document.getElementById('update-toast');
  if (toast) toast.style.display = 'none';
}

window.closeUpdateToast = closeUpdateToast;

async function checkForUpdate() {
  _updateState.checking = true;
  showUpdate(`
    <div style="text-align:center; padding:10px 0;">
      <div style="font-size:24px; margin-bottom:6px;">🔍</div>
      <div>正在检查更新...</div>
    </div>
  `);

  try {
    let result;
    if (window.ipcRenderer && window.ipcRenderer.invoke) {
      result = await window.ipcRenderer.invoke('check-for-update');
    } else if (window.musicAPI && window.musicAPI.checkForUpdate) {
      result = await window.musicAPI.checkForUpdate();
    } else {
      result = { success: false, error: '更新模块不可用' };
    }
    if (!result.success) {
      showFailure('检查失败', result.error || '未知错误', result.manualUrl);
    }
  } catch (err) {
    showFailure('检查失败', errBrief(err), null);
  }
  _updateState.checking = false;
}

window.checkForUpdate = checkForUpdate;

async function downloadUpdate() {
  _updateState.downloading = true;
  showUpdate(`
    <div style="padding:4px 0;">
      <div style="margin-bottom:6px;">📥 正在下载更新...</div>
      <div style="height:6px;background:rgba(0,212,255,0.15);border-radius:3px;overflow:hidden;">
        <div id="update-progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,var(--neon-cyan),var(--neon-green));transition:width 0.3s;"></div>
      </div>
      <div id="update-progress-text" style="font-size:12px;color:var(--text-dim);margin-top:4px;">0%</div>
    </div>
  `);
  // 真正触发主进程下载（进度经 update-download-progress 事件回填）；
  // 此前这里只画了个 0% 假进度条，通道从未被调用，按钮形同虚设
  try {
    let result;
    if (window.ipcRenderer && window.ipcRenderer.invoke) {
      result = await window.ipcRenderer.invoke('download-update');
    } else if (window.musicAPI && window.musicAPI.downloadUpdate) {
      result = await window.musicAPI.downloadUpdate();
    } else {
      result = { success: false, error: '更新模块不可用' };
    }
    if (result && result.success === false) {
      _updateState.downloading = false;
      showFailure('下载失败', result.error || '未知错误', result.manualUrl);
    }
  } catch (err) {
    _updateState.downloading = false;
    showFailure('下载失败', errBrief(err), null);
  }
}

function handleDownloadProgress(percent) {
  const bar = document.getElementById('update-progress-bar');
  const text = document.getElementById('update-progress-text');
  if (bar) bar.style.width = percent + '%';
  if (text) text.textContent = percent + '%';
}

function handleUpdateAvailable(version, releaseNotes) {
  _updateState.available = true;
  // releaseNotes 来自 GitHub Release 描述（外部内容），必须先转义再插入
  // innerHTML，否则可注入任意 HTML/JS（配合 CSP unsafe-inline 即 XSS）。
  // 原 bug：replace(/\\n/g) 匹配的是字面反斜杠+n，真正的换行符从未被转换。
  const escHtml = window.esc || (s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  const safeNotes = (releaseNotes && typeof releaseNotes === 'string')
    ? escHtml(releaseNotes).replace(/\r?\n/g, '<br>')
    : '';
  const versionText = escHtml(version);
  showUpdate(`
    <div style="padding:4px 0;">
      <div style="margin-bottom:8px;">
        <span style="font-size:18px;">🎉</span>
        <span style="font-weight:bold; color:var(--neon-green);">发现新版本 v${versionText}</span>
      </div>
      ${safeNotes ? `<div style="font-size:12px; color:var(--text-dim); margin-bottom:10px; max-height:80px; overflow-y:auto;">${safeNotes}</div>` : ''}
      <div style="display:flex; gap:8px;">
        <button onclick="window.downloadUpdate()" style="flex:1;padding:8px;background:var(--neon-cyan);color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">下载更新</button>
        <button onclick="window.closeUpdateToast()" style="padding:8px 12px;background:transparent;border:1px solid var(--border-color);color:var(--text-primary);border-radius:6px;cursor:pointer;">稍后</button>
      </div>
    </div>
  `);
}

function handleUpdateNotAvailable() {
  showUpdate(`
    <div style="text-align:center; padding:10px 0;">
      <div style="font-size:20px; margin-bottom:4px;">✅</div>
      <div>已是最新版本</div>
    </div>
  `);
  setTimeout(closeUpdateToast, 3000);
}

function handleUpdateDownloaded(version) {
  _updateState.downloading = false;
  showUpdate(`
    <div style="padding:4px 0;">
      <div style="margin-bottom:8px;">
        <span style="font-size:18px;">✅</span>
        <span style="font-weight:bold; color:var(--neon-green);">v${esc(version)} 下载完成</span>
      </div>
      <div style="display:flex; gap:8px;">
        <button onclick="window.restartAndInstall()" style="flex:1;padding:8px;background:var(--neon-green);color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">立即重启安装</button>
        <button onclick="window.closeUpdateToast()" style="padding:8px 12px;background:transparent;border:1px solid var(--border-color);color:var(--text-primary);border-radius:6px;cursor:pointer;">稍后</button>
      </div>
    </div>
  `);
}

function handleUpdateError(message, manualUrl) {
  showFailure('更新失败', message, manualUrl);
}

window.downloadUpdate = downloadUpdate;
window.restartAndInstall = () => {
  window.musicAPI.restartAndInstall?.();
};

// ── 监听主进程 IPC 事件 ────────────────────────────────
// 注意：preload 兼容桥的 on(channel, cb) 展开为 cb(data)——只传 data 一个参数，
// 不是原生 ipcRenderer.on 的 (event, data)。
if (window.ipcRenderer) {
  window.ipcRenderer.on('update-available', (info) => {
    handleUpdateAvailable(info.version, info.releaseNotes);
  });
  window.ipcRenderer.on('update-not-available', () => {
    if (_updateState.checking) handleUpdateNotAvailable();
  });
  window.ipcRenderer.on('update-download-progress', (info) => {
    handleDownloadProgress(info.percent);
  });
  window.ipcRenderer.on('update-downloaded', (info) => {
    handleUpdateDownloaded(info.version);
  });
  window.ipcRenderer.on('update-error', (info) => {
    handleUpdateError(info.message, info.manualUrl);
  });
}

// ── 设置页「检查更新」按钮事件 ────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('checkUpdateBtn');
  if (btn) {
    btn.addEventListener('click', checkForUpdate);
  }
});
