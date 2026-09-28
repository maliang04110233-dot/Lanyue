import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFallbackByCode, FALLBACK_CODES } from '../src/api/services/fallbackCodes.js';

describe('换源白名单', () => {
  it('PLATFORM_CHANGED 在白名单内', () => {
    assert.ok(FALLBACK_CODES.has('PLATFORM_CHANGED'));
  });

  it('shouldFallbackByCode 对 PLATFORM_CHANGED 返回 true', () => {
    assert.equal(shouldFallbackByCode('PLATFORM_CHANGED'), true);
  });

  it('VIP_REQUIRED / COPYRIGHT_RESTRICTED 仍在白名单', () => {
    assert.equal(shouldFallbackByCode('VIP_REQUIRED'), true);
    assert.equal(shouldFallbackByCode('COPYRIGHT_RESTRICTED'), true);
  });

  it('NETWORK_TIMEOUT 不在白名单（网络问题不换源）', () => {
    assert.equal(shouldFallbackByCode('NETWORK_TIMEOUT'), false);
  });

  it('null / undefined / 空串都返回 false', () => {
    assert.equal(shouldFallbackByCode(null), false);
    assert.equal(shouldFallbackByCode(undefined), false);
    assert.equal(shouldFallbackByCode(''), false);
  });

  it('未知错误码返回 false', () => {
    assert.equal(shouldFallbackByCode('UNKNOWN_ERROR'), false);
  });

  it('白名单包含 9 个错误码', () => {
    assert.equal(FALLBACK_CODES.size, 9);
  });
});
