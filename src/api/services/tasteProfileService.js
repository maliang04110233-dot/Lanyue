/**
 * 品味解读服务（候选方向 2：口味画像）—— 纯函数 + 依赖注入，单测不触网
 *
 * 对应竞品已验证的方向（网易云小宝「红心歌单锐评/情绪走向」）：给用户一份
 * 「AI 看懂了你最近在听什么」的画像。本模块只做三件事 —— 组统计摘要、组提示、
 * 清洗回复；出网与缓存/凭据在主进程侧（src/main/ipc/tasteProfile.js）。
 *
 * 两条纪律（写进系统提示，不是软约束）：
 *   ① 隐私：出网的只有**统计摘要**（歌手/曲风的次数、时段、时长分布），
 *      不出现具体歌名、id、下载路径；系统提示明确「只能依据给出的统计摘要谈，
 *      不许推测具体听没听某首歌」；
 *   ② 不编造：播放量级、日期、排名这类不确定的具体数字一律不写，宁缺毋错。
 *
 * 回复一律裁剪到上限；坏回复不该把界面刷爆。
 */

const MAX_REPORT_CHARS = 2500;
// 歌手聚合上限：喂给模型的「全部世界」不必无限，超出的部分对画像结论不再敏感
const MAX_ARTISTS = 40;

/** 界面语言 → 输出语言措辞（未登记的键回落简体中文） */
const LANG_NAMES = Object.freeze({
  zh: '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
});

/**
 * 从播放统计里取「可出网」的画像素材。
 * 只回统计量，绝不把 playCount 的键（即歌名+歌手）原样端出去 ——
 * 那等于把用户的曲库明细直接喂给模型（AI 音乐猎手需求判断里的隐私红线）。
 * 歌手名是画像的必要输入（「你最近密集听 XX 系」必须能说出口），
 * 按次数排序、截到上限，属于最小必要；其余（时段、时长分布）只留聚合数字。
 *
 * @param {Object} stats playStats 原样（playCount/daily/totalPlayTime/totalSongs/lastPlayed）
 * @returns {{ok:boolean, error?:string, digest?:Object}}
 */
function buildDigest(stats) {
  const s = (stats && typeof stats === 'object') ? stats : {};
  const playCount = (s.playCount && typeof s.playCount === 'object') ? s.playCount : {};
  const entries = Object.entries(playCount).filter(([, c]) => Number(c) > 0);
  if (!entries.length) return { ok: false, error: 'NO_PLAYDATA' };

  const artists = new Map(); // artist → 次数（一首多歌手取键内原样，不拆分）
  let songs = 0;
  let totalCount = 0;
  let top = null;
  for (const [key, raw] of entries) {
    const count = Number(raw) || 0;
    songs++;
    totalCount += count;
    const artist = String(String(key || '').split('|||')[1] || '').trim();
    if (artist) artists.set(artist, (artists.get(artist) || 0) + count);
    if (!top || count > top.count) {
      top = { title: String(key.split('|||')[0] || '').trim(), artist, count };
    }
  }

  // 时段分布：daily 只记日、记不下钟点，所以时段画像退化为「周内作息」
  // （见 buildSlotProfile），这里只汇总活跃日与总秒数。
  const daily = (s.daily && typeof s.daily === 'object') ? s.daily : {};
  const slotsProfile = buildSlotProfile(daily);
  let dailyActiveDays = 0;
  let dailyTotalSec = 0;
  for (const raw of Object.values(daily)) {
    const secs = Number(raw) || 0;
    if (secs <= 0) continue;
    dailyActiveDays++;
    dailyTotalSec += secs;
  }

  const topArtists = [...artists.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, MAX_ARTISTS)
    .map(([artist, count]) => ({ artist, count }));

  return {
    ok: true,
    digest: {
      // 隐私边界：具体歌名不出网。top 仅描述「重复度最高的那一首的歌手」，
      // title 本身也不传（一首具体歌的标题 = 曲库明细）。
      mostRepeatedArtist: top ? top.artist : '',
      totalPlayTimeSec: Math.max(0, Number(s.totalPlayTime) || 0),
      distinctSongs: songs,
      totalPlays: totalCount,
      distinctArtists: topArtists.length,
      topArtists,
      slots: slotsProfile,
      activeDays: dailyActiveDays,
      dailySecs: dailyTotalSec,
      lastPlayedArtist: String((s.lastPlayed && s.lastPlayed.artist) || '').trim(),
      // 供缓存签名：不把歌手列表整个 hash 进去，只带长度与次数总量，
      // 否则每次多听一首都换签名、缓存永远不命中（见 ipc/tasteProfile.js）。
    },
  };
}

/**
 * 时段画像：daily 只记日，记不下钟点。为了不编数据，这里把「最近 N 天」的
 * 活跃日按星期投影（周一~周日），得到的是**周内作息**而不是某天的分布，
 * 是 daily 数据能支撑的最诚实结论。无 daily 数据时回空数组（不造 0）。
 */
function buildSlotProfile(daily) {
  const src = (daily && typeof daily === 'object') ? daily : {};
  const buckets = new Array(7).fill(0); // 0=周日 ... 6=周六
  for (const [key, raw] of Object.entries(src)) {
    const secs = Number(raw) || 0;
    if (secs <= 0) continue;
    const d = new Date(`${key}T12:00:00`);
    if (Number.isNaN(d.getTime())) continue;
    buckets[d.getDay()] += secs;
  }
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return buckets
    .map((secs, i) => ({ weekday: names[i], secs, pct: Math.round((secs / total) * 100) }))
    .filter((b) => b.secs > 0)
    .sort((a, b) => b.secs - a.secs);
}

/**
 * 播放统计 → 一句「出网摘要」文本。
 * 隐私边界在此收口：不出现具体歌名，只出现歌手聚合与时段聚合。
 * @param {Object} digest buildDigest 的产物
 */
function digestToText(digest) {
  if (!digest || !digest.ok || !digest.digest) return '';
  const d = digest.digest;
  const hours = Math.floor((d.totalPlayTimeSec || 0) / 3600);
  const mins = Math.floor(((d.totalPlayTimeSec || 0) % 3600) / 60);
  const timeText = hours > 0 ? `${hours}小时${mins}分钟` : `${mins}分钟`;
  const artistLines = (d.topArtists || [])
    .slice(0, 20)
    .map((a) => `${a.artist}（${a.count} 次）`)
    .join('、');
  const slotLines = (d.slots || [])
    .slice(0, 4)
    .map((b) => `${b.weekday} ${b.pct}%`)
    .join('、');
  return [
    `累计播放时长：${timeText}`,
    `听过的不同歌曲：${d.distinctSongs} 首；累计播放：${d.totalPlays} 次`,
    `歌手聚合（次数）：${artistLines}`,
    `一周作息分布：${slotLines || '暂无'}`,
    `最重复的那位歌手：${d.mostRepeatedArtist || '未知'}`,
    `最近一次播放的歌手：${d.lastPlayedArtist || '未知'}`,
  ].join('\n');
}

/** 提示组：系统提示（隐私 + 不编造红线）+ 用户请求（统计摘要 + 输出语言） */
function buildProfileMessages({ digest, lang }) {
  const outLang = LANG_NAMES[lang] || LANG_NAMES.zh;
  const text = digestToText(digest);
  const system = '你是桌面音乐应用「揽乐」内置的品味解读助手。用户给你一份**经过脱敏的**听歌统计摘要，'
    + '你要做的是基于这份统计谈谈用户的音乐口味画像：风格倾向、歌手偏好、听歌作息、可能的心境走向。\n'
    + '红线：\n'
    + '1. 只依据给出的统计摘要谈，摘要里没有的具体歌名、曲目、下载记录一概不许推测或编造；\n'
    + '2. 播放次数、时长、日期、排名这类具体数字不许自己发明，只能转述摘要里已有的；\n'
    + '3. 语气客观克制，不贴标签、不评判，不确定就说不确定；\n'
    + '4. 全程不泄露任何曲库明细，因为你自己也没见过明细。';
  const user = `这是我最近一段时间（脱敏后）的听歌统计：\n${text}\n\n`
    + '请给我一段「品味画像」解读，2-4 段，包含：风格倾向、歌手偏好、听歌作息、心境走向（如有依据）。'
    + `用${outLang}回答，直接输出正文，不要 markdown 标题、代码块或开场白。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 回复清洗：裁剪 + 去首尾空白；上限 2500 字，坏回复不该刷爆界面 */
function extractProfileText(content) {
  return String(content == null ? '' : content).trim().slice(0, MAX_REPORT_CHARS);
}

module.exports = {
  buildDigest,
  buildProfileMessages,
  digestToText,
  extractProfileText,
  MAX_REPORT_CHARS,
  MAX_ARTISTS,
};