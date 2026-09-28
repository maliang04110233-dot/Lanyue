/**
 * 操作失败 toast 的错误人话层
 *
 * 来龙去脉：全渲染层 99 处 catch 里，用户可见的 toast 直接拼原始 e.message。
 * Node/Electron 的报错是英文栈文本——「导出失败: ENOENT: no such file or
 * directory, open 'C:\Users\...\x.json'」混进纯中文界面，新手读不懂，
 * 长堆栈还会把 toast 撑爆。下载/播放失败早有 diagnose.js 码表说「怎么办」，
 * 但那些只覆盖"取流任务"；保存/删除/导出/订阅这类操作错误一直没有家。
 *
 * 本测试锁三件事：
 * 1. errBrief 只有 errBrief.js 一个家，且是零依赖纯函数（同 skeleton 纪律）；
 * 2. 已知错误族必须翻成人话、且措辞与 diagnose.js 码表同族（同一概念同一词）；
 *    未知错误保留原文但压成单行、超长截断——人话层不许吞诊断线索；
 * 3. 全渲染层的用户可见拼接全部改走 errBrief（toast/行内文本/innerHTML 占位），
 *    并用目录级反向钉罩住新代码；logger.warn 里的原始 e.message 一个不许动
 *    （开发日志要留真话）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = (...p) => path.join(__dirname, '..', 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

// errBrief.js 是纯字符串函数（不碰 document、不碰 api），node 下可直接动态导入
const load = async () => import('../src/renderer/js/errBrief.js?tc=' + Math.random());

/** 造一个 Error，消息原样透传 */
const E = (msg) => new Error(msg);

// ── 纯函数：已知族翻译 ──────────────────────────────────

test('网络族英文栈文本统一翻成一句中文（含 net::ERR_ 与超时）', async () => {
  const { errBrief } = await load();
  for (const raw of [
    'fetch failed',
    'Failed to fetch',
    'request to https://x.invalid/ failed, reason: getaddrinfo ENOTFOUND x.invalid',
    'connect ECONNREFUSED 127.0.0.1:443',
    'read ECONNRESET',
    'timeout of 30000ms exceeded',
    'net::ERR_INTERNET_DISCONNECTED',
  ]) {
    assert.equal(errBrief(E(raw)), '网络异常，请检查网络/代理后重试', `未命中网络族: ${raw}`);
  }
});

test('文件族：能抽出路径就带上路径，抽不出就给通用说法', async () => {
  const { errBrief } = await load();
  assert.equal(
    errBrief(E("ENOENT: no such file or directory, open 'C:\\Music\\出歌.json'")),
    "文件读写失败：C:\\Music\\出歌.json",
  );
  assert.equal(errBrief(E('EACCES: permission denied')), '文件读写失败：路径不存在或无权限');
  assert.equal(errBrief(E('磁盘空间不足，写入失败')), '磁盘空间不足，请清理磁盘后重试');
});

test('鉴权族与取消与 JSON 解析族各有定译', async () => {
  const { errBrief } = await load();
  for (const raw of ['HTTP 401 Unauthorized', 'invalid api key', 'Forbidden']) {
    assert.equal(errBrief(E(raw)), '鉴权失败，请检查设置中的 API Key / Cookie', `未命中鉴权族: ${raw}`);
  }
  assert.equal(errBrief(E('signal is aborted without reason')), '操作已取消');
  assert.equal(errBrief(E('Unexpected token < in JSON at position 0')), '返回数据无法解析（平台接口可能变更），请稍后重试');
});

// ── 纯函数：未知族不吞线索 ──────────────────────────────

test('未知错误保留原文：多行压成单行，超 80 字符截断加省略号', async () => {
  const { errBrief } = await load();
  assert.equal(errBrief(E('第一行\n第二行   含  空格')), '第一行 第二行 含 空格');
  const long = 'X'.repeat(200);
  const out = errBrief(E(long));
  assert.equal(out.length, 81, '截断后应为 80 正文 + 1 省略号');
  assert.ok(out.endsWith('…'));
});

test('已经是人话的短中文原样透传（翻译层不许改写它本来就懂的话）', async () => {
  const { errBrief } = await load();
  assert.equal(errBrief(E('订阅源列表为空')), '订阅源列表为空');
});

test('入参宽容：字符串/null/undefined/无 message 对象都不炸', async () => {
  const { errBrief } = await load();
  assert.equal(errBrief('boom'), 'boom');
  assert.equal(errBrief(null), '未知错误');
  assert.equal(errBrief(undefined), '未知错误');
  assert.equal(errBrief({}), '未知错误');
  assert.equal(errBrief('   '), '未知错误');
});

test('errBrief.js 零依赖：不 import、不碰 api/window/document（纯函数纪律）', () => {
  const src = read('js', 'errBrief.js');
  assert.ok(!/^\s*import\s/m.test(src), '错误人话层不该引入任何依赖');
  assert.ok(!/\b(api|window|document)\b/.test(src), '禁止触碰宿主对象');
});

// ── 接线钉：全渲染层的用户可见拼接全部改走 errBrief ──────

const WIRED_VIEWS = ['playlist.js', 'history.js', 'subscriptions.js', 'ai-music.js',
  'download.js', 'settings.js', 'local.js', 'home.js', 'search.js',
  'local-stats.js', 'nameBatch.js', 'dragdrop.js'];
const WIRED_JS = ['abClip.js', 'app.js', 'artistGroups.js', 'converter-core.js', 'favorites.js',
  'folderGroups.js', 'historyTrend.js', 'lyricEditor.js', 'm3uToPlaylist.js', 'playRetry.js',
  'updater.js'];

test('全部接线视图各自 import errBrief（views 走 ../、js 走 ./）', () => {
  for (const f of WIRED_VIEWS) {
    assert.ok(read('js', 'views', f).includes("import { errBrief } from '../errBrief.js';"),
      `views/${f} 需从公共模块引入 errBrief`);
  }
  for (const f of WIRED_JS) {
    assert.ok(read('js', f).includes("import { errBrief } from './errBrief.js';"),
      `js/${f} 需从公共模块引入 errBrief`);
  }
});

test('四视图各自 import errBrief，且 showToast 拼接里不再出现裸 e.message', () => {
  const WIRED = WIRED_VIEWS.map(f => 'views/' + f).concat(WIRED_JS);
  for (const f of WIRED) {
    const src = read('js', ...f.split('/'));
    assert.ok(
      !/showToast\([^\n]*\+ *(\(e\.message \|\| e\)|e\.message)/.test(src),
      `${f} 仍有 toast 直拼原始 e.message`,
    );
  }
});

test('全局反向钉：任何用户可见弹层/横幅调用行不得直拼异常 .message（不限变量名，新代码同样受辖）', () => {
  // 170/171 的巡扫钉只认死变量名 `e.message`——dragdrop 的 e2、playlist 的 err、
  // updater 的模板串插值就这样从钉眼下漏过去。教训与 168「点名必腐化」同源：
  // 钉按形状扫，不按名字扫。
  // 白名单 info|result 是"数据对象自带人话字段"（更新服务器/导入结果的 message），
  // 不是异常栈文本；新增数据源撞钉时必须显式记账加名，而不是把钉改窄。
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;
      if (ent.name === 'errBrief.js') continue; // 人话层自身的 text = e.message 是定义处
      const src = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
      for (const line of src.split('\n')) {
        if (/logger\./.test(line)) continue; // 开发日志留真话，保护钉另有专测
        const sinks = /show[A-Z]\w*\(/.test(line) || /textContent\s*=\s*[^=\n]*\.message/.test(line);
        const raw = /(?:^|[^\w.])(?!info\.|result\.)[A-Za-z_$][\w$]*\.message\b/.test(line)
          && !/errBrief\(/.test(line);
        if (sinks && raw) offenders.push(path.relative(R(), p));
      }
    }
  };
  walk(R('js'));
  assert.deepEqual([...new Set(offenders)], [], '仍有弹层直拼原始 .message');
});

test('渲染进列表区的错误文案也走 errBrief（esc 包的是人话不是栈文本）', () => {
  const all = WIRED_VIEWS.map(f => read('js', 'views', f)).join('\n')
    + WIRED_JS.map(f => read('js', f)).join('\n');
  assert.ok(!/esc\(\(?\(e\.message \|\| e\)?\)?/.test(all), 'innerHTML 错误占位不得再裸插 e.message');
  assert.ok(!/textContent = '[^']*' \+ e\.message/.test(all), '行内错误文本不得再裸拼 e.message');
  assert.ok(read('js', 'views', 'playlist.js').includes('errBrief(e)'), 'playlist 接线证明');
  assert.ok(read('js', 'app.js').includes('errBrief(e)'), 'app 接线证明');
});

test('开发日志反向钉：logger.warn 里的原始 e.message 必须还在（防无差别替换）', () => {
  const hi = read('js', 'views', 'history.js');
  const pl = read('js', 'views', 'playlist.js');
  assert.ok(/logger\.warn\([^)]*e\.message/.test(hi), 'history 的 warn 日志要留原始消息');
  assert.ok(/logger\.warn\([^)]*e\.message/.test(pl), 'playlist 的 warn 日志要留原始消息');
});
