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
    },
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
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
