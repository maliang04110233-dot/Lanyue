/**
 * 助手的一张计划卡 —— 纯渲染，不取词、不问人、不执行。
 *
 * 为什么单独一个文件：视图那边 `_round` 已经有循环、预算、止损三层职责，
 * 再塞进 DOM 拼装就没人读得动它了；而「批准了哪几步」这份数据正是最容易写错的部分，
 * 单独一个模块能让它被逐条断言（见 test/ai-assistant-plan-card.test.js）。
 * 取词函数从外面传（labels）：这样 `assistant.*` 这些键的字面量都留在视图文件里，
 * test/ai-assistant-ui.test.js 那枚「中英齐备」的静态钉才扫得到它们。
 *
 * 为什么 selected() 读 box.checked 而不是 checkbox.checked：fake-dom 与真 DOM 在这里
 * 一致 —— change 事件里把状态同步进 box，界面拿到的就是这份「批准了哪几步」的数据。
 *
 * UI 重构（2026-10-16）：新增卡片头（标题 + 风险徽标计数）与更清晰的按钮层级
 * （批准=主色、只读=次色、取消=弱化）。返回契约（el/rows/buttons/selected/counts）
 * 与 dataset.asstDecide 保持不变，agent-loop 与 plan-card 的测试不需要跟着动。
 */

const RISK_CLASS = { read: 'asst-risk-read', write: 'asst-risk-write', destructive: 'asst-risk-destructive' };

function _mk(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function renderPlanCard({ host, steps, tools, labels }) {
  const root = _mk('div', 'asst-plan-card');
  const rows = [];

  // 卡头：标题 + 「N 步 · 其中 M 步会改数据」徽标（标题/徽标取词可选 —— 早期 stub 与静态钉
  // 传进来的 labels 只带 summary/approve 等键，缺就跳过整块卡头，避免测试桩漂移红）
  // 徽标里的 M 是风险计数，必须等下面的循环数完才能取词 —— 所以 head 先建好挂上，
  // 徽标 span 在循环结束后补进去（root 的子元素顺序不变，仍是 head → rows → foot）。
  const showHead = labels && typeof labels.title === 'string' && typeof labels.headBadges === 'function';
  let head = null;
  if (showHead) {
    head = _mk('div', 'asst-plan-head');
    head.appendChild(_mk('span', 'asst-plan-head-title', labels.title));
    root.appendChild(head);
  }

  const list = _mk('div', 'asst-plan-rows');
  root.appendChild(list);

  let writes = 0;
  let destructive = 0;

  for (const step of steps) {
    const meta = (tools || []).find((x) => x.name === step.tool) || { name: step.tool, risk: 'read' };
    if (meta.risk !== 'read') writes += 1;
    if (meta.risk === 'destructive') destructive += 1;

    const row = _mk('label', 'asst-plan-row');
    const checkbox = _mk('input', 'asst-plan-check');
    checkbox.checked = true;
    row.appendChild(checkbox);
    row.appendChild(_mk('span', `asst-risk ${RISK_CLASS[meta.risk] || RISK_CLASS.read}`,
      meta.risk === 'destructive' ? labels.riskDestructive : (meta.risk === 'read' ? labels.riskRead : labels.riskWrite)));
    row.appendChild(_mk('span', 'asst-plan-tool', String(step.tool)));
    if (step.why) row.appendChild(_mk('span', 'asst-plan-why', step.why));
    const box = { step, meta, checkbox, row, checked: true };
    checkbox.addEventListener('change', () => { box.checked = checkbox.checked !== false; });
    rows.push(box);
    list.appendChild(row);
  }

  const counts = () => ({ total: rows.length, writes, destructive });

  if (head) head.appendChild(_mk('span', 'asst-plan-head-badges', labels.headBadges(counts().total, counts().writes)));

  const foot = _mk('div', 'asst-plan-foot');
  foot.appendChild(_mk('div', 'asst-plan-summary', labels.summary(counts().total, counts().writes)));
  const decide = (kind) => {
    const btn = _mk('button', `asst-plan-btn asst-plan-${kind}`);
    btn.dataset.asstDecide = kind;
    btn.textContent = kind === 'approve' ? labels.approve : (kind === 'readOnly' ? labels.readOnly : labels.cancel);
    foot.appendChild(btn);
    return btn;
  };
  const buttons = { approve: decide('approve'), readOnly: decide('readOnly'), cancel: decide('cancel') };
  root.appendChild(foot);
  if (host) host.appendChild(root);

  return {
    el: root,
    rows,
    buttons,
    // 顺序与 step 对象原样：视图拿它直接喂给执行循环，不在这里重排或复制字段
    selected: () => rows.filter((r) => r.checked !== false).map((r) => r.step),
    counts,
  };
}