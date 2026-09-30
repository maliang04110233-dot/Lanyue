/**
 * 测试：localEditModal —— ID3 编辑弹窗（单曲 + 批量）
 *
 * 模块通过 deps 注入拿到一切外部能力（getState/setState/getApi/showToast/
 * renderLocalSongs/exitSelection/getSelectedPaths），因此这里用一组假 deps
 * 就能在 node 里跑完整保存链路，不需要真的 Electron。
 *
 * 钉的行为（都是原来内联在 local.js 里、值得独立守住的不变量）：
 *   ① 封面只有 data:image/*;base64 白名单才插进 innerHTML（防外部输入进 src）；
 *   ② 单曲保存成功 → 写标签(必要时写封面) → 回填对象 → 重画 → 关窗 → toast；
 *   ③ 批量保存：全空字段直接拒（不空跑）；只写勾选集；逐首回填两个数组；
 *   ④ 批量保存完退回非选择态（否则工具条悬着）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const mod = () => import(`${pathToFileURL(path.join(REPO, 'src/renderer/js/localEditModal.js')).href}?t=${Math.random()}`);

/** 造一套编辑弹窗所需的假 DOM 元素。 */
function fakeDom() {
  const els = {};
  const mk = (id) => (els[id] = {
    id, value: '', textContent: '', innerHTML: '', style: {},
    _attrs: {}, setAttribute(k, v) { this._attrs[k] = v; },
    classList: { _c: new Set(), add(c) { this._c.add(c); }, remove(c) { this._c.delete(c); }, contains(c) { return this._c.has(c); } },
  });
  ['editTitle', 'editArtist', 'editAlbum', 'editYear', 'editGenre',
    'editCoverPreview', 'editTitleLabel', 'editBatchHint', 'editSaveBtn', 'editOverlay'].forEach(mk);
  return els;
}

async function harness(overrides) {
  const M = await mod();
  const els = fakeDom();
  const state = { editingSong: null, editingCoverBase64: null, localSongs: [], localFiltered: [] };
  const calls = { toast: [], rendered: 0, exited: 0, id3Tags: [], id3Cover: [] };
  globalThis.document = {
    getElementById: (id) => (id in els ? els[id] : null),
    addEventListener() {}, removeEventListener() {},
  };
  // 模块直接用 window 全局（getState/setState/api/showToast），与本仓渲染层一致
  const o = overrides || {};
  globalThis.getState = (k) => state[k];
  globalThis.setState = (k, v) => { state[k] = v; };
  globalThis.showToast = (m, t) => { calls.toast.push([m, t]); };
  globalThis.api = o.api || {
    updateId3Tags: async (fp, tags) => { calls.id3Tags.push([fp, tags]); return { success: true }; },
    updateId3Cover: async (fp, cov) => { calls.id3Cover.push([fp, cov]); return { success: true }; },
  };
  // 只注入视图内部三件
  M.setDeps({
    renderLocalSongs: () => { calls.rendered++; },
    exitSelection: () => { calls.exited++; },
    getSelectedPaths: o.getSelectedPaths || (() => []),
  });
  return { M, els, state, calls };
}

test('openEdit：填字段 + 封面走 data:image 白名单（非法 cover 当无封面）', async () => {
  const { M, els, state } = await harness();
  state.localFiltered = [{ filePath: '/m/a.mp3', title: 'T', artist: 'A', album: 'B', year: '2020', genre: 'G', cover: 'data:image/png;base64,AAAA' }];
  M.openEdit(0);
  assert.equal(els.editTitle.value, 'T');
  assert.equal(els.editArtist.value, 'A');
  assert.equal(els.editOverlay.classList.contains('hidden'), false, '弹窗应打开');
  assert.ok(els.editCoverPreview.innerHTML.includes('data:image/png;base64,AAAA'), '合法 data:image 封面应进预览');
  // 非法 cover（外部 URL）——当无封面，不插进 src
  state.localFiltered[0].cover = 'https://evil/x.png';
  M.openEdit(0);
  assert.ok(!els.editCoverPreview.innerHTML.includes('evil'), '非 data:image 的 cover 不得进 innerHTML');
  assert.ok(els.editCoverPreview.innerHTML.includes('🎵'), '应回落到占位');
});

test('saveEdit：成功 → 写标签(+封面) → 回填 → 重画 → 关窗 → toast', async () => {
  const { M, els, state, calls } = await harness();
  const song = { filePath: '/m/a.mp3', title: 'old', cover: null };
  state.editingSong = song;
  state.editingCoverBase64 = 'data:image/png;base64,BBBB';
  els.editTitle.value = ' 新名 '; els.editArtist.value = 'A';
  await M.saveEdit();
  assert.deepEqual(calls.id3Tags[0][0], '/m/a.mp3');
  assert.equal(calls.id3Tags[0][1].title, '新名', '标签应 trim');
  assert.deepEqual(calls.id3Cover, [['/m/a.mp3', 'data:image/png;base64,BBBB']], '封面变了才写封面');
  assert.equal(song.title, '新名', '应回填到对象');
  assert.equal(song.cover, 'data:image/png;base64,BBBB');
  assert.equal(calls.rendered, 1, '保存后重画列表');
  assert.ok(calls.toast.some(([m]) => /已保存/.test(m)), '成功 toast');
});

test('saveEdit：失败/异常 → 错误 toast，不崩', async () => {
  const { M, state, calls } = await harness({
    api: { updateId3Tags: async () => ({ success: false, error: 'E_FAIL' }) },
  });
  state.editingSong = { filePath: '/m/a.mp3', cover: null };
  await M.saveEdit();
  const failMsg = calls.toast.find(([m]) => /E_FAIL/.test(m));
  assert.ok(failMsg, '应 toast 失败原因');
  assert.equal(failMsg[1], 'error');
});

test('saveBatchEdit：全空字段直接拒，不空跑', async () => {
  const { M, els, calls } = await harness({ getSelectedPaths: () => ['/m/a.mp3'] });
  els.editTitle.value = ''; els.editArtist.value = '';
  await M.saveBatchEdit();
  assert.equal(calls.id3Tags.length, 0, '全空不应发任何写请求');
  assert.ok(calls.toast.some(([, t]) => t === 'warn' && /至少填写一个字段/.test(calls.toast.find(([m]) => /至少填写/.test(m))[0])));
});

test('saveBatchEdit：只写勾选集 + 逐首回填两个数组 + 完后退回非选择态', async () => {
  const { M, els, state, calls } = await harness({ getSelectedPaths: () => ['/m/a.mp3', '/m/b.mp3'] });
  const a = { filePath: '/m/a.mp3', title: 'oldA' };
  const b = { filePath: '/m/b.mp3', title: 'oldB' };
  state.localSongs = [a, b];
  state.localFiltered = [a, b];
  els.editAlbum.value = ' NewAlbum ';
  await M.saveBatchEdit();
  assert.equal(calls.id3Tags.length, 2, '每首选中歌写一次');
  assert.equal(calls.id3Tags[0][1].album, 'NewAlbum');
  assert.ok(!('title' in calls.id3Tags[0][1]), '未填字段不应写入');
  assert.equal(a.album, 'NewAlbum', 'localSongs 回填');
  assert.equal(state.localFiltered[0].album, 'NewAlbum', 'localFiltered 回填');
  assert.equal(calls.exited, 1, '批量保存完退回非选择态');
  assert.equal(calls.rendered, 1, '保存后重画');
  assert.ok(calls.toast.some(([m]) => /批量编辑完成/.test(m) && /2 成功/.test(m)));
});
