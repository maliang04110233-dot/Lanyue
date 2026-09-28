/**
 * 播放失败分流诊断
 *   - src/renderer/js/playError.js —— isLocalFileSong / describePlayError（纯函数，无 DOM）
 *   - src/renderer/js/app.js —— audio error 监听唯一调用点接入
 *
 * 关注的是"说清楚"而不是"改行为"：跳过当前曲的策略不变，
 * 变的是文案 —— 本地文件被移走时不能再说"音源播放出错"，
 * 那会把用户支去查网络，而真正该查的是下载目录。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const esm = p => import(`../${p}?ck=${Math.random()}`);

test('isLocalFileSong：只认非空 filePath，在线/拖入临时行都不算本地文件', async () => {
  const { isLocalFileSong } = await esm('src/renderer/js/playError.js');
  assert.equal(isLocalFileSong({ filePath: 'D:/music/a.mp3' }), true);
  assert.equal(isLocalFileSong({ filePath: '   ' }), false, '空白路径不算');
  assert.equal(isLocalFileSong({ url: 'https://cdn/x.mp3' }), false);
  assert.equal(isLocalFileSong({ source: 'drop', url: 'blob:https://app/1' }), false);
  assert.equal(isLocalFileSong(null), false, '脏入参不炸');
  assert.equal(isLocalFileSong(''), false);
});

test('本地文件读不到（MediaError 4）：说文件被移动/删除/改名，并带曲名', async () => {
  const { describePlayError } = await esm('src/renderer/js/playError.js');
  const r = describePlayError({ filePath: 'D:/music/a.mp3', title: '晴天', artist: '周杰伦' }, 4);
  assert.equal(r.kind, 'warn');
  assert.match(r.text, /本地文件/);
  assert.match(r.text, /移动|删除|改名/);
  assert.ok(r.text.includes('晴天 - 周杰伦'), '必须点名是哪首，队列里几十首只有一条失败');
  assert.doesNotMatch(r.text, /网络|音源播放出错/, '本地文件失败不该指向网络');
});

test('本地文件解码失败（MediaError 3）：说损坏/格式不支持，不误导成文件丢了', async () => {
  const { describePlayError } = await esm('src/renderer/js/playError.js');
  const r = describePlayError({ filePath: 'D:/music/broken.flac', title: '坏文件' }, 3);
  assert.match(r.text, /损坏|格式/);
  assert.doesNotMatch(r.text, /移动|删除/, '文件在但解不开，说"被删除"是假诊断');
  assert.ok(r.text.includes('坏文件'));
});

test('拖入即播的临时行：只说临时曲目已失效，不提本地文件也不提音源', async () => {
  const { describePlayError } = await esm('src/renderer/js/playError.js');
  const r = describePlayError({ source: 'drop', url: 'blob:file/1', title: '拖入的歌' }, 4);
  assert.match(r.text, /临时/);
  assert.doesNotMatch(r.text, /本地文件|音源/);
  assert.ok(r.text.includes('拖入的歌'));
});

test('在线音源出错：保留改造前那句原文（回归钉，别顺手改写没坏的分支）', async () => {
  const { describePlayError } = await esm('src/renderer/js/playError.js');
  const r = describePlayError({ source: 'netease', id: '1', url: 'https://cdn/x.mp3' }, 4);
  assert.equal(r.text, '⚠️ 音源播放出错，自动播放下一曲');
  assert.equal(r.kind, 'warn');
  assert.equal(r.local, false);
});

test('缺曲名/缺 code 的脏组合不炸，且每句都带"下一曲"提示（行为不变：仍会跳）', async () => {
  const { describePlayError } = await esm('src/renderer/js/playError.js');
  for (const [song, code] of [[{}, 4], [null, undefined], [{ filePath: 'x' }, 0], [{ title: '' }, 3]]) {
    const r = describePlayError(song, code);
    assert.ok(typeof r.text === 'string' && r.text.length > 0);
    assert.match(r.text, /下一曲/);
    assert.ok(['warn', 'error'].includes(r.kind));
  }
});

test('接线：app.js 唯一调用点改用分流文案，本地失败展示更久，零新 IPC 通道', async () => {
  const app = read('src/renderer/js/app.js');
  // 花括号留白：155 给同一模块加了兄弟导出（playFailureRetry 等），钉住"名字在里面"即可
  assert.match(app, /import \{[^}]*\bdescribePlayError\b[^}]*\} from '\.\/playError\.js';/, '模块没被加载');
  assert.match(app, /describePlayError\(cur, _audio\.error\.code\)/, '错误监听没吃到 MediaError.code');
  assert.match(app, /e\.local \? 5500 : 3000/, '本地文件失效要说得更久（用户要去翻下载目录）');
  assert.equal((app.match(/音源播放出错，自动播放下一曲/g) || []).length, 0, '通用文案只该活在 playError.js 里');
  assert.doesNotMatch(read('src/shared/ipcContract.js'), /play-error|playError/, '不该为此新增通道');
});
