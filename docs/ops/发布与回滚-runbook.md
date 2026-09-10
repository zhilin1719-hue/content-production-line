# 发布与回滚 Runbook（D7-2 · 运维与应急包之二）

适用范围：v1.x 小版本发布（含服务期内承诺的 1 个功能小版本与缺陷修复版本）。原则：发布前自检不过不发；发布后 30 分钟只读冒烟任一失败立即回滚。

---

## 0. 发布窗口与角色

| 项 | 约定 |
|---|---|
| 发布窗口 | 工作日 10:00–11:00 或 16:00–17:00，避开 09:00 出稿、12:00 发圈、17:00 课物料三个使用高峰 |
| 执行人 | 交付方运维（服务期内）或客户方管理员（交接后） |
| 记录 | 每次发布填第 6 节记录表，归入 D8 过程档案 |

## 1. 发布前自检（不过不发）

| # | 步骤 | 命令 / 操作 | 通过标准 |
|---|---|---|---|
| 1.1 | 测试套件全绿 | `cd server` → `node --test test/` | api / engines / isolation / llm / statemachine 五个套件全部 pass，0 fail |
| 1.2 | 评测基线达标 | `node test/_calib.js`（如启用第二校准脚本再跑 `node test/_calib2.js`） | 全部输出 `OK`（无 `LOW` 行）；对照 D5 基线：像你度 ≥90、规则命中 100% 拦截、漏检率 ≤1%、原创度 ≤15% |
| 1.3 | 健康检查 | `curl http://127.0.0.1:8399/api/health` | `ok: true`，记录当前 version 作为回滚目标版本 |
| 1.4 | 变更清单确认 | 阅读本版本的变更说明 | 明确改动文件范围；涉及 server/data 结构变更时必须先备份并演练恢复 |

任一项不通过：停止发布，回到开发修复，当天不再排发布。

## 2. 备份 data 目录（发布前必做）

```powershell
# 在项目根目录执行；tar 为 Windows 10+ 自带
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
tar -czf "backups/data-pre-release-$stamp.tar.gz" -C server data
# 验证：文件存在且大小 > 0
dir backups\data-pre-release-$stamp.tar.gz
```

通过标准：tar 文件存在、大小 > 0、时间戳为当前。失败则停止发布（备份是回滚的唯一依据）。

## 3. 拉版本

```powershell
git pull            # 或按交付方式解压新版本包覆盖 app/ 与 server/ 源码
git log -1 --oneline   # 记录新版本 commit，写入发布记录
```

注意：不要覆盖 server/data 目录（新版本包不含 data，若有则说明包有问题，停止发布）。

## 4. 启动

```powershell
cd server
node server.js
# 控制台应出现三行：API 地址 / 门户地址 / 数据目录
curl http://127.0.0.1:8399/api/health   # 确认 ok:true 且 version 为新版本
```

启动失败：先按第 5 节回滚，再排查（优先检查端口占用与 Node 版本 ≥18）。

## 5. 发布后 30 分钟只读冒烟（任一失败即回滚）

只读冒烟：只做读操作和登录，不做任何生成 / 标已发 / 终审写操作，避免污染业务数据。

| # | 检查项 | 操作 / 命令 | 通过标准 |
|---|---|---|---|
| 5.1 | 登录 | `curl -X POST http://127.0.0.1:8399/api/auth/login -H "content-type: application/json" -d '{"username":"admin","password":"***"}'` | HTTP 200，返回 token（用真实密码替换 ***） |
| 5.2 | 列表加载 | `curl "http://127.0.0.1:8399/api/topics?projectId=p-zeyu" -H "authorization: Bearer <token>"` | HTTP 200，返回选题数组非空 |
| 5.3 | 任务状态查询 | `curl http://127.0.0.1:8399/api/pools?projectId=p-zeyu` 与 `curl http://127.0.0.1:8399/api/sessions?projectId=p-zeyu`（带 token） | 均 200，六池与场次数据结构完整 |
| 5.4 | 门户加载 | 浏览器打开 http://127.0.0.1:8399/ | 首页正常渲染，三个模块卡可点入 |

30 分钟内每 10 分钟重复 5.1–5.3 一次，共三轮。全部通过 → 发布完成，填记录表。任一失败 → 立即执行回滚。

## 6. 回滚步骤

| # | 步骤 | 操作 / 命令 | 验证 |
|---|---|---|---|
| 6.1 | 停服 | 运行窗口 Ctrl+C（触发 flushAll）；或 `taskkill /im node.exe` 前先确认无其他 node 进程 | 进程消失 |
| 6.2 | 恢复 data 备份 | `tar -xzf backups\data-pre-release-<stamp>.tar.gz -C server`（覆盖前可先把当前 data 移为 data-broken-<stamp> 留证） | server/data/*.json 恢复为发布前状态 |
| 6.3 | 回退版本 | `git checkout <发布前 commit>` 或换回旧版本包 | `git log -1` 为回滚目标 |
| 6.4 | 重启 | `cd server && node server.js` | 控制台三行启动信息正常 |
| 6.5 | 复验 | 重复第 5 节 5.1–5.3 三项 + /api/health | version 回到旧版本，三项全 200 |

回滚后：当次发布问题按缺陷分级立项（P0/P1 修复后重新走本流程），发布记录表如实记「已回滚」。

## 7. 发布记录表（每次发布一行）

| 日期 | 版本/commit | 自检结果（1.1/1.2） | 备份文件名 | 冒烟结果 | 是否回滚 | 执行人 | 备注 |
|---|---|---|---|---|---|---|---|
| | | 绿 / 绿 | | 三轮通过 | 否 | | |
| | | | | | | | |

| 记录 | 内容 |
|---|---|
| 编制 | 交付方 · 后端工程师 |
| 复核 | 交付方 · 项目经理 |
| 客户接收 | 签字：＿＿＿＿＿＿ 日期：＿＿＿＿＿＿ |
