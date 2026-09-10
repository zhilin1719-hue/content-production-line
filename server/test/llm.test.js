/* ============================================================
   llm.test.js — LLM 网关测试: 主备切换(NFR-12) + token 记账(NFR-14)
   ============================================================ */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

process.env.DATA_DIR = path.join(os.tmpdir(), 'cpl-test-llm-' + Date.now());
process.env.LLM_DELAY_MS = '1';

const gateway = require('../llm-gateway');

const VARS = { topic: { newTitle: '低客单不是引流, 是内耗', srcTitle: '对标原文' } };

test('providers: 主备双供应商配置', () => {
  assert.strictEqual(gateway.providers.primary.name, 'demo-primary');
  assert.strictEqual(gateway.providers.primary.model, 'voiceprint-v2');
  assert.ok(gateway.providers.backup.name);
  assert.notStrictEqual(gateway.providers.backup.name, gateway.providers.primary.name);
});

test('loadPrompt: 从 prompts/ 加载 P-01~P-08, 缺失时用内置 fallback', () => {
  for (let i = 1; i <= 8; i++) {
    const key = 'P-0' + i;
    const tpl = gateway.loadPrompt(key);
    assert.ok(tpl.length > 20, `${key} 模板非空`);
    assert.ok(tpl.includes('{{'), `${key} 含 {{变量}} 占位`);
  }
  assert.ok(gateway.loadPrompt('P-99').length > 0, '未知 key 走 fallback');
});

test('renderPrompt: {{变量}} 渲染与缺失变量兜底', () => {
  const out = gateway.renderPrompt('选题: {{topic}} / 理念: {{idea}}', { topic: 'X', idea: null });
  assert.strictEqual(out, '选题: X / 理念: ');
});

test('call: 正常走主供应商', async () => {
  delete process.env.LLM_PROVIDER;
  const r = await gateway.call('P-02', VARS, { projectId: 'p-test' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.provider, 'demo-primary');
  assert.strictEqual(r.promptKey, 'P-02');
  assert.ok(Array.isArray(r.result) && r.result.length === 2, 'P-02 → 2 套框架');
  assert.ok(r.tokens > 0);
});

test('call: LLM_PROVIDER=fail 注入主供应商故障 → 自动切备(NFR-12)', async () => {
  process.env.LLM_PROVIDER = 'fail';
  const before = gateway.getTokenUsage().failovers || 0;
  const r = await gateway.call('P-02', VARS, { projectId: 'p-test' });
  assert.strictEqual(r.provider, 'demo-backup', '应自动切换到备用供应商');
  assert.ok(r.ok);
  assert.ok(gateway.getTokenUsage().failovers >= before + 1, 'failover 计数累加');
  delete process.env.LLM_PROVIDER;
  const r2 = await gateway.call('P-02', VARS, { projectId: 'p-test' });
  assert.strictEqual(r2.provider, 'demo-primary', '故障解除后回到主供应商');
});

test('call: 主备全挂 → 抛 LLM_ALL_PROVIDERS_FAILED', async () => {
  process.env.LLM_PROVIDER = 'fail-all';
  await assert.rejects(() => gateway.call('P-02', VARS, {}), (e) => e.code === 'LLM_ALL_PROVIDERS_FAILED');
  delete process.env.LLM_PROVIDER;
});

test('token 记账: 按 promptKey 与项目累加(NFR-14)', async () => {
  gateway.resetUsage();
  const u0 = gateway.getTokenUsage();
  assert.strictEqual((u0.byPrompt['P-01'] || { calls: 0 }).calls, 0);
  await gateway.call('P-01', { topic: VARS.topic, ideas: undefined }, { projectId: 'p-test' });
  const u1 = gateway.getTokenUsage();
  assert.strictEqual(u1.byPrompt['P-01'].calls, 1);
  assert.ok(u1.byPrompt['P-01'].tokens > 0, 'tokens = 字符数/4 估算');
  assert.strictEqual(u1.byProject['p-test'].calls, 1);
  await gateway.call('P-01', { topic: VARS.topic, ideas: undefined }, { projectId: 'p-test' });
  const u2 = gateway.getTokenUsage();
  assert.strictEqual(u2.byPrompt['P-01'].calls, 2, '调用次数累加');
  assert.ok(u2.byPrompt['P-01'].tokens > u1.byPrompt['P-01'].tokens, 'token 累加');
  assert.strictEqual(u2.byProject['p-test'].calls, 2);
  /* token 估算口径: ≈ (prompt+output) 字符 / 4 */
  const r = await gateway.call('P-02', VARS, { projectId: 'p-test' });
  const expectTokens = Math.ceil((r.prompt.length + JSON.stringify(r.result).length) / 4);
  assert.ok(Math.abs(r.tokens - expectTokens) <= 1, `tokens 口径: ${r.tokens} ≈ ${expectTokens}`);
});
