'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { validateProfile } = require('./regions');
const { guessCountry } = require('./subscription');

class Store {
  constructor(dataPath, encryption) {
    this.dataPath = dataPath;
    this.encryption = encryption;
    fs.mkdirSync(dataPath, { recursive: true });
    this.profilesPath = path.join(dataPath, 'profiles.json');
    this.vaultPath = path.join(dataPath, 'subscriptions.enc');
    this.profiles = fs.existsSync(this.profilesPath) ? JSON.parse(fs.readFileSync(this.profilesPath, 'utf8')) : [];
    this.subscriptions = [];
    this.nodes = [];
    if (fs.existsSync(this.vaultPath)) {
      try {
        if (!encryption.isEncryptionAvailable()) throw new Error();
        const vault = JSON.parse(encryption.decryptString(fs.readFileSync(this.vaultPath)));
        this.subscriptions = vault.subscriptions;
        this.nodes = vault.nodes;
        if (!Array.isArray(this.subscriptions) || !Array.isArray(this.nodes)) throw new Error();
      } catch { throw new Error('无法解密本机订阅数据。请使用原 Windows 账户打开，或恢复数据备份。'); }
    }
    if (!Array.isArray(this.profiles)) throw new Error('环境数据格式损坏，请恢复数据备份。');
    if (this.profiles.some(p => p.engine === 'fingerprint' && !p.fingerprintVersion)) {
      this.saveProfiles(this.profiles.map(p => p.engine === 'fingerprint' && !p.fingerprintVersion ? validateProfile({ ...p, canvasMode: p.canvasMode === 'native' ? 'native' : 'stable' }, p, [...this.nodes.map(n => n.id), p.nodeId].filter(Boolean)) : p));
    }
  }

  atomicWrite(file, data) {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, data, { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  saveProfiles(next) {
    this.atomicWrite(this.profilesPath, JSON.stringify(next, null, 2));
    this.profiles = next;
  }

  saveVault(subscriptions, nodes) {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('系统加密服务不可用，暂时无法保存订阅。');
    this.atomicWrite(this.vaultPath, this.encryption.encryptString(JSON.stringify({ subscriptions, nodes })));
    this.subscriptions = subscriptions;
    this.nodes = nodes;
  }

  saveProfile(input) {
    const existing = input.id ? this.profiles.find(p => p.id === input.id) : undefined;
    if (input.id && !existing) throw new Error('环境不存在。');
    const profile = validateProfile(input, existing, this.nodes.map(n => n.id));
    this.saveProfiles(existing ? this.profiles.map(p => p.id === profile.id ? profile : p) : [...this.profiles, profile]);
    return profile;
  }

  duplicateProfile(id) {
    const original = this.profile(id);
    const copy = validateProfile({ ...original, engine: original.engine || 'electron', id: undefined, fingerprintSeed: undefined, name: `${original.name.slice(0, 72)} · 副本` }, undefined, this.nodes.map(n => n.id));
    this.saveProfiles([...this.profiles, copy]);
    return copy;
  }

  profile(id) {
    const profile = this.profiles.find(p => p.id === id);
    if (!profile) throw new Error('环境不存在。');
    return profile;
  }

  importSubscription({ name, url, host, proxies, id }) {
    const subscriptionId = id || randomUUID();
    const old = id && this.subscriptions.find(s => s.id === id);
    if (id && !old) throw new Error('订阅不存在。');
    if (!id && url && this.subscriptions.some(s => s.url === url)) throw new Error('此订阅已导入，请刷新现有订阅。');
    const cleanName = String(name || host || '本地订阅').trim().slice(0, 80);
    const nodes = proxies.map(raw => ({
      id: createHash('sha256').update(`${subscriptionId}\0${raw.name}`).digest('hex').slice(0, 32),
      subscriptionId, name: raw.name, type: raw.type, countryCode: guessCountry(raw.name), raw
    }));
    const record = { id: subscriptionId, name: cleanName, url: url || '', host, nodeCount: nodes.length, updatedAt: new Date().toISOString() };
    const subscriptions = old ? this.subscriptions.map(s => s.id === subscriptionId ? record : s) : [...this.subscriptions, record];
    this.saveVault(subscriptions, [...this.nodes.filter(n => n.subscriptionId !== subscriptionId), ...nodes]);
  }

  deleteSubscription(id) {
    if (!this.subscriptions.some(s => s.id === id)) throw new Error('订阅不存在。');
    const referenced = new Set(this.profiles.map(p => p.nodeId));
    if (this.nodes.some(n => n.subscriptionId === id && referenced.has(n.id)))
      throw new Error('有环境正在使用此订阅的节点。请先在环境设置中更换节点。');
    this.saveVault(this.subscriptions.filter(s => s.id !== id), this.nodes.filter(n => n.subscriptionId !== id));
  }
}

module.exports = { Store };
