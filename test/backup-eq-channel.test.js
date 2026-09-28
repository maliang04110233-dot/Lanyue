/**
 * （起工记 184，落库前发现被并发整增量落库，让号为 185）：
 * 备份里的 EQ 键只有一个家 —— 通用 prefs 通道。
 *
 * 来龙：179（并发增量）记下候选「cloudSync 只搬 eqPreset/eqGains 两键，eqBypass
 * 不跟着同步」。本次 forensics 推翻了这个猜测：导出侧 `prefs: pickExportablePrefs(
 * prefs.getAll())` 早已把 prefs.json 全量带上，eq 三键都在 ipc/prefs.js 的
 * ALLOWED_PREF_KEYS 白名单里 ⇒ 三键一直都从通用通道走。真正住着的是病灶：
 * 导出块又手抄了顶层 eqPreset/eqGains 两枚"特别收集"——同一份数据在备份里有两个家，
 * 且手抄清单天然会漏第三枚（这正是 148/151 在本文件里杀过两次的那只手）。
 * 修法：导出侧摘掉手抄两枚（数据仍经 data.prefs 全量走）；导入侧顶层分支保留但
 * 降级为 legacy 读面（旧备份文件里那些顶层键必须还认）。
 *
 * 钉形：①反向钉按形状扫导出段（prefs.get('eq 一现即红，堵未来任何逐键手抄）；
 * ②derive 钉三键 ∈ 导入白名单（通道成立的资格）；③往返真跑纯函数（导出手 → 导入手，
 * eqBypass:true 必须活着到对端）；④legacy 读面钉（顶层与 eqSettings 两个兼容分支不许被顺手拆掉）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cloudSync = require('../src/main/ipc/cloudSync');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

/** 截出「导出所有数据」handler 的源码段（到导入 handler 之前为止） */
function exportSection() {
  const src = read('src/main/ipc/cloudSync.js');
  const from = src.indexOf("handle('export-all-data'");
  const to = src.indexOf("handle('import-all-data'");
  assert.ok(from >= 0 && to > from, 'cloudSync.js 的导出/导入两个 handler 锚点必须还在');
  return src.slice(from, to);
}

test('反向钉：导出段不得手抄任何 EQ 键 —— 备份里的 EQ 只许住 data.prefs 一个家', () => {
  const sec = exportSection();
  const offenders = sec.split('\n').filter((l) => /prefs\.get\(\s*['"`]eq/.test(l));
  assert.deepEqual(offenders, [],
    '导出侧又出现逐键手抄的 EQ 收集（148/151 杀过两次的那只手）:\n' + offenders.join('\n'));
});

test('derive 钉：eqPreset/eqGains/eqBypass 三键都在导入白名单里（通用通道的资格证）', () => {
  for (const k of ['eqPreset', 'eqGains', 'eqBypass']) {
    assert.ok(cloudSync.IMPORTABLE_PREF_KEYS.has(k), `${k} 必须可导入，否则 data.prefs 通道对它是断头路`);
    assert.ok(!cloudSync.NONPORTABLE_PREF_KEYS.has(k), `${k} 是可携偏好，不是凭证/本机配置，不许进剔除清单`);
  }
});

test('往返真跑：eqBypass:true 从导出手活到 import 手（纯函数级，无需 electron）', () => {
  const raw = {
    eqPreset: 'rock',
    eqGains: [3, 0, -3, 0, 2],
    eqBypass: true,
    aiMusicApiKey: 'enc:v1:bogus', // 顺带证明剔除与 EQ 互不误伤
  };
  const { kept } = cloudSync.pickExportablePrefs(raw);
  assert.ok(!('aiMusicApiKey' in kept), '凭证照旧剔除');
  const back = cloudSync.pickImportablePrefs(kept);
  assert.equal(back.kept.eqBypass, true, 'EQ 开关态必须跨机存活');
  assert.equal(back.kept.eqPreset, 'rock');
  assert.deepEqual(back.kept.eqGains, [3, 0, -3, 0, 2]);
});

test('legacy 读面钉：旧备份的顶层 eq 键与 eqSettings 对象两个兼容分支不许被顺手拆掉', () => {
  const src = read('src/main/ipc/cloudSync.js');
  assert.ok(/data\.eqPreset !== undefined/.test(src), '旧备份顶层 eqPreset 必须还认');
  assert.ok(/data\.eqSettings && typeof data\.eqSettings === 'object'/.test(src),
    '远古备份的 eqSettings 对象分支必须还认');
});
