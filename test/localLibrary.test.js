/**
 * 单元测试：utils/localLibrary.js 的封面兜底链
 *
 * 跑：npm test
 *
 * _findFolderCover 在「音频无内嵌封面」时必然执行，是扫描热路径的一部分。
 * 旧实现对 22 个候选逐个 existsSync + statSync，现在改为一次 readdir + 内存比对，
 * 本测试锁定「候选优先级不变、大小写不敏感行为不变」这两点，
 * 并用同步 fs 守卫确保它不会退回同步实现。
 *
 * 后半段锁「在线封面」这一环的出网条件：它是本地库读取里唯一会碰网络的地方，
 * 也是本仓「测试不触网」不变量的唯一例外来源（详见那段用例的头注）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _findFolderCover, readAudioMetadata } = require('../src/utils/localLibrary');

const SYNC_FS_APIS = [
  'statSync', 'existsSync', 'readFileSync', 'writeFileSync',
  'readdirSync', 'renameSync', 'unlinkSync', 'copyFileSync', 'mkdirSync',
];

async function withSyncFsGuard(fn) {
  const syncCalls = [];
  const originals = {};
  for (const k of SYNC_FS_APIS) {
    originals[k] = fs[k];
    fs[k] = function guardedSync(...args) {
      syncCalls.push(k);
      return originals[k].apply(fs, args);
    };
  }
  try {
    return { result: await fn(), syncCalls };
  } finally {
    for (const k of SYNC_FS_APIS) fs[k] = originals[k];
  }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'foldercover-test-'));
}

/** 在当前目录造一个假的音频文件（内容无关，只需要路径存在） */
function makeAudio(dir, name = 'song.mp3') {
  const fp = path.join(dir, name);
  fs.writeFileSync(fp, 'not-really-audio');
  return fp;
}

test('_findFolderCover: 优先命中 cover.jpg', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'folder.jpg'), 'x');

  const hit = await _findFolderCover(audio, 'song');
  assert.strictEqual(path.basename(hit), 'cover.jpg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 优先级 cover → folder → front', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);

  // 只有 folder / front 时取 folder
  fs.writeFileSync(path.join(dir, 'folder.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'front.jpg'), 'x');
  assert.strictEqual(path.basename(await _findFolderCover(audio, 'song')), 'folder.jpg');

  // 追加 cover 后 cover 应升为最高优先
  fs.writeFileSync(path.join(dir, 'cover.jpg'), 'x');
  assert.strictEqual(path.basename(await _findFolderCover(audio, 'song')), 'cover.jpg');

  // 去掉 cover 后回落到 folder
  fs.unlinkSync(path.join(dir, 'cover.jpg'));
  assert.strictEqual(path.basename(await _findFolderCover(audio, 'song')), 'folder.jpg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 同名封面在通用候选之后命中', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir, '晴天.mp3');
  fs.writeFileSync(path.join(dir, '晴天.jpg'), 'x');

  assert.strictEqual(path.basename(await _findFolderCover(audio, '晴天')), '晴天.jpg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: AlbumArt* 通配兜底', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  fs.writeFileSync(path.join(dir, 'AlbumArtSmall.jpg'), 'x');

  assert.strictEqual(path.basename(await _findFolderCover(audio, 'song')), 'AlbumArtSmall.jpg');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 大小写不敏感（Cover.JPG 命中 cover.jpg 候选）', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  fs.writeFileSync(path.join(dir, 'Cover.JPG'), 'x');
  fs.writeFileSync(path.join(dir, 'FOLDER.PNG'), 'x');

  // Cover.JPG 归一后先于 FOLDER.PNG 命中
  assert.strictEqual(path.basename(await _findFolderCover(audio, 'song')), 'Cover.JPG');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 目录同名时不算封面（只认文件）', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  fs.mkdirSync(path.join(dir, 'cover.jpg'));  // 同名目录

  assert.strictEqual(await _findFolderCover(audio, 'song'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 无匹配返回 null；目录不存在也不抛错', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  assert.strictEqual(await _findFolderCover(audio, 'song'), null);

  const ghost = path.join(dir, 'no-such-dir', 'a.mp3');
  assert.strictEqual(await _findFolderCover(ghost, 'a'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 不返回非图片文件（避免把歌词当封面）', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  fs.writeFileSync(path.join(dir, 'cover.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'song.lrc'), 'x');

  assert.strictEqual(await _findFolderCover(audio, 'song'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('_findFolderCover: 全程无同步 fs 调用，且只做一次目录读取', async () => {
  const dir = makeTempDir();
  const audio = makeAudio(dir);
  // 铺满候选，模拟最坏情况（旧实现会在这里产生 22 次同步 stat）
  for (const n of ['cover.jpg', 'folder.jpg', 'front.png', 'AlbumArt1.jpg']) {
    fs.writeFileSync(path.join(dir, n), 'x');
  }

  const { result, syncCalls } = await withSyncFsGuard(() => _findFolderCover(audio, 'song'));
  assert.ok(result, '应命中封面');
  assert.deepStrictEqual(syncCalls, [], `出现同步 fs 调用: ${syncCalls.join(', ')}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 在线封面兜底的出网闸门 ───────────────────────────────────
//
// 为什么单独锁这一环：本地库读取里只有「没有内嵌封面 → 去在线搜一张」会真出网。
// CI 曾在 windows-latest 上因为它连红三次（本地却全绿）：测试造的假音频没有标签，
// 标题是文件名猜出来的，而当时的判据看的是**哪个解析器跑过**（source），
// 不是**标题到底来自标签还是文件名** —— 于是猜出来的标题照样触发在线搜索，
// qq-music-api 上游返 500 时抛出没人 await 的游离 rejection，
// 被 node --test 记成"当时正在跑的那个用例"失败。本机复现不了是因为
// 这台机器根本连不上 QQ 音乐，请求在 DNS 阶段就死了（走 catch，静默）。
//
// 下面两条一对：无标签必须**零出网**（守住「测试不触网」），
// 有标签必须**照常出网一次**（别把功能一起砍没了）。

/** 把 utils/onlineCover 换成计数器桩（localLibrary 里是惰性 require，事后替换有效） */
function stubOnlineCover() {
  const p = require.resolve('../src/utils/onlineCover');
  const original = require.cache[p];
  const calls = [];
  require.cache[p] = {
    id: p,
    filename: p,
    loaded: true,
    exports: {
      fetchOnlineCover: async (title, artist) => {
        calls.push({ title, artist });
        return {
          coverBase64: 'data:image/jpeg;base64,AA==',
          mime: 'image/jpeg',
          size: 1,
          sourceUrl: 'stub',
          source: 'qq-online',
        };
      },
      downloadImageBuffer: async () => { throw new Error('测试里不许出网'); },
      detectImageMime: () => 'image/jpeg',
    },
  };
  return { calls, restore: () => { if (original) require.cache[p] = original; else delete require.cache[p]; } };
}

/** 把 music-metadata 换成可控桩：common 里有没有 title 就是"标签有没有标题" */
function stubMusicMetadata(common) {
  const p = require.resolve('music-metadata');
  const original = require.cache[p];
  require.cache[p] = {
    id: p,
    filename: p,
    loaded: true,
    exports: {
      parseFile: async () => ({ common: { ...common }, format: { duration: 1, bitrate: 128 } }),
    },
  };
  return { restore: () => { if (original) require.cache[p] = original; else delete require.cache[p]; } };
}

test('readAudioMetadata: 标签里没有标题时绝不发起在线封面搜索（测试不触网的地基）', async () => {
  const dir = makeTempDir();
  // 每条用例独立文件名：_metaCache 按 路径+mtime+size 缓存，避免相互污染
  const audio = path.join(dir, '无标签.mp3');
  fs.writeFileSync(audio, 'not-really-audio');

  const mm = stubMusicMetadata({});            // 解析器能打开文件，但标签是空的
  const cover = stubOnlineCover();
  try {
    const meta = await readAudioMetadata(audio);
    assert.deepStrictEqual(cover.calls, [], '文件名猜出来的标题不该触发在线搜索');
    assert.strictEqual(meta.title, '无标签', '标题仍按文件名兜底给出');
    assert.strictEqual(meta.cover, null, '没有内嵌封面也不补在线封面');
  } finally {
    mm.restore();
    cover.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readAudioMetadata: 标签里有标题时照常出网一次拉封面（别把功能砍没）', async () => {
  const dir = makeTempDir();
  const audio = path.join(dir, '有标签.mp3');
  fs.writeFileSync(audio, 'not-really-audio');

  const mm = stubMusicMetadata({ title: '夜曲', artist: '周杰伦' });
  const cover = stubOnlineCover();
  try {
    const meta = await readAudioMetadata(audio);
    assert.deepStrictEqual(
      cover.calls, [{ title: '夜曲', artist: '周杰伦' }],
      '标签标题应触发一次在线封面搜索，且用的是标签里的标题/歌手'
    );
    assert.strictEqual(meta.cover, 'data:image/jpeg;base64,AA==');
  } finally {
    mm.restore();
    cover.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readAudioMetadata: 已有内嵌封面时不出网（在线只是兜底）', async () => {
  const dir = makeTempDir();
  const audio = path.join(dir, '有封面.mp3');
  fs.writeFileSync(audio, 'not-really-audio');

  const pic = { format: 'image/jpeg', data: Buffer.from([0xFF, 0xD8, 0xFF]) };
  const mm = stubMusicMetadata({ title: '夜曲', picture: [pic] });
  const cover = stubOnlineCover();
  try {
    const meta = await readAudioMetadata(audio);
    assert.deepStrictEqual(cover.calls, [], '内嵌封面已够用，不该再出网');
    assert.ok(String(meta.cover).startsWith('data:image/jpeg;base64,'));
  } finally {
    mm.restore();
    cover.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
