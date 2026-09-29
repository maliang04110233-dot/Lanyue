/**
 * electron-builder 配置 — MusicDL
 *
 * 优化要点：
 * 1. ASAR 压缩打包（比 uncompressed 体积小 40%+）
 * 2. NSIS 安装程序：自定义路径/桌面快捷方式/中英文双语
 * 3. 输出目录独立：release/（避免 dist/ 与 Vite 构建产物冲突）
 * 4. 自动更新：GitHub Releases
 * 5. Linux/macOS 配置
 */
module.exports = {
  appId: 'com.musicdl.app',
  productName: 'Lanyue',
  copyright: 'Copyright © 2026 Lanyue',
  directories: {
    output: 'release',
  },

  // ── 文件包含/排除 ──────────────────────────────────
  // 精确列出 Vite 构建产物，避免递归包含 dist/ 自身
  files: [
    'dist/main/**/*',
    'dist/preload/**/*',
    'dist/renderer/**/*',
    'dist/api/**/*',
    'dist/utils/**/*',
    'dist/shared/**/*',
    // scripts 不进 asar：Python 标签/转码脚本运行时从 resourcesPath/scripts 取
    // （src/utils/downloader.js 的路径解析第二候选），由下方 extraResources 提供
    'assets/**/*',
    'package.json',
    // ⚠️ package-lock.json 无法通过这里打进包 —— app-builder-lib 在
    // fileMatcher 的默认忽略清单里硬编码排除了它（连同 yarn.lock /
    // pnpm-lock.yaml / bun.lock），优先级高于本 files 数组，写了也无效。
    // 故版本号一致性只能靠 scripts/version-bump.js 在源头同步，
    // 并由 scripts/smoke-asar.js 以「缺失即跳过」的方式记录，不当作失败。
    '!**/test/**',
    '!**/__tests__/**',
    '!**/*.map',
    '!**/*.tsbuildinfo',

    // ── 剔除 jade 模版引擎依赖链（asar 减重 3.70 MB / 10.1%）──────
    // 来源：qq-music-api 的 dependencies 声明了 jade ~1.11.0，但该 SDK
    // 被本仓使用的入口是 node/index.js（main 字段），其 require 链为
    //   node/index.js → ./routes、../util/cache、../util/request
    // 全程不碰 jade；jade 只服务于该 SDK 自带的 express web server
    // （server.js，本仓从不加载）。属上游多声明的装饰性依赖。
    //
    // 判定依据（三重验证，均可复现）：
    //   1. 运行时插桩：hook Module._load 遍历 src/ 全部 58 个模块 +
    //      两个 SDK 入口，jade 及下列包**从未被 require**；
    //   2. 静态扫描：全仓（src + 各 SDK + express 等）grep jade 链包的
    //      require 点，jade 链外部命中数为 0；
    //   3. 归属确认：uglify-js / with / clean-css / transformers /
    //      constantinople 仅被 jade 引用，source-map 与 acorn 亦只被
    //      uglify-js 引用，均无旁路依赖。
    //
    // ⚠️ 与 express 的区别：express 虽也只被 server.js 使用，但
    // NeteaseCloudMusicApi/main.js 末尾有一句**无条件的**
    //   Object.assign(module.exports, require('./server'))
    // 会在加载即拉入 express 整棵树 —— 故 express/body-parser/raw-body/
    // finalhandler/serve-static 等**不可删**。切勿照着「server 才用」
    // 的直觉一刀切。
    //
    // 维护提示：若将来升级 qq-music-api 到改用 jade 渲染的接口，需先
    // 运行 scripts/check-dead-deps.cjs 复验，再移除本段排除项。
    '!node_modules/jade/**',
    '!node_modules/uglify-js/**',
    '!node_modules/with/**',
    '!node_modules/clean-css/**',
    '!node_modules/transformers/**',
    '!node_modules/constantinople/**',
    '!node_modules/character-parser/**',
    '!node_modules/is-promise/**',
    '!node_modules/jstransformer/**',
    '!node_modules/promise/**',
    '!node_modules/asap/**',
    '!node_modules/acorn/**',
    '!node_modules/acorn-globals/**',
    '!node_modules/css/**',
    '!node_modules/css-parse/**',
    '!node_modules/css-stringify/**',
    '!node_modules/void-elements/**',
    '!node_modules/align-text/**',
    '!node_modules/center-align/**',
    '!node_modules/right-align/**',
    '!node_modules/longest/**',
    '!node_modules/repeat-string/**',
    '!node_modules/kind-of/**',
    '!node_modules/lazy-cache/**',
    '!node_modules/uglify-to-browserify/**',
    '!node_modules/window-size/**',
    '!node_modules/amdefine/**',
    '!node_modules/optimist/**',
    '!node_modules/wordwrap/**',
    '!node_modules/decamelize/**',
    '!node_modules/source-map/**',
  ],

  // ── ASAR 压缩 ──────────────────────────────────────
  asar: true,
  asarUnpack: ['**/*.node'],
  compression: 'maximum',

  // ── Windows ────────────────────────────────────────
  win: {
    icon: 'assets/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
    // ⚠️ 不得关闭（2026-09 审计 P0）。
    // 这一项是 electron-updater 在 Windows 上校验安装包签名的开关，默认即 true。
    // 曾经被显式置为 false：配合 src/main/updateMirror.js 的第三方镜像兜底
    // （ghproxy / gh.ddlc），等于把「更新包由谁提供」的信任根交给网络中间人 ——
    // 镜像或链路被劫持即可静默安装未签名程序。签名校验是镜像兜底能存在的前提。
    verifyUpdateCodeSignature: true,
  },

  // ── NSIS 安装程序 ──────────────────────────────────
  nsis: {
    // 产物名：v1.0.33 及更早发布为 MusicDL-Setup-*（旧品牌），v1.0.34 起改用 Lanyue-*。
    // 此前"钉死旧名"的理由是"已发布的 latest.yml / Release 资产直接引用它们"——
    // 那条约束其实只对**已发布**的版本成立，改名因此是安全的：
    //   ① 每次发版重新生成 latest.yml，它指向的是本次自己的产物名，自洽；
    //   ② 旧资产不会被删除，旧下载 URL 继续可达（v1.0.33 的链接照常有效）；
    //   ③ appId 与包名（→ updaterCacheDirName）都没动 ⇒ 升级链与更新缓存目录不受影响。
    artifactName: 'Lanyue-Setup-${version}.${ext}',
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '揽乐',
    allowElevation: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: true,
    installerHeaderIcon: 'assets/icon.ico',
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico',
    license: 'LICENSE',
    installerLanguages: ['zh_CN', 'en_US'],
    // 品牌图片（NSIS 2.0 风格：顶部横幅 + 左侧边栏）
    installerHeader: 'build/installerHeader.bmp',
    installerSidebar: 'build/installerSidebar.bmp',
  },

  // ── Linux ──────────────────────────────────────────
  // ⚠️ electron-builder 26 起 schema 已移除 `linux.desktop`（自定义 .desktop 字段）。
  // 校验是全 config 生效的 —— 即使只打 --win，残留该字段也会直接
  // 「Invalid configuration object」打包失败。Name/Categories 由 productName 与 category 自动生成。
  linux: {
    icon: 'assets',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] },
    ],
    category: 'AudioVideo',
  },

  // ── macOS ──────────────────────────────────────────
  mac: {
    icon: 'assets/icon.png',
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    category: 'public.app-category.music',
    artifactName: '${name}-${version}-${os}-${arch}.${ext}',
  },

  // ── 自动更新（GitHub Releases）─────────────────────
  publish: {
    provider: 'github',
    owner: 'maliang04110233-dot',
    repo: 'Lanyue',
    private: false,
    releaseType: 'release',
  },

  // ── 额外资源 ───────────────────────────────────────
  // 只带运行期真正执行的 Python 脚本（write_tags.py 标签写入；convert_audio.py
  // 应急转码兜底），17 个开发期 js 脚本不再随包分发（2026-09 审计产物卫生项）
  extraResources: [
    { from: 'scripts/', to: 'scripts/', filter: ['*.py'] },
  ],
};
