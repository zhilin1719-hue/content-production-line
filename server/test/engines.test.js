/* ============================================================
   engines.test.js — 纯业务引擎测试 (node:test + node:assert)
   ============================================================ */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const E = require('../engines');
const CONFIG = require('../config');

const RULES = CONFIG.RULES;

/* ---------- normalizeText: 全角→半角 / 去空白标点 emoji ---------- */
test('normalizeText: 全角转半角并去空白', () => {
  assert.strictEqual(E.normalizeText('ＡＢＣ ｘｙｚ'), 'abcxyz');
  assert.strictEqual(E.normalizeText('最　好'), '最好');          // 全角空格
  assert.strictEqual(E.normalizeText('最 好'), '最好');           // 半角空格
  assert.strictEqual(E.normalizeText('最😊好'), '最好');          // emoji 插入
  assert.strictEqual(E.normalizeText('（最好）！'), '最好');      // 全角标点
  assert.strictEqual(E.normalizeText('Ｇｕａｒａｎｔｅｅｄ'), 'guaranteed');
  assert.strictEqual(E.normalizeText(''), '');
});

/* ---------- complianceScan: 变体拦截(全角/emoji/半角必须命中) ---------- */
test('complianceScan: 「最好」三种变体全部命中', () => {
  for (const text of ['这款产品最好用', '这款产品最　好用', '这款产品最😊好用', '这款产品最 好用', '（最好）的选择']) {
    const hits = E.complianceScan(text, RULES);
    const hit = hits.find((h) => h.word === '最好');
    assert.ok(hit, `变体应命中「最好」: ${text}`);
    assert.strictEqual(hit.type, '广告法极限词');
    assert.ok(hit.count >= 1);
  }
});

test('complianceScan: 半角/大小写英文规则命中 + 计数', () => {
  const hits = E.complianceScan('100% Guaranteed returns, guaranteed!', RULES);
  const g = hits.find((h) => h.word === 'guaranteed');
  assert.ok(g, 'guaranteed 应命中(大小写+前后空格归一)');
  assert.strictEqual(g.count, 2);
});

test('complianceScan: 无风险文本返回空', () => {
  assert.deepStrictEqual(E.complianceScan('这是一篇干净的稿子, 只讲方法论。', RULES), []);
});

test('complianceScan: 多规则同时命中', () => {
  const hits = E.complianceScan('史上最好的第一选择, 绝对稳赚', RULES);
  const words = hits.map((h) => h.word);
  for (const w of ['史上最', '最好', '第一', '绝对', '稳赚']) assert.ok(words.includes(w), `应命中 ${w}`);
});

/* ---------- applyRuleFixes ---------- */
test('applyRuleFixes: 按 repl 映射替换(最好→更适合大多数人、第一→头部)', () => {
  const r = E.applyRuleFixes('我见过最好的一个顾问, 第一, 要敢报价。', RULES);
  assert.ok(r.text.includes('更适合大多数人'));
  assert.ok(r.text.includes('头部'));
  assert.ok(!r.text.includes('最好') && !r.text.includes('第一'));
  assert.strictEqual(r.remaining.length, 0, '重扫应清零');
  assert.ok(r.applied.length >= 2);
});

test('applyRuleFixes: 变体(全角空格/emoji)同样可替换', () => {
  const r = E.applyRuleFixes('这是最　好的, 也是最😊好的', RULES);
  assert.ok(!r.text.includes('最　好') && !r.text.includes('最😊好'));
  assert.strictEqual(r.remaining.length, 0);
});

test('applyRuleFixes: repl 为空串的规则执行删除', () => {
  const r = E.applyRuleFixes('史上最离谱的案例', RULES);
  assert.ok(!r.text.includes('史上最'));
});

/* ---------- originality: 连续 8 字重合 ---------- */
test('originality: 完全相同 → 高重合, 不通过', () => {
  const s = '为什么我劝你别再做低客单, 一个咨询师的定价血泪史, 课越卖越便宜人越干越累, 低客单不是引流是内耗, 专业也救不了结构问题';
  const o = E.originality(s, s);
  assert.ok(o.ratio >= 0.9, `ratio=${o.ratio}`);
  assert.strictEqual(o.pass, false);
  assert.ok(o.overlapPct >= 90);
});

test('originality: 完全无关 → ~0, 通过', () => {
  const o = E.originality('今天天气不错, 我们去公园散步顺便喂鸽子, 生活美好而平静。', '别墅设计的高客单不在效果图, 在交付结构与业主筛选。');
  assert.ok(o.ratio <= 0.02, `ratio=${o.ratio}`);
  assert.strictEqual(o.pass, true);
  assert.strictEqual(o.overlapPct, 0);
});

test('originality: 大段照抄 → 不通过; 原型演示对(初稿 vs 对标节选) → 通过', () => {
  const src = '课越卖越便宜人越干越累低客单不是引流是内耗专业也救不了结构问题要敢报价';
  const copied = src + '接下来我们讲完全不同的另一个话题, 关于高尔夫球场的第 7 洞与备忘录里的金句, 以及海边两天的思考, 都是无关内容凑字数用的。';
  assert.strictEqual(E.originality(copied, src).pass, false);
  const draft = `你是不是也这样: 课越卖越便宜, 人越干越累?\n\n低客单不是引流, 是内耗。今天给你高客单定价的三段论:\n第一, 把价值锚点从「我的时间」换成「客户的结果」;\n第二, 用已核验的案例数字做结果承诺;\n第三, 设一道筛选门槛, 敢拒绝不合适的人。\n\n我们客户岑晴川, 把客单价从 2 万提到 45 万, 两个月签了 10 单。这不是神话, 是结构。\n\n评论区扣「定价」, 我把《报价 10 倍手册》发你。`;
  const excerpt = '为什么我劝你别再做低客单: 一个咨询师的定价血泪史。课越卖越便宜人越干越累, 低客单不是引流是内耗……';
  const o = E.originality(draft, excerpt);
  assert.strictEqual(o.pass, true, `原型演示对应通过, overlapPct=${o.overlapPct}`);
  assert.ok(o.overlapPct <= 15);
});

test('originality: 空输入与短文本边界', () => {
  assert.deepStrictEqual(E.originality('', '来源'), { ratio: 0, overlapPct: 0, pass: true });
  assert.strictEqual(E.originality('很短', '来源文本').pass, true);
});

test('originality: 返回结构契约 {ratio(0-1), overlapPct(1位), pass}', () => {
  const o = E.originality('定位选对客户会自己把你从人群里挑出来敢报高价的人先过了自己心里那关', '定位选对客户会自己把你从人群里挑出来');
  assert.ok(typeof o.ratio === 'number' && o.ratio >= 0 && o.ratio <= 1);
  assert.ok(Number.isInteger(o.overlapPct * 10), 'overlapPct 保留 1 位');
  assert.strictEqual(typeof o.pass, 'boolean');
});

/* ---------- likeness: 确定性 / 门禁 / 降级 ---------- */
test('likeness: 同输入同输出(确定性)', () => {
  const t = '高客单顾问和低客单顾问的区别, 不在专业, 在报价单的结构。同一个专业, 两种写法, 客单价差 20 倍。';
  const a = E.likeness(t, { lexicon: ['客单价', '报价', '结构', '专业'], golden: [], samples: [t] });
  const b = E.likeness(t, { lexicon: ['客单价', '报价', '结构', '专业'], golden: [], samples: [t] });
  assert.strictEqual(a, b);
  assert.ok(a >= 0 && a <= 100);
});

test('likeness: 生成稿默认声纹 ≥ 90; 降级声纹 < 90', () => {
  const topic = { newTitle: '低客单不是引流, 是内耗: 高客单顾问的定价三段论', srcTitle: '对标原文' };
  const ideas = E.generateIdeaOptions(topic);
  const frames = E.generateFrames(topic);
  for (const f of frames) {
    const d = E.generateDraft(topic, ideas[0], f);
    assert.ok(E.likeness(d) >= 90, `生成稿像你度应≥90: ${f.tag} → ${E.likeness(d)}`);
  }
  const degraded = { samples: [], lexicon: [], golden: [] };
  const d = E.generateDraft(topic, ideas[0], frames[0]);
  assert.ok(E.likeness(d, degraded) < 90, '降级声纹应低于 90(NFR-17 触发条件)');
});

test('likeness: 金句引用加权', () => {
  const voice = { lexicon: ['定价', '客户', '结果'], golden: ['定位选对, 客户会自己把你从人群里挑出来。'], samples: [] };
  const base = '今天聊聊定价和客户结果。';
  const withQuote = base + '\n\n定位选对, 客户会自己把你从人群里挑出来。';
  assert.ok(E.likeness(withQuote, voice) > E.likeness(base, voice));
});

/* ---------- 选题/框架/初稿生成 ---------- */
test('generateIdeaOptions: 3 个方向, 确定性, 含 tag/title/desc', () => {
  const topic = { newTitle: '低客单不是引流, 是内耗: 高客单顾问的定价三段论', srcTitle: '为什么我劝你别再做低客单' };
  const a = E.generateIdeaOptions(topic);
  const b = E.generateIdeaOptions(topic);
  assert.strictEqual(a.length, 3);
  assert.deepStrictEqual(a, b, '确定性');
  assert.strictEqual(a[0].tag, '理念一 · 反内耗');
  a.forEach((o) => { assert.ok(o.title && o.desc); });
  assert.ok(String(a[0].title).includes('定价三段论'));
});

test('generateFrames: 2 套框架(A 冲突递进 / B 案例实证)', () => {
  const f = E.generateFrames({ newTitle: '信任账户: 每天存一点, 成交时一次取', srcTitle: 'x' });
  assert.strictEqual(f.length, 2);
  assert.ok(f[0].tag.includes('框架 A'));
  assert.ok(f[1].tag.includes('框架 B'));
});

test('generateDraft: 结构随 frame 变化, 含钩子与行动指令, 含演示极限词', () => {
  const topic = { newTitle: '低客单不是引流, 是内耗: 高客单顾问的定价三段论', srcTitle: '对标原文' };
  const ideas = E.generateIdeaOptions(topic);
  const frames = E.generateFrames(topic);
  const dA = E.generateDraft(topic, ideas[0], frames[0]);
  const dB = E.generateDraft(topic, ideas[0], frames[1]);
  assert.notStrictEqual(dA, dB, '框架 A/B 结构应不同');
  assert.ok(dB.startsWith('先说一个案例'), '框架 B 案例开场');
  assert.ok(dA.includes('你是不是也这样'), '框架 A 钩子开场');
  for (const d of [dA, dB]) {
    assert.ok(d.includes('评论区扣'), '行动指令');
    const hits = E.complianceScan(d, RULES);
    assert.ok(hits.length >= 1, '演示初稿含极限词供三层拦截');
  }
});

/* ---------- 朋友圈 ---------- */
test('generateMoment: 确定性取材, 返回池内文案', () => {
  const pool = { id: 'ganhuo', variants: ['文案甲', '文案乙', '文案丙'] };
  const a = E.generateMoment(pool, '工作日 · 周三');
  const b = E.generateMoment(pool, '工作日 · 周三');
  assert.strictEqual(a, b);
  assert.ok(['文案甲', '文案乙', '文案丙'].includes(a));
  assert.ok(E.generateMoment({ id: 'anli', variants: ['唯一'] }, 'x').length > 0);
  assert.strictEqual(E.generateMoment({ id: 'x', variants: [] }, 'x'), '');
});

/* ---------- 公开课物料/正文 ---------- */
test('generateMaterials: 三渠道 {pyq, dm, poster}, 每渠道多变体', () => {
  const s = { title: '有流量, 却卡在变现: 私域成交系统课', host: '泽宇', audience: '博主', hook: '《路线图》', warmStart: '2026-08-21', openDay: '2026-08-24' };
  for (const day of ['D1', 'D2', 'D3']) {
    const m = E.generateMaterials(s, day);
    for (const ch of ['pyq', 'dm', 'poster']) {
      assert.ok(m[ch] && Array.isArray(m[ch].variants) && m[ch].variants.length >= 2, `${day}/${ch} 应有 ≥2 变体`);
    }
    assert.ok(m.dm.variants.every((v) => v.includes('{称呼}')), '私信话术保留 {称呼} 占位');
    m.poster.variants.forEach((v) => {
      assert.ok(v.title && v.sub && v.proof && v.cta, '海报变体含 title/sub/proof/cta');
    });
  }
  assert.deepStrictEqual(E.generateMaterials(s, 'D1'), E.generateMaterials(s, 'D1'), '确定性');
});

test('generateCourseBody: 正文含天数与钩子', () => {
  const s = { title: '公开课', hook: '《手册》', courseThemes: ['第 1 天主题'] };
  const body = E.generateCourseBody(s, 1);
  assert.ok(body.includes('【公开课 D1'));
  assert.ok(body.includes('第 1 天主题'));
  assert.ok(body.includes('《手册》'));
});

/* ---------- 场次节奏 ---------- */
test('sessionRhythm: 预热3天+正课5天(+3 开课, +7 收官)', () => {
  const r = E.sessionRhythm('2026-08-21');
  assert.strictEqual(r.warmStart, '2026-08-21');
  assert.strictEqual(r.openDay, '2026-08-24');
  assert.strictEqual(r.endDay, '2026-08-28');
  assert.deepStrictEqual(r.warmDays, ['D1', 'D2', 'D3']);
  assert.deepStrictEqual(r.courseDays, [1, 2, 3, 4, 5]);
});

test('sessionRhythm: 跨月/闰年日期推演', () => {
  assert.strictEqual(E.sessionRhythm('2026-08-30').openDay, '2026-09-02');
  assert.strictEqual(E.sessionRhythm('2026-08-30').endDay, '2026-09-06');
  assert.strictEqual(E.sessionRhythm('2024-02-27').openDay, '2024-03-01'); // 闰年
  assert.strictEqual(E.sessionRhythm('2023-02-26').openDay, '2023-03-01'); // 平年
  assert.throws(() => E.sessionRhythm('2026-13-01'));
  assert.throws(() => E.sessionRhythm('bad'));
});

/* ---------- 撞期检测 ---------- */
const EXISTING = [
  { id: 's1', title: '场次一', openDay: '2026-08-24', endDay: '2026-08-28' },
  { id: 's2', title: '场次二(已收官)', openDay: '2026-08-06', endDay: '2026-08-10', status: '已收官' },
];
test('checkClash: 相交 → 返回冲突场次', () => {
  const c = E.checkClash('2026-08-22', EXISTING); // 新: 08-25~08-29 与 s1 08-24~08-28 相交
  assert.ok(c && c.id === 's1');
});
test('checkClash: 相离 → null', () => {
  assert.strictEqual(E.checkClash('2026-09-14', EXISTING), null); // 新: 09-17~09-21
});
test('checkClash: 边界相切 → 计为冲突', () => {
  const c = E.checkClash('2026-08-17', EXISTING); // 新: 08-20~08-24, endDay 恰为 s1 openDay
  assert.ok(c && c.id === 's1', '相切(新收官日=既有开课日)应拦下');
});
test('checkClash: 已收官场次不参与撞期', () => {
  const onlyClosed = [{ id: 's2', title: '已收官', openDay: '2026-08-06', status: '已收官' }];
  assert.strictEqual(E.checkClash('2026-08-03', onlyClosed), null);
});
test('checkClash: 无 endDay 的场次按 openDay+4 推演', () => {
  const c = E.checkClash('2026-08-21', [{ id: 'sx', title: 'x', openDay: '2026-08-24' }]);
  assert.ok(c && c.id === 'sx');
});

/* ---------- 扫描候选 ---------- */
test('generateTopicCandidates: 同 seed 确定性, rel 在 25-95, 数量 1-2', () => {
  const acct = { id: 'a1', name: '透*糖', track: '商业IP赛道' };
  const a = E.generateTopicCandidates(acct, { seed: 42, count: 2 });
  const b = E.generateTopicCandidates(acct, { seed: 42, count: 2 });
  assert.deepStrictEqual(a, b);
  assert.ok(a.length >= 1 && a.length <= 2);
  a.forEach((c) => {
    assert.ok(c.rel >= 25 && c.rel <= 95);
    assert.ok(c.srcTitle && c.newTitle && c.srcLikes > 0);
  });
  assert.strictEqual(E.generateTopicCandidates(acct, { seed: 7, count: 1 }).length, 1);
});

/* ---------- 复核(第二层) ---------- */
test('reviewDraft: 原创度通过且无语义风险 → 通过; 语义风险词 → 打回', () => {
  const ok = E.reviewDraft('今天讲一个完全不同的原创话题, 关于结构与系统的思考方法。', '完全不同的来源文本', RULES, CONFIG.SEMANTIC_RISK_WORDS);
  assert.strictEqual(ok.pass, true);
  const bad = E.reviewDraft('这个项目稳赚不赔, 零风险必涨。', '无关来源', RULES, CONFIG.SEMANTIC_RISK_WORDS);
  assert.strictEqual(bad.pass, false);
  assert.ok(bad.reasons.some((r) => r.includes('语义风险')));
});
