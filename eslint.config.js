const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-console': 'off',
      'no-prototype-builtins': 'off',
      // 渲染层与前端代码禁止直接 fetch / XMLHttpRequest：
      // 网络请求必须走主进程 IPC（src/api/request.js 有统一 SSRF 防护）。
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: '禁止直接使用 fetch，请走主进程 IPC（musicAPI.*）' },
        { name: 'XMLHttpRequest', message: '禁止直接使用 XMLHttpRequest，请走主进程 IPC（musicAPI.*）' },
        { name: 'WebSocket', message: '禁止直接使用 WebSocket，请走主进程 IPC（musicAPI.*）' },
      ],
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // 测试文件允许 fetch / WebSocket（MCP 服务等需要真实 HTTP 客户端）
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        musicAPI: 'readonly',
        showToast: 'readonly',
        setState: 'readonly',
        getState: 'readonly',
        applyTheme: 'readonly',
        renderQueue: 'readonly',
        showDownloadError: 'readonly',
        mockLocalSongs: 'readonly',
        state: 'readonly',
        parseLrc: 'readonly',
        showNoLyrics: 'readonly',
        audio: 'readonly',
        updateProgress: 'readonly',
        onAudioEnded: 'readonly',
        stopSpectrum: 'readonly',
        startSpectrum: 'readonly',
        fmtTime: 'readonly',
        togglePlay: 'readonly',
      },
    },
    rules: {
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-inner-declarations': 'off',
    },
  },
];
