/**
 * 更新完整性 —— 双源哈希交叉比对
 *
 * 信任模型：
 *   electron-updater 从 GitHub API 拿 latest.yml → 里面每个 artifact 带 sha512。
 *   单独还需要 update-integrity.json（发布时 gen-update-integrity.cjs 生成，
 *   作为额外 Release 资产上传）。
 *
 *   两边 sha512 列表按文件名交叉比对：
 *     · 任一文件只有一边有 sha512 → 拒绝（列表不一致）
 *     · 同名文件 sha512 不同      → 拒绝（被篡改）
 *     · 全部一致                    → 通过
 *
 * 为什么两个来源：latest.yml 走 GitHub API 端点，update-integrity.json 走
 * Release 资产下载端点——两者的 TLS 连接是独立的（不同 HTTP 请求、不同缓存、
 * 有时甚至不同 CDN 节点）。攻击者要同时篡改两份，攻击面翻一倍。
 *
 * 为什么不直接硬编码 sha512：代码签名才是真正的信任根，
 * 但本项目目前无代码签名证书。双源比对是证书到位前的务实加固。
 */

const https = require('https');
const http = require('http');
const logger = require('../utils/logger');
const { assertPublicHttpUrl, makePinnedLookup } = require('../utils/urlGuard');

/** 从 HTTP URL 抓取 JSON，带 SSRF 防护与连接固定 */
function fetchJsonSecure(rawUrl, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let result;
    try {
      result = assertPublicHttpUrl(rawUrl);
    } catch (e) {
      return reject(new Error(`[integrity] SSRF 拦截: ${e.message}`));
    }
    if (!result.ok) return reject(new Error(`[integrity] URL 校验失败: ${result.reason}`));

    const { url, ips } = result;
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      timeout,
      // 固定到已校验的 IP（防 DNS rebinding）
      lookup: makePinnedLookup(ips),
      servername: url.hostname, // TLS SNI
      headers: { Accept: 'application/json' },
    }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`[integrity] HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (_e) {
          reject(new Error('[integrity] JSON 解析失败'));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 从 latest.yml 的 artifact 列表提取 sha512 映射
 * electron-updater 返回的 update-info 里每个 artifact 自带 sha512 字段
 * （这是 latest.yml 原生提供的，不是我们额外加的）
 */
function extractLatestHashes(updateInfo) {
  const map = new Map();
  const artifacts = updateInfo?.artifacts || [];
  for (const art of artifacts) {
    if (art.sha512 && art.file) {
      // electron-updater 的 file 字段通常含扩展名（如 'Lanyue-Setup-1.0.35.exe'）
      // 我们匹配时去掉路径前缀，只看文件名
      const name = art.file.split('/').pop().split('\\').pop();
      map.set(name, art.sha512);
    }
  }
  return map;
}

/** 从 update-integrity.json 提取 sha512 映射 */
function extractIntegrityHashes(integrityJson) {
  const map = new Map();
  const entries = integrityJson?.artifacts || [];
  for (const e of entries) {
    if (e.sha512 && e.file) {
      const name = e.file.split('/').pop().split('\\').pop();
      map.set(name, e.sha512);
    }
  }
  return map;
}

/**
 * 双源交叉比对
 * @returns {{ ok: boolean, reason?: string }}
 */
function compareHashes(latestMap, integrityMap) {
  // 取两边文件名的并集
  const allNames = new Set([...latestMap.keys(), ...integrityMap.keys()]);

  for (const name of allNames) {
    const inLatest = latestMap.get(name);
    const inIntegrity = integrityMap.get(name);

    if (!inLatest) {
      return { ok: false, reason: `update-integrity.json 有 ${name} 但 latest.yml 没有` };
    }
    if (!inIntegrity) {
      return { ok: false, reason: `latest.yml 有 ${name} 但 update-integrity.json 没有` };
    }
    if (inLatest !== inIntegrity) {
      return { ok: false, reason: `${name} sha512 不一致（latest.yml vs integrity.json）` };
    }
  }
  return { ok: true };
}

/**
 * 执行完整性校验
 *
 * @param {object} updateInfo  electron-updater checkForUpdates 返回的 info
 * @param {{ owner: string, repo: string, version: string }} ghMeta  GitHub 仓库元数据
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function verifyUpdateIntegrity(updateInfo, ghMeta) {
  const latestMap = extractLatestHashes(updateInfo);
  if (latestMap.size === 0) {
    logger.warn('[integrity] latest.yml 里没有 artifact sha512，跳过交叉校验');
    return { ok: true }; // 没法校验时降级放行（electron-updater 自身哈希校验仍生效）
  }

  // 版本号优先用 updateInfo.version，其次用 ghMeta
  const version = updateInfo?.version || ghMeta?.version;
  const integrityUrl = `https://github.com/${ghMeta.owner}/${ghMeta.repo}/releases/download/v${version}/update-integrity.json`;

  try {
    const integrityJson = await fetchJsonSecure(integrityUrl);
    const integrityMap = extractIntegrityHashes(integrityJson);

    // 如果 integrity.json 还没生成（首次发布、或脚本漏跑），降级放行
    if (integrityMap.size === 0) {
      logger.warn('[integrity] update-integrity.json 没有 artifact 条目，跳过交叉校验');
      return { ok: true };
    }

    const result = compareHashes(latestMap, integrityMap);
    if (!result.ok) {
      logger.error(`[integrity] 校验失败: ${result.reason}`);
    } else {
      logger.log(`[integrity] 双源哈希比对通过（${latestMap.size} 个资产）`);
    }
    return result;
  } catch (e) {
    logger.warn(`[integrity] 完整性校验不可用（${e.message}），降级放行`);
    // integrity.json 拉不到不是硬性失败（老版本没有这个文件），降级放行
    return { ok: true };
  }
}

module.exports = { verifyUpdateIntegrity };
