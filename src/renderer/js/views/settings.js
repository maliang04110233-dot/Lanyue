/**
 * MusicDL 设置 / Cookie 管理视图 — 兼容层
 *
 * 原始 ~1600 行巨型文件已拆分为 settings/ 目录下的 6 个子模块，
 * settings/index.js 是聚合入口（统一导出 + 全局 window 桥接 + DOM 缓存初始化）：
 *   - account.js    账户平台管理（账号卡片、Cookie、源健康度）
 *   - quality.js    质量策略（分平台音质、换源排除、质量规则）
 *   - general.js    通用设置（主题、快捷键、文件名模板）
 *   - templates.js  下载路径模板管理
 *   - mcp.js        MCP 本地服务
 *   - webdav.js     WebDAV 云同步
 *
 * 本文件保留为兼容层：既有 import 语句（如 app.js 的
 * `import './views/settings.js'`）无需改动。`export *` 在转发全部具名导出的
 * 同时会触发 index.js 求值 —— window.* 桥接与 DOM 缓存初始化照常发生。
 */

export * from './settings/index.js';
