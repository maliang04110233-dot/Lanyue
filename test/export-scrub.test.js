/**
 * 凭证键永不进备份（导出侧剔除清单 derive 自 SECRET_KEYS）
 *
 * 修的是"导入漏键"，这次是镜像方向：导出侧的剔除清单是手抄的 5 个键
 * （webdav* / mcpToken），而它注释写着"密文键不会进备份" —— 事实不成立：
 *   prefs.SECRET_KEYS 里的 aiMusicApiKey（AI 服务计费 key，落盘走 safeStorage）
 *   从来没进那份手抄清单，于是每次「导出所有数据」都把密钥密文写进一个
 *   用户可能随手网盘/微信发出去的 JSON 文件。
 *   148 之后更糟：导入白名单 derive 自 ALLOWED，所以别的机器导来的备份会把这个
 *   跨机不可解的密文当本地配置装上（解不开 ⇒ 表现为"未配置"，但盘上留着脏值）。
 * 修法同 148：不再手抄，两边都由 prefs.SECRET_KEYS 派生。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const prefsUtils = require('../src/utils/prefs');
const cloudSync = require('../src/main/ipc/cloudSync');

const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

/** 本机专属、不该跟着备份走的配置（WebDAV 连接参数 + MCP 令牌） */
const LOCAL_ONLY = ['webdavUrl', 'webdavUser', 'webdavPass', 'webdavLastSyncAt', 'mcpToken'];

test('prefs.SECRET_KEYS 导出为凭证键的唯一权威清单', () => {
  assert.ok(prefsUtils.SECRET_KEYS instanceof Set, 'SECRET_KEYS 没导出，导出/导入两侧只能继续手抄');
  assert.ok(prefsUtils.SECRET_KEYS.has('aiMusicApiKey'), 'AI 计费 key 必须在这份清单里');
});

test('凭证与本机配置键一律导不出去（含未来新增的凭证键）', () => {
  const raw = {
    theme: 'dark',
    playerVolume: 80,
    saveDir: 'D:/music',
    aiMusicApiKey: 'enc:v1:bogusBase64Ciphertext',
    webdavUrl: 'https://nas.example/dav',
    webdavUser: 'u',
    webdavPass: 'enc:v1:xxxx',
    webdavLastSyncAt: 123,
    mcpToken: 'enc:v1:yyyy',
  };
  const { kept, dropped } = cloudSync.pickExportablePrefs(raw);
  for (const k of [...prefsUtils.SECRET_KEYS, ...LOCAL_ONLY]) {
    assert.ok(!(k in kept), `${k} 泄漏进备份文件了`);
  }
  assert.equal(dropped, 6, '剔除计数要如实（导出报告用得上）：5 个本机配置 + 1 个凭证键');
  assert.deepEqual(kept, { theme: 'dark', playerVolume: 80, saveDir: 'D:/music' });
});

test('pickExportablePrefs 脏入参不炸也不误放行', () => {
  for (const bad of [null, undefined, 'x', 0, [], true]) {
    assert.deepEqual(cloudSync.pickExportablePrefs(bad), { kept: {}, dropped: 0 });
  }
});

test('清单 derive 而非手抄：任何 SECRET_KEYS 成员都进不了导出与导入', () => {
  // 这两条关系是本次的全部要点：新增凭证键时两侧自动跟上
  for (const k of prefsUtils.SECRET_KEYS) {
    const { kept } = cloudSync.pickExportablePrefs({ [k]: 'enc:v1:whatever', theme: 'x' });
    assert.ok(!(k in kept), `SECRET_KEYS 里的 ${k} 仍可导出`);
    assert.ok(!cloudSync.IMPORTABLE_PREF_KEYS.has(k), `SECRET_KEYS 里的 ${k} 仍可被导入安装（跨机不可解的脏值）`);
  }
  const cs = read('src/main/ipc/cloudSync.js');
  assert.ok(!/'aiMusicApiKey'/.test(cs), '又手抄了一遍键名 —— 清单必须来自 prefs.SECRET_KEYS');
  assert.ok(!/for \(const k of \[/.test(cs), '还留着手抄字面量的 delete 循环');
});

test('真 prefs 走一遍：设过的密钥不出现在导出结果里', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'musicdl-export-scrub-'));
  prefsUtils.init(dir);
  prefsUtils.set('theme', 'dark');
  prefsUtils.set('aiMusicApiKey', 'sk-test-123456');
  const { kept, dropped } = cloudSync.pickExportablePrefs(prefsUtils.getAll());
  assert.ok(!('aiMusicApiKey' in kept), '密文（或不可加密环境下的原文）都不能进备份');
  assert.equal(dropped, 1);
  assert.equal(kept.theme, 'dark');
  prefsUtils.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});
