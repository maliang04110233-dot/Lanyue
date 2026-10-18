/**
 * 播放进度记忆的串行写入（第 2 条缺陷，口径 B）
 *
 * 问题
 * ----
 * 写入是「读 → 改 → 整体写回」三步，而三个写者各自独立触发、没有排队：
 *   1. 30 秒自动保存（timeupdate）
 *   2. 暂停（togglePlay）
 *   3. 播完写 0（onAudioEnded）
 *
 * 两次读改写交错时，后落地那次用的是自己那次读到的陈旧快照整体覆盖 ——
 * 典型症状是「进度没记住」，或者明明播完的歌又冒出进度
 * （0 先写进去，紧接着被暂停那次的快照顶回几十秒）。
 *
 * 这里把整段读改写排成一条 FIFO 队列：上一次的写落完才放下一次，
 * 于是每一次「读」看到的都是前一次「写」之后的状态。
 *
 * 契约
 * ----
 *   createProgressWriter({ getPref, setPref, now?, cap? }) → { save(key, time) }
 *   save 返回的 promise 在「这一次」写入落地后 resolve；
 *   任一次读写失败只吃掉那一次，不得让队列停在 rejected 的 tail 上。
 *   savedAt 在队列内部取时，因此随发起顺序单调不减 —— 裁剪看的就是这个字段。
 *
 * 为什么单独成文件
 * ----------------
 * player.js 顶层依赖 audioPlayer 元素与十余个 import，测试里拉不起来；
 * 队列本身不碰 DOM，注入一对假 prefs 就能真跑交错。
 * 与 player/resumeSeek.js 同一个理由、同一套做法。
 */

/** 进度记忆最多留多少首（超出按 savedAt 裁掉最旧的） */
const DEFAULT_CAP = 200;

/**
 * @param {{getPref: (key:string)=>Promise<any>, setPref: (key:string,value:any)=>Promise<any>,
 *          now?: ()=>number, cap?: number}} deps prefs 读写由调用方注入（渲染层是 window.api）
 */
export function createProgressWriter(deps) {
  const { getPref, setPref } = deps;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const cap = Number.isFinite(deps.cap) && deps.cap > 0 ? deps.cap : DEFAULT_CAP;

  /** 队列尾：下一次必须等它完成。初始为已完成的 resolved promise。 */
  let tail = Promise.resolve();

  async function run(key, time) {
    try {
      const enabled = await getPref('playProgressMemory');
      if (!enabled) return;
      const map = (await getPref('playProgressMap')) || {};
      map[key] = { time, savedAt: now() };
      const entries = Object.entries(map);
      if (entries.length > cap) {
        entries.sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0));
        await setPref('playProgressMap', Object.fromEntries(entries.slice(-cap)));
      } else {
        await setPref('playProgressMap', map);
      }
    } catch (_e) { /* 记不住进度不影响播放本身 */ }
  }

  return {
    save(key, time) {
      const next = tail.then(() => run(key, time));
      // run 内部已经吞掉所有异常，next 恒为 fulfilled；即便如此仍把 tail 指向 next ——
      // 若哪天 run 真的 reject（比如注入的 getPref 非函数），队列不能永久卡死。
      tail = next.catch(() => {});
      return next;
    },
  };
}
