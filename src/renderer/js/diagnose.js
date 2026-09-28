/**
 * 下载失败诊断向导
 *
 * classifyFailure 是纯函数：优先按引擎回写的 errorCode 查表，
 * 未知码再按 error 文本关键词兜底（磁盘/网络/鉴权/VIP），永不返回空。
 * 弹层给出「原因 + 建议 + 可行动作」（前往设置 / 立即重试），
 * 行内徽标只说“是什么”，诊断说“怎么办”——两者共用下面这一张码表。
 *
 * 372d675 起弹层不再专属队列：按钮显隐收成 diagHeals 一处纯规则，
 * 具体动作由调用方那一页经 ctx 注入（队列 retryQueueItem / 历史 retryFromHistory）。
 *
 * cb2c416 起「是什么」那一侧也搬了进来：行内失败徽标的短标签与颜色就是 DIAG_TABLE
 * 的字段，failureTagHtml 是全仓唯一的徽标渲染（队列行与历史行共用），
 * 「重试也没用、得先去设置」的鉴权判定同样只有 AUTH_CODES 一处定义。
 *
 * bd3e549 起「最近的失败」不再只住队列（队列重启即清空，开机后两条 ⌘K 入口只会说
 * 「没有失败任务」，而历史里全是红的）：失败清单由 pickFailureSource 定谁提供 ——
 * 队列优先、队列没有才用历史兜底，两个入口共用 _failureSources 一份取数。
 *
 * 4ba07a0 起徽标自己就是入口：162 让行内戴上了「需VIP / Cookie过期」，但要说「怎么办」
 * 还得摸到行尾那枚 🆘 —— 而队列进入批量选择模式时那一整组按钮会隐藏。现在点徽标即弹诊断，
 * 页面只交出「入口名 + 机器生成的 id」（diagnoseFailure(taskId) / diagnoseHistoryItem(idx)），
 * 通用层依旧不认识任何一页的动作（158 的规矩）；id 形状不对就不挂点击，宁可少一个入口也不给注入留缝。
 */

/** 码表：cause=给用户看的原因，advice=下一步建议，heal=可一键执行的动作，tag=行内徽标（短标签+语义色） */
const DIAG_TABLE = {
  VIP_REQUIRED: { cause: '该音质档位为平台 VIP 专享', advice: '在搜索结果右键「以此音质下载」选低一档，或到设置补 VIP 账号的 Cookie', heal: 'settings', tag: { label: '需VIP', color: 'var(--neon-orange)' } },
  AUTH_EXPIRED: { cause: '平台 Cookie 已过期', advice: '到 设置 → 平台 Cookie 更新后点「立即重试」', heal: 'settings', tag: { label: 'Cookie过期', color: 'var(--neon-orange)' } },
  LOGIN_REQUIRED: { cause: '该平台需要登录才能取流', advice: '到 设置 填入已登录的 Cookie 后重试', heal: 'settings', tag: { label: '需登录', color: 'var(--neon-orange)' } },
  COPYRIGHT_RESTRICTED: { cause: '版权受限（地区限制或曲目下架）', advice: '换其他平台搜索同名版本，一般聚合搜索里会有替代源', heal: null, tag: { label: '版权受限', color: 'var(--neon-purple)' } },
  UNAVAILABLE: { cause: '曲目当前不可用', advice: '稍后重试；持续失败就换源搜索同名版本', heal: 'retry', tag: { label: '不可用', color: 'var(--neon-purple)' } },
  CDN_EMPTY: { cause: '平台 CDN 返回空数据（多为高峰期限流）', advice: '稍后再试，或用「定时下载」错峰到夜间自动入队', heal: null, tag: { label: 'CDN异常', color: 'var(--neon-red)' } },
  NETWORK_TIMEOUT: { cause: '网络超时', advice: '检查网络/代理；不稳定时到设置把并发数调低再重试', heal: 'retry', tag: { label: '网络超时', color: 'var(--neon-yellow)' } },
  // 引擎给断网跑完的下载补的码。缺这一行的话它跟"没登记"一模一样 ——
  // 队列与历史那一行不戴徽标、弹层说「未分类的失败」，用户根本看不出该去检查网络。
  // 「网络恢复后会自动重排」说的是下载页那条横幅的真话：只有这两枚码会被自动重新入队。
  NETWORK_ERROR: { cause: '网络中断（本机断网或连不上音源）', advice: '恢复网络后下载页会自动重试这些任务；反复失败请检查代理/VPN 或到设置把并发数调低', heal: 'retry', tag: { label: '断网', color: 'var(--neon-yellow)' } },
  NO_AUDIO_STREAM: { cause: '找不到可播放的音频流（付费/加密/下架）', advice: '换一档音质或换源；本地库可用「音质扫描」核对已有文件', heal: null, tag: { label: '无音频流', color: 'var(--neon-red)' } },
  UNKNOWN_PLATFORM: { cause: '链接所属平台暂不支持', advice: '确认链接来自支持列表内的平台', heal: null, tag: { label: '未知平台', color: 'var(--text-dim)' } },
  // 下面七行是补登「取流层早就在发、码表却一直没收」的码 —— 缺行不是小事，
  // 缺一个码 = 队列/历史那一行不戴徽标 + 弹层只会说「未分类的失败，请复制错误信息反馈」。
  // 覆盖度由 test/diagnose-coverage.test.js 机械扫回写层来钉，加码不登记会直接红。
  PLATFORM_CHANGED: { cause: '该平台接口已变更或被反爬拦截', advice: '稍后再试；持续失败就到聚合搜索里换其他平台下载同一歌曲', heal: 'retry', tag: { label: '接口变更', color: 'var(--neon-red)' } },
  BAD_PARAMS: { cause: '请求参数不完整（缺歌曲标识）', advice: '这条链接可能残缺，回到搜索结果重新点一次下载', heal: null, tag: { label: '参数缺失', color: 'var(--neon-yellow)' } },
  INVALID_ARGS: { cause: '曲目定位信息不完整', advice: '回到搜索结果重选该曲目（跨平台分组里换一条同名结果）', heal: null, tag: { label: '定位缺参', color: 'var(--neon-yellow)' } },
  FETCH_FAILED: { cause: '向平台请求音源时失败（网络或平台拒绝）', advice: '检查网络后点「立即重试」；反复失败就换一档音质或换源', heal: 'retry', tag: { label: '取流失败', color: 'var(--neon-red)' } },
  BILI_URL_ERROR: { cause: 'B站音频流获取异常', advice: '点「立即重试」；B站分 P 影视原声常无独立音源，可换其他平台搜同名', heal: 'retry', tag: { label: 'B站取流失败', color: 'var(--neon-red)' } },
  UNKNOWN_SOURCE: { cause: '数据源不在支持列表内', advice: '确认链接来自支持的平台，或改用聚合搜索找同名版本', heal: null, tag: { label: '未知来源', color: 'var(--text-dim)' } },
  INTERNAL_ERROR: { cause: '应用内部错误', advice: '点「立即重试」看是否偶发；持续失败请携带任务详情反馈', heal: 'retry', tag: { label: '内部错误', color: 'var(--neon-red)' } },
};

const KEYWORD_RULES = [
  { re: /ENOSPC|no space|空间不足/i, cause: '磁盘剩余空间不足', advice: '清理磁盘或到设置更换下载目录后重试', heal: 'settings' },
  { re: /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|网络/i, cause: '网络异常', advice: '检查网络/代理后点「立即重试」', heal: 'retry' },
  { re: /403|cookie|auth|登录|unauthorized/i, cause: '鉴权失败（Cookie 无效或缺失）', advice: '到 设置 → 平台 Cookie 更新后重试', heal: 'settings' },
  { re: /vip/i, cause: '需要 VIP 权限', advice: '换低一档音质下载，或在设置补 VIP Cookie', heal: 'settings' },
];

/**
 * 纯分类：errorCode 命中码表优先，否则关键词兜底，最后归「未分类」。
 * @returns {{code:string, cause:string, advice:string, heal:(string|null)}}
 */
export function classifyFailure(errorCode, errorText) {
  const code = errorCode ? String(errorCode) : '';
  if (DIAG_TABLE[code]) return { code, ...DIAG_TABLE[code] };
  const text = errorText ? String(errorText) : '';
  for (const r of KEYWORD_RULES) {
    if (r.re.test(text)) return { code: code || 'INFERRED', cause: r.cause, advice: r.advice, heal: r.heal };
  }
  return {
    code: code || 'UNKNOWN',
    cause: '未分类的失败',
    advice: '展开任务详情复制错误信息反馈；也可以直接点「立即重试」看是否为偶发',
    heal: 'retry',
  };
}

/**
 * 纯取徽标：平台回写码 → 行内短标签；无码或未收录码返回 null。
 * 徽标只认取流侧真实回写的码 —— classifyFailure 的关键词推断是给诊断弹层兜底的，
 * 猜出来的原因不够确定，不配在行内戴一顶帽子。
 * @returns {?{label:string, color:string}}
 */
export function failureTag(errorCode) {
  const row = DIAG_TABLE[String(errorCode || '')];
  return row ? { label: row.tag.label, color: row.tag.color } : null;
}

/**
 * 徽标 HTML：队列行与历史行共用这一份渲染（两处各写一遍必然长歪）。
 * 第二参 diag={fn,arg} 给定时，徽标本身就是诊断入口 —— 用户的眼睛落在徽标上，手不必去摸
 * 行尾那枚 🆘；而队列进入批量选择模式时行尾按钮整组隐藏，那一刻它是仅剩的入口。
 * 页面交出来的只有「入口名 + 机器生成的 id」（taskId / 行号），通用层依旧不认识任何一页的动作。
 * 本函数不配 HTML 转义器（它是纯函数，测试在 Node 里直接调），所以 id 只认 token 字符集，
 * 形状不对就退回不可点徽标：宁可少一个入口，也不给注入留缝。
 */
export function failureTagHtml(errorCode, diag) {
  const t = failureTag(errorCode);
  if (!t) return '';
  const call = _diagCall(diag);
  if (!call) return `<span class="fail-tag" style="color:${t.color}">${t.label}</span>`;
  return `<span class="fail-tag" role="button" tabindex="0" title="点击诊断这次失败（原因 + 建议 + 下一步）"`
    + ` style="color:${t.color};cursor:pointer;" onclick="${call}">${t.label}</span>`;
}

const DIAG_FN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DIAG_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

function _diagCall(diag) {
  if (!diag || typeof diag !== 'object') return '';
  const { fn, arg } = diag;
  if (typeof fn !== 'string' || !DIAG_FN_RE.test(fn)) return '';
  if (typeof arg === 'number') return Number.isInteger(arg) && arg >= 0 ? `event.stopPropagation();${fn}(${arg})` : '';
  if (typeof arg === 'string') return DIAG_ID_RE.test(arg) ? `event.stopPropagation();${fn}('${arg}')` : '';
  return '';
}

function _closeDiag() {
  const el = document.getElementById('diagOverlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/** 「前往设置」点的是全局导航，任何页面都点得动，故由本模块自己实现 */
function _gotoSettings() {
  const btn = document.querySelector('.nav-item[data-tab="settings"]');
  if (btn && typeof window.switchTab === 'function') window.switchTab('settings', btn);
}

/**
 * 纯函数：诊断弹层该出现哪些按钮（显隐规则唯一一家）。
 * 「立即重试」还要看调用方那一页给没给重试动作 —— 队列给 retryQueueItem(taskId)，
 * 历史页给 retryFromHistory(六字段)。通用层不认识任何一页的动作，
 * 所以缺动作就少一个按钮，而不是弹一个点了没反应的按钮。
 * @param {{heal?: (string|null)}} d
 * @param {{retry?: Function}} [ctx]
 * @returns {Array<{label:string, primary:boolean, run:Function}>}
 */
export function diagHeals(d, ctx) {
  const heal = d ? d.heal : null;
  const out = [];
  if (heal === 'settings') out.push({ label: '前往设置', primary: true, run: _gotoSettings });
  if (ctx && typeof ctx.retry === 'function' && (heal === 'retry' || heal === 'settings')) {
    out.push({ label: '立即重试', primary: false, run: ctx.retry });
  }
  return out;
}

/** 通用入口：给一条带 error/errorCode 的记录弹诊断层，动作由页面经 ctx 注入 */
export function showDiagnosis(task, ctx) {
  if (!task) return;
  _renderDiag(task, classifyFailure(task.errorCode, task.error), ctx);
}

function _renderDiag(task, d, ctx) {
  _closeDiag();
  const overlay = document.createElement('div');
  overlay.id = 'diagOverlay';
  overlay.className = 'edit-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeDiag(); });

  const panel = document.createElement('div');
  panel.className = 'edit-panel';

  const header = document.createElement('div');
  header.className = 'edit-header';
  const title = document.createElement('span');
  title.className = 'edit-title';
  title.textContent = '🆘 失败诊断';
  const close = document.createElement('button');
  close.className = 'edit-close';
  close.textContent = '✕';
  close.addEventListener('click', _closeDiag);
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'edit-body';
  const songLabel = `${task.title || '未知曲目'}${task.artist ? ' · ' + task.artist : ''}`;
  const errLine = task.error ? String(task.error) : '';
  body.innerHTML =
    `<div class="sched-job"><div class="sched-job-lines">${esc(songLabel)}${task.source ? '（' + esc(String(task.source)) + '）' : ''}</div></div>` +
    `<div class="sched-job"><div class="sched-job-lines"><b>原因：</b>${esc(d.cause)}${d.code ? '　' + esc(d.code) : ''}</div></div>` +
    `<div class="sched-job"><div class="sched-job-lines"><b>建议：</b>${esc(d.advice)}</div></div>` +
    (errLine ? `<div class="sched-job"><div class="sched-job-lines"><b>原始错误：</b>${esc(errLine.slice(0, 200))}</div></div>` : '');

  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
  for (const h of diagHeals(d, ctx)) {
    const b = document.createElement('button');
    b.className = h.primary ? 'btn btn-primary' : 'btn';
    b.textContent = h.label;
    b.addEventListener('click', () => {
      _closeDiag();
      h.run();
    });
    foot.appendChild(b);
  }
  body.appendChild(foot);
  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

/** 入口：按 taskId 从队列快照找失败任务并弹诊断层 */
function diagnoseFailure(taskId) {
  const queue = (typeof getState === 'function' && getState('queueSnapshot')) || [];
  const task = queue.find(q => String(q.taskId) === String(taskId));
  if (!task) { showToast('任务已不在队列中', 'warn', 2000); return; }
  showDiagnosis(task, { retry: () => { if (typeof window.retryQueueItem === 'function') window.retryQueueItem(task.taskId); } });
}

/**
 * 命令面板入口：诊断最近一个失败任务。
 * 队列是易失的（重启即清空），所以队列没有失败时退到下载历史 —— 历史里的 errorCode
 * 从 158 起就在，162 起行内也有徽标，缺的只是让这两个入口够得着它。
 */
async function diagnoseLatestFailure() {
  const { items, origin, latest } = await _failureSources();
  if (!items.length) { showToast('队列和历史里都没有失败任务', 'info', 2000); return; }
  if (origin === 'queue') { diagnoseFailure(latest.taskId); return; }
  // 历史条目没有 taskId：照样弹同一份诊断，但不给「立即重试」（158 的规矩：缺动作就少一个按钮）
  showDiagnosis(latest, {});
}

/**
 * 取数：队列快照 + 最近的历史失败，交给 pickFailureSource 定谁说了算。
 * 两个入口共用这一份 —— 各自查一遍的话，一个改了边界（limit）另一个就会拿旧口径说话。
 */
async function _failureSources() {
  const queue = (typeof getState === 'function' && getState('queueSnapshot')) || [];
  let hist = [];
  try {
    const r = await api.queryHistory({ status: 'error', sort: 'recent', limit: 200 });
    hist = (r && r.items) || [];
  } catch (_e) { /* 历史读不到时只剩队列那一半 —— 别让整个入口失灵 */ }
  return pickFailureSource(queue, hist);
}

/** 鉴权/VIP 类：自动重试没有意义，须先去设置处理（全仓唯一定义处，判定走 isAuthFailure） */
const AUTH_CODES = ['VIP_REQUIRED', 'AUTH_EXPIRED', 'LOGIN_REQUIRED'];

/**
 * 纯判定：这个码是不是「重试也没用，得先去设置」。
 * 队列的批量重试与失败报告都问它 —— 以前两处各自手抄三码，
 * 加一个鉴权码要改三个地方，漏一处就是"设置没改却自动重试了 N 次"。
 */
export function isAuthFailure(code) {
  return !!code && AUTH_CODES.includes(String(code));
}

/**
 * 纯聚合：error 任务按 classifyFailure 分组。
 * 队列行与历史行都吃这个函数：分组只认 status/errorCode/error/title，
 * taskId 缺就缺着（下面的 retryableFailureCount 因此能把"够不着重试的"筛出去）。
 * @returns {Array<{code,cause,advice,heal,songs:Array}>} 按数量降序
 */
export function groupFailures(items) {
  const groups = new Map();
  for (const it of items || []) {
    if (!it || it.status !== 'error') continue;
    const d = classifyFailure(it.errorCode, it.error);
    let g = groups.get(d.code);
    if (!g) { g = { ...d, songs: [] }; groups.set(d.code, g); }
    g.songs.push({ taskId: it.taskId, title: it.title || '未知曲目' });
  }
  return Array.from(groups.values()).sort((a, b) => b.songs.length - a.songs.length);
}

/**
 * 纯取数规则：失败清单由谁提供 —— 队列优先，队列空（重启后必然）才由历史兜底。
 * 刻意不相加去重：队列的 taskId 与历史的 id 不同源（一个是下载任务号、一个是平台曲目号），
 * 拿 title 去凑是猜，宁可只在队列没有时兜底。
 * `latest` 在这里算，不在调用处算：两个来源的次序正好相反（队列快照按入队顺序，
 * 最新在尾；历史查询按 recent 排，最新在头），这条差别让每个入口各记一遍迟早记错。
 * @returns {{items:Array, origin:?string, latest:?Object}}
 */
export function pickFailureSource(queueItems, historyItems) {
  const q = (queueItems || []).filter(i => i && i.status === 'error');
  if (q.length) return { items: q, origin: 'queue', latest: q[q.length - 1] };
  const h = (historyItems || []).filter(i => i && i.status === 'error');
  if (h.length) return { items: h, origin: 'history', latest: h[0] };
  return { items: [], origin: null, latest: null };
}

/** 可自动重试（非鉴权类）的任务总数 */
export function retryableFailureCount(groups) {
  // 两道闸门：鉴权类重试也没用（isAuthFailure）；历史来源没有 taskId，按下去就是空转
  return groups.reduce(
    (n, g) => n + (isAuthFailure(g.code) ? 0 : g.songs.filter(s => s.taskId).length),
    0,
  );
}

function _closeFailReport() {
  const el = document.getElementById('failReportOverlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function _renderFailReport(groups, origin) {
  _closeFailReport();
  const total = groups.reduce((n, g) => n + g.songs.length, 0);
  const overlay = document.createElement('div');
  overlay.id = 'failReportOverlay';
  overlay.className = 'edit-overlay';
  overlay.setAttribute('data-modal', '');
  overlay.setAttribute('data-modal-close', '-');
  overlay.setAttribute('data-modal-pri', '10');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeFailReport(); });

  const panel = document.createElement('div');
  panel.className = 'edit-panel';

  const header = document.createElement('div');
  header.className = 'edit-header';
  const title = document.createElement('span');
  title.className = 'edit-title';
  // 出处要如实说出来：队列重启就空了，这份清单是历史里翻出来的，别让用户以为是当前队列
  title.textContent = `🩹 失败诊断报告（${total} 首 · ${groups.length} 类原因）`
    + (origin === 'history' ? ' · 来自下载历史' : '');
  const close = document.createElement('button');
  close.className = 'edit-close';
  close.textContent = '✕';
  close.addEventListener('click', _closeFailReport);
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'edit-body';
  for (const g of groups) {
    const names = g.songs.slice(0, 6).map(s => s.title).join('、')
      + (g.songs.length > 6 ? ` 等 ${g.songs.length} 首` : '');
    const row = document.createElement('div');
    row.className = 'sched-job';
    row.innerHTML =
      `<div class="sched-job-lines"><b>${esc(g.cause)}</b> · ${g.songs.length} 首（${esc(g.code)}）</div>` +
      `<div class="sched-job-lines">${esc(g.advice)}</div>` +
      `<div class="sched-job-lines" style="opacity:.7">${esc(names)}</div>`;
    body.appendChild(row);
  }

  const retryable = retryableFailureCount(groups);
  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
  if (retryable > 0) {
    const b = document.createElement('button');
    b.className = 'btn btn-primary';
    b.textContent = `🔄 一键重试可恢复任务（${retryable}）`;
    b.addEventListener('click', async () => {
      _closeFailReport();
      let ok = 0;
      for (const g of groups) {
        if (isAuthFailure(g.code)) continue;
        for (const s of g.songs) {
          if (!s.taskId) continue; // 与 retryableFailureCount 同一条闸门：数进去的才按得动
          try { const r = await api.retryDownload(s.taskId); if (r && r.ok) ok++; } catch (_e) { /* 单个失败不影响整体 */ }
        }
      }
      showToast(ok ? `已重试 ${ok} 项` : '重试未成功，可稍后再试', ok ? 'success' : 'warn', 3000);
    });
    foot.appendChild(b);
  }
  if (origin === 'history') {
    // 历史来源：逐首诊断/重下都在历史页那一行上，报告只负责说清"为什么红了一堆"
    const b = document.createElement('button');
    b.className = retryable > 0 ? 'btn' : 'btn btn-primary';
    b.textContent = '📜 转到下载历史';
    b.addEventListener('click', () => {
      _closeFailReport();
      if (typeof switchDlSubTab === 'function') switchDlSubTab('history');
    });
    foot.appendChild(b);
  }
  body.appendChild(foot);
  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

/** 入口：聚合失败任务并弹报告（队列优先，队列空了看历史） */
async function openFailureReport() {
  const { items, origin } = await _failureSources();
  const groups = groupFailures(items);
  if (!groups.length) { showToast('队列和历史里都没有失败任务', 'info', 2000); return; }
  _renderFailReport(groups, origin);
}

if (typeof document !== 'undefined') {
  window.diagnoseFailure = diagnoseFailure;
  window.diagnoseLatestFailure = diagnoseLatestFailure;
  window.closeFailureDiag = _closeDiag;
  window.openFailureReport = openFailureReport;
  window.closeFailureReport = _closeFailReport;
}
