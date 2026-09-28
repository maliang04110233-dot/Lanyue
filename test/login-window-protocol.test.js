/**
 * 登录窗口的导航/弹窗域判据（2026-09 审计 P1-12）
 *
 * 两个缺口，本文件各钉一条：
 *   1. hostAllowed 把 http: 和 https: 一起放行。登录窗口里握着**活的登录
 *      Cookie**（QQ uin / 网易云 MUSIC_U / B站 SESSDATA），明文一跳就够
 *      中间人把整页内容换成钓鱼页，窗口却照常显示"登录成功"。三个平台的
 *      登录入口本身全是 https，放行 http: 在真实用途里一次都用不上。
 *   2. 域白名单是 .qq.com / .163.com / .bilibili.com —— 整腾讯 / 整 163 /
 *      整个 B 站的兄弟域都算"登录域"。这条**故意保持原样**：真实登录流程
 *      本身就要跳出起始 host（QQ 走 ptlogin2/open.weixin/graph，QQ 与 B站
 *      登录后跳兄弟域），且这份清单同时是抓 Cookie 的清单；收窄会把真实
 *      登录流程改坏。所以本文件不假装收窄，只把"为什么宽"钉在源码注释里，
 *      并守住前缀碰撞不成立这条性质（后缀带前导点，别改成 startsWith）。
 *
 * 为什么是行为测试而不是扫源码：will-navigate / setWindowOpenHandler 的
 * 结构由 test/navigation-guard.test.js 负责；本文件直接打 hostAllowed 这个
 * 判据本身 —— 它是那两处守卫唯一的判断依据，判据错了守卫就形同虚设。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

// 纯 node 下 require('electron') 拿到的是二进制路径字符串，BrowserWindow
// 解构出 undefined；本文件不建窗口，只用判据。桩只是为了不依赖真实 electron。
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') return { BrowserWindow: class {} };
  return originalLoad(request, parent, isMain);
};
const { hostAllowed, LOGIN_CONFIGS } = require(path.join(__dirname, '../src/main/loginWindow'));
Module._load = originalLoad;

const allow = (url, platform = 'qq') => hostAllowed(new URL(url), LOGIN_CONFIGS[platform]);

test('http: 一律被拒（明文链路 + 窗口内持有活的登录 Cookie）', () => {
  // 同域的明文页同样要拒：判据看的是协议，不是"这个域在白名单里"
  for (const platform of Object.keys(LOGIN_CONFIGS)) {
    for (const host of ['y.qq.com', 'music.163.com', 'passport.bilibili.com']) {
      const url = `http://${host}/login`;
      assert.equal(allow(url, platform), false,
        `${platform}: ${url} 是明文导航，必须被拒（MITM 可在此投放钓鱼页）`);
    }
  }
  // 典型的中间人改写：把 https 降级成 http
  assert.equal(allow('http://ptlogin2.qq.com/'), false, 'QQ 账号密码登录页不许走明文');
  assert.equal(allow('http://open.weixin.qq.com/connect/qrconnect'), false, '微信扫码页不许走明文');
});

test('https: 放行（含各平台真实的登录入口与登录途中必须经过的域）', () => {
  // 起始页：三个平台的 loginUrl 本身必须通，否则登录窗口第一步就废
  for (const [platform, cfg] of Object.entries(LOGIN_CONFIGS)) {
    assert.equal(allow(cfg.loginUrl, platform), true,
      `${platform} 的 loginUrl (${cfg.loginUrl}) 竟被自己的白名单挡了`);
  }
  // 登录途中真实会跳到的域（收窄白名单会直接卡死的就是这些）
  const realFlow = [
    ['https://y.qq.com/', 'qq'],
    ['https://ptlogin2.qq.com/', 'qq'],
    ['https://open.weixin.qq.com/connect/qrconnect', 'qq'],
    ['https://graph.qq.com/oauth2.0/login', 'qq'],
    ['https://music.163.com/discover/user/login', 'netease'],
    ['https://passport.bilibili.com/login', 'bilibili'],
    ['https://www.bilibili.com/', 'bilibili'],
  ];
  for (const [url, platform] of realFlow) {
    assert.equal(allow(url, platform), true, `真实登录流程走到 ${url} 却被挡（登录会卡死）`);
  }
});

test('子域放行：白名单是域，不是 URL（路径/端口/查询串都不参与判定）', () => {
  assert.equal(allow('https://y.qq.com/n/ryqq/profile', 'qq'), true);
  assert.equal(allow('https://a.b.c.music.163.com/x', 'netease'), true, '多级子域也该放行');
  // 端口/查询串不影响判定（域判据就该只看 host）
  assert.equal(allow('https://passport.bilibili.com:443/login?next=1', 'bilibili'), true);
});

test('非白名单域被拒（含 userinfo 伪装与跨平台）', () => {
  for (const [url, platform] of [
    ['https://evil.example/', 'qq'],
    ['https://qq.com.attacker.net/', 'qq'],
    ['https://music.163.com.evil.net/', 'netease'],
    ['https://y.qq.com/', 'netease'],        // 跨平台：QQ 的域不等于网易云白名单
    ['https://passport.bilibili.com/', 'qq'],
  ]) {
    assert.equal(allow(url, platform), false, `${url} 不该被 ${platform} 的白名单放行`);
  }
});

test('前缀碰撞不成立：evilqq.com / qq.com.evil.net 都进不来（后缀带前导点）', () => {
  // 判据若被"优化"成 startsWith，这几条会全部放行 —— 这就是本用例的用处
  for (const host of ['evilqq.com', 'myqq.com', 'qq.com.evil.net', 'notmusic.163.com.evil.net',
    'evilbilibili.com', 'x.bilibili.com.evil.net']) {
    assert.equal(allow(`https://${host}/`, host.includes('163') ? 'netease' : (host.includes('bilibili') ? 'bilibili' : 'qq')), false,
      `${host} 靠前缀碰撞混进了白名单`);
  }
  // 顺带钉住"域"这个粒度：裸主域要放行（cookieDomains 里的 '.qq.com' 去点后）
  assert.equal(allow('https://qq.com/', 'qq'), true);
});

test('非 http(s) 协议一律被拒（file:/javascript:/data: 内网读取）', () => {
  for (const url of [
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'javascript:alert(document.cookie)',
    'data:text/html,<script>1</script>',
    'ftp://y.qq.com/x',
    'smb://y.qq.com/share',
  ]) {
    assert.equal(allow(url, 'qq'), false, `${url} 必须被拒`);
  }
});

test('judge 一处：will-navigate 与 setWindowOpenHandler 用的是同一个 hostAllowed', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '../src/main/loginWindow.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const calls = [...src.matchAll(/hostAllowed\(/g)].length;
  // 1 次定义 + 2 处调用（will-navigate / setWindowOpenHandler）
  assert.equal(calls, 3, `hostAllowed 调用点数变了（${calls}），确认没有第二套判据`);
});
