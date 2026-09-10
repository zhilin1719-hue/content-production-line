# 流量总台 · 内容生产线 — 交付包

按《附件二 · 项目里程碑与交付物清单》D1–D8 交付。打开 **portal.html** 进入交付门户（含 29 项 FR 需求追溯矩阵与验收基线证据）。

## 在线访问

- **交付门户（GitHub Pages）**：<https://zhilin1719-hue.github.io/content-production-line/>
- **可交互原型**：<https://zhilin1719-hue.github.io/content-production-line/app/>
- **本仓库**：<https://github.com/zhilin1719-hue/content-production-line>

> 说明：在线版为纯静态演示（原型 + 门户）；后端 API 与测试请按下方「快速开始」本地运行。合同附件 PDF 属商务保密件，未随公开仓库分发，随本地交付包 zip 移交。

## 目录结构

```
├── portal.html          # D1 交付门户（验收入口）
├── app/                 # D1 可交互原型 ×4（评审用高保真稿, 零依赖离线可用）
│   ├── index.html       #   总台入口 + 数据看板
│   ├── gongyu.html      #   公域台：对标 → 选题池 → 三选一 → 二选一 → 初稿 → 合规三层
│   ├── quan.html        #   朋友圈：五源状态 → 六池 → 声纹 → 随取随发 → 记账
│   ├── kaike.html       #   公开课：场次 → 三渠道物料 → 正课 5 天 → 排期泳道
│   └── assets/          #   设计令牌(tokens.css) + 组件库(app.css) + 交互层 + 演示数据
├── server/              # D2 后端服务（零 npm 依赖, Node ≥ 18）
│   ├── server.js        #   HTTP API ×33 + 静态托管 ../app
│   ├── engines.js       #   纯业务引擎(合规/原创度/像你度/生成/节奏/状态机)
│   ├── llm-gateway.js   #   LLM 网关(主备双供应商 NFR-12 + token 成本 NFR-14)
│   ├── store.js / seed.js / config.js
│   ├── prompts/         #   P-01~P-08 加载位(完整模板见 docs/prompts)
│   ├── test/            #   node:test ×73 用例 + report.txt
│   └── eval/            # D5 评测集 250 条 + 跑分器 + judge-config.yaml + 基线报告
├── docs/
│   ├── api/openapi.yaml # D3 OpenAPI 3.1 契约(33 端点)
│   ├── prompts/         # D4 提示词模板 P-01~P-08
│   ├── training/        # D6 操作手册 + FAQ(36) + 录屏清单(15 段)
│   ├── ops/             # D7 运维手册 + 发布回滚 runbook + 备份恢复 + 告警处置单
│   └── acceptance/      # D8 里程碑纪要×4 + UAT 签字单×4 + 考核表 + 验收单 + 服务期确认书
├── Dockerfile           # D2 生产镜像
├── docker-compose.yml   # D-7 单机编排(二期 PG/Redis/MinIO 预留位)
└── README.md
```

## 快速开始

### 原型（评审）
双击 `app/index.html`。所有交互真实可用，状态本地持久化；演示数据一律标注「演示数据」（DOC-07 §1 演示态诚实）。

### 后端服务（联调 / 验收演示）

```bash
# Node ≥ 18（零 npm 依赖）
node server/seed.js --reset     # 播种双项目演示数据
node server/server.js           # http://localhost:8399（同端口托管原型与 API）
```

```bash
# 或 Docker 单机部署（D-7）
docker compose up -d            # 健康检查 /api/health
```

演示账号（seed）：`admin/admin123` · `operator/op123` · `reviewer/rev123` · `viewer/view123`

### 测试与评测（发布准出）

```bash
node --test server/test/engines.test.js     # 逐套件, 或全量:
#   engines / statemachine / llm / isolation / api —— 共 73 用例
node server/eval/gen-eval-set.js            # 生成 250 条评测集(固定种子可复现)
node server/eval/run-eval.js                # 五指标跑分, 达标退出码 0
```

## 验收基线（2026-09-10 实测）

| 指标 | 实测 | 目标（附件三 DOC-08 §4.1） |
|---|---|---|
| 功能测试 | 73/73 全绿 | P0 用例 100% |
| 像你度均值（评测集正样本） | 98 | ≥ 93（单条门禁 ≥ 90） |
| 合规规则拦截率（含全角/emoji/空格变体） | 100% | 100%（NFR-18） |
| 语义复核漏检率 | 0% | ≤ 1% |
| 原创度判定一致率（连续 8 字重合 ≤15%） | 100% | 打回/通过判定一致 |
| 多项目隔离 | 跨项目资源一律 404 | 越权全部被拦（U4 口径） |

## 红线约定（附件一 §7）

- 换理念必须产出原创表达：连续 8 字重合 >15% 自动打回（阈值 D-3）
- 合规三层中「终审权永远在人」：规则与模型只提示不改写
- 微信侧发布为人工复制粘贴，不对接个人号自动化工具
- 对标账号默认脱敏展示；未授权素材不进入面向公众的生成

## 交付即接手

任何一支有 AI 工程能力的团队凭本包即可接手演进：文档讲清为什么这么做（附件一~四 + docs/），代码与模板讲清现在怎么做（server/ + prompts），评测集与基线讲清怎么判断改好了（server/eval/）。
