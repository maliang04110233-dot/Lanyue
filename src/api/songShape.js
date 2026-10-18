/**
 * 各平台「歌曲」条目的规范结构 + 收敛助手
 *
 * ── 为什么需要它 ─────────────────────────────────────────
 * 每个平台的搜索解析各写一份 `{title, artist, ...}` 字面量，字段取值只能
 * 平台内自己写（API 形状不同），但「最终形状」却没有任何一处文档承载：
 * 新平台加音源时只能照抄别的平台，duration 的单位约定尤其靠口口相传
 * （曾出现过「秒 vs 毫秒」二义）。本模块把形状契约变成代码 + 注释。
 *
 * ── 字段约定（加新平台照此，详见 docs/architecture/ADD-A-PLATFORM.md）──
 *   id        非空字符串。可为平台内编码产物（如 kugou 的三 hash 编码）。
 *   title     非空字符串（平台解析负责去 HTML 标签等）。
 *   artist    已连接好的字符串。⚠️ 连接符是**按平台有意不同**的现状约定，
 *             勿「顺手统一」：netease/qq 用 ' / '，migu/soda 用 '、'，
 *             kuwo 用 ', ' —— 下游显示与文件名解析按现状工作，统一会
 *             改变用户可见行为。
 *   album     可空字符串。
 *   cover     URL 或 ''。空封面必须有兜底（下载/匹配各自处理）。
 *   duration  ⚠️ 毫秒整数。平台源数据是秒的（qq interval / kugou Duration /
 *             kuwo DURATION / bilibili "mm:ss"）必须在*平台文件里*折算，
 *             搜索接口不返回时长的报 0（migu / fivesing）。soda 分享页是
 *             秒、entity.track 是毫秒，注意区分。
 *   source    平台 id，等于 pluginRegistry 里注册的 id。
 *
 * ── asSong 不做的事（刻意为之）─────────────────────────
 *   - 不丢弃任何条目：id/title 为空的守卫留在各平台（各平台丢单条件
 *     不同，如 migu 要求双非空、kuwo 只筛 id——行为被 fixture 测试
 *     钉住，收拢到一处会改变丢单集合）。
 *   - 不触碰平台扩展字段：netease 的 fee/albumMid、qq 的
 *     pay/numId/albumMid/mid/aid 是下游 VIP 判断与跳转依赖，透传保留。
 *   - 只做类型收敛：把 API 回来可能是 null/NaN/数字字符串的核心字段
 *     收敛成上面约定的类型，杜绝 NaN 流进渲染层。
 *
 * @param {object} song 平台已按「字段取值」组装好的歌曲对象（可带扩展字段）
 * @returns {object} 收敛后的规范歌曲对象
 */
function asSong(song) {
  const d = Number(song.duration);
  return {
    ...song,
    id: String(song.id ?? ''),
    title: String(song.title ?? ''),
    artist: song.artist == null ? '' : String(song.artist),
    album: song.album == null ? '' : String(song.album),
    cover: song.cover == null ? '' : String(song.cover),
    duration: Number.isFinite(d) ? d : 0,
    source: String(song.source ?? ''),
  };
}

module.exports = { asSong };
