/**
 * 应用内 AI 助手（轨道二）
 *
 * 分工：主进程负责「一次出网」与「执行一个工具」，本文件负责**循环与确认**。
 * 循环放界面侧不是因为这里逻辑高级，而是因为确认框只有 UI 拿得到 ——
 * 换成主进程驱动就得发明一套 send/invoke 往返加超时与孤儿请求，换到的只是
 * 同一个 `confirmed === true` 的闸门。闸门本身在主进程（见 ipc/ai-assistant.js）。
 *
 * 纪律：写操作逐条 askConfirm 且必须 await（不 await 的确认框等于没有确认）；
 * 文本一律 textContent 上屏（歌名与模型回复都可能含尖括号）；文案全部走词典；
 * 循环有上界（MAX_TURNS），坏回复不该把用户的 API Key 刷爆。
 *
 * Key 录入行换成共用面板（../aiProviderPanel.js）：AI 创作页由 FEATURES.ai 关着，
 * 助手若不带入口就没处配 Key；而配 Key 这件事的判据（厂商名单、{厂商:Key} 的合并
 * 写法、端点合法性）全在主进程那一份登记表里，界面只画只交。两页挂同一个模块，
 * 于是「两页各攒一套 Key 写法」这种事故没有可发生的地方。
 */

import { t } from '../i18n.js';
import { errBrief } from '../errBrief.js';
import { showToast } from '../toast.js';
import { askConfirm } from '../confirmDialog.js';
import { mountProviderPanel, providerErrText } from '../aiProviderPanel.js';
import { renderPlanCard } from '../assistantPlanCard.js';

const MAX_TURNS = 6;
const MAX_RUN_CALLS = 24;
const MAX_RUN_MUTATIONS = 12;
const CTX_QUEUE = 8;
const CTX_SONGS = 5;
// 工具结果回喂的文本上限：与服务侧 MAX_RESULT_CHARS 同数（两处各一份，静态钉守着同数，
// 见 test/ai-assistant-gate.test.js）。不跨层 import 服务的原因见 _toolResultsMessage 头注。
const MAX_RESULT_CHARS_LOCAL = 4000;

let _history = [];      // [{role,content}]，不含 system
let _tools = null;      // 助手可见目录（含 mutating/risk/audience）
let _busy = false;

/** 一轮（用户的一句话到循环收束）的编号：审计靠它把同一步的几次调用串起来 */
function _newRunId() {
  const c = globalThis.crypto;
  return (c && typeof c.randomUUID === 'function')
    ? String(c.randomUUID()).slice(0, 32)
    : `r${Date.now().toString(36)}`;
}

/** 一首歌缩成一行。只取标题/歌手/来源/id（+正在播那首的音质）：歌词、本地路径不进提示 */
function _oneLine(s, withQuality) {
  if (!s || typeof s !== 'object') return '';
  const title = String(s.title || '').slice(0, 40);
  const artist = String(s.artist || '').slice(0, 30);
  const src = s.source ? ` ${s.source}` : '';
  const q = withQuality && s.quality ? ` 音质=${String(s.quality).slice(0, 12)}` : '';
  const id = s.id === undefined || s.id === null || s.id === '' ? '' : ` id=${String(s.id).slice(0, 24)}`;
  return `「${title} - ${artist}」${src}${q}${id}`;
}

/**
 * 助手唯一的「眼睛」：把此刻的应用状态缩成一段文本随每次请求递上去。
 *
 * 为什么每回合现读而不是开局拼一次：队列会被助手自己的 add_to_queue 改掉，
 * 第二回合拿着第一回合的快照回「队列里没有这首歌」就是幻觉。为什么不塞进 _history：
 * 历史会被 trimHistory 削头、被 clearAssistant 清空，状态跟着走要么被裁掉要么留下
 * 过期快照；当参数走，两者互不干扰。上限那道闸在主进程（契约 t.str + 服务里的同一枚数）。
 */

/**
 * 只在渲染层执行的能力。每一条都是**包一层 typeof 守卫**再调界面自己那个全局函数：
 * 这些函数按页面/模块加载顺序才存在（views/search.js 才装 playSong），没装就是没这个能力，
 * 此时必须如实报失败而不是让助手以为做了 —— 静默成功会让模型继续往上报「已经在放了」。
 */
const APP_ACTIONS = {
  'play.toggle': () => (typeof globalThis.togglePlay === 'function' ? (globalThis.togglePlay(), '已切换播放/暂停') : null),
  'play.next': () => (typeof globalThis.nextSong === 'function' ? (globalThis.nextSong(), '已切到下一首') : null),
  'play.prev': () => (typeof globalThis.prevSong === 'function' ? (globalThis.prevSong(), '已切到上一首') : null),
  'play.volume': (a) => {
    const v = Math.max(0, Math.min(100, Number(a && a.value) || 0));
    if (typeof globalThis.setVolume !== 'function') return null;
    globalThis.setVolume(v);
    return `音量 ${v}`;
  },
  'play.result': (a) => {
    const n = Number(a && a.index);
    // 状态段里的序号从 1 数，playSong 的数组下标从 0 数：越界就当没这回事，不执行
    if (!Number.isInteger(n) || n < 1 || n > 50) return null;
    if (typeof globalThis.playSong !== 'function') return null;
    globalThis.playSong(n - 1);
    return `开始播放第 ${n} 首结果`;
  },
  'ui.open': (a) => {
    const tab = String((a && a.tab) || '');
    if (typeof globalThis.switchTab !== 'function' || !tab) return null;
    globalThis.switchTab(tab);
    return `已切到页面 ${tab}`;
  },
};

function _appContext() {
  const g = (k) => (typeof window.getState === 'function' ? window.getState(k) : null);
  const playing = g('currentPlaying');
  const queue = g('playQueue') || [];
  const idx = Number(g('playIdx'));
  const kw = g('currentKeyword');
  const songs = g('songs') || [];
  const lines = [];
  lines.push(playing && playing.title
    ? `正在播放：${_oneLine(playing, true)}`
    : '正在播放：未在播放');
  if (queue.length) {
    const head = Number.isFinite(idx) && idx >= 0 && idx < queue.length
      ? `（第 ${idx + 1}/${queue.length} 首）`
      : `（共 ${queue.length} 首）`;
    lines.push(`待播队列${head}：` + queue.slice(0, CTX_QUEUE).map((s, i) => `${i + 1}.${_oneLine(s)}`).join(' '));
  } else {
    lines.push('待播队列：队列为空');
  }
  if (kw) {
    const top = songs.slice(0, CTX_SONGS).map((s, i) => `${i + 1}.${_oneLine(s)}`).join(' ');
    lines.push(`本次搜索：关键词「${String(kw).slice(0, 40)}」` + (top ? `，结果前 ${Math.min(songs.length, CTX_SONGS)} 首：${top}` : '，当前无结果'));
  } else {
    lines.push('本次搜索：本会话还没搜过');
  }
  return lines.join('\n');
}

function _log() { return document.getElementById('assistantLog'); }

/** 清掉空态引导（无论它是旧版 `.asst-empty` 文本还是新版 `.asst-empty-guide` 容器） */
function _dropEmptyGuide(box) {
  if (!box) return;
  const guide = box.querySelector('.asst-empty-guide');
  if (guide) guide.remove();
  const legacy = box.querySelector('.asst-empty');
  if (legacy) legacy.remove();
}

/**
 * 复制一段文本到剪贴板。渲染层用 navigator.clipboard，兜底 execCommand。
 * 返回 true/false 供界面提示（复制失败不该让对话中断）。
 */
async function _copyText(text) {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(String(text));
      return true;
    }
    const ta = document.createElement('textarea');
    ta.value = String(text);
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    document.body.removeChild(ta);
    return !!ok;
  } catch (_e) {
    return false;
  }
}

/** 时间戳：只显示 HH:MM（短时间戳足够，不引入日期复杂度） */
function _stamp() {
  try {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (_e) { return ''; }
}

/**
 * 一条对话消息（气泡）。role: 'user' | 'assistant'。
 * 结构：wrap(.asst-bubble-wrap .asst-user|.asst-assistant)
 *   ├ .asst-avatar（只助手侧有；用户侧用占位）
 *   └ .asst-bubble(.asst-msg .asst-msg-user|assistant)
 *        └ .asst-bubble-text (textContent)
 *      + .asst-bubble-meta（时间 + 复制按钮）
 * 返回 wrap，供「思考中…」占位气泡在拿到回复后移除。
 */
function _pushBubble(role, text) {
  const box = _log();
  if (!box) return null;
  _dropEmptyGuide(box);

  const wrap = document.createElement('div');
  wrap.className = `asst-bubble-wrap ${role === 'user' ? 'asst-user' : 'asst-assistant'}`;

  if (role === 'assistant') {
    const av = document.createElement('div');
    av.className = 'asst-avatar';
    av.setAttribute('aria-hidden', 'true');
    wrap.appendChild(av);
  } else {
    const av = document.createElement('div');
    av.className = 'asst-avatar asst-avatar-user';
    av.setAttribute('aria-hidden', 'true');
    wrap.appendChild(av);
  }

  const bubble = document.createElement('div');
  bubble.className = `asst-bubble asst-msg ${role === 'user' ? 'asst-msg-user' : 'asst-msg-assistant'}`;
  bubble.textContent = text;
  wrap.appendChild(bubble);

  const meta = document.createElement('div');
  meta.className = 'asst-bubble-meta';
  const time = document.createElement('span');
  time.className = 'asst-bubble-time';
  time.textContent = _stamp();
  meta.appendChild(time);
  const copyBtn = document.createElement('button');
  copyBtn.className = 'asst-copy';
  copyBtn.type = 'button';
  copyBtn.setAttribute('data-asst-copy', '1');
  copyBtn.setAttribute('title', t('assistant.copy'));
  copyBtn.textContent = t('assistant.copy');
  copyBtn.addEventListener('click', async () => {
    const ok = await _copyText(text);
    copyBtn.textContent = ok ? t('assistant.copyDone') : t('assistant.copyFailed', { msg: '' });
    copyBtn.setAttribute('data-copied', ok ? '1' : 'fail');
  });
  // 反馈态不靠定时器复位：用户下次把鼠标移回来（或键盘聚焦）就恢复「复制」。
  // 用事件而不是 setTimeout —— 定时器在切页/关窗后仍会跑，且测试进程会被挂住。
  const _resetCopy = () => { copyBtn.textContent = t('assistant.copy'); copyBtn.setAttribute('data-copied', ''); };
  copyBtn.addEventListener('mouseenter', _resetCopy);
  copyBtn.addEventListener('focus', _resetCopy);
  meta.appendChild(copyBtn);
  bubble.appendChild(meta);

  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  return wrap;
}

/**
 * 一条执行步骤（运行中/成功/失败/取消），缩进在小徽标条里。
 * kind: 'running' | 'done' | 'failed' | 'declined'。仍是 textContent 上屏。
 */
function _pushStep(text, kind) {
  const box = _log();
  if (!box) return null;
  _dropEmptyGuide(box);
  const wrap = document.createElement('div');
  wrap.className = `asst-step-row asst-step-${kind}`;
  // 文本先写在顶层节点上（真实 DOM 里 textContent 与子节点可共存；fake-dom 的 textContent
  // 不是聚合 getter，log.children.map(c => c.textContent) 只能读到顶层这一份 ——
  // agent-loop 那条「要有人话」的断言读的正是它）。之后再挂徽标点与缩进文本。
  wrap.textContent = text;
  const dot = document.createElement('span');
  dot.className = 'asst-step-dot';
  dot.setAttribute('aria-hidden', 'true');
  wrap.appendChild(dot);
  const txt = document.createElement('span');
  txt.className = `asst-step asst-step-${kind}`;
  txt.textContent = text;
  wrap.appendChild(txt);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  return wrap;
}

/** 工具目录惰性拉取：切页不该反复打 IPC */
async function _ensureTools() {
  if (_tools) return _tools;
  const r = await window.ipcRenderer.invoke('ai-assistant-tools');
  _tools = (r && r.tools) || [];
  return _tools;
}

// 主进程只发 ASCII 令牌，文案在这里（渲染层词典）—— 见 ipc/ai-assistant.js 的口径。
// 表里只留助手自己特有的令牌；配置类与 HTTP 类一律交 providerErrText（三处打的是同
// 一个出网闸，同一个失败该说同一句话，不该每处各攒一张表再各自漏几行）。
const ERR_KEYS = {
  NO_KEY: 'assistant.errNoKey',
  NEED_CONFIRM: 'assistant.errNeedConfirm',
  UNKNOWN_TOOL: 'assistant.errUnknownTool',
  LLM_FAILED: 'assistant.errLlmFailed',
  TOOL_FAILED: 'assistant.errLlmFailed',
  EMPTY: 'assistant.errEmpty',
  EMPTY_REPLY: 'assistant.errEmpty',
  AGENT_SCOPE_MISMATCH: 'assistant.errScopeMismatch',
  APP_ONLY: 'assistant.errAppOnlyTool',
};

function _errText(code, msg) {
  const key = ERR_KEYS[code];
  if (key) {
    return key === 'assistant.errLlmFailed' ? t(key, { msg: errBrief(msg || '') }) : t(key);
  }
  return providerErrText(code, t('assistant.errLlmFailed', { msg: errBrief(code || msg || 'unknown') }));
}

/** 把界面词全部在视图里取好再传进卡：本文件里的 assistant.* 字面量才扫得到那枚中英齐备的钉 */
function _cardLabels() {
  return {
    title: t('assistant.planTitle'),
    headBadges: (n, w) => t('assistant.planApproveHint', { n, w }),
    riskRead: t('assistant.riskRead'),
    riskWrite: t('assistant.riskWrite'),
    riskDestructive: t('assistant.riskDestructive'),
    approve: t('assistant.planApprove'),
    readOnly: t('assistant.planReadOnly'),
    cancel: t('assistant.planCancel'),
    summary: (n, w) => t('assistant.planSummary', { n, w }),
  };
}

/** 等用户在卡上做一个决定。resolve 之后卡就不再接受第二次点击。 */
function _awaitDecision(card) {
  return new Promise((resolve) => {
    let done = false;
    const settle = (kind) => {
      if (done) return;
      done = true;
      for (const b of Object.values(card.buttons)) b.disabled = true;
      resolve(kind);
    };
    card.buttons.approve.addEventListener('click', () => settle('approve'));
    card.buttons.readOnly.addEventListener('click', () => settle('readOnly'));
    card.buttons.cancel.addEventListener('click', () => settle('cancel'));
  });
}

/**
 * 一轮执行结果回喂成一条 user 消息。
 *
 * 不跨层 import api/services/aiAssistantService.js 的 formatToolResults：那个模块顶层
 * require 了主进程的 mcp/tools，渲染层打包路径取不到它。所以这里本地拼同一形状的消息，
 * 上限常数 MAX_RESULT_CHARS_LOCAL 由静态钉（test/ai-assistant-gate.test.js）钉成与服务侧同数。
 */
function _toolResultsMessage(results) {
  return {
    role: 'user',
    content: JSON.stringify({
      tool_results: (results || []).map(r => ({
        tool: String(r.tool || ''),
        ok: r.ok === true,
        text: String(r.text || '').slice(0, MAX_RESULT_CHARS_LOCAL),
      })),
    }),
  };
}

/**
 * 执行一批步骤。三种确认形态在这里分岔，而**判据在主进程**（assistantGate）：
 * 界面只负责发出正确的 scope/confirmed 组合，发错了主进程拒，拒了界面如实上屏。
 */
async function _execSteps(steps, tools, grant, run) {
  const results = [];
  for (const step of steps) {
    if (run.calls >= MAX_RUN_CALLS) {
      results.push({ tool: step.tool, ok: false, text: t('assistant.planStoppedBudget') });
      _pushStep(t('assistant.planStoppedBudget'), 'failed');
      run.outOfBudget = true;
      break;
    }
    const meta = tools.find((x) => x.name === step.tool) || { risk: 'read', audience: 'both' };
    const isWrite = meta.risk !== 'read';
    if (isWrite && run.mutations >= MAX_RUN_MUTATIONS) {
      results.push({ tool: step.tool, ok: false, text: t('assistant.planStoppedBudget') });
      _pushStep(t('assistant.planStoppedBudget'), 'failed');
      run.outOfBudget = true;
      break;
    }
    let confirmed = false;
    let scope = grant;
    if (meta.risk === 'destructive') {
      // 危险步骤即使在批确认里也单独弹。askConfirm 仍是本文件里唯一的模态确认入口 ——
      // test/ai-assistant-ui.test.js 那枚「恰好一处 await askConfirm」就是它还在的证据。
      scope = 'single';
      confirmed = await askConfirm({
        text: t('assistant.confirmText', { tool: step.tool, args: JSON.stringify(step.args).slice(0, 200) }),
      });
      if (!confirmed) {
        const declined = t('assistant.toolDeclined', { tool: step.tool });
        results.push({ tool: step.tool, ok: false, text: declined });
        _pushStep(declined, 'declined');
        continue;
      }
    } else {
      confirmed = isWrite;   // 只读不需要批准；非只读需要「这一批被批准了」那个事实
    }
    run.calls += 1;
    if (isWrite) run.mutations += 1;
    if (meta.audience === 'app') {
      // app-only 能力主进程帮不上：不发 IPC，本地执行并如实记结果（fn 找不到/返回 null 都算失败，
      // 与止损共用同一份 run.failures——静默成功会让模型继续往上报「已经在放了」）。
      const fn = APP_ACTIONS[meta.action || ''];
      let done = null;
      try { done = fn ? fn(step.args) : null; } catch (_e) { done = null; }
      const ok = typeof done === 'string';
      results.push({ tool: step.tool, ok, text: ok ? done : t('assistant.errAppOnlyTool') });
      _pushStep(ok ? t('assistant.stepDone', { tool: step.tool })
        : t('assistant.stepFailed', { tool: step.tool }), ok ? 'done' : 'failed');
      if (!ok) {
        const key = `${step.tool}|${JSON.stringify(step.args)}`;
        run.failures[key] = (run.failures[key] || 0) + 1;
      }
      continue;
    }
    _pushStep(t('assistant.stepRunning', { tool: step.tool }), 'running');
    const out = await window.ipcRenderer.invoke(
      'ai-assistant-tool-call', step.tool, step.args, confirmed, scope, run.id);
    const ok = !!(out && out.ok);
    if (!ok) {
      const key = `${step.tool}|${JSON.stringify(step.args)}`;
      run.failures[key] = (run.failures[key] || 0) + 1;
    }
    results.push({ tool: step.tool, ok, text: ok ? out.text : _errText(out && out.error, out && out.text) });
    _pushStep(ok ? t('assistant.stepDone', { tool: step.tool })
      : t('assistant.stepFailed', { tool: step.tool }), ok ? 'done' : 'failed');
  }
  return results;
}

/** 同 tool + 同 args 连续失败两次就停：模型会对着一个坏工具反复试，那是刷额度不是思考 */
function _stuck(run) {
  return Object.values(run.failures || {}).some((n) => n >= 2);
}

/**
 * 一个回合：问 → 计划卡批准 → 执行 → 结果回喂再问，直到没有 steps、触上界或触预算。
 * 返回值是「为什么停」的提示文案（空串 = 模型自己收了尾）。
 */
async function _round(userText) {
  _history.push({ role: 'user', content: userText });
  const tools = await _ensureTools();
  const run = { calls: 0, mutations: 0, id: _newRunId(), failures: Object.create(null) };
  let stopHint = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const thinking = _pushBubble('assistant', t('assistant.thinking'));
    const plan = await window.ipcRenderer.invoke('ai-assistant-plan', _history, _appContext());
    if (thinking) thinking.remove();
    if (!plan || plan.ok !== true) {
      stopHint = _errText(plan && plan.error, plan && plan.text);
      break;
    }
    // 模型的上一轮输出必须原样回到上下文，否则下一轮它会重复同一步
    _history.push({ role: 'assistant', content: JSON.stringify({ reply: plan.reply, steps: plan.steps }) });
    if (plan.reply) _pushBubble('assistant', plan.reply);
    if (!plan.steps.length) return '';

    const card = renderPlanCard({ host: _log(), steps: plan.steps, tools, labels: _cardLabels() });
    const kind = await _awaitDecision(card);
    if (kind === 'cancel') {
      _pushStep(t('assistant.planCancelled'), 'declined');
      return '';
    }
    const chosen = kind === 'readOnly'
      ? card.selected().filter((s) => ((tools.find((x) => x.name === s.tool) || {}).risk === 'read'))
      : card.selected();
    if (!chosen.length) { _pushStep(t('assistant.planCancelled'), 'declined'); return ''; }
    const results = await _execSteps(chosen, tools, kind === 'approve' ? 'batch' : 'readOnly', run);
    _history.push(_toolResultsMessage(results));
    if (run.outOfBudget) { stopHint = t('assistant.planStoppedBudget'); break; }
    if (_stuck(run)) { stopHint = t('assistant.planStoppedRepeat'); break; }
    stopHint = t('assistant.loopStopped');
  }
  return stopHint;
}

async function sendAssistant() {
  if (_busy) return;
  const input = document.getElementById('assistantInput');
  const text = ((input && input.value) || '').trim();
  if (!text) return;
  _busy = true;
  const btn = document.getElementById('assistantSendBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('assistant.busyHint'); }
  if (input) { input.value = ''; input.disabled = true; }
  _pushBubble('user', text);
  try {
    const hint = await _round(text);
    if (hint) _pushStep(hint, 'failed');
  } catch (e) {
    showToast(t('toast.assistantSendFailed', { msg: errBrief(e) }), 'error', 5000);
  } finally {
    _busy = false;
    if (btn) { btn.disabled = false; btn.textContent = t('assistant.send'); }
    if (input) { input.disabled = false; input.focus(); }
  }
}

/** 空态引导卡：能力点 + 快捷指令 chip。chip 点击把文本回填输入框（不自动发送） */
function _quickFill(text) {
  const input = document.getElementById('assistantInput');
  if (input) {
    input.value = text;
    input.focus();
  }
}

function _renderEmptyGuide() {
  const box = _log();
  if (!box) return;
  const guide = document.createElement('div');
  guide.className = 'asst-empty-guide';

  const title = document.createElement('div');
  title.className = 'asst-empty-title';
  title.textContent = t('assistant.title');
  guide.appendChild(title);

  const hint = document.createElement('div');
  hint.className = 'asst-empty';
  hint.textContent = t('assistant.empty');
  guide.appendChild(hint);

  const quickTitle = document.createElement('div');
  quickTitle.className = 'asst-quick-title';
  quickTitle.textContent = t('assistant.quickTitle');
  guide.appendChild(quickTitle);

  const quick = document.createElement('div');
  quick.className = 'asst-quick';
  for (const s of ['assistant.quickPlay', 'assistant.quickQueue', 'assistant.quickContext']) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'asst-quick-chip';
    chip.textContent = t(s);
    chip.addEventListener('click', () => _quickFill(t(s)));
    quick.appendChild(chip);
  }
  guide.appendChild(quick);

  box.appendChild(guide);
}

function clearAssistant() {
  _history = [];
  const box = _log();
  if (box) {
    box.innerHTML = '';
    _renderEmptyGuide();
  }
  showToast(t('toast.assistantCleared'), 'success');
}

/** 面板容器在页首（index.html 里那一行），挂一次就跟着配置刷新自己 */
function _mountPanel() {
  mountProviderPanel(document.getElementById('assistantProviderPanel'));
}

// 回车发送、Shift+回车换行
function _bindInput() {
  const input = document.getElementById('assistantInput');
  if (input && !input.dataset.asstBound) {
    input.dataset.asstBound = '1';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAssistant(); }
    });
  }
  // 面板挂载会读厂商配置（裸 api）。**不能在模块求值阶段同步跑**：
  // window.api 的 getter 要等 app.js 模块体末尾才挂载，而本模块是被 import 的，
  // 求值早于它，此刻裸 api 必然命中 `ReferenceError: api is not defined`
  // （2026-10-16 实测报错：Uncaught (in promise) ReferenceError: api is not defined）。
  // 挪到宏任务，那时 getter 必已就位。空态渲染与输入绑定不含 api，保持同步。
  setTimeout(() => _mountPanel(), 0);
  if (!_log().children.length) _renderEmptyGuide();
}

document.addEventListener('DOMContentLoaded', _bindInput);
// ESM 是 deferred，执行时 readyState 必为 interactive；立即执行一次以保证空态
// 与输入绑定不依赖事件循环（_mountPanel 已挪到宏任务，此处不含裸 api，安全）。
if (document.readyState !== 'loading') _bindInput();

window.sendAssistant = sendAssistant;
window.clearAssistant = clearAssistant;
