/* ============================================================
   流量总台 · 内容生产线 — 后端配置 (合同交付物 D2)
   端口 / 路径 / 角色权限矩阵 / 合规规则库 / 阈值
   DATA_DIR 环境变量可覆盖数据目录(测试用, 不污染 server/data)
   ============================================================ */
'use strict';

const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 8399);
const HOST = process.env.HOST || '127.0.0.1';
const APP_DIR = path.join(__dirname, '..', 'app');
const PROMPTS_DIR = path.join(__dirname, 'prompts');

/* ---------- 鉴权 ---------- */
const AUTH_SECRET = process.env.AUTH_SECRET || 'cpl-demo-secret-2026-d2';
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/* ---------- 角色权限矩阵 ----------
   read     读操作
   write    业务写操作(生成/扫描/换一换/标已发/淘汰/恢复...)
   review   第三层人工终审 final-review
   manage   平台管理(新建项目)             */
const ROLE_MATRIX = {
  admin:    { read: true,  write: true,  review: true,  manage: true  },
  operator: { read: true,  write: true,  review: false, manage: false },
  reviewer: { read: true,  write: true,  review: true,  manage: false },
  viewer:   { read: false, write: false, review: false, manage: false },
};
/* viewer 的读权限按接口单独放行(只读账号), 见 server.js READ_ONLY_ROLES */
const READ_ONLY_ROLES = ['viewer'];

/* ---------- 业务阈值 ---------- */
const THRESHOLDS = {
  originalityMax: 0.15,   // 原创度: 连续 8 字重合占比 ≤ 15% 通过 (NFR/FR-A7 第二层)
  ngram: 8,               // 连续 n 字重合片段
  likenessMin: 90,        // 像你度 < 90 不出稿, 自动重生一次 (NFR-17)
  relevanceMin: 40,       // 选题相关度 < 40 挂不上钩, 筛除留痕
  restoreDays: 90,        // 淘汰选题保留 90 天可恢复
  titleMax: 40,           // 公开课主题 ≤ 40 字
  audienceMax: 30,        // 目标人群 ≤ 30 字
  photoMax: 3,            // 正课配图上限 3 张
  pageSize: 20,           // 列表分页
};

/* ---------- 合规规则库 (FR-A7 第一层)
   比原型更完整: 增加 repl 替换映射, 供 applyRuleFixes 一键采纳。
   word 按长度降序应用, 避免「史上最好」被「最好」抢先拆散。 */
const RULES = [
  { word: '史上最',   type: '广告法极限词', fix: '「史上最」是绝对化用语, 删掉',                             repl: '' },
  { word: '保证收益', type: '承诺性表述',   fix: '承诺收益违规, 改成「可验证的案例路径」',                   repl: '可验证的案例路径' },
  { word: '最好',     type: '广告法极限词', fix: '「最好」是极限词, 改成「更适合大多数人」或删掉',           repl: '更适合大多数人' },
  { word: '第一',     type: '广告法极限词', fix: '「第一」是极限词, 改成「头部」或删掉',                   repl: '头部' },
  { word: '稳赚',     type: '承诺性表述',   fix: '「稳赚」是承诺收益, 改成「把确定性做高」',               repl: '把确定性做高' },
  { word: '躺赚',     type: '承诺性表述',   fix: '「躺赚」是诱导性承诺, 改成「系统替你跑」',               repl: '系统替你跑' },
  { word: '百分百',   type: '广告法极限词', fix: '「百分百」是绝对化用语, 给出具体数字依据或删掉',         repl: '大概率' },
  { word: '绝对',     type: '广告法极限词', fix: '「绝对」是绝对化用语, 改成「大概率」或删掉',             repl: '大概率' },
  { word: '包治',     type: '医疗绝对化',   fix: '医疗功效承诺违规, 删掉',                                 repl: '' },
  { word: 'guaranteed', type: '承诺性表述', fix: '避免收益承诺',                                           repl: '' },
].sort((a, b) => b.word.length - a.word.length);

/* ---------- 大模型复核 · 语义风险词表 (第二层模拟) ---------- */
const SEMANTIC_RISK_WORDS = [
  { word: '稳赚不赔', type: '收益承诺' },
  { word: '零风险',   type: '风险暗示' },
  { word: '无风险',   type: '风险暗示' },
  { word: '必涨',     type: '收益承诺' },
  { word: '暴富',     type: '诱导性表述' },
  { word: '根治',     type: '医疗绝对化' },
  { word: '治愈',     type: '医疗绝对化' },
  { word: '内部消息', type: '信息违规' },
];

/* ---------- 六池默认配置(与演示数据同源, 水位按项目持久化) ---------- */
const POOL_DEFS = [
  { id: 'ganhuo',   name: '干货', cap: 40, ratio: 30 },
  { id: 'anli',     name: '案例', cap: 30, ratio: 20 },
  { id: 'shenghuo', name: '生活', cap: 30, ratio: 20 },
  { id: 'dianping', name: '点评', cap: 25, ratio: 15 },
  { id: 'chengjiao', name: '成交', cap: 20, ratio: 10 },
  { id: 'jushen',   name: '拒审', cap: 15, ratio: 5 },
];

/* ---------- LLM 网关 ---------- */
const LLM = {
  delayMinMs: 200,                       // 生成类接口模拟延迟 200-600ms
  delayMaxMs: 600,
  delayOverride: process.env.LLM_DELAY_MS !== undefined ? Number(process.env.LLM_DELAY_MS) : null,
  tokensPerChar: 1 / 4,                  // token 估算: 字符数 / 4 (NFR-14)
};

/* ---------- 写盘 ---------- */
const WRITE_DEBOUNCE_MS = 50;

module.exports = {
  DATA_DIR, PORT, HOST, APP_DIR, PROMPTS_DIR,
  AUTH_SECRET, TOKEN_TTL_MS,
  ROLE_MATRIX, READ_ONLY_ROLES,
  THRESHOLDS, RULES, SEMANTIC_RISK_WORDS, POOL_DEFS,
  LLM, WRITE_DEBOUNCE_MS,
};
