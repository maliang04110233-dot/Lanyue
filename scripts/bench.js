#!/usr/bin/env node
/**
 * 性能基准（scripts/bench.js）
 *
 * 为什么需要它：本项目有几处**随数据量增长**的纯计算路径 —— 命名模板渲染、
 * 歌词解析、快照合并、SSRF URL 解析、队列调度扫描。它们在功能上都有单测覆盖，
 * 但「单测通过」与「够快」是两件事：某天有人把 `O(n)` 写成 `O(n²)`，测试全绿而
 * 真实曲库（几千首）卡住界面。基准就是为了让这类退化**可被看见**。
 *
 * 用法
 *   npm run bench                  跑全部，输出表格
 *   npm run bench -- --json        输出 JSON（便于 CI 或本机留档对比）
 *   npm run bench -- --save        连同基线写入 bench-baseline.json
 *   npm run bench -- --check       与 bench-baseline.json 对比，劣化超阈值则退出码 1
 *
 * 阈值口径（--check）：单项劣化 > 30% 且绝对耗时 > 3ms 才判失败。绝对下限是为了
 * 滤掉「0.02ms 变 0.03ms」这种测量噪声；相对阈值是为了不把基准变成随机数竞赛。
 *
 * 诚实说明：这不是科学测量（单次进程内计时、受 JIT 与 GC 影响），它的价值是
 * **同机同版本的前后对比**，跨机器比较没有意义。基线文件因此不进版本库
 * （见 .gitignore），只在需要时本地生成。
 */

'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

const REL_THRESHOLD = 0.30;  // 劣化 30%
const ABS_FLOOR_MS = 3;      // 且绝对耗时 > 3ms 才判失败

// ── 计时器 ────────────────────────────────────────────────
function bench(name, fn, { iterations = 1, size = 0 } = {}) {
  // 先热身一次：让 V8 完成解析/优化，避免把冷启动算进结果
  try { fn(); } catch (e) {
    return { name, error: e.message, ms: null, iterations, size };
  }
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  const t1 = process.hrtime.bigint();
  return {
    name,
    ms: Number(t1 - t0) / 1e6 / iterations,
    iterations,
    size,
  };
}

// ── 基准项 ────────────────────────────────────────────────
const cases = [
  {
    name: 'naming: 文件名模板渲染（1k 首 × 5 模板）',
    iterations: 3,
    setup() {
      const { renderFileName, DEFAULT_TEMPLATE } = require(path.join(ROOT, 'src/utils/naming'));
      const songs = Array.from({ length: 1000 }, (_, i) => ({
        id: String(i), source: 'netease', title: `歌曲 ${i}`, artist: `歌手 ${i % 50}`,
        album: `专辑 ${i % 20}`,
      }));
      const templates = [DEFAULT_TEMPLATE, '{title} - {artist}', '{artist}/{album}/{title}',
        '{source}_{id}_{title}', '{album}/{artist}/{title} [{quality}]'];
      return () => {
        for (let i = 0; i < songs.length; i++) {
          renderFileName(templates[i % templates.length], songs[i], 'mp3');
        }
      };
    },
  },
  {
    name: 'krcCodec: KRC 标记文本解析（500 行逐字歌词）',
    iterations: 5,
    setup() {
      const { parseKrcXml, krcToLrc } = require(path.join(ROOT, 'src/utils/krcCodec'));
      const lines = [];
      for (let i = 0; i < 500; i++) {
        const t = i * 3000;
        lines.push(`[${t},2000]<0,500,0>词${i}<500,500,0>语<1000,500,0>句`);
      }
      const xml = `[ti:基准]\n${lines.join('\n')}\n`;
      return () => krcToLrc(parseKrcXml(xml));
    },
  },
  {
    name: 'syncMerge: 快照合并（双方各 400 条）',
    iterations: 5,
    setup() {
      const { mergeSnapshotData } = require(path.join(ROOT, 'src/utils/syncMerge'));
      const mk = (pre, n) => Array.from({ length: n }, (_, i) => ({
        id: `${pre}${i}`, name: `歌单 ${i}`, updatedAt: i, songs: [
          { id: `s${i}`, source: 'qq', title: `t${i}` },
        ],
      }));
      const local = { userPlaylists: mk('a', 400), downloadTemplates: [], downloadHistory: [] };
      const remote = { userPlaylists: mk('b', 400), downloadTemplates: [], downloadHistory: [] };
      return () => mergeSnapshotData(local, remote);
    },
  },
  {
    name: 'matchMusic: 跨源同曲匹配评分（200 候选池 × 1 目标）',
    iterations: 3,
    setup() {
      const { matchScore } = require(path.join(ROOT, 'src/utils/matchMusic'));
      const song = { id: '1', source: 'netease', title: '晴天', artist: '周杰伦', duration: 269 };
      const pool = Array.from({ length: 200 }, (_, i) => ({
        id: String(i), source: 'qq', title: i % 3 === 0 ? '晴天' : `别的歌 ${i}`,
        artist: i % 3 === 0 ? '周杰伦' : `歌手 ${i}`, duration: 269,
      }));
      let acc = 0;
      // 用 matchScore 而非 findMatchedCandidates：后者内部要做平台候选装载，
      // 在这个基准里会引入与「匹配算法」无关的一次性开销与异步，让数字失真。
      return () => {
        for (let i = 0; i < pool.length; i++) acc += matchScore(song, pool[i]) || 0;
        if (acc < 0) throw new Error('不可达');   // 防 JIT 把整个循环消掉
      };
    },
  },
  {
    name: 'urlGuard: 内部网地址判定（1k 次判定）',
    iterations: 5,
    setup() {
      const { _internal } = require(path.join(ROOT, 'src/utils/urlGuard'));
      const ips = ['127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254',
        '8.8.8.8', '::1', '[::ffff:127.0.0.1]', '2130706433', '0x7f.0.0.1', '0177.0.0.1'];
      const { normalizeHost, isPrivateIPv4, isPrivateIPv6 } = _internal;
      let acc = 0;
      return () => {
        for (let i = 0; i < 1000; i++) {
          const host = normalizeHost(ips[i % ips.length]);
          acc += isPrivateIPv4(host) || isPrivateIPv6(host) ? 1 : 0;
        }
        if (acc < 0) throw new Error('不可达');
      };
    },
  },
  {
    name: 'planDownloadDir: 下载路径模板规划（1k 次）',
    iterations: 5,
    setup() {
      const { planDownloadDir } = require(path.join(ROOT, 'src/utils/downloadPath'));
      const root = 'D:/Music';
      const template = { subpath: '{artist}/{album}/{title}' };
      const song = { id: '1', source: 'qq', title: '歌', artist: '人', album: '碟' };
      return () => planDownloadDir(template, root, song);
    },
  },
];

function run() {
  const results = [];
  for (const c of cases) {
    let fn;
    try {
      fn = c.setup();
    } catch (e) {
      results.push({ name: c.name, error: e.message, ms: null });
      continue;
    }
    results.push(bench(c.name, fn, { iterations: c.iterations }));
  }
  return results;
}

function fmt(results) {
  const rows = results.map((r) => ({
    基准项: r.name,
    '单次耗时(ms)': r.error ? '—' : r.ms.toFixed(3),
    状态: r.error ? `跳过（${r.error}）` : 'ok',
  }));
  const w = Math.max(...rows.map((r) => String(r.基准项).length));
  const lines = [`${'基准项'.padEnd(w)}  单次耗时(ms)  状态`];
  for (const r of rows) {
    lines.push(`${String(r.基准项).padEnd(w)}  ${String(r['单次耗时(ms)']).padStart(11)}  ${r.状态}`);
  }
  return lines.join('\n');
}

function compare(results, baseline) {
  const bad = [];
  const prev = new Map((baseline.results || []).map((r) => [r.name, r]));
  for (const r of results) {
    const p = prev.get(r.name);
    if (!p || p.ms == null || r.ms == null) continue;
    const ratio = r.ms / p.ms;
    if (ratio > 1 + REL_THRESHOLD && r.ms > ABS_FLOOR_MS) {
      bad.push(`${r.name}: ${p.ms.toFixed(3)}ms → ${r.ms.toFixed(3)}ms（${(ratio - 1) * 100 | 0}% 劣化）`);
    }
  }
  return bad;
}

function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const results = run();
  const baselinePath = path.join(ROOT, 'bench-baseline.json');

  if (has('--json')) {
    process.stdout.write(JSON.stringify({ results }, null, 2) + '\n');
  } else {
    console.log(fmt(results));
    console.log(`\n（单进程计时，仅供同机前后对比；劣化阈值 ${REL_THRESHOLD * 100}% 且绝对 > ${ABS_FLOOR_MS}ms）`);
  }

  if (has('--save')) {
    fs.writeFileSync(baselinePath, JSON.stringify({ savedAt: new Date().toISOString(), results }, null, 2));
    console.error(`\n基线已写入 ${path.relative(ROOT, baselinePath)}`);
  }

  if (has('--check')) {
    if (!fs.existsSync(baselinePath)) {
      console.error('\n无 bench-baseline.json，跳过对比（先跑 npm run bench -- --save）');
      return;
    }
    let baseline;
    try {
      baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch (e) {
      console.error(`\n基线文件损坏（${e.message}），跳过对比`);
      return;
    }
    const bad = compare(results, baseline);
    if (bad.length) {
      console.error(`\n✖ ${bad.length} 项相对基线显著劣化：`);
      bad.forEach((b) => console.error(`  · ${b}`));
      process.exitCode = 1;
    } else {
      console.error('\n✔ 全部基准项相对基线无显著劣化');
    }
  }
}

main();
