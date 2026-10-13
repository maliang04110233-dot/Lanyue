# 发版与仓库运维手册

面向维护者。覆盖：远端初始化、分支保护、发版、代码签名接入。

---

## 一、首次接入远端（当前缺口）

仓库现在只有**本地** 3 个提交，没有远端 —— 意味着 `.github/workflows/ci.yml` 与
`release.yml` **一次都没跑过**。第一次接远端时按顺序做：

```bash
# 1. 加远端（仓库名与 build/config.cjs 的 publish 段一致，改名会让
#    已装客户端的 app-update.yml 指向旧地址，靠 GitHub 重定向续命）
git remote add origin git@github.com:maliang04110233-dot/Lanyue.git

# 2. 推历史（不要用 --depth：浅历史会让 tag 无法正确解析）
git push -u origin master

# 3. 确认 CI 真的跑起来了
#    GitHub 仓库页 → Actions → CI workflow
```

> **为什么强调「不要浅推」**：tag 指向的是具体提交，浅克隆拿不到完整对象图时，
> `git push --tags` 会失败，而发布流程的一切都建立在 tag 上。

如果远端是空仓库且你想保持默认分支叫 `main`：

```bash
git branch -M main
git push -u origin main
```

---

## 二、分支保护（推远端后立刻配）

仓库设置 → Branches → Add rule，对 `main`（或 `master`）：

| 项 | 建议值 | 理由 |
|---|---|---|
| Require a pull request | ✅ | 至少 1 位 reviewer（单人项目可开 "Dismiss stale reviews"） |
| Require status checks | ✅ `CI / Lint & Unit Tests`、`CI / Build & Asar Smoke` | 状态检查不过不许合 |
| Require branches to be up to date | ✅ | 避免合入时又落后主分支 |
| Block force pushes | ✅ | 本项目的历史里有 2026-09 的重命名事故，重写会让 bisect 失效 |
| Allow deletions | ❌ | 删主分支等于删项目 |
| Restrict who can push | ✅ | 含 tag 推送权限（发版只有一个人做） |

**关于 tag 保护**：Rulesets 里可限制 tag 匹配 `v*` 的创建权限。这一条比分支保护更重要
—— 发布出去的版本无法撤回。

---

## 三、发版流程

### 自动（tag 驱动，推荐）

```bash
# 1. 改版本号（同时同步 package-lock.json 的 version）
node scripts/version-bump.js            # patch；也可手改 package.json 后
                                       # npm install --package-lock-only 同步 lock

# 2. 写 CHANGELOG（本仓库强制：workflow 会检查 "## [版本]" 条目是否存在）
$EDITOR CHANGELOG.md

# 3. 提交 + 打 tag（tag 版本必须等于 package.json version，workflow 会硬校验）
git add -A && git commit -m "release: v1.0.36"
git tag -a v1.0.36 -m "v1.0.36"
git push origin master --follow-tags
```

流水线随后会：校验 tag ↔ package.json ↔ package-lock 三方一致 → 检查 CHANGELOG 条目
→ 跑 lint/audit/单测 → 真实打 NSIS + 便携版 → asar 冒烟 → **生成草稿 Release**。

### 最后一步是人工的，且必须人工

草稿 Release 建好后，去 Releases 页面确认三件事再点 Publish：

1. 安装包能正常安装并启动（别只看上传成功）
2. 包内版本号与 tag 一致
3. `latest.yml` 里的 `sha512` 与实际文件匹配 —— electron-updater 完全依赖它

**Publish 之后自动更新会立刻把这个版本推给所有已装用户，没有反悔余地。**

### 回滚

已发布版本无法回滚（用户已下载）。能做的是：

- **功能出问题**：立刻发一个新版本修（patch 或 minor）
- **发现签名/校验问题**：把 `useMirrorFeed` 的闸门收紧（fail-closed 已默认开启）
- **Release 本身出问题**：删除 Release 草稿（未 publish 前可随意删）

---

## 四、代码签名接入（当前未启用）

### 现状与后果

安装包**未做代码签名**，因此：

- `verifyUpdateCodeSignature: true` 这个开关**不产生实际约束**（产物无 `publisherName`，
  electron-updater 的校验逻辑读不到信任锚就按「放行」处理）
- 第三方镜像兜底已被 `src/main/updateMirror.js` 的 fail-closed 闸门拦下（检测到无
  `publisherName` 直接拒绝切换 feed），所以最危险的路径已经堵住
- 但走 GitHub 直连时，安装包仍是在「没有签名校验」的状态下被安装的
- Windows 会显示 SmartScreen 提示（影响首次安装体验）

### 采购到证书后要做的事

1. **配置签名**（`build/config.cjs` 的 `win` 段）：

   ```js
   win: {
     // ...已有配置
     certificateFile: process.env.WIN_CERT_PFX || undefined,      // 或直接写路径
     certificateSubjectName: process.env.WIN_CERT_SUBJECT || undefined,
     // 时戳服务器：没有它签名虽有效但会被「未做可信时间戳」质疑
     timeStampServer: 'http://timestamp.digicert.com',
   }
   ```

   建议走环境变量而不是把路径写进配置：证书路径是本机事实，不该进仓库。

2. **CI 里注入证书**（`release.yml` 的 build 步骤）：

   ```yaml
   - name: 还原证书
     run: echo "${{ secrets.WIN_CERT_PFX_BASE64 }}" | base64 -d > $RUNNER_TEMP\cert.pfx
   - name: Package
     run: npx electron-builder --config build/config.cjs --win --x64 --publish never
     env:
       CSC_LINK: ${{ runner.temp }}\cert.pfx
       CSC_KEY_PASSWORD: ${{ secrets.WIN_CERT_PASSWORD }}
   ```

   证书与口令放仓库 Secrets，**不要**提交进仓库。

3. **验证签名真的生效**（关键：不要只看配置写了什么）

   ```powershell
   # 产物必须带 publisherName —— 它是 electron-updater 唯一的校验对象
   Get-Content release\win-unpacked\resources\app-update.yml
   # 安装包签名状态必须是 Valid
   Get-AuthenticodeSignature 'release\Lanyue-Setup-1.0.36.exe' | Format-List Status,SignerCertificate
   ```

4. **同步更新**：

   - `test/update-signature-guard.test.js` 的 `RECORDED_STATE`
   - `SECURITY.md` 第四节的「已知未闭合项」
   - `CHANGELOG.md` 的「安全」小节
   - 确认后镜像兜底闸门会自动放行（`isMirrorFeedTrusted` 读的就是 `publisherName`），
     可按需决定是否恢复镜像兜底

5. **顺带摘掉一处**：现在更新页常驻显示「当前更新包未启用安装包签名校验」
   （`settings.about.updateSecurityHint`），签名生效后应改文案或隐藏。

---

## 五、日常维护

### 依赖更新

`.github/dependabot.yml` 已配置（周更 runtime / 月更 dev+CI，分组提交）。
合并前必跑：

```bash
npm run verify     # 含 lint / 单测 / dead-deps / icons / build / asar 冒烟
```

特别注意 **electron 大版本升级**：可能让 `build/config.cjs` 里那批「死依赖排除」的
假设失效（jade 链等），那只在打包后才暴露，所以 electron 组单独成 PR、人工验证。

### 本机钩子

```bash
npm run setup:hooks          # 安装 pre-commit 质量闸门
npm run setup:hooks -- --check   # 只看状态
SKIP_HOOKS=1 git commit ...      # 紧急绕过
```

### 性能基线

```bash
npm run bench -- --save      # 生成基线（不入库，见 .gitignore）
npm run bench -- --check     # 与基线对比，劣化超阈值则退出码 1
```

---

## 六、检查清单（发版前）

- [ ] `node scripts/version-bump.js` 后 `package.json` 与 `package-lock.json` 版本一致
- [ ] `CHANGELOG.md` 有本次 `## [版本]` 条目，且「安全」小节与实际改动一致
- [ ] `npm run verify` 全绿
- [ ] `npm run bench -- --check` 无显著劣化
- [ ] 本地跑一次安装包（Windows）：安装、启动、搜索、入队、下载、播放、更新检查
- [ ] tag 与版本一致，且 tag 推送权限受保护
