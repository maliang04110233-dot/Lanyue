/**
 * 接线钉：网络歌曲的歌词区必须**主动显示**（而不是一直藏在 display:none 里）。
 *
 * 背景（2026-10-16 用户反馈「歌词现在不显示了」）：
 *   player.js 的本地歌曲分支在播放开始时会清空歌词区，随后异步加载 LRC；
 *   但**网络歌曲分支**从不主动显示歌词区 —— 初始/切歌后它一直是 display:none，
 *   而歌词是异步获取的（慢、失败、或该平台本就无词）。
 *   结果：慢或失败时歌词区一直看不见，用户看到的现象就是「歌词不显示」。
 *
 * 修复 + 本钉钉住三条：
 *   1. 网络分支播放开始时**立即** showNoLyrics()（用户永远能看到歌词面板，
 *      有词加载后 parseLrc 会覆盖为逐字高亮）；
 *   2. 网络分支歌词为空时 showNoLyrics()（不残留上一首的歌词）；
 *   3. 网络分支 getLyrics 抛异常时 showNoLyrics()（失败也有「暂无歌词」占位）。
 *
 * 本文件用静态断言（readFileSync + includes），与 test/home-plat-tabs.test.js
 * 同一套路 —— player.js 顶层有 DOM 访问，node 下 import 不可行。
 *
 * 说明：这里只断言「调用存在 + 相对顺序正确」，不断言相邻行/严格缩进，
 * 因为网络分支里有说明性注释、catch 是单行、import 是多行，锚点若写死
 * 会把「代码风格差异」误判成「缺陷」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const PLAYER = read('src/renderer/js/player.js');

/** 提取「网络歌曲分支」之后的代码片段，避免误匹配本地分支 */
function networkBranchCode() {
  const start = PLAYER.indexOf('// ── 网络歌曲分支 ───');
  assert.ok(start > -1, 'player.js 缺少「网络歌曲分支」标记');
  const end = PLAYER.indexOf('// ── 切歌 ───', start);
  assert.ok(end > start, '找不到网络分支的结束边界（切歌标记）');
  return PLAYER.slice(start, end);
}

test('网络歌曲分支播放开始时立即 showNoLyrics()（不再藏 display:none）', () => {
  const code = networkBranchCode();
  // 关键：清空本地文件路径（标志着进入网络分支）之后，必须紧跟 showNoLyrics() 调用；
  // 且它必须出现在「歌曲标题写入」之前，保证面板在异步歌词回来前就已可见。
  const clearLocalIdx = code.indexOf("setState('_currentLocalFilePath', null);");
  assert.ok(clearLocalIdx > -1, '网络分支应清空本地文件路径');
  const showIdx = code.indexOf('showNoLyrics();');
  assert.ok(showIdx > -1, '网络分支缺少 showNoLyrics() 调用');
  assert.ok(
    showIdx > clearLocalIdx && showIdx < code.indexOf("document.getElementById('playerTitle')"),
    'showNoLyrics() 应发生在网络分支开头、歌曲标题写入之前，让歌词面板立即可见'
  );
});

test('网络歌曲歌词为空时 showNoLyrics()（不残留上一首歌词）', () => {
  const code = networkBranchCode();
  const emptyIdx = code.indexOf("setState('_currentLyricRaw', '');");
  assert.ok(emptyIdx > -1, '网络分支应有清空歌词 state 的分支');
  // 清空 state 之后、本分支闭合之前必须有 showNoLyrics()
  const afterEmpty = code.slice(emptyIdx, code.indexOf('} catch', emptyIdx));
  assert.ok(afterEmpty.includes('showNoLyrics();'),
    '网络分支歌词为空时只清空 state 却不调 showNoLyrics() 会残留上一首歌词');
});

test('网络歌曲 getLyrics 异常时 showNoLyrics()（失败也有占位）', () => {
  const code = networkBranchCode();
  const catchIdx = code.indexOf('} catch');
  assert.ok(catchIdx > -1, '网络分支应有 getLyrics 的异常兜底');
  const catchBlock = code.slice(catchIdx);
  // catch 里不能只剩 /* ignore */：失败也必须置为无词占位
  assert.ok(catchBlock.includes("setState('_currentLyricRaw', '');"),
    '网络分支 catch 必须清空歌词 state，避免残留上一首');
  assert.ok(catchBlock.includes('showNoLyrics();'),
    '网络分支 catch 只 /* ignore */ 会让歌词区永远不更新（保持上一首或隐藏）');
});

test('showNoLyrics 与 parseLrc 都已从 lyrics.js 导入 player.js', () => {
  // import 是多行（换行列表 + `} from './player/lyrics.js';`），故不能只匹配单行
  const lyricImport = PLAYER.match(/^[\s\S]*?from '\.\/player\/lyrics\.js';/m);
  assert.ok(lyricImport, 'player.js 应从 ./player/lyrics.js 导入歌词函数');
  assert.ok(/parseLrc/.test(lyricImport[0]) && /showNoLyrics/.test(lyricImport[0]),
    'player.js 的歌词导入应同时含 parseLrc 与 showNoLyrics');
});
