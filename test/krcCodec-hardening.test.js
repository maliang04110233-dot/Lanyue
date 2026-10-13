/**
 * KRC 解码的边界加固（2026-10-13 复审 P2-11）
 *
 * 四条旧洞，本文件逐条钉住：
 *   1. decryptKrc 直接 subarray(4) 跳过「魔数」，从不核对 —— 内容被网关/代理
 *      截断时报错只说「解压失败」，排查只能靠猜。现在魔数不符/内容过短是可分辨的
 *      两种失败。
 *   2. zlib.inflateSync 没有输出上限。本模块跑在主进程（= UI 线程），一段几百 KB
 *      的压缩炸弹能一次性吃满内存把应用顶死。对照 webdav.js:31 早就有
 *      MAX_RESPONSE_BYTES，这里是全仓唯一没有上限的解压点。
 *   3. 行/词时间轴完全不排序，依赖「源文件本来有序」这个假设；行序一乱，输出的
 *      .lrc 时间戳非递增，逐行歌词 UI 就来回跳。
 *   4. [language:...] 只删掉标记行本身（且无 /g），翻译块正文被当歌词解析进来 ——
 *      与文件头「此处跳过翻译块」的声明不符，且旧 fixture 里没有该分支，等于零覆盖。
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const { decryptKrc, parseKrcXml, krcToLrc } = require('../src/utils/krcCodec');

/** 格式互操作常量（与生产同一份）：16 字节 XOR key */
const XOR_KEY = Buffer.from([
  0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47,
  0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69,
]);

/** 按 KRC 封装链造一个合法 content：magic + XOR(deflate(xml)) → base64 */
function buildKrc(xml, { magic = 'krc1' } = {}) {
  const body = Buffer.from(zlib.deflateSync(Buffer.from(xml, 'utf8')));
  for (let i = 0; i < body.length; i++) body[i] ^= XOR_KEY[i % XOR_KEY.length];
  return Buffer.concat([Buffer.from(magic, 'latin1'), body]).toString('base64');
}

test('魔数不符 ⇒ 明确报错（不再伪装成「解压失败」）', () => {
  const bad = buildKrc('[0,100]<0,100,0>x\n', { magic: 'XXXX' });
  assert.throws(() => decryptKrc(bad), /魔数不符/,
    '非 KRC 内容必须可与「KRC 损坏」区分开，否则排查只能靠猜');
});

test('内容过短（连魔数都不够）⇒ 明确报错，不越界读', () => {
  assert.throws(() => decryptKrc(Buffer.from('krc', 'utf8').toString('base64')), /过短/);
});

test('压缩炸弹 ⇒ 超出解压上限即拒绝（主进程不能被吃满内存）', () => {
  // 8 MiB 上限（MAX_INFLATE_BYTES）的 2.5 倍重复内容：deflate 后极小，解压后超大
  const bomb = buildKrc('啊'.repeat(20 * 1024 * 1024));
  assert.ok(bomb.length < 200 * 1024, '前提：压缩包本身很小（否则撑不住内存论证）');
  assert.throws(() => decryptKrc(bomb), /上限|超过/,
    '解压输出必须有上限，否则一段构造内容就能顶死 UI 进程');
});

test('行按时间戳升序，但词序保持源文件顺序（词序即显示顺序）', () => {
  const xml = [
    '[3000,500]<2000,500,0>第三<0,500,0>句',
    '[1000,500]<500,500,0>第二<0,500,0>句',
    // 这一行的词 offset 使绝对时间非递增（尾 2200 < 句 2800），正是「拖腔」
    '[2000,500]<800,500,0>句<0,200,0>中<200,300,0>尾',
    '',
  ].join('\n');
  const parsed = parseKrcXml(xml);
  assert.deepStrictEqual(parsed.lines.map(l => l.startMs), [1000, 2000, 3000]);

  // 词**不许**按绝对时间重排：KRC 里词的顺序就是逐字显示顺序，重排会把
  // 「句中尾」显示成「中尾句」，歌词读起来直接是错的。
  const multiWord = parsed.lines[1];
  assert.deepStrictEqual(multiWord.words.map(w => w.text), ['句', '中', '尾'],
    '词序必须与源文件一致，哪怕它们的绝对时间非递增');

  const lrc = krcToLrc(parsed).split('\n').map(l => l.slice(1, 7));
  for (let i = 1; i < lrc.length; i++) {
    assert.ok(lrc[i] >= lrc[i - 1], '输出的 LRC 行时间戳必须非递减');
  }
});

test('[language:...] 翻译块整块跳过（正文不得混进歌词）', () => {
  const xml = [
    '[ti:歌名]',
    '[0,500]<0,500,0>原词',
    '[language:5L2g5aW9]',
    '这是一行翻译正文，不带时间轴',
    '这是第二行翻译正文',
    '[1000,500]<0,500,0>原词二',
    '',
  ].join('\n');
  const parsed = parseKrcXml(xml);
  assert.strictEqual(parsed.meta.ti, '歌名');
  assert.strictEqual(parsed.lines.length, 2, '翻译块正文不该被当成歌词行');
  assert.deepStrictEqual(parsed.lines.map(l => l.startMs), [0, 1000]);
  assert.ok(!krcToLrc(parsed).includes('翻译正文'));
});

test('合法 KRC 仍然能解出内容（加固不许伤到正常路径）', () => {
  const xml = '[ti:晴天]\n[0,500]<0,250,0>故<250,250,0>园<500,500,0>晴\n[1000,500]<0,500,0>天\n';
  const out = decryptKrc(buildKrc(xml));
  assert.ok(out.includes('晴天'));
  const lrc = krcToLrc(parseKrcXml(out));
  assert.ok(lrc.includes('[00:00.000]故园晴'));
});
