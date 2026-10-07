'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Store } = require('../src/store');

const key = crypto.randomBytes(32);
const encryption = {
  isEncryptionAvailable: () => true,
  encryptString: input => {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(input, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  },
  decryptString: data => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  }
};
test('subscription secrets are encrypted, refresh keeps node identities, deletion protects referenced nodes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangjing-store-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, encryption);
  const raw = { name: '日本01', type: 'http', server: '127.0.0.1', port: 8080, password: 'unit-secret-password' };
  store.importSubscription({ name: 'test', url: 'https://example.com/sub?token=unit-secret-token', host: 'example.com', proxies: [raw] });
  const id = store.subscriptions[0].id, nodeId = store.nodes[0].id;
  const vault = fs.readFileSync(store.vaultPath);
  assert.equal(vault.includes('unit-secret-password'), false);
  assert.equal(vault.includes('unit-secret-token'), false);
  const restored = new Store(dir, encryption);
  assert.equal(restored.nodes[0].raw.password, raw.password);
  store.importSubscription({ ...store.subscriptions[0], proxies: [{ ...raw, port: 9090 }] });
  assert.equal(store.nodes[0].id, nodeId);
  store.saveProfile({ name: '环境', regionId: 'jp-tokyo', nodeId });
  assert.throws(() => store.deleteSubscription(id), /有环境/);
  const copied = store.duplicateProfile(store.profiles[0].id);
  assert.notEqual(copied.id, store.profiles[0].id);
  assert.notEqual(copied.fingerprintSeed, store.profiles[0].fingerprintSeed);
  const reloaded = new Store(dir, encryption);
  assert.equal(reloaded.profiles[0].fingerprintSeed, store.profiles[0].fingerprintSeed);
  store.saveProfiles([]);
  store.deleteSubscription(id);
  assert.equal(store.nodes.length, 0);
});
test('unavailable encryption never silently persists secrets as plaintext', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangjing-store-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir, { isEncryptionAvailable: () => false });
  assert.throws(() => store.importSubscription({ name: 'test', host: 'test', proxies: [{ name: 'x', type: 'http', server: '127.0.0.1', port: 80 }] }), /加密/);
  assert.equal(fs.existsSync(store.vaultPath), false);
  assert.equal(store.subscriptions.length, 0);
});
test('legacy fingerprint migration keeps seed, data identity and removed-node references', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'peregrine-migration-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const old={id:'legacy-native',name:'已有环境',regionId:'jp-tokyo',engine:'fingerprint',fingerprintSeed:123456789,canvasMode:'compatibility',nodeId:'removed-subscription-node',createdAt:'2026-01-01',userAgent:'Legacy-UA/1'};
  fs.writeFileSync(path.join(dir,'profiles.json'),JSON.stringify([old]));
  const store=new Store(dir,encryption),migrated=store.profiles[0];
  assert.equal(migrated.id,old.id);assert.equal(migrated.fingerprintSeed,old.fingerprintSeed);
  assert.equal(migrated.nodeId,old.nodeId);assert.equal(migrated.createdAt,old.createdAt);
  assert.equal(migrated.canvasMode,'stable');assert.equal(migrated.fingerprintVersion,1);
  assert.deepEqual(new Store(dir,encryption).profiles[0],migrated);
});
