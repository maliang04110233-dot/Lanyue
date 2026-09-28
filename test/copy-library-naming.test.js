/**
 * 「曲库 / 音乐库」命名收口（设计走查 check-3 姊妹项回写真 app）
 *
 * 来龙去脉：167 收掉了「音源/平台」的双名，本钉收同族另一例——同一个东西
 * 在一屏内叫两个名字。现网实况（全部用户可见命中仅 4 处）：
 *   D1 命令面板条目 label 叫「曲库统计」，点开弹层自己的标题却叫「音乐库统计」
 *      ——同一视图在 0.5 秒内对用户换了名字；
 *   D2 统计/查重两处空态 toast 说「请先扫描本地音乐库」，而侧栏导航与统计卡
 *      label 都写「本地曲库」——指引你去找的东西，和提示里叫的不是一个名；
 *   D3 总览页统计卡 label 写「本地曲库」，紧贴的 tooltip 却是「本地音乐库」
 *      ——同一张卡两名并排，隔一个 title 属性。
 * 立法（沿用 168「同一个词只许有一个家」）：用户可见文案统一叫「曲库」——
 *   它已是压倒性用法（侧栏分组标题、导航项、统计卡 label、命令面板、m3u 导入
 *   提示等 60+ 处），「音乐库」只在上述 4 处漏网。注释/文件头是开发者散文，
 *   不在钉面内（反向钉按形状排除注释行）。
 *
 * 本测试锁三件事：① 反向钉——渲染层非注释行、index.html、zh 词典零「音乐库」；
 *   ② 正向钉——4 处改口后的原句在位（弹层标题、两条 toast、统计卡 tooltip）；
 *   ③ 同源钉——面板 label 与弹层标题含同一个词「曲库统计」。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const R = (...p) => path.join(ROOT, 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

// 注释行形状（与 171/173 巡扫钉同款排除式）：行首 // 、 /* 、 *
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

function libraryAliasOffenders() {
  const offenders = [];
  const check = (abs, src) => {
    src.split('\n').forEach((line, i) => {
      if (!line.includes('音乐库')) return;
      if (abs.endsWith('.js') && COMMENT_LINE.test(line)) return; // 开发者散文不钉
      offenders.push(`${path.relative(ROOT, abs)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  };
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(js|json|html)$/.test(ent.name)) continue;
      check(p, fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'));
    }
  };
  walk(R()); // src/renderer 全量：js 子树 + lang 词典 + index.html
  return offenders;
}

// ── ① 反向钉 ───────────────────────────────────────────────

test('用户可见文案零「音乐库」——它叫曲库（非注释行 + index.html + zh/en 词典全扫）', () => {
  assert.deepEqual(libraryAliasOffenders(), [],
    '仍有「音乐库」漏网（统一改「曲库」，见 167 音源/平台双名案）:\n' + libraryAliasOffenders().join('\n'));
});

// ── ② 正向钉：四处改口后的原句 ─────────────────────────────

test('统计弹层标题改口「📊 曲库统计」，与命令面板条目同一称呼', () => {
  const stats = read('js', 'views', 'local-stats.js');
  assert.ok(stats.includes('📊 曲库统计'), '弹层标题应写「📊 曲库统计」（对齐 commandPalette lc-stats label）');
});

test('统计/查重两处空态 toast 改口「请先扫描本地曲库」（与侧栏导航项同名）', () => {
  const stats = read('js', 'views', 'local-stats.js');
  const n = (stats.match(/请先扫描本地曲库/g) || []).length;
  assert.ok(n >= 2, `应有 ≥2 处「请先扫描本地曲库」toast，实际 ${n} 处`);
});

test('总览统计卡 tooltip 与卡内 label 同名：title 写「本地曲库」', () => {
  const html = read('index.html');
  assert.ok(!html.includes('title="本地音乐库"'), '同一张卡 label「本地曲库」而 tooltip「本地音乐库」——隔一个属性换名');
  assert.match(html, /stat-card[^>]*title="本地曲库"/);
});

// ── ③ 同源钉：面板 label 与弹层标题共词 ────────────────────

test('「曲库统计」一词在命令面板与弹层标题两处同源（改名必须同改）', () => {
  const palette = read('js', 'commandPalette.js');
  const stats = read('js', 'views', 'local-stats.js');
  assert.ok(palette.includes("label: '曲库统计'"), '命令面板 lc-stats 应叫「曲库统计」');
  assert.ok(stats.includes('曲库统计'), '弹层标题应与面板共词');
});
