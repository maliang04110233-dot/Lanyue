/**
 * AI 音乐落盘的路径判据必须与全仓同源（2026-10-13 复审 P1-3）
 *
 * 旧实现（src/main/ipc/ai-music.js）在 saveDir 校验上重写了一份纯词法
 * isInside —— 只做 path.relative，没过 approvedDirs 的 realpath 复核。
 * 于是「默认下载目录里一个指向别处的链接」可以把 AI 生成的 mp3 写到沙箱外，
 * 而同一仓库里 downloadQueue 的模板子目录、open-folder、library 的十几条
 * 路径通道都会被 isApprovedDir 拦下。src/utils/downloadPath.js 顶部的遗留
 * 注释早把它点过名，但它一直没改。
 *
 * 换掉之后还顺手修掉一个功能 bug：旧允许基目录不含 aiMusicSaveDir，用户在
 * AI 页用原生选器挑的保存目录会被判为不合法，于是每首都静默落到默认目录，
 * 那个设置项形同虚设。
 *
 * ai-music.js 顶层 require('electron')，无法在 Node 单测里加载，所以这里用
 * 静态守卫钉住「判据同源」这条不变量 —— 本仓库对不可测模块一贯如此。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const AI_MUSIC = fs.readFileSync(
  path.join(__dirname, '..', 'src/main/ipc/ai-music.js'), 'utf8');
const DOWNLOAD_PATH = fs.readFileSync(
  path.join(__dirname, '..', 'src/utils/downloadPath.js'), 'utf8');

test('守卫钉：AI 落盘必须走 approvedDirs.isApprovedDir，不许自写词法判定', () => {
  assert.ok(AI_MUSIC.includes("require('../approvedDirs')"),
    'ai-music.js 必须从 approvedDirs 取判据，保持单一事实来源');
  assert.ok(AI_MUSIC.includes('isApprovedDir(saveDir)'),
    'saveDir 必须过 isApprovedDir（词法快筛 + realpath 复核两道闸）');
  assert.ok(!AI_MUSIC.includes('const isInside = (base, target)'),
    '不许再自带一份纯词法 isInside —— 那正是符号链接逃逸的入口');
  assert.ok(!AI_MUSIC.includes('allowedBaseDirs'),
    '旧的 allowedBaseDirs 口径（含整个 userData、且漏掉 aiMusicSaveDir）应已移除');
});

test('守卫钉：未被批准的 saveDir 必须回落默认目录，并留下日志', () => {
  assert.ok(AI_MUSIC.includes('!isApprovedDir(saveDir)'),
    '判定必须取反使用：未批准即回落');
  assert.ok(AI_MUSIC.includes('AI_SUBDIR_NAME'),
    '回落目标仍是默认下载目录下的 AI 子目录');
  assert.ok(AI_MUSIC.includes('拒绝未批准的 saveDir'),
    '拒绝要留日志：用户选了目录却被改道，得能查到');
});

test('回归：downloadPath.js 的遗留注释应已删除（别再误导后来人）', () => {
  assert.ok(!DOWNLOAD_PATH.includes('里另有一份'),
    'ai-music.js 已改用 isApprovedDir，那条「遗留」注释必须删掉，'
    + '否则下一个维护者会以为两套口径还在');
});
