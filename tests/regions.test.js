'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { regions, validateProfile, normalizeUrl, HOME_URL } = require('../src/regions');

const input = { name: '日本工作环境', regionId: 'jp-tokyo', nodeId: '' };
test('region profile validation derives regional defaults and supports explicit overrides', () => {
  const profile = validateProfile(input);
  assert.equal(profile.locale, 'ja-JP');
  assert.equal(profile.timezone, 'Asia/Tokyo');
  assert.equal(profile.locationMode, 'ask');
  assert.equal(profile.latitude, 35.6762);
  assert.equal(profile.userAgent, '');
  assert.equal(profile.homepage, HOME_URL);
  assert.equal(profile.engine, 'fingerprint');
  assert.equal(profile.canvasMode, 'stable');
  assert.equal(profile.searchEngine, 'bing');
  assert.equal(profile.memoryGiB, 8);
  assert.ok(profile.screenWidth >= profile.width);
  assert.ok(profile.screenHeight >= profile.height);
  const saved=validateProfile({...input}, profile);
  assert.equal(saved.screenWidth,profile.screenWidth);
  assert.equal(saved.screenHeight,profile.screenHeight);
  assert.equal(validateProfile({ ...input }, profile).fingerprintSeed, profile.fingerprintSeed);
  assert.equal(validateProfile({ ...input, userAgent: 'Peregrine-UA/1.0' }).userAgent, 'Peregrine-UA/1.0');
  assert.throws(() => validateProfile({ ...input, userAgent: 'bad\r\nInjected: value' }));
  const edited = validateProfile({ ...profile, timezone: 'Europe/London', locale: 'en-GB', latitude: 51.5 }, profile);
  assert.equal(edited.id, profile.id);
  assert.equal(edited.timezone, 'Europe/London');
  assert.equal(edited.locale, 'en-GB');
});
test('invalid timezones, coordinates, missing nodes and unsafe URLs are refused', () => {
  for (const patch of [{ timezone: 'Jupiter/Station' }, { latitude: 91 }, { longitude: -181 }, { nodeId: 'missing' }, { width: 200 }, { homepage: 'file:///C:/Windows/System32/config/SAM' }, { homepage: 'javascript:alert(1)' }]) {
    assert.throws(() => validateProfile({ ...input, ...patch }));
  }
  assert.throws(() => normalizeUrl('https://user:password@example.com'));
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl(HOME_URL), HOME_URL);
  assert.throws(() => normalizeUrl('peregrine://home/../../src/main.js'));
  assert.throws(() => normalizeUrl('peregrine://other/'));
  for (const region of regions) assert.doesNotThrow(() => validateProfile({ name: '地区检查', regionId: region.id }));
});

test('fingerprint settings reject malformed seeds and security policies', () => {
  for (const patch of [{ fingerprintSeed: -1 }, { fingerprintSeed: 4294967296 }, { fingerprintSeed: 0.5 }, { engine: 'webkit' }, { hardwareConcurrency: 99 }, { memoryGiB: 16 }, { screenWidth: 700 }, { pixelRatio: 1.1 }, { searchEngine: 'unsafe' }, { security: { httpsOnly: 'false' } }, { security: { webrtc: 'direct' } }]) assert.throws(() => validateProfile({ ...input, ...patch }));
  const legacy = { ...input, id: 'old-profile', createdAt: '2026-01-01' };
  assert.equal(validateProfile(input, legacy).engine, 'electron');
  assert.equal(validateProfile(input, legacy).fingerprintSeed, validateProfile(input, legacy).fingerprintSeed);
});
