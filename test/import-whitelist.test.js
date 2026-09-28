/**
 * 导入白名单与 set-pref 白名单对齐
 *
 * 既有测试只钉了「可导入 ⊆ 可写入」这一个方向（防导入注入未知键），
 * 反方向没人管 —— 于是 cloudSync 自己那份手抄清单从 2022 年起 progressively
 * 落后于 ALLOWED_PREF_KEYS：备份文件里明明有 换源排除平台/不感兴趣屏蔽清单/
 * 歌词逐曲覆写/淡入淡出/倍速/队列完成后动作… 导入时被静默丢弃，
 * 用户换机恢复完发现"设置丢了一半"，而且一句话都不告诉他。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ALLOWED_PREF_KEYS } = require('../src/main/ipc/prefs');
const prefsUtils = require('../src/utils/prefs');
const cloudSync = require('../src/main/ipc/cloudSync');
const approvedDirs = require('../src/main/approvedDirs');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/** 曾经被静默丢弃的键：逐个点名，别只验一个泛化关系 */
const DRIFTED = [
  'fallbackDisabledPlatforms', 'perSourceConcurrency', 'maxAttempts',
  'autoLyric', 'autoCover', 'playerVolume', 'playbackRate', 'globalShortcuts',
  'fadeInMs', 'fadeOutMs', 'lyricsVisible', 'lyricOverrides', 'dismissedSongs',
  'clipboardWatch', 'afterQueueDone', 'scheduledDownloads', 'welcomeSeen',
];

test('ALLOWED 里的每个非凭证键都可导入（备份里有却 import 不进去 = 静默丢设置）', () => {
  // 39733bf 起凭证键（prefs.SECRET_KEYS）两侧都不走：跨机不可解的密文装进本地
  // 配置只会留下一个解不开的脏值。不变量因此是「ALLOWED 减去凭证键 ⊆ 可导入」
  const missing = [...ALLOWED_PREF_KEYS]
    .filter(k => !prefsUtils.SECRET_KEYS.has(k))
    .filter(k => !cloudSync.IMPORTABLE_PREF_KEYS.has(k));
  assert.deepEqual(missing, [], '这些键能写入却被导入丢弃: ' + missing.join(', '));
  for (const k of DRIFTED) assert.ok(cloudSync.IMPORTABLE_PREF_KEYS.has(k), `${k} 未进导入白名单`);
});

test('密文与本机同步配置永不进导入白名单（safeStorage 密文跨机不可解）', () => {
  for (const k of ['webdavUrl', 'webdavUser', 'webdavPass', 'webdavLastSyncAt', 'mcpToken']) {
    assert.ok(!ALLOWED_PREF_KEYS.has(k), `${k} 根本不该是 pref 白名单键`);
    assert.ok(!cloudSync.IMPORTABLE_PREF_KEYS.has(k), `${k} 被带进导入白名单了`);
  }
  // aiMusicApiKey 是 ALLOWED 里的凭证键：靠 NONPORTABLE 清单两侧同时排除
  for (const k of prefsUtils.SECRET_KEYS) {
    assert.ok(ALLOWED_PREF_KEYS.has(k), `${k} 若不在 ALLOWED 就不必特殊处理`);
    assert.ok(cloudSync.NONPORTABLE_PREF_KEYS.has(k), `${k} 未列入不可携清单`);
    assert.ok(!cloudSync.IMPORTABLE_PREF_KEYS.has(k), `${k} 仍可被导入安装`);
  }
});

test('pickImportablePrefs：未知键丢弃、正常键保留、脏入参不炸', () => {
  const { kept, droppedDirs } = cloudSync.pickImportablePrefs({
    theme: 'neon', saveDirBogus: 'C:\\Windows', maxAttempts: 5, n: null,
  });
  assert.equal(kept.theme, 'neon');
  assert.equal(kept.maxAttempts, 5);
  assert.ok(!('saveDirBogus' in kept), '未知键不能混进来');
  assert.equal(droppedDirs, 0);
  for (const bad of [null, undefined, 'x', 0, []]) {
    assert.deepEqual(cloudSync.pickImportablePrefs(bad).kept, {});
  }
});

test('目录键仍要过已批准目录守卫：导入不等于授予任意目录读写权', () => {
  const denied = cloudSync.pickImportablePrefs({ saveDir: path.join(os.tmpdir(), 'never-approved-' + Date.now()) });
  assert.equal(denied.kept.saveDir, undefined);
  assert.equal(denied.droppedDirs, 1, '被挡下的目录键要计数，好在导入报告里如实说');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-approve-'));
  approvedDirs.approve(dir);
  const passed = cloudSync.pickImportablePrefs({ saveDir: dir, theme: 'neon' });
  assert.equal(path.resolve(passed.kept.saveDir), path.resolve(dir));
  assert.equal(passed.droppedDirs, 0);
});

test('接线：清单只有一份（derive 自 ALLOWED），handler 走纯函数', () => {
  const src = read('src/main/ipc/cloudSync.js');
  assert.match(src, /const IMPORTABLE_PREF_KEYS = new Set\(\[\.\.\.ALLOWED_PREF_KEYS/, '仍在手抄第二份键清单');
  assert.doesNotMatch(src, /'saveDir', 'localDirPath', 'theme'/, '旧的字面量清单没删干净（两份必然漂移）');
  assert.match(src, /pickImportablePrefs\(data\.prefs\)/, '导入 handler 没用纯函数');
});
