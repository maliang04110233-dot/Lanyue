/**
 * 听歌报告纯文本—— 纯函数，node 可直测
 *
 * 报告弹层只有 HTML，想发群聊只能截图；这里把同一份统计投影成
 * 一段纯文本，交给 songShare.copyText 进剪贴板。歌手聚合从
 * playCount 的 'title|||artist' 键还原（与 stats.js 记录端同一约定）。
 */

import { toTrackLine } from './songListText.js';

export const UNKNOWN_ARTIST_TEXT = '未知';

/**
 * 按歌手聚合播放次数（一首多歌手不拆分，取键内原样）。
 * @param {Object<string,number>} playCount { 'title|||artist': count }
 * @param {number} [limit] 截断条数（缺省给全量，收听歌手数 = 全量长度）
 * @returns {Array<{artist:string,count:number}>} 次数降序、同数按歌手 zh 序
 */
export function topArtistsFromPlayCount(playCount, limit) {
  const map = new Map();
  const entries = (playCount && typeof playCount === 'object') ? Object.entries(playCount) : [];
  for (const [key, raw] of entries) {
    const count = +raw || 0;
    if (count <= 0) continue;
    const artist = String(String(key || '').split('|||')[1] || '').trim() || UNKNOWN_ARTIST_TEXT;
    map.set(artist, (map.get(artist) || 0) + count);
  }
  const out = Array.from(map, ([artist, count]) => ({ artist, count }));
  out.sort((a, b) => b.count - a.count || a.artist.localeCompare(b.artist, 'zh'));
  return Number.isFinite(limit) ? out.slice(0, limit) : out;
}

/**
 * 报告 → 纯文本清单。缺项的段落整体省略（不造假 0）。
 * @param {{totalPlayTimeText?:string,totalSongs?:number,artistTotal?:number,
 *          mostPlayed?:Array<{title:string,artist:string,count:number}>,
 *          topArtists?:Array<{artist:string,count:number}>,
 *          daily?:Array<{label:string,secs:number}>,
 *          week?:{label:string,secs:number,prevSecs:number},
 *          month?:{label:string,secs:number,prevSecs:number},
 *          lastPlayed?:{title:string,artist:string}}} d
 */
export function formatReportText(d) {
  const s = d || {};
  const lines = [
    '📊 揽乐 听歌报告',
    `⏱️ 总播放时长：${s.totalPlayTimeText || '0分钟'}`,
    `🎵 播放歌曲数：${+s.totalSongs || 0}`,
    `🎤 收听歌手数：${+s.artistTotal || 0}`,
  ];
  const mp = Array.isArray(s.mostPlayed) ? s.mostPlayed.filter(x => x && x.title) : [];
  if (mp.length) {
    lines.push('', `🏆 最爱歌曲 TOP ${mp.length}`);
    mp.forEach((x, i) => lines.push(`${i + 1}. ${toTrackLine(x)} (${+x.count || 0} 次)`));
  }
  const ta = Array.isArray(s.topArtists) ? s.topArtists.filter(x => x && x.artist) : [];
  if (ta.length) {
    lines.push('', `🎤 最爱歌手 TOP ${ta.length}`);
    ta.forEach((x, i) => lines.push(`${i + 1}. ${x.artist} (${+x.count || 0} 次)`));
  }
  // 每日听歌：只列有账的天，零天省略；全无则整段省略
  const daily = Array.isArray(s.daily) ? s.daily.filter(b => b && +b.secs > 0) : [];
  if (daily.length) {
    lines.push('', `📅 每日听歌 · 近 ${s.daily.length} 天`);
    daily.forEach(b => lines.push(`${b.label}：${Math.max(1, Math.round(+b.secs / 60))}分钟`));
  }
  // 本周/本月：账到才出段；上周期基数只在该周有账时附带
  const _mins = (x) => `${Math.max(1, Math.round(+x / 60))}分钟`;
  const wk = s.week && +s.week.secs > 0 ? s.week : null;
  const mo = s.month && +s.month.secs > 0 ? s.month : null;
  if (wk || mo) {
    lines.push('', '🗓 周期听歌');
    if (wk) {
      lines.push(`本周（${wk.label || ''}）：${_mins(wk.secs)}${+wk.prevSecs > 0 ? ` · 上周 ${_mins(wk.prevSecs)}` : ''}`);
    }
    if (mo) {
      lines.push(`本月（${mo.label || ''}）：${_mins(mo.secs)}${+mo.prevSecs > 0 ? ` · 上月 ${_mins(mo.prevSecs)}` : ''}`);
    }
  }
  if (s.lastPlayed && s.lastPlayed.title) {
    lines.push('', `📀 最后播放：${toTrackLine(s.lastPlayed)}`);
  }
  return lines.join('\n');
}
