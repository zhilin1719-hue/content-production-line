/* ============================================================
   流量总台 · 内容生产线 — 零依赖 HTTP API + 静态托管 (合同交付物 D2)
   只用 node 内置模块。启动: node server.js (默认 127.0.0.1:8399)
   静态托管 ../app (原型门户同端口): GET / 与 /assets/*
   错误结构统一: { error: { code, message, hint } }
   ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const CONFIG = require('./config');
const engines = require('./engines');
const store = require('./store');
const gateway = require('./llm-gateway');
const seed = require('./seed');

const VERSION = '1.0.0-d2';
const startedAt = Date.now();

/* ==================== 小工具 ==================== */

let seqCounter = 0;
function nid(prefix) {
  seqCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${seqCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
function nowISO() { return new Date().toISOString(); }
function todayHHMM() {
  const d = new Date();
  return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function sceneNow() {
  const d = new Date();
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  const kind = [0, 6].includes(d.getDay()) ? '周末' : '工作日';
  return `${kind} · ${wd}`;
}
function deepCopy(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
function publicUser(u) { return u ? { username: u.username, name: u.name, role: u.role, projects: u.projects } : null; }

/* ==================== HTTP 基元 ==================== */

function sendJSON(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}
function fail(res, status, code, message, hint, extra) {
  const err = { code, message };
  if (hint) err.hint = hint;
  if (extra) Object.assign(err, extra);
  sendJSON(res, status, { error: err });
}
function ok(res, obj, status) { sendJSON(res, status || 200, obj); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(Object.assign(new Error('BODY_TOO_LARGE'), { code: 'BODY_TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Object.assign(new Error('INVALID_JSON'), { code: 'INVALID_JSON' })); }
    });
    req.on('error', reject);
  });
}

/* ==================== 鉴权 (HMAC 签名 token) ==================== */

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', CONFIG.AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', CONFIG.AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || ''); const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || typeof payload.u !== 'string') return null;
    if (payload.exp && Date.now() > payload.exp) return null;
    const users = store.get('users', []);
    const user = users.find((x) => x.username === payload.u);
    return user || null;
  } catch (e) { return null; }
}
function bearerToken(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/* ==================== 权限 / 项目域 / 审计 ==================== */

function requireCap(ctx, cap) {
  const caps = CONFIG.ROLE_MATRIX[ctx.user.role] || {};
  return !!caps[cap];
}
/** 查询参数中的 projectId → 授权项目域; 未授权 404 */
function scopeFromQuery(q, ctx) {
  const pid = q.get('projectId');
  if (pid) return ctx.projects.includes(pid) ? [pid] : null;
  return ctx.projects;
}
/** 资源查找: 不存在或跨项目 → null(统一 404 口径) */
function findOwned(name, id, ctx) {
  const list = store.get(name, []);
  const item = list.find((x) => x.id === id);
  if (!item || !ctx.projects.includes(item.projectId)) return null;
  return item;
}
function getProject(projectId) {
  return (store.get('projects', [])).find((p) => p.id === projectId) || null;
}
function audit(ctx, action, objectType, objectId, projectId, detail) {
  const list = store.get('audit', []);
  list.unshift({
    id: nid('au'), time: nowISO(),
    actor: ctx && ctx.user ? ctx.user.username : 'anonymous',
    actorName: ctx && ctx.user ? ctx.user.name : '',
    role: ctx && ctx.user ? ctx.user.role : '',
    action, objectType, objectId: objectId || '', projectId: projectId || '',
    detail: detail || '',
  });
  store.set('audit', list.slice(0, 2000));
}
function getSignals(projectId) {
  const list = store.get('signals', []);
  let s = list.find((x) => x.projectId === projectId);
  if (!s) { s = { projectId, swap: 0, edit: 0, pub: 0 }; list.push(s); store.set('signals', list); }
  return s;
}
function addLedger(projectId, type, refId, text, pool) {
  const list = store.get('ledger', []);
  list.unshift({ id: nid('lg'), projectId, type, refId: refId || '', time: nowISO(), displayTime: todayHHMM(), text: String(text || '').replace(/\s+/g, ' ').slice(0, 40) + '……', pool: pool || '' });
  store.set('ledger', list);
}
function bumpCounter(key, projectId) {
  const c = store.get('counters', {});
  c[key] = c[key] || {};
  c[key][projectId] = (c[key][projectId] || 0) + 1;
  store.set('counters', c);
  return c[key][projectId];
}

/* ==================== 业务辅助 ==================== */

function topicOut(t) {
  const o = { ...t };
  return o;
}
function draftOut(d) {
  return { ...d };
}
function poolOut(p) {
  const pct = Math.round((p.count / p.cap) * 100);
  return { ...p, pct, low: p.count / p.cap < 0.2 };
}
function ensureCourseRow(session, day) {
  const list = store.get('course', []);
  let row = list.find((r) => r.sessionId === session.id && r.day === day);
  if (!row) {
    row = {
      id: `c-${session.id}-${day}`, projectId: session.projectId, sessionId: session.id, day,
      theme: `第 ${day} 天: 把「${String(session.title || '').split(/[:：]/)[0]}」拆到可执行`,
      hook: session.hook || '《高净值变现路线图》', caseRef: '', status: '未发', photos: 0,
    };
    list.push(row);
    store.set('course', list);
  }
  return row;
}
function ensureCourseRows(session) {
  for (let d = 1; d <= 5; d++) ensureCourseRow(session, d);
  return store.get('course', []).filter((r) => r.sessionId === session.id).sort((a, b) => a.day - b.day);
}
function ensureMaterial(session, day, channel) {
  const list = store.get('materials', []);
  let m = list.find((x) => x.sessionId === session.id && x.day === day && x.channel === channel);
  if (!m) {
    m = { id: `${session.id}|${day}|${channel}`, projectId: session.projectId, sessionId: session.id, day, channel, variantIdx: 0, published: false, publishedAt: null };
    list.push(m);
    store.set('materials', list);
  }
  return m;
}
function materialsOfDay(session, day) {
  const gen = engines.generateMaterials(session, day);
  const list = store.get('materials', []);
  const out = {};
  for (const channel of ['pyq', 'dm', 'poster']) {
    const m = list.find((x) => x.sessionId === session.id && x.day === day && x.channel === channel)
      || ensureMaterial(session, day, channel);
    const variants = gen[channel].variants;
    const idx = m.variantIdx % variants.length;
    out[channel] = {
      channel, name: gen[channel].name, variantIdx: idx, variantTotal: variants.length,
      current: variants[idx], published: !!m.published, publishedAt: m.publishedAt || null,
    };
  }
  return { day, channels: out };
}
function sessionProgress(s) {
  const rows = store.get('course', []).filter((r) => r.sessionId === s.id);
  if (s.status === '正课中') {
    const published = rows.filter((r) => r.status === '已发').length;
    return `已发 ${published}/5`;
  }
  return s.progress || s.status;
}
function sessionOut(s) {
  const rows = ensureCourseRows(s);
  return { ...s, progress: sessionProgress(s), coursePublished: rows.filter((r) => r.status === '已发').length };
}

/* ==================== 路由处理器 ==================== */

const H = {};

/* ---------- 鉴权 ---------- */
H.login = async (ctx, req, res, q, body) => {
  const { username, password } = body || {};
  if (!username || !password) return fail(res, 400, 'VALIDATION', '用户名和密码必填', '请携带 {username, password}');
  const users = store.get('users', []);
  const user = users.find((u) => u.username === String(username));
  const hash = crypto.createHash('sha256').update(String(username) + ':' + String(password)).digest('hex');
  if (!user || user.passHash !== hash) return fail(res, 401, 'AUTH_FAILED', '用户名或密码错误', '演示账号: admin/admin123 · operator/op123 · reviewer/rev123 · viewer/view123');
  const token = signToken({ u: user.username, iat: Date.now(), exp: Date.now() + CONFIG.TOKEN_TTL_MS });
  audit({ user }, 'login', 'user', user.username, user.projects[0] || '', '登录成功');
  ok(res, { token, user: { username: user.username, name: user.name, role: user.role }, projects: user.projects });
};
H.me = async (ctx, req, res) => {
  const projects = (store.get('projects', [])).filter((p) => ctx.projects.includes(p.id)).map((p) => ({ id: p.id, name: p.name, host: p.host }));
  ok(res, { user: { username: ctx.user.username, name: ctx.user.name, role: ctx.user.role }, projects: ctx.projects, projectList: projects });
};

/* ---------- 项目 ---------- */
H.projectsList = async (ctx, req, res) => {
  const list = (store.get('projects', [])).filter((p) => ctx.projects.includes(p.id));
  ok(res, { projects: list.map((p) => ({ id: p.id, name: p.name, host: p.host, track: p.track, desc: p.desc })) });
};
H.projectsCreate = async (ctx, req, res, q, body) => {
  if (!requireCap(ctx, 'manage')) return fail(res, 403, 'FORBIDDEN', '仅管理员可创建项目', '使用 admin 账号操作');
  const { name, host } = body || {};
  if (!name || !String(name).trim()) return fail(res, 400, 'VALIDATION', '项目名称必填', '请携带 {name, host}');
  const projects = store.get('projects', []);
  const id = 'p-' + crypto.createHash('md5').update(String(name) + Date.now()).digest('hex').slice(0, 8);
  const voice = {
    role: String(host || '主讲').slice(0, 12), leadMagnet: '《资料包》', hookWord: '资料',
    lexicon: engines.DEFAULT_LEXICON, golden: engines.DEFAULT_GOLDEN, samples: [], cases: [engines.DEFAULT_CASE],
  };
  projects.push({
    id, name: String(name).trim(), host: String(host || '主讲').trim(), track: body.track || '未分赛道', desc: body.desc || '',
    voice, ideas: engines.DEFAULT_IDEAS, hooks: ['《资料包》'], momentVariants: engines.DEFAULT_MOMENT_VARIANTS,
    sources: [
      { id: 'voice', name: '声纹引擎', icon: '声', status: 'ok', desc: '声纹建模中' },
      { id: 'case', name: '案例库', icon: '案', status: 'ok', desc: '案例待录入' },
      { id: 'life', name: '生活素材库', icon: '图', status: 'ok', desc: '素材待录入' },
      { id: 'cockpit', name: '驾驶舱', icon: '舱', status: 'ok', desc: '已连通' },
      { id: 'audit', name: '审核记录', icon: '拒', status: 'ok', desc: '暂无记录' },
    ],
  });
  store.set('projects', projects);
  const pools = store.get('pools', []);
  for (const def of CONFIG.POOL_DEFS) pools.push({ projectId: id, id: def.id, name: def.name, count: Math.floor(def.cap / 2), cap: def.cap, ratio: def.ratio });
  store.set('pools', pools);
  const users = store.get('users', []);
  const u = users.find((x) => x.username === ctx.user.username);
  if (u && !u.projects.includes(id)) { u.projects.push(id); store.set('users', users); }
  const signals = store.get('signals', []); signals.push({ projectId: id, swap: 0, edit: 0, pub: 0 }); store.set('signals', signals);
  audit(ctx, 'project.create', 'project', id, id, `新建项目 ${name}`);
  ok(res, { project: { id, name: name.trim(), host: host || '主讲' } }, 201);
};

/* ---------- 对标账号 ---------- */
H.accountsList = async (ctx, req, res, q) => {
  const scope = scopeFromQuery(q, ctx);
  if (!scope) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const list = (store.get('accounts', [])).filter((a) => scope.includes(a.projectId));
  ok(res, { accounts: list, total: list.length });
};
H.accountsCreate = async (ctx, req, res, q, body) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const { projectId, name, full, platform, track, fans, works } = body || {};
  if (!projectId) return fail(res, 400, 'VALIDATION', 'projectId 必填', '请携带 {projectId, name, ...}');
  if (!ctx.projects.includes(projectId)) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const fullName = String(full || name || '').trim();
  if (!fullName) return fail(res, 400, 'VALIDATION', '账号名必填', '请携带 name 或 full');
  const masked = fullName.length <= 1 ? fullName + '*' : fullName[0] + '*' + fullName[fullName.length - 1];
  const accounts = store.get('accounts', []);
  const acct = {
    id: nid('a'), projectId, name: masked, full: fullName,
    platform: platform || '抖音', track: String(track || '未分赛道').trim(),
    fans: Number(fans) || 0, works: Number(works) || 0,
    watching: body.watching !== false, lastScan: '已开盯, 待自动扫描', status: 'idle',
  };
  accounts.push(acct);
  store.set('accounts', accounts);
  audit(ctx, 'account.create', 'account', acct.id, projectId, `添加对标账号 ${masked}`);
  ok(res, { account: acct }, 201);
};
H.accountPatch = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const acct = findOwned('accounts', id, ctx);
  if (!acct) return fail(res, 404, 'NOT_FOUND', '账号不存在', '检查账号 id 或项目权限');
  if (typeof (body || {}).watching !== 'boolean') return fail(res, 400, 'VALIDATION', 'watching 必须为布尔', 'PATCH {watching: true|false}');
  acct.watching = body.watching;
  acct.status = body.watching ? 'idle' : 'paused';
  acct.lastScan = body.watching ? '已开盯, 待自动扫描' : '开盯后自动扫描';
  store.set('accounts', store.get('accounts', []));
  audit(ctx, 'account.watch', 'account', acct.id, acct.projectId, body.watching ? '开盯' : '暂停盯');
  ok(res, { account: acct });
};
H.accountScan = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const acct = findOwned('accounts', id, ctx);
  if (!acct) return fail(res, 404, 'NOT_FOUND', '账号不存在', '检查账号 id 或项目权限');
  const project = getProject(acct.projectId);
  const seedNum = Date.now() ^ (Math.floor(Math.random() * 0xffff) << 8);
  const count = 1 + (seedNum % 2);
  const gw = await gateway.call('P-08', { account: { id: acct.id, name: acct.name, track: acct.track }, opts: { seed: seedNum, count } }, { projectId: acct.projectId });
  const candidates = gw.result;
  const topics = store.get('topics', []);
  const out = [];
  for (const c of candidates) {
    if (c.rel >= CONFIG.THRESHOLDS.relevanceMin) {
      const t = {
        id: nid('t'), projectId: acct.projectId, srcTitle: c.srcTitle, srcLikes: c.srcLikes,
        srcTime: c.srcTime, srcAcct: c.srcAcct, srcExcerpt: c.srcTitle + '……',
        newTitle: c.newTitle, status: '选题', rel: c.rel, createdAt: nowISO(),
      };
      topics.push(t);
      out.push({ srcTitle: c.srcTitle, newTitle: c.newTitle, rel: c.rel, admitted: true, topicId: t.id });
    } else {
      out.push({ srcTitle: c.srcTitle, newTitle: c.newTitle, rel: c.rel, admitted: false });
    }
  }
  store.set('topics', topics);
  const admitted = out.filter((x) => x.admitted).length;
  const scanLog = {
    id: nid('sl'), projectId: acct.projectId, accountId: acct.id, time: nowISO(),
    found: candidates.length, admitted,
    rejected: out.filter((x) => !x.admitted).map((x) => ({ title: x.srcTitle, rel: x.rel, reason: `相关度低于阈值 ${CONFIG.THRESHOLDS.relevanceMin}, 挂不上钩, 留痕不入池` })),
  };
  const logs = store.get('scan_log', []);
  logs.unshift(scanLog);
  store.set('scan_log', logs.slice(0, 500));
  acct.lastScan = '刚刚来过';
  acct.status = 'idle';
  store.set('accounts', store.get('accounts', []));
  audit(ctx, 'account.scan', 'account', acct.id, acct.projectId, `扫描 ${candidates.length} 条, 入池 ${admitted} 条, 筛除 ${candidates.length - admitted} 条(留痕)`);
  ok(res, { scanLogId: scanLog.id, found: candidates.length, admitted, rejected: candidates.length - admitted, candidates: out });
};

/* ---------- 选题池 ---------- */
H.topicsList = async (ctx, req, res, q) => {
  const scope = scopeFromQuery(q, ctx);
  if (!scope) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const status = q.get('status') || '';
  const page = Math.max(1, Number(q.get('page')) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(q.get('pageSize')) || CONFIG.THRESHOLDS.pageSize));
  let list = (store.get('topics', [])).filter((t) => scope.includes(t.projectId));
  if (status) list = list.filter((t) => t.status === status);
  else list = list.filter((t) => t.status !== '已筛除');
  list.sort((a, b) => (b.srcLikes || 0) - (a.srcLikes || 0) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const total = list.length;
  const slice = list.slice((page - 1) * pageSize, page * pageSize);
  ok(res, { list: slice.map(topicOut), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
};
H.topicGet = async (ctx, req, res, q, body, id) => {
  const t = findOwned('topics', id, ctx);
  if (!t) return fail(res, 404, 'NOT_FOUND', '选题不存在', '检查选题 id 或项目权限');
  ok(res, { topic: topicOut(t) });
};
H.topicDiscard = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const t = findOwned('topics', id, ctx);
  if (!t) return fail(res, 404, 'NOT_FOUND', '选题不存在', '检查选题 id 或项目权限');
  if (!engines.canTopicTransition(t.status, 'discard')) {
    return fail(res, 422, 'INVALID_STATE', `状态「${t.status}」不允许淘汰`, '仅「选题」状态可淘汰; 90 天内可恢复');
  }
  t.status = engines.transitionTopic(t.status, 'discard');
  t.discardedAt = nowISO();
  t.restoreDeadline = new Date(Date.now() + CONFIG.THRESHOLDS.restoreDays * 24 * 3600 * 1000).toISOString();
  store.set('topics', store.get('topics', []));
  audit(ctx, 'topic.discard', 'topic', t.id, t.projectId, `移入已淘汰, 保留 ${CONFIG.THRESHOLDS.restoreDays} 天可恢复`);
  ok(res, { topic: topicOut(t) });
};
H.topicRestore = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const t = findOwned('topics', id, ctx);
  if (!t) return fail(res, 404, 'NOT_FOUND', '选题不存在', '检查选题 id 或项目权限');
  if (!engines.canTopicTransition(t.status, 'restore')) {
    return fail(res, 422, 'INVALID_STATE', `状态「${t.status}」不允许恢复`, '仅「已淘汰」状态可恢复');
  }
  if (t.restoreDeadline && Date.now() > new Date(t.restoreDeadline).getTime()) {
    return fail(res, 422, 'RESTORE_EXPIRED', '恢复期限已过(90 天)', '该选题已自动清除出池');
  }
  t.status = engines.transitionTopic(t.status, 'restore');
  delete t.restoreDeadline;
  store.set('topics', store.get('topics', []));
  audit(ctx, 'topic.restore', 'topic', t.id, t.projectId, '恢复回选题池');
  ok(res, { topic: topicOut(t) });
};

/* ---------- 出稿工作台 ---------- */
H.topicIdeas = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const t = findOwned('topics', id, ctx);
  if (!t) return fail(res, 404, 'NOT_FOUND', '选题不存在', '检查选题 id 或项目权限');
  if (t.status !== '选题') return fail(res, 422, 'INVALID_STATE', `状态「${t.status}」不能进入出稿流程`, '只有「选题」状态可出稿');
  const project = getProject(t.projectId);
  const gw = await gateway.call('P-01', { topic: { id: t.id, newTitle: t.newTitle, srcTitle: t.srcTitle, role: project.voice.role }, ideas: project.ideas }, { projectId: t.projectId });
  t.ideas = gw.result;
  t.idea = null;
  t.frames = null;
  store.set('topics', store.get('topics', []));
  audit(ctx, 'topic.ideas', 'topic', t.id, t.projectId, '生成 3 个理念选题方向');
  ok(res, { ideas: t.ideas, provider: gw.provider });
};
H.topicFrame = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const t = findOwned('topics', id, ctx);
  if (!t) return fail(res, 404, 'NOT_FOUND', '选题不存在', '检查选题 id 或项目权限');
  if (!Array.isArray(t.ideas) || !t.ideas.length) return fail(res, 422, 'IDEAS_REQUIRED', '尚未生成理念选项', '先 POST /api/topics/:id/ideas 生成三选一');
  const ideaIndex = Number((body || {}).ideaIndex) || 0;
  if (ideaIndex < 0 || ideaIndex >= t.ideas.length) return fail(res, 400, 'VALIDATION', `ideaIndex 超出范围(0-${t.ideas.length - 1})`, '三选一: {ideaIndex: 0|1|2}');
  t.idea = t.ideas[ideaIndex];
  const project = getProject(t.projectId);
  const gw = await gateway.call('P-02', { topic: { id: t.id, newTitle: t.newTitle, srcTitle: t.srcTitle, role: project.voice.role } }, { projectId: t.projectId });
  t.frames = gw.result;
  store.set('topics', store.get('topics', []));
  audit(ctx, 'topic.frame', 'topic', t.id, t.projectId, `选定理念「${t.idea.tag}」, 生成 2 套框架`);
  ok(res, { idea: t.idea, frames: t.frames, provider: gw.provider });
};
H.topicDraft = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const t = findOwned('topics', id, ctx);
  if (!t) return fail(res, 404, 'NOT_FOUND', '选题不存在', '检查选题 id 或项目权限');
  if (!t.idea) return fail(res, 422, 'IDEA_REQUIRED', '尚未选定理念', '先 POST /api/topics/:id/frame 选定三选一');
  const project = getProject(t.projectId);
  const frameIndex = Number((body || {}).frameIndex) || 0;
  const frames = Array.isArray(t.frames) && t.frames.length ? t.frames : engines.generateFrames(t);
  if (frameIndex < 0 || frameIndex >= frames.length) return fail(res, 400, 'VALIDATION', `frameIndex 超出范围(0-${frames.length - 1})`, '二选一: {frameIndex: 0|1}');
  const frame = frames[frameIndex];
  t.frame = frame;
  /* NFR-17: 像你度 < 90 自动重生一次。degradeFirstAttempt 为演示/测试开关 */
  const degraded = !!(body || {}).degradeFirstAttempt;
  const gw1 = await gateway.call('P-03', {
    topic: { id: t.id, newTitle: t.newTitle, srcTitle: t.srcTitle, role: project.voice.role },
    idea: t.idea, frame,
    voice: degraded ? { samples: [], lexicon: [], golden: [] } : project.voice,
  }, { projectId: t.projectId });
  let text = gw1.result;
  let like = engines.likeness(text, project.voice);
  let firstLikeness = like;
  let regenerated = false;
  if (like < CONFIG.THRESHOLDS.likenessMin) {
    const gw2 = await gateway.call('P-03', {
      topic: { id: t.id, newTitle: t.newTitle, srcTitle: t.srcTitle, role: project.voice.role },
      idea: t.idea, frame, voice: project.voice,
    }, { projectId: t.projectId });
    text = gw2.result;
    like = engines.likeness(text, project.voice);
    regenerated = true;
  }
  const drafts = store.get('drafts', []);
  const draft = {
    id: nid('d'), projectId: t.projectId, topicId: t.id, idea: t.idea, frame,
    text, likeness: like, firstLikeness, regenerated,
    status: '初稿', compliancePassed: false, reviewPassed: false, review: null,
    provider: gw1.provider, createdAt: nowISO(),
  };
  drafts.push(draft);
  store.set('drafts', drafts);
  store.set('topics', store.get('topics', []));
  audit(ctx, 'topic.draft', 'draft', draft.id, t.projectId, `生成初稿(像你度 ${like}%, ${regenerated ? '低分自动重生一次' : '一次通过'})`);
  ok(res, { draft: draftOut(draft), likeness: like, regenerated, firstLikeness }, 201);
};

/* ---------- 合规三层 ---------- */
H.draftCompliance = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const d = findOwned('drafts', id, ctx);
  if (!d) return fail(res, 404, 'NOT_FOUND', '稿件不存在', '检查稿件 id 或项目权限');
  const hits = engines.complianceScan(d.text, CONFIG.RULES);
  if (hits.length === 0) d.compliancePassed = true;
  d.lastScan = { time: nowISO(), hits };
  store.set('drafts', store.get('drafts', []));
  const total = hits.reduce((s, h) => s + h.count, 0);
  audit(ctx, 'draft.compliance', 'draft', d.id, d.projectId, `第一层规则扫描: 命中 ${total} 处`);
  ok(res, { hits, totalHits: total, passed: hits.length === 0, compliancePassed: !!d.compliancePassed });
};
H.draftApplyFixes = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const d = findOwned('drafts', id, ctx);
  if (!d) return fail(res, 404, 'NOT_FOUND', '稿件不存在', '检查稿件 id 或项目权限');
  if (d.status === '合规过审版') return fail(res, 422, 'INVALID_STATE', '合规过审版不可再修改', '该稿件已归档交接剪辑');
  const r = engines.applyRuleFixes(d.text, CONFIG.RULES);
  d.text = r.text;
  if (r.remaining.length === 0) d.compliancePassed = true;
  d.lastScan = { time: nowISO(), hits: r.remaining };
  store.set('drafts', store.get('drafts', []));
  const appliedStr = r.applied.length ? r.applied.map((a) => `${a.word}→${a.repl || '(删掉)'}×${a.count}`).join('、') : '无需替换';
  audit(ctx, 'draft.applyFixes', 'draft', d.id, d.projectId, `采纳修复: ${appliedStr}; 重扫剩余 ${r.remaining.length} 处`);
  ok(res, { applied: r.applied, remaining: r.remaining, passed: r.remaining.length === 0, compliancePassed: !!d.compliancePassed, text: d.text });
};
H.draftReview = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const d = findOwned('drafts', id, ctx);
  if (!d) return fail(res, 404, 'NOT_FOUND', '稿件不存在', '检查稿件 id 或项目权限');
  if (d.status !== '初稿') return fail(res, 422, 'INVALID_STATE', `状态「${d.status}」不能复核`, '仅「初稿」状态可进入第二层复核');
  if (!d.compliancePassed) return fail(res, 422, 'COMPLIANCE_REQUIRED', '第一层规则扫描未通过', '先 POST compliance 扫描并 apply-fixes 清零风险词');
  const t = (store.get('topics', [])).find((x) => x.id === d.topicId && x.projectId === d.projectId);
  const gw = await gateway.call('P-07', { draft: d.text, source: (t && t.srcExcerpt) || '', rules: CONFIG.RULES, riskWords: CONFIG.SEMANTIC_RISK_WORDS }, { projectId: d.projectId });
  const review = gw.result;
  d.review = { ...review, time: nowISO(), provider: gw.provider };
  if (review.pass) { d.status = engines.transitionDraft(d.status, 'reviewPass'); d.reviewPassed = true; }
  else { d.status = engines.transitionDraft(d.status, 'reviewReject'); d.reviewPassed = false; }
  store.set('drafts', store.get('drafts', []));
  audit(ctx, 'draft.review', 'draft', d.id, d.projectId, `第二层大模型复核: ${review.verdict}(重合率 ${review.originality.overlapPct}%, 语义风险 ${review.semanticRisk.count} 处)`);
  ok(res, { review: d.review, status: d.status });
};
H.draftFinalReview = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  if (!requireCap(ctx, 'review')) return fail(res, 403, 'FORBIDDEN_ROLE', '第三层人工终审仅 reviewer/admin 可操作', 'operator 负责产出, 终审请换 reviewer 或 admin 账号');
  const d = findOwned('drafts', id, ctx);
  if (!d) return fail(res, 404, 'NOT_FOUND', '稿件不存在', '检查稿件 id 或项目权限');
  const decision = (body || {}).decision;
  if (decision !== 'pass' && decision !== 'reject') return fail(res, 400, 'VALIDATION', 'decision 必须为 pass|reject', '{decision: "pass" | "reject"}');
  if (d.status !== '复核通过') return fail(res, 422, 'INVALID_STATE', `状态「${d.status}」不能终审`, '需先通过第二层复核(POST review)');
  const topics = store.get('topics', []);
  const t = topics.find((x) => x.id === d.topicId && x.projectId === d.projectId);
  if (decision === 'pass') {
    d.status = engines.transitionDraft(d.status, 'finalPass');
    d.finalReviewedBy = ctx.user.username;
    d.finalReviewedAt = nowISO();
    if (t && engines.canTopicTransition(t.status, 'publish')) t.status = engines.transitionTopic(t.status, 'publish');
    store.set('topics', topics);
    audit(ctx, 'draft.finalReview', 'draft', d.id, d.projectId, '第三层人工终审通过 → 合规过审版, 选题联动「已出稿」');
  } else {
    d.status = engines.transitionDraft(d.status, 'finalReject');
    audit(ctx, 'draft.finalReview', 'draft', d.id, d.projectId, '第三层人工终审打回');
  }
  store.set('drafts', store.get('drafts', []));
  ok(res, { draft: draftOut(d), topic: t ? { id: t.id, status: t.status } : null });
};
H.draftExport = async (ctx, req, res, q, body, id) => {
  const d = findOwned('drafts', id, ctx);
  if (!d) return fail(res, 404, 'NOT_FOUND', '稿件不存在', '检查稿件 id 或项目权限');
  if (d.status !== '合规过审版') return fail(res, 422, 'NOT_APPROVED', '仅合规过审版可导出', '三层全过后才允许交接剪辑队列');
  const t = (store.get('topics', [])).find((x) => x.id === d.topicId);
  const base = String((t && t.newTitle) || '口播稿').replace(/[\\/:*?"<>|]/g, '').slice(0, 40);
  const buf = Buffer.from(d.text, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="draft-${d.id}.txt"; filename*=UTF-8''${encodeURIComponent(`口播稿-${base}.txt`)}`,
  });
  res.end(buf);
};

/* ---------- 朋友圈 ---------- */
H.sources = async (ctx, req, res, q) => {
  const scope = scopeFromQuery(q, ctx);
  if (!scope) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const out = [];
  for (const pid of scope) {
    const p = getProject(pid);
    if (p) for (const s of (p.sources || [])) out.push({ ...s, projectId: pid });
  }
  ok(res, { sources: out });
};
H.pools = async (ctx, req, res, q) => {
  const scope = scopeFromQuery(q, ctx);
  if (!scope) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const list = (store.get('pools', [])).filter((p) => scope.includes(p.projectId)).map(poolOut);
  ok(res, { pools: list });
};
H.momentGenerate = async (ctx, req, res, q, body) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const b = body || {};
  let projectId = b.projectId;
  if (!projectId) {
    if (ctx.projects.length === 1) projectId = ctx.projects[0];
    else return fail(res, 400, 'PROJECT_REQUIRED', '请指定 projectId', '你有权访问多个项目, 携带 {projectId, poolId}');
  }
  if (!ctx.projects.includes(projectId)) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const project = getProject(projectId);
  const pools = (store.get('pools', [])).filter((p) => p.projectId === projectId);
  let pool;
  if (b.poolId) {
    pool = pools.find((p) => p.id === b.poolId);
    if (!pool) return fail(res, 422, 'UNKNOWN_POOL', `素材池 ${b.poolId} 不存在`, '可选: ' + pools.map((p) => p.id).join('/'));
  } else {
    /* 配比策略取材: 按 ratio 加权轮转 */
    const seq = bumpCounter('momentSeq', projectId);
    let acc = 0; const totalRatio = pools.reduce((s, p) => s + p.ratio, 0) || 100;
    const point = (seq - 1) % totalRatio;
    pool = pools[pools.length - 1];
    for (const p of pools) { acc += p.ratio; if (point < acc) { pool = p; break; } }
  }
  if (pool.count <= 0) return fail(res, 422, 'POOL_EMPTY', `「${pool.name}池」已见底`, '今晚扫描后自动补料, 先发别的池不耽误');
  const scene = b.scene || sceneNow();
  const gw = await gateway.call('P-04', { pool: { id: pool.id, name: pool.name, variants: (project.momentVariants || {})[pool.id] }, scene, voice: project.voice }, { projectId });
  let text = gw.result;
  let like = engines.likeness(text, project.voice);
  let firstLikeness = like;
  let regenerated = false;
  let goldenImplanted = false;
  const variants = engines.momentVariantsOf({ id: pool.id, variants: (project.momentVariants || {})[pool.id] });
  let variantIdx = Math.max(0, variants.indexOf(text));
  if (like < CONFIG.THRESHOLDS.likenessMin && variants.length > 1) {
    const nextIdx = (variantIdx + 1) % variants.length;
    const text2 = variants[nextIdx];
    const like2 = engines.likeness(text2, project.voice);
    regenerated = true;
    if (like2 > like) { text = text2; like = like2; variantIdx = nextIdx; }
  }
  if (like < CONFIG.THRESHOLDS.likenessMin && Array.isArray(project.voice.golden) && project.voice.golden.length) {
    const withGolden = text + '\n\n' + project.voice.golden[variantIdx % project.voice.golden.length];
    const like3 = engines.likeness(withGolden, project.voice);
    if (like3 > like) { text = withGolden; like = like3; goldenImplanted = true; }
  }
  const moments = store.get('moments', []);
  const moment = {
    id: nid('m'), projectId, poolId: pool.id, poolName: pool.name,
    variantIdx, variantTotal: variants.length || 1, text,
    goldenUsed: goldenImplanted, published: false, publishedAt: null,
    likeness: like, firstLikeness, regenerated, scene, createdAt: nowISO(),
  };
  moments.push(moment);
  store.set('moments', moments);
  audit(ctx, 'moment.generate', 'moment', moment.id, projectId, `从「${pool.name}池」取材生成(像你度 ${like}%)`);
  ok(res, { moment, likeness: like, mix: { pool: pool.name, ratio: pool.ratio, totalRatio: pools.reduce((s, p) => s + p.ratio, 0) }, regenerated }, 201);
};
H.momentGet = async (ctx, req, res, q, body, id) => {
  const m = findOwned('moments', id, ctx);
  if (!m) return fail(res, 404, 'NOT_FOUND', '文案不存在', '检查文案 id 或项目权限');
  ok(res, { moment: m });
};
H.momentSwap = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const m = findOwned('moments', id, ctx);
  if (!m) return fail(res, 404, 'NOT_FOUND', '文案不存在', '检查文案 id 或项目权限');
  if (m.published) return fail(res, 409, 'ALREADY_PUBLISHED', '已发布的文案不能再换', '生成新的一条继续');
  const project = getProject(m.projectId);
  const variants = engines.momentVariantsOf({ id: m.poolId, variants: (project.momentVariants || {})[m.poolId] });
  if (variants.length > 1) {
    m.variantIdx = (m.variantIdx + 1) % variants.length;
    m.text = variants[m.variantIdx];
    m.goldenUsed = false;
    m.likeness = engines.likeness(m.text, project.voice);
  }
  const s = getSignals(m.projectId); s.swap += 1;
  store.set('signals', store.get('signals', []));
  store.set('moments', store.get('moments', []));
  audit(ctx, 'moment.swap', 'moment', m.id, m.projectId, '换一换(已记入学习信号, 下周该方向少出)');
  ok(res, { moment: m });
};
H.momentGolden = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const m = findOwned('moments', id, ctx);
  if (!m) return fail(res, 404, 'NOT_FOUND', '文案不存在', '检查文案 id 或项目权限');
  if (m.published) return fail(res, 409, 'ALREADY_PUBLISHED', '已发布的文案不能再修改', '');
  if (m.goldenUsed) return fail(res, 409, 'GOLDEN_USED', '金句已植入', '每条文案限植入一次');
  const project = getProject(m.projectId);
  const golden = (project.voice.golden || [])[m.variantIdx % Math.max(1, (project.voice.golden || []).length)];
  if (golden) {
    m.text = m.text + '\n\n' + golden;
    m.goldenUsed = true;
    m.likeness = engines.likeness(m.text, project.voice);
  }
  store.set('moments', store.get('moments', []));
  audit(ctx, 'moment.golden', 'moment', m.id, m.projectId, '金句植入(发布时计入「修改后发布」)');
  ok(res, { moment: m });
};
H.momentPublish = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const m = findOwned('moments', id, ctx);
  if (!m) return fail(res, 404, 'NOT_FOUND', '文案不存在', '检查文案 id 或项目权限');
  if (m.published) return fail(res, 409, 'ALREADY_PUBLISHED', '该文案已发布(幂等拦截)', '同一文案只能标已发一次, 重复调用返回 409');
  const pools = store.get('pools', []);
  const pool = pools.find((p) => p.projectId === m.projectId && p.id === m.poolId);
  if (pool) pool.count = Math.max(0, pool.count - 1);
  store.set('pools', pools);
  m.published = true;
  m.publishedAt = nowISO();
  addLedger(m.projectId, 'moment', m.id, m.text, m.poolName || (pool && pool.name) || '');
  const s = getSignals(m.projectId);
  s.pub += 1;
  if (m.goldenUsed) s.edit += 1;
  store.set('signals', store.get('signals', []));
  store.set('moments', store.get('moments', []));
  audit(ctx, 'moment.publish', 'moment', m.id, m.projectId, `标已发: 「${m.poolName || (pool && pool.name)}池」水位 -1(剩 ${pool ? pool.count : 0}), 已记入发布记账与学习信号`);
  ok(res, { moment: m, pool: pool ? poolOut(pool) : null });
};

/* ---------- 公开课 ---------- */
H.sessionsList = async (ctx, req, res, q) => {
  const scope = scopeFromQuery(q, ctx);
  if (!scope) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const list = (store.get('sessions', [])).filter((s) => scope.includes(s.projectId)).map(sessionOut);
  ok(res, { sessions: list, total: list.length });
};
H.sessionsCreate = async (ctx, req, res, q, body) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const b = body || {};
  if (!b.projectId) return fail(res, 400, 'VALIDATION', 'projectId 必填', '请携带 {projectId, title, warmStart}');
  if (!ctx.projects.includes(b.projectId)) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const title = String(b.title || '').trim();
  const audience = String(b.audience || '').trim();
  if (!title) return fail(res, 400, 'VALIDATION', '课程主题必填', '没有主题, 物料系统没法开工');
  if (title.length > CONFIG.THRESHOLDS.titleMax) return fail(res, 400, 'VALIDATION', `课程主题超 ${CONFIG.THRESHOLDS.titleMax} 字`, '收一收');
  if (audience.length > CONFIG.THRESHOLDS.audienceMax) return fail(res, 400, 'VALIDATION', `目标人群超 ${CONFIG.THRESHOLDS.audienceMax} 字`, '收一收');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.warmStart || ''))) return fail(res, 400, 'VALIDATION', '先定预热开始日', '开课日 = 预热开始日 + 3 天');
  let rhythm;
  try { rhythm = engines.sessionRhythm(b.warmStart); } catch (e) { return fail(res, 400, 'VALIDATION', '预热开始日格式无效', 'YYYY-MM-DD'); }
  const existing = (store.get('sessions', [])).filter((s) => s.projectId === b.projectId);
  const clash = engines.checkClash(b.warmStart, existing);
  if (clash) {
    return fail(res, 422, 'SESSION_CLASH', `与「${String(clash.title).split(/[:：]/)[0]}」正课期撞期`, '把预热开始日挪开再建', {
      clash: { id: clash.id, title: clash.title, openDay: clash.openDay, endDay: clash.endDay || engines.addDaysISO(clash.openDay, 4) },
    });
  }
  const project = getProject(b.projectId);
  const s = {
    id: nid('s'), projectId: b.projectId, title, host: project ? project.host : '主讲',
    audience, hook: b.hook || (project && project.hooks && project.hooks[0]) || '《资料包》',
    warmStart: rhythm.warmStart, openDay: rhythm.openDay, endDay: rhythm.endDay,
    status: '筹备中', progress: '筹备中',
  };
  const sessions = store.get('sessions', []);
  sessions.push(s);
  store.set('sessions', sessions);
  audit(ctx, 'session.create', 'session', s.id, s.projectId, `新建场次: 预热 ${s.warmStart} → 开课 ${s.openDay} → 收官 ${s.endDay}`);
  ok(res, { session: sessionOut(s) }, 201);
};
H.sessionGet = async (ctx, req, res, q, body, id) => {
  const s = findOwned('sessions', id, ctx);
  if (!s) return fail(res, 404, 'NOT_FOUND', '场次不存在', '检查场次 id 或项目权限');
  ok(res, { session: sessionOut(s) });
};
H.sessionAdvance = async (ctx, req, res, q, body, id) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const s = findOwned('sessions', id, ctx);
  if (!s) return fail(res, 404, 'NOT_FOUND', '场次不存在', '检查场次 id 或项目权限');
  const action = (body || {}).action;
  if (!['start', 'open', 'close'].includes(action)) return fail(res, 400, 'VALIDATION', 'action 必须为 start|open|close', '筹备中→预热中→正课中→已收官');
  if (!engines.canSessionTransition(s.status, action)) {
    return fail(res, 422, 'INVALID_STATE', `状态「${s.status}」不允许 ${action}`, '合法迁移: ' + JSON.stringify(engines.SESSION_TRANSITIONS[s.status] || {}));
  }
  s.status = engines.transitionSession(s.status, action);
  s.progress = s.status;
  store.set('sessions', store.get('sessions', []));
  audit(ctx, 'session.advance', 'session', s.id, s.projectId, `场次状态 → ${s.status}`);
  ok(res, { session: sessionOut(s) });
};
H.materialsGet = async (ctx, req, res, q, body, id) => {
  const s = findOwned('sessions', id, ctx);
  if (!s) return fail(res, 404, 'NOT_FOUND', '场次不存在', '检查场次 id 或项目权限');
  const dayParam = (q.get('day') || 'D1').toUpperCase();
  if (!['D1', 'D2', 'D3'].includes(dayParam)) return fail(res, 400, 'VALIDATION', 'day 取值 D1-D3', '预热 3 天');
  ok(res, materialsOfDay(s, dayParam));
};
H.materialSwap = async (ctx, req, res, q, body, sid, day, channel) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const s = findOwned('sessions', sid, ctx);
  if (!s) return fail(res, 404, 'NOT_FOUND', '场次不存在', '检查场次 id 或项目权限');
  const d = String(day || '').toUpperCase();
  if (!['D1', 'D2', 'D3'].includes(d)) return fail(res, 400, 'VALIDATION', 'day 取值 D1-D3', '预热 3 天');
  if (!['pyq', 'dm', 'poster'].includes(channel)) return fail(res, 400, 'VALIDATION', 'channel 取值 pyq|dm|poster', '三渠道物料');
  const m = ensureMaterial(s, d, channel);
  if (m.published) return fail(res, 409, 'ALREADY_PUBLISHED', '该物料已发布, 不能再换', '换一换请在新场次/新物料上操作');
  const gw = await gateway.call('P-05', { session: { id: s.id, title: s.title, host: s.host, audience: s.audience, hook: s.hook, warmStart: s.warmStart, openDay: s.openDay }, day: d }, { projectId: s.projectId });
  const variants = gw.result[channel].variants;
  m.variantIdx = (m.variantIdx + 1) % variants.length;
  store.set('materials', store.get('materials', []));
  const sig = getSignals(s.projectId); sig.swap += 1;
  store.set('signals', store.get('signals', []));
  audit(ctx, 'material.swap', 'material', m.id, s.projectId, `${d} ${channel} 换一换 → 变体 ${m.variantIdx + 1}/${variants.length}(已记入学习信号)`);
  ok(res, { material: { ...m, current: variants[m.variantIdx], variantTotal: variants.length } });
};
H.materialPublish = async (ctx, req, res, q, body, sid, day, channel) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const s = findOwned('sessions', sid, ctx);
  if (!s) return fail(res, 404, 'NOT_FOUND', '场次不存在', '检查场次 id 或项目权限');
  const d = String(day || '').toUpperCase();
  if (!['D1', 'D2', 'D3'].includes(d)) return fail(res, 400, 'VALIDATION', 'day 取值 D1-D3', '预热 3 天');
  if (!['pyq', 'dm', 'poster'].includes(channel)) return fail(res, 400, 'VALIDATION', 'channel 取值 pyq|dm|poster', '三渠道物料');
  const m = ensureMaterial(s, d, channel);
  if (m.published) return fail(res, 409, 'ALREADY_PUBLISHED', '该物料已发布(幂等拦截)', '重复标已发返回 409');
  m.published = true;
  m.publishedAt = nowISO();
  store.set('materials', store.get('materials', []));
  const gen = engines.generateMaterials(s, d);
  const cur = gen[channel].variants[m.variantIdx % gen[channel].variants.length];
  const textOf = typeof cur === 'string' ? cur : (cur && cur.title) || '';
  addLedger(s.projectId, 'material', m.id, textOf, gen[channel].name);
  const dayMaterials = store.get('materials', []).filter((x) => x.sessionId === s.id && x.day === d);
  const published = dayMaterials.filter((x) => x.published).length;
  audit(ctx, 'material.publish', 'material', m.id, s.projectId, `${d} ${gen[channel].name}标已发(${published}/3), 已记入发布记账`);
  ok(res, { material: m, dayPublished: `${published}/3` });
};
H.courseGet = async (ctx, req, res, q, body, sid) => {
  const s = findOwned('sessions', sid, ctx);
  if (!s) return fail(res, 404, 'NOT_FOUND', '场次不存在', '检查场次 id 或项目权限');
  const rows = ensureCourseRows(s);
  ok(res, { course: rows, published: `${rows.filter((r) => r.status === '已发').length}/5` });
};
H.courseGenerate = async (ctx, req, res, q, body, sid, day) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const s = findOwned('sessions', sid, ctx);
  if (!s) return fail(res, 404, 'NOT_FOUND', '场次不存在', '检查场次 id 或项目权限');
  const n = Number(day);
  if (!(n >= 1 && n <= 5)) return fail(res, 400, 'VALIDATION', 'day 取值 1-5', '正课 5 天');
  const row = ensureCourseRow(s, n);
  const themes = store.get('course', []).filter((r) => r.sessionId === s.id && r.theme).sort((a, b) => a.day - b.day).map((r) => r.theme);
  const gw = await gateway.call('P-06', { session: { id: s.id, title: s.title, host: s.host, hook: row.hook || s.hook, courseThemes: themes }, day: n }, { projectId: s.projectId });
  row.body = gw.result;
  row.generatedAt = nowISO();
  store.set('course', store.get('course', []));
  audit(ctx, 'course.generate', 'course', row.id, s.projectId, `D${n} 正文已生成`);
  ok(res, { day: row, body: row.body, provider: gw.provider });
};
H.coursePublish = async (ctx, req, res, q, body, sid, day) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const s = findOwned('sessions', sid, ctx);
  if (!s) return fail(res, 404, 'NOT_FOUND', '场次不存在', '检查场次 id 或项目权限');
  const n = Number(day);
  if (!(n >= 1 && n <= 5)) return fail(res, 400, 'VALIDATION', 'day 取值 1-5', '正课 5 天');
  const row = ensureCourseRow(s, n);
  if (row.status === '已发') return fail(res, 409, 'ALREADY_PUBLISHED', `D${n} 已发布(幂等拦截)`, '重复标已发返回 409');
  if (!row.body) return fail(res, 422, 'COURSE_BODY_REQUIRED', `D${n} 尚未生成正文`, `先 POST /api/sessions/${sid}/course/${n}/generate`);
  const before = store.get('course', []).filter((r) => r.sessionId === s.id && r.status === '已发').length;
  row.status = '已发';
  row.publishedAt = nowISO();
  store.set('course', store.get('course', []));
  addLedger(s.projectId, 'course', row.id, row.body, `D${n}`);
  const after = before + 1;
  if (s.status === '正课中') { s.progress = `已发 ${after}/5`; store.set('sessions', store.get('sessions', [])); }
  audit(ctx, 'course.publish', 'course', row.id, s.projectId, `正课已发 ${before}/5 → ${after}/5, D${n} 已归档`);
  ok(res, { day: row, published: `${after}/5` });
};
H.coursePhoto = async (ctx, req, res, q, body, sid, day) => {
  if (!requireCap(ctx, 'write')) return fail(res, 403, 'FORBIDDEN', '只读账号不能执行写操作', '使用 operator/reviewer/admin 账号');
  const s = findOwned('sessions', sid, ctx);
  if (!s) return fail(res, 404, 'NOT_FOUND', '场次不存在', '检查场次 id 或项目权限');
  const n = Number(day);
  if (!(n >= 1 && n <= 5)) return fail(res, 400, 'VALIDATION', 'day 取值 1-5', '正课 5 天');
  const row = ensureCourseRow(s, n);
  if (row.photos >= CONFIG.THRESHOLDS.photoMax) {
    return fail(res, 422, 'PHOTO_LIMIT', `配图已达上限 ${CONFIG.THRESHOLDS.photoMax} 张`, '每天正文最多挂 3 张配图');
  }
  row.photos += 1;
  row.photoAt = nowISO();
  store.set('course', store.get('course', []));
  audit(ctx, 'course.photo', 'course', row.id, s.projectId, `D${n} 配图 ${row.photos - 1}/${CONFIG.THRESHOLDS.photoMax} → ${row.photos}/${CONFIG.THRESHOLDS.photoMax}`);
  ok(res, { day: row });
};

/* ---------- 公共聚合 ---------- */
H.dashboard = async (ctx, req, res, q) => {
  const scope = scopeFromQuery(q, ctx);
  if (!scope) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const projects = [];
  for (const pid of scope) {
    const p = getProject(pid);
    if (!p) continue;
    const topics = (store.get('topics', [])).filter((t) => t.projectId === pid);
    const byStatus = { '选题': 0, '已出稿': 0, '已淘汰': 0, '已筛除': 0 };
    topics.forEach((t) => { if (byStatus[t.status] !== undefined) byStatus[t.status] += 1; });
    const pools = (store.get('pools', [])).filter((x) => x.projectId === pid).map(poolOut);
    const sessions = (store.get('sessions', [])).filter((s) => s.projectId === pid).map(sessionOut);
    const ledger = store.get('ledger', []).filter((l) => l.projectId === pid);
    const scans = (store.get('scan_log', [])).filter((l) => l.projectId === pid && new Date(l.time).getTime() >= weekAgo);
    const drafts = (store.get('drafts', [])).filter((d) => d.projectId === pid);
    projects.push({
      projectId: pid, name: p.name,
      topics: {
        thisWeek: topics.filter((t) => new Date(t.createdAt || 0).getTime() >= weekAgo).length,
        total: topics.length, byStatus,
      },
      drafts: { approved: drafts.filter((d) => d.status === '合规过审版').length, total: drafts.length },
      pools,
      sessions: sessions.map((s) => ({ id: s.id, title: s.title, status: s.status, progress: s.progress, coursePublished: s.coursePublished })),
      ledger: {
        moments: ledger.filter((l) => l.type === 'moment').length,
        materials: ledger.filter((l) => l.type === 'material').length,
        course: ledger.filter((l) => l.type === 'course').length,
        total: ledger.length,
        recent: ledger.slice(0, 10),
      },
      scan: {
        thisWeekAdmitted: scans.reduce((s2, l) => s2 + (l.admitted || 0), 0),
        thisWeekRejected: scans.reduce((s2, l) => s2 + (l.rejected || []).length, 0),
      },
      signals: getSignals(pid),
    });
  }
  ok(res, { generatedAt: nowISO(), projects });
};
H.auditList = async (ctx, req, res, q) => {
  const scope = scopeFromQuery(q, ctx);
  if (!scope) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const actor = q.get('actor') || '';
  const action = q.get('action') || '';
  const limit = Math.min(500, Math.max(1, Number(q.get('limit')) || 100));
  let list = (store.get('audit', [])).filter((a) => !a.projectId || scope.includes(a.projectId));
  if (actor) list = list.filter((a) => a.actor === actor);
  if (action) list = list.filter((a) => String(a.action).startsWith(action));
  ok(res, { audit: list.slice(0, limit), total: list.length });
};
H.costReport = async (ctx, req, res, q) => {
  const scope = scopeFromQuery(q, ctx);
  if (!scope) return fail(res, 404, 'NOT_FOUND', '项目不存在或无权访问', '检查 projectId');
  const usage = gateway.getTokenUsage();
  const projects = [];
  for (const pid of scope) {
    const p = getProject(pid);
    const pj = usage.byProject[pid] || { calls: 0, tokens: 0, byPrompt: {} };
    projects.push({ projectId: pid, name: p ? p.name : pid, calls: pj.calls || 0, tokens: pj.tokens || 0, byPrompt: pj.byPrompt || {} });
  }
  const totalCalls = Object.values(usage.byPrompt).reduce((s, x) => s + x.calls, 0);
  const totalTokens = Object.values(usage.byPrompt).reduce((s, x) => s + x.tokens, 0);
  ok(res, { total: { calls: totalCalls, tokens: totalTokens, failovers: usage.failovers || 0 }, byPrompt: usage.byPrompt, projects });
};
H.health = async (ctx, req, res) => {
  ok(res, { ok: true, service: 'cpl-server', version: VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000), dataDir: CONFIG.DATA_DIR, now: nowISO() });
};

/* ==================== 路由表 ==================== */

const WRITE_FREE = new Set(['login', 'health']);

const ROUTES = [
  ['POST', /^\/api\/auth\/login$/, (c, r, r2, q, b) => H.login(c, r, r2, q, b), 'login'],
  ['GET', /^\/api\/auth\/me$/, (c, r, r2) => H.me(c, r, r2), 'me'],
  ['GET', /^\/api\/projects$/, (c, r, r2, q) => H.projectsList(c, r, r2, q), 'projectsList'],
  ['POST', /^\/api\/projects$/, (c, r, r2, q, b) => H.projectsCreate(c, r, r2, q, b), 'projectsCreate'],
  ['GET', /^\/api\/accounts$/, (c, r, r2, q) => H.accountsList(c, r, r2, q), 'accountsList'],
  ['POST', /^\/api\/accounts$/, (c, r, r2, q, b) => H.accountsCreate(c, r, r2, q, b), 'accountsCreate'],
  ['PATCH', /^\/api\/accounts\/([^/]+)$/, (c, r, r2, q, b, m) => H.accountPatch(c, r, r2, q, b, m[1]), 'accountPatch'],
  ['POST', /^\/api\/accounts\/([^/]+)\/scan$/, (c, r, r2, q, b, m) => H.accountScan(c, r, r2, q, b, m[1]), 'accountScan'],
  ['GET', /^\/api\/topics$/, (c, r, r2, q) => H.topicsList(c, r, r2, q), 'topicsList'],
  ['GET', /^\/api\/topics\/([^/]+)$/, (c, r, r2, q, b, m) => H.topicGet(c, r, r2, q, b, m[1]), 'topicGet'],
  ['POST', /^\/api\/topics\/([^/]+)\/discard$/, (c, r, r2, q, b, m) => H.topicDiscard(c, r, r2, q, b, m[1]), 'topicDiscard'],
  ['POST', /^\/api\/topics\/([^/]+)\/restore$/, (c, r, r2, q, b, m) => H.topicRestore(c, r, r2, q, b, m[1]), 'topicRestore'],
  ['POST', /^\/api\/topics\/([^/]+)\/ideas$/, (c, r, r2, q, b, m) => H.topicIdeas(c, r, r2, q, b, m[1]), 'topicIdeas'],
  ['POST', /^\/api\/topics\/([^/]+)\/frame$/, (c, r, r2, q, b, m) => H.topicFrame(c, r, r2, q, b, m[1]), 'topicFrame'],
  ['POST', /^\/api\/topics\/([^/]+)\/draft$/, (c, r, r2, q, b, m) => H.topicDraft(c, r, r2, q, b, m[1]), 'topicDraft'],
  ['POST', /^\/api\/drafts\/([^/]+)\/compliance$/, (c, r, r2, q, b, m) => H.draftCompliance(c, r, r2, q, b, m[1]), 'draftCompliance'],
  ['POST', /^\/api\/drafts\/([^/]+)\/apply-fixes$/, (c, r, r2, q, b, m) => H.draftApplyFixes(c, r, r2, q, b, m[1]), 'draftApplyFixes'],
  ['POST', /^\/api\/drafts\/([^/]+)\/review$/, (c, r, r2, q, b, m) => H.draftReview(c, r, r2, q, b, m[1]), 'draftReview'],
  ['POST', /^\/api\/drafts\/([^/]+)\/final-review$/, (c, r, r2, q, b, m) => H.draftFinalReview(c, r, r2, q, b, m[1]), 'draftFinalReview'],
  ['GET', /^\/api\/drafts\/([^/]+)\/export$/, (c, r, r2, q, b, m) => H.draftExport(c, r, r2, q, b, m[1]), 'draftExport'],
  ['GET', /^\/api\/sources$/, (c, r, r2, q) => H.sources(c, r, r2, q), 'sources'],
  ['GET', /^\/api\/pools$/, (c, r, r2, q) => H.pools(c, r, r2, q), 'pools'],
  ['POST', /^\/api\/moments\/generate$/, (c, r, r2, q, b) => H.momentGenerate(c, r, r2, q, b), 'momentGenerate'],
  ['GET', /^\/api\/moments\/([^/]+)$/, (c, r, r2, q, b, m) => H.momentGet(c, r, r2, q, b, m[1]), 'momentGet'],
  ['POST', /^\/api\/moments\/([^/]+)\/swap$/, (c, r, r2, q, b, m) => H.momentSwap(c, r, r2, q, b, m[1]), 'momentSwap'],
  ['POST', /^\/api\/moments\/([^/]+)\/golden$/, (c, r, r2, q, b, m) => H.momentGolden(c, r, r2, q, b, m[1]), 'momentGolden'],
  ['POST', /^\/api\/moments\/([^/]+)\/publish$/, (c, r, r2, q, b, m) => H.momentPublish(c, r, r2, q, b, m[1]), 'momentPublish'],
  ['GET', /^\/api\/sessions$/, (c, r, r2, q) => H.sessionsList(c, r, r2, q), 'sessionsList'],
  ['POST', /^\/api\/sessions$/, (c, r, r2, q, b) => H.sessionsCreate(c, r, r2, q, b), 'sessionsCreate'],
  ['GET', /^\/api\/sessions\/([^/]+)$/, (c, r, r2, q, b, m) => H.sessionGet(c, r, r2, q, b, m[1]), 'sessionGet'],
  ['POST', /^\/api\/sessions\/([^/]+)\/advance$/, (c, r, r2, q, b, m) => H.sessionAdvance(c, r, r2, q, b, m[1]), 'sessionAdvance'],
  ['GET', /^\/api\/sessions\/([^/]+)\/materials$/, (c, r, r2, q, b, m) => H.materialsGet(c, r, r2, q, b, m[1]), 'materialsGet'],
  ['POST', /^\/api\/sessions\/([^/]+)\/materials\/(D\d+)\/(pyq|dm|poster)\/swap$/, (c, r, r2, q, b, m) => H.materialSwap(c, r, r2, q, b, m[1], m[2], m[3]), 'materialSwap'],
  ['POST', /^\/api\/sessions\/([^/]+)\/materials\/(D\d+)\/(pyq|dm|poster)\/publish$/, (c, r, r2, q, b, m) => H.materialPublish(c, r, r2, q, b, m[1], m[2], m[3]), 'materialPublish'],
  ['GET', /^\/api\/sessions\/([^/]+)\/course$/, (c, r, r2, q, b, m) => H.courseGet(c, r, r2, q, b, m[1]), 'courseGet'],
  ['POST', /^\/api\/sessions\/([^/]+)\/course\/([1-5])\/generate$/, (c, r, r2, q, b, m) => H.courseGenerate(c, r, r2, q, b, m[1], m[2]), 'courseGenerate'],
  ['POST', /^\/api\/sessions\/([^/]+)\/course\/([1-5])\/publish$/, (c, r, r2, q, b, m) => H.coursePublish(c, r, r2, q, b, m[1], m[2]), 'coursePublish'],
  ['POST', /^\/api\/sessions\/([^/]+)\/course\/([1-5])\/photo$/, (c, r, r2, q, b, m) => H.coursePhoto(c, r, r2, q, b, m[1], m[2]), 'coursePhoto'],
  ['GET', /^\/api\/dashboard$/, (c, r, r2, q) => H.dashboard(c, r, r2, q), 'dashboard'],
  ['GET', /^\/api\/audit$/, (c, r, r2, q) => H.auditList(c, r, r2, q), 'auditList'],
  ['GET', /^\/api\/cost-report$/, (c, r, r2, q) => H.costReport(c, r, r2, q), 'costReport'],
  ['GET', /^\/api\/health$/, (c, r, r2) => H.health(c, r, r2), 'health'],
];

/* ==================== 静态托管 ../app ==================== */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.map': 'application/json',
};
function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(CONFIG.APP_DIR, rel));
  if (!file.startsWith(path.normalize(CONFIG.APP_DIR + path.sep)) && file !== path.normalize(CONFIG.APP_DIR)) {
    return fail(res, 404, 'NOT_FOUND', '文件不存在', '');
  }
  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) return fail(res, 404, 'NOT_FOUND', '文件不存在', '仅托管原型门户静态资源');
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, 'NOT_FOUND', '文件不存在', `GET / 与 /assets/* 指向 ../app`);
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

/* ==================== 主处理 ==================== */

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  try {
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'METHOD', '静态资源仅支持 GET', '');
      return serveStatic(pathname, res);
    }
    const route = ROUTES.find(([m, re]) => m === req.method && re.test(pathname));
    if (!route) {
      if (req.method === 'GET' && ROUTES.some(([m, re]) => re.test(pathname))) return fail(res, 405, 'METHOD', '方法不允许', '检查请求方法');
      return fail(res, 404, 'NOT_FOUND', '接口不存在', '前缀 /api, 详见 README/交付物说明');
    }
    const [method, re, handler, name] = route;
    const m = pathname.match(re);

    /* 鉴权 */
    let ctx = null;
    if (!WRITE_FREE.has(name)) {
      const user = verifyToken(bearerToken(req));
      if (!user) return fail(res, 401, 'UNAUTHORIZED', '未登录或 token 无效', '先 POST /api/auth/login 获取 Bearer token');
      ctx = { user, projects: user.projects, role: user.role };
    }

    const body = (method === 'GET' || method === 'HEAD') ? {} : await readBody(req);
    await handler(ctx, req, res, u.searchParams, body, m);
  } catch (e) {
    if (e && (e.code === 'INVALID_JSON' || e.code === 'BODY_TOO_LARGE')) {
      return fail(res, 400, e.code, '请求体不是合法 JSON 或超过 1MB', 'Content-Type: application/json; charset=utf-8');
    }
    if (e && e.code === 'LLM_ALL_PROVIDERS_FAILED') {
      return fail(res, 503, 'LLM_ALL_PROVIDERS_FAILED', '主备供应商均不可用', '稍后重试或检查 LLM_PROVIDER 环境变量');
    }
    if (e && e.code === 'UNKNOWN_PROMPT_KEY') {
      return fail(res, 500, 'UNKNOWN_PROMPT_KEY', e.message, '');
    }
    console.error('[cpl-server] error:', e);
    return fail(res, 500, 'INTERNAL', '服务内部错误', (e && e.message) || '');
  }
}

/* ==================== 启动 ==================== */

function start(opts) {
  const o = opts || {};
  if (!store.get('projects', null)) seed.seedAll({ reset: false });
  const server = http.createServer(handle);
  const port = o.port || CONFIG.PORT;
  const host = o.host || CONFIG.HOST;
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      const close = () => new Promise((r) => { store.flushAll(); server.close(() => r()); });
      resolve({ server, port: actual, host, close });
    });
  });
}

if (require.main === module) {
  start().then(({ port, host }) => {
    console.log(`[cpl-server] 流量总台 · 内容生产线 后端已启动`);
    console.log(`[cpl-server] API  : http://${host}:${port}/api/health`);
    console.log(`[cpl-server] 门户  : http://${host}:${port}/  (托管 ../app)`);
    console.log(`[cpl-server] 数据  : ${CONFIG.DATA_DIR}`);
  }).catch((e) => { console.error('[cpl-server] 启动失败:', e); process.exit(1); });
  const shutdown = () => { store.flushAll(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { start, handle };
