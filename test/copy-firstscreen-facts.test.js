/**
 * 首屏/引导文案的事实收敛（用词线的下半场）
 *
 * 来龙去脉：167 收的是「音源/平台」的名词失配，本批收同一片文案上的**事实失配**——
 * 首屏正是旅程地图里 pain 4 的 Onboarding stage，用户读到的第一句谎话成本最高：
 * ① 搜索占位与欢迎卡都写死平台清单（「网易云/QQ/B站/酷狗」「三大平台」），
 *    而 v3 起源由 manifest 自动发现、README 明示 8 源——点名清单注定过期，
 *    且会把不知道支持粘贴的人劝退在「不在清单里的平台」上；
 * ② 欢迎卡断言「未登录只能下载标准音质」——与设置页自己声明的
 *    「N 个平台免登录直接下载」当面矛盾（多数平台根本不需要 Cookie）；
 * ③ zh 词典 search.welcome.hint 写「三大平台」而 en 词典已是 "multiple
 *    platforms"——中英两版各说各话，zh 是被落下的一份。
 *
 * 修法定律：**不点名的能力描述**代替清单（点名必腐化，清单的唯一真相源是 manifest）；
 * 跨页引用设置小节时用该小节的正式标题原文（「设置 → 平台账号」），
 * 并钉住与词典 sectionTitle 同源——标题再改，引导文案要么跟着红、要么搬家。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = (...p) => path.join(__dirname, '..', 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');
const dict = (lang) => JSON.parse(read('js', 'lang', `${lang}.json`));

test('welcome.js 不再断言「未登录只能下载标准音质」（与设置页当面矛盾）', () => {
  const src = read('js', 'views', 'welcome.js');
  assert.ok(!src.includes('未登录只能下载标准音质'));
  assert.ok(src.includes('免登录可直接下载的平台在「设置 → 平台账号」里标出'),
    '改口后的卡片必须指向设置页真实存在的小节');
  // 跨页引用的词头与词典小节标题同源：sectionTitle 改了这里就要跟着红
  assert.ok(dict('zh')['settings.accounts.sectionTitle'].startsWith('平台账号'),
    '「平台账号」小节标题已改名，欢迎卡的指路文案要同步搬家');
});

test('welcome.js 卡片①去掉点名的平台清单（清单唯一真相源是 manifest）', () => {
  const src = read('js', 'views', 'welcome.js');
  assert.ok(!src.includes('网易云 / QQ 音乐 / B 站'));
  assert.ok(src.includes('把各音乐平台的歌曲、歌单、专辑链接复制出来'));
});

test('search.welcome.hint：zh 去掉「三大平台」硬数字，与 en 的 multiple platforms 对齐', () => {
  const zh = dict('zh')['search.welcome.hint'];
  assert.ok(!/三大|三个/.test(zh), `zh 词典仍写死数量：${zh}`);
  assert.strictEqual(zh, '支持歌名、歌手、专辑，多平台同时检索');
  assert.match(dict('en')['search.welcome.hint'], /multiple platforms/i);
});

test('search.welcome.hint：index.html 行内默认值与 zh.json 逐字相等（一个文案一个家）', () => {
  const html = read('index.html');
  const m = html.match(/data-i18n="search\.welcome\.hint">([^<]*)</);
  assert.ok(m, 'index.html 里找不到 search.welcome.hint（结构变了要连测试一起搬家）');
  assert.strictEqual(m[1], dict('zh')['search.welcome.hint']);
});

test('两处搜索占位统一为「粘贴各平台…」，不再点名 4/8 个平台', () => {
  const html = read('index.html');
  assert.ok(!html.includes('网易云/QQ/B站/酷狗链接'), '占位仍点名平台');
  const ph = html.match(/placeholder="搜索歌曲、歌手、专辑[^"]*"/g) || [];
  assert.strictEqual(ph.length, 2, `搜索占位应有且仅有 2 处，实为 ${ph.length}`);
  for (const p of ph) {
    assert.ok(p.includes('粘贴各平台'), `占位未改口：${p}`);
  }
});

test('全站反向钉：renderer 可见文案里「三大平台」绝迹', () => {
  for (const p of ['index.html', 'js/lang/zh.json', 'js/views/welcome.js']) {
    assert.ok(!read(...p.split('/')).includes('三大平台'), `${p} 仍含「三大平台」`);
  }
});
