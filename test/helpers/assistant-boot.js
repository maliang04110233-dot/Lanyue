/**
 * 助手视图测试的共用起台：fake-dom + loadView + 可控的 ipcRenderer 桩。
 *
 * 为什么抽出来：上下文测试（ai-assistant-context）与循环测试（ai-assistant-agent-loop）
 * 起的是同一个视图模块、同一批 DOM id、同一条 ipcRenderer 桩语义 —— 各攒一份的后果
 * 就是「工具通道的形参签名在一份里改了，另一份还在喂旧的」，那种红灯读起来像回归，
 * 实则是桩漂移。所以这里一份，谁要用谁 require。
 *
 * 调用方控制两样：
 *   - state：getState 读的表（可在桩里改，模拟「助手自己改了队列」）；
 *   - { tools, plan, tool, confirm }：目录 / 每回合模型答什么 / 工具执行回执 / 模态确认桩。
 * 返回句柄额外带：tick（让出事件循环）、confirms（askConfirm 被调次数）、
 * settled()（sendAssistant 的 Promise 是否已落地 —— 循环还在等用户决定时它是 false）。
 */
'use strict';

const { installBrowserGlobals, tick } = require('./fake-dom');
const { loadView } = require('./view-module');

const VIEW = 'src/renderer/js/views/ai-assistant.js';
const IDS = ['assistantLog', 'assistantInput', 'assistantSendBtn', 'assistantProviderPanel', 'toastContainer'];

const SONG = (id, title) => ({
  id,
  source: 'netease',
  title,
  artist: '张三',
  quality: 'hires',
  // 这两枚真在歌曲对象里（歌词与本地路径），最容易被「顺手全塞进提示」带出去：
  lyrics: 'LYRICS-LEAK 一行歌词',
  localPath: 'D:\\MUSIC\\path-leak.mp3',
});

/** 默认工具目录：与助手真实面同形（name/description/mutating），供「上下文」用例用 */
const DEFAULT_TOOLS = [{ name: 'search_music', description: '搜歌', mutating: false, risk: 'read', audience: 'both' }];

async function boot(state = {}, { tools, plan, tool, confirm, extraGlobalsHook } = {}) {
  const calls = { plan: [], tool: [] };
  // 视图静态 import confirmDialog，全局桩拦不到它 —— 打开解析钩子的重定向，
  // 让 confirm 桩经 __TEST_CONFIRM__ 生效（只在本 boot 生效，不动别的视图测试）。
  globalThis.__STUB_CONFIRM_DIALOG__ = true;
  globalThis.__TEST_CONFIRM_CALLS__ = [];
  globalThis.__TEST_CONFIRM__ = confirm || true;
  if (extraGlobalsHook) extraGlobalsHook(globalThis);
  let settled = false;

  const dom = installBrowserGlobals({
    ids: IDS,
    extraGlobals: {
      getState: (k) => (k in state ? state[k] : null),
      ipcRenderer: {
        invoke: async (channel, ...args) => {
          if (channel === 'ai-assistant-tools') {
            return { tools: tools || DEFAULT_TOOLS };
          }
          if (channel === 'ai-assistant-plan') {
            calls.plan.push({ messages: args[0], context: args[1] });
            const round = calls.plan.length;
            if (!plan) return { ok: true, reply: '好', steps: [] };
            const r = plan(args[0], args[1], round);
            // 主进程那一侧返回的是解析好的对象 { ok, reply, steps }；
            // 测试里用字符串写模型的原始 JSON 最顺手，所以在这里统一 parse 并补 ok。
            if (typeof r === 'string') {
              try { const o = JSON.parse(r); return { ok: true, ...o }; } catch (_e) { return { ok: false, error: 'LLM_FAILED' }; }
            }
            return r;
          }
          if (channel === 'ai-assistant-tool-call') {
            // Task 7 起的 6 参签名：name, args, confirmed, scope, runId。
            // tool 桩收 (state, calls, args)：闭包里改 state 能模拟「助手自己动了队列」，
            // 返回 truthy 值则作为该次调用的回执，否则走默认 done。
            calls.tool.push(args);
            if (tool) { const r = tool(state, calls, args); if (r) return r; }
            return { ok: true, text: 'done' };
          }
          // 厂商面板挂起来时要读配置：给一份最小的合法包，本文件不测它
          return { providers: [], current: { providerId: 'minimax', hasKey: true }, supportsMusic: true, keys: {} };
        },
      },
    },
  });
  const mod = await loadView(VIEW, dom, { stubConfirm: true });

  // sendAssistant 的 Promise 落地与否：循环还在等用户决定时它是 false。
  // 用 then 标记而不是 await —— 测试要的就是「先让它挂着，我去点按钮」。
  const origSend = globalThis.sendAssistant;
  const sendTracked = async () => {
    settled = false;
    const p = origSend();
    p.then(() => { settled = true; }, () => { settled = true; });
    return p;
  };
  globalThis.sendAssistant = sendTracked;

  return {
    mod, dom, calls,
    get confirms() { return (globalThis.__TEST_CONFIRM_CALLS__ || []).length; },
    settled: () => settled,
    tick,
    sendAssistant: (text) => {
      dom.element('assistantInput').value = text;
      return sendTracked();
    },
  };
}

/** 走真实用户路径：往输入框里写字，再点发送（sendAssistant 只认 window 上那个） */
async function send(dom, text) {
  dom.element('assistantInput').value = text;
  await globalThis.sendAssistant();
}

module.exports = { boot, send, IDS, SONG };
