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

const MAX_TURNS = 3;
const CTX_QUEUE = 8;
const CTX_SONGS = 5;

let _history = [];      // [{role,content}]，不含 system
let _tools = null;      // 助手可见目录（含 mutating）
let _busy = false;

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

/** 上屏一条消息。文本一律 textContent：模型回复与歌名都可能含尖括号 */
function _push(cls, text) {
  const box = _log();
  if (!box) return null;
  const empty = box.querySelector('.asst-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = `asst-msg ${cls}`;
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
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
};

function _errText(code, msg) {
  const key = ERR_KEYS[code];
  if (key) {
    return key === 'assistant.errLlmFailed' ? t(key, { msg: errBrief(msg || '') }) : t(key);
  }
  return providerErrText(code, t('assistant.errLlmFailed', { msg: errBrief(code || msg || 'unknown') }));
}

/**
 * 一个回合：问 →（写操作先确认）执行 → 结果回喂再问，直到没有 steps 或触上界。
 * 返回值是「为什么停」的提示文案（空串 = 模型自己收了尾）。
 */
async function _round(userText) {
  _history.push({ role: 'user', content: userText });
  const tools = await _ensureTools();
  let stopHint = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const thinking = _push('asst-msg-assistant', t('assistant.thinking'));
    const plan = await window.ipcRenderer.invoke('ai-assistant-plan', _history, _appContext());
    if (thinking) thinking.remove();
    if (!plan || plan.ok !== true) {
      stopHint = _errText(plan && plan.error, plan && plan.text);
      break;
    }
    // 模型的上一轮输出必须原样回到上下文，否则下一轮它会重复同一步
    _history.push({ role: 'assistant', content: JSON.stringify({ reply: plan.reply, steps: plan.steps }) });
    if (plan.reply) _push('asst-msg-assistant', plan.reply);
    if (!plan.steps.length) return '';

    const results = [];
    for (const step of plan.steps) {
      const meta = tools.find(x => x.name === step.tool);
      if (meta && meta.mutating) {
        const okAsk = await askConfirm({
          text: t('assistant.confirmText', { tool: step.tool, args: JSON.stringify(step.args).slice(0, 200) }),
        });
        if (!okAsk) {
          const declined = t('assistant.toolDeclined', { tool: step.tool });
          results.push({ tool: step.tool, ok: false, text: declined });
          _push('asst-step', declined);
          continue;
        }
      }
      _push('asst-step', t('assistant.toolRunning', { tool: step.tool }));
      const out = await window.ipcRenderer.invoke(
        'ai-assistant-tool-call', step.tool, step.args, meta && meta.mutating === true);
      const ok = !!(out && out.ok);
      results.push({ tool: step.tool, ok, text: ok ? out.text : _errText(out && out.error, out && out.text) });
      _push(ok ? 'asst-step' : 'asst-step asst-step-failed',
        ok ? t('assistant.toolDone', { tool: step.tool })
          : t('assistant.toolFailed', { tool: step.tool, msg: errBrief(out && out.text) }));
    }
    _history.push({ role: 'user', content: JSON.stringify({ tool_results: results }) });
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
  if (btn) btn.disabled = true;
  if (input) input.value = '';
  _push('asst-msg-user', text);
  try {
    const hint = await _round(text);
    if (hint) _push('asst-step', hint);
  } catch (e) {
    showToast(t('toast.assistantSendFailed', { msg: errBrief(e) }), 'error', 5000);
  } finally {
    _busy = false;
    if (btn) btn.disabled = false;
    if (input) input.focus();
  }
}

function clearAssistant() {
  _history = [];
  const box = _log();
  if (box) {
    box.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'asst-empty';
    d.textContent = t('assistant.empty');
    box.appendChild(d);
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
  _mountPanel();
}

document.addEventListener('DOMContentLoaded', _bindInput);
if (document.readyState !== 'loading') _bindInput();

window.sendAssistant = sendAssistant;
window.clearAssistant = clearAssistant;
