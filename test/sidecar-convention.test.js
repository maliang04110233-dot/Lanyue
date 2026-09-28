/**
 * 歌词 sidecar 命名约定收成一处
 *
 * `.lrc` 路径在 5 个地方各写了一遍正则（library.js 两处在0d07b92 已收口），
 * 三份余下的并不等价：
 *   downloadQueue.js  /\.[^.]+$/    —— 字符类不排分隔符。
 *     'D:/v1.2/music/无扩展名曲' 被当成"扩展名 = .2/music/无扩展名曲"，
 *     整段替换成 'D:/v1.lrc' —— 歌词写到曲库外的另一个目录去了。
 *   ai-music.js       /\.mp3$/i     —— 只对 mp3 成立，换格式即静默失配（写成原路径=覆盖音频）。
 *   onlineLrc.js      ext 三元       —— 行为对，是第 4 份拷贝。
 * 收成 relinkRefs.sidecarPathFor 一处：字符类排除 \\ / ，无扩展名则追加。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { sidecarPathFor } = require('../src/utils/relinkRefs');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('sidecarPathFor：扩展名段不跨目录分隔符（内联正则会写到曲库外）', () => {
  // 目录名带点、文件名无扩展名 —— 手抄正则会把整段路径尾巴当扩展名吃掉
  assert.equal(sidecarPathFor('D:/v1.2/music/song'), 'D:/v1.2/music/song.lrc');
  assert.equal(sidecarPathFor('/m/1.2/song.flac'), '/m/1.2/song.lrc');
  assert.equal(sidecarPathFor('D:\\v1.2\\music\\song.mp3'), 'D:\\v1.2\\music\\song.lrc');
  // 逐字符保持与旧写法一致的正常用例（收口不能改变现有行为）
  assert.equal(sidecarPathFor('D:/music/a.mp3'), 'D:/music/a.lrc');
  assert.equal(sidecarPathFor('D:/music/a.tar.gz'), 'D:/music/a.tar.lrc');
  assert.equal(sidecarPathFor('D:/music/noext'), 'D:/music/noext.lrc');
  assert.equal(sidecarPathFor(''), '');
});

test('全库只剩一处 .lrc 拼法（内联正则一律清零）', () => {
  const offenders = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(fp); continue; }
      if (!/\.js$/.test(e.name)) continue;
      const rel = path.relative(ROOT, fp).replace(/\\/g, '/');
      if (rel === 'src/utils/relinkRefs.js') continue;
      const src = fs.readFileSync(fp, 'utf8');
      // 任何把路径 replace 成 '.lrc' 的内联写法都是第 6 份约定
      if (/replace\([^)]*,\s*'\.lrc'\)/.test(src)) offenders.push(rel);
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(offenders, [], '这些文件还在自己拼 .lrc 路径，改用 sidecarPathFor');
});

test('三处消费方真的接上了（不是只删了旧写法）', () => {
  for (const [file, needCall] of [
    ['src/main/downloadQueue.js', true],
    ['src/utils/onlineLrc.js', true],
    ['src/main/ipc/ai-music.js', true],
  ]) {
    const src = read(file);
    assert.match(src, /require\([^)]*relinkRefs'\)/, `${file} 没引 sidecarPathFor`);
    if (needCall) assert.ok(src.includes('sidecarPathFor('), `${file} 引了不用`);
  }
  // downloadQueue 是主进程热路径：歌词写入仍必须在 embedId3Tags 之后、且不阻塞状态推进
  const dq = read('src/main/downloadQueue.js');
  assert.ok(dq.indexOf('embedId3Tags(savePath') < dq.indexOf('sidecarPathFor(savePath'), '顺序变了要重新评估失败隔离');
});
