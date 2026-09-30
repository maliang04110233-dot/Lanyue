/**
 * 守卫：续播 seek 不得被 await 期间的竞态吃掉（根因 2）
 *
 * 问题
 * ----
 * loadAndPlay 的两个分支都是这个顺序：
 *
 *     audio.src = url;                                 // 加载开始
 *     const saved = await restorePlayProgress(song);   // 内含两次 await getPref
 *     if (saved > 0) attachResumeSeekListener(audio, saved);
 *
 * restorePlayProgress 是异步的。await 期间媒体完全可能已经就绪，
 * loadedmetadata 在监听挂上之前就发完了 —— 事后挂的监听永远收不到，
 * seek 静默不执行。表现是"每次都从 0 开始播"，没有任何报错，
 * 用户只会以为进度没记住。
 *
 * M7 修的是另一个方向（歌 A 的监听泄漏到歌 B）。同一个函数上挂着两个缺陷，
 * 所以监听必须挂两处，缺任一处都有歌会从头播。
 *
 * 本文件对着一个假 audio 元素真跑这两个方向，不是 grep 源码。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createResumeSeeker } from '../src/renderer/js/player/resumeSeek.js';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));

const PLAYER = stripComments(read('src/renderer/js/player.js'));

/** 假 audio 元素：只实现 seek 落点用到的那几个成员 */
function fakeAudio({ duration = 300, readyState = 0 } = {}) {
  return {
    duration,
    readyState,
    currentTime: 0,
    _handlers: new Map(),
    addEventListener(type, fn) {
      if (!this._handlers.has(type)) this._handlers.set(type, []);
      this._handlers.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = this._handlers.get(type) || [];
      const i = arr.indexOf(fn);
      if (i > -1) arr.splice(i, 1);
    },
    /** 派发事件，模拟浏览器已经发完的那一次 */
    emit(type) {
      for (const fn of [...(this._handlers.get(type) || [])]) fn();
    },
    listenerCount(type) {
      return (this._handlers.get(type) || []).length;
    },
    /** 媒体就绪：给 duration、抬 readyState、派发一次 loadedmetadata */
    becomeReady(dur = duration) {
      this.duration = dur;
      this.readyState = 1;
      this.emit('loadedmetadata');
    },
  };
}

// ── 1. 竞态方向：metadata 在 await 期间就已到达 ─────────

test('根因 2：metadata 先到时，attach 仍要立刻 seek（不靠等事件）', () => {
  const audio = fakeAudio();
  // 复现竞态：restorePlayProgress 的 await 期间媒体就绪了
  audio.becomeReady(300);
  assert.equal(audio.currentTime, 0, '就绪本身不该改变 currentTime');

  const seen = [];
  const seeker = createResumeSeeker({ onSeek: (a, t) => seen.push(t) });
  seeker.attach(audio, 120);

  assert.equal(audio.currentTime, 120,
    'loadedmetadata 早在 attach 之前就发完了，不补这次检查就永远不 seek —— 歌从 0 开始播');
  assert.deepEqual(seen, [120], 'onSeek 也要被通知');
});

test('根因 2：metadata 还没到时，走事件路径也能 seek', () => {
  const audio = fakeAudio();
  const seeker = createResumeSeeker({});
  seeker.attach(audio, 120);
  assert.equal(audio.currentTime, 0, '还没就绪时不该抢跑');

  audio.becomeReady(300);
  assert.equal(audio.currentTime, 120);
});

test('补口之后不留悬挂监听（否则会在下一首歌上再触发一次）', () => {
  const audio = fakeAudio();
  audio.becomeReady(300);
  const seeker = createResumeSeeker({});
  seeker.attach(audio, 120);
  assert.equal(audio.listenerCount('loadedmetadata'), 0,
    '已经就绪并当场 seek 过了，监听必须撤掉');
  assert.equal(seeker.hasPending(), false);
});

// ── 2. M7 方向：跨歌泄漏 ───────────────────────────────

test('M7：切歌时新 attach 撤掉上一首的监听（歌 B 不被 seek 到歌 A 的进度）', () => {
  const a = fakeAudio();
  const b = fakeAudio();
  const seeker = createResumeSeeker({});
  seeker.attach(a, 60);
  seeker.attach(b, 200);
  assert.equal(a.listenerCount('loadedmetadata'), 0, '歌 A 的监听没撤掉');

  a.becomeReady(300);
  assert.equal(a.currentTime, 0, '歌 A 的监听泄漏到了自己身上，还可能污染歌 B');

  b.becomeReady(300);
  assert.equal(b.currentTime, 200, '歌 B 应 seek 到自己的进度');
});

test('cancel 撤掉待触发监听', () => {
  const audio = fakeAudio();
  const seeker = createResumeSeeker({});
  seeker.attach(audio, 60);
  assert.equal(seeker.hasPending(), true);
  seeker.cancel();
  assert.equal(seeker.hasPending(), false);
  audio.becomeReady(300);
  assert.equal(audio.currentTime, 0);
});

test('attach 幂等：连续两次只留最后一个监听', () => {
  const audio = fakeAudio();
  const seeker = createResumeSeeker({});
  seeker.attach(audio, 30);
  seeker.attach(audio, 90);
  assert.equal(audio.listenerCount('loadedmetadata'), 1, '重复挂载会导致一次 metadata 触发两次 seek');
  audio.becomeReady(300);
  assert.equal(audio.currentTime, 90);
});

// ── 3. seek 条件 ───────────────────────────────────────

test('进度超过整首时长时不 seek（跳过去会停在结尾）', () => {
  const audio = fakeAudio();
  const seen = [];
  const seeker = createResumeSeeker({ onSeek: (a, t) => seen.push(t) });
  seeker.attach(audio, 999);
  audio.becomeReady(300);
  assert.equal(audio.currentTime, 0, 'savedTime > duration 时不得 seek');
  assert.deepEqual(seen, [], '也不该弹"继续播放"提示');
});

test('进度等于整首时长时同样不 seek', () => {
  const audio = fakeAudio();
  const seeker = createResumeSeeker({});
  seeker.attach(audio, 300);
  audio.becomeReady(300);
  assert.equal(audio.currentTime, 0, '等于时长没有任何可跳的空间');
});

test('duration 未就绪（NaN / 0）时不 seek，等就绪后由事件路径补', () => {
  const audio = fakeAudio({ duration: NaN, readyState: 0 });
  const seeker = createResumeSeeker({});
  seeker.attach(audio, 100);
  assert.equal(audio.currentTime, 0);
  audio.becomeReady(300);
  assert.equal(audio.currentTime, 100);
});

// ── 4. player.js 接线 ──────────────────────────────────

test('player.js 两处续播都走 createResumeSeeker（不许再有裸 addEventListener 挂法）', () => {
  assert.ok(!/addEventListener\(\s*['"]loadedmetadata['"]/.test(PLAYER),
    'player.js 里还留着裸的 loadedmetadata 挂载 —— 旧竞态还在');
  const calls = PLAYER.match(/_resumeSeeker\.attach\(/g) || [];
  assert.equal(calls.length, 2, '本地与网络两个分支都要接上，实际 ' + calls.length);
});

test('player.js 已 import resumeSeek 且旧函数名不再存在', () => {
  assert.match(PLAYER, /import\s*\{\s*createResumeSeeker\s*\}\s*from\s*['"]\.\/player\/resumeSeek\.js['"]/);
  assert.ok(!/attachResumeSeekListener/.test(PLAYER), '旧实现应被替换掉，不能留两套并存');
});
