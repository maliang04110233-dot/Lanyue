/**
 * A-B 片段导出为独立音频文件
 *   - src/utils/audioConvert.js —— normalizeClip / clipNameSuffix / -ss -t 参数位 / 输出命名
 *   - src/renderer/js/abClip.js —— 出片前判定（纯函数，不碰 window）
 *   - 真 ffmpeg 冒烟：产物时长必须真的短于源（否则说明 -ss/-t 根本没生效）
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  FORMATS,
  MIN_CLIP_SEC,
  normalizeClip,
  clipNameSuffix,
  resolveOutputPath,
  buildFfmpegArgs,
  convertAudioFile,
  probeDuration,
} = require('../src/utils/audioConvert');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const esm = p => import(`../${p}?ck=${Math.random()}`);

test('normalizeClip：合法区间收敛为 2 位小数，负起点按 0 处理', () => {
  assert.deepEqual(normalizeClip(1.234, 5.678), { start: 1.23, end: 5.68 });
  assert.deepEqual(normalizeClip(-3, 10), { start: 0, end: 10 });
  assert.equal(normalizeClip(0, MIN_CLIP_SEC).start, 0);
  assert.equal(normalizeClip(0, MIN_CLIP_SEC).end, MIN_CLIP_SEC);
});

test('normalizeClip：垃圾/残缺/倒序/过短一律 null（调用方据此拒绝出片）', () => {
  for (const bad of [[null, null], [1], [undefined, 5], ['a', 'b'], [NaN, 5], [1, NaN],
    [5, 5], [5, 4], [5, 5.1], [Infinity, 10], [{}, {}], [[1], [2]]]) {
    assert.equal(normalizeClip(bad[0], bad[1]), null, `应判非法: ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizeClip(null, null), null, '两端都没传不是「全曲」也不是合法片段');
});

test('clipNameSuffix：Windows 文件名禁冒号，只能用 m/s 形态', () => {
  assert.equal(clipNameSuffix(20, 105), '_片段20s-1m45s');
  assert.equal(clipNameSuffix(1, 2.5), '_片段1s-2s');
  assert.equal(clipNameSuffix(0, 45), '_片段0s-45s');
  assert.equal(clipNameSuffix(1, 0), '');
  for (const s of [clipNameSuffix(20, 105), clipNameSuffix(0, 45)]) {
    assert.ok(!s.includes(':'), `文件名后缀不能含冒号: ${s}`);
    assert.ok(!/[\\/"*?<>|]/.test(s), `不能含路径/非法字符: ${s}`);
  }
});

test('buildFfmpegArgs：-ss 定位在 -i 之前，-t 是输出时长（等于 end-start）', () => {
  const args = buildFfmpegArgs({
    inputPath: 'in.wav', outputPath: 'out.mp3', format: 'mp3', bitrate: '128k', start: 10, end: 40.5,
  });
  const iIn = args.indexOf('-i');
  const iSs = args.indexOf('-ss');
  const iT = args.indexOf('-t');
  assert.ok(iSs > 0 && iSs < iIn, '-ss 必须在 -i 之前（输入侧定位，长文件不必从头解码）');
  assert.equal(args[iSs + 1], '10');
  assert.ok(iT > iIn, '-t 必须在输出侧');
  assert.equal(args[iT + 1], '30.5');
  assert.ok(args.indexOf('-to') === -1, '定位后 -to 语义会漂移，只能用 -t');
  assert.equal(args[args.length - 1], 'out.mp3', '输出路径必须仍是最后一个参数');
});

test('buildFfmpegArgs：未截片段时参数与改造前逐字一致（转码老路径回归钉）', () => {
  const plain = buildFfmpegArgs({ inputPath: 'in.wav', outputPath: 'out.mp3', format: 'mp3' });
  assert.equal(plain.join(' '), '-nostdin -i in.wav -y -codec:a libmp3lame -b:a 320k out.mp3');
  assert.equal(plain.indexOf('-ss'), -1);
  assert.equal(plain.indexOf('-t'), -1);
  // 只给一端 = 非法片段，按全曲处理，绝不能拼出 -ss undefined
  const half = buildFfmpegArgs({ inputPath: 'in.wav', outputPath: 'out.mp3', format: 'mp3', start: 5 });
  assert.equal(half.join(' '), plain.join(' '));
});

test('resolveOutputPath：片段后缀进文件名，且外部塞进来的分隔符被洗掉', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-clip-'));
  try {
    const input = path.join(dir, 'song.wav');
    fs.writeFileSync(input, 'x');
    const p = resolveOutputPath({ inputPath: input, outputDir: dir, format: 'mp3', nameSuffix: '_片段1s-2s' });
    assert.equal(path.basename(p), 'song_片段1s-2s.mp3');
    const evil = resolveOutputPath({ inputPath: input, outputDir: dir, format: 'mp3', nameSuffix: '/../../etc/pw' });
    assert.equal(path.dirname(evil), dir, '后缀不得越出输出目录');
    assert.ok(path.basename(evil).startsWith('song'), '仍应以原曲名打头');
    assert.ok(!path.basename(evil).includes('/') && !path.basename(evil).includes('\\'), '越界分隔符被洗掉');
    // 同名片段不覆盖（连续截同一段会撞名）
    fs.writeFileSync(p, 'x');
    const again = resolveOutputPath({ inputPath: input, outputDir: dir, format: 'mp3', nameSuffix: '_片段1s-2s' });
    assert.equal(path.basename(again), 'song_片段1s-2s_1.mp3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('渲染层格式镜像与主进程 FORMATS 逐一对应（防只改一侧）', async () => {
  const { CLIP_FORMATS } = await esm('src/renderer/js/abClip.js');
  assert.deepEqual(CLIP_FORMATS.slice().sort(), Object.keys(FORMATS).sort());
});

// ── 真实 ffmpeg：截取必须真的生效 ──────────────────────
const _ff = require('child_process').spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
const NO_FFMPEG = _ff.status === 0 ? false : '本机未找到 ffmpeg，跳过';

test('convertAudioFile：截 1–2.5s 出来的文件时长≈1.5s 而不是源曲 4s', { skip: NO_FFMPEG, timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-clip-run-'));
  try {
    const wav = path.join(dir, 'tone.wav');
    const { spawnSync } = require('child_process');
    const mk = spawnSync('ffmpeg', [
      '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
      '-codec:a', 'pcm_s16le', wav,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    assert.strictEqual(mk.status, 0, '合成测试音频失败: ' + mk.stderr.toString().slice(0, 200));
    const srcDur = await probeDuration('ffmpeg', wav);
    assert.ok(srcDur > 3.5 && srcDur < 4.5, `源应约 4s，实际 ${srcDur}`);

    const progresses = [];
    const res = await convertAudioFile({
      inputPath: wav, outputDir: dir, format: 'mp3', bitrate: '128k',
      start: 1, end: 2.5, onProgress: (p) => progresses.push(p), timeoutMs: 30000,
    });
    assert.strictEqual(res.success, true, `截取应成功: ${JSON.stringify(res)}`);
    assert.equal(path.basename(res.path), 'tone_片段1s-2s.mp3', '输出名要带片段区间');
    const outDur = await probeDuration('ffmpeg', res.path);
    assert.ok(outDur > 1 && outDur < 2.2, `产物应约 1.5s（远短于源 4s），实际 ${outDur}`);
    // 片段进度分母用片段长度而非整曲，否则永远冲不到 100%
    assert.ok(progresses.length > 0 && Math.max(...progresses) > 60, `进度应跑到高位: ${progresses}`);

    // 非法区间不做片段：走全曲老路径
    const bad = await convertAudioFile({
      inputPath: wav, outputDir: dir, format: 'mp3', start: 3, end: 1, timeoutMs: 30000,
    });
    assert.strictEqual(bad.success, true, `非法区间应回落全曲转码: ${JSON.stringify(bad)}`);
    assert.ok(!path.basename(bad.path).includes('片段'), '回落全曲时不该带片段后缀');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 渲染层判定 ────────────────────────────────────────

test('planClipExport：缺本地文件 / 没点区间 / 过短 都要挡住并给出可操作提示', async () => {
  const { planClipExport } = await esm('src/renderer/js/abClip.js');
  const r = assertNo(planClipExport({ filePath: '', region: { a: 1, b: 20 } }));
  assert.match(r.msg, /本地文件/);
  assert.match(
    planClipExport({ filePath: 'C:\\m\\a.mp3', region: null }).msg,
    /A-B 循环/,
  );
  assert.match(planClipExport({ filePath: 'C:\\m\\a.mp3', region: { a: 5, b: 5.05 } }).msg, /太短/);
  assert.match(planClipExport({ filePath: 'C:\\m\\a.mp3', region: { a: 'x', b: 'y' } }).msg, /无效/);
  assert.equal(planClipExport({}).ok, false, '无参数不得抛错');
});

test('planClipExport：合法区间出参齐全，B 点越过曲尾按实际时长收口', async () => {
  const { planClipExport, clipFormatFor } = await esm('src/renderer/js/abClip.js');
  const p = planClipExport({ filePath: 'D:\\音乐\\歌.mp3', region: { a: 12.34, b: 45.6 }, duration: 200 });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.deepEqual(
    { inputPath: p.inputPath, start: p.start, end: p.end, outputFormat: p.outputFormat },
    { inputPath: 'D:\\音乐\\歌.mp3', start: 12.34, end: 45.6, outputFormat: 'mp3' },
  );
  const clamped = planClipExport({ filePath: 'a.flac', region: { a: 10, b: 999 }, duration: 60 });
  assert.equal(clamped.end, 60, 'duration 已知时按曲尾收口');
  assert.equal(clamped.outputFormat, 'flac', 'flac 截段不该被压成 mp3');
  const noDur = planClipExport({ filePath: 'a.wav', region: { a: 0, b: 30 }, duration: NaN });
  assert.equal(noDur.end, 30, '时长未知（NaN）时不收口');
  assert.equal(noDur.outputFormat, 'wav');
  // 格式镜像：m4a→aac，未知容器→mp3，查询串/片段锚点不能骗过后缀判定
  assert.equal(clipFormatFor('x.m4a'), 'aac');
  assert.equal(clipFormatFor('x.opus'), 'mp3');
  assert.equal(clipFormatFor('x.mp3?token=1'), 'mp3');
  assert.equal(clipFormatFor(''), 'mp3');
});

test('clipResultToast：取消/成功/失败三态，成功文案带区间', async () => {
  const { clipResultToast } = await esm('src/renderer/js/abClip.js');
  const plan = { start: 80, end: 105 };
  assert.deepEqual(clipResultToast({ canceled: true }, plan), { kind: 'info', text: '已取消导出' });
  assert.equal(clipResultToast({ success: true }, plan).kind, 'success');
  assert.equal(clipResultToast({ success: true }, plan).text, '✂ 片段已导出（1:20–1:45）');
  assert.match(clipResultToast({ error: '未找到 ffmpeg' }, plan).text, /未找到 ffmpeg/);
  assert.equal(clipResultToast(null, plan).kind, 'error', '空返回也要报错而不是静默');
});

function assertNo(r) {
  assert.equal(r.ok, false, `应被拒绝: ${JSON.stringify(r)}`);
  return r;
}

// ── 接线 ──────────────────────────────────────────────

test('接线：菜单项 / 面板入口 / 主进程透传 / 零新通道 全齐', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /id="btnAbClipExport"[^>]*onclick="exportAbClip\(\)"/, '播放器更多菜单缺入口');
  assert.match(read('src/renderer/js/app.js'), /import '\.\/abClip\.js';/, '模块没被加载（onclick 找不到函数）');
  assert.match(read('src/renderer/js/abLoop.js'), /export function getAbRegion/, 'abLoop 未导出区间访问器');
  const palette = read('src/renderer/js/commandPalette.js');
  assert.match(palette, /id: 'pl-abclip'/, '命令面板缺入口');
  assert.match(palette, /_call\('exportAbClip'\)/, '命令面板未指向同一个全局函数');

  const lib = read('src/main/ipc/library.js');
  assert.match(lib, /start: clip \? clip\.start : null/, '主进程未透传起点');
  assert.match(lib, /const clip = \(start != null \|\| end != null\)/, '主进程未做区间合法性判定');
  assert.match(lib, /片段区间无效/, '非法区间必须明确失败，不能静默出全曲');

  // 复用既有通道：契约里 convert-audio 仍是自由对象参数，且没冒出新通道名
  const contract = read('src/shared/ipcContract.js');
  assert.match(contract, /'convert-audio':\s*\{ invoke: MAIN, args: \[\['params', t\.obj\(\)\]\] \}/);
  assert.ok(!/'[a-z-]*(export-clip|clip-export|cut-audio|audio-clip|clip-save)'/.test(contract), '不该为此功能新增通道名');
  const clipMod = read('src/renderer/js/abClip.js');
  assert.match(clipMod, /api\.convertAudio\(/, '渲染层未复用转码通道');
  assert.ok(!clipMod.includes('invoke(') && !clipMod.includes('ipcRenderer'), '渲染层不该绕过 api 桥直接发 IPC');
});
