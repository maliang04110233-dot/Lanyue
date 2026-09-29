/**
 * 二级窗口（迷你播放器 / 桌面歌词）专用最小 preload
 *
 * 这两个窗口渲染的是远端来源的歌词/曲名（XSS 风险面），绝不能持有主窗口
 * musicAPI 的 ~90 个通道（delete-file / save-cookie / get-cookies / set-pref
 * 等）。放行清单由主进程注入的 --ipc-contract 参数派生（win:'secondary'
 * 标记，当前实测：7 个 send + 2 个 receive，见审查报告 C4/M2）。
 * sandbox preload 运行时不能 require 应用相对路径，故走 argv 注入。
 */
const { contextBridge, ipcRenderer } = require('electron');

const raw = process.argv.find(a => a.startsWith('--ipc-contract='));
if (!raw) {
  console.error('[揽乐][preload-secondary] 缺少 --ipc-contract 参数，miniAPI 不可用（检查主进程 additionalArguments 注入）');
}
const contract = raw ? JSON.parse(raw.slice('--ipc-contract='.length)) : { send: [], receive: [] };

const SEND = new Set(contract.send);
const RECEIVE = new Set(contract.receive);

contextBridge.exposeInMainWorld('miniAPI', {
  send(channel, ...args) {
    if (SEND.has(channel)) ipcRenderer.send(channel, ...args);
  },
  on(channel, callback) {
    if (RECEIVE.has(channel)) {
      ipcRenderer.on(channel, (_, data) => callback(data));
    }
  },
});
