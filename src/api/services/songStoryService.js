/**
 * 歌曲讲解服务（候选方向 1：背景卡片）—— 纯函数 + 依赖注入，单测不触网
 *
 * 对应竞品已验证的方向（网易云小宝「讲讲在播的歌」）：播放页一键生成歌曲的
 * 创作背景与主题解读。本模块只做「一次调用」—— 组提示、清洗回复；
 * 缓存与出网闸在主进程侧（src/main/ipc/songStory.js）。
 *
 * 纪律：不确定的事实（日期/销量/奖项）在系统提示里就不许编造；
 * 回复一律裁剪到上限，坏回复不该把界面刷爆。
 */

const MAX_STORY_CHARS = 2000;

/** 界面语言 → 输出语言措辞（未登记的键回落简体中文） */
const LANG_NAMES = Object.freeze({
  zh: '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
});

/** 提示组：系统提示（红线）+ 用户请求（歌名/歌手/输出语言） */
function buildStoryMessages({ title, artist, lang }) {
  const outLang = LANG_NAMES[lang] || LANG_NAMES.zh;
  const system = '你是桌面音乐下载应用「揽乐」内置的歌曲讲解助手。'
    + '只依据公开常识介绍歌曲与歌手；日期、销量、奖项这类不确定的具体事实一律不写，'
    + '宁缺毋错。';
  const user = `请介绍歌曲《${title}》${artist ? `（${artist}）` : ''}：创作背景与主题解读，2-4 段以内；用${outLang}回答，直接输出正文，不要 markdown 标题、代码块或开场白。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** 回复清洗：裁剪 + 去首尾空白；上限 2000 字，坏回复不该刷爆界面 */
function extractStoryText(content) {
  return String(content == null ? '' : content).trim().slice(0, MAX_STORY_CHARS);
}

module.exports = { buildStoryMessages, extractStoryText, MAX_STORY_CHARS };
