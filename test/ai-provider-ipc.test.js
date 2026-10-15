/**
 * 厂商配置 IPC：真 handler + 真 prefs（safeStorage 打桩）
 *
 * 纯函数那 21 枚（test/ai-provider-config.test.js）钉的是判据；这里钉的是**接线**：
 * 通道真的注册了、真的读写 prefs、真的把 Key 留在主进程。
 * 之所以值得单开一文件：「界面拿不到 Key」这件事只有在跨界那一侧才成立，
 * 而跨界这一侧最容易写的错就是忘了加密（prefs.set 对 SECRET_KEYS 返回 false）
 * 或顺手把 readKeyMap 的结果整个递给界面。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiprov-el-'));
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: { handle: () => {}, on: () => {} },
      app: { getPath: () => stubDir, getVersion: () => '1.0.0' },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from(s, 'utf8'),
        decryptString: (b) => b.toString('utf8'),
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const register = require('../src/main/ipc/register');
const prefs = require('../src/utils/prefs');
const ipcProvider = require('../src/main/ipc/ai-provider');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiprov-'));
  prefs.init(dir);
  return dir;
}

function call(ch, ...args) {
  const fn = register.getInvokeHandler(ch);
  assert.ok(fn, `通道未注册: ${ch}`);
  return fn(null, ...args);
}

test.before(() => {
  ipcProvider.register();
});

test('两条通道都登记在契约里（漏一条 = 启动时 assertContractCoverage 抛错）', () => {
  const { CHANNELS } = require('../src/shared/ipcContract');
  for (const ch of ['ai-provider-config', 'ai-provider-save']) {
    assert.ok(CHANNELS[ch] && CHANNELS[ch].invoke, `${ch} 未声明 invoke`);
  }
});

test('空盘读：回一份完整下拉数据，且没有任何 Key 形状的东西', async () => {
  tmp();
  const cfg = await call('ai-provider-config');
  assert.ok(cfg.providers.length >= 7);
  assert.equal(cfg.current.hasKey, false);
  assert.ok(!JSON.stringify(cfg).includes('sk-'));
});

test('存 Key 走真 prefs：落盘是密文，读侧解回后仍只递布尔', async () => {
  const dir = tmp();
  const r = await call('ai-provider-save', { providerId: 'kimi', key: { vendorId: 'kimi', value: 'sk-K-secret' } });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  // 盘上那一份才是证据：prefs.get 会透明解密，拿它断"存了明文"永远断不出来
  prefs.flush();
  const onDisk = fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8');
  assert.ok(!onDisk.includes('sk-K-secret'), '计费 Key 明文落盘（SECRET_KEYS 那条口径漏了）');
  assert.equal(prefs.get('aiMusicApiKey'), JSON.stringify({ kimi: 'sk-K-secret' }));
  const cfg = await call('ai-provider-config');
  assert.equal(cfg.current.hasKey, true);
  assert.ok(!JSON.stringify(cfg).includes('sk-K-secret'), 'Key 本体跨了进程界');
});

test('两家 Key 分别保存后互不覆盖（覆盖式写法会在这里红）', async () => {
  tmp();
  await call('ai-provider-save', { key: { vendorId: 'minimax', value: 'sk-M' } });
  await call('ai-provider-save', { providerId: 'deepseek', key: { vendorId: 'deepseek', value: 'sk-D' } });
  const map = JSON.parse(prefs.get('aiMusicApiKey'));
  assert.deepEqual(map, { minimax: 'sk-M', deepseek: 'sk-D' });
  // 当前选的是 deepseek，递给界面的 hasKey 必须是 deepseek 那根，不是整包
  const cfg = await call('ai-provider-config');
  assert.equal(cfg.current.providerId, 'deepseek');
  assert.equal(cfg.current.hasKey, true);
  assert.equal(cfg.supportsMusic, false);
});

test('坏端点经 IPC 也拒（形状钳制在契约，判据在登记表）', async () => {
  tmp();
  const r = await call('ai-provider-save', { baseUrl: 'http://ok.example.com' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'BAD_BASE_URL:HTTPS_ONLY');
  assert.equal(prefs.get('aiProviderBaseUrl'), undefined, '拒了却写进了 prefs');
});

test('超长型号被拒：patch 是对象，契约的字符串钳制管不到它的字段，判据得由登记表兜住', async () => {
  tmp();
  const r = await call('ai-provider-save', { model: 'glm-4' + 'x'.repeat(500) });
  assert.equal(r.ok, false);
  assert.match(r.error, /^BAD_MODEL:/);
});

test('空 patch 与 junk patch 都不写坏状态', async () => {
  tmp();
  await call('ai-provider-save', { providerId: 'glm' });
  const r = await call('ai-provider-save', { providerId: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'UNKNOWN_PROVIDER');
  assert.equal(prefs.get('aiProvider'), 'glm');
});
