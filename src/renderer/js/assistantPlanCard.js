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
  const list = _mk('div', 'asst-plan-rows');
  root.appendChild(list);

  for (const step of steps) {
    const meta = (tools || []).find((x) => x.name === step.tool) || { name: step.tool, risk: 'read' };
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

  const counts = () => {
    let writes = 0;
    let destructive = 0;
    for (const r of rows) {
      if (r.meta.risk !== 'read') writes += 1;
      if (r.meta.risk === 'destructive') destructive += 1;
    }
    return { total: rows.length, writes, destructive };
  };

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
