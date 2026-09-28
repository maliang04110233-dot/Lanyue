/**
 * 队列完成后动作 —— 下载队列全部结束时自动 退出/睡眠/关机
 *
 * 检测在渲染层（onQueueUpdated 流里），执行走主进程 system-power 通道
 * （动作枚举白名单，命令是常量，无任何用户可控拼接）。
 * 核心 createAfterQueueMachine 为纯状态机，node 可单测；
 * 「必须先见到活跃任务，再见到全终态」才触发一次 —— 启动时从
 * 持久化队列恢复出的「已完成」不会误触。
 * 睡眠/关机给 60 秒可取消倒计时（纯 JS 侧延时，取消即什么都不会发生）。
 */

import { showContextMenu } from './contextMenu.js';
import { logger } from './logger.js';

const ACTIONS = [
  { value: 'none', label: '无' },
  { value: 'quit', label: '退出应用' },
  { value: 'sleep', label: '进入睡眠' },
  { value: 'shutdown', label: '关机' },
];
const COUNTDOWN_SECONDS = 60;

const ACTIVE_STATUSES = new Set(['pending', 'downloading']);
const FINISHED_STATUSES = new Set(['done', 'error']);

function hasActiveTasks(tasks) {
  return Array.isArray(tasks) && tasks.some(x => x && ACTIVE_STATUSES.has(x.status));
}

function isQueueFinished(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return false;
  return tasks.every(x => x && FINISHED_STATUSES.has(x.status));
}

/**
 * @param {Object} deps
 * @param {() => string} deps.getAction 当前动作（'none' 表示不做）
 * @param {(action: string, tasks: Array) => void} deps.onFire
 */
function createAfterQueueMachine({ getAction, onFire }) {
  let _seenActive = false;
  let _fired = false;

  return {
    observe(tasks) {
      if (!Array.isArray(tasks)) return;
      if (hasActiveTasks(tasks)) { _seenActive = true; _fired = false; return; }
      if (!_seenActive || _fired || !isQueueFinished(tasks)) return;
      _fired = true;
      _seenActive = false;
      const action = getAction();
      if (!action || action === 'none') return;
      try { onFire(action, tasks); } catch (e) { logger.warn('[afterQueueDone] onFire 失败:', e && e.message); }
    },
    reset() { _seenActive = false; _fired = false; },
  };
}

// ── UI 单例 ──────────────────────────────────────────
let _machine = null;
let _action = null;   // null = 尚未从 prefs 读出
let _loading = false;
let _cdTimer = null;
let _cdLeft = 0;

function _act() {
  if (!_machine) _machine = createAfterQueueMachine({ getAction: () => _action || 'none', onFire: _fire });
  return _machine;
}

function _ensureAction() {
  if (_action !== null || _loading) return;
  _loading = true;
  Promise.resolve()
    .then(() => window.api.getPref('afterQueueDone'))
    .then(v => {
      _action = ACTIONS.some(a => a.value === v) ? v : 'none';
      _renderLabel();
    })
    .catch(e => { logger.warn('[afterQueueDone] 读取偏好失败:', e && e.message); _action = 'none'; })
    .finally(() => { _loading = false; });
}

function _renderLabel() {
  const el = document.getElementById('afterQueueLabel');
  const found = ACTIONS.find(a => a.value === (_action || 'none'));
  if (el) el.textContent = found ? found.label : '无';
}

function _fire(action) {
  if (action === 'quit') {
    showToast('🏁 下载队列已完成，正在退出应用…', 'info', 4000);
    window.api.systemPower('quit').catch(e => logger.warn('[afterQueueDone] 退出失败:', e && e.message));
    return;
  }
  if (action === 'sleep' || action === 'shutdown') _startCountdown(action);
}

// ── 60 秒可取消倒计时 ────────────────────────────────
function _overlay() {
  let el = document.getElementById('afterQueueOverlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'afterQueueOverlay';
  el.className = 'edit-overlay hidden';
  el.setAttribute('data-modal', '');
  el.setAttribute('data-modal-close', 'cancelAfterQueueCountdown');
  el.innerHTML = `
    <div class="edit-panel" style="width:400px;">
      <div class="edit-header">
        <span class="edit-title" id="afterQueueCdTitle">🏁 队列已完成</span>
        <button class="edit-close" onclick="cancelAfterQueueCountdown()">✕</button>
      </div>
      <div class="edit-body">
        <div class="batch-import-status" id="afterQueueCdText"></div>
      </div>
      <div class="edit-footer">
        <button class="edit-btn-save" onclick="cancelAfterQueueCountdown()">取消</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function _renderCountdown(action) {
  const label = action === 'shutdown' ? '关机' : '睡眠';
  const text = document.getElementById('afterQueueCdText');
  if (text) text.textContent = `${_cdLeft} 秒后自动${label}，点「取消」可中止`;
}

function _startCountdown(action) {
  _stopCountdown();
  _cdLeft = COUNTDOWN_SECONDS;
  const el = _overlay();
  el.classList.remove('hidden');
  _renderCountdown(action);
  _cdTimer = setInterval(() => {
    _cdLeft--;
    if (_cdLeft <= 0) {
      _stopCountdown();
      window.api.systemPower(action).catch(e => logger.warn('[afterQueueDone] 执行失败:', e && e.message));
      return;
    }
    _renderCountdown(action);
  }, 1000);
}

function _stopCountdown() {
  if (_cdTimer !== null) { clearInterval(_cdTimer); _cdTimer = null; }
  const el = document.getElementById('afterQueueOverlay');
  if (el) el.classList.add('hidden');
}

function cancelAfterQueueCountdown() {
  if (_cdTimer === null) return;
  _stopCountdown();
  showToast('已取消，不再执行完成后动作', 'info', 2500);
}

// ── 菜单 ─────────────────────────────────────────────
function openAfterQueueMenu() {
  _ensureAction();
  const items = ACTIONS.map(a => ({
    icon: a.value === (_action || 'none') ? '✓' : '🏁',
    label: a.label,
    onClick: () => {
      _action = a.value;
      _renderLabel();
      window.api.setPref('afterQueueDone', a.value)
        .catch(e => logger.warn('[afterQueueDone] 保存偏好失败:', e && e.message));
      if (a.value !== 'none') showToast(`🏁 队列完成后将：${a.label}`, 'info', 2500);
    },
  }));
  const btn = document.getElementById('afterQueueBtn');
  let x = 300, y = 300;
  if (btn) {
    const r = btn.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  }
  showContextMenu(x, y, items);
}

function afterQueueObserve(queue) {
  _ensureAction();
  _act().observe(queue);
}

/**
 * 默认态：设置页「恢复所有设置」叫这一家。
 * 必须连内存里的 _action 一起归零 —— 只清 pref 的话，本次会话下一次队列跑完
 * 照样按旧动作关机；倒计时已经在跑时更要当场掐掉。
 */
function resetAfterQueueAction() {
  cancelAfterQueueCountdown();
  _action = 'none';
  _renderLabel();
  window.api.setPref('afterQueueDone', 'none')
    .catch(e => logger.warn('[afterQueueDone] 恢复默认失败:', e && e.message));
}

// ── window 桥接 ───────────────────────────────────────
window.openAfterQueueMenu = openAfterQueueMenu;
window.afterQueueObserve = afterQueueObserve;
window.cancelAfterQueueCountdown = cancelAfterQueueCountdown;
window.resetAfterQueueAction = resetAfterQueueAction;

export { createAfterQueueMachine, isQueueFinished, hasActiveTasks, openAfterQueueMenu, afterQueueObserve, resetAfterQueueAction, ACTIONS, COUNTDOWN_SECONDS };
