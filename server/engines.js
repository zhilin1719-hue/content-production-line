/* ============================================================
   流量总台 · 内容生产线 — 纯业务引擎 (合同交付物 D2)
   无 HTTP / 无 IO 依赖, 供测试与评测脚本 require。
   所有生成类函数均为确定性算法: 同输入 → 同输出。
   评测契约: 以下导出签名不可更改。
   ============================================================ */
'use strict';

/* ==================== 基础工具 ==================== */

/** 全角→半角、去空白/标点/emoji (合规变体拦截用, DOC-08 §3.1) */
function normalizeText(text) {
  let s = String(text == null ? '' : text);
  try { s = s.normalize('NFKC'); } catch (e) { /* 老引擎兜底: 手工映射全角空格 */ s = s.replace(/\u3000/g, ' '); }
  s = s.toLowerCase();
  // \p{Z} 空白类(含全角空格) / \p{P} 标点 / \p{S} 符号(含 emoji) / \p{M} 组合符 / \p{C} 控制与格式符(含 ZWJ)
  s = s.replace(/[\p{Z}\p{P}\p{S}\p{M}\p{C}]/gu, '');
  return s;
}

function round1(n) { return Math.round(n * 10) / 10; }
function hashStr(s) { let x = 5381; for (const c of String(s)) x = ((x * 33) ^ c.charCodeAt(0)) >>> 0; return x >>> 0; }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==================== 日期工具 (UTC, 纯字符串 YYYY-MM-DD) ==================== */
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseISO(iso) {
  const s = String(iso || '');
  if (!ISO_RE.test(s)) throw new Error('INVALID_DATE: ' + s);
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) throw new Error('INVALID_DATE: ' + s);
  return d;
}
function addDaysISO(iso, n) {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ==================== 合规 · 第一层: 规则库扫描 (FR-A7) ==================== */

/** 规则命中(基于 normalizeText 匹配, 变体拦截: 全角/emoji 插入/半角空格) */
function complianceScan(text, rules) {
  const hay = normalizeText(text);
  const hits = [];
  for (const r of (rules || [])) {
    if (!r || !r.word) continue;
    const needle = normalizeText(r.word);
    if (!needle) continue;
    let idx = 0, count = 0;
    while ((idx = hay.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
    if (count > 0) hits.push({ word: r.word, type: r.type, fix: r.fix, count });
  }
  return hits;
}

/** 容错正则: 允许规则词字符之间插入 0-3 个空白/标点/符号(变体拦截) */
function tolerantRegExp(word) {
  const esc = String(word).split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(esc.join('[\\s\\p{Z}\\p{P}\\p{S}\\p{M}]{0,3}'), 'gu');
}

/** 按 fix/repl 映射执行替换(最好→更适合大多数人、第一→头部 等)。
    返回 { text, applied:[{word, repl, count}], remaining: 重扫结果 } */
function applyRuleFixes(text, rules) {
  let out = String(text == null ? '' : text);
  const applied = [];
  const ordered = [...(rules || [])].filter((r) => r && r.word && typeof r.repl === 'string')
    .sort((a, b) => b.word.length - a.word.length);
  for (const r of ordered) {
    const re = tolerantRegExp(r.word);
    const before = out;
    out = out.replace(re, r.repl);
    const count = countDiff(before, out, r);
    if (count > 0) applied.push({ word: r.word, repl: r.repl, count });
  }
  return { text: out, applied, remaining: complianceScan(out, rules) };
}
function countDiff(before, after, rule) {
  // 替换次数按「替换前命中次数」口径统计(变体亦计入)
  const re = tolerantRegExp(rule.word);
  const m = before.match(re);
  return m ? m.length : 0;
}

/* ==================== 原创度检测 (FR-A7 第二层) ==================== */

/** 连续 8 字重合片段占比(清洗后 n-gram)。
    返回 { ratio(0-1), overlapPct(保留1位), pass(≤0.15) } */
function originality(draft, source) {
  const a = normalizeText(draft);
  const b = normalizeText(source);
  const N = 8;
  if (!a.length || !b.length || a.length < N) return { ratio: 0, overlapPct: 0, pass: true };
  const grams = new Set();
  for (let i = 0; i + N <= b.length; i++) grams.add(b.substr(i, N));
  let hit = 0;
  const total = a.length - N + 1;
  for (let i = 0; i + N <= a.length; i++) if (grams.has(a.substr(i, N))) hit++;
  const ratio = hit / total;
  return { ratio: Math.round(ratio * 10000) / 10000, overlapPct: round1(ratio * 100), pass: ratio <= 0.15 };
}

/* ==================== 像你度 (NFR-17) ==================== */

const DEFAULT_LEXICON = ['定价', '客单价', '高客单', '低客单', '结果', '系统', '结构', '筛选', '案例', '核验',
  '方法论', '私域', '成交', '锚点', '高净值', '朋友圈', '内耗', '报价', '专业', '收窄', '拆解',
  '人群', '流量', '变现', '生意', '简单', '稳定', '动作', '客户', '承诺'];
const DEFAULT_GOLDEN = [
  '定位选对, 客户会自己把你从人群里挑出来。',
  '你短缺的不是努力, 是把力气用对地方。',
  '敢报高价的人, 先过了自己心里那关。',
];
const DEFAULT_SAMPLE_TEXT = '你是不是也这样: 课越卖越便宜, 人越干越累?\n\n低客单不是引流, 是内耗。今天给你高客单定价的三段论:\n第一, 把价值锚点从「我的时间」换成「客户的结果」;\n第二, 用已核验的案例数字做结果承诺。\n\n评论区扣「定价」, 我把手册发你。';
const DEFAULT_CASE = { name: '岑晴川', domain: '别墅设计赛道', from: '2 万', to: '45 万', period: '两个月', deals: 10 };

function normalizeVoiceArg(voiceSamples) {
  if (!voiceSamples) return { lexicon: DEFAULT_LEXICON, golden: DEFAULT_GOLDEN, samples: [DEFAULT_SAMPLE_TEXT], cases: [DEFAULT_CASE], role: '顾问', leadMagnet: '《报价 10 倍手册》', hookWord: '定价' };
  if (Array.isArray(voiceSamples)) {
    const samples = voiceSamples.filter((s) => typeof s === 'string' && s.trim());
    return { lexicon: DEFAULT_LEXICON, golden: DEFAULT_GOLDEN, samples: samples.length ? samples : [DEFAULT_SAMPLE_TEXT], cases: [DEFAULT_CASE], role: '顾问', leadMagnet: '《报价 10 倍手册》', hookWord: '定价' };
  }
  if (typeof voiceSamples === 'object') {
    return {
      lexicon: Array.isArray(voiceSamples.lexicon) && voiceSamples.lexicon.length ? voiceSamples.lexicon : (Array.isArray(voiceSamples.lexicon) ? [] : DEFAULT_LEXICON),
      golden: Array.isArray(voiceSamples.golden) ? voiceSamples.golden : [],
      samples: Array.isArray(voiceSamples.samples) ? voiceSamples.samples.filter((s) => typeof s === 'string' && s.trim()) : [],
      cases: Array.isArray(voiceSamples.cases) && voiceSamples.cases.length ? voiceSamples.cases : [DEFAULT_CASE],
      role: voiceSamples.role || '顾问',
      leadMagnet: voiceSamples.leadMagnet || '《报价 10 倍手册》',
      hookWord: voiceSamples.hookWord || '定价',
    };
  }
  return { lexicon: DEFAULT_LEXICON, golden: DEFAULT_GOLDEN, samples: [DEFAULT_SAMPLE_TEXT], cases: [DEFAULT_CASE], role: '顾问', leadMagnet: '《报价 10 倍手册》', hookWord: '定价' };
}

const FEATURE_KEYS = ['shortSent', 'colon', 'semi', 'corner', 'enum', 'question', 'multiPara'];
function styleFeatures(text) {
  const raw = String(text || '');
  const sents = raw.split(/[。！？!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const avg = sents.length ? sents.reduce((x, s) => x + s.length, 0) / sents.length : 0;
  return {
    shortSent: avg > 0 && avg <= 42,
    colon: /[：:]/.test(raw),
    semi: /；/.test(raw),
    corner: /「/.test(raw),
    enum: /(一[、,，]|二[、,，]|三[、,，]|第[一二三1][、,，步]|①|②|1\.|2\.)/.test(raw),
    question: /[？?]/.test(raw),
    multiPara: /\n\s*\n/.test(raw) || raw.split(/\n+/).length >= 3,
  };
}

/** 像你度 0-100: 语义词表(60) + 句式特征(25) + 金句引用(15) 加权, 确定性算法 */
function likeness(text, voiceSamples) {
  const v = normalizeVoiceArg(voiceSamples);
  const raw = String(text == null ? '' : text);
  const norm = normalizeText(raw);
  if (!norm) return 0;

  /* 1) 语义词表: 每 100 字命中次数, 密度 ≥3 记满分 */
  let occ = 0;
  for (const w of v.lexicon) {
    if (!w) continue;
    let i = 0;
    while ((i = norm.indexOf(w, i)) !== -1) { occ++; i += w.length; }
  }
  const density = occ / Math.max(0.2, norm.length / 100);
  const sem = Math.min(1, density / 3) * 60;

  /* 2) 句式特征: 与声纹样本特征吻合度 + 平均句长接近度 */
  const corpus = v.samples.length ? v.samples.join('\n\n') : DEFAULT_SAMPLE_TEXT;
  const tf = styleFeatures(raw);
  const cf = styleFeatures(corpus);
  const present = FEATURE_KEYS.filter((k) => cf[k]);
  const agree = present.length ? present.filter((k) => tf[k]).length / present.length : 0.5;
  const sents = raw.split(/[。！？!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const avgLen = sents.length ? sents.reduce((x, s) => x + s.length, 0) / sents.length : 0;
  const cSents = corpus.split(/[。！？!?\n]+/).map((s) => s.trim()).filter(Boolean);
  const cAvg = cSents.length ? cSents.reduce((x, s) => x + s.length, 0) / cSents.length : 30;
  const lenClose = 1 - Math.min(1, Math.abs(avgLen - cAvg) / 45);
  const struct = (0.6 * agree + 0.4 * lenClose) * 25;

  /* 3) 金句引用: 完整引用 15 分, ≥5 字片段 10 分 */
  let golden = 0;
  for (const q of v.golden) {
    const nq = normalizeText(q);
    if (!nq) continue;
    if (norm.includes(nq)) { golden = 15; break; }
    if (nq.length >= 5 && norm.includes(nq.slice(0, 5))) golden = Math.max(golden, 10);
  }

  /* 4) 篇幅合理 10 分 */
  const lenScore = norm.length >= 25 ? 10 : norm.length / 2.5;

  return round1(Math.min(98, sem + struct + golden + lenScore));
}

/* ==================== 公域台 · 选题/理念/框架/初稿 ==================== */

function topicCore(topic) {
  const t = topic || {};
  const title = t.newTitle || t.srcTitle || '';
  const m = String(title).split(/[:：]/)[0];
  return String(m || title).trim() || '这个选题';
}
function topicKeyword(topic) {
  const t = topic || {};
  const s = String(t.newTitle || t.srcTitle || '');
  const after = s.split(/[:：]/)[1] || s;
  return String(after).replace(/[,，。;；、\s]/g, '').slice(0, 12) || '这个方向';
}
function trunc(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

/** 3 个改编选题方向(模板化生成, 确定性) */
function generateIdeaOptions(topic, ideas) {
  const lib = (Array.isArray(ideas) && ideas.length >= 3) ? ideas : DEFAULT_IDEAS;
  const core = topicCore(topic);
  const role = (topic && topic.role) || '顾问';
  const CN_NUM = ['一', '二', '三'];
  return lib.slice(0, 3).map((idea, i) => ({
    tag: `理念${CN_NUM[i] || (i + 1)} · ${idea.name}`,
    title: String(idea.titleTpl || '{pain}: {formula}')
      .replace('{pain}', core).replace('{formula}', idea.formula || '').replace('{role}', role),
    desc: `从「${trunc(topic && topic.srcTitle, 24)}」的叙事切入, 观点内核换成「${idea.name}」: ${idea.method || ''}。其余两个方向自动回收。`,
  }));
}

/** 2 套内容框架 */
function generateFrames(topic) {
  const core = topicCore(topic);
  const kw = topicKeyword(topic);
  return [
    { tag: '框架 A · 冲突递进', title: '钩子 → 冲突 → 展开 → 收尾', desc: `开头一句反常识钩住(「${core}」), 中段三层递进展开${kw}, 收尾落到方法论清单。` },
    { tag: '框架 B · 案例实证', title: '案例开场 → 拆解 → 迁移 → 行动指令', desc: `用一个已核验成交案例开场建立信任, 拆解${kw}的关键动作, 迁移到观众自己的业务, 收尾给评论指令。` },
  ];
}

/** 口播初稿(确定性模板生成, 结构随 frame 变化; 内含极限词供合规三层演示) */
function generateDraft(topic, idea, frame, voice) {
  const v = normalizeVoiceArg(voice);
  const t = topic || {};
  const pain = topicCore(t);
  const ideaTitle = (idea && idea.title) || t.newTitle || pain;
  const c = v.cases[0] || DEFAULT_CASE;
  const golden = v.golden[0] || DEFAULT_GOLDEN[0];
  const isB = /B/.test(String((frame && frame.tag) || (frame && frame.title) || 'A'));

  /* 声纹样本不足 → 降级为「通用口吻 + 人工润色」(PRD §4.6): 无金句、书面腔, 像你度必然低分触发 NFR-17 重生 */
  const degraded = voice && typeof voice === 'object' && !Array.isArray(voice)
    && (!voice.samples || !voice.samples.length)
    && (!voice.golden || !voice.golden.length)
    && (!voice.lexicon || !voice.lexicon.length);
  if (degraded) {
    return `尊敬的用户, 您好。\n\n基于我们的专业洞察, 针对您所关注的「${ideaTitle}」这一议题, 我们沉淀了一套可复用的方法论体系, 旨在通过结构化的交付链路, 系统性地赋能您的业务增长, 实现价值闭环的全方位构建。\n\n我们的服务体系具备以下核心优势:\n其一, 深度定制化的解决方案, 精准匹配您的业务诉求;\n其二, 全链路陪伴式交付, 确保成果的可验证性;\n其三, 持续迭代的运营支持, 助力长期主义的稳健发展。\n\n如需进一步了解, 欢迎通过官方渠道与我们取得联系, 获取完整的产品介绍资料。`;
  }

  if (isB) {
    return `先说一个案例: 我们客户${c.name}, ${c.domain}, ${c.period}把客单价从 ${c.from} 做到 ${c.to}, 签了 ${c.deals} 单。\n\n你可能会说, 这和我有什么关系? 关系就在「${pain}」——${ideaTitle}。\n\n拆开看, 最好的那批${v.role}只做对了三件事:\n第一, 报价按结果不按时间: 交付物写清楚, 数字可核验;\n第二, 定位收窄: 只服务付得起、也值得服务的人群;\n第三, 系统替代才华: 把交付做成结构, 不靠灵感。\n\n迁移到你自己的业务上, 今天就能做一步: 把你的报价单拍下来, 圈出所有「按时间收费」的条目, 换成「按结果交付」。\n\n${golden}\n\n想要${v.leadMagnet}的, 评论区扣「${v.hookWord}」, 我发你。`;
  }
  return `你是不是也这样: ${pain}?\n\n我见过最好的一个${v.role}, 专业没得说, 报价永远不敢往上提。结果呢, 客户不珍惜, 自己也耗干。\n\n${ideaTitle}。今天给你把结构拆开:\n第一, 把价值锚点从「我的时间」换成「客户的结果」;\n第二, 用已核验的案例数字做结果承诺, 而不是拍胸脯;\n第三, 设一道筛选门槛, 敢拒绝不合适的人。\n\n我们客户${c.name}, ${c.domain}, 把客单价从 ${c.from} 提到 ${c.to}, ${c.period}签了 ${c.deals} 单。这不是神话, 是结构。\n\n${golden}\n\n评论区扣「${v.hookWord}」, 我把${v.leadMagnet}发你。`;
}

/* ==================== 大模型复核 · 模拟语义风险 (FR-A7 第二层) ==================== */

function semanticRiskScan(text, riskWords) {
  const hay = normalizeText(text);
  const items = [];
  for (const r of (riskWords || [])) {
    if (!r || !r.word) continue;
    const needle = normalizeText(r.word);
    if (needle && hay.includes(needle)) items.push({ word: r.word, type: r.type });
  }
  return items;
}

/** 复合复核: 原创度 + 模拟语义风险 → 通过/打回 */
function reviewDraft(draft, source, rules, riskWords) {
  const orig = originality(draft, source);
  const risks = semanticRiskScan(draft, riskWords);
  const pass = orig.pass && risks.length === 0;
  const reasons = [];
  if (!orig.pass) reasons.push(`与对标原文连续 8 字重合率 ${orig.overlapPct}% 超过 15%`);
  if (risks.length) reasons.push(`语义风险词: ${risks.map((r) => r.word).join('、')}`);
  if (pass) reasons.push(`原创度 ${orig.overlapPct}% ≤ 15%, 未发现语义风险`);
  return { pass, verdict: pass ? '通过' : '打回', originality: orig, semanticRisk: { count: risks.length, items: risks }, reasons };
}

/* ==================== 朋友圈 · 取材与文案 ==================== */

const DEFAULT_MOMENT_VARIANTS = {
  ganhuo: [
    '高客单顾问和低客单顾问的区别, 不在专业, 在报价单的结构。\n\n低客单报价单写的是「我帮你做什么」;\n高客单报价单写的是「你能拿到什么结果」。\n\n同一个专业, 两种写法, 客单价差 20 倍。\n\n今天把这句话送给你: 你短缺的不是努力, 是把力气用对地方。',
    '很多人问我定价怎么定。\n\n先看你的客户在为什么付钱: 为时间, 还是为结果。\n\n为时间付钱, 你永远在跟同行卷单价;\n为结果付钱, 你在跟客户的目标对齐。\n\n定价三段论: 价值锚点 → 结果承诺 → 筛选门槛。明天展开讲。',
    '一个反直觉的事实: 涨价之后, 成交率反而可能变高。\n\n因为价格是筛选器, 不只是收入。\n低价格吸引来的是比价的人; 高价格吸引来的是要结果的人。\n\n后者好服务十倍。',
  ],
  anli: [
    '岑晴川找到我的时候, 别墅设计一单收 2 万, 忙得脚不沾地。\n\n我们只动了两处: 把报价从「按面积」改成「按结果」, 再加一道客户筛选。\n\n两个月, 客单价 45 万, 签了 10 单。\n\n数字都核对了, 在案例库里躺着。想看拆解的, 评论区扣 1。',
    '上周五复盘了一个案例: 疗愈赛道的学员, 把定位从「所有焦虑的人」收窄到「35+ 高压女高管」。\n\n听起来市场变小了, 实际成交率翻了三倍。\n\n定位越窄, 钩子越尖。',
  ],
  shenghuo: [
    '下午在球场打了九洞, 想明白一件事:\n\n打球和做生意一样, 动作越简单, 结果越稳定。\n\n回去把报价单又砍了一半的字。\n\n(配图是今天的第 7 洞)',
    '海边待了两天, 没带电脑。\n\n手机里最常住的还是备忘录, 想到一句记一句:\n「敢报高价的人, 先过了自己心里那关。」\n\n回来慢慢展开。',
  ],
  dianping: [
    '收到一条学员评价, 看完挺感慨:\n\n「定位选对, 客户会自己把你从人群里挑出来。」\n\n这话不是我说的, 是做完定位收窄的学员自己悟到的。\n\n好的方法论, 最后都长成了客户自己的话。',
  ],
  chengjiao: [
    '今天签了一单 45w 的年度顾问。\n\n对方说选我的原因很简单: 翻了我三个月朋友圈, 每一条都在讲同一件事。\n\n重复, 是高客单成交里最被低估的动作。',
  ],
  jushen: [
    '这周拒了 3 位想报名的朋友。\n\n不是端着, 是真的不合适: 业务模式还没到能承接高客单的阶段, 进来也是浪费钱。\n\n敢拒绝, 这门生意才做得长。',
  ],
};

function momentVariantsOf(pool) {
  if (!pool) return [];
  if (Array.isArray(pool.variants) && pool.variants.length) return pool.variants;
  if (typeof pool.id === 'string' && DEFAULT_MOMENT_VARIANTS[pool.id]) return DEFAULT_MOMENT_VARIANTS[pool.id];
  return [];
}

/** 朋友圈文案: 按池取材, 场景与池 id 决定确定性变体 */
function generateMoment(pool, scene, voice) {
  const variants = momentVariantsOf(pool);
  if (!variants.length) return '';
  const pid = (pool && pool.id) || 'pool';
  const idx = hashStr(pid + '|' + String(scene || '')) % variants.length;
  return String(variants[idx]);
}

/* ==================== 公开课 · 物料/正文/节奏/撞期 ==================== */

function fmtCn(iso) {
  const d = parseISO(iso);
  return `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日`;
}
function shortTitle(title) { return String(title || '').split(/[，,：:。:]/)[0].replace(/\s/g, ''); }

/** 场次节奏: 预热 3 天 + 正课 5 天 */
function sessionRhythm(warmStart) {
  const warm = parseISO(warmStart).toISOString().slice(0, 10);
  return {
    warmStart: warm,
    openDay: addDaysISO(warm, 3),
    endDay: addDaysISO(warm, 7),
    warmDays: ['D1', 'D2', 'D3'],
    courseDays: [1, 2, 3, 4, 5],
  };
}

/** 正课期区间交集检测: 返回冲突场次或 null(相切计为冲突) */
function checkClash(warmStart, existingSessions) {
  const r = sessionRhythm(warmStart);
  for (const s of (existingSessions || [])) {
    if (!s || !s.openDay) continue;
    if (s.status === '已收官') continue;
    const sStart = s.openDay;
    const sEnd = s.endDay || addDaysISO(s.openDay, 4);
    if (r.openDay <= sEnd && r.endDay >= sStart) return s;
  }
  return null;
}

/** 三渠道预热物料 {pyq, dm, poster}, 每渠道多变体 */
function generateMaterials(session, day) {
  const s = session || {};
  const title = s.title || '公开课';
  const host = s.host || '主讲';
  const open = fmtCn(s.openDay || addDaysISO(String(s.warmStart || '2026-01-01').slice(0, 10), 3));
  const short = shortTitle(title);
  const aud = s.audience || '目标人群';
  const hook = s.hook || '《高净值变现路线图》';
  const d = String(day || 'D1').toUpperCase();

  const pyqMap = {
    D1: [
      `${short}, 不是你一个人的困境。\n\n粉丝涨了, 咨询来了, 一到报价就冷场——问题不在流量, 在你的成交系统根本不存在。\n\n${open}开课, 我用 5 天把「${title}」拆开讲。\n想听的, 评论区扣 1, 拉你进群, 先领${hook}。`,
      `一个反常识的观察: 卡在百万的, 一直在追流量; 跑到千万的, 早就在修成交系统。\n\n${open}, 5 天公开课, 讲后者。\n\n扣 1 进群, 先领${hook}。`,
      `做${aud}这一行, 分水岭不在专业, 在系统。\n\n${open}起, 连续 5 天, 我把「${short}」的方法论完整过一遍。\n\n评论区扣 1, 进群先领${hook}。`,
    ],
    D2: [
      `昨天说「${short}」, 后台炸了。\n\n最多的留言: 我知道要卖贵的, 但不敢报。\n\n不敢报的本质, 是你心里没有「结果证据」。公开课第一天我会把已核验的案例数字摆出来讲。\n\n还没进群的, 扣 1。`,
      `距离公开课还有 2 天。\n\n今天透露一个课里会讲的判断: 高客单成交, 80% 发生在朋友圈, 不在直播间。\n\n直播间是见面, 朋友圈是过日子。\n\n扣 1 进群, 先领${hook}。`,
      `备课时翻到一条老笔记: 大多数人缺的不是方法, 是一个「被允许」的瞬间。\n\n${open}开课, 5 天, 每天解决一环。\n\n扣 1 进群。`,
    ],
    D3: [
      `明天开课。\n\n5 天的地图提前给你:\nD1 诊断你为什么卡住 → D2 到 D4 三把钥匙 → D5 一对一应用。\n\n带好自己的业务问题来, 别当观众。\n\n最后召集, 扣 1 进群。`,
      `开课前一天, 说个数据:\n\n往期学员里, 听完课 30 天内调高报价的占 71%。\n\n不是课神奇, 是大多数人只差一个「被允许」的瞬间。\n\n明天见。扣 1 进群。`,
      `最后 24 小时召集。\n\n「${title}」, ${open}早 9 点第一课。\n\n现在扣 1 还能进群, 附${hook}。`,
    ],
  };
  const dmMap = {
    D1: [
      `嗨 {称呼}, 看你也在做${aud}方向。\n\n${open}我有一场 5 天的公开课, 专门讲「${short}」这个坎, 不收费。\n\n想来的话扣 1, 我拉你进群, 先送你一份${hook}。`,
      `嗨 {称呼}, 冒昧打扰。\n\n你上次问到报价的问题, 正好公开课第一天就讲这个。\n\n扣 1 拉你进群, 附赠${hook}。`,
      `{称呼}, ${open}的公开课名单快满了。\n\n主题: ${title}。\n\n零门槛, 扣 1 留位, 进群先领${hook}。`,
    ],
    D2: [
      `{称呼}, 公开课倒计时 2 天。\n\n今天群里已经在发预热讨论: 你现在卡在哪个环节——报价、成交还是交付?\n\n扣 1 进群, 顺便把${hook}领了。`,
      `嗨 {称呼}, 提醒你一下: ${open}开课。\n\n如果你现在恰好卡在「${short}」, 这场课就是为你准备的。\n\n扣 1, 我给你留位置。`,
      `{称呼}, 群里今晚有一场预习讨论, 讲「为什么有流量不变现」。\n\n要不要来听? 扣 1 我拉你。`,
    ],
    D3: [
      `{称呼}, 明天就开课了, 最后确认一次:\n\n5 天安排: 诊断 → 三把钥匙 → 一对一应用。\n\n今晚 8 点前扣 1, 还能进。`,
      `嗨 {称呼}, 明早 9 点第一课。\n\n建议你现在就把「最想解决的一个问题」写下来, D5 有一对一环节。\n\n扣 1 进群。`,
      `{称呼}, 最后召集: 明天开课。\n\n现在扣 1, 进群还能领${hook}。`,
    ],
  };
  const posterMap = {
    D1: [
      { title: short, sub: `${title} · 5 天直播`, proof: `主讲: ${host}`, cta: `扫码领取${hook}` },
      { title: '有流量, 却卡在变现?', sub: `5 天修一套自己的成交系统`, proof: `主讲: ${host}`, cta: '扫码进群 · 领取钩子资料包' },
      { title: `${short}的下半场比赛`, sub: '从追流量, 到修系统 · 5 天公开课', proof: `案例全部经数字核验`, cta: `扫码领取${hook}` },
    ],
    D2: [
      { title: '不敢报高价, 是因为没有结果证据', sub: `公开课 · 倒计时 2 天`, proof: `课内案例全部经数字核验`, cta: '扫码进群 · 领取资料包' },
      { title: '80% 的高客单成交, 发生在朋友圈', sub: `5 天公开课 · ${open}开课`, proof: `主讲: ${host}`, cta: `扫码领取${hook}` },
      { title: '报价单, 是你最该重写的一页', sub: `${short} · 倒计时 2 天`, proof: `往期学员复购率 71%`, cta: '扫码进群' },
    ],
    D3: [
      { title: '明天开课: 5 天, 修好你的成交系统', sub: '诊断 → 三把钥匙 → 一对一应用', proof: `往期学员 30 天内调价比例 71%`, cta: '最后召集 · 扫码进群' },
      { title: `明早 9 点: ${short}`, sub: `${title}`, proof: `主讲: ${host}`, cta: `扫码领${hook}` },
      { title: '最后 24 小时', sub: `5 天公开课 · 明早开课`, proof: `案例: 已核验成交数字`, cta: '扫码进群 · 先领资料' },
    ],
  };
  const key = pyqMap[d] ? d : 'D1';
  return {
    pyq: { name: '朋友圈文案', variants: pyqMap[key] },
    dm: { name: '私信话术', variants: dmMap[key] },
    poster: { name: '宣传海报', variants: posterMap[key] },
  };
}

/** 正课正文 */
function generateCourseBody(session, day) {
  const s = session || {};
  const n = Number(day) || 1;
  const themes = Array.isArray(s.courseThemes) ? s.courseThemes : null;
  const theme = (themes && themes[n - 1]) || `第 ${n} 天: 把「${shortTitle(s.title)}」拆到可执行`;
  const hook = s.hook || '《高净值变现路线图》';
  return `【公开课 D${n} 正文 · 演示稿】\n\n${theme}\n\n开场先把问题钉死: 你不是不努力, 是努力的方向上没有系统。今天这一天, 只解决一件事——把「${hook}」里的动作, 落到你自己的业务上。\n\n三步走:\n一、对照昨天的内容, 找出你卡住的那一环;\n二、用今天的框架把它拆开, 每一步都有可核验的数字;\n三、今晚 8 点前在群里交作业, 明早我逐条批。\n\n听完了别只点头, 动手才算数。钩子文件群里自取。`;
}

/* ==================== 对标扫描 · 模拟选题候选 ==================== */

const SCAN_TEMPLATES = [
  { src: '为什么我劝你别再做{X}: 一个从业者的血泪复盘', neu: '{X}不是引流, 是内耗: 把结构拆开看' },
  { src: '从月销 30 万到 300 万, 她只改了一行报价单', neu: '报价单上的那一行: 把「卖时间」改成「卖结果」' },
  { src: '别再卷流量了, 高净值客户根本不在直播间', neu: '高净值客户在哪: 三个不在公域的成交场' },
  { src: '一个人做{X}, 怎么年入千万还不累死', neu: '千万级一人公司的背面: SOP 比才华重要' },
  { src: '{X}的底层逻辑: 不是发广告, 是养信任', neu: '信任账户: 每天存一点, 成交时一次取' },
];

/** 模拟扫描: 生成 1-2 条候选(相关度随机, 同 seed 确定性) */
function generateTopicCandidates(account, opts) {
  const o = opts || {};
  const count = Math.max(1, Math.min(2, Number(o.count) || 2));
  const rnd = mulberry32(hashStr(String(o.seed == null ? 1 : o.seed) + '|' + String((account && account.id) || '')));
  const track = (account && account.track) || '商业IP赛道';
  const x = track.includes('设计') ? '别墅设计' : track.includes('创业') ? '创业服务' : '知识付费';
  const out = [];
  for (let i = 0; i < count; i++) {
    const tpl = SCAN_TEMPLATES[Math.floor(rnd() * SCAN_TEMPLATES.length)];
    const rel = 25 + Math.floor(rnd() * 71); // 25-95
    const srcLikes = 8000 + Math.floor(rnd() * 50000);
    out.push({
      srcTitle: tpl.src.replace('{X}', x),
      srcLikes,
      srcTime: '刚刚',
      srcAcct: (account && account.name) || '对标账号',
      newTitle: tpl.neu.replace('{X}', x),
      rel,
    });
  }
  return out;
}

/* ==================== 状态机(表驱动) ==================== */

const TOPIC_STATES = ['已筛除', '选题', '已出稿', '已淘汰'];
const TOPIC_TRANSITIONS = {
  '选题':   { discard: '已淘汰', publish: '已出稿' },
  '已淘汰': { restore: '选题' },
  '已出稿': {},
  '已筛除': {},
};

const MATERIAL_STATES = ['未发', '已发'];
const MATERIAL_TRANSITIONS = {
  '未发': { publish: '已发' },
  '已发': {},
};

const SESSION_STATES = ['筹备中', '预热中', '正课中', '已收官'];
const SESSION_TRANSITIONS = {
  '筹备中': { start: '预热中' },
  '预热中': { open: '正课中' },
  '正课中': { close: '已收官' },
  '已收官': {},
};

const DRAFT_STATES = ['初稿', '复核通过', '打回', '合规过审版'];
const DRAFT_TRANSITIONS = {
  '初稿':   { reviewPass: '复核通过', reviewReject: '打回', revise: '初稿' },
  '复核通过': { finalPass: '合规过审版', finalReject: '打回' },
  '打回':   { revise: '初稿' },
  '合规过审版': {},
};

function makeCan(TRANSITIONS) {
  return function can(from, action) {
    return !!(TRANSITIONS[from] && TRANSITIONS[from][action]);
  };
}
function makeTransition(name, TRANSITIONS) {
  return function transition(from, action) {
    const to = TRANSITIONS[from] && TRANSITIONS[from][action];
    if (!to) throw new Error(`INVALID_${name}_TRANSITION: ${from} --${action}-->`);
    return to;
  };
}

const canTopicTransition = makeCan(TOPIC_TRANSITIONS);
const transitionTopic = makeTransition('TOPIC', TOPIC_TRANSITIONS);
const canMaterialTransition = makeCan(MATERIAL_TRANSITIONS);
const transitionMaterial = makeTransition('MATERIAL', MATERIAL_TRANSITIONS);
const canSessionTransition = makeCan(SESSION_TRANSITIONS);
const transitionSession = makeTransition('SESSION', SESSION_TRANSITIONS);
const canDraftTransition = makeCan(DRAFT_TRANSITIONS);
const transitionDraft = makeTransition('DRAFT', DRAFT_TRANSITIONS);

/* ==================== 默认理念库(引擎独立运行时兜底) ==================== */
const DEFAULT_IDEAS = [
  { name: '反内耗', formula: '定价三段论', method: '价值锚点 → 结果承诺 → 筛选门槛', titleTpl: '{pain}: {formula}' },
  { name: '卖结果', formula: '按结果定价', method: '已核验案例数字做支撑', titleTpl: '客户不为你的时间付钱, 只为结果付钱' },
  { name: '筛选', formula: '挑客户方法论', method: '把「挑客户」讲成方法论', titleTpl: '敢拒绝的{role}, 才配得上高客单' },
];

module.exports = {
  /* 基础 */
  normalizeText, round1, hashStr, mulberry32, addDaysISO, parseISO,
  /* 合规第一层 */
  complianceScan, applyRuleFixes, tolerantRegExp,
  /* 原创度/像你度/复核 */
  originality, likeness, semanticRiskScan, reviewDraft,
  /* 公域台生成 */
  generateIdeaOptions, generateFrames, generateDraft, generateTopicCandidates,
  /* 朋友圈 */
  generateMoment, momentVariantsOf, DEFAULT_MOMENT_VARIANTS,
  /* 公开课 */
  generateMaterials, generateCourseBody, sessionRhythm, checkClash,
  /* 状态机 */
  TOPIC_STATES, TOPIC_TRANSITIONS, canTopicTransition, transitionTopic,
  MATERIAL_STATES, MATERIAL_TRANSITIONS, canMaterialTransition, transitionMaterial,
  SESSION_STATES, SESSION_TRANSITIONS, canSessionTransition, transitionSession,
  DRAFT_STATES, DRAFT_TRANSITIONS, canDraftTransition, transitionDraft,
  /* 语料 */
  DEFAULT_LEXICON, DEFAULT_GOLDEN, DEFAULT_IDEAS, DEFAULT_CASE,
};
