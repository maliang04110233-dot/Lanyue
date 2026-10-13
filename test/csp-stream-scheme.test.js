/**
 * CSP 必须放行流式播放 scheme —— 钉住「整套流式架构被一行策略静默废掉」这个坑
 * （2026-10-13 现场实证）。
 *
 * 现场：所有网络歌都播不出来，只有一屏 toast 刷屏；主进程日志里**一条记录都没有**
 * （没有 [stream] 告警，也没有取流失败记录）。根因是 index.html 的 media-src
 * 没放行 `lanyue-stream:` —— 音频 src 走的是自定义 scheme，而特权注册处
 * 显式 `bypassCSP: false`，于是 Chromium 在发请求之前就拦下，
 * protocol.handle 一次都没被调用。
 *
 * 这类故障难查的原因正在于**它不留痕迹**：没有 4xx、没有日志、没有异常，
 * 只有一个 audio error 事件。所以必须有测试钉住，而不是靠下次记得。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

/** scheme 名只认一处事实来源：streamRegistry.js 自己导出的常量 */
const { STREAM_SCHEME } = require('../src/main/streamRegistry');

function cspOf(htmlFile) {
  const m = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(read('src', 'renderer', htmlFile));
  assert.ok(m, `${htmlFile} 必须声明 CSP；没有 CSP 等于没有这道防线`);
  return m[1];
}

function directive(csp, name) {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s+([^;]*)`).exec(csp);
  return m ? m[1].trim() : null;
}

// ── 主窗口：有 <audio>，且在线歌确实走自定义 scheme ──────

test('主窗口 media-src 必须放行流式播放 scheme（漏了 ⇒ 所有网络歌都播不出来）', () => {
  const csp = cspOf('index.html');
  const media = directive(csp, 'media-src');
  assert.ok(media, 'media-src 不能缺席：缺席时按 default-src 判定，自定义 scheme 一样被拦');
  assert.ok(
    media.split(/\s+/).includes(`${STREAM_SCHEME}:`),
    `media-src 必须含 "${STREAM_SCHEME}:"，实际是：${media}\n`
    + 'audio.src 走自定义 scheme，CSP 会在发请求前拦掉它，主进程零日志、无 4xx。',
  );
});

test('主窗口 CSP 不得对流式 scheme 开 bypassCSP（放行 ≠ 绕过，绕过会让 SSRF 防护失效）', () => {
  // scheme 特权注册在 src/main/index.js；这里只钉"不许出现绕过流式 scheme 的写法"
  const main = read('src', 'main', 'index.js');
  const privileged = /protocol\.registerSchemesAsPrivileged\(\[[\s\S]*?\]\)/.exec(main);
  assert.ok(privileged, '找不到 registerSchemesAsPrivileged 调用');
  assert.ok(
    !/bypassCSP:\s*true/.test(privileged[0]),
    '流式 scheme 开了 bypassCSP 就等于放弃 CSP 对它的约束，与 streamProtocol 的安全前提冲突',
  );
});

// ── 名单一致性：改 scheme 名不许只改一边 ─────────────────

test('流式 scheme 名只在 streamRegistry 一处定义（改名时这个测试会提醒同步 CSP）', () => {
  // index.html 是 HTML 字面量，改名必须手改；这里断言两边说的是同一个名字，
  // 避免出现"协议注册叫 A、CSP 放行 B"这种静默错配。
  const media = directive(cspOf('index.html'), 'media-src') || '';
  const entries = media.split(/\s+/);
  assert.ok(
    entries.includes(`${STREAM_SCHEME}:`),
    `CSP 未放行 ${STREAM_SCHEME}:（实际：${media}）—— scheme 名改了要同步这里`,
  );
});

// ── 另外两个窗口：没有 <audio>，不该被要求放行 ─────────────

test('迷你播放器/桌面歌词不含 audio 元素，不必为其放宽 CSP', () => {
  for (const f of ['mini-player.html', 'desktop-lyric.html']) {
    // 先剥注释再找标签：这两个文件的 CSP 注释里**恰好写着**「不含任何 <audio> 元素」，
    // 直接正则扫原文会命中那段说明文字（与 CSS 门禁里"注释中的 :hover 被计入"同一类坑）
    const html = read('src', 'renderer', f).replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(
      !/<(?:audio|video)[\s>]/i.test(html),
      `${f} 出现了媒体元素：它的 CSP 就必须同步放行 ${STREAM_SCHEME}:，请改这两处测试`,
    );
  }
});