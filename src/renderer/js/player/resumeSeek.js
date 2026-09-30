/**
 * 续播 seek 落点（根因 2）
 *
 * 问题
 * ----
 * loadAndPlay 两个分支的写法相同：
 *
 *     audio.src = url;                            // 开始加载
 *     const saved = await restorePlayProgress(song);   // 内含两次 await api.getPref
 *     if (saved > 0) attachResumeSeekListener(audio, saved);
 *
 * restorePlayProgress 是异步的，**await 期间媒体可能已经就绪**，
 * loadedmetadata 事件在监听挂上之前就发完了。
 * 事后挂的监听永远收不到这次事件，seek 静默不执行 —— 表现是从 0 开始播，
 * 没有任何报错，用户只会以为"进度没记住"。
 *
 * M7 修的是另一个方向：歌 A 的监听泄漏到歌 B。
 * 同一个函数上还挂着第二个缺陷，两个方向都得治，所以监听要挂两处。
 *
 * 为什么单独成文件
 * ----------------
 * player.js 顶层就 `document.getElementById('audioPlayer')` 并 import 十余个
 * 依赖单测环境没有的东西。seek 落点本身无状态、无 DOM 依赖，
 * 抽出来才能在测试里对着一个假 audio 元素真跑一遍这个竞态。
 *
 * 契约
 * ----
 *   createResumeSeeker({ onSeek }) → { attach(audio, savedTime), cancel() }
 *   attach 幂等：重复调用只保留最后一次的 pending 监听。
 *   seek 条件：audio.duration > savedTime（进度不能超过时长）。
 */

/** 媒体已就绪的 readyState（HAVE_METADATA）—— 与 loadedmetadata 的判据一致 */
const HAVE_METADATA = 1;

/**
 * @param {{onSeek?: (audio:any, t:number)=>void}} [deps]
 *   onSeek 真正执行 seek 时的回调（提示文案等副作用交给调用方）
 */
export function createResumeSeeker(deps = {}) {
  const onSeek = typeof deps.onSeek === 'function' ? deps.onSeek : () => {};
  /** 当前待触发的监听与它绑定的 audio —— 二者必须成对，否则会在别的歌上触发 */
  let pending = null;

  function doSeek(audio, savedTime) {
    // 进度 >= 整首时长说明是坏数据（换了版本、时长变了），跳过去会停在结尾
    if (!(audio.duration > savedTime)) return false;
    audio.currentTime = savedTime;
    onSeek(audio, savedTime);
    return true;
  }

  return {
    /**
     * 挂上"metadata 就绪后 seek 到 savedTime"
     * 已经就绪（竞态已发生）则立即 seek，不等下一次事件。
     */
    attach(audio, savedTime) {
      this.cancel();
      const handler = () => doSeek(audio, savedTime);
      pending = { audio, handler };
      audio.addEventListener('loadedmetadata', handler);
      // TOCTOU 补口：await 期间 metadata 已到，此刻 readyState 已 >= 1。
      // 少了这一句，事件早已发完，seek 永远不执行。
      if (audio.readyState >= HAVE_METADATA) {
        this.cancel();
        doSeek(audio, savedTime);
      }
    },

    /** 撤掉尚未触发的监听（切歌时调，防泄漏到下一首） */
    cancel() {
      if (!pending) return;
      pending.audio.removeEventListener('loadedmetadata', pending.handler);
      pending = null;
    },

    /** 供诊断/测试读取当前是否还有挂着的监听 */
    hasPending() {
      return !!pending;
    },
  };
}
