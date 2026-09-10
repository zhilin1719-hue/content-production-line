/* ============================================================
   api.test.js — HTTP API 全链路测试 (随机端口 + fetch)
   login → scan → ideas → frame → draft → compliance → apply →
   review → final-review → export; moments; sessions 撞期; course;
   角色权限(viewer 403 / operator 终审 403); dashboard/audit/cost
   ============================================================ */
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

process.env.DATA_DIR = path.join(os.tmpdir(), 'cpl-test-api-' + Date.now());
process.env.PORT = '0';
process.env.LLM_DELAY_MS = '1';

const seed = require('../seed');
const { start } = require('../server');

let BASE = '';
let closer = null;
let opToken = '', revToken = '', viewToken = '', adminToken = '';

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, data, res };
}

after(() => { if (closer) return closer(); });

/* ==================== 启动与登录 ==================== */
test('setup: 播种 + 随机端口起服', async () => {
  seed.seedAll({ reset: true });
  const s = await start();
  closer = s.close;
  BASE = `http://127.0.0.1:${s.port}`;
  assert.ok(s.port > 0);
});

test('login: 四角色登录, operator 仅授权泽宇项目', async () => {
  const bad = await api('POST', '/api/auth/login', { username: 'operator', password: 'wrong' });
  assert.strictEqual(bad.status, 401);
  assert.ok(bad.data.error.code === 'AUTH_FAILED' && bad.data.error.hint);

  const op = await api('POST', '/api/auth/login', { username: 'operator', password: 'op123' });
  assert.strictEqual(op.status, 200);
  opToken = op.data.token;
  assert.deepStrictEqual(op.data.user, { username: 'operator', name: '内容操盘手', role: 'operator' });
  assert.deepStrictEqual(op.data.projects, ['p-zeyu']);
  assert.ok(opToken.includes('.'), 'HMAC 签名 token');

  const rev = await api('POST', '/api/auth/login', { username: 'reviewer', password: 'rev123' });
  revToken = rev.data.token;
  assert.deepStrictEqual(rev.data.projects, ['p-zeyu', 'p-cenqc']);

  const view = await api('POST', '/api/auth/login', { username: 'viewer', password: 'view123' });
  viewToken = view.data.token;

  const admin = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  adminToken = admin.data.token;
  assert.strictEqual(admin.data.user.role, 'admin');
});

test('auth: me / 未登录 401 / 坏 token 401 / 篡改 token 401', async () => {
  const me = await api('GET', '/api/auth/me', undefined, opToken);
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.data.user.role, 'operator');

  const no = await api('GET', '/api/auth/me');
  assert.strictEqual(no.status, 401);
  assert.strictEqual(no.data.error.code, 'UNAUTHORIZED');

  const bad = await api('GET', '/api/auth/me', undefined, 'not.a.token');
  assert.strictEqual(bad.status, 401);

  const forged = opToken.split('.').slice(0, 1).join('.') + '.' + opToken.split('.').slice(1).join('.').slice(0, 10);
  const f = await api('GET', '/api/auth/me', undefined, forged);
  assert.strictEqual(f.status, 401);
});

test('health: 免鉴权', async () => {
  const h = await api('GET', '/api/health');
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.data.ok, true);
});

test('projects: 按授权过滤; 仅 admin 可建项目', async () => {
  const opList = await api('GET', '/api/projects', undefined, opToken);
  assert.strictEqual(opList.status, 200);
  assert.strictEqual(opList.data.projects.length, 1);
  assert.strictEqual(opList.data.projects[0].id, 'p-zeyu');

  const denied = await api('POST', '/api/projects', { name: '新项目' }, opToken);
  assert.strictEqual(denied.status, 403);

  const created = await api('POST', '/api/projects', { name: '测试新项目', host: '测试主讲' }, adminToken);
  assert.strictEqual(created.status, 201);
  assert.ok(created.data.project.id.startsWith('p-'));
});

/* ==================== 对标账号与扫描 ==================== */
test('accounts: 新增/开盯暂停/模拟扫描入库与留痕', async () => {
  const created = await api('POST', '/api/accounts', { projectId: 'p-zeyu', name: '测试达人笔记', platform: '抖音', track: '商业IP赛道', fans: 120000, works: 48 }, opToken);
  assert.strictEqual(created.status, 201);
  const acct = created.data.account;
  assert.strictEqual(acct.watching, true);
  assert.ok(acct.name.includes('*'), '名称自动脱敏');

  const paused = await api('PATCH', `/api/accounts/${acct.id}`, { watching: false }, opToken);
  assert.strictEqual(paused.status, 200);
  assert.strictEqual(paused.data.account.status, 'paused');
  const resumed = await api('PATCH', `/api/accounts/${acct.id}`, { watching: true }, opToken);
  assert.strictEqual(resumed.data.account.watching, true);

  const scan = await api('POST', `/api/accounts/${acct.id}/scan`, {}, opToken);
  assert.strictEqual(scan.status, 200);
  assert.ok(scan.data.found >= 1 && scan.data.found <= 2, '生成 1-2 条候选');
  assert.strictEqual(scan.data.candidates.length, scan.data.found);
  assert.strictEqual(scan.data.admitted + scan.data.rejected, scan.data.found);

  const topics = await api('GET', '/api/topics?status=选题', undefined, opToken);
  for (const c of scan.data.candidates) {
    if (c.admitted) {
      assert.ok(c.rel >= 40, '入池候选相关度 ≥ 阈值 40');
      const t = topics.data.list.find((x) => x.id === c.topicId);
      assert.ok(t, '入池候选出现在选题列表');
      assert.strictEqual(t.status, '选题');
    } else {
      assert.ok(c.rel < 40, '筛除候选相关度 < 40(留痕不入池)');
    }
  }
  /* 种子留痕: 已筛除选题不进默认列表 */
  const all = await api('GET', '/api/topics', undefined, opToken);
  assert.ok(!all.data.list.some((x) => x.status === '已筛除'));
  const filtered = await api('GET', '/api/topics?status=已筛除', undefined, opToken);
  assert.ok(filtered.data.list.length >= 1, '显式查询可见筛除留痕');
});

/* ==================== 出稿全链路 ==================== */
test('出稿链路: ideas → frame → draft(含 NFR-17 降级重生)', async () => {
  const noIdeas = await api('POST', '/api/topics/t2/frame', { ideaIndex: 0 }, opToken);
  assert.strictEqual(noIdeas.status, 422);

  const ideas = await api('POST', '/api/topics/t2/ideas', {}, opToken);
  assert.strictEqual(ideas.status, 200);
  assert.strictEqual(ideas.data.ideas.length, 3);
  assert.ok(ideas.data.ideas[0].tag.startsWith('理念一'));

  const frame = await api('POST', '/api/topics/t2/frame', { ideaIndex: 1 }, opToken);
  assert.strictEqual(frame.status, 200);
  assert.strictEqual(frame.data.frames.length, 2);
  assert.strictEqual(frame.data.idea.tag, '理念二 · 卖结果');

  /* NFR-17 演示开关: 首次生成使用降级声纹 → 低分自动重生一次 */
  const draft = await api('POST', '/api/topics/t2/draft', { frameIndex: 0, degradeFirstAttempt: true }, opToken);
  assert.strictEqual(draft.status, 201);
  assert.ok(draft.data.likeness >= 90, `重生后像你度 ≥ 90, 实际 ${draft.data.likeness}`);
  assert.strictEqual(draft.data.regenerated, true, '低分触发自动重生');
  assert.ok(draft.data.firstLikeness < 90, `首次生成 < 90, 实际 ${draft.data.firstLikeness}`);
  assert.ok(draft.data.draft.text.length > 100);
  assert.strictEqual(draft.data.draft.status, '初稿');
  globalThis.__draftId = draft.data.draft.id;

  /* 正常生成: 一次通过 */
  const normal = await api('POST', '/api/topics/t3/ideas', {}, opToken);
  assert.strictEqual(normal.status, 200);
  await api('POST', '/api/topics/t3/frame', { ideaIndex: 0 }, opToken);
  const d3 = await api('POST', '/api/topics/t3/draft', { frameIndex: 1 }, opToken);
  assert.strictEqual(d3.status, 201);
  assert.ok(d3.data.likeness >= 90);
});

test('合规三层: 第一层扫描 → 采纳修复 → 第二层复核 → 第三层终审(角色) → 导出', async () => {
  const id = globalThis.__draftId;

  /* 第一层: 规则库扫描(演示初稿含极限词) */
  const scan1 = await api('POST', `/api/drafts/${id}/compliance`, {}, opToken);
  assert.strictEqual(scan1.status, 200);
  assert.ok(scan1.data.totalHits >= 1, '演示初稿应命中极限词');
  assert.strictEqual(scan1.data.passed, false);

  /* 未过第一层不可进第二层 */
  const early = await api('POST', `/api/drafts/${id}/review`, {}, opToken);
  assert.strictEqual(early.status, 422);
  assert.strictEqual(early.data.error.code, 'COMPLIANCE_REQUIRED');

  /* 采纳修复: 替换后重扫清零 */
  const fix = await api('POST', `/api/drafts/${id}/apply-fixes`, {}, opToken);
  assert.strictEqual(fix.status, 200);
  assert.strictEqual(fix.data.remaining.length, 0, '重扫清零');
  assert.strictEqual(fix.data.passed, true);
  assert.ok(fix.data.applied.length >= 1);

  /* 第二层: 大模型复核(原创度+语义风险) */
  const review = await api('POST', `/api/drafts/${id}/review`, {}, opToken);
  assert.strictEqual(review.status, 200);
  assert.strictEqual(review.data.status, '复核通过');
  assert.strictEqual(review.data.review.pass, true);
  assert.ok(review.data.review.originality.pass, '原创度 ≤ 15%');
  assert.ok(typeof review.data.review.originality.overlapPct === 'number');

  /* 第三层: operator 终审 403(角色权限) */
  const opFinal = await api('POST', `/api/drafts/${id}/final-review`, { decision: 'pass' }, opToken);
  assert.strictEqual(opFinal.status, 403);
  assert.strictEqual(opFinal.data.error.code, 'FORBIDDEN_ROLE');

  /* viewer 写操作 403 */
  const viewWrite = await api('POST', `/api/drafts/${id}/final-review`, { decision: 'pass' }, viewToken);
  assert.strictEqual(viewWrite.status, 403);
  assert.strictEqual(viewWrite.data.error.code, 'FORBIDDEN');

  /* reviewer 终审通过 → 合规过审版 + 选题联动已出稿 */
  const fin = await api('POST', `/api/drafts/${id}/final-review`, { decision: 'pass' }, revToken);
  assert.strictEqual(fin.status, 200);
  assert.strictEqual(fin.data.draft.status, '合规过审版');
  assert.strictEqual(fin.data.topic.status, '已出稿');

  /* 导出: text/plain 下载 */
  const exp = await api('GET', `/api/drafts/${id}/export`, undefined, opToken);
  assert.strictEqual(exp.status, 200);
  assert.ok(String(exp.res.headers.get('content-type')).includes('text/plain'));
  assert.ok(String(exp.data).length > 100);
  assert.ok(exp.res.headers.get('content-disposition').includes('attachment'));

  /* 未过审稿件不可导出 */
  const d3 = await api('POST', '/api/topics/t5/ideas', {}, opToken);
  await api('POST', '/api/topics/t5/frame', { ideaIndex: 0 }, opToken);
  const raw = await api('POST', '/api/topics/t5/draft', {}, opToken);
  const expEarly = await api('GET', `/api/drafts/${raw.data.draft.id}/export`, undefined, opToken);
  assert.strictEqual(expEarly.status, 422);
  assert.strictEqual(expEarly.data.error.code, 'NOT_APPROVED');
});

test('选题状态: 淘汰 → 90 天可恢复 → 恢复', async () => {
  const kill = await api('POST', '/api/topics/t6/discard', {}, opToken);
  assert.strictEqual(kill.status, 200);
  assert.strictEqual(kill.data.topic.status, '已淘汰');
  assert.ok(kill.data.topic.restoreDeadline, '带恢复期限');

  const reKill = await api('POST', '/api/topics/t6/discard', {}, opToken);
  assert.strictEqual(reKill.status, 422, '重复淘汰拒绝');

  const restore = await api('POST', '/api/topics/t6/restore', {}, opToken);
  assert.strictEqual(restore.status, 200);
  assert.strictEqual(restore.data.topic.status, '选题');

  /* 已出稿选题不可淘汰 */
  const done = await api('POST', '/api/topics/t4/discard', {}, opToken);
  assert.strictEqual(done.status, 422);
});

/* ==================== 朋友圈 ==================== */
test('朋友圈: 水位 → 生成(likeness 门禁) → 换一换 → 标已发(幂等 409)', async () => {
  const pools = await api('GET', '/api/pools', undefined, opToken);
  assert.strictEqual(pools.status, 200);
  assert.strictEqual(pools.data.pools.length, 6);
  const ganhuo = pools.data.pools.find((p) => p.id === 'ganhuo');
  assert.strictEqual(ganhuo.name, '干货');

  const gen = await api('POST', '/api/moments/generate', { poolId: 'ganhuo' }, opToken);
  assert.strictEqual(gen.status, 201);
  assert.ok(gen.data.likeness >= 90, `生成文案像你度 ≥ 90(门禁), 实际 ${gen.data.likeness}`);
  assert.ok(gen.data.moment.text.length > 20);
  assert.strictEqual(gen.data.mix.pool, '干货');

  const unknown = await api('POST', '/api/moments/generate', { poolId: 'nope' }, opToken);
  assert.strictEqual(unknown.status, 422);

  const mid = gen.data.moment.id;
  const before = (await api('GET', '/api/pools', undefined, opToken)).data.pools.find((p) => p.id === 'ganhuo').count;

  const swap = await api('POST', `/api/moments/${mid}/swap`, {}, opToken);
  assert.strictEqual(swap.status, 200);
  assert.notStrictEqual(swap.data.moment.text, gen.data.moment.text, '换一换切换变体');

  const pub = await api('POST', `/api/moments/${mid}/publish`, {}, opToken);
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(pub.data.moment.published, true);

  const after = (await api('GET', '/api/pools', undefined, opToken)).data.pools.find((p) => p.id === 'ganhuo').count;
  assert.strictEqual(after, before - 1, '水位 -1');

  const again = await api('POST', `/api/moments/${mid}/publish`, {}, opToken);
  assert.strictEqual(again.status, 409, '重复发布幂等拦截 409');
  assert.strictEqual(again.data.error.code, 'ALREADY_PUBLISHED');

  const swapAfterPub = await api('POST', `/api/moments/${mid}/swap`, {}, opToken);
  assert.strictEqual(swapAfterPub.status, 409, '已发不可换');

  /* 配比策略: 不带 poolId 时按 ratio 轮转 */
  const auto = await api('POST', '/api/moments/generate', {}, opToken);
  assert.strictEqual(auto.status, 201);
  assert.ok(['干货', '案例', '生活', '点评', '成交', '拒审'].includes(auto.data.mix.pool));
});

/* ==================== 公开课 ==================== */
test('公开课: 撞期 422 + 冲突场次信息; 合法创建', async () => {
  const clash = await api('POST', '/api/sessions', { projectId: 'p-zeyu', title: '撞期测试课: 与 s1 重叠', audience: '测试人群', warmStart: '2026-08-21' }, opToken);
  assert.strictEqual(clash.status, 422);
  assert.strictEqual(clash.data.error.code, 'SESSION_CLASH');
  assert.ok(clash.data.error.clash && clash.data.error.clash.openDay, '返回冲突场次信息');

  const bad = await api('POST', '/api/sessions', { projectId: 'p-zeyu', title: '', warmStart: '2026-09-14' }, opToken);
  assert.strictEqual(bad.status, 400);

  const created = await api('POST', '/api/sessions', { projectId: 'p-zeyu', title: '系统课: 从流量到成交', audience: '有流量的博主', warmStart: '2026-09-14' }, opToken);
  assert.strictEqual(created.status, 201);
  const s = created.data.session;
  assert.strictEqual(s.openDay, '2026-09-17', '开课 = 预热 + 3');
  assert.strictEqual(s.endDay, '2026-09-21', '收官 = 预热 + 7');
  assert.strictEqual(s.status, '筹备中');
  globalThis.__sessionId = s.id;

  const dup = await api('POST', '/api/sessions', { projectId: 'p-zeyu', title: '另一场: 与新课撞期', warmStart: '2026-09-16' }, opToken);
  assert.strictEqual(dup.status, 422, '与刚建场次撞期被拦');
});

test('物料: 换一换 → 标已发(幂等 409) → 本日进度', async () => {
  const sid = globalThis.__sessionId;
  const list = await api('GET', `/api/sessions/${sid}/materials?day=D1`, undefined, opToken);
  assert.strictEqual(list.status, 200);
  assert.ok(list.data.channels.pyq && list.data.channels.dm && list.data.channels.poster);

  const swap = await api('POST', `/api/sessions/${sid}/materials/D1/pyq/swap`, {}, opToken);
  assert.strictEqual(swap.status, 200);
  assert.ok(swap.data.material.current, '返回当前变体');

  const badDay = await api('POST', `/api/sessions/${sid}/materials/D9/pyq/swap`, {}, opToken);
  assert.strictEqual(badDay.status, 400);

  const pub = await api('POST', `/api/sessions/${sid}/materials/D1/pyq/publish`, {}, opToken);
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(pub.data.dayPublished, '1/3');

  const again = await api('POST', `/api/sessions/${sid}/materials/D1/pyq/publish`, {}, opToken);
  assert.strictEqual(again.status, 409, '物料重复发布 409');
});

test('正课: 生成正文 → 发布(幂等) → 配图上限 3', async () => {
  const sid = globalThis.__sessionId;
  const course = await api('GET', `/api/sessions/${sid}/course`, undefined, opToken);
  assert.strictEqual(course.status, 200);
  assert.strictEqual(course.data.course.length, 5);
  assert.strictEqual(course.data.published, '0/5');

  const early = await api('POST', `/api/sessions/${sid}/course/1/publish`, {}, opToken);
  assert.strictEqual(early.status, 422, '未生成正文不可发布');
  assert.strictEqual(early.data.error.code, 'COURSE_BODY_REQUIRED');

  const gen = await api('POST', `/api/sessions/${sid}/course/1/generate`, {}, opToken);
  assert.strictEqual(gen.status, 200);
  assert.ok(String(gen.data.body).includes('【公开课 D1'));

  const pub = await api('POST', `/api/sessions/${sid}/course/1/publish`, {}, opToken);
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(pub.data.day.status, '已发');
  assert.strictEqual(pub.data.published, '1/5');

  const again = await api('POST', `/api/sessions/${sid}/course/1/publish`, {}, opToken);
  assert.strictEqual(again.status, 409, '重复发布 409');

  for (let i = 0; i < 3; i++) {
    const ph = await api('POST', `/api/sessions/${sid}/course/1/photo`, {}, opToken);
    assert.strictEqual(ph.status, 200);
    assert.strictEqual(ph.data.day.photos, i + 1);
  }
  const over = await api('POST', `/api/sessions/${sid}/course/1/photo`, {}, opToken);
  assert.strictEqual(over.status, 422, '配图上限 3');
  assert.strictEqual(over.data.error.code, 'PHOTO_LIMIT');
});

/* ==================== 聚合与审计 ==================== */
test('dashboard: FR-D5 聚合(选题/出稿/六池/场次/记账)', async () => {
  const d = await api('GET', '/api/dashboard', undefined, opToken);
  assert.strictEqual(d.status, 200);
  const p = d.data.projects[0];
  assert.strictEqual(p.projectId, 'p-zeyu');
  assert.ok(p.topics.thisWeek >= 1);
  assert.ok(p.topics.byStatus['已出稿'] >= 2);
  assert.strictEqual(p.pools.length, 6);
  assert.ok(p.sessions.length >= 5);
  assert.ok(p.ledger.moments >= 3, '含种子记账 + 本次发布');
  assert.ok(p.ledger.course >= 1);
  assert.ok(p.signals.pub >= 1);
});

test('audit: 操作审计含操作者/时间/动作/对象(FR-D3)', async () => {
  const a = await api('GET', '/api/audit?limit=50', undefined, opToken);
  assert.strictEqual(a.status, 200);
  assert.ok(a.data.audit.length >= 10, '写操作全量留痕');
  const sample = a.data.audit[0];
  for (const k of ['time', 'actor', 'action', 'objectId']) assert.ok(sample[k], `审计字段 ${k}`);
  assert.ok(a.data.audit.some((x) => x.action === 'draft.finalReview' && x.actor === 'reviewer'));
  assert.ok(a.data.audit.some((x) => x.action === 'moment.publish'));
});

test('cost-report: token 消耗按项目(NFR-14)', async () => {
  const c = await api('GET', '/api/cost-report', undefined, opToken);
  assert.strictEqual(c.status, 200);
  assert.ok(c.data.total.tokens > 0, '本次链路有 token 消耗');
  assert.ok(c.data.total.calls > 0);
  const zy = c.data.projects.find((p) => p.projectId === 'p-zeyu');
  assert.ok(zy && zy.tokens > 0, '泽宇项目有记账');
  assert.ok(c.data.byPrompt['P-03'], '按 promptKey 记账');
});

/* ==================== 静态托管 ==================== */
test('静态托管: GET / 与 /assets/*', async () => {
  const home = await fetch(BASE + '/');
  assert.strictEqual(home.status, 200);
  assert.ok(String(home.headers.get('content-type')).includes('text/html'));
  const html = await home.text();
  assert.ok(html.includes('流量总台'), '门户页可访问(同源集成)');

  const css = await fetch(BASE + '/assets/app.css');
  assert.strictEqual(css.status, 200);
  assert.ok(String(css.headers.get('content-type')).includes('text/css'));

  const missing = await fetch(BASE + '/assets/nope.xyz');
  assert.strictEqual(missing.status, 404);
  const traversal = await fetch(BASE + '/assets/..%2f..%2fconfig.js');
  assert.ok([403, 404].includes(traversal.status), '路径穿越被拒');
});
