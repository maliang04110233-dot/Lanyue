/**
 * 本地音乐库 IPC · 查重/检测域
 * 注册：find-content-duplicates / probe-audio
 */

const { handle } = require('../register');
const { scanDirectory } = require('../../../utils/localLibrary');
const { bucketBySize, slicePlan, groupByHash, dupGroupView, wastedBytes } = require('../../../utils/dupScan');
const logger = require('../../../utils/logger');
// 主进程即 UI 线程：所有 fs 操作必须异步，避免扫描/读写文件时窗口冻结
const fsa = require('../../../utils/fsAsync');
const { isValidPath, isInAllowedDir } = require('./sandbox');

function register() {
  // 内容级查重：字节哈希（大小分桶 → 头尾切片 hash → 同哈希成组）
  // 与渲染层按「标题+歌手」的元数据查重互补，抓改名/换目录的同内容副本
  handle('find-content-duplicates', async (_, dirPath) => {
    try {
      if (!isValidPath(dirPath)) return { error: '非法路径', groups: [] };
      if (!isInAllowedDir(dirPath)) return { error: '路径不可访问', groups: [] };
      if (!await fsa.exists(dirPath)) return { error: '目录不存在', groups: [] };

      const filePaths = await scanDirectory(dirPath);
      const sized = [];
      const BATCH = 50;
      for (let i = 0; i < filePaths.length; i += BATCH) {
        const chunk = filePaths.slice(i, i + BATCH);
        const stats = await Promise.all(chunk.map(fp => fsa.statOrNull(fp)));
        chunk.forEach((fp, j) => {
          const st = stats[j];
          if (st && typeof st.size === 'number' && st.size > 0 && (!st.isFile || st.isFile())) {
            sized.push({ filePath: fp, fileSize: st.size });
          }
        });
        await new Promise(r => setImmediate(r));
      }

      // 极端大库守护：候选文件哈希量封顶（分桶后仍是同大小者才进候选）
      const hashed = [];
      let budget = 5000;
      for (const bucket of bucketBySize(sized)) {
        for (const f of bucket) {
          if (budget-- <= 0) break;
          const hash = await _hashFileSlices(f.filePath, f.fileSize);
          if (!hash) continue;
          hashed.push({ ...f, hash });
        }
        await new Promise(r => setImmediate(r));
      }

      const dupGroups = groupByHash(hashed);
      return {
        groups: dupGroups.map(dupGroupView),
        wasted: wastedBytes(dupGroups),
        scanned: filePaths.length,
      };
    } catch (e) {
      logger.warn('[find-content-duplicates] 失败:', e.message);
      return { error: e.message, groups: [] };
    }
  });

  // 伪无损检测：ffprobe 实测真实编码/码率（与转码同款路径沙箱）
  handle('probe-audio', async (_, filePath) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { error: '路径不可访问' };
      const { probeAudioFile } = require('../../../utils/audioProbe');
      return await probeAudioFile(filePath);
    } catch (e) {
      logger.warn('[probe-audio] 检测失败:', e && e.message);
      return { error: e.message };
    }
  });
}

// ─── 内容查重：单文件头尾切片哈希（size 进哈希摘要防切片碰撞误判） ───
async function _hashFileSlices(filePath, size) {
  const crypto = require('crypto');
  let fh;
  try {
    fh = await fsa.fsp.open(filePath, 'r');
    const h = crypto.createHash('sha256');
    h.update(String(size));
    for (const r of slicePlan(size)) {
      const buf = Buffer.alloc(r.end - r.start);
      await fh.read(buf, 0, buf.length, r.start);
      h.update(buf);
    }
    return h.digest('hex');
  } catch {
    return null; // 占用中/无权限的文件跳过而不是让整次查重失败
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = register;
