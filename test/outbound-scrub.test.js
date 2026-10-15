/**
 * 发给厂商的文本里不许出现本机路径与凭据（spec 第五节）。
 *
 * 为什么要一道新闸而不是「渲染层少塞点」：上下文那条出网路（_appContext）已经守住了
 * 歌词与本地路径，但工具返回值是**第二条**路 —— 返回值由主进程的 handler 产出，
 * 形状不归界面管（聚合曲库与播放队列里每条都可能带 path/localPath）。
 * 判据放在桥的出口一处：这样加新工具不必各自记得剥，也不存在「剥了两份、各漏一处」。
 *
 * 刻意不含 `lyric`：`get_lyrics` 的存在理由就是把歌词取回来给用户看，
 * 把它一起剥掉是砍功能不是堵泄漏。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { LEAK_KEYS, scrubOutbound, scrubToolText } = require('../src/shared/outboundScrub');

test('键名黑名单是那份唯一清单，且都是「本机路径 / 凭据」类', () => {
  for (const k of ['path', 'localPath', 'filePath', 'dir', 'cookie', 'token', 'apiKey', 'secret', 'savePath']) {
    assert.ok(LEAK_KEYS.includes(k), `少了 ${k}`);
  }
  assert.ok(!LEAK_KEYS.includes('lyric'), 'get_lyrics 的正文不许被剥');
  // 这份清单是「唯一出处」，所以要钉死到具体成员：只允许登记过的这些键。
  // savePath 是控制方裁定 R-15 补进来的（query_history 的返回值里带绝对本机路径，
  // 漏了它这道闸对下载历史等于没装）。要再加键得先有同级别的实测依据，不许顺手扩。
  assert.deepStrictEqual([...LEAK_KEYS].sort(), [
    'accessToken', 'apiKey', 'cookie', 'cookies', 'dir', 'filePath',
    'localPath', 'path', 'savePath', 'secret', 'token',
  ].sort(), '黑名单成员飘了：既多了谁，或少了谁');
});

test('递归剥：数组里、嵌套对象里的黑名单键一律消失', () => {
  const out = scrubOutbound({
    queue: [{ title: '晚风', path: 'D:\\MUSIC\\a.mp3', nested: { localPath: 'D:\\b.mp3', id: 7 } }],
    active: { name: '默认', dir: 'D:\\MUSIC' },
  });
  const text = JSON.stringify(out);
  assert.ok(!/D:\\\\MUSIC/.test(text), text);
  assert.ok(text.includes('晚风') && text.includes('"id":7'), '该留的业务字段被一起剥了');
  // 另一半判据：一道只会把所有字段抹掉的闸不算闸。
  // 同上，被剥的只是那两个路径键 —— 同层的 name 必须原样留着。
  assert.deepStrictEqual(out.active, { name: '默认' }, 'active.name 被顺手剥了');
  assert.deepStrictEqual(out.queue[0].nested, { id: 7 }, 'nested.id 被顺手剥了');
});

test('递归形状：数组套数组、数组套对象都要走到', () => {
  const out = scrubOutbound([
    [{ path: 'D:\\x', keep: 1 }],
    { list: [{ dir: 'D:\\y', name: 'n' }, { token: 'T', id: 2 }] },
  ]);
  assert.deepStrictEqual(out, [[{ keep: 1 }], { list: [{ name: 'n' }, { id: 2 }] }]);
});

test('不改动原对象（审计与真 handler 的返回值还要用）', () => {
  const src = { songs: [{ title: 'x', path: 'D:\\p' }] };
  scrubOutbound(src);
  assert.strictEqual(src.songs[0].path, 'D:\\p', '脱敏写回了原对象');
});

test('不是 JSON 就当没有可读：回空串，不许把原文丢给厂商', () => {
  assert.strictEqual(scrubToolText('这不是 JSON，里面有 D:\\SECRET.mp3'), '');
  // 读不出来的东西一条都不许出去：非字符串、空串、只有空白同样回空串
  assert.strictEqual(scrubToolText(''), '');
  assert.strictEqual(scrubToolText('   '), '');
  assert.strictEqual(scrubToolText(undefined), '');
});

test('出口只走 scrubToolText：解析成功给脱敏后的 JSON 文本', () => {
  // 字面量里写四道斜杠才是「合法的 JSON 文本」：两道（简报原样）在 JS 里是 `\a`，
  // JSON 不认这个转义 → 这段文本从一开始就 parse 不动，钉的其实是上面那枚「非 JSON 回空串」，
  // 而不是「解析成功给脱敏后的 JSON」。这里改的是转义写法，断言的形状没动。
  assert.deepStrictEqual(JSON.parse(scrubToolText('{"songs":[{"title":"晚风","localPath":"D:\\\\a.mp3"}]}')),
    { songs: [{ title: '晚风' }] });
  // 桥（mcpCore）对 undefined 返回值会 stringify 成 "null"：那仍是一段读得出形状的文本，
  // 剥完照原样回，不该被当成「解析失败」而静默掉
  assert.strictEqual(scrubToolText('null'), 'null');
});
