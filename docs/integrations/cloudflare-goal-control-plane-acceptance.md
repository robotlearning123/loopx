# Cloudflare Goal Control Plane Acceptance Standard

本文定义 `cloudflare/goal-control-plane` 的**可部署基线**。任何功能声称“完成”前，均应有可重复执行、不可仅依赖人工阅读的验收证据。该标准只批准协调面进入受控集成；它**不**批准自主修复、GitHub merge、Sentry resolve、部署或生产写操作。

> **通过定义：** 代码、契约、Worker 本地运行时和负面路径均已验证；每一项验证留下结构化、无凭据的证据；任何未通过项均阻断 Cloudflare 部署与后续外部 effect provider 接入。

## 验收矩阵

| ID | 类别 | 必须验证的行为 | 通过证据 | 阻断条件 |
|---|---|---|---|---|
| A-01 | 构建 | TypeScript 无诊断；Worker 可打包为 dry-run | `pnpm check` 与 `wrangler deploy --dry-run` 退出码为 0 | 任一编译、绑定或迁移错误 |
| A-02 | 单元 | lease 排他、同键重放、state fencing、过期 lease、release/reclaim、命令幂等 | Vitest 全量测试；每项命名断言 | 协调器接受旧 epoch、重复 command 或竞争 lease |
| A-03 | 认证 | 所有 `/v1` 路由在无/错 Bearer token 下拒绝；错误不回显 token | 本地 Worker 端到端证据中含 401 与无 secret 检查 | 未授权访问返回 goal 投影或 token 可在响应中找到 |
| A-04 | 协议 | claim 返回 epoch/lease/state version；command 必须匹配当前 lease 与 state version | 本地端到端 JSON evidence | 只靠 agent ID、自然语言或旧版本即可写入 |
| A-05 | 幂等 | 同一 `idempotency_key`/`command_id` 重放不产生第二个状态推进 | replay receipt 与 snapshot command count | 重放改变 epoch、state version 或 command count |
| A-06 | 恢复 | release 后其他 agent 能得到更高 epoch；旧 lease 不能恢复写入 | release/reclaim 端到端证据 | 新旧 agent 可并发提交，或 epoch 不单调 |
| A-07 | Queue | 已接纳 command 产生 wakeup receipt；receipt 明确无 external effect | `queue_delivery=accepted` 与 `guard=command_accepted_without_external_effect` | Queue consumer 含 GitHub/Sentry/部署/merge/closeout effect |
| A-08 | 边界 | coordinator/Queue/CLI 预览不记录 credential、原始 Sentry/Agent transcript/本地路径 | 静态 boundary scan 与 CLI preview evidence | 发现凭据值、原始 payload 或 `.loopx` 私有状态被写入该模块 |
| A-09 | 回滚 | 迁移、版本与部署定位清晰；禁用/回滚不会创建外部 effect | `wrangler.jsonc` migration、commit SHA、部署日志与回滚 runbook | 版本不可定位或部署失败后无法停用服务 |

## 运行验收流程

执行顺序不可跳过：

1. 运行 `pnpm check`、`pnpm test`、`pnpm exec wrangler deploy --dry-run`。
2. 运行 `pnpm acceptance`，该脚本以 `wrangler dev --local` 启动隔离运行时，并输出 `artifacts/acceptance.json`。
3. 审核 `artifacts/acceptance.json` 是否所有 check 均为 `passed`，并确认无 credential 值。
4. 审核 `git diff --check`、`git status --short`、静态边界扫描及当前 commit SHA。
5. 仅在 A-01 至 A-09 全通过时，允许请求用户授权开启 Cloudflare 连接并创建真实资源。

## 部署后验收（需要已连接 Cloudflare）

真实 Cloudflare 环境另有一层验收。它必须使用**测试账户或独立 staging 环境**，不使用生产 Sentry/GitHub token：

| ID | 验证 | 必要证据 |
|---|---|---|
| P-01 | `GET /healthz` 与受保护 snapshot 分别按预期返回 200/401 | 请求时间、HTTP status、Worker version（不含 token） |
| P-02 | Durable Object migration `v1` 已创建；两个并发 claim 只有一个成功 | 两个 request ID、一个 201、一个 409、epoch |
| P-03 | Queue wakeup 可观测但无外部 effect | 仅 compact command ID/goal ID/epoch 的 consumer log |
| P-04 | 部署前版本与部署后版本可识别，并可回退至上一个 Worker version | 版本 ID、时间、回滚命令/链接 |
| P-05 | Cloudflare Access 或等效服务身份已覆盖 `/v1/*`；`CONTROL_PLANE_TOKEN` 为 secret 而非 vars/Git | 配置审阅、最小权限说明、secret 存在性证明 |

## 明确不验收的能力

在 GitHub、Sentry、部署、Claude Managed Agent 或其他写入 provider 通过各自独立的 extension contract 和验证前，下列能力一律处于**禁用**状态：创建/关闭 Issue、提交/批准/合并 PR、解析/resolve Sentry、部署/回滚、调用 Agent 执行命令、读取私有 repo 或 production log、持久化 Agent memory。

这不是功能缺失，而是从协调面安全演进到外部 effect 前的必要门禁。
