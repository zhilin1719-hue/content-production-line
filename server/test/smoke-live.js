/* 集成验收冒烟: login → 出稿全链 → 朋友圈 → 公开课 → 隔离 */
'use strict';
const BASE = 'http://localhost:8399';
const results = [];
function ok(name, cond, extra) { results.push({ name, pass: !!cond, extra: extra || '' }); }

async function api(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
}

(async () => {
  /* 1. 登录与账号体系 */
  const op = await api('POST', '/api/auth/login', { username: 'operator', password: 'op123' });
  ok('login operator', op.status === 200 && op.data.token, JSON.stringify(op.data.projects || ''));
  const opT = op.data.token;
  const rev = await api('POST', '/api/auth/login', { username: 'reviewer', password: 'rev123' });
  const revT = rev.data.token;
  const badLogin = await api('POST', '/api/auth/login', { username: 'operator', password: 'wrong' });
  ok('错误密码 401', badLogin.status === 401);

  /* 2. 公域台全链路 */
  const topics = await api('GET', '/api/topics?projectId=p-zeyu', undefined, opT);
  ok('选题池列表', topics.status === 200 && topics.data.list.length >= 3, `${topics.data.list.length} 条`);
  const t1 = topics.data.list.find((t) => t.status === '选题');
  const ideas = await api('POST', `/api/topics/${t1.id}/ideas`, {}, opT);
  ok('三选一生成', ideas.status === 200 && ideas.data.ideas.length === 3, ideas.data.ideas[0].tag);
  const frame = await api('POST', `/api/topics/${t1.id}/frame`, { ideaIndex: 0 }, opT);
  ok('二选一生成', frame.status === 200 && frame.data.frames.length === 2);
  const draft = await api('POST', `/api/topics/${t1.id}/draft`, { frameIndex: 0 }, opT);
  ok('初稿生成(像你度门禁)', draft.status === 201 && draft.data.likeness >= 90, `like=${draft.data.likeness}`);
  const dId = draft.data.draft.id;
  const scan = await api('POST', `/api/drafts/${dId}/compliance`, {}, opT);
  ok('合规第一层(含极限词命中)', scan.status === 200 && scan.data.totalHits >= 1, `hits=${scan.data.totalHits}`);
  const fix = await api('POST', `/api/drafts/${dId}/apply-fixes`, {}, opT);
  ok('采纳修复重扫清零', fix.status === 200 && fix.data.passed);
  const review = await api('POST', `/api/drafts/${dId}/review`, {}, opT);
  ok('第二层复核(原创度)', review.status === 200 && review.data.review.pass, `overlap=${review.data.review.originality.overlapPct}%`);
  const opFinal = await api('POST', `/api/drafts/${dId}/final-review`, { decision: 'pass' }, opT);
  ok('operator 终审被拒 403', opFinal.status === 403);
  const fin = await api('POST', `/api/drafts/${dId}/final-review`, { decision: 'pass' }, revT);
  ok('reviewer 终审 → 合规过审版', fin.status === 200 && fin.data.draft.status === '合规过审版');
  const exp = await api('GET', `/api/drafts/${dId}/export`, undefined, opT);
  ok('导出 text/plain', exp.status === 200 && String(exp.data).length > 100);

  /* 3. 朋友圈 */
  const pools = await api('GET', '/api/pools?projectId=p-zeyu', undefined, opT);
  ok('六池水位', pools.status === 200 && pools.data.pools.length === 6);
  const before = pools.data.pools.find((p) => p.id === 'ganhuo').count;
  const mo = await api('POST', '/api/moments/generate', { poolId: 'ganhuo' }, opT);
  ok('朋友圈生成', mo.status === 201 && mo.data.likeness >= 90, `like=${mo.data.likeness} pool=${mo.data.mix.pool}`);
  const pub = await api('POST', `/api/moments/${mo.data.moment.id}/publish`, {}, opT);
  ok('标已发记账(水位-1)', pub.status === 200);
  const again = await api('POST', `/api/moments/${mo.data.moment.id}/publish`, {}, opT);
  ok('重复发布幂等 409', again.status === 409);
  const pools2 = await api('GET', '/api/pools?projectId=p-zeyu', undefined, opT);
  const after = pools2.data.pools.find((p) => p.id === 'ganhuo').count;
  ok('水位回写校验', after === before - 1, `${before} → ${after}`);

  /* 4. 公开课 */
  const clash = await api('POST', '/api/sessions', { projectId: 'p-zeyu', title: '撞期课', audience: '测试', warmStart: '2026-08-21' }, opT);
  ok('撞期阻断 422', clash.status === 422 && clash.data.error.code === 'SESSION_CLASH');
  /* 动态找可用日期(冒烟可重复执行): 从今天+30 天起, 每周后移, 最多试 6 次 */
  let sess = null, warmStart = '';
  for (let i = 0; i < 6 && !sess; i++) {
    const d = new Date(Date.now() + (30 + i * 7) * 86400000);
    warmStart = d.toISOString().slice(0, 10);
    const r = await api('POST', '/api/sessions', { projectId: 'p-zeyu', title: '验收演示课: 高客单成交系统', audience: '有流量的博主', warmStart }, opT);
    if (r.status === 201) sess = r; else if (r.status !== 422) { sess = r; break; }
  }
  ok('建场次(开课=+3)', sess.status === 201, sess.status === 201 ? `warm=${warmStart} open=${sess.data.session.openDay}` : JSON.stringify(sess.data));
  const sId = sess.data.session.id;
  const mat = await api('GET', `/api/sessions/${sId}/materials?day=D1`, undefined, opT);
  ok('三渠道物料', mat.status === 200 && mat.data.channels.pyq && mat.data.channels.dm && mat.data.channels.poster);
  const mPub = await api('POST', `/api/sessions/${sId}/materials/D1/pyq/publish`, {}, opT);
  ok('物料标已发 1/3', mPub.status === 200 && mPub.data.dayPublished === '1/3');
  const body5 = await api('POST', `/api/sessions/${sId}/course/5/generate`, {}, opT);
  ok('正课正文生成', body5.status === 200 && body5.data.body.length > 50, `${body5.data.body.length} 字`);
  const cPub = await api('POST', `/api/sessions/${sId}/course/5/publish`, {}, opT);
  ok('正课发布 1/5', cPub.status === 200 && cPub.data.day.status === '已发');

  /* 5. 公共能力 */
  const dash = await api('GET', '/api/dashboard', undefined, opT);
  const d0 = dash.data.projects && dash.data.projects[0];
  ok('看板聚合 FR-D5', dash.status === 200 && d0 && d0.topics.byStatus, d0 ? `选题${d0.topics.byStatus['选题']}/出稿${d0.topics.byStatus['已出稿']}` : JSON.stringify(dash.data).slice(0, 80));
  const audit = await api('GET', '/api/audit', undefined, opT);
  ok('审计日志 FR-D3', audit.status === 200 && audit.data.audit.length >= 8, `${audit.data.audit.length} 条`);
  const cost = await api('GET', '/api/cost-report', undefined, opT);
  ok('成本报表 NFR-14', cost.status === 200 && cost.data.total, `calls=${cost.data.total.calls} tokens=${cost.data.total.tokens} failovers=${cost.data.total.failovers}`);

  /* 6. 多项目隔离 */
  const op2 = await api('POST', '/api/auth/login', { username: 'operator2', password: 'op123' });
  const cross = await api('GET', `/api/topics/${t1.id}`, undefined, op2.data.token);
  ok('跨项目访问 404', cross.status === 404);
  const view = await api('POST', '/api/auth/login', { username: 'viewer', password: 'view123' });
  const viewWrite = await api('POST', `/api/topics/${t1.id}/discard`, {}, view.data.token);
  ok('viewer 只读 403', viewWrite.status === 403);

  /* 汇总 */
  const pass = results.filter((r) => r.pass).length;
  console.log(results.map((r) => `${r.pass ? '✓' : '✗'} ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`).join('\n'));
  console.log(`\n集成冒烟: ${pass}/${results.length} 通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
