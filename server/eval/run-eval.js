/* ============================================================
   流量总台 · 内容生产线 — 评测跑分器 (D5)
   逐条调用 engines 真实函数, 产出 eval-report.json / eval-report.md。
   口径: DOC-08 §4.1 五指标。退出码: 达标 0 / 不达标 1。
   用法: node run-eval.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const engines = require('../engines');
const { RULES, SEMANTIC_WORDS, THRESHOLDS } = require('./eval-config');

const set = fs.readFileSync(path.join(__dirname, 'eval-set.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const report = {
  evalSetVersion: 'v1.0', engine: 'server/engines.js', date: '2026-09-10',
  total: set.length, byKind: {}, metrics: {}, fails: [],
};

/* ---------- 1) 像你度 ---------- */
const voicePos = set.filter((s) => s.kind === 'voice' && !s.expect.negative);
const voiceNeg = set.filter((s) => s.kind === 'voice' && s.expect.negative);
const posScores = voicePos.map((s) => engines.likeness(s.text, s.voiceSamples));
const negScores = voiceNeg.map((s) => engines.likeness(s.text, s.voiceSamples));
const posMean = Math.round(posScores.reduce((a, b) => a + b, 0) / posScores.length * 10) / 10;
const posPass = posScores.filter((x) => x >= THRESHOLDS.likenessMin).length;
const negCorrect = negScores.filter((x) => x < THRESHOLDS.likenessMin).length;
voicePos.forEach((s, i) => { if (posScores[i] < THRESHOLDS.likenessMin) report.fails.push({ id: s.id, metric: 'likeness-gate', got: posScores[i] }); });
voiceNeg.forEach((s, i) => { if (negScores[i] >= THRESHOLDS.likenessMin) report.fails.push({ id: s.id, metric: 'likeness-negative-leak', got: negScores[i] }); });
report.metrics.likeness = {
  positiveCount: posScores.length, positiveMean: posMean, gatePass: posPass, gateRate: round3(posPass / posScores.length),
  negativeCount: negScores.length, negativeCorrect: negCorrect, negativeRate: round3(negCorrect / negScores.length),
  target: `单条≥${THRESHOLDS.likenessMin}, 均值≥${THRESHOLDS.likenessMeanMin}`,
  passMean: posMean >= THRESHOLDS.likenessMeanMin, passGate: posPass === posScores.length && negCorrect === negScores.length,
};

/* ---------- 2) 规则拦截率 (含变体) ---------- */
const comp = set.filter((s) => s.kind === 'compliance');
const must = comp.filter((s) => s.expect.mustIntercept);
const clean = comp.filter((s) => !s.expect.mustIntercept);
let intercepted = 0; const missIds = [];
must.forEach((s) => {
  const hits = engines.complianceScan(s.text, RULES);
  if (hits.length) intercepted++; else missIds.push(s.id);
});
let falseHit = 0; const falseIds = [];
clean.forEach((s) => {
  const hits = engines.complianceScan(s.text, RULES);
  if (hits.length) { falseHit++; falseIds.push({ id: s.id, words: hits.map((h) => h.word) }); }
});
const variants = must.filter((s) => s.variant);
let variantHit = 0;
variants.forEach((s) => { if (engines.complianceScan(s.text, RULES).length) variantHit++; });
report.metrics.intercept = {
  mustIntercept: must.length, intercepted, interceptRate: round3(intercepted / must.length),
  variantCount: variants.length, variantIntercepted: variantHit, variantRate: round3(variantHit / variants.length),
  cleanCount: clean.length, cleanFalseHits: falseHit, falseHitRate: round3(falseHit / clean.length),
  missedIds: missIds, falseHitIds: falseIds,
  target: '拦截率 100% (NFR-18), 干净样本零误拦',
  pass: intercepted === must.length && falseHit === 0,
};
if (missIds.length) missIds.forEach((id) => report.fails.push({ id, metric: 'intercept-miss' }));

/* ---------- 3) 语义复核捕获率 (漏检率口径 ≤1%) ---------- */
const sem = set.filter((s) => s.kind === 'semantic');
let semCaught = 0; const semMiss = [];
sem.forEach((s) => {
  const items = engines.semanticRiskScan(s.text, SEMANTIC_WORDS);
  if (items.length) semCaught++; else semMiss.push(s.id);
});
report.metrics.semantic = {
  count: sem.length, caught: semCaught, catchRate: round3(semCaught / sem.length),
  missRate: round3((sem.length - semCaught) / sem.length), missedIds: semMiss,
  target: '漏检率 ≤ 1% (NFR-18, 裁判词表口径)',
  pass: (sem.length - semCaught) / sem.length <= THRESHOLDS.missRateMax,
};
semMiss.forEach((id) => report.fails.push({ id, metric: 'semantic-miss' }));

/* ---------- 4) 原创度判定一致率 ---------- */
const orig = set.filter((s) => s.kind === 'originality');
let agree = 0; const disagree = [];
orig.forEach((s) => {
  const r = engines.originality(s.draft, s.source);
  const actualReject = !r.pass;
  if (actualReject === s.expect.reject) agree++;
  else disagree.push({ id: s.id, expectReject: s.expect.reject, overlapPct: r.overlapPct });
});
report.metrics.originality = {
  count: orig.length, agreed: agree, agreementRate: round3(agree / orig.length),
  disagree: disagree, thresholdPct: THRESHOLDS.originalityMax,
  target: '判定一致率 100% (重合率 ≤15% 通过)',
  pass: agree === orig.length,
};
disagree.forEach((d) => report.fails.push({ id: d.id, metric: 'originality-disagree' }));

/* ---------- 5) boundary: 不崩溃 + 确定性 ---------- */
const bounds = set.filter((s) => s.kind === 'boundary');
let noCrash = 0, deterministic = 0; const crashed = [];
bounds.forEach((s) => {
  try {
    const a = engines.likeness(s.text, s.voiceSamples);
    const b = engines.complianceScan(s.text, RULES);
    const c = engines.originality(s.text, s.draft || s.text);
    const a2 = engines.likeness(s.text, s.voiceSamples);
    if (typeof a === 'number' && Array.isArray(b) && c && typeof c.pass === 'boolean') noCrash++;
    else crashed.push({ id: s.id, reason: '返回类型异常' });
    if (a === a2) deterministic++; else crashed.push({ id: s.id, reason: '非确定性输出' });
  } catch (e) {
    crashed.push({ id: s.id, reason: e.message });
  }
});
report.metrics.boundary = {
  count: bounds.length, noCrash, deterministic,
  crashed, target: '极端输入不崩溃且输出确定',
  pass: noCrash === bounds.length && deterministic === bounds.length,
};

/* ---------- 汇总 ---------- */
set.forEach((s) => { report.byKind[s.kind] = (report.byKind[s.kind] || 0) + 1; });
report.overallPass = report.metrics.likeness.passMean && report.metrics.likeness.passGate
  && report.metrics.intercept.pass && report.metrics.semantic.pass
  && report.metrics.originality.pass && report.metrics.boundary.pass;
report.failCount = report.fails.length;

function round3(n) { return Math.round(n * 1000) / 1000; }
function pct(n) { return (n * 100).toFixed(1) + '%'; }

/* markdown 报告 */
const md = `# AI 质量评测基线报告 (D5)

- 评测集版本: ${report.evalSetVersion} · 引擎: ${report.engine} · 日期: ${report.date}
- 样本总数: ${report.total} (${Object.entries(report.byKind).map(([k, v]) => `${k} ${v}`).join(' / ')})
- 结论: **${report.overallPass ? '五指标全部达标' : '存在未达标项, 见下表与问题样本'}**

## 五指标对照 (DOC-08 §4.1 口径)

| 指标 | 实测 | 目标 | 结论 |
|---|---|---|---|
| 像你度均值(正样本) | ${report.metrics.likeness.positiveMean} | ≥ ${THRESHOLDS.likenessMeanMin} | ${report.metrics.likeness.passMean ? '达标' : '未达标'} |
| 像你度门禁(正≥90 且 负<90) | 正 ${report.metrics.likeness.gatePass}/${report.metrics.likeness.positiveCount} · 负 ${report.metrics.likeness.negativeCorrect}/${report.metrics.likeness.negativeCount} | 双 100% | ${report.metrics.likeness.passGate ? '达标' : '未达标'} |
| 规则拦截率(含变体) | ${pct(report.metrics.intercept.interceptRate)} (变体 ${pct(report.metrics.intercept.variantRate)}) | 100% | ${report.metrics.intercept.pass ? '达标' : '未达标'} |
| 语义复核漏检率 | ${pct(report.metrics.semantic.missRate)} | ≤ 1% | ${report.metrics.semantic.pass ? '达标' : '未达标'} |
| 原创度判定一致率 | ${pct(report.metrics.originality.agreementRate)} | 100% | ${report.metrics.originality.pass ? '达标' : '未达标'} |
| 边界输入健壮性 | 不崩溃 ${report.metrics.boundary.noCrash}/${report.metrics.boundary.count} · 确定 ${report.metrics.boundary.deterministic}/${report.metrics.boundary.count} | 双 100% | ${report.metrics.boundary.pass ? '达标' : '未达标'} |

## 明细

- 干净样本误拦: ${report.metrics.intercept.cleanFalseHits} 条${report.metrics.intercept.falseHitIds.length ? ' → ' + JSON.stringify(report.metrics.intercept.falseHitIds) : ''}
- 拦截漏网: ${JSON.stringify(report.metrics.intercept.missedIds)}
- 语义漏检样本: ${JSON.stringify(report.metrics.semantic.missedIds)}
- 原创度分歧样本: ${JSON.stringify(report.metrics.originality.disagree)}
- 边界异常样本: ${JSON.stringify(report.metrics.boundary.crashed)}
- 正样本像你度分布: min ${Math.min(...posScores)} / mean ${posMean} / max ${Math.max(...posScores)}

## 回归口径

触发条件: 提示词模板 / 模型版本 / 取材策略 / 温度参数任一变更 → CI 对本评测集全量重跑;
阻断规则: 像你度 / 拦截率 / 漏检率任一回退 > 2pp 阻断发布 (见 judge-config.yaml)。

## 扩展回路

生产中「重生后仍 <90%」「终审打回」的真实样本, 脱敏后经人工确认补入本评测集, 随系统使用持续生长。
`;

fs.writeFileSync(path.join(__dirname, 'eval-report.json'), JSON.stringify(report, null, 2), 'utf8');
fs.writeFileSync(path.join(__dirname, 'eval-report.md'), md, 'utf8');
console.log(md);
console.log('overall:', report.overallPass ? 'PASS' : 'FAIL', '| fails:', report.failCount);
process.exit(report.overallPass ? 0 : 1);
