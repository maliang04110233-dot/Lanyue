/**
 * 连续播放失败熔断 —— 纯工厂（node 可单测，顶层不碰 window）
 *
 * 为什么要有这个
 * --------------
 * audio 的 error 事件此前是「无条件 toast + 无条件 nextSong」，而 nextSong 在
 * 循环模式（loopMode===1）下是 `(playIdx + 1) % length` 的**无限**循环。
 * 于是**一次**失败会被放大成：
 *   失败 → toast → 跳下一曲 → 新 src 的 play() 被 autoplay 策略拦截 → 又一条 toast
 *        → 加载又失败 → ……
 * 实测（用户截图实证）：十几条「音源播放出错」与「自动播放被拦截」交替糊满整屏，
 * 歌单被完全遮住、界面不可操作。根因可能是网络或音源本身，但**放大器是这个**——
 * 不管根因是什么，一次失败都不该有能力接管整个界面。
 *
 * 只做计数与判定，**不碰播放控制**
 * --------------------------------
 * 拿到 tripped 之后要不要停、怎么停，由调用方决定；不让纯函数反过来绑架播放器。
 * 同理不自动 reset：熔断后清零与否，是"用户是否已用手动操作表达了新意图"的问题，
 * 调用方答得了（手动操作会走 succeed/reset 两条路之一）。
 *
 * 阈值为什么是 3
 * --------------
 * 连着 3 首起不来，基本可以断定不是"这一首的锅"（单曲问题早该由 describePlayError
 * 分流成 VIP / 本地文件丢失），继续跳只是刷屏。
 */
const DEFAULT_THRESHOLD = 3;

function createPlayFailGuard({ threshold = DEFAULT_THRESHOLD } = {}) {
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new TypeError('threshold 必须是 >= 1 的整数');
  }
  let streak = 0;
  return {
    /**
     * 记一次失败
     * @returns {{streak:number, tripped:boolean, threshold:number}} tripped=true 表示该停了
     */
    fail() {
      streak += 1;
      return { streak, tripped: streak >= threshold, threshold };
    },
    /** 真的播起来过一次：偶发失败不该拖垮整轮，计数归零 */
    succeed() {
      streak = 0;
    },
    /** 当前已连续失败几曲（给文案与测试用） */
    get streak() {
      return streak;
    },
    /** 归零：熔断后调用，让用户手动操作有新的几次机会 */
    reset() {
      streak = 0;
    },
  };
}

export { createPlayFailGuard, DEFAULT_THRESHOLD };