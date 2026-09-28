/**
 * 本地文件播不出来时，就地给一口"重新下载"
 *
 * 症状（用户视角）：手工删过下载目录 / 挪过盘之后，从队列或历史点 ▶ 播一首"当年下过"的歌，
 * 得到的只是一句「📁 本地文件读不到，可能已被移动、删除或改名」+ 自动跳下一曲（
 * 把说法改对了，但也仅止于说法）。想重下得自己翻到下载历史、认出那一行、再点 🔄 ——
 * 而 153/154 的批量口在另一个页面上，正在听歌的人根本想不到那儿去。
 * 机理：本地行播失败 = 磁盘与记录的引用关系断了，这是"就地补救"最该出现的时刻；
 * 但只有带平台主键（id+source）的行才有源可下 —— 本地曲库行与拖入的 blob 行没有，
 * 给它们一个点了必然失败的按钮比不给更糟。
 *
 * 顺带收口：入队载荷构造原本叫 deadRetryPayload 住在 historyFilters.js（154），
 * 现在第二个消费方（播放失败重下）出现，把它挪到中性的 enqueuePayload.js ——
 * 同一份载荷规则不许有第二家。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const loadMod = (rel) => import(`../src/renderer/js/${rel}.js?ck=${Math.random()}`);

test('enqueuePayloadFor：歌曲行 → addToQueue 载荷，缺字段兜底、不发明默认音质之外的东西', async () => {
  const { enqueuePayloadFor } = await loadMod('enqueuePayload');
  assert.deepEqual(enqueuePayloadFor(
    { id: '12', source: 'netease', title: '晴天', artist: '周杰伦', album: '叶惠美', quality: 'lossless' },
    'D:/Music',
  ), {
    id: '12', source: 'netease', title: '晴天', artist: '周杰伦', album: '叶惠美',
    saveDir: 'D:/Music', quality: 'lossless', cover: '', duration: 0,
  });
  const p = enqueuePayloadFor({ id: '7', source: 'qq', title: 'X' }, 'D:/Music');
  assert.equal(p.album, '');
  assert.equal(p.artist, '');
  assert.equal(p.quality, 'standard');
  // 刻意不带 forceRedownload：文件可能刚好又回来了，该让主进程查重跳过而不是覆盖式重下
  assert.equal(p.forceRedownload, undefined);
});

test('enqueuePayloadFor：没有主键就没有"源"可下，返回 null 而不是造半成品载荷', async () => {
  const { enqueuePayloadFor } = await loadMod('enqueuePayload');
  assert.equal(enqueuePayloadFor({ id: '', source: 'qq' }, 'D:/Music'), null);
  assert.equal(enqueuePayloadFor({ id: '1', source: '' }, 'D:/Music'), null);
  assert.equal(enqueuePayloadFor({ title: '本地曲库的歌' }, 'D:/Music'), null);
  assert.equal(enqueuePayloadFor(null, 'D:/Music'), null);
  assert.equal(enqueuePayloadFor('junk', 'D:/Music'), null);
});

test('playFailureRetry：只有"能说出从哪下"的本地行才配一个重下按钮', async () => {
  const { playFailureRetry } = await loadMod('playError');
  assert.deepEqual(playFailureRetry({ id: '9', source: 'netease', title: 'T', artist: 'A', filePath: 'D:/a.mp3' }),
    { id: '9', source: 'netease', title: 'T', artist: 'A', album: '', quality: '' });
  assert.equal(playFailureRetry({ filePath: 'D:/a.mp3' }), null);            // 本地曲库行：文件就是它本身
  assert.equal(playFailureRetry({ id: '9', source: 'netease' }), null);      // 没有 id/source 谈不上重下
  assert.equal(playFailureRetry({ id: '9', source: 'netease', url: 'blob:x' }), null); // 拖入行
  assert.equal(playFailureRetry(null), null);
});

test('playFailureRetry：解码失败(3) 不提议重下 —— 文件在但解不开，重下一遍还是解不开', async () => {
  const { playFailureRetry, CODE_DECODE } = await loadMod('playError');
  assert.equal(playFailureRetry({ id: '9', source: 'netease', filePath: 'D:/a.mp3' }, CODE_DECODE), null);
  assert.ok(playFailureRetry({ id: '9', source: 'netease', filePath: 'D:/a.mp3' }, 4));
});

test('playFailureRetryText：按钮旁的话要说清"文件不在了"，别只重复诊断（吃行，和两个兄弟函数同形）', async () => {
  const { playFailureRetryText } = await loadMod('playError');
  const t = playFailureRetryText({ title: '晴天', artist: '周杰伦' });
  assert.match(t, /晴天 - 周杰伦/);
  assert.match(t, /不在磁盘上|已不存在|读不到/);
});

test('showActionToast：可交互 toast 只有一个实现，「仍要下载」那种旧弹窗必须复用它', async () => {
  const src = read('src/renderer/js/utils.js');
  assert.match(src, /function showActionToast\(/);
  assert.match(src, /window\.showActionToast = showActionToast/);
  // showRedownloadToast 必须委托，不许留第二份"造 div + 按钮 + 定时消失"的实现
  const old = src.slice(src.indexOf('function showRedownloadToast('));
  const body = old.slice(0, old.indexOf('\n}', old.indexOf('showActionToast')));
  assert.match(body, /showActionToast\(/);
  assert.doesNotMatch(body, /setTimeout\(/);
  assert.doesNotMatch(body, /createElement\('button'\)/);
});

test('接线：播放器 error 分流后，可重下的本地行走带按钮的 toast，别的照旧', () => {
  const src = read('src/renderer/js/app.js');
  const at = src.indexOf('_audio.addEventListener(\'error\'');
  assert.ok(at > -1, 'error 分流点必须还在原位');
  const body = src.slice(at, at + 1200);
  assert.match(body, /playFailureRetry\(/);
  assert.match(body, /showActionToast\(/);
  assert.match(body, /retryAfterPlayFailure/);
  // 无按钮可给时必须退回原来的纯文字诊断（146 的行为不许丢）
  assert.match(body, /describePlayError\(/);
  assert.match(body, /showToast\(/);
  assert.ok(body.indexOf('nextSong()') > body.indexOf('playFailureRetry('), '跳下一曲仍要在补救提示之后');
});

test('retryAfterPlayFailure：入队后按主进程的回话如实说，不给自己发成功', async () => {
  const src = read('src/renderer/js/playRetry.js');
  assert.match(src, /enqueuePayloadFor\(/);
  assert.match(src, /classifyRetryResult/);
  assert.match(src, /dup|已在队列/);
  assert.match(src, /had|又回来了|还在磁盘/); // 文件其实回来了要讲清楚，别演"已入队"
  assert.match(src, /switchDlSubTab/);        // 下起来了把人带到队列
});

test('零新通道：新链路只走既有 addToQueue，播放器那段接线自己一个 api 调用都不加', () => {
  // app.js 全量 api.* 名单不该由本增量维护（30+ 个既有方法），本增量的口径是：
  // ① 新模块只用一个既有方法；② error 分流那段自己做零调用（动作全在 playRetry.js 里）。
  // 真往 preload 白名单塞名字，test/ipc-contract.test.js 的计数钉会先炸。
  const retryApi = new Set([...read('src/renderer/js/playRetry.js').matchAll(/\bapi\.([A-Za-z0-9_]+)/g)].map(m => m[1]));
  assert.deepEqual([...retryApi], ['addToQueue'], 'playRetry.js 只许用既有 addToQueue');
  const src = read('src/renderer/js/app.js');
  const at = src.indexOf("_audio.addEventListener('error'");
  const close = src.slice(at).indexOf('\n      });'); // 监听器自己那一层的收尾
  assert.ok(close > 200, 'error 监听器结构变了，请重定截取边界');
  const body = src.slice(at, at + close);
  assert.doesNotMatch(body, /\bapi\./, '播放失败补救不该顺手新增 IPC 调用');
});
