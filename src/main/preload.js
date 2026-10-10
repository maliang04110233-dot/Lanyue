const { contextBridge, ipcRenderer } = require('electron');
// IPC 契约由主进程经 webPreferences.additionalArguments 序列化注入
// （见 src/shared/ipcContract.js buildContractArg）。sandbox preload 运行时
// 不能 require 应用相对路径，argv 是保持单一事实源的传递方式。
const logger = {
  warn: (...args) => console.warn('[揽乐][preload]', ...args),
};

const raw = process.argv.find(a => a.startsWith('--ipc-contract='));
if (!raw) {
  // 不静默降级为无白名单：宁可窗口明确报错也不暴露未校验的桥
  console.error('[揽乐][preload] 缺少 --ipc-contract 参数，musicAPI 不可用（检查主进程 additionalArguments 注入）');
}
const contract = raw ? JSON.parse(raw.slice('--ipc-contract='.length)) : { invoke: [], send: [], receive: [], methods: {}, events: {} };

// ── 白名单（派生，不再手工维护） ──────────────────────────────
const SAFE_CHANNELS_SEND    = new Set(contract.send);
const SAFE_CHANNELS_RECEIVE = new Set(contract.receive);
const SAFE_CHANNELS_INVOKE  = new Set(contract.invoke);

// ── 传输层信封解包 ────────────────────────────────────────────
// 主进程 register.js 把所有 invoke 结果包成 {envKey:1, ok, data|error}；
// 这里还原为迁移前的直连语义：ok → data（含历史遗留的 resolved {error}值），
// !ok → 抛错，让 ipcRenderer.invoke 的 Promise 拒绝，渲染层 try/catch 不变。
const ENV_KEY = contract.envKey || '__ipcEnv';
function unwrap(res) {
  if (res && typeof res === 'object' && res[ENV_KEY] === 1) {
    if (res.ok) return res.data;
    throw new Error(res.error || 'IPC 调用失败');
  }
  return res;
}

// ── 核心 musicAPI（渲染层 → 主进程的 IPC 桥）────────────
// 方向判定来自契约的 invoke 清单；不在其中且是 send 通道的走 ipcRenderer.send
// （send-only 通道走 invoke 会无人应答、Promise 永远 pending）。
function makeApiMethod(ipcChannel) {
  if (!SAFE_CHANNELS_INVOKE.has(ipcChannel) && SAFE_CHANNELS_SEND.has(ipcChannel)) {
    return (...args) => ipcRenderer.send(ipcChannel, ...args);
  }
  return (...args) => ipcRenderer.invoke(ipcChannel, ...args).then(unwrap);
}

const _musicApiBase = {
  invoke(channel, ...args) {
    if (SAFE_CHANNELS_INVOKE.has(channel)) {
      return ipcRenderer.invoke(channel, ...args).then(unwrap);
    }
    logger.warn('[preload] 未授权的 IPC 通道:', channel);
  },
  get version() { return ipcRenderer.invoke('get-version').then(unwrap); },
};

// 从 METHODS 批量生成调用方法（渲染层 camelCase → 契约通道）
for (const [name, channel] of Object.entries(contract.methods)) {
  _musicApiBase[name] = makeApiMethod(channel);
}

// 从 EVENTS 批量生成订阅方法
for (const [name, channel] of Object.entries(contract.events)) {
  _musicApiBase[name] = (cb) => ipcRenderer.on(channel, (_, d) => cb(d));
}

contextBridge.exposeInMainWorld('musicAPI', _musicApiBase);

// ── ipcRenderer 向后兼容（供 updater.js / settings.js 使用）────────
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(channel, callback) {
    if (SAFE_CHANNELS_RECEIVE.has(channel)) {
      ipcRenderer.on(channel, (_, data) => callback(data));
    }
  },
  invoke(channel, ...args) {
    if (SAFE_CHANNELS_INVOKE.has(channel)) {
      return ipcRenderer.invoke(channel, ...args).then(unwrap);
    }
    logger.warn('[preload] 未授权的 IPC 通道:', channel);
  },
  send(channel) {
    if (SAFE_CHANNELS_SEND.has(channel)) {
      ipcRenderer.send(channel);
    } else {
      logger.warn('[preload] 未授权的 IPC 通道:', channel);
    }
  },
});

// miniAPI 只在 preload-secondary.js（迷你播放器/桌面歌词窗口）暴露，
// 主渲染层统一用 musicAPI，避免两套并行 API 形状漂移。
