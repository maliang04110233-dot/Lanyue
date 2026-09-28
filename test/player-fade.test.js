/**
 * 播放淡入 / 淡出（/）纯函数 + 接线钉
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const FADE_SRC = read('../src/renderer/js/player/fade.js');
const PLAYER_SRC = read('../src/renderer/js/player.js');
const SLEEP_SRC = read('../src/renderer/js/player-controls.js');
const MS_SRC = read('../src/renderer/js/player/mediaSession.js');
const HTML = read('../src/renderer/index.html');
const PALETTE = read('../src/renderer/js/commandPalette.js');

const mod = () => import(`../src/renderer/js/player/fade.js?ck=${Math.random()}`);

test('nextFadeMs 循环档位 关→0.5→1→2→关', async () => {
  const { nextFadeMs, FADE_STEPS } = await mod();
  assert.deepEqual(FADE_STEPS, [0, 500, 1000, 2000]);
  assert.equal(nextFadeMs(0), 500);
  assert.equal(nextFadeMs(500), 1000);
  assert.equal(nextFadeMs(1000), 2000);
  assert.equal(nextFadeMs(2000), 0);
  assert.equal(nextFadeMs('bad'), 500); // 未知值从关起
});

test('fadeStageLabel 文案', async () => {
  const { fadeStageLabel } = await mod();
  assert.equal(fadeStageLabel(0), '关');
  assert.equal(fadeStageLabel(500), '0.5s');
  assert.equal(fadeStageLabel(2000), '2s');
});

test('fadeVolumeAt 线性斜坡与钳制', async () => {
  const { fadeVolumeAt } = await mod();
  assert.equal(fadeVolumeAt(0.8, 0, 0, 1000), 0);
  assert.equal(fadeVolumeAt(0.8, 0, 500, 1000), 0.4);
  assert.equal(fadeVolumeAt(0.8, 0, 1000, 1000), 0.8);
  assert.equal(fadeVolumeAt(0.8, 0, 9999, 1000), 0.8);
  assert.equal(fadeVolumeAt(0.8, 0, -5, 1000), 0);
  assert.equal(fadeVolumeAt(0.8, 0, 3, 0), 0.8); // dur<=0 直接到位
});

test('shouldFadeIn：暂停恢复/新曲淡入，缓冲恢复（非暂停+已播放）不淡', async () => {
  const { shouldFadeIn } = await mod();
  assert.equal(shouldFadeIn(true, 120), true);
  assert.equal(shouldFadeIn(false, 0), true);
  assert.equal(shouldFadeIn(false, 0.5), true);
  assert.equal(shouldFadeIn(false, 120), false);
});

test('fadeOutVolumeAt：start→0 线性下降并钳制，dur<=0 直接归零', async () => {
  const { fadeOutVolumeAt } = await mod();
  assert.equal(fadeOutVolumeAt(0.8, 0, 0, 1000), 0.8);
  assert.equal(fadeOutVolumeAt(0.8, 0, 250, 1000), 0.6);
  assert.equal(fadeOutVolumeAt(0.8, 0, 500, 1000), 0.4);
  assert.equal(fadeOutVolumeAt(0.8, 0, 1000, 1000), 0);
  assert.equal(fadeOutVolumeAt(0.8, 0, 9999, 1000), 0, '越界不外溢成负音量');
  assert.equal(fadeOutVolumeAt(0.8, 0, -5, 1000), 0.8);
  assert.equal(fadeOutVolumeAt(0.8, 0, 3, 0), 0, 'dur<=0 等价立即停');
  assert.equal(fadeOutVolumeAt('x', 0, 0, 1000), 0, '脏入参不起飞');
});

test('缓停接线钉：fadeOutPause 归零后才 pause，且收尾前还原滑条音量（否则下次淡入取到 0）', () => {
  assert.match(FADE_SRC, /export function fadeOutPause\(audio\) \{/);
  assert.match(FADE_SRC, /if \(!_fadeOutMs \|\| _outRaf \|\| !audio \|\| audio\.paused\) return false;/,
    '关档/已在缓停/已暂停都不接管');
  assert.match(FADE_SRC, /const start = audio\.muted \? 0 : audio\.volume;/);
  assert.ok(FADE_SRC.includes('_cancelRaf(); // 淡入还在跑的话先接管音量'), '两条斜坡不得同时写 volume');
  assert.match(FADE_SRC, /_cancelFadeOut\(\); \/\/ 还原滑条音量后再停/);
  assert.match(FADE_SRC, /if \(_outAudio && _outResumeVol > 0\) _outAudio\.volume = _outResumeVol;/);
  assert.match(FADE_SRC, /audio\.addEventListener\('play', \(\) => \{ _cancelFadeOut\(\); \}\);/,
    '缓停中途又开播要把音量交还，别留下静音');
  assert.match(FADE_SRC, /_cancelRaf\(\); _cancelFadeOut\(\); \}\);/, '外部 pause（媒体键/曲终）同样交还音量');
  assert.match(FADE_SRC, /api\.getPref\('fadeOutMs'\)/);
  assert.match(FADE_SRC, /window\.fadeOutPause = fadeOutPause;/);
  assert.match(FADE_SRC, /window\.cycleFadeOut = cycleFadeOut;/);
});

test('三处暂停入口先问淡出（切歌暂停/睡眠到点/媒体键 stop），到点仍保底主动 pause', () => {
  assert.match(PLAYER_SRC, /if \(typeof window\.fadeOutPause === 'function' && window\.fadeOutPause\(audio\)\) return;/);
  assert.match(SLEEP_SRC, /if \(typeof window\.fadeOutPause !== 'function' \|\| !window\.fadeOutPause\(audio\)\) audio\.pause\(\);/);
  assert.match(MS_SRC, /if \(typeof window\.fadeOutPause === 'function' && window\.fadeOutPause\(audio\)\) return;/);
});

test('UI 接线钉：更多菜单「播放淡出」项 + 档位徽标 + 命令面板 pl-fadeout', () => {
  assert.match(HTML, /<button class="pc-more-item" id="btnFadeOut" role="menuitem"[^>]*onclick="cycleFadeOut\(\)">/);
  assert.match(HTML, /<span class="pc-more-val" id="fadeOutVal">关<\/span>/);
  assert.match(PALETTE, /\{ id: 'pl-fadeout'[\s\S]{0,200}?_call\('cycleFadeOut'\) \},/);
});
