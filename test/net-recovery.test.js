/**
 * （上半）：断网这件事，界面要认得
 *
 * 队列里那些红色任务此前分两种命运，而且两种都错：
 *   - 断网跑完的任务无码 ⇒ 用户看到一排红条 +「未分类的失败」，只能一条条手点重试；
 *   - 复网之后没有任何东西回头看它们 ⇒ 红条一直红着，直到用户想起来自己点。
 * 码补齐（下半）之后，渲染层第一次有可能问「哪些红条是在等网络的」，于是这一页可以：
 *   断网时给一条横幅说清「现在断网，N 个任务在等恢复」；复网时把这 N 条自动重新入队。
 *
 * 本文件钉的是"界面这半边的账"：
 *   1 网络码清单在渲染层只有一份字面量，且与 src/shared/netClass.js 逐字相等（家法同 WIRING_194/203）；
 *   2 挑任务的口径：只挑 error + 网络码，别的红条（VIP/版权/磁盘）一律不碰；
 *   3 引擎自归类的每一枚码都在诊断码表有行 —— 210 管住了平台回写的码，
 *     但引擎自己新写的码不在那个扫描面里，漏登记时红条照样不戴徽标；
 *   4 横幅/提示的句子两边词典成对、占位符成对，且 index.html 里那枚元素与 JS 用的 id 对得上。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import netClass from '../src/shared/netClass.js';

const ROOT = path.join(process.cwd());
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const fresh = () => import(`../src/renderer/js/netRecovery.js?ck=${Math.random()}`);
const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
const en = JSON.parse(read('src/renderer/js/lang/en.json'));

// ── 1：码清单只有一份，且与判据之家逐字相等 ──────────────

test(' 渲染层的网络码清单与 netClass 的 NETWORK_CODES 逐字相等', async () => {
  const { NET_CODES } = await fresh();
  assert.deepEqual(NET_CODES, netClass.NETWORK_CODES,
    '渲染层手抄的码表与判据之家漂了：横幅会漏认码，或去重试根本不是网络问题的红条');
});

// ── 2：挑任务只挑"在等网络"的红条 ────────────────────────

test(' 只把 error + 网络码的行算作"在等网络恢复"', async () => {
  const { netFailedTasks } = await fresh();
  const items = [
    { taskId: 'a', status: 'error', errorCode: 'NETWORK_ERROR' },
    { taskId: 'b', status: 'error', errorCode: 'NETWORK_TIMEOUT' },
    { taskId: 'c', status: 'error', errorCode: 'VIP_REQUIRED' },
    { taskId: 'd', status: 'error' },
    { taskId: 'e', status: 'error', errorCode: 'ENOSPC' },
    { taskId: 'f', status: 'done', errorCode: 'NETWORK_ERROR' },
    { taskId: 'g', status: 'pending', errorCode: 'NETWORK_ERROR' },
  ];
  assert.deepEqual(netFailedTasks(items).map(s => s.taskId), ['a', 'b'],
    '下载成功的、排队中的、以及非网络类失败都不该被自动重排');
});

test(' 挑出来的行带 taskId（复网时按它调既有重试通道，不另开通道）', async () => {
  const { netFailedTasks } = await fresh();
  const rows = netFailedTasks([{ taskId: 'x1', status: 'error', errorCode: 'NETWORK_ERROR' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskId, 'x1');
});

test(' 空值/非数组/脏行不抛（队列快照随时可能是空的）', async () => {
  const { netFailedTasks } = await fresh();
  for (const v of [undefined, null, '', [], {}]) {
    assert.deepEqual(netFailedTasks(v), [], `${JSON.stringify(v)} 应返回空数组而不是抛`);
  }
  assert.deepEqual(netFailedTasks([null, undefined, 0, { status: 'error' }, { taskId: 'q', status: 'error', errorCode: 'NETWORK_TIMEOUT' }])
    .map(s => s.taskId), ['q']);
});

// ── 3：引擎自归类的码必须在诊断码表登记 ──────────────────

test(' 引擎自归类的每枚网络码都有徽标与真诊断（不许掉进"未分类"）', async () => {
  const { failureTag, classifyFailure } = await import(`../src/renderer/js/diagnose.js?ck=${Math.random()}`);
  for (const code of netClass.NETWORK_CODES) {
    const tag = failureTag(code);
    assert.ok(tag, `${code} 没登记徽标：队列/历史那一行不戴牌，用户看不出它是网络问题`);
    assert.ok(/^var\(--/.test(tag.color), `${code} 徽标颜色要走语义变量`);
    const c = classifyFailure(code, '');
    assert.equal(c.code, code);
    assert.ok(c.cause && !c.cause.includes('未分类'), `${code} 的诊断仍是「未分类的失败」`);
    assert.ok(c.advice, `${code} 没有建议`);
    assert.ok(c.heal, `${code} 网络类失败应给出一键动作（retry）`);
  }
});

// ── 4：句子成对、跨文件锚对得上 ──────────────────────────

const COPY_KEYS = ['download.netOffline', 'download.netWaiting', 'toast.netRequeued'];

test(' 网络横幅与复网提示的中英文案成对，占位符也成对', () => {
  for (const key of COPY_KEYS) {
    const a = zh[key];
    const b = en[key];
    assert.ok(a, `zh.json 缺 ${key}`);
    assert.ok(b, `en.json 缺 ${key}`);
    const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    assert.deepEqual(ph(a), ph(b), `${key} 两边占位符不等：zh=${a} en=${b}`);
  }
  assert.match(zh['download.netWaiting'], /\{count\}/, '等待条数得真印出来，不是写死的"若干"');
  assert.match(zh['toast.netRequeued'], /\{count\}/);
});

test(' 横幅元素在 index.html 里，且 JS 用的 id 与它一字不差', () => {
  const html = read('src/renderer/index.html');
  const view = read('src/renderer/js/views/download.js');
  const m = html.match(/id="(netBanner)"/);
  assert.ok(m, 'index.html 里没有 #netBanner');
  assert.ok(view.includes("'netBanner'") || view.includes('"netBanner"'),
    'download.js 没按这个 id 找元素 —— 横幅会静默不出现（双 #saveDirText 的老坑）');
});

test(' 复网自动续跑走 online/offline 事件，且尊重队列暂停', () => {
  const view = read('src/renderer/js/views/download.js');
  assert.match(view, /addEventListener\(\s*['"]offline['"]/, '没听 offline：横幅不会在断网时出现');
  assert.match(view, /addEventListener\(\s*['"]online['"]/, '没听 online：复网后红条仍要人手一条条点');
  assert.match(view, /netFailedTasks/, '没问"哪些红条在等网络"');
  assert.ok(/_queuePaused/.test(view.split("addEventListener('online'")[1] ?? ''),
    '复网重排在监听里没查 _queuePaused —— 用户刚按下的暂停会被自动解掉');
});
