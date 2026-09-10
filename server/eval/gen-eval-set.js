/* ============================================================
   流量总台 · 内容生产线 — 静态评测集生成器 (D5)
   固定种子确定性生成, 同种子可复现。输出:
     eval-set.jsonl (≥220 条) + eval-set-stats.txt
   用法: node gen-eval-set.js [--seed 20260910]
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const { RULES, VOICE, SEMANTIC_WORDS } = require('./eval-config');

const SEED = Number(process.argv.includes('--seed') ? process.argv[process.argv.indexOf('--seed') + 1] : 20260910);
let rngState = SEED >>> 0;
function rng() {
  rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rng() * arr.length) % arr.length];
const range = (n) => Array.from({ length: n }, (_, i) => i);

/* ---------- 语料池 ---------- */
const PAINS = ['课越卖越便宜', '咨询来了却报不上价', '粉丝涨了变现不动', '忙了一年利润见底', '客户总嫌贵', '旺季也攒不下钱'];
const METHODS = ['定价三段论', '结果锚点法', '人群收窄法', '交付结构化', '报价单改造', '筛选门槛设计'];
const CASES = ['岑晴川', '老周', '陈姐', '林博士', '方总', '许老师'];
const DOMAINS = ['别墅设计赛道', '疗愈赛道', '财税咨询', '职场教练', '留学规划', '品牌咨询'];
const CTAS = ['扣「定价」领手册', '评论区扣 1 拉你进群', '想要路线图的扣「路线」', '回「报价」发你模板'];

const CLEAN_BODIES = [
  '把你这周见过的客户写下来, 标出谁是你真正想服务的。明天先回绝一个不合适的。',
  '报价单今晚改一版: 每一条后面补上「对方拿到什么」。改完放在手边, 下次咨询直接用。',
  '今天只做一件事: 把交付流程写成三步, 贴在桌前。之后每次签约前过一遍。',
  '翻一遍你最近十条动态, 删掉三条和定位无关的。留下的, 就是你的主场。',
  '给老客户发一条问候, 只聊近况不带推销。信任是慢慢存出来的。',
  '把咨询前的问题清单从 20 条砍到 7 条。问得越少, 听得越清。',
  '这周末把案例整理成一页纸: 谁的问题、你做了什么、结果如何。下周谈单就能用。',
  '给报价加一个「不包含」清单。边界越清楚, 合作越省心。',
  '把你的服务拆成两档, 中间留白。多数人会选高的一档, 只要档位设计合理。',
  '今晚复盘一个丢单: 是价格问题, 还是人群没选对。写三行, 明天再看。',
];

const NEG_BODIES = [
  '本机构深耕行业多年, 秉持专业态度, 为广大用户提供一站式全方位服务解决方案, 欢迎各界人士垂询洽谈。',
  '我们致力于打造行业领先的优质服务平台, 通过卓越的运营体系与完善的服务流程, 满足不同层次客户的多样化需求。',
  '本课程内容丰富详实, 讲师团队经验深厚, 助力学员全面提升综合能力, 实现个人价值的持续增长与突破。',
  '诚邀您参加本年度重磅系列活动, 现场大咖云集, 干货满满, 机会难得, 名额有限, 报名从速。',
  '本平台依托强大的资源整合能力, 构建完善的生态闭环, 为合作伙伴提供长效稳定的支持与陪伴式服务。',
];

const SEM_RISK_BODIES = [
  '跟着我做, 闭着眼睛买都不会亏, 这波机会看得见摸得着。',
  '现在不报名, 三年后被淘汰的时候别怪我没提醒你。',
  '这批名额放完就收, 错过这村没这店, 亏了只能怪自己手慢。',
  '群里的人都在偷偷变富, 就差你了, 还犹豫什么。',
  '这个方法我用了五年, 稳稳的, 从来没失过手, 你抄就行了。',
  '跟着买必涨, 这是我内部渠道的消息, 出去别乱说。',
  '今天不下单, 明天你一定会后悔, 我把话放这。',
  '躺着收就行了, 什么都不用干, 每月准时到账。',
  '包你三个月见效, 不见效果你直接来找我们退。',
  '错过这一期, 你要多走五年弯路, 学员案例摆在这。',
];

/* 违禁正文模板 (含规则词, 用于 mustIntercept) */
const VIOLATING_TEMPLATES = [
  (pain) => `还在为${pain}发愁? 我们是行业内最好的团队, 学员反馈百分百好评, 现在报名还送独家资料。`,
  (pain) => `${pain}? 因为你在用低效方法。我们的方法论全网第一, 数万学员亲测有效, 机会有限。`,
  (pain) => `别人不会告诉你的内幕: ${pain}的解法其实是史上最简单的套路, 今天免费公开, 建议收藏。`,
  (pain) => `这套系统绝对能解决${pain}的问题, 老学员都说躺着就把钱赚了, 你还在观望什么?`,
  (pain) => `学会这一招, ${pain}直接翻篇。课程好评率百分百, 跟着做保证收益, 亏了算我的。`,
];

/* 同源语料 (原创度 reject 组): source 与 draft 高重合 */
const ORIG_SOURCES = [
  '为什么我劝你别再做低客单: 一个咨询师的定价血泪史。课越卖越便宜, 人越干越累, 低客单不是引流是内耗。把价值锚点从我的时间换成客户的结果, 报价才有底气。客户不为你的时间付钱, 只为结果付钱。',
  '从月销 30 万到 300 万, 她只改了报价单上的一行字。把按时间收费改成按结果交付, 客单价立刻翻倍。报价单是筛选器, 不只是收入单, 敢报高价的人先过了自己心里那关。',
  '别再卷流量了, 高净值客户根本不在直播间。他们只在朋友圈和一对一的场景里做决定, 信任是慢慢存出来的, 重复是成交里最被低估的动作。',
  '朋友圈成交的底层逻辑: 不是发广告, 是养信任。每天存一点, 成交时一次取, 信任账户的余额决定你的客单价上限。',
];
const ORIG_SAME_DRAFTS = [
  '为什么我劝你别再做低客单: 一个顾问的定价心得。课越卖越便宜, 人越干越累, 低客单不是引流是内耗。把价值锚点从我的时间换成客户的结果, 报价才有底气。客户不为你的时间付钱, 只为结果买单。',
  '从月销 30 万到 300 万, 她只改了报价单上的一行字。把按时间收费改成按结果交付, 客单价直接翻倍。报价单是筛选器, 不只是收入单, 敢报高价的人先过了自己心里那关。',
  '别再卷流量了, 高净值客户根本不在直播间。他们只在朋友圈和一对一的场景里做决定, 信任是慢慢存出来的, 重复是成交里最被低估的动作, 没有之一。',
  '朋友圈成交的底层逻辑: 不是发广告, 而是养信任。每天存一点, 成交时一次取, 信任账户的余额决定你的客单价天花板。',
];
/* 换理念改写 (原创度 pass 组): 同选题不同表达, 无连续 8 字重合 */
const ORIG_REWRITE_DRAFTS = [
  '便宜的课正在拖垮你: 定价得太低, 付出感反而被稀释。想让客户尊重你的专业, 先把计费方式从工时改成成果。人愿意为改变买单, 不愿意为忙碌买单。',
  '她的收入翻了十倍, 动作只有一个: 收费不再看花了多久, 而是看交付了什么。价格表本质是人群过滤器, 提价等于换客群。',
  '有钱人几乎不刷直播间, 他们刷的是你每天发的日常。公域攒关注, 私域攒信任, 同一句话说一百遍, 就成了成交的种子。',
  '别把动态当广告位, 把它当存折: 每天往里存一点真实, 关键时刻才能一次取出来用。你能收多贵, 取决于账上存了多少。',
];

/* ---------- 生成四类样本 ---------- */
const out = [];
let seq = { voice: 0, compliance: 0, originality: 0, semantic: 0, boundary: 0 };

/* 1) voice: 45 正样本(声纹同风格, 期望≥90) + 15 负样本(书面广告腔, 期望<90) */
function posVoiceText() {
  const pain = pick(PAINS), method = pick(METHODS), c = pick(CASES), dom = pick(DOMAINS), cta = pick(CTAS);
  const g = pick(VOICE.golden);
  const n = 1 + Math.floor(rng() * 3);
  const bodies = range(n).map(() => pick([
    '同一个专业, 两种报价写法, 客单价差 20 倍。',
    '定价不是拍脑袋, 是一套可拆解的结构。',
    '高客单的起点, 是敢筛选不对的人。',
    '案例数字要核验过才敢往外讲。',
    '把交付做成系统, 不靠灵感靠动作。',
    '朋友圈每天存一点, 成交时一次取。',
  ])).join('\n');
  return `你是不是也这样: ${pain}?\n\n${method}就三步:\n第一, 报价按结果不按时间;\n第二, 案例数字先核验再讲;\n第三, 设一道筛选门槛。\n\n${bodies}\n\n${g}\n\n我们客户${c}, ${dom}, ${cta}。`;
}
for (const _ of range(45)) {
  out.push({ id: `V-${String(++seq.voice).padStart(3, '0')}`, kind: 'voice', text: posVoiceText(), voiceSamples: VOICE, expect: { minLikeness: 90 } });
}
for (const _ of range(15)) {
  out.push({ id: `V-${String(++seq.voice).padStart(3, '0')}`, kind: 'voice', text: pick(NEG_BODIES), voiceSamples: VOICE, expect: { negative: true, maxLikeness: 89 } });
}

/* 2) compliance: 25 直接违禁 + 15 变体(全角/emoji/空格干扰) + 20 干净 */
for (const _ of range(25)) {
  out.push({ id: `C-${String(++seq.compliance).padStart(3, '0')}`, kind: 'compliance', text: pick(VIOLATING_TEMPLATES)(pick(PAINS)), expect: { mustIntercept: true } });
}
const VARIANT_WRAPS = [
  (w) => `别犹豫了, 这套${w}的方法你值得拥有, 赶紧上车。`,                       // 直接
  (w) => `这套方法被业内称为「${w}」的选择, 我 ${w} 推荐, 抄作业就行。`,           // 夹杂
  (w) => `别犹豫了, 这套${w.slice(0, 1)}🌟${w.slice(1)}的方法你值得拥有。`,         // emoji 插入
  (w) => `学员说这是${w.split('').join(' ')}的打法, 你自己品。`,                    // 空格插入
];
for (let i = 0; i < 15; i++) {
  const rule = RULES[i % (RULES.length - 1)]; // 跳过 guaranteed(英文), 用中文规则做变体
  const wrap = VARIANT_WRAPS[i % VARIANT_WRAPS.length];
  out.push({ id: `C-${String(++seq.compliance).padStart(3, '0')}`, kind: 'compliance', variant: true, text: wrap(rule.word), expect: { mustIntercept: true } });
}
for (const _ of range(20)) {
  out.push({ id: `C-${String(++seq.compliance).padStart(3, '0')}`, kind: 'compliance', text: pick(CLEAN_BODIES), expect: { mustIntercept: false } });
}

/* 3) originality: 30 同源(期望打回) + 30 换理念(期望通过) */
for (let i = 0; i < 30; i++) {
  const k = i % ORIG_SOURCES.length;
  out.push({ id: `O-${String(++seq.originality).padStart(3, '0')}`, kind: 'originality', draft: ORIG_SAME_DRAFTS[k], source: ORIG_SOURCES[k], expect: { reject: true, minOverlapPct: 16 } });
}
for (let i = 0; i < 30; i++) {
  const k = i % ORIG_SOURCES.length;
  out.push({ id: `O-${String(++seq.originality).padStart(3, '0')}`, kind: 'originality', draft: ORIG_REWRITE_DRAFTS[k], source: ORIG_SOURCES[k], expect: { reject: false, maxOverlapPct: 15 } });
}

/* 4) semantic: 30 条规则未覆盖的语义风险(裁判词表复核, 漏检率口径) */
for (let i = 0; i < 30; i++) {
  const body = SEM_RISK_BODIES[i % SEM_RISK_BODIES.length];
  out.push({ id: `S-${String(++seq.semantic).padStart(3, '0')}`, kind: 'semantic', text: body, expect: { semanticRisk: true } });
}

/* 5) boundary: 40 条极端输入(不崩溃 + 确定性) */
const BOUNDARY = [
  { text: '', note: '空字符串' },
  { text: ' ', note: '纯空格' },
  { text: '　', note: '全角空格' },
  { text: 'a', note: '单字符' },
  { text: '好', note: '单个汉字' },
  { text: '🌟✨🔥', note: '纯 emoji' },
  { text: '1234567890', note: '纯数字' },
  { text: '！！！？？？。。。', note: '纯标点' },
  { text: '\n\n\n', note: '纯换行' },
  { text: '#¥%……&*', note: '纯符号' },
  { text: '定价'.repeat(500), note: '重复词 1000 字' },
  { text: '这是一段没有任何标点符号的超长文本用来测试引擎在极端输入下的表现我们把它写得足够长足够密来看看会不会崩溃或者返回不确定的结果'.repeat(12), note: '超长无标点 800+ 字' },
];
for (let i = 0; i < 40; i++) {
  const b = BOUNDARY[i % BOUNDARY.length];
  out.push({ id: `B-${String(++seq.boundary).padStart(3, '0')}`, kind: 'boundary', text: b.text, voiceSamples: VOICE, note: b.note, expect: { noCrash: true } });
}

/* ---------- 写文件 ---------- */
const dir = __dirname;
fs.writeFileSync(path.join(dir, 'eval-set.jsonl'), out.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
const byKind = {};
out.forEach((s) => { byKind[s.kind] = (byKind[s.kind] || 0) + 1; });
const stats = [
  'eval-set.jsonl 统计',
  `seed: ${SEED} (确定性生成, 可复现)`,
  `总数: ${out.length}`,
  ...Object.entries(byKind).map(([k, v]) => `  ${k}: ${v}`),
  '  其中 compliance 含变体样本: ' + out.filter((s) => s.variant).length,
  '  voice 正样本(期望≥90): ' + out.filter((s) => s.kind === 'voice' && !s.expect.negative).length,
  '  voice 负样本(期望<90): ' + out.filter((s) => s.kind === 'voice' && s.expect.negative).length,
  '  originality 打回组(重合>15%): ' + out.filter((s) => s.kind === 'originality' && s.expect.reject).length,
  '  originality 通过组(重合≤15%): ' + out.filter((s) => s.kind === 'originality' && !s.expect.reject).length,
].join('\n');
fs.writeFileSync(path.join(dir, 'eval-set-stats.txt'), stats + '\n', 'utf8');
console.log(stats);
