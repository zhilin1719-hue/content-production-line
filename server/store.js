/* ============================================================
   流量总台 · 内容生产线 — JSON 文件持久化
   server/data/*.json (DATA_DIR 可覆盖)
   写盘防抖(50ms) + 原子写(临时文件 + rename)
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const CONFIG = require('./config');

const DIR = CONFIG.DATA_DIR;
const cache = Object.create(null);
const dirty = new Set();
const timers = Object.create(null);

function fileOf(name) { return path.join(DIR, name + '.json'); }

function load(name, fallback) {
  if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name];
  let v = fallback !== undefined ? fallback : null;
  try {
    v = JSON.parse(fs.readFileSync(fileOf(name), 'utf8'));
  } catch (e) { /* 不存在或损坏 → 用 fallback */ }
  cache[name] = v;
  return v;
}

function get(name, fallback) {
  if (Object.prototype.hasOwnProperty.call(cache, name)) return cache[name];
  return load(name, fallback !== undefined ? fallback : null);
}

function set(name, value) {
  cache[name] = value;
  dirty.add(name);
  if (!timers[name]) {
    timers[name] = setTimeout(() => { delete timers[name]; flush(name); }, CONFIG.WRITE_DEBOUNCE_MS);
    if (typeof timers[name].unref === 'function') timers[name].unref();
  }
  return value;
}

/** 原子写单集合 */
function flush(name) {
  if (!dirty.has(name)) return;
  const tmp = fileOf(name) + '.tmp';
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(cache[name], null, 1), 'utf8');
  fs.renameSync(tmp, fileOf(name));
  dirty.delete(name);
}

function flushAll() {
  for (const name of [...dirty]) flush(name);
}

/** 清空数据目录并重置内存缓存(种子重置用) */
function resetDir() {
  for (const name of Object.keys(timers)) { clearTimeout(timers[name]); delete timers[name]; }
  for (const k of Object.keys(cache)) delete cache[k];
  dirty.clear();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
}

process.on('exit', () => { try { flushAll(); } catch (e) { /* 尽力而为 */ } });

module.exports = { get, set, flush, flushAll, resetDir, DATA_DIR: DIR };
