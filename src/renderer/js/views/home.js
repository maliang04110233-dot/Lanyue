/**
 * MusicDL 首页
 *
 * 架构（后）：
 *   1. 分区注册表 HOME_PLATFORMS 是唯一数据源，驱动 DOM 生成、平台 tab、按需加载
 *   2. 顶部平台条是 **tab（互斥切换）**，不是锚点滚动条：点哪个平台就只显示
 *      那个平台，其余整块 hidden。此前四平台纵向堆叠成聚合长页，看酷狗要
 *      先滚过网易云 + QQ 的三千像素 —— 平台之间是并列选择关系，不是阅读顺序
 *   3. 平台数据在 tab 首次激活时才加载（loadPlatform 自身幂等），
 *      每块独立成功/失败/重试；←/→ 在平台间循环
 *   4. 单一状态源 homeState：window / global state 共享同一对象引用，
 *      永不整体替换（旧实现有模块变量 + state + window 三份副本，会漂移）
 *
 * 对外契约（不得改动）：
 *   window.loadHomeRecommendations()  —— app.js init / router 调用，幂等
 *   window.loadHomeStats()            —— app.js init 调用
 *   window.renderRecentlyPlayed()     —— app.js init / router 调用
 */

import { errBrief } from '../errBrief.js';
import { logger } from '../logger.js';
import { heartBtnHtml } from '../favorites.js';
import { resolveQuality } from '../quality.js';
import { openSongRowMenu } from '../songMenu.js';
import { filterHomeSection } from '../homeFilter.js';
import { platIdsOf, normalizePlatTab, nextPlatTab, HOME_PLAT_LS_KEY } from '../homePlatTabs.js';
import { skeletonHtml } from '../skeleton.js';
import { buildFallbackNotice } from '../fallbackNotice.js';
import { PLAY_ALL_LIMIT, planSectionPlay, playAllToastText } from '../homePlayAll.js';

// 首页榜单过滤词（会话级；小写化在 filterHomeSection 内统一处理）
let _homeFilterStr = '';

// ── 分区注册表 ────────────────────────────────────────────
// 新增一个区块 = 这里加一行；DOM、锚点、懒加载、状态统计自动跟上
//
// 平台显示名不在此定义 —— 统一走 utils.js 的 platformName(p.plat)（单一来源）。
// 原先这里带 label + i18n 键（home.neteaseTab / home.qqTab / home.biliTab），
// 是平台名的第二份拷贝，且命名与 search.<id> 不统一，已移除。
const HOME_PLATFORMS = [
  {
    plat: 'netease',
    sections: [
      { sec: 'netease.tops',      title: '飙升榜',   i18n: 'home.subtab.tops',      kind: 'list' },
      { sec: 'netease.hot',       title: '热歌榜',   i18n: 'home.subtab.hot',       kind: 'list' },
      { sec: 'netease.new',       title: '新歌榜',   i18n: 'home.subtab.new',       kind: 'list' },
      { sec: 'netease.original',  title: '原创榜',   i18n: 'home.subtab.original',  kind: 'list' },
      { sec: 'netease.playlists', title: '推荐歌单', i18n: 'home.subtab.playlists', kind: 'grid' },
    ],
  },
  {
    plat: 'qq',
    sections: [
      { sec: 'qq.recommend', title: '个性化推荐', kind: 'grid' },
      { sec: 'qq.official',  title: '官方歌单',   kind: 'grid' },
      { sec: 'qq.classic',   title: '经典歌单',   kind: 'grid' },
      { sec: 'qq.love',      title: '情歌歌单',   kind: 'grid' },
      { sec: 'qq.ktv',       title: 'KTV热歌',    kind: 'grid' },
      { sec: 'qq.top',       title: '热歌榜',     kind: 'list' },
      { sec: 'qq.new',       title: '内地新歌',   kind: 'list' },
      { sec: 'qq.radio',     title: '热门电台',   kind: 'grid' },
      { sec: 'qq.singers',   title: '热门歌手',   kind: 'grid' },
    ],
  },
  {
    plat: 'bilibili',
    sections: [
      { sec: 'bilibili.ranking', title: '音乐区热门排行', kind: 'list', showSource: true },
    ],
  },
  {
    // 酷狗（2026-09-18 补齐推荐域能力后加入）。
    // 榜单口径与 netease 对齐（飙升/热歌/短视频/TOP500），便于横向比较。
    // 注：酷狗的「网络热歌榜」「短视频热歌榜」与 netease「热歌榜」内容不同源，
    //     标题保留平台原榜名，不强行统一成「热歌榜」，避免误导。
    plat: 'kugou',
    sections: [
      { sec: 'kugou.tops',      title: '飙升榜',      kind: 'list' },
      { sec: 'kugou.hot',       title: '网络热歌榜',  kind: 'list' },
      { sec: 'kugou.short',     title: '短视频热歌榜', kind: 'list' },
      { sec: 'kugou.top500',    title: 'TOP500',      kind: 'list' },
      { sec: 'kugou.playlists', title: '推荐歌单',    kind: 'grid' },
    ],
  },
];

/**
 * 榜单默认只渲染前 N 行，超出走「查看完整榜单」弹窗。
 *
 * 从 20 降到 8 的依据（实测，非审美偏好）：
 *   改版前 netease 块高 1156px，其中 980px 是单一分区的前 20 行 ——
 *   一个分区就吃掉一整屏，同平台其它分区被推出视野。
 *   收到 8 行后单块约 350px，一屏能看完当前平台的分区头 + 榜单主体。
 * （e1924ae 起一次只显示一个平台，「块太高会把后面的平台推走」这条
 *    动机已不存在，折叠仍然保留 —— 理由换成下面那句。）
 *   完整榜单不再原地展开，而是弹窗查看 —— 首页负责「发现」，
 *   完整列表不是首页该承担的信息量。
 */
const LIST_FOLD = 8;
/** 横向卡片流里歌单卡的列数上限（超过则靠横向滚动，不再挤压缩小） */
const GRID_LIMIT = 12;
/** 单分区请求超时（毫秒） */
const SECTION_TIMEOUT = 10000;

const HERO_TAGS = [
  { text: '周杰伦', hot: true },
  { text: '林俊杰', hot: true },
  { text: '五月天', hot: true },
  { text: 'Taylor Swift', hot: true },
  { text: '轻音乐' },
  { text: '钢琴曲' },
  { text: 'LoFi Hip Hop' },
  { text: 'OST 原声带' },
  { text: '粤语经典' },
  { text: '日语动漫' },
];

// ── 单一状态源 ────────────────────────────────────────────
// plat[plat] = { status, sections: { sec: data[] }, ok, fail }
const homeState = { plat: {}, _booted: false };
try { setState('homeRecommendations', homeState); } catch (_e) { /* ignore */ }
window.homeRecommendations = homeState;

// ── 平台 tab 状态 ─────────────────────────────────────────
const _platIds = platIdsOf(HOME_PLATFORMS);

/** 上次所选平台：localStorage 尽力而为，禁用/隐私模式下静默降级到首个平台 */
function _storedPlat() {
  try { return localStorage.getItem(HOME_PLAT_LS_KEY); } catch (_e) { return null; }
}
function _rememberPlat(plat) {
  try { localStorage.setItem(HOME_PLAT_LS_KEY, plat); } catch (_e) { /* ignore */ }
}

let _activePlat = normalizePlatTab(_platIds, _storedPlat());

let _shellRendered = false;
/** 完整榜单弹窗的 Esc 监听器（关闭时必须移除，否则重复打开会累积） */
let _chartEscHandler = null;

// ── 小工具 ────────────────────────────────────────────────
function _getApi() { return window.api || (typeof api !== 'undefined' ? api : null); }

/**
 * 取 i18n 词条，缺失时回落中文（英文模式下不再丢词条）。
 *
 * params 用于 `{n}` 这类占位符插值（i18n.t 原生支持）。**回落串也要插值** ——
 * 否则语言包一旦缺词条，界面上会原样显示出 "{n}"，比没有翻译更糟。
 */
function _tr(key, fallback, params) {
  const fill = (s) => {
    if (!params) return s;
    return Object.keys(params).reduce(
      (acc, k) => acc.replace(new RegExp('\\{' + k + '\\}', 'g'), params[k]), s);
  };
  if (!key) return fill(fallback);
  try {
    const v = typeof window.t === 'function' ? window.t(key, params) : '';
    return v && v !== key ? v : fill(fallback);
  } catch (_e) { return fill(fallback); }
}

/** 区块 DOM id：netease.tops → sec-netease-tops（点号不能进 CSS 选择器） */
function _domId(sec) { return 'sec-' + sec.replace(/\./g, '-'); }
function _platOf(sec) { return sec.split('.')[0]; }
function _blockId(plat) { return 'blk-' + plat; }
function _findMeta(sec) {
  for (const p of HOME_PLATFORMS) {
    const s = p.sections.find(x => x.sec === sec);
    if (s) return s;
  }
  return null;
}
function _getSection(sec) {
  const st = homeState.plat[_platOf(sec)];
  return (st && st.sections[sec]) || [];
}

/**
 * 取（或建）平台状态槽。
 * 每次重新从 homeState 读取，避免 reloadPlatform 换掉状态对象后，
 * 尚在飞行中的 fetchSection 把计数写进已废弃的旧对象。
 */
function _platState(plat) {
  const cur = homeState.plat[plat];
  if (cur) return cur;
  const fresh = { status: 'idle', sections: {}, ok: 0, fail: 0 };
  homeState.plat[plat] = fresh;
  return fresh;
}

/**
 * 首页这一节该出哪种骨架。标记本身在 js/skeleton.js（全站唯一实现），
 * 这里只保留首页的两个决定：
 *   - 行数取 LIST_FOLD 而非写死：骨架的作用是占位，它和真实内容的高度差
 *     会表现为「数据到位的瞬间页面跳一下」；榜单折叠到 8 行，这里就同步 8 行。
 *   - 封面 36px 是 skeleton.js 的基准形状（与 .top-song-cover 一致），故不传修饰。
 */
function _homeSkel(kind) {
  return kind === 'grid' ? skeletonHtml('grid', 6) : skeletonHtml('list', LIST_FOLD);
}

// ── 骨架构建 ──────────────────────────────────────────────
function renderHeroTags() {
  const el = document.getElementById('homeHeroTags');
  if (!el) return;
  el.innerHTML = HERO_TAGS.map(g =>
    `<span class="hot-tag${g.hot ? ' trending' : ''}" onclick="quickSearch('${escQ(g.text)}')">${esc(g.text)}</span>`
  ).join('');
}

function renderHomeShell() {
  const wrap = document.getElementById('homeBlocks');
  if (!wrap) return;

  wrap.innerHTML = HOME_PLATFORMS.map(p => {
    const label = platformName(p.plat);
    const on = p.plat === _activePlat;
    return `
    <section class="plat-block" id="${_blockId(p.plat)}" data-plat="${p.plat}"${on ? '' : ' hidden'}>
      <div class="plat-block-head">
        <span class="plat-dot" data-plat="${escAttr(p.plat)}"></span>
        <span class="plat-block-name">${esc(label)}</span>
        <span class="plat-block-state" data-state>待加载</span>
        <span class="plat-block-spacer"></span>
        <div class="plat-chips plat-chips--rail" role="tablist">
          ${p.sections.map((s, i) => `<button class="plat-chip${i === 0 ? ' active' : ''}" role="tab" aria-selected="${i === 0}" data-sec="${escAttr(s.sec)}" onclick="showHomeSection('${escQ(p.plat)}','${escQ(s.sec)}',this)">${esc(_tr(s.i18n, s.title))}</button>`).join('')}
        </div>
      </div>
      ${p.sections.map((s, i) => `<div class="home-sec home-sec--${s.kind}" id="${_domId(s.sec)}" data-sec="${escAttr(s.sec)}"${i === 0 ? '' : ' hidden'}>${_homeSkel(s.kind)}</div>`).join('')}
    </section>`;
  }).join('');

  const anchors = document.getElementById('homeAnchors');
  if (anchors) {
    anchors.setAttribute('role', 'tablist');
    anchors.innerHTML = HOME_PLATFORMS.map(p => {
      const on = p.plat === _activePlat;
      return `<button class="anchor-chip${on ? ' active' : ''}" role="tab" aria-selected="${on}" data-plat="${escAttr(p.plat)}" title="${escAttr(platformName(p.plat))}（←/→ 可循环切换平台）" onclick="showHomePlatform('${escQ(p.plat)}',this)"><span class="plat-dot" data-plat="${escAttr(p.plat)}"></span>${esc(platformName(p.plat))}</button>`;
    }).join('');
  }

  _shellRendered = true;
}

// ── 平台 tab 切换 / 平台内分区切换 ────────────────────────
/**
 * 切到某个平台：只保留该平台的块，其余整块 hidden。
 *
 * 与旧版「锚点 + scrollIntoView」的区别是实质的：旧版四个平台始终在同一
 * 条滚动流里，点 tab 只是把视口挪过去；现在一次只有一个平台在场，
 * 滚动条长度由当前平台决定，切平台时回到顶部（否则新平台会停在半屏位置）。
 */
function showHomePlatform(plat, btn) {
  const target = normalizePlatTab(_platIds, plat);
  if (!target) return;
  _activePlat = target;
  _rememberPlat(target);

  const bar = document.getElementById('homeAnchors');
  if (bar) {
    bar.querySelectorAll('.anchor-chip').forEach(c => {
      const on = c.dataset.plat === target;
      c.classList.toggle('active', on);
      c.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  document.querySelectorAll('#homeBlocks .plat-block').forEach(el => {
    el.hidden = el.dataset.plat !== target;
  });

  const root = document.getElementById('homePage');
  if (root) root.scrollTop = 0;

  loadPlatform(target); // 幂等：loading/done 直接返回
  if (btn) btn.blur();
}

/**
 * ←/→ 循环切平台。
 * 只在首页、且焦点不在输入框、且没有弹窗在场时接管 ——
 * 榜单弹窗/歌单弹窗开着时方向键属于弹窗内容滚动。
 */

/**
 * 是否有弹窗真的开着。
 * ⚠️ 不能写 querySelector('.playlist-modal-overlay') 就完事：index.html 里有六个
 * 弹层是常驻 DOM 的（用 .hidden 类控制显隐），那样判定永远为真，
 * 方向键切平台会静默失效（浏览器实测踩过）。故只看「没有 hidden 类」的那些。
 */
function _homeModalOpen() {
  return [...document.querySelectorAll('.playlist-modal-overlay')]
    .some(el => !el.classList.contains('hidden'));
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (!window.isTabPageVisible?.('homePage')) return; // 只在首页视图生效（真相源=页面可见，非导航高亮，见 164）
  if (_homeModalOpen()) return;
  const next = nextPlatTab(_platIds, _activePlat, e.key === 'ArrowRight' ? 1 : -1);
  if (!next || next === _activePlat) return;
  e.preventDefault();
  showHomePlatform(next, null);
});

/** 平台内切换分区：显式比对 data-sec，不再用 id.includes(type) 的子串匹配 */
function showHomeSection(plat, sec, btn) {
  const block = document.getElementById(_blockId(plat));
  if (!block) return;
  block.querySelectorAll('.plat-chip').forEach(c => c.classList.toggle('active', c.dataset.sec === sec));
  block.querySelectorAll('.home-sec').forEach(el => { el.hidden = el.dataset.sec !== sec; });
  if (btn) btn.blur();
}

// ── 平台状态徽标 ──────────────────────────────────────────
function _setBlockState(plat, text, onRetry) {
  const el = document.querySelector(`#${_blockId(plat)} [data-state]`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-error', typeof onRetry === 'function');
  el.onclick = typeof onRetry === 'function' ? onRetry : null;
}

function _refreshPlatformState(plat) {
  const def = HOME_PLATFORMS.find(p => p.plat === plat);
  const st = homeState.plat[plat];
  if (!def || !st) return;

  const total = def.sections.length;
  const settled = st.ok + st.fail;

  if (st.ok) {
    _setBlockState(plat, `${st.ok}/${total} 个分区`);
  } else if (settled >= total) {
    _setBlockState(plat, '加载失败，点击重试', () => reloadPlatform(plat));
  } else {
    _setBlockState(plat, `加载中 ${settled}/${total}`);
  }
}

// ── 数据加载 ──────────────────────────────────────────────
async function loadPlatform(plat) {
  const st = _platState(plat);
  if (st.status === 'loading' || st.status === 'done') return;

  const def = HOME_PLATFORMS.find(p => p.plat === plat);
  if (!def) return;

  st.status = 'loading';
  _refreshPlatformState(plat);

  await Promise.allSettled(def.sections.map(s => fetchSection(s)));

  st.status = st.ok ? 'done' : 'error';
  _refreshPlatformState(plat);
}

async function reloadPlatform(plat) {
  const def = HOME_PLATFORMS.find(p => p.plat === plat);
  if (!def) return;
  homeState.plat[plat] = { status: 'idle', sections: {}, ok: 0, fail: 0 };
  def.sections.forEach(s => {
    const el = document.getElementById(_domId(s.sec));
    if (el) el.innerHTML = _homeSkel(s.kind);
  });
  _refreshPlatformState(plat);
  await loadPlatform(plat);
}

async function fetchSection(meta) {
  const plat = _platOf(meta.sec);
  const st = _platState(plat);
  const el = document.getElementById(_domId(meta.sec));
  const _api = _getApi();

  if (!_api || typeof _api.getHomeSection !== 'function') {
    if (el) el.innerHTML = '<div class="home-sec-msg">接口未就绪</div>';
    st.fail++;
    _refreshPlatformState(plat);
    return false;
  }

  // 超时计时器必须在 finally 清掉，否则每次加载都会遗留一堆 10s 定时器
  let timer = null;
  try {
    const result = await Promise.race([
      _api.getHomeSection(meta.sec),
      new Promise((_res, rej) => {
        timer = setTimeout(() => rej(new Error('请求超时(10s)')), SECTION_TIMEOUT);
      }),
    ]);

    if (result && result.ok) {
      const data = Array.isArray(result.data) ? result.data : [];
      // await 期间 reloadPlatform 可能整体替换了状态对象，必须重读再写，
      // 否则数据落在孤儿对象上（页面上不显示、计数错乱）
      const st2 = _platState(plat);
      st2.sections[meta.sec] = data;
      st2.ok++;
      renderSection(meta, data);
      logger.log(`[Home] ✓ ${meta.sec} -> ${data.length} items`);
      _refreshPlatformState(plat);
      return true;
    }

    logger.warn(`[Home] ✗ ${meta.sec}:`, (result && result.error) || '加载失败');
    renderSectionError(meta, (result && result.error) || '加载失败');
    const st2 = _platState(plat);
    st2.fail++;
    _refreshPlatformState(plat);
    return false;
  } catch (e) {
    logger.warn(`[Home] ✗ ${meta.sec} exception:`, e.message);
    renderSectionError(meta, e.message || String(e));
    const st2 = _platState(plat);
    st2.fail++;
    _refreshPlatformState(plat);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 首页入口（app.js init / router switchTab('home') 调用）
 * 幂等：重复调用不重复加载。window._forceHomeRefresh = true 强制重载当前平台的分区。
 */
async function loadHomeRecommendations() {
  const force = !!window._forceHomeRefresh;
  window._forceHomeRefresh = false;

  if (!_shellRendered) {
    renderHeroTags();
    renderHomeShell();
    // 只加载当前 tab：其余平台等用户切过去再按需加载
    showHomePlatform(_activePlat);
  }

  if (homeState._booted && !force) return;
  homeState._booted = true;

  if (force) reloadPlatform(_activePlat);
}

// ── 渲染 ──────────────────────────────────────────────────
/**
 * 渲染一个分区的内容。
 *
 * grid 分区按 GRID_LIMIT 截断：网易云推荐歌单上游会给到 30+ 条，全渲染后
 * 网格要占 3 行以上（6 列 × 110px 卡），单块高度又会失控 —— 那正是这次
 * 改版要解决的问题。首页承担「发现」，超出部分交给「查看完整歌单」。
 */
function renderSection(meta, data) {
  const el = document.getElementById(_domId(meta.sec));
  if (!el) return;

  if (!Array.isArray(data) || !data.length) {
    // 空数据 **不等于**「这个榜真的没有歌」：失败信号在到达渲染层前已被两层抹平 ——
    // qq.js 四类加载器一律 `catch → return []`，gateway.recommendCall 再经
    // `safeRun(…, EMPTY.list())` 吞一次，于是 recommendations.getHomeSection
    // 只能把它包成 `{ok:true, data:[]}`，home.js 走的是**成功分支**。
    // 纯渲染层无法区分「真无数据」与「源失败」，故文案用「可能」而不断言
    // （断言会把「某榜今日确实为空」误报成故障），并复用重试能力。
    renderSectionError(meta, _tr('home.sectionUnavailable', '该区块暂无内容（平台可能暂时不可用）'));
    return;
  }

  // 有内容：清掉上一次降级留下的标记，否则该分区会被一直沉底且一直带降级外观
  el.classList.remove('is-unavailable');

  // 单出口：两条渲染分支都不 return，沉底后处理只在末尾调一次。
  // （早前 grid / list 各 return 各调一次，守卫只能断言「函数里提到过它」，
  //   删掉其中一条分支的调用照样绿 —— 分支越多越容易漏。）
  if (meta.kind === 'grid') {
    const { items } = filterHomeSection('grid', data, _homeFilterStr);
    el.innerHTML = items.length
      ? items.slice(0, GRID_LIMIT).map(playlistCardHtml).join('')
      : `<div class="home-sec-msg">没有匹配「${esc(_homeFilterStr)}」的歌单</div>`;
  } else {
    const { pairs } = filterHomeSection('list', data, _homeFilterStr);
    // 计数必须用**过滤后**的 pairs.length，不能用 data.length：
    // 后者是未过滤总量，「查看完整榜单（共 N 首）」会在筛选后仍报全量，
    // 且 N > LIST_FOLD 时按钮明明该消失却还在（点开只看到 2 首）。
    el.innerHTML = pairs.length
      ? listHtml(meta, pairs, pairs.length)
      : `<div class="home-sec-msg">没有匹配「${esc(_homeFilterStr)}」的歌曲</div>`;
  }
  _sinkUnavailableSections(_platOf(meta.sec));
}

function renderSectionError(meta, msg) {
  const el = document.getElementById(_domId(meta.sec));
  if (!el) return;
  // is-unavailable 是「本分区没有可用内容」的语义标记：
  // _sinkUnavailableSections 据此把它连同页签一起沉到平台区块末尾。
  el.classList.add('is-unavailable');
  el.innerHTML = `<div class="home-sec-msg is-error" tabindex="0" role="button" onclick="reloadHomePlatform('${escQ(_platOf(meta.sec))}')">⚠️ ${esc(msg)}，点击重试</div>`;
  _sinkUnavailableSections(_platOf(meta.sec));
}

/**
 * 把「不可用」分区沉到平台区块末尾（含它的页签）。
 *
 * 每个平台一次只显示一个 .home-sec（showHomeSection 用 hidden 切换），默认可见的是
 * **第一个**。若第一个分区恰好没有内容（QQ 九分区里有 7 个是空的），用户切到该平台
 * 看到的就是一块降级提示，会以为整个平台都坏了 —— 尽管后面几个分区其实有数据。
 * 故每次分区内容变化后做一次后处理：可用在前、不可用在后（组内保持原相对顺序），
 * 页签顺序跟着走，并保证可见的那个是可用分区。
 *
 * 幂等：已就位时直接返回，不折腾 DOM（避免把用户当前选中的分区跳掉）。
 */
function _sinkUnavailableSections(plat) {
  const block = document.getElementById(_blockId(plat));
  if (!block) return;
  const rail = block.querySelector('.plat-chips');
  const secs = [...block.querySelectorAll('.home-sec')];
  if (!rail || secs.length < 2) return;
  const chips = [...rail.querySelectorAll('.plat-chip')];
  const chipOf = (el) => chips.find(c => c.dataset.sec === el.dataset.sec);
  const bad = (el) => el.classList.contains('is-unavailable');

  // sort 稳定 → 同类内保持原有相对顺序，不会把「飙升榜/热歌榜」的次序打乱
  const ordered = [...secs].sort((a, b) => (bad(a) ? 1 : 0) - (bad(b) ? 1 : 0));
  if (ordered.every((el, i) => el === secs[i])) return;

  for (const el of ordered) block.appendChild(el);
  for (const el of ordered) { const c = chipOf(el); if (c) rail.appendChild(c); }

  // 保持用户当前看的分区（若它仍可用）；否则退到第一个可用分区
  const wasVisible = ordered.find(el => !el.hidden);
  const firstOk = (wasVisible && !bad(wasVisible))
    ? wasVisible
    : (ordered.find(el => !bad(el)) || ordered[0]);
  for (const el of ordered) el.hidden = el !== firstOk;
  for (const c of chips) {
    const on = c === chipOf(firstOk);
    c.classList.toggle('active', on);
    c.setAttribute('aria-selected', String(on));
  }
}

/**
 * 歌单卡。
 *
 * 无封面占位从 emoji 📀 换成内联 SVG（与榜单行同源 noCoverSvgHtml）：
 * 无 emoji 字体时 📀 会退化成一颗褐色实心圆，观感等同「图片加载失败」。
 *
 * 占位 SVG **常驻 DOM**、垫在 <img> 下层（.playlist-cover 是 absolute inset:0）：
 * 图片加载成功后自然把它盖住，因此不再需要原来那套
 * `onerror` 里操作 nextElementSibling.style.display 的隐式配对 ——
 * 那种写法一旦有人往中间插一个元素就会静默错位。
 */
function playlistCardHtml(p) {
  return `
    <div class="playlist-card" tabindex="0" role="button" onclick="openPlaylistModal('${escQ(p.source)}', '${escQ(p.id)}', '${escQ(p.name)}')">
      <div class="playlist-cover-wrap">
        ${p.cover
          ? `<img class="playlist-cover" src="${escAttr(p.cover)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.remove()">`
          : ''}
        <div class="playlist-cover-ph">${noCoverSvgHtml()}</div>
        ${p.playCount ? `<span class="playlist-playcount">${formatPlayCount(p.playCount)}</span>` : ''}
        <div class="playlist-hover-play">▶ 浏览歌单</div>
      </div>
      <div class="playlist-name" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="playlist-source">${esc(srcLabel(p.source))}</div>
    </div>`;
}

function listHtml(meta, pairs, total) {
  const shown = pairs.slice(0, LIST_FOLD);
  const more = total > LIST_FOLD
    ? `<button class="list-more-btn" onclick="openHomeChartModal('${escQ(meta.sec)}')">${esc(_tr('home.viewFullChart', `查看完整榜单（共 ${total} 首）`, { n: total }))} ▸</button>`
    : '';
  // 折叠视图只画 8 行，整单连播走 planSectionPlay 从原始数据重取 ——
  // 按钮若只播 shown，用户点的「播放全部」就永远只有前 8 首。
  // 超出入队上限时按钮写「前 N 首」：写「共 233 首」却只连播 100 首等于骗人。
  const playAllCount = total > PLAY_ALL_LIMIT ? `前 ${PLAY_ALL_LIMIT}` : `共 ${total}`;
  const playAll = `<button class="list-more-btn" onclick="playAllHomeChart('${escQ(meta.sec)}')">${esc(_tr('home.playAllChart', `▶ 播放全部（${playAllCount} 首）`, { n: total }))}</button>`;
  return playAll + songRowsHtml(meta, shown) + more;
}

/**
 * 榜单行。
 *
 * 改版前的问题（实测）：这一行**没有封面** —— 尽管后端每个 song 都带
 * cover 字段（netease 给的是 ?param=300y300 的 300px 图）。结果是
 * 772px 宽的行只有左侧 60px 左右有内容，右侧全空，视觉上是一列纯文字，
 * 既难扫读也浪费空间。
 *
 * 现在：封面 36px + 标题/歌手 + （可选）来源徽标 + 时长 + 常显操作按钮。
 * 「时长」是新加的 —— 榜单有 duration 字段却从未展示。
 */
function songRowsHtml(meta, rows) {
  // rows 是 [{s, i}]：i 必须是**原始数组下标**——行内播放/下载/右键全部经
  // _resolveSectionSong 回查，过滤后重排下标会点 A 播 B；id 一起烘焙进回调，
  // 弹窗快照与 live 数组错位时按下标+id 双重校验，id 命中则仍能正确取歌。
  return rows.map(({ s, i }) => `
    <div class="top-song-row" data-sec="${escAttr(meta.sec)}" data-ridx="${i}" tabindex="0" role="button" onclick="playRecommendById('${escQ(meta.sec)}',${i},'${escQ(s.id)}')">
      <span class="top-song-rank ${i < 3 ? 'top3' : ''}">${i + 1}</span>
      ${coverThumbHtml(s.cover)}
      <div class="top-song-info">
        <div class="top-song-title">${esc(s.title)}</div>
        <div class="top-song-artist">${esc(s.artist)}${s.album ? ' · ' + (s.albumMid
          ? `<span class="album-link" onclick="event.stopPropagation();openAlbumView('${escQ(s.albumMid)}','${escQ(s.source)}','${escQ(s.album)}')">${esc(s.album)}</span>`
          : esc(s.album)) : ''}</div>
      </div>
      ${meta.showSource ? `<span class="source-badge badge-${badgeCls(s.source)}">${esc(srcLabel(s.source))}</span>` : ''}
      <span class="top-song-dur">${fmtDuration(s.duration)}</span>
      <div class="top-song-actions">
        <button class="top-song-action" title="播放" aria-label="播放 ${escAttr(s.title)}" onclick="event.stopPropagation();playRecommendById('${escQ(meta.sec)}',${i},'${escQ(s.id)}')">${svgIcon('play')}</button>
        <button class="top-song-action" title="下载" aria-label="下载 ${escAttr(s.title)}" onclick="event.stopPropagation();addRecommendDownload('${escQ(meta.sec)}',${i},'${escQ(s.id)}')">${svgIcon('down')}</button>
        <button class="top-song-action" title="添加到歌单" aria-label="添加到歌单" onclick="event.stopPropagation();quickAddRecommendToPlaylist('${escQ(meta.sec)}',${i},'${escQ(s.id)}')">${svgIcon('plus')}</button>
        ${heartBtnHtml(s, 'top-song-action')}
      </div>
    </div>
  `).join('');
}

/**
 * 按下标+id 双重解析分区歌曲：idx 是烘焙进 DOM 的快照下标，分区数据重载/
 * 过滤后可能错位 —— 下标取到的歌 id 不符时按 id 在当前数组里重找。
 */
function _resolveSectionSong(sec, idx, songId) {
  const cur = _getSection(sec);
  const at = cur[idx];
  if (at && (!songId || String(at.id) === String(songId))) return at;
  if (songId) {
    const byId = cur.find(s => String(s.id) === String(songId));
    if (byId) return byId;
  }
  return at || null;
}

// ── 首页榜单过滤（会话级）──────────────────────────────
// 输入即重渲染所有已加载分区：数据始终在 homeState.plat[plat].sections[sec]
// 原样保留，过滤只发生在渲染层，清空输入即还原。
function _rerenderLoadedSections() {
  for (const p of HOME_PLATFORMS) {
    const st = homeState.plat[p.plat];
    if (!st) continue;
    for (const meta of p.sections) {
      const data = st.sections[meta.sec];
      if (Array.isArray(data) && data.length) renderSection(meta, data);
    }
  }
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'homeFilterInput') {
    _homeFilterStr = String(e.target.value || '').trim();
    _rerenderLoadedSections();
  }
});

// ── 榜单行右键菜单（业务项在 ../songMenu.js 共享）──────
// data-sec 只在榜单行上；榜单弹层行同样经 songRowsHtml 渲染，菜单顺带覆盖
document.addEventListener('contextmenu', (e) => {
  const row = e.target && e.target.closest ? e.target.closest('.top-song-row[data-sec]') : null;
  if (!row) return;
  const sec = row.getAttribute('data-sec');
  const idx = Number(row.getAttribute('data-ridx'));
  const s = _getSection(sec)[idx];
  if (!s) return;
  openSongRowMenu(e, s, {
    play: () => playRecommendById(sec, idx),
    download: () => addRecommendDownload(sec, idx),
    downloadQuality: (q) => addRecommendDownload(sec, idx, '', q),
  });
});

/**
 * 36px 方形封面缩略图。
 *
 * onerror 换成一个**内联 SVG 音符轮廓**而不是 emoji：原先用 📀，
 * 在无 emoji 字体的环境（本机 Chromium 实测）会被渲染成一个黄褐色
 * 实心圆点，看起来像「加载失败」，而不像「没有封面」。
 * SVG 不依赖字体，颜色走 token，主题切换自动跟随。
 */
function coverThumbHtml(url, cls) {
  const c = cls || 'top-song-cover';
  return `<span class="${c}">${
    url
      ? `<img src="${escAttr(url)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.remove()">`
      : ''
  }${noCoverSvgHtml()}</span>`;
}

/** 无封面时的占位图形（内联 SVG，不依赖 emoji 字体） */
function noCoverSvgHtml() {
  return `<svg class="cover-ph-svg" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 18V6l10-2v12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
  </svg>`;
}

/**
 * 行内操作图标（内联 SVG，统一 16px 网格 + 1.7 描边）。
 *
 * 换掉字符图标 ▶ ⬇ ＋ ♡ 的原因：这四个符号来自**四个不同的 Unicode 区块**
 * （几何图形 / 杂项符号 / 全角标点 / 其他符号），在 Segoe UI 下光学校正完全
 * 不一致 —— 实测放大后 ▶ 实心偏重、⬇ 细如发丝、＋ 偏轻，看起来像拼凑的。
 * 而 ⬇ 更麻烦：U+2B07 在部分字体下会走 emoji 呈现，被渲染成彩色方块。
 * 同一套 SVG 后，四个图标的笔画粗细、视觉重量、对齐都一致，
 * 且颜色继承 currentColor —— 主题切换与 hover 反色都不需要额外规则。
 */
const ROW_ICONS = {
  play:  '<path d="M6 4.5l12 7.5-12 7.5z" fill="currentColor"/>',
  down:  '<path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 20h16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
  plus:  '<path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  heart: '<path d="M12 20s-7-4.4-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.7c0 4.9-7 9.3-7 9.3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
  heartOn: '<path d="M12 20s-7-4.4-7-9.3A3.9 3.9 0 0 1 12 8a3.9 3.9 0 0 1 7 2.7c0 4.9-7 9.3-7 9.3z" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>',
};

function svgIcon(name) {
  return `<svg class="row-icon" viewBox="0 0 24 24" aria-hidden="true">${ROW_ICONS[name] || ''}</svg>`;
}

/** 毫秒 → m:ss；缺失/非法返回空串（不显示「0:00」这种噪音） */
function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const total = Math.round(n / 1000);
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return mm + ':' + ss;
}

/**
 * 完整榜单弹窗。
 *
 * 为什么把「展开全部」从原地展开改成弹窗：
 *   原地展开会把该平台块撑到 20 行 ×49px ≈ 1 屏高，把后面的平台
 *   推出视口 —— 首页要回答的是「有什么值得听」，不是「全部有什么」。
 *   完整榜单是次级信息，用弹窗承载既不丢功能，也不破坏首页节奏。
 *
 * 列表本身仍复用 songRowsHtml，故行的交互（播放/下载/收藏）完全一致；
 * 区别只是 meta.sec 仍指向原分区，因此 playRecommendById 的索引语义不变。
 */
function openHomeChartModal(sec) {
  const meta = _findMeta(sec);
  const songs = _getSection(sec);
  if (!meta || !songs.length) return;

  // 过滤词必须一并生效：分区列表已按 _homeFilterStr 收敛，弹窗若渲染全量，
  // 用户筛出 3 首、点「查看完整榜单」却看到 30 首，且没有任何提示 —— 前后自相矛盾。
  // 走同一个纯函数（不是自己写一遍 includes）：pairs 保留原始下标，
  // playRecommendById(sec, i) 的索引语义因此不变。
  const { pairs } = filterHomeSection('list', songs, _homeFilterStr);
  if (!pairs.length) return; // 与分区一致：没有匹配就不该开出一个空弹窗

  closeHomeChartModal(); // 幂等：重复打开先清旧的

  // 有过滤词时把「命中/总量」与筛选词写出来，否则用户会以为榜单被截断了
  const countText = _homeFilterStr
    ? _tr('home.filteredCount', `${pairs.length} / ${songs.length} 首 · 已筛选「${_homeFilterStr}」`,
      { m: pairs.length, n: songs.length, kw: _homeFilterStr })
    : _tr('home.trackCount', `${pairs.length} 首`, { n: pairs.length });

  const overlay = document.createElement('div');
  overlay.className = 'playlist-modal-overlay';
  overlay.id = 'homeChartModal';
  overlay.setAttribute('data-modal', '');
  overlay.innerHTML = `
    <div class="playlist-modal home-chart-modal" role="dialog" aria-modal="true" aria-label="${escAttr(_tr(meta.i18n, meta.title))}">
      <div class="playlist-modal-header">
        <span class="playlist-modal-title">${esc(_tr(meta.i18n, meta.title))} · ${esc(platformName(_platOf(sec)))}</span>
        <span class="home-chart-count">${esc(countText)}</span>
        <button class="btn-sm" onclick="playAllHomeChart('${escQ(sec)}')">${esc(_tr('home.playAllChartBtn', '▶ 播放全部'))}</button>
        <button class="playlist-modal-close" aria-label="${escAttr(_tr('home.close', '关闭'))}" onclick="closeHomeChartModal()">✕</button>
      </div>
      <div class="playlist-modal-body" id="homeChartBody">${songRowsHtml(meta, pairs)}</div>
    </div>`;

  // 点遮罩关闭（点内容区不关）—— 与既有 playlist-modal 行为一致
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeHomeChartModal(); });
  document.body.appendChild(overlay);

  // Esc 关闭。监听器挂在 document 上，故关闭时必须移除，否则每开一次
  // 就积一个监听器（连开 10 次 = 10 个 Esc 监听，且都引用同一个闭包）。
  _chartEscHandler = (e) => { if (e.key === 'Escape') closeHomeChartModal(); };
  document.addEventListener('keydown', _chartEscHandler);

  const closeBtn = overlay.querySelector('.playlist-modal-close');
  if (closeBtn) closeBtn.focus();
}

function closeHomeChartModal() {
  const el = document.getElementById('homeChartModal');
  if (el) el.remove();
  if (_chartEscHandler) {
    document.removeEventListener('keydown', _chartEscHandler);
    _chartEscHandler = null;
  }
}

// ── 推荐歌曲交互 ──────────────────────────────────────────
async function playRecommendById(sec, idx, songId) {
  try {
    const song = _resolveSectionSong(sec, idx, songId);
    if (song) await playRecommendSong(song);
  } catch (e) {
    logger.warn(`[playRecommendById] error:`, e);
  }
}

async function playRecommendSong(song) {
  if (!song) return;
  const quality = resolveQuality(song.source);
  showToast(`正在准备音源：${song.title}`, 'info');
  try {
    const result = await api.getDownloadUrlSmart(song, quality);
    if (!result || !result.url) {
      if (result && result.code === 'VIP_REQUIRED') {
        showToast('⚠️ 该歌曲为 VIP 专享，请在「设置」中填入已登录的 Cookie 后重试', 'warn', 5000);
      } else {
        showToast('⚠️ 暂无法获取音源，请稍后重试或下载后收听', 'warn', 5000);
      }
      return;
    }
    song._playedQuality = quality;
    const notice = buildFallbackNotice(result, song.source);
    if (notice) showToast(notice, 'info', 3000);
    if (result.matchedSong) {
      song._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
    }
    const playSource = result.source || song.source;
    const referer = playReferer(playSource, result);
    const proxied = await api.proxyPlay(result.url, referer, {
      id: String(result.id ?? song.id),
      source: playSource,
      quality,
    });
    if (!proxied || !proxied.fileUrl) {
      showToast('⚠️ 音源下载失败：' + (proxied?.error || '未知错误'), 'error', 5000);
      return;
    }
    const songs = [song];
    setState('songs', songs);
    setState('playQueue', songs);
    setState('playIdx', 0);
    setState('currentPlaying', song);
    await loadAndPlay(song, proxied.fileUrl, true);
    showToast('▶ 正在播放：' + song.title, 'success', 2500);
  } catch (e) {
    logger.warn('播放推荐歌曲失败:', e);
    showToast('⚠️ 播放失败：' + errBrief(e), 'error', 4000);
  }
}

async function addRecommendDownload(sec, idx, songId, qualityOverride) {
  // songId 在 qualityOverride 之前：行模板把 id 作为第 3 参烘焙进回调
  const song = _resolveSectionSong(sec, idx, songId);
  if (!song) return;
  const existing = (state.get('queueSnapshot') || []).find(q => q.id === song.id && q.source === song.source && q.status !== 'done');
  if (existing) {
    showToast(`「${song.title}」已在队列中`, 'warn', 2500);
    return;
  }
  try {
    const quality = qualityOverride || resolveQuality(song.source);
    const saveDir = getState('saveDir');
    const r = await api.addToQueue({ ...song, saveDir, quality });
    if (r && r.duplicated) {
      showToast(`「${song.title}」已在下载队列中`, 'warn', 2500);
      return;
    }
    if (r && r.alreadyDownloaded) {
      showRedownloadToast(song.title, r.finishedAt, () => {
        api.addToQueue({ ...song, saveDir, quality, forceRedownload: true })
          .then(() => showToast(`「${song.title}」已加入下载队列`, 'success'))
          .catch(e => showToast('加入下载失败：' + errBrief(e), 'error', 4000));
      });
      return;
    }
    showToast(`「${song.title}」已加入下载队列`, 'success');
  } catch (e) {
    showToast('加入下载失败：' + errBrief(e), 'error', 4000);
  }
}

async function quickAddRecommendToPlaylist(sec, idx, songId) {
  try {
    const song = _resolveSectionSong(sec, idx, songId);
    if (!song) return;
    const playlists = getState('userPlaylists') || [];
    if (playlists.length === 0) {
      await loadUserPlaylists();
    }
    if (typeof quickAddToPlaylist === 'function') {
      quickAddToPlaylist(song);
    }
  } catch (e) {
    logger.warn(`[quickAddRecommendToPlaylist] error:`, e);
  }
}

// ── 搜索入口 ──────────────────────────────────────────────
function quickSearch(keyword) {
  const input = document.getElementById('searchInput');
  if (input) input.value = keyword;
  switchTab('search');
  doSearch(1);
}

/** 首页快捷搜索条：空关键词直接跳搜索页，不触发空检索 */
function homeHeroSearch(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) { quickSearch(''); return; }
  quickSearch(kw);
}

// ── 统计概览卡片 ──────────────────────────────────────────
async function loadHomeStats() {
  try {
    const _api = _getApi();
    if (!_api) return;
    // 并行拉三块数据，各自容错（缺哪块哪块留 —）
    const [lib, hist, stats] = await Promise.allSettled([
      _api.loadLibraryIndex ? _api.loadLibraryIndex() : Promise.resolve(null),
      _api.getHistoryStats ? _api.getHistoryStats() : Promise.resolve(null),
      Promise.resolve(typeof getPlayStats === 'function' ? getPlayStats() : null),
    ]);

    // loadLibraryIndex 返回 { songs, dirPath, lastScan }
    const libSongs = lib.status === 'fulfilled' && lib.value
      ? (Array.isArray(lib.value) ? lib.value : (lib.value.songs || []))
      : [];
    const elLib = document.getElementById('statLibCount');
    if (elLib) elLib.textContent = String(libSongs.length);

    const doneCount = hist.status === 'fulfilled' && hist.value ? hist.value.done : null;
    const elDone = document.getElementById('statDoneCount');
    if (elDone) elDone.textContent = doneCount == null ? '—' : String(doneCount);

    const elTime = document.getElementById('statPlayTime');
    if (elTime) {
      const totalSec = stats.status === 'fulfilled' && stats.value ? (stats.value.totalPlayTime || 0) : 0;
      elTime.textContent = totalSec >= 3600
        ? (totalSec / 3600).toFixed(1) + ' 小时'
        : Math.round(totalSec / 60) + ' 分钟';
    }

    const elMost = document.getElementById('statMostPlayed');
    if (elMost) {
      let most = null;
      const pv = stats.status === 'fulfilled' && stats.value ? stats.value : null;
      if (pv && pv.playCount) {
        const entries = Object.entries(pv.playCount).sort((a, b) => b[1] - a[1]);
        if (entries.length) most = entries[0];
      }
      if (most) {
        const [title] = most[0].split('|||');
        elMost.textContent = title.slice(0, 12);
        elMost.title = `${title}（${most[1]} 次）`;
      } else {
        elMost.textContent = '—';
      }
    }
  } catch (e) {
    logger.warn('[loadHomeStats] error:', e);
  }
}

// ── 最近播放 ──────────────────────────────────────────────
function renderRecentlyPlayed() {
  const section = document.getElementById('recentlyPlayedSection');
  const list = document.getElementById('recentlyPlayedList');
  if (!section || !list) return;

  const recent = typeof getRecentlyPlayed === 'function' ? getRecentlyPlayed() : [];
  if (!recent.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  // 标题行加「播放全部」：整单最近播放进队列从第一首播
  const titleEl = section.querySelector('.hot-section-title');
  if (titleEl && !titleEl.querySelector('.section-playall-btn')) {
    const btn = document.createElement('button');
    btn.className = 'section-playall-btn';
    btn.textContent = '▶ 播放全部';
    btn.onclick = () => playAllRecent();
    titleEl.appendChild(btn);
  }

  list.innerHTML = recent.slice(0, 10).map((s, i) => `
    <div class="recent-item" tabindex="0" role="button" onclick="playRecentSong(${i})" title="${esc(s.title)} - ${esc(s.artist)}">
      <div class="recent-cover">
        ${s.cover
          ? `<img src="${escAttr(s.cover)}" alt="" loading="lazy" decoding="async" onload="this.classList.add('loaded')" onerror="this.parentElement.innerHTML='🎵'">`
          : '🎵'}
        <div class="recent-play-overlay">▶</div>
      </div>
      <div class="recent-info">
        <div class="recent-title">${esc(s.title)}</div>
        <div class="recent-artist">${esc(s.artist)}</div>
      </div>
      <span class="recent-time">${fmtHistoryTime(s.playedAt)}</span>
    </div>
  `).join('');
}

async function playRecentSong(idx) {
  try {
    const recent = typeof getRecentlyPlayed === 'function' ? getRecentlyPlayed() : [];
    const song = recent[idx];
    if (!song) return;
    // audio error / 25s 加载超时守卫依赖 currentPlaying 真值，缺失会静默卡死
    setState('currentPlaying', song);
    await loadAndPlay(song);
  } catch (e) {
    logger.warn(`[playRecentSong] error:`, e);
  }
}

// 最近播放整单入队（从第一首开始顺序播放）
async function playAllRecent() {
  try {
    const recent = typeof getRecentlyPlayed === 'function' ? getRecentlyPlayed() : [];
    if (!recent.length) return;
    const songs = [...recent].reverse().slice(0, 50); // 最近播放是新的在前，队列按旧→新排
    setState('songs', songs);
    setState('playQueue', songs);
    setState('playIdx', 0);
    setState('currentPlaying', songs[0]);
    await loadAndPlay(songs[0]);
    showToast(`▶ 正在播放最近播放（共 ${songs.length} 首）`, 'success', 2500);
  } catch (e) {
    logger.warn('[playAllRecent] error:', e);
    showToast('播放失败：' + errBrief(e), 'error', 3000);
  }
}

/**
 * 榜单整单连播（分区卡片与完整榜单弹层共用一个入口）。
 *
 * 数据从 _getSection 原始数组重取，而不是读 DOM：折叠视图只有 8 行、弹层是快照，
 * 两者都可能与 live 数组错位。过滤词与 planSectionPlay 里复用同一个纯函数，
 * 所以「筛完再播放全部」与用户当下看到的列表严格一致。
 */
async function playAllHomeChart(sec) {
  try {
    const meta = _findMeta(sec);
    if (!meta) return;
    closeHomeChartModal(); // 弹层若开着先关掉，否则遮罩会压在播放器上面
    const { songs, total, truncated } = planSectionPlay(_getSection(sec), _homeFilterStr);
    if (!songs.length) return;
    setState('songs', songs);
    setState('playQueue', songs);
    setState('playIdx', 0);
    setState('currentPlaying', songs[0]);
    await loadAndPlay(songs[0]);
    showToast(playAllToastText(_tr(meta.i18n, meta.title), songs.length, total, truncated), 'success', 2500);
  } catch (e) {
    logger.warn('[playAllHomeChart] error:', e);
    showToast('播放失败：' + errBrief(e), 'error', 3000);
  }
}

// ── ES Module 导出 ────────────────────────────────────────
export {
  HOME_PLATFORMS,
  homeState,
  loadHomeRecommendations,
  reloadPlatform,
  renderSection,
  renderHomeShell,
  showHomePlatform,
  showHomeSection,
  openHomeChartModal,
  closeHomeChartModal,
  playRecommendById,
  playRecommendSong,
  addRecommendDownload,
  quickAddRecommendToPlaylist,
  quickSearch,
  homeHeroSearch,
  loadHomeStats,
  playAllRecent,
  playAllHomeChart,
  playRecentSong,
  renderRecentlyPlayed,
};

// ── 全局桥接（HTML onclick 兼容） ─────────────────────────
window.loadHomeRecommendations = loadHomeRecommendations;
window.reloadHomePlatform = reloadPlatform;
window.showHomePlatform = showHomePlatform;
window.showHomeSection = showHomeSection;
window.openHomeChartModal = openHomeChartModal;
window.closeHomeChartModal = closeHomeChartModal;
window.playRecommendById = playRecommendById;
window.playRecommendSong = playRecommendSong;
window.addRecommendDownload = addRecommendDownload;
window.quickAddRecommendToPlaylist = quickAddRecommendToPlaylist;
window.quickSearch = quickSearch;
window.homeHeroSearch = homeHeroSearch;
window.loadHomeStats = loadHomeStats;
window.playAllRecent = playAllRecent;
window.playAllHomeChart = playAllHomeChart;
window.playRecentSong = playRecentSong;
window.renderRecentlyPlayed = renderRecentlyPlayed;

// ── 兼容旧调用名（外部自动化/CDP 可能仍在用） ──────────────
window.switchPlatTab = (plat) => showHomePlatform(plat);
