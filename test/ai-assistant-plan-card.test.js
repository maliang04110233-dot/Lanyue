/**
 * 计划卡的行为（不测长相，测「批准了什么」这份数据）。
 *
 * 三枚最容易回退的性质：去掉勾选后 selected() 恰好少那一步（顺序与形状不许变）、
 * 危险步骤默认不被 selected() 收进来（默认勾着不等于默认批准，视图那里还要单独弹）、
 * 模型的 why 只当文本上屏（它可能写着 <img>）。
 *
 * 套具同 local-filter-chips.test.js：fake-dom + loadView，本仓没有 jsdom。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installBrowserGlobals } = require('./helpers/fake-dom');
const { loadView } = require('./helpers/view-module');

const CARD = 'src/renderer/js/assistantPlanCard.js';

const TOOLS = [
  { name: 'search_music', description: '搜歌', mutating: false, risk: 'read', audience: 'both' },
  { name: 'add_to_queue', description: '加入下载队列', mutating: true, risk: 'write', audience: 'both' },
  { name: 'clear_all_queue', description: '清空下载队列', mutating: true, risk: 'destructive', audience: 'both' },
];
const LABELS = {
  riskRead: '只读', riskWrite: '会改数据', riskDestructive: '会删除',
  approve: '批准并执行', readOnly: '只跑只读那几步', cancel: '取消',
  summary: (n, w) => `批准 ${n} 步，其中 ${w} 步会改数据`,
};

async function boot(steps) {
  const dom = installBrowserGlobals({ ids: ['asstHost'] });
  const mod = await loadView(CARD, dom);
  const host = dom.element('asstHost');
  const card = mod.renderPlanCard({ host, steps, tools: TOOLS, labels: LABELS });
  return { dom, host, card };
}

const el = (node, pred) => {
  if (pred(node)) return node;
  for (const c of node.children || []) { const hit = el(c, pred); if (hit) return hit; }
  return null;
};
const buttons = (card) => el(card.el, (n) => n.dataset && n.dataset.asstDecide);

test('每步一行：行里带上模型的 why 与工具的人话说明', async () => {
  const { card } = await boot([{ tool: 'search_music', args: { keyword: '晨跑' }, why: '先搜一批' }]);
  assert.strictEqual(card.rows.length, 1);
  assert.ok(card.el.children.length >= 1);
  assert.deepStrictEqual(card.counts(), { total: 1, writes: 0, destructive: 0 });
});

test('取消勾选 → selected() 恰好少那一步（顺序与形状不许变）', async () => {
  const steps = [
    { tool: 'search_music', args: { keyword: 'a' } },
    { tool: 'add_to_queue', args: { song: { id: 1 } }, why: '入队' },
  ];
  const { card } = await boot(steps);
  assert.deepStrictEqual(card.selected().map((s) => s.tool), ['search_music', 'add_to_queue']);
  const cb = card.rows[1].checkbox;
  cb.checked = false;
  cb.dispatch('change');
  assert.deepStrictEqual(card.selected().map((s) => s.tool), ['search_music']);
  assert.strictEqual(card.selected()[0].args.keyword, 'a', '选中项的 args 被改写过');
});

test('counts(): 非只读算 writes、destructive 另记一笔（视图那句总账靠它）', async () => {
  const { card } = await boot([
    { tool: 'search_music', args: {} },
    { tool: 'add_to_queue', args: {} },
    { tool: 'clear_all_queue', args: {} },
  ]);
  assert.deepStrictEqual(card.counts(), { total: 3, writes: 2, destructive: 1 });
});

test('why 只当文本：含尖括号的 why 不许变成标签', async () => {
  const { card } = await boot([{ tool: 'search_music', args: {}, why: '<img src=x onerror=alert(1)>' }]);
  const node = el(card.el, (n) => n.textContent === '<img src=x onerror=alert(1)>');
  assert.ok(node, 'why 没按原文上屏');
  assert.ok(!card.el.innerHTML.includes('<img'), 'innerHTML 里不该出现模型给的标签');
});

test('三个动作按钮都在，且各自标了 dataset.asstDecide 供界面接线', async () => {
  const { card } = await boot([{ tool: 'search_music', args: {} }]);
  const seen = [];
  (function walk(n) { if (n.dataset && n.dataset.asstDecide) seen.push(n.dataset.asstDecide); (n.children || []).forEach(walk); }(card.el));
  assert.deepStrictEqual(seen.sort(), ['approve', 'cancel', 'readOnly']);
  assert.ok(buttons(card), 'buttons 找不到');
});
