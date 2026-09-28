/**
 * 下载历史 IPC
 *
 * 注册：query-history / history-stats / clear-history / remove-history
 *
 * query-history 的 opts 是自由对象（契约 t.obj()），由此多接一个只读开关
 * markMissing：渲染层要如实告诉用户"这条记录的文件已经不在磁盘上了"，而渲染层没有
 * fs，判活只能在主进程做 —— 为此开新通道不值当，判活也只是查询结果上的一个附加字段。
 */

const { handle } = require('./register');
const history = require('../../utils/history');
const { markMissing, pickDeadEntries } = require('../../utils/deadRefs');
// 主进程即 UI 线程：判活必须异步 stat
const fsa = require('../../utils/fsAsync');
const logger = require('../../utils/logger');

function register() {
  handle('query-history', async (_, opts) => {
    const o = opts || {};
    const result = history.query(o);
    if (!o.markMissing) return result;
    try {
      result.items = await markMissing(result.items || [], fsa.exists);
      // 「哪些算可删的死账」这条规则只许有一处（渲染层再抄一份必然漂移）：
      // 主进程判完顺手把待删清单算好带上，前端只管报数、确认、送进 remove-history。
      result.deadEntries = pickDeadEntries(result.items);
    } catch (e) {
      // 判活失败不该让整页历史打不开：照常返回，只是少了 missing / deadEntries
      logger.warn('[query-history] 判活失败:', e.message);
    }
    return result;
  });
  handle('history-stats', () => history.stats());
  handle('clear-history', () => { history.clear(); return true; });
  handle('remove-history', (_, entries) => ({ removed: history.remove(entries) }));
}

module.exports = { register };
