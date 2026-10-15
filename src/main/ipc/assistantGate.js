/**
 * 助手工具调用的确认闸（纯函数，主进程侧唯一的判据）
 *
 * 抽成函数而不是写在 handler 里，是因为它的四种组合必须能被逐条断言 ——
 * 写在 handler 里就得为了测一个分支去起整条桥。
 * 返回 null = 放行；返回字符串 = ASCII 令牌，由渲染层查词典成人话。
 */
function gateAssistantCall(tool, { confirmed, scope }) {
  if (tool.audience === 'app') return 'APP_ONLY';   // 主进程没有执行它的能力
  if (tool.risk !== 'read' && confirmed !== true) return 'NEED_CONFIRM';
  // destructive 只认单项确认：批量令牌换不到「删/清空」。真 IPC 路径下 scope 缺省是
  // 'single'（契约里 t.enum 的默认值），所以 undefined 只可能来自绕过契约的裸调用 —— 拒。
  if (tool.risk === 'destructive' && scope !== 'single') return 'AGENT_SCOPE_MISMATCH';
  return null;
}

module.exports = { gateAssistantCall };
