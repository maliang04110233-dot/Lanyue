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
 *   监听只活一次：loadedmetadata 触发后（无论 seek 是否成立）即自我撤销 ——
 *   渲染层共用同一个 audio 元素，留着它等于把上一首的进度带给下一首。
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

  /** 撤掉尚未触发的监听。抽成函数是因为处理函数自己也要调它 —— 见 attach 里那句 */
  function clearPending() {
    if (!pending) return;
    pending.audio.removeEventListener('loadedmetadata', pending.handler);
    pending = null;
  }

  return {
    /**
     * 挂上"metadata 就绪后 seek 到 savedTime"
     * 已经就绪（竞态已发生）则立即 seek，不等下一次事件。
     */
    attach(audio, savedTime) {
      clearPending();
      const handler = () => {
        // loadedmetadata 每个 src 只发一次，所以这次触发就是这条监听的最后一次
        // 用处；不管 seek 成不成立都得先把自己摘掉。渲染层共用同一个 audio 元素，
        // 摘不干净它就活到下一首歌上：下一首若没有进度记忆（压根不会 attach），
        // 陈旧监听照样会在它的 metadata 上把新歌 seek 到上一首的位置 ——
        // 用户看到的是"没听过的歌从中间开始播"。
        clearPending();
        doSeek(audio, savedTime);
      };
      pending = { audio, handler };
      audio.addEventListener('loadedmetadata', handler);
      // TOCTOU 补口：await 期间 metadata 已到，此刻 readyState 已 >= 1。
      // 少了这一句，事件早已发完，seek 永远不执行。
      if (audio.readyState >= HAVE_METADATA) {
        clearPending();
        doSeek(audio, savedTime);
      }
    },

    /** 撤掉待触发监听（切歌时调，防泄漏到下一首） */
    cancel() {
      clearPending();
    },

    /** 供诊断/测试读取当前是否还有挂着的监听 */
    hasPending() {
      return !!pending;
    },
  };
}
