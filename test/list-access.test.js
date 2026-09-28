/**
 * 「取不到曲目」必须分档说话（浏览路径照 188 的口径收口）
 *
 * 188 把订阅检查的"空清单 ≠ 检查成功"立了法，但同一件事在浏览路径上仍然没人管：
 * 首页推荐页点开一个酷狗歌单 → gateway 发现平台没实现 getPlaylistSongs → 返回 []
 * → 弹层写死一句「暂无歌曲」。三件完全不同的事共用同一句话：
 *   D1 该平台**根本没这个能力**（8 个平台里只有 netease/qq 实现了 getPlaylistSongs）
 *      —— 用户以为是网络抽风，反复点，每次都白打一次请求（连请求都不该发）；
 *   D2 需要登录/VIP 的歌单被静默降级为 []（gateway 连 cookie 都不传，见
 *      test/gateway-cookie-scope.test.js）—— 用户永远不知道去「设置 › 账号」填 Cookie；
 *   D3 歌单真的是空的。
 * 「暂无歌曲」对 D1 是假话（平台不是暂无，是压根不支持），对 D2 是漏话（该说的话）。
 *
 * 能力位是**可推导的事实**（pluginRegistry 按方法存在性推导 _caps，经 get-platforms
 * 下发到渲染层），所以分档不需要新 IPC、不需要主进程改动任何返回形状。
 * 判据只有一处：listAccessHint()。调用它两次（取数前决定是否发请求、取空后决定
 * 怎么说）得到的是同一个对象 —— 同一事实只许一个家。
 *
 * 消费方审计（提交前跑 api.getPlaylistSongs/getAlbumSongs/getSingerSongs 的渲染层调用点）
 * 找到**三处**弹层共用同一个 #playlistModal：app.js 的歌单弹层、app.js 的专辑弹层，
 * 以及 search.js 粘贴专辑链接走的 openAlbumSongsModal —— 第三处写的是另一句假话
 * 「专辑暂无歌曲（链接可能已失效）」，把"平台不支持/需要登录"断言成"链接失效"。
 * 三处必须走同一层接线（listAccessFor），否则修了两处仍会漏一处。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// renderer 是 ESM（Vite），node --test 下只能动态 import（口径同 accountPlatforms.test.js）
const MODULE_URL = 'file:///' + path.join(__dirname, '..', 'src', 'renderer', 'js', 'listAccess.js')
  .split(path.sep).join('/');

let listAccessHint, term, EMPTY_UNSUPPORTED, EMPTY_UNAVAILABLE, EMPTY_UNKNOWN;
test.before(async () => {
  const mod = await import(MODULE_URL);
  ({ listAccessHint, term, EMPTY_UNSUPPORTED, EMPTY_UNAVAILABLE, EMPTY_UNKNOWN } = mod);
  for (const name of ['listAccessHint', 'term', 'EMPTY_UNSUPPORTED', 'EMPTY_UNAVAILABLE', 'EMPTY_UNKNOWN']) {
    assert.ok(name in mod, `listAccess.js 未导出 ${name}`);
  }
});

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

/** 去注释：反向钉不能把自己写的说明文字算成代码 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const PL_UNSUPPORTED = { id: 'kugou', capabilities: { search: true, cookie: true } };
const PL_CAPABLE = { id: 'netease', capabilities: { playlistSongs: true, cookie: true } };
const PL_CAPABLE_NOLOGIN = { id: 'fivesing', capabilities: { playlistSongs: true } };

test('平台清单未就绪 / 脏入参 ⇒ unknown，并且照常发起请求（没有证据就不拦用户的路）', () => {
  for (const bad of [undefined, null, {}, 'netease', { capabilities: null }, { capabilities: 'x' }]) {
    const r = listAccessHint(bad, { capability: 'playlistSongs', name: '酷狗音乐' });
    assert.equal(r.code, EMPTY_UNKNOWN, `脏 platform 判错档: ${JSON.stringify(bad)}`);
    assert.equal(r.fetch, true, '清单没就绪时不许拦请求，否则首屏极早期会永久取不到');
    assert.ok(!/暂不支持/.test(r.text), `不许把"不知道"说成"不支持": ${r.text}`);
  }
});

test('能力在、取回空 ⇒ unavailable：只能说"可能"，不许断言"就是空的"', () => {
  const r = listAccessHint(PL_CAPABLE, { capability: 'playlistSongs', subject: '歌单', name: '网易云音乐' });
  assert.equal(r.code, EMPTY_UNAVAILABLE);
  assert.equal(r.fetch, true);
  assert.match(r.text, /可能/);
  assert.ok(!/暂不支持/.test(r.text), '有能力的平台不许被判成不支持');
});

test('能力缺失 ⇒ unsupported：说清是平台不支持，并且这一枪根本不该发', () => {
  const r = listAccessHint(PL_UNSUPPORTED, { capability: 'playlistSongs', subject: '歌单', name: '酷狗音乐' });
  assert.equal(r.code, EMPTY_UNSUPPORTED);
  assert.equal(r.fetch, false, '确定取不到还发请求 = 让用户对着骨架屏转圈');
  assert.match(r.text, /暂不支持/);
  assert.match(r.text, /酷狗音乐/, '要点名是哪个平台');
  assert.match(r.text, /搜索页/, '要给出路，不能只说不行');
});

test('同一能力位换到专辑上不许串档：capability 参数决定判档，不是写死歌单', () => {
  const pl = { id: 'x', capabilities: { playlistSongs: true } };
  assert.equal(listAccessHint(pl, { capability: 'playlistSongs', name: 'X' }).code, EMPTY_UNAVAILABLE);
  assert.equal(listAccessHint(pl, { capability: 'albumSongs', name: 'X' }).code, EMPTY_UNSUPPORTED);
  const subj = listAccessHint(pl, { capability: 'playlistSongs', subject: '专辑', name: 'X' });
  assert.equal(subj.code, EMPTY_UNAVAILABLE);
});

test('只对"有 Cookie 能力"的平台提登录：没有登录入口的平台不配听到"去粘贴 Cookie"', () => {
  const withLogin = listAccessHint(PL_CAPABLE, { capability: 'playlistSongs', name: '网易云音乐' });
  const noLogin = listAccessHint(PL_CAPABLE_NOLOGIN, { capability: 'playlistSongs', name: '5sing' });
  assert.match(withLogin.text, /Cookie/, '有 cookie 能力却没取到 ⇒ 必须把可做的动作说出来');
  assert.match(withLogin.text, /账号/);
  assert.ok(!/Cookie/.test(noLogin.text), `对无登录能力的平台提 Cookie 是新的假话: ${noLogin.text}`);
});

test('三档文案两两不同：一句通用模板糊住三档 = 回到"暂无歌曲"', () => {
  const texts = [
    listAccessHint(undefined, { capability: 'playlistSongs', name: 'P' }).text,
    listAccessHint(PL_CAPABLE, { capability: 'playlistSongs', name: 'P' }).text,
    listAccessHint(PL_UNSUPPORTED, { capability: 'playlistSongs', name: 'P' }).text,
  ];
  assert.equal(new Set(texts).size, 3, JSON.stringify(texts));
});

test('接了 tr 就用词条，词条缺失/抛错则回落中文，且两条路都要插值（不许漏出 {name}）', () => {
  const zh = { 'modal.listUnsupported': '{name}无法展开{subject}' };
  const tr = key => (zh[key] || key);
  const ok = listAccessHint(PL_UNSUPPORTED, { capability: 'playlistSongs', subject: '歌单', name: '酷狗音乐', tr });
  assert.equal(ok.text, '酷狗音乐无法展开歌单');
  for (const broken of [
    () => { throw new Error('i18n 未初始化'); },
    () => '',          // 词条缺失返回空串
    k => k,            // 词条缺失返回 key 本身
  ]) {
    const fb = listAccessHint(PL_UNSUPPORTED, { capability: 'playlistSongs', subject: '歌单', name: '酷狗音乐', tr: broken });
    assert.match(fb.text, /暂不支持/);
    assert.match(fb.text, /酷狗音乐/);
    assert.ok(!/\{name\}/.test(fb.text), `回落串也必须插值: ${fb.text}`);
    assert.ok(!/modal\./.test(fb.text), `词条缺失时不许把键名漏到界面上: ${fb.text}`);
  }
});

test('term：单词条（如"歌单/专辑"）取不到就回落，绝不把键名当文案传下去', () => {
  const cases = [
    [() => 'Playlist', 'Playlist'],   // 正常取到英文
    [k => k, '歌单'],                  // i18n.t 找不到键时返回键本身 —— 必须判为缺失
    [() => '', '歌单'],
    [() => { throw new Error('i18n 未初始化'); }, '歌单'],
    [undefined, '歌单'],               // 没接 tr（纯函数直调 / 单测）
  ];
  for (const [tr, want] of cases) {
    assert.equal(term(tr, 'modal.subjectPlaylist', '歌单'), want, `tr=${String(tr)} 取词结果不对`);
  }
  // 单词条没有插值，插值规则由 say 复用它，两条路不能各写一份"什么算缺失"
  const echo = listAccessHint(PL_UNSUPPORTED, {
    capability: 'playlistSongs', subject: term(k => k, 'modal.subjectPlaylist', '歌单'),
    name: '酷狗音乐', tr: k => k,
  });
  assert.match(echo.text, /酷狗音乐暂不支持展开歌单/);
});

test('text 与 code 必须同档：判档与说法是一件事的两面，漂了就说明有两家', () => {
  const cases = [
    [undefined, EMPTY_UNKNOWN],
    [PL_CAPABLE, EMPTY_UNAVAILABLE],
    [PL_UNSUPPORTED, EMPTY_UNSUPPORTED],
  ];
  for (const [pl, code] of cases) {
    const r = listAccessHint(pl, { capability: 'playlistSongs', name: 'P' });
    assert.equal(r.code, code);
    const has = /暂不支持/.test(r.text);
    assert.equal(has, code === EMPTY_UNSUPPORTED, `文案与判档不一致: ${code} / ${r.text}`);
  }
});

test('接线：三处弹层都走这一家，且 unsupported 在发请求之前就返回', () => {
  const appSrc = stripComments(read('src/renderer/js/app.js'));
  assert.equal([...appSrc.matchAll(/listAccessHint\(/g)].length, 1,
    'app.js 里判档入口只许一处（弹层共用 listAccessFor 这一层接线，各调一次就是两家）');
  const modals = [
    ['src/renderer/js/app.js', 'openPlaylistModal', 'api.getPlaylistSongs'],
    ['src/renderer/js/app.js', 'openAlbumView', 'api.getAlbumSongs'],
    // 消费方审计找到的第三处：搜索页粘贴专辑链接 → 同一个 playlistModal，却自己写了一句假话
    ['src/renderer/js/views/search.js', 'openAlbumSongsModal', 'api.getAlbumSongs'],
  ];
  for (const [file, fn, call] of modals) {
    const src = file === 'src/renderer/js/app.js' ? appSrc : stripComments(read(file));
    const start = src.indexOf(`async function ${fn}(`);
    assert.ok(start >= 0, `未找到 ${fn}（${file}）`);
    const body = src.slice(start, src.indexOf('async function', start + 10) > start
      ? src.indexOf('async function', start + 10) : start + 4000);
    assert.match(body.slice(0, 1200), /listAccessFor\(/, `${fn} 没走统一的判档接线`);
    const gate = body.indexOf('if (!hint.fetch)');
    const fetch = body.indexOf(`await ${call}`);
    assert.ok(gate >= 0 && fetch >= 0, `${fn} 缺判档或缺取数（gate=${gate} fetch=${fetch}）`);
    assert.ok(gate < fetch, `${fn} 先发请求再判档：确定不支持的平台仍会白打一次`);
    assert.match(body.slice(gate, gate + 120), /return;/, `${fn} 的判档分支没有早退`);
    assert.match(body, /if \(!songs\.length\) \{[\s\S]{0,120}?hint\.text/,
      `${fn} 取回空数组后没有复用取数前那一次判档的文案（第二家必然漂）`);
    assert.ok(!/暂无歌曲/.test(body.slice(0, 3000)), `${fn} 仍在硬编码「暂无歌曲」`);
  }
  // search.js 靠窗口桥够到 app.js 那一层接线（与它调用 renderPlaylistModal 同一惯例）
  assert.match(appSrc, /window\.listAccessFor = listAccessFor/, 'listAccessFor 未挂到窗口桥，search.js 够不到');
});

test('接线：取词也走同一家（"什么算取不到词"不许出现第二份判据）', () => {
  const src = stripComments(read('src/renderer/js/app.js'));
  // 在 app.js 里自己写 "t(key) || fallback" 的话，键缺失就会把 'modal.subjectPlaylist' 印到界面上
  assert.match(src, /const subject = term\(/, '接线的 subject 没走 term()');
  assert.ok(!/t\(subjectKey\)\s*\|\|/.test(src), '不许绕过 term() 自己拿 || 兜底');
});

test('i18n：新词条中英齐备（扁平键，与语言包同构）', () => {
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  const keys = ['modal.listUnknown', 'modal.listUnavailable', 'modal.listNeedsLogin', 'modal.listUnsupported',
    'modal.subjectPlaylist', 'modal.subjectAlbum'];
  for (const k of keys) {
    assert.ok(typeof zh[k] === 'string' && zh[k], `zh 缺词条 ${k}`);
    assert.ok(typeof en[k] === 'string' && en[k], `en 缺词条 ${k}`);
    assert.notEqual(en[k], zh[k], `en 词条照抄中文: ${k}`);
  }
  assert.match(zh['modal.listUnsupported'], /\{name\}.*\{subject\}/, '词条必须带插值占位');
});

test('零新 IPC：判档是纯前端推导（能力位早已随 get-platforms 下发），不碰 api', () => {
  const src = stripComments(read('src/renderer/js/listAccess.js'));
  assert.ok(!/\bapi\./.test(src), '纯函数不该调 IPC');
  assert.ok(!/document\.|window\.(?!i18n)/.test(src), '纯函数不该碰 DOM');
  const search = stripComments(read('src/main/ipc/search.js'));
  const channels = [...search.matchAll(/handle\('([a-z0-9-]+)'/g)].map(m => m[1]);
  assert.ok(channels.includes('get-playlist-songs') && channels.includes('get-album-songs'));
  assert.equal(new Set(channels).size, channels.length);
});
