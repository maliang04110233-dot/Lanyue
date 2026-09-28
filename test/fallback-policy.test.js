/**
 * 单元测试：api/services/fallbackPolicy.js + resolveTrackService 换源排除接线
 *
 * 语义边界（逐条钉死）：
 *   - 排除清单只砍**跨源路径**：候选过滤 + _altSource 记忆跳过；
 *   - 本源取流永不受限 —— 禁了 kuwo 不能导致 kuwo 自己的歌播不了；
 *   - prefs 垃圾值（对象/数字/数组混垃圾）必须安全降级为「无禁用」；
 *   - 每次 resolve 重读偏好：设置页勾选即刻生效，不依赖重启。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeDisabledPlatforms,
  filterDisabledCandidates,
  crossSourceEnabled,
} = require('../src/api/services/fallbackPolicy');
const { createResolveTrackService } = require('../src/api/services/resolveTrackService');

// ── 纯函数：normalize ────────────────────────────────────

test('normalizeDisabledPlatforms: 字符串数组 → 集合，去空白去重', () => {
  const s = normalizeDisabledPlatforms(['kuwo', ' kuwo ', 'ximalaya', '', '  ']);
  assert.deepEqual([...s].sort(), ['kuwo', 'ximalaya']);
});

test('normalizeDisabledPlatforms: 对象映射 {id:true} 兼容旧备份', () => {
  const s = normalizeDisabledPlatforms({ kuwo: true, qq: false, netease: 1 });
  assert.deepEqual([...s].sort(), ['kuwo', 'netease']);
});

test('normalizeDisabledPlatforms: 垃圾值一律空集（null/数字/数组混对象/嵌套）', () => {
  for (const raw of [null, undefined, 42, 'kuwo', { kuwo: 0 }, [{ id: 'kuwo' }], [{}]]) {
    assert.equal(normalizeDisabledPlatforms(raw).size, 0, `应降级为空集: ${JSON.stringify(raw)}`);
  }
});

test('filterDisabledCandidates: 剔除禁用源，保留畸形候选交给主循环裁判', () => {
  const disabled = new Set(['kuwo']);
  const cands = [{ id: '1', source: 'kuwo' }, { id: '2', source: 'qq' }, null, { id: '3' }];
  const out = filterDisabledCandidates(cands, disabled);
  assert.deepEqual(out, [{ id: '2', source: 'qq' }, null, { id: '3' }]);
});

test('filterDisabledCandidates: 空清单/非数组输入原样返回（零拷贝短路）', () => {
  const cands = [{ id: '1', source: 'kuwo' }];
  assert.equal(filterDisabledCandidates(cands, new Set()), cands);
  assert.equal(filterDisabledCandidates(cands, null), cands);
  assert.equal(filterDisabledCandidates('not-array', new Set(['x'])), 'not-array');
});

// ── 接线：resolveTrackService ────────────────────────────

const okResult = { url: 'https://cdn/x.mp3', ext: 'mp3' };
const vipFail = { error: '需要VIP', code: 'VIP_REQUIRED' };

function makeSvc({ map, candidates, disabled, extra = {} }) {
  const getUrlCalls = [];
  return {
    svc: createResolveTrackService({
      getUrl: async (id, source) => {
        getUrlCalls.push(source);
        const key = `${source}:${id}`;
        return map[key] || { error: `未知: ${key}`, code: 'UNKNOWN_SOURCE' };
      },
      searchFn: async () => [],
      hasCookie: () => false,
      findCandidates: async () => candidates,
      sourceHealth: { recordResult: () => {}, rankByHealth: (a) => a },
      ...(disabled === undefined ? {} : { getDisabledPlatforms: () => disabled }),
      ...extra,
    }),
    getUrlCalls,
  };
}

const SONG = { id: '1', source: 'netease', title: 'T', artist: 'A' };

test('排除清单命中候选源：该候选不发起取流，走下一个可用候选', async () => {
  const { svc, getUrlCalls } = makeSvc({
    map: { 'netease:1': vipFail, 'kuwo:9': okResult, 'qq:8': okResult },
    candidates: [{ id: '9', source: 'kuwo' }, { id: '8', source: 'qq' }],
    disabled: ['kuwo'],
  });
  const r = await svc.resolve(SONG);
  assert.equal(r.source, 'qq');
  assert.ok(!getUrlCalls.includes('kuwo'), 'kuwo 不应被请求');
});

test('本源不受排除清单限制：禁了 netease，netease 自己的歌照常出流', async () => {
  const { svc } = makeSvc({
    map: { 'netease:1': okResult },
    candidates: [],
    disabled: ['netease'],
  });
  const r = await svc.resolve(SONG);
  assert.equal(r.url, okResult.url);
});

test('_altSource 记忆指向被禁平台：跳过记忆，回正常流程', async () => {
  const { svc, getUrlCalls } = makeSvc({
    map: { 'netease:1': vipFail, 'kuwo:9': okResult },
    candidates: [{ id: '9', source: 'kuwo' }],
    disabled: ['kuwo'],
  });
  const song = { ...SONG, _altSource: { id: '9', source: 'kuwo' } };
  const r = await svc.resolve(song);
  assert.ok(!getUrlCalls.includes('kuwo'));
  assert.equal(r.error !== undefined, true, '唯一候选被禁 ⇒ 返回本源错误');
  assert.match(r.error, /VIP/);
});

test('未注入 getDisabledPlatforms：行为与旧版完全一致（可选依赖不破坏兼容）', async () => {
  const { svc, getUrlCalls } = makeSvc({
    map: { 'netease:1': vipFail, 'kuwo:9': okResult },
    candidates: [{ id: '9', source: 'kuwo' }],
    disabled: undefined,
  });
  const r = await svc.resolve(SONG);
  assert.equal(r.source, 'kuwo');
  assert.ok(getUrlCalls.includes('kuwo'));
});

test('getter 抛错按「无禁用」处理：偏好层故障不阻断取流', async () => {
  const svc = createResolveTrackService({
    getUrl: async (id, source) => (source === 'netease' ? vipFail : okResult),
    searchFn: async () => [],
    hasCookie: () => false,
    findCandidates: async () => [{ id: '9', source: 'kuwo' }],
    sourceHealth: { recordResult: () => {}, rankByHealth: (a) => a },
    getDisabledPlatforms: () => { throw new Error('prefs 读盘炸了'); },
  });
  const r = await svc.resolve(SONG);
  assert.equal(r.source, 'kuwo');
});

test('两次 resolve 之间改清单：第二次即刻生效（缓存不跨调用）', async () => {
  let current = [];
  const svc = createResolveTrackService({
    getUrl: async (id, source) => (source === 'netease' ? vipFail : okResult),
    searchFn: async () => [],
    hasCookie: () => false,
    findCandidates: async () => [{ id: '9', source: 'kuwo' }],
    sourceHealth: { recordResult: () => {}, rankByHealth: (a) => a },
    getDisabledPlatforms: () => current,
  });
  assert.equal((await svc.resolve(SONG)).source, 'kuwo');
  current = ['kuwo'];
  assert.notEqual((await svc.resolve(SONG)).url, okResult.url, '勾选后应不再出 kuwo 流');
});

// ── 跨源换源总开关（产品决策）──────────────────────
// 用户诉求：「根据搜索结果播放就是正常播放，没有音乐源就无法正常展示内容，也不用换音乐源」。
// 决策落在 fallbackPolicy 一处，机制保留在 resolveTrackService —— 想恢复换源改这里即可。

test('crossSourceEnabled：产品口径 = 关闭跨源换源', () => {
  assert.equal(crossSourceEnabled(), false,
    '默认不得跨源取流：别家平台的整曲不是这首歌');
});

test('生产接线：api/index.js 把总开关注入取流服务（漏注入等于决策失效）', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/api/index.js'), 'utf8');
  assert.match(src, /fallbackEnabled: crossSourceEnabled/,
    'resolveTrack 必须注入总开关，否则服务默认「开」，设置形同虚设');
});
