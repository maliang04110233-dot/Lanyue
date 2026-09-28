/**
 * check-icons.cjs — 图标与安装器图片的静态守卫
 *
 * 为什么需要这个脚本：
 *   `assets/icon.png` 曾经是一张 1024×1024 的 **AI 生成图**，右下角烧录了
 *   「图片由AI生成」水印，会随安装包一起发给最终用户；这类缺陷**都能通过
 *   build 与全部测试**，没有任何自动检查会发现 —— 所以必须专门守住。
 *   同一个脚本还守住另一件事：图标是代码画出来的，一旦合成公式写反，
 *   前景会被数学上完全抹除，画出来只有一个空底板，且**不报任何错**
 *   （gen-icon.js 踩过这个坑）。所以这里必须验「图形真的画上去了」。
 *
 * 现行规范（5c58701 起）：**圆角方牌 + 白色底 + 深色音符**。
 *   旧规范是「圆形徽标 + 圆外透明」，当时的判据是四角必须透明；
 *   改成方牌后判据随之反转 —— 形状与配色都按新规范守，不保留旧口径。
 *
 * 本脚本只做静态检查，不启动 Electron、不依赖网络。
 *
 * 检查项：
 *   A. icon.png   —— 方形主体（不透明区几乎铺满画布）+ 四角内侧有着色
 *   A2.icon.png   —— 底色为白；且深色图形像素存在、明度跨度足够（不得白压白）
 *   B. icon.png   —— 尺寸与体积受控（避免又塞回 1MB 级大图）
 *   C. icon.ico   —— 结构合法（type=1）；含足够多的尺寸档位；含 16/32/48/256
 *   D. icon.ico   —— 各档位都是方形主体（缩放后不得退回圆盘/丢角）
 *   E. 安装器 BMP —— 24bpp、BI_RGB、尺寸符合 NSIS 规范
 *   F. 全仓无「AI 生成」水印文案混入图片元数据（PNG tEXt 等文本块）
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const BUILD = path.join(ROOT, 'build');

const failures = [];
const passes = [];

function ok(msg) {
  passes.push(msg);
}

function fail(msg) {
  failures.push(msg);
}

// ─────────────────────────────────────────────────────────────
// PNG 解码（只支持 8-bit RGBA / RGB，够用且不引依赖）
// ─────────────────────────────────────────────────────────────

function parsePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');

  let off = 8;
  let ihdr = null;
  const idat = [];
  const textChunks = [];

  while (off < buf.length - 8) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString('ascii');
    const data = buf.slice(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      // ⚠️ 必须按 UTF-8 解码，**不能用 latin1**。
      // 用 latin1 读中文会得到乱码（「图片由AI生成」→「å¾çç±AIçæ」），
      // 于是下面的水印正则永远匹配不上 —— 守卫静默失效，且不报任何错。
      // （本文件初版正犯此错，靠变异测试才发现。）
      textChunks.push(data.toString('utf8'));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (!ihdr) throw new Error('缺 IHDR');
  if (ihdr.bitDepth !== 8) throw new Error('仅支持 8-bit，实际 ' + ihdr.bitDepth);
  if (ihdr.interlace !== 0) throw new Error('不支持隔行 PNG');

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error('不支持的颜色类型 ' + ihdr.colorType);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);

  // 逐行反滤波（PNG 的 5 种 filter）
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.from(line);

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0: break;
        case 1: cur[x] = (cur[x] + a) & 0xff; break;
        case 2: cur[x] = (cur[x] + b) & 0xff; break;
        case 3: cur[x] = (cur[x] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[x] = (cur[x] + pred) & 0xff;
          break;
        }
        default: throw new Error('未知 filter ' + filter);
      }
    }
    cur.copy(out, y * stride);
    prev = cur;
  }

  return { ...ihdr, channels, data: out, textChunks };
}

/** 取某像素的 alpha（RGB 图视为全不透明） */
function alphaAt(img, x, y) {
  if (img.channels === 4) return img.data[(y * img.width + x) * 4 + 3];
  if (img.channels === 2) return img.data[(y * img.width + x) * 2 + 1];
  return 255;
}

/** 取某像素的 Rec.601 亮度（透明处视为 0，让「什么都没有」判得出来） */
function lumaAt(img, x, y) {
  if (alphaAt(img, x, y) <= 128) return 0;
  const o = (y * img.width + x) * img.channels;
  return 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
}

/**
 * 不透明像素占比。方牌 ≈0.98，圆底徽标 ≈0.66（π·0.46²），
 * 两者差一个量级，用一条阈值就能分辨形状，不必去拟合轮廓。
 */
function opaqueRatio(img) {
  let solid = 0;
  const step = img.channels;
  for (let i = step - 1; i < img.data.length; i += step) {
    if (img.data[i] > 128) solid++;
  }
  return solid / (img.width * img.height);
}

/**
 * 「方形主体」的最低不透明占比 —— 随尺寸放宽，不能卡一个死数。
 *
 * 铺满画布的方牌，最外一圈像素只有约半个像素的覆盖度（边缘抗锯齿），
 * 一圈掉的面积是 4/size 量级：512 档实测 98.4%，16 档只剩 77%。
 * 卡固定 90% 会让小档位因为「画得对」而报错。
 * 对照：圆底徽标实测 16→55%、24→58%、32→60%、256→66%、512→66%，
 * 全部落在这条线以下，判别力没有因为放宽而丢失。
 */
function squareFloor(size) {
  return 0.9 - 3 / size;
}

/**
 * 图形（前景）统计：白底上必须有足量深色像素，且深色与最亮处拉开差距。
 * 这是「前景被抹除」的唯一自动侦测手段 —— 那种情况下画布只剩一块白底板，
 * 尺寸/体积/结构类检查全都发现不了。
 */
function glyphStats(img) {
  const step = img.channels;
  let dark = 0;
  let darkest = 255;
  let lightest = 0;
  for (let i = 0; i < img.data.length; i += step) {
    if (img.data[i + step - 1] <= 128) continue;
    const l = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    if (l < darkest) darkest = l;
    if (l > lightest) lightest = l;
    if (l < 140) dark++;
  }
  return { darkRatio: dark / (img.width * img.height), darkest, lightest };
}

// ─────────────────────────────────────────────────────────────
// A/B. icon.png
// ─────────────────────────────────────────────────────────────

function checkIconPng() {
  const p = path.join(ASSETS, 'icon.png');
  if (!fs.existsSync(p)) {
    fail('assets/icon.png 不存在');
    return;
  }

  const buf = fs.readFileSync(p);
  const img = parsePNG(buf);

  // 尺寸受控：太大的 PNG 会白占安装包体积（历史上是 1024×1024 / 1.1MB）
  if (img.width > 1024 || img.height > 1024) {
    fail(`icon.png 尺寸 ${img.width}x${img.height} 过大（应 ≤1024）`);
  } else {
    ok(`icon.png 尺寸 ${img.width}x${img.height} 在合理范围`);
  }

  // 体积预算：程序化生成的图标应在几十 KB 量级；
  // 若哪天又换成照片级大图，这条会拦住。
  const sizeKB = buf.length / 1024;
  if (sizeKB > 300) {
    fail(`icon.png 体积 ${sizeKB.toFixed(0)} KB 超出 300 KB 预算（疑似又换回大图）`);
  } else {
    ok(`icon.png 体积 ${sizeKB.toFixed(0)} KB 在预算内`);
  }

  // ── A. 方形主体 ────────────────────────────────────────
  // 规范：圆角方牌铺满画布。旧的圆底徽标只有约 66% 不透明，会被这条拦下。
  const pct = (r) => `${(r * 100).toFixed(1)}%`;
  const ratio = opaqueRatio(img);
  const floor = squareFloor(img.width);
  if (ratio < floor) {
    fail(`icon.png 不透明区域仅 ${pct(ratio)}（应 ≥${pct(floor)}）—— 主体不是方形（圆底徽标？圆角半径过大？）`);
  } else {
    ok(`icon.png 不透明区域 ${pct(ratio)} ≥ ${pct(floor)} —— 方形主体`);
  }

  // 四角内侧必须有着色：方牌的四个角是内容区，透明说明被切掉了。
  // 探针从边缘内缩 14%，落在圆角半径之内（贴着边探就成在验圆角本身）。
  const inset = Math.max(2, Math.round(img.width * 0.14));
  const corners = [
    ['左上', inset, inset],
    ['右上', img.width - 1 - inset, inset],
    ['左下', inset, img.height - 1 - inset],
    ['右下', img.width - 1 - inset, img.height - 1 - inset],
  ];
  const holes = corners.filter(([, x, y]) => alphaAt(img, x, y) < 200).map(([n]) => n);
  if (holes.length) {
    fail(`icon.png 四角内侧无内容（方牌缺角 / 其实是圆形）：${holes.join('、')}`);
  } else {
    ok('icon.png 四角内侧有着色（方牌完整）');
  }

  // ── A2. 白底 + 深色图形 ────────────────────────────────
  const cornerLuma = Math.min(...corners.map(([, x, y]) => lumaAt(img, x, y)));
  if (cornerLuma < 200) {
    fail(`icon.png 四角底色亮度仅 ${cornerLuma.toFixed(0)} —— 规范是白色底`);
  } else {
    ok(`icon.png 白底（四角亮度 ${cornerLuma.toFixed(0)}）`);
  }

  const { darkRatio, darkest, lightest } = glyphStats(img);
  if (darkRatio < 0.02) {
    fail(`icon.png 深色图形像素仅 ${pct(darkRatio)} —— 白底上没有前景（音符被合成抹除？）`);
  } else {
    ok(`icon.png 深色图形像素 ${pct(darkRatio)}`);
  }
  const spread = lightest - darkest;
  if (spread < 90) {
    fail(`icon.png 明度跨度仅 ${spread.toFixed(0)}（应 ≥90）—— 白压白，浅色任务栏上看不出内容`);
  } else {
    ok(`icon.png 明度跨度 ${spread.toFixed(0)}（前景与底板可分）`);
  }

  // 中心必须不透明，否则图标是空的
  if (alphaAt(img, Math.floor(img.width / 2), Math.floor(img.height / 2)) < 200) {
    fail('icon.png 中心透明 —— 图标内容为空');
  } else {
    ok('icon.png 中心有不透明内容');
  }

  // 应存在足量半透明像素（抗锯齿边缘）；若完全没有，说明边缘是硬切，会有锯齿
  let semi = 0;
  for (let i = 3; i < img.data.length; i += img.channels) {
    const a = img.data[i];
    if (a > 8 && a < 247) semi++;
  }
  if (semi < 100) {
    fail(`icon.png 半透明像素仅 ${semi} 个 —— 方牌圆角缺抗锯齿，会有明显锯齿`);
  } else {
    ok(`icon.png 有 ${semi} 个半透明像素（圆角抗锯齿正常）`);
  }

  // 元数据不得夹带「AI 生成」类水印文案
  const blob = img.textChunks.join(' ');
  if (/AI\s*生成|AI-generated|图片由/i.test(blob)) {
    fail('icon.png 元数据含「AI 生成」水印文案');
  } else {
    ok('icon.png 元数据无水印文案');
  }
}

// ─────────────────────────────────────────────────────────────
// C/D. icon.ico
// ─────────────────────────────────────────────────────────────

function checkIconIco() {
  const p = path.join(ASSETS, 'icon.ico');
  if (!fs.existsSync(p)) {
    fail('assets/icon.ico 不存在');
    return;
  }

  const buf = fs.readFileSync(p);
  if (buf.readUInt16LE(0) !== 0) fail('icon.ico 保留字段非 0');
  if (buf.readUInt16LE(2) !== 1) fail(`icon.ico type=${buf.readUInt16LE(2)}（应为 1）`);

  const count = buf.readUInt16LE(4);
  if (count < 4) {
    fail(`icon.ico 仅含 ${count} 个尺寸（过少，系统缩放会糊）`);
    return;
  }

  const sizes = [];
  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const size = buf[off] || 256;
    const bytes = buf.readUInt32LE(off + 8);
    const dataOff = buf.readUInt32LE(off + 12);
    sizes.push(size);
    entries.push({ size, dataOff, bytes });
  }

  // 关键档位必须齐备：16/32 用于任务栏与资源管理器，48 用于桌面，256 用于大图标
  const required = [16, 32, 48, 256];
  const missing = required.filter(s => !sizes.includes(s));
  if (missing.length) {
    fail(`icon.ico 缺少关键尺寸 ${missing.join('/')}`);
  } else {
    ok(`icon.ico 关键尺寸齐备（16/32/48/256），共 ${count} 档：${sizes.join('/')}`);
  }

  // 每一档都必须是方形主体：缩放到 16/32 时若退回圆盘或丢了四角，
  // 任务栏与资源管理器小视图会立刻显示成圆徽标。
  const notSquare = [];
  for (const e of entries) {
    let img;
    try {
      img = parsePNG(buf.slice(e.dataOff, e.dataOff + e.bytes));
    } catch (err) {
      fail(`icon.ico 的 ${e.size}x${e.size} 档解析失败：${err.message}`);
      continue;
    }
    if (opaqueRatio(img) < squareFloor(e.size)) notSquare.push(`${e.size}(${(opaqueRatio(img) * 100).toFixed(0)}%)`);
  }
  if (notSquare.length) {
    fail(`icon.ico 以下档位不是方形主体：${notSquare.join(' ')}`);
  } else {
    ok('icon.ico 全部档位为方形主体（不透明区达到该尺寸的方形下限）');
  }
}

// ─────────────────────────────────────────────────────────────
// E. 安装器 BMP
// ─────────────────────────────────────────────────────────────

function checkInstallerBmp() {
  const specs = [
    { file: 'installerHeader.bmp', w: 150, h: 57 },
    { file: 'installerSidebar.bmp', w: 164, h: 314 },
  ];

  for (const spec of specs) {
    const p = path.join(BUILD, spec.file);
    if (!fs.existsSync(p)) {
      fail(`build/${spec.file} 不存在`);
      continue;
    }
    const b = fs.readFileSync(p);

    if (b.slice(0, 2).toString('ascii') !== 'BM') {
      fail(`${spec.file} 不是 BMP（缺 BM 签名）`);
      continue;
    }

    const dataOff = b.readUInt32LE(10);
    const dibSize = b.readUInt32LE(14);
    const w = b.readInt32LE(18);
    const h = b.readInt32LE(22);
    const bpp = b.readUInt16LE(28);
    const compression = b.readUInt32LE(30);

    // NSIS 要求 24bpp 非压缩。历史上这两个文件是 8bpp 索引色，
    // 部分 NSIS 版本会渲染异常或直接拒绝。
    if (bpp !== 24) {
      fail(`${spec.file} 位深 ${bpp}bpp（NSIS 要求 24bpp）`);
    } else {
      ok(`${spec.file} 位深 24bpp`);
    }

    if (compression !== 0) {
      fail(`${spec.file} 压缩方式 ${compression}（NSIS 要求 BI_RGB=0）`);
    } else {
      ok(`${spec.file} 非压缩 BI_RGB`);
    }

    if (w !== spec.w || h !== spec.h) {
      fail(`${spec.file} 尺寸 ${w}x${h}（应为 ${spec.w}x${spec.h}）`);
    } else {
      ok(`${spec.file} 尺寸 ${w}x${h} 符合 NSIS 规范`);
    }

    if (dibSize !== 40) {
      fail(`${spec.file} DIB 头 ${dibSize} 字节（NSIS 兼容性最好的是 40）`);
    }

    // 文件长度应正好等于 头 + 像素（每行 4 字节对齐）
    const rowSize = Math.ceil((w * bpp) / 8 / 4) * 4;
    const expected = dataOff + rowSize * h;
    if (b.length !== expected) {
      fail(`${spec.file} 长度 ${b.length} 与推算 ${expected} 不符（可能被截断）`);
    } else {
      ok(`${spec.file} 长度与像素数据推算一致`);
    }
  }
}

// ─────────────────────────────────────────────────────────────

checkIconPng();
checkIconIco();
checkInstallerBmp();

console.log('\n图标与安装器图片检查\n');
for (const m of passes) console.log('  PASS  ' + m);
for (const m of failures) console.log('  FAIL  ' + m);

if (failures.length) {
  console.log(`\n${failures.length} 项未通过，${passes.length} 项通过。`);
  console.log('\n提示：图标由 scripts/gen-icon.js 程序化生成，直接重跑即可修复：');
  console.log('  node scripts/gen-icon.js');
  process.exit(1);
}

console.log(`\n全部 ${passes.length} 项通过。`);
