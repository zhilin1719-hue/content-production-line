/* ============================================================
   isolation.test.js — 多项目隔离(跨项目一律 404, 强制基线)
   A 项目 token 访问 B 项目资源 → 404; 未授权项目参数 → 404
   ============================================================ */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

process.env.DATA_DIR = path.join(os.tmpdir(), 'cpl-test-iso-' + Date.now());
process.env.PORT = '0';
process.env.LLM_DELAY_MS = '1';

const seed = require('../seed');
const { start } = require('../server');

let BASE = '';
let closer = null;
let opToken = '', adminToken = '';

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

after(() => { if (closer) return closer(); });

test('setup: 播种 + 起服 + 登录(仅泽宇项目的 operator)', async () => {
  seed.seedAll({ reset: true });
  const s = await start();
  closer = s.close;
  BASE = `http://127.0.0.1:${s.port}`;
  const op = await api('POST', '/api/auth/login', { username: 'operator', password: 'op123' });
  assert.strictEqual(op.status, 200);
  opToken = op.data.token;
  assert.deepStrictEqual(op.data.projects, ['p-zeyu'], 'operator 仅授权泽宇项目');
  const admin = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  adminToken = admin.data.token;
});

test('隔离: 选题/稿件/场次/文案 跨项目资源一律 404', async () => {
  /* 岑晴川项目的种子资源: (method, path, body) */
  const cases = [
    ['GET', '/api/topics/tc1', undefined],
    ['POST', '/api/topics/tc1/discard', {}],
    ['POST', '/api/topics/tc1/restore', {}],
    ['POST', '/api/topics/tc1/ideas', {}],
    ['GET', '/api/drafts/d-seed-c1', undefined],
    ['POST', '/api/drafts/d-seed-c1/compliance', {}],
    ['POST', '/api/drafts/d-seed-c1/review', {}],
    ['GET', '/api/sessions/sc1', undefined],
    ['GET', '/api/sessions/sc1/course', undefined],
    ['GET', '/api/sessions/sc1/materials?day=D1', undefined],
    ['POST', '/api/sessions/sc1/course/1/generate', {}],
    ['POST', '/api/sessions/sc1/course/1/photo', {}],
    ['GET', '/api/moments/m-cenqc-notexist', undefined],
  ];
  for (const [method, p, body] of cases) {
    const r = await api(method, p, body, opToken);
    assert.strictEqual(r.status, 404, `${method} ${p} → 404`);
    assert.strictEqual(r.data.error.code, 'NOT_FOUND');
  }
});

test('隔离: 带 B 项目 projectId 的查询/创建一律 404', async () => {
  for (const [method, p, body] of [
    ['GET', '/api/topics?projectId=p-cenqc', undefined],
    ['GET', '/api/pools?projectId=p-cenqc', undefined],
    ['GET', '/api/sources?projectId=p-cenqc', undefined],
    ['GET', '/api/sessions?projectId=p-cenqc', undefined],
    ['GET', '/api/dashboard?projectId=p-cenqc', undefined],
    ['GET', '/api/audit?projectId=p-cenqc', undefined],
    ['POST', '/api/accounts', { projectId: 'p-cenqc', name: '越权账号' }],
    ['POST', '/api/sessions', { projectId: 'p-cenqc', title: '越权场次', warmStart: '2026-10-01' }],
    ['POST', '/api/moments/generate', { projectId: 'p-cenqc', poolId: 'ganhuo' }],
  ]) {
    const r = await api(method, p, body, opToken);
    assert.strictEqual(r.status, 404, `${method} ${p} → 404`);
  }
});

test('隔离: 管理员双项目可见, 同一资源 admin 可访问', async () => {
  const adminTopics = await api('GET', '/api/topics?projectId=p-cenqc', undefined, adminToken);
  assert.strictEqual(adminTopics.status, 200);
  assert.ok(adminTopics.data.list.length >= 1, 'admin 可见岑晴川选题');

  const adminOne = await api('GET', '/api/topics/tc1', undefined, adminToken);
  assert.strictEqual(adminOne.status, 200);

  const opOne = await api('GET', '/api/topics/tc1', undefined, opToken);
  assert.strictEqual(opOne.status, 404, 'operator 访问同资源 404');
});

test('隔离: operator 写岑晴川选题 → 404 而非 403(越权口径统一)', async () => {
  const r = await api('POST', '/api/topics/tc2/discard', {}, opToken);
  assert.strictEqual(r.status, 404);
  const r2 = await api('POST', '/api/topics/tc2/ideas', {}, opToken);
  assert.strictEqual(r2.status, 404);
  const adminCheck = await api('GET', '/api/topics/tc2', undefined, adminToken);
  assert.strictEqual(adminCheck.status, 200, '资源本身存在');
  assert.strictEqual(adminCheck.data.topic.status, '选题', '未被越权修改');
});

test('项目列表按授权过滤', async () => {
  const opList = await api('GET', '/api/projects', undefined, opToken);
  assert.strictEqual(opList.data.projects.length, 1);
  const adminList = await api('GET', '/api/projects', undefined, adminToken);
  assert.strictEqual(adminList.data.projects.length, 2);
});
