/* ============================================================
   流量总台 · 内容生产线 — LLM 网关
   主备双供应商(NFR-12) / 提示词加载(prompts/*.md.txt, {{变量}}) /
   token 成本记账(NFR-14, 按字符/4 估算) / 模拟延迟 200-600ms
   环境变量:
     LLM_PROVIDER=fail      → 注入主供应商故障, 验证自动切备
     LLM_PROVIDER=fail-all  → 主备全挂(抛 LLM_ALL_PROVIDERS_FAILED)
     LLM_DELAY_MS=n         → 覆盖模拟延迟(测试加速用)
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const engines = require('./engines');
const store = require('./store');
const CONFIG = require('./config');

const providers = {
  primary: { name: 'demo-primary', model: 'voiceprint-v2' },
  backup: { name: 'demo-backup', model: 'voiceprint-v2-backup' },
};

/* ---------- 提示词: 文件优先, 无文件用内置 fallback ---------- */
const BUILTIN_PROMPTS = {
  'P-01': '你是资深内容操盘手。基于对标爆款换理念, 输出 3 个改编选题方向。\n对标选题: {{topic}}\n理念库: {{ideas}}\n输出: 3 个方向, 每个含 tag/title/desc。',
  'P-02': '你是内容架构师。为选题生成 2 套内容框架(冲突递进 / 案例实证)。\n选题: {{topic}}\n输出: 2 套框架, 每套含 tag/title/desc。',
  'P-03': '你是口播稿写手。按选定理念与框架写口播初稿, 必须贴合主讲声纹。\n选题: {{topic}}\n理念: {{idea}}\n框架: {{frame}}\n声纹: {{voice}}\n输出: 口播初稿全文。',
  'P-04': '你是朋友圈文案引擎。按池子配比取材, 用主讲口吻写一条朋友圈。\n素材池: {{pool}}\n场景: {{scene}}\n声纹: {{voice}}\n输出: 朋友圈文案。',
  'P-05': '你是公开课预热物料引擎。为场次生成三渠道物料(朋友圈/私信/海报)。\n场次: {{session}}\n预热日: {{day}}\n输出: pyq/dm/poster 三渠道, 每渠道多变体。',
  'P-06': '你是公开课正文引擎。写第 {{day}} 天正课正文。\n场次: {{session}}\n输出: 正课正文全文。',
  'P-07': '你是合规复核引擎(第二层)。检测原创度与语义风险。\n稿件: {{draft}}\n对标原文: {{source}}\n输出: 通过/打回 + 理由。',
  'P-08': '你是选题改编引擎。扫描对标账号新爆款, 生成候选选题并评估理念相关度。\n对标账号: {{account}}\n输出: 1-2 条候选(含相关度)。',
};

function loadPrompt(promptKey) {
  const file = path.join(CONFIG.PROMPTS_DIR, promptKey + '.md.txt');
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return BUILTIN_PROMPTS[promptKey] || '完成任务: {{task}}'; }
}

/** 渲染 {{变量}} 占位(缺失变量替换为空串) */
function renderPrompt(tpl, vars) {
  return String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
}

/* ---------- promptKey → engines 生成函数映射 ---------- */
const ENGINE_MAP = {
  'P-01': (v) => engines.generateIdeaOptions(v.topic, v.ideas),
  'P-02': (v) => engines.generateFrames(v.topic),
  'P-03': (v) => engines.generateDraft(v.topic, v.idea, v.frame, v.voice),
  'P-04': (v) => engines.generateMoment(v.pool, v.scene, v.voice),
  'P-05': (v) => engines.generateMaterials(v.session, v.day),
  'P-06': (v) => engines.generateCourseBody(v.session, v.day),
  'P-07': (v) => engines.reviewDraft(v.draft, v.source, v.rules, v.riskWords),
  'P-08': (v) => engines.generateTopicCandidates(v.account, v.opts),
};

/* ---------- token 记账(NFR-14) ---------- */
let usage = null;
function ensureUsage() {
  if (usage) return usage;
  const saved = store.get('costs', null);
  usage = saved && typeof saved === 'object'
    ? Object.assign({ byPrompt: {}, byProject: {}, failovers: 0 }, saved)
    : { byPrompt: {}, byProject: {}, failovers: 0 };
  return usage;
}
function getTokenUsage() {
  ensureUsage();
  return JSON.parse(JSON.stringify(usage));
}
function resetUsage() {
  usage = { byPrompt: {}, byProject: {}, failovers: 0 };
  store.set('costs', usage);
}
function outputSize(result) {
  if (result == null) return 0;
  if (typeof result === 'string') return result.length;
  try { return JSON.stringify(result).length; } catch (e) { return 0; }
}
function recordUsage(promptKey, ctx, tokens, providerName) {
  ensureUsage();
  const p = usage.byPrompt[promptKey] || (usage.byPrompt[promptKey] = { calls: 0, tokens: 0 });
  p.calls += 1; p.tokens += tokens;
  if (ctx && ctx.projectId) {
    const pj = usage.byProject[ctx.projectId] || (usage.byProject[ctx.projectId] = { calls: 0, tokens: 0, byPrompt: {} });
    pj.calls += 1; pj.tokens += tokens;
    const pp = pj.byPrompt[promptKey] || (pj.byPrompt[promptKey] = { calls: 0, tokens: 0 });
    pp.calls += 1; pp.tokens += tokens;
  }
  usage.lastProvider = providerName;
  store.set('costs', usage);
}

function delayMs() {
  if (CONFIG.LLM.delayOverride !== null && !Number.isNaN(CONFIG.LLM.delayOverride)) return Math.max(0, CONFIG.LLM.delayOverride);
  return CONFIG.LLM.delayMinMs + Math.floor(Math.random() * (CONFIG.LLM.delayMaxMs - CONFIG.LLM.delayMinMs + 1));
}

/**
 * 调用生成。成功返回:
 *   { ok, provider, model, promptKey, tokens, latencyMs, result, prompt }
 * 主备全挂抛错 code=LLM_ALL_PROVIDERS_FAILED。
 */
async function call(promptKey, vars, ctx) {
  const tpl = loadPrompt(promptKey);
  const prompt = renderPrompt(tpl, vars || {});
  const order = ['primary', 'backup'];
  let lastErr = null;

  for (const key of order) {
    const provider = providers[key];
    const mode = process.env.LLM_PROVIDER || '';
    const failed = mode === 'fail-all' || (mode === 'fail' && key === 'primary');
    if (failed) {
      lastErr = new Error('PROVIDER_FAILED:' + provider.name);
      if (key === 'primary') { ensureUsage(); usage.failovers += 1; store.set('costs', usage); }
      continue; /* NFR-12: 自动切备 */
    }
    const t0 = Date.now();
    const wait = delayMs();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const fn = ENGINE_MAP[promptKey];
    if (!fn) { const err = new Error('UNKNOWN_PROMPT_KEY:' + promptKey); err.code = 'UNKNOWN_PROMPT_KEY'; throw err; }
    const result = fn(vars || {});
    const tokens = Math.ceil((prompt.length + outputSize(result)) * CONFIG.LLM.tokensPerChar); /* 字符数/4 */
    recordUsage(promptKey, ctx, tokens, provider.name);
    return { ok: true, provider: provider.name, model: provider.model, promptKey, tokens, latencyMs: Date.now() - t0, result, prompt };
  }
  const err = new Error('LLM_ALL_PROVIDERS_FAILED');
  err.code = 'LLM_ALL_PROVIDERS_FAILED';
  throw err;
}

module.exports = { providers, call, loadPrompt, renderPrompt, getTokenUsage, resetUsage, BUILTIN_PROMPTS, ENGINE_MAP };
