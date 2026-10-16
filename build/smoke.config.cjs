'use strict';

/**
 * 发行冒烟专用打包配置。
 * 与正式 release/ 隔离，避免一次失败的 --dir 打包移走或破坏上一份可发布产物。
 *
 * SMOKE_OUT_DIR 可覆盖输出目录：Windows 上 IDE/索引器的文件监视器会持有
 * 刚生成的 app.asar 只读句柄（Restart Manager 对这类句柄查不到持有者），
 * 重打包时 electron-builder unlink 旧 asar 直接 EBUSY。换一个全新目录
 * 即可绕开，不动被锁的文件、也不需要任何删除。
 */
const base = require('./config.cjs');

const OUT = process.env.SMOKE_OUT_DIR || '.preview/release-smoke';

module.exports = {
  ...base,
  directories: {
    ...(base.directories || {}),
    output: OUT,
  },
  // 冒烟只需要解包目录，命令行仍显式传 --dir；清掉发布配置避免误触上传。
  publish: null,
};
