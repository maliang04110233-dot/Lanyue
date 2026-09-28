/**
 * gen-icon.js — 程序化生成 MusicDL 图标与安装器图片
 *
 * 产物：
 *   assets/icon.ico              多尺寸 ICO（16/24/32/48/64/128/256），Windows 用
 *   assets/icon.png              512×512 PNG，Linux / macOS 用
 *   build/installerHeader.bmp    150×57  24bpp，NSIS 顶部横幅
 *   build/installerSidebar.bmp   164×314 24bpp，NSIS 左侧边栏
 *
 * 设计：白色圆角方牌 + 深靛紫八分音符（符头 + 符干 + 符尾）。
 * 全部用代码绘制，可在任意尺寸下重新生成，不依赖外部素材。
 *
 * ⚠️ 三个必须守住的性质（有 check:icons 守卫）：
 *   1. **无水印**。历史版本 icon.png 是一张 AI 生成图，右下角烧录了
 *      「图片由AI生成」水印，会随安装包发给用户。程序化绘制从根上避免。
 * 2. **方形铺满 + 白底要有对比**。图标是铺满画布的圆角方牌（5c58701 起，
 *      旧规范是圆底 + 圆外透明）。白色底最大的风险是「白压白」——前景画错
 *      颜色或干脆没画上，肉眼在浅色背景下看不出来。所以底板与音符之间必须
 *      拉开明度跨度，这条由 check-icons 的明度/深色像素判据守着。
 *   3. **ICO 多尺寸齐备**。只放单一尺寸会让系统缩放时糊掉。
 *
 * ⚠️ alpha 合成的坑（本文件曾在此处出错，务必先读）：
 *   合成必须按 **source-over**：结果 = 源 × 源α + 目标 × 目标α × (1 − 源α)。
 *   早期版本把公式写反（目标在前、源被乘了 (1−目标α)），在**已经不透明**的
 *   底板上再画音符时，源贡献恒为 0 —— 音符被数学上完全抹除，
 *   画出来只有一个空方块，且**不报任何错**。
 *   绘制顺序是「先铺不透明底、再画前景」，所以这个错误 100% 会触发。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const BUILD = path.join(__dirname, '..', 'build');

// ─────────────────────────────────────────────────────────────
// 画布：RGBA 像素缓冲 + 正确的 alpha 合成
// ─────────────────────────────────────────────────────────────

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = new Float64Array(size * size * 4); // 用浮点，避免反复舍入丢精度
  }

  /**
   * source-over 合成单个像素。
   * @param {number} cov 覆盖度 0..1，用于抗锯齿（相当于把源 alpha 再乘一次）
   */
  blend(x, y, r, g, b, a, cov) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const alpha = (a / 255) * cov;
    if (alpha <= 0) return;

    const i = (y * this.size + x) * 4;
    const sa = this.data[i + 3];
    const outA = alpha + sa * (1 - alpha); // 源在上，目标在下
    if (outA <= 0) return;

    // 源项带 alpha，目标项带 sa*(1-alpha)，正是 source-over 的定义
    this.data[i] = (r * alpha + this.data[i] * sa * (1 - alpha)) / outA;
    this.data[i + 1] = (g * alpha + this.data[i + 1] * sa * (1 - alpha)) / outA;
    this.data[i + 2] = (b * alpha + this.data[i + 2] * sa * (1 - alpha)) / outA;
    this.data[i + 3] = outA;
  }

  /** 逐像素按椭圆方程填充，带 1px 抗锯齿边缘 */
  fillEllipse(cx, cy, rx, ry, rot, r, g, b, a = 255) {
    if (rx <= 0 || ry <= 0) return;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    // 旋转后椭圆的轴对齐包围盒（保守估计）
    const span = Math.sqrt((rx * cos) ** 2 + (ry * sin) ** 2);
    const spanY = Math.sqrt((rx * sin) ** 2 + (ry * cos) ** 2);
    const x0 = Math.floor(cx - span - 1);
    const x1 = Math.ceil(cx + span + 1);
    const y0 = Math.floor(cy - spanY - 1);
    const y1 = Math.ceil(cy + spanY + 1);

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const lx = dx * cos + dy * sin;
        const ly = -dx * sin + dy * cos;
        // d=1 正好在椭圆边界上；用 d 到边界的距离换算覆盖率
        const d = Math.sqrt((lx / rx) ** 2 + (ly / ry) ** 2);
        if (d > 1) continue;
        // 边缘 1.5% 的带宽内做线性过渡，消除锯齿
        const cov = d > 0.985 ? (1 - d) / 0.015 : 1;
        this.blend(x, y, r, g, b, a, Math.min(1, cov));
      }
    }
  }

  /** 轴向矩形填充（含抗锯齿） */
  fillRect(x0, y0, x1, y1, r, g, b, a = 255) {
    const [ax, bx] = x0 <= x1 ? [x0, x1] : [x1, x0];
    const [ay, by] = y0 <= y1 ? [y0, y1] : [y1, y0];
    for (let y = Math.floor(ay); y <= Math.ceil(by); y++) {
      for (let x = Math.floor(ax); x <= Math.ceil(bx); x++) {
        // 覆盖率 = 像素与矩形在 x/y 两个方向的交叠比例
        const covX = Math.min(1, x + 1 - ax) - Math.max(0, x - ax);
        const covY = Math.min(1, y + 1 - ay) - Math.max(0, y - ay);
        const cov = Math.max(0, covX) * Math.max(0, covY);
        if (cov > 0) this.blend(x, y, r, g, b, a, cov);
      }
    }
  }

  /**
   * 圆角矩形填充（含抗锯齿）。
   *
   * 覆盖度用「到圆角圆心矩形的最近点距离」算：把像素夹进内缩 r 的中心矩形，
   * 夹不到的方向就给出该方向的越界量，两者合成后到边界距离 = r − d。
   * 直边处该式会退化成「离边几个像素」（r 自动抵消），所以整条边都能正确淡出，
   * 而不是只在四个角淡出 —— 铺满画布时最外一圈像素因此是半透明，属正常抗锯齿。
   * 用 fillRect 逐段拼圆角会切出阶梯，必须走像素判定。
   *
   * @param {(px:number,py:number)=>{r:number,g:number,b:number,a?:number}} colorAt
   */
  fillRoundRect(x0, y0, x1, y1, r, colorAt) {
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        if (px < x0 || px > x1 || py < y0 || py > y1) continue;
        const nx = Math.min(Math.max(px, x0 + r), x1 - r);
        const ny = Math.min(Math.max(py, y0 + r), y1 - r);
        const d = Math.hypot(px - nx, py - ny);
        if (d > r) continue;
        const edge = r - d;
        const cov = edge > 1.5 ? 1 : edge / 1.5;
        const c = colorAt(px, py);
        this.blend(x, y, c.r, c.g, c.b, c.a === undefined ? 255 : c.a, Math.min(1, cov));
      }
    }
  }

  toRGBA() {
    const out = Buffer.alloc(this.size * this.size * 4);
    for (let i = 0; i < this.data.length; i += 4) {
      out[i] = Math.max(0, Math.min(255, Math.round(this.data[i])));
      out[i + 1] = Math.max(0, Math.min(255, Math.round(this.data[i + 1])));
      out[i + 2] = Math.max(0, Math.min(255, Math.round(this.data[i + 2])));
      out[i + 3] = Math.max(0, Math.min(255, Math.round(this.data[i + 3] * 255)));
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────
// 调色板
// ─────────────────────────────────────────────────────────────

const BG_TOP = { r: 255, g: 255, b: 255 }; // 方牌亮端：纯白
const BG_BOTTOM = { r: 226, g: 231, b: 243 }; // 方牌暗端：极浅蓝灰，让白方块在浅色桌面上仍能看出边界
const NOTE_MAIN = { r: 44, g: 20, b: 122 }; // 音符主色（品牌靛紫）
const NOTE_HI = { r: 96, g: 62, b: 186 };   // 音符受光侧
const NOTE_LO = { r: 18, g: 6, b: 56 };     // 音符背光侧 / 描边投影

const mix = (c1, c2, t) => ({
  r: c1.r + (c2.r - c1.r) * t,
  g: c1.g + (c2.g - c1.g) * t,
  b: c1.b + (c2.b - c1.b) * t,
});

/** 点 (px,py) 到线段 (x1,y1)-(x2,y2) 的最短距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  // 把点投影到线段上，t 夹到 [0,1] 以保证落在段内
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ─────────────────────────────────────────────────────────────
// 图标绘制
// ─────────────────────────────────────────────────────────────

/**
 * 在 size×size 画布上绘制图标。
 * 所有几何量都按 size 的比例给出，保证任意尺寸下构图一致、可辨识。
 */
function drawIcon(canvas, size) {
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.46; // 音符构图的基准半径（沿用旧版比例，方牌下留白更足）

  // ── 底板：铺满画布的圆角方牌，纯白 → 极浅蓝灰的对角渐变 ──
  // 圆角取 10% 边长：肉眼读作「方形」，但避开直角被系统蒙版硬切。
  // 不敢用纯白一片 —— 白图标贴在浅色任务栏/桌面上会直接消失，
  // 所以靠这条很浅的对角渐变收出边界（check-icons 的明度跨度也靠它兜底）。
  const rad = size * 0.10;
  canvas.fillRoundRect(0, 0, size, size, rad, (px, py) => {
    const t = (px + py) / (2 * size);
    const col = mix(BG_TOP, BG_BOTTOM, t);
    return { r: col.r, g: col.g, b: col.b, a: 255 };
  });

  // ── 音符几何（八分音符：符头 + 符干 + 符尾）──
  // 用相对尺寸定义，小尺寸下这些比例依然成立。
  const noteW = R * 0.62;          // 音符整体视觉宽度
  const headRx = noteW * 0.30;
  const headRy = headRx * 0.82;
  const stemW = Math.max(1.15, size * 0.045);

  // 符干竖直位置：顶部略低于圆心，底部落在符头中心
  const stemTop = cy - R * 0.52;
  const headCy = cy + R * 0.30;
  const headCx = cx - noteW * 0.16;
  const stemCx = cx + noteW * 0.20;

  // 符干（带从亮到暗的纵向渐变）
  const stemSteps = Math.max(24, Math.round((headCy - stemTop)));
  for (let i = 0; i <= stemSteps; i++) {
    const t = i / stemSteps;
    const y = stemTop + (headCy - stemTop) * t;
    const col = mix(NOTE_HI, NOTE_LO, t * 0.85);
    canvas.fillRect(stemCx - stemW / 2, y, stemCx + stemW / 2, y + (headCy - stemTop) / stemSteps + 0.5,
      col.r, col.g, col.b, 255);
  }

  // 符尾：从符干顶端向右外扬、再收回的水滴形实体
  //
  // ⚠️ 两个曾经踩过的坑，改动前务必先读：
  //   1. **不要沿贝塞尔路径盖小方块** —— 步长稍大于方块尺寸就会留下
  //      一串断续虚点（小尺寸下尤其明显）。
  //   2. **不要用 fillRect 逐行拼** —— fillRect 的覆盖率按像素与矩形交叠
  //      计算，配合 alpha 渐隐后每行只剩 1~2px 实心，整体退化成一根细线。
  // 正确做法：先在浮点缓冲上做「点是否在水滴内」的判定（椭圆求交），
  // 再一次性合成，边缘按到边界距离做抗锯齿。
  //
  // 水滴 = 两个椭圆并集再叠一条连接带：
  //   · 主鼓包：紧跟符干顶端，最宽
  //   · 尾梢：向右下甩出，收细
  //   · 连接带：填掉两椭圆之间的凹口，避免看起来像两个分离的圆
  const bulgeRx = noteW * 0.30;
  const bulgeRy = R * 0.185;
  const bulgeCx = stemCx + noteW * 0.15;
  const bulgeCy = stemTop + R * 0.145;

  const tipRx = noteW * 0.235;
  const tipRy = R * 0.135;
  const tipCx = stemCx + noteW * 0.46;
  const tipCy = stemTop + R * 0.305;

  const flagY0 = Math.floor(stemTop - 2);
  const flagY1 = Math.ceil(stemTop + R * 0.50);
  const flagX0 = Math.floor(stemCx - 2);
  const flagX1 = Math.ceil(stemCx + noteW * 0.78);

  for (let y = flagY0; y <= flagY1; y++) {
    for (let x = flagX0; x <= flagX1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const db = Math.sqrt(((px - bulgeCx) / bulgeRx) ** 2 + ((py - bulgeCy) / bulgeRy) ** 2);
      const dt = Math.sqrt(((px - tipCx) / tipRx) ** 2 + ((py - tipCy) / tipRy) ** 2);

      // 连接带：沿两椭圆中心连线的一条粗线段，用「点到线段距离」判定。
      // 有它才是一个完整的水滴，否则两椭圆交界处会出现明显凹口。
      const segD = distToSegment(px, py, bulgeCx, bulgeCy, tipCx, tipCy);
      const band = segD / (stemW * 0.95);

      const d = Math.min(db, dt, band);
      if (d > 1) continue;

      const cov = d > 0.94 ? (1 - d) / 0.06 : 1;
      const shade = Math.max(0, Math.min(1, (py - stemTop) / (R * 0.5)));
      const col = mix(NOTE_HI, NOTE_MAIN, shade);
      canvas.blend(x, y, col.r, col.g, col.b, 255, Math.min(1, cov));
    }
  }

  // 符头：先描一圈暗色投影增加与白底的分离度，再填主色，最后点高光
  canvas.fillEllipse(headCx + size * 0.008, headCy + size * 0.012, headRx, headRy, -0.32,
    NOTE_LO.r, NOTE_LO.g, NOTE_LO.b, 110);
  canvas.fillEllipse(headCx, headCy, headRx, headRy, -0.32,
    NOTE_MAIN.r, NOTE_MAIN.g, NOTE_MAIN.b, 255);
  canvas.fillEllipse(headCx - headRx * 0.28, headCy - headRy * 0.30, headRx * 0.38, headRy * 0.34, -0.32,
    NOTE_HI.r, NOTE_HI.g, NOTE_HI.b, 210);
}

// ─────────────────────────────────────────────────────────────
// PNG / ICO 编码
// ─────────────────────────────────────────────────────────────

function crc32(buf) {
  let c = 0xffffffff;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let v = n;
    for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    table[n] = v;
  }
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData));
  return Buffer.concat([len, typeData, crc]);
}

/** RGBA 像素 → PNG Buffer（每行前加一个 filter 字节 0） */
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 组装 ICO。每个尺寸各存一张 PNG（Vista+ 支持 PNG-in-ICO，
 * 且 PNG 比 BMP 小很多，128/256 尤其明显）。
 */
function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = ICO
  header.writeUInt16LE(entries.length, 4);

  let offset = 6 + entries.length * 16;
  const dir = [];
  for (const { size, png } of entries) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 256 用 0 表示
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // 调色板数
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4);   // planes
    e.writeUInt16LE(32, 6);  // bit count
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    dir.push(e);
    offset += png.length;
  }

  return Buffer.concat([header, ...dir, ...entries.map(e => e.png)]);
}

/** 渲染指定尺寸的图标 → { size, rgba } */
function render(size) {
  const canvas = new Canvas(size);
  drawIcon(canvas, size);
  return { size, rgba: canvas.toRGBA() };
}

// ─────────────────────────────────────────────────────────────
// BMP 编码（NSIS 安装器用，24bpp 非压缩）
// ─────────────────────────────────────────────────────────────

/**
 * RGBA → 24bpp BGR 非压缩 BMP。
 * NSIS 2.0 要求 installerHeader / installerSidebar 为 24bpp；
 * 8bpp 索引图在部分 NSIS 版本下会被拒绝或渲染异常。
 */
function encodeBMP(rgba, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4; // 每行 4 字节对齐
  const pixelBytes = rowSize * height;
  const fileHeaderSize = 14;
  const dibSize = 40;
  const dataOffset = fileHeaderSize + dibSize;

  const buf = Buffer.alloc(dataOffset + pixelBytes);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(dataOffset, 10);

  buf.writeUInt32LE(dibSize, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // 正数 = bottom-up
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixelBytes, 34);
  buf.writeInt32LE(2835, 38); // 72 DPI
  buf.writeInt32LE(2835, 42);

  // BMP 是 bottom-up，且通道序为 BGR
  for (let y = 0; y < height; y++) {
    const srcY = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const si = (srcY * width + x) * 4;
      const di = dataOffset + y * rowSize + x * 3;
      buf[di] = rgba[si + 2];
      buf[di + 1] = rgba[si + 1];
      buf[di + 2] = rgba[si];
    }
  }
  return buf;
}

// ─────────────────────────────────────────────────────────────
// 安装器图片绘制
// ─────────────────────────────────────────────────────────────

/** 在 RGBA 缓冲上铺横向渐变（用于安装器横幅/侧边栏的打底） */
function gradientFill(w, h, from, to, angleDeg) {
  const out = Buffer.alloc(w * h * 4);
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // 把渐变轴投影到画布对角线长度上，保证 0..1 覆盖满
  const proj = Math.abs(w * cos) + Math.abs(h * sin);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = Math.max(0, Math.min(1, (x * cos + y * sin) / proj));
      const c = mix(from, to, t);
      const i = (y * w + x) * 4;
      out[i] = c.r;
      out[i + 1] = c.g;
      out[i + 2] = c.b;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** 把小尺寸图标（带 alpha）叠加到 RGBA 大图上的指定位置 */
function blitIcon(dst, dw, dh, iconRgba, isz, ox, oy, opacity = 1) {
  for (let y = 0; y < isz; y++) {
    const dy = oy + y;
    if (dy < 0 || dy >= dh) continue;
    for (let x = 0; x < isz; x++) {
      const dx = ox + x;
      if (dx < 0 || dx >= dw) continue;
      const si = (y * isz + x) * 4;
      const a = (iconRgba[si + 3] / 255) * opacity;
      if (a <= 0) continue;
      const di = (dy * dw + dx) * 4;
      for (let k = 0; k < 3; k++) {
        dst[di + k] = Math.round(iconRgba[si + k] * a + dst[di + k] * (1 - a));
      }
      dst[di + 3] = 255;
    }
  }
}

/** 顶部横幅 150×57：左侧图标 + 右侧品牌色条（BMP 无 alpha，直接画在不透明底上） */
function renderInstallerHeader() {
  const W = 150;
  const H = 57;
  const canvas = gradientFill(W, H, { r: 34, g: 20, b: 96 }, { r: 18, g: 8, b: 62 }, 20);

  // 图标 44px 居中于左侧留白区（57px 高的条里，44 留出上下各 6~7px 呼吸空间）
  const iconSize = 44;
  const icon = render(iconSize);
  blitIcon(canvas, W, H, icon.rgba, iconSize, 7, Math.round((H - iconSize) / 2));

  // 品牌色条：与图标音符的靛紫呼应（旧版是金色，随白底深靛紫改造一并收口）。
  // NSIS 顶部横幅只有 57px 高，在这个尺寸下塞中文/英文产品名经 24bpp 转换后极易糊，
  // 故用一条克制的色条表达品牌，产品名由安装器标题文字承担。
  const barX0 = 64;
  const barX1 = 126;
  const barY0 = Math.round(H / 2) - 3;
  const barY1 = barY0 + 5;
  for (let y = barY0; y < barY1; y++) {
    for (let x = barX0; x < barX1; x++) {
      const t = (x - barX0) / (barX1 - barX0);
      const c = mix({ r: 156, g: 130, b: 232 }, { r: 78, g: 48, b: 164 }, t);
      const i = (y * W + x) * 4;
      canvas[i] = c.r;
      canvas[i + 1] = c.g;
      canvas[i + 2] = c.b;
    }
  }
  return encodeBMP(canvas, W, H);
}

/** 左侧边栏 164×314：竖向渐变 + 居中图标 + 底部细装饰 */
function renderInstallerSidebar() {
  const W = 164;
  const H = 314;
  const canvas = gradientFill(W, H, { r: 30, g: 16, b: 88 }, { r: 14, g: 6, b: 52 }, 65);
  const icon = render(120);
  blitIcon(canvas, W, H, icon.rgba, 120, Math.round((W - 120) / 2), 84);

  // 底部装饰带：与图标音符同色（靛紫）
  for (let y = H - 12; y < H - 8; y++) {
    for (let x = 30; x < W - 30; x++) {
      const i = (y * W + x) * 4;
      canvas[i] = 156; canvas[i + 1] = 130; canvas[i + 2] = 232;
    }
  }
  return encodeBMP(canvas, W, H);
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.mkdirSync(BUILD, { recursive: true });

  // ICO 尺寸：16/24/32 用于任务栏与资源管理器小图标，48 用于桌面，
  // 128/256 用于大图标视图与 Alt+Tab。
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoEntries = icoSizes.map(size => {
    const { rgba } = render(size);
    return { size, png: encodePNG(size, rgba) };
  });
  const ico = encodeICO(icoEntries);
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), ico);

  // Linux / macOS 用 PNG。512 足够覆盖 macOS retina 的 256@2x，
  // 且体积远小于原 1024。
  const png512 = render(512);
  fs.writeFileSync(path.join(ASSETS, 'icon.png'), encodePNG(512, png512.rgba));

  fs.writeFileSync(path.join(BUILD, 'installerHeader.bmp'), renderInstallerHeader());
  fs.writeFileSync(path.join(BUILD, 'installerSidebar.bmp'), renderInstallerSidebar());

  console.log('icon.ico            ', ico.length, 'B  —', icoSizes.join('/'));
  console.log('icon.png            ', fs.statSync(path.join(ASSETS, 'icon.png')).size, 'B  — 512x512');
  console.log('installerHeader.bmp ', fs.statSync(path.join(BUILD, 'installerHeader.bmp')).size, 'B  — 150x57 24bpp');
  console.log('installerSidebar.bmp', fs.statSync(path.join(BUILD, 'installerSidebar.bmp')).size, 'B  — 164x314 24bpp');
}

if (require.main === module) main();

module.exports = { Canvas, drawIcon, encodePNG, encodeICO, encodeBMP, render, renderInstallerHeader, renderInstallerSidebar };
