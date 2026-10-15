/**
 * 助手的确认闸门与白名单（静态守卫）
 *
 * 「写操作要先问用户」如果只长在界面上，就等于没长：任何绕过界面的调用方
 * （以后新增的快捷键、命令面板、或者助手自己拼的 invoke）都能不确认就改歌单。
 * 所以闸门在主进程（handler 里调 assistantGate.js 那道纯函数），且确认状态是**参数**
 * （confirmed === true + scope），不是「渲染层已经问过了」这种口头承诺。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const ASSISTANT = read('src/main/ipc/ai-assistant.js');
const CONTRACT = read('src/shared/ipcContract.js');
const { AGENT_TOOLS } = require('../src/main/mcp/tools');
const { toolsFromContract } = require('../src/main/mcp/tools');

test('三条助手通道都在契约里且 invoke 给 main', () => {
  for (const ch of ['ai-assistant-tools', 'ai-assistant-plan', 'ai-assistant-tool-call']) {
    assert.match(CONTRACT, new RegExp(`'${ch}':\\s*\\{\\s*invoke:\\s*MAIN`), `${ch} 未声明进契约`);
    assert.match(ASSISTANT, new RegExp(`handle\\('${ch}'`), `${ch} 未注册 handler`);
  }
});

test('确认闸门在主进程且按 risk 判：判据只有一处', () => {
  assert.match(ASSISTANT, /gateAssistantCall\(tool, \{ confirmed, scope \}\)/, 'handler 没调用那道闸');
  assert.match(ASSISTANT, /error: deny/, '拒了要回令牌');
  assert.ok(!/askConfirm/.test(ASSISTANT), '主进程不该出现确认框：确认是 UI 的事');
  const gate = read('src/main/ipc/assistantGate.js');
  assert.match(gate, /tool\.risk !== 'read' && confirmed !== true/, 'write 的确认判据不在了');
  assert.match(gate, /scope !== 'single'/, '批量令牌换不到 destructive 的那道拒不在场');
});

test('失败原因是令牌不是文案（中文句子的家在渲染层词典，日志除外）', () => {
  // 令牌现在长在两份文件里：handler 的 `error: '令牌'` 与闸的 `return '令牌'`。
  // 抽闸把 NEED_CONFIRM 那几枚搬走了，只扫 handler 的话，闸里写句中文也不会红。
  const GATE = read('src/main/ipc/assistantGate.js');
  const errs = [
    ...ASSISTANT.matchAll(/error:\s*'([^']*)'/g).map((m) => m[1]),
    ...GATE.matchAll(/return '([^']*)'/g).map((m) => m[1]),
  ];
  assert.ok(errs.length >= 4, `该有若干个令牌化失败点，实得 ${errs.length}`);
  for (const e of errs) {
    assert.ok(!/[\u4e00-\u9fa5]/.test(e), `错误该是可判定令牌: ${e}`);
  }
});

test('助手不扩白名单：现取工具表，且不绕开桥碰任意 handler', () => {
  const names = new Set(toolsFromContract().map(t => t.name));
  assert.strictEqual(names.size, AGENT_TOOLS.length);
  assert.match(ASSISTANT, /toolsFromContract\(\)/, '助手必须现取工具表，不许自带一份清单');
  // getInvokeHandler 能取到**任何**通道的 handler —— 助手用它就是绕开白名单
  assert.ok(!/getInvokeHandler\(/.test(ASSISTANT), '助手绕开桥直接取了任意 handler');
});

// 上限这个数只该有一份：契约按它截运输，服务按它截提示，两边各写一遍迟早飘。
test('契约里 context 的 t.str 上限 = 服务侧 MAX_CONTEXT_CHARS（同一个数不许有两份）', () => {
  const { MAX_CONTEXT_CHARS } = require('../src/api/services/aiAssistantService');
  const line = CONTRACT.split('\n').find((l) => l.includes("'ai-assistant-plan'"));
  assert.ok(line, '契约里找不到 ai-assistant-plan 那行');
  const m = line.match(/'context',\s*t\.str\((\d+)\)/);
  assert.ok(m, `context 没作为位置参数进契约（这行是：${line.trim()}）`);
  assert.strictEqual(Number(m[1]), MAX_CONTEXT_CHARS, '两处上限飘了');
});
