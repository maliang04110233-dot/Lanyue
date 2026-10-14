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
 * Key 输入行存在理由：这把 Key 的既有录入口在 AI 创作页，而那一页由 FEATURES.ai
 * 关着 —— 助手若不带入口，出货配置下每次提问都只会得到 NO_KEY。存的是同一个
 * pref（prefs.set 对 aiMusicApiKey 走系统加密），不是第二个家。
 */

import { t } from '../i18n.js';
import { errBrief } from '../errBrief.js';
import { showToast } from '../toast.js';
import { askConfirm } from '../confirmDialog.js';

const MAX_TURNS = 3;

let _history = [];      // [{role,content}]，不含 system
let _tools = null;      // 助手可见目录（含 mutating）
let _busy = false;

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

// 主进程只发 ASCII 令牌，文案在这里（渲染层词典）—— 见 ipc/ai-assistant.js 的口径
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
  if (!key) return t('assistant.errLlmFailed', { msg: errBrief(code || msg || 'unknown') });
  return key === 'assistant.errLlmFailed' ? t(key, { msg: errBrief(msg || '') }) : t(key);
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
    const plan = await window.ipcRenderer.invoke('ai-assistant-plan', _history);
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

/** Key 行：读写既有 pref，值只进输入框与主进程，不进消息流、不进日志 */
async function saveAssistantKey() {
  const el = document.getElementById('assistantKeyInput');
  const v = ((el && el.value) || '').trim();
  if (!v) {
    showToast(t('toast.assistantKeyMissing'), 'error');
    if (el) el.focus();
    return;
  }
  try {
    await api.setPref('aiMusicApiKey', v);
    showToast(t('toast.assistantKeySaved'), 'success');
  } catch (e) {
    showToast(t('toast.assistantSendFailed', { msg: errBrief(e) }), 'error', 5000);
  }
}

async function initAssistant() {
  const el = document.getElementById('assistantKeyInput');
  if (!el || el.dataset.asstKeyFilled === '1') return;
  el.dataset.asstKeyFilled = '1';
  try {
    el.value = (await api.getPref('aiMusicApiKey')) || '';
  } catch (_e) {
    // pref 读不到就留空，让用户自己填 —— 不该因为一次 IPC 失败把整页废掉
  }
}

// 回车发送、Shift+回车换行
function _bindInput() {
  const input = document.getElementById('assistantInput');
  if (!input || input.dataset.asstBound === '1') return;
  input.dataset.asstBound = '1';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAssistant(); }
  });
}

document.addEventListener('DOMContentLoaded', _bindInput);
if (document.readyState !== 'loading') _bindInput();

window.sendAssistant = sendAssistant;
window.clearAssistant = clearAssistant;
window.saveAssistantKey = saveAssistantKey;
window.initAssistant = initAssistant;
