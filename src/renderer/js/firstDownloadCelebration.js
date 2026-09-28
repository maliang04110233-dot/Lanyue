/**
 * 首个下载成功的 moment-of-truth 庆祝（增量177）
 *
 * check 走查明确标出：旅程 Activation 阶段的关键时刻「首次下载成功给仪式感确认」
 * 没有落地——第一首歌和第三首歌得到完全相同的对待。对新手而言，第一次成功同时是
 * 最大的疑问时刻：「下好了，文件呢？能离线听吗？」本模块在那一刻补一条一次性引导：
 * 庆祝文案（成功色 toast）+「📂 打开文件夹」走既有 openFolder 通道 + 指认队列行
 * 既有的 ▶ 播放与 📂 按钮。零新 IPC、零新 CSS（.toast-success 早已在 base.css）。
 *
 * 三道门槛（都有测试钉住，缺一不可，防止把庆祝变成骚扰）：
 *  1) 本会话必须先亲眼见过活跃任务（pending/downloading）再见到 done——
 *     与 afterQueueDone 同款的「启动恢复的全终态队列不误触」纪律；
 *  2) pref firstDownloadCelebrated 没记过——跨会话只此一次；
 *  3) 历史统计 done ≤ 1（就是刚下的这条）——老用户升级后第一次下载不谎报"第一次"，
 *     判为老用户则静默记 pref 短路，之后每次启动零开销。
 * 读 pref / 统计失败时保守跳过（宁可不弹，也不误弹）。
 */

import { logger } from './logger.js';

/** pref 键：全仓唯一家，测试按字面量记账 */
export const WELCOME_PREF_KEY = 'firstDownloadCelebrated';

/** 纯函数：这一行算不算「下载成功」——done 且有落盘路径 */
export function isDoneRow(row) {
  return !!(row && row.status === 'done' && (row.savePath || row.filePath));
}

/** 纯函数：队列快照里有没有活跃任务（本会话亲眼见过下载在跑） */
export function hasActiveRow(queue) {
  return Array.isArray(queue)
    && queue.some((s) => s && (s.status === 'pending' || s.status === 'downloading'));
}

/**
 * 纯状态机（依赖全部注入，Node 里直接测）。
 * @param {object}   cfg
 * @param {function} cfg.getPref        async (key) => value
 * @param {function} cfg.setPref        async (key, value) => any
 * @param {function} cfg.getHistoryStats async () => { done, ... }
 * @param {function} cfg.onCelebrate    (doneRow) => void —— 真弹层在模块底部接
 */
export function createFirstDownloadMachine(cfg) {
  const { getPref, setPref, getHistoryStats, onCelebrate } = cfg || {};
  let _sawActive = false;   // 本会话是否见过下载真的在跑
  let _busy = false;        // 判定链在途（异步读 pref/统计期间不重入）
  let _settled = false;     // 本会话终局：庆祝过 / 老用户 / 出错保守跳过
  let _pending = Promise.resolve();

  async function _resolve(doneRow) {
    let celebrated = false;
    try {
      if (await getPref(WELCOME_PREF_KEY)) return; // 门槛2：跨会话只此一次
      const stats = await getHistoryStats();
      const doneCount = Number(stats && stats.done);
      if (Number.isFinite(doneCount) && doneCount > 1) {
        // 门槛3：老用户升级后新下载——静默记 pref，不谎报"第一次"
        await setPref(WELCOME_PREF_KEY, '1');
        return;
      }
      await setPref(WELCOME_PREF_KEY, '1');
      celebrated = true;
      onCelebrate(doneRow);
    } catch (e) {
      // 任何一步失败都不打扰用户；原始栈文本只进开发日志
      logger.warn('firstDownloadCelebration: 判定失败，跳过庆祝', e);
      if (!celebrated) {
        try { await setPref(WELCOME_PREF_KEY, '1'); } catch { /* 尽力而为 */ }
      }
    }
  }

  return {
    observe(queue) {
      if (_settled || _busy) return;
      if (hasActiveRow(queue)) _sawActive = true;
      if (!_sawActive) return; // 门槛1：没见过活跃任务的 done 是启动恢复的旧队列
      const doneRow = Array.isArray(queue) ? queue.find((s) => isDoneRow(s)) : null;
      if (!doneRow) return;
      _busy = true;
      _pending = _resolve(doneRow).finally(() => {
        _busy = false;
        _settled = true; // 一个会话只走一次判定链
      });
    },
    /** 测试钩子：等判定链落地 */
    idle() { return _pending; },
  };
}

// ── 真接线：全局观察器（app.js onQueueUpdated 调用，与 afterQueue/autoLyric/autoCover 同谱）──

let _machine = null;

/** 庆祝弹条：showActionToast 唯一实现 + tone=success 成功色，动作走既有 openFolder */
function _celebrate(doneRow) {
  const title = doneRow.title || '你的歌';
  window.showActionToast({
    tone: 'success',
    text: `🎉 第一次下载成功！「${title}」已经存进本地曲库所在文件夹，戴上耳机就能离线听。点右侧按钮直达文件，或随时点队列行里的 ▶ 播放、📂 打开文件夹。`,
    btnLabel: '📂 打开文件夹',
    ttl: 9000,
    onConfirm() {
      const p = doneRow.savePath || doneRow.filePath;
      if (p) openFolderSafe(p);
    },
  });
}

/** 队列推送入口（app.js 调用）。无 api（测试 Node 环境）时静默。 */
export function firstDownloadCelebrateObserve(queue) {
  if (typeof api === 'undefined' || typeof window === 'undefined') return;
  if (typeof window.showActionToast !== 'function') return;
  if (!_machine) {
    _machine = createFirstDownloadMachine({
      getPref: (k) => api.getPref(k),
      setPref: (k, v) => api.setPref(k, v),
      getHistoryStats: () => api.getHistoryStats(),
      onCelebrate: _celebrate,
    });
  }
  _machine.observe(queue);
}

window.firstDownloadCelebrateObserve = firstDownloadCelebrateObserve;
