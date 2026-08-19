# Cloudflare Goal Control Plane

`cloudflare/goal-control-plane` 是 LoopX 的可选云端协调面，用于让本地、Cloudflare Container、Claude Managed Agent 自托管 sandbox 或其他受控执行节点围绕同一个 `goal_id` 安全接力。它补充而不取代现有 [Worker Bridge](worker-bridge-install-contract.md)：Worker Bridge 描述如何在执行环境中调用 LoopX CLI；Cloudflare Goal Control Plane 描述谁在何时拥有该目标的有效执行 lease。

## 边界

| 层 | 职责 | 不负责 |
|---|---|---|
| LoopX Kernel | 目标、todo、quota、gate、验收、writeback 与实际状态承诺 | 维持云端 Agent session 或实现多节点锁 |
| Cloudflare Goal Control Plane | goal lease、epoch、state version、命令幂等、wakeups | GitHub/Sentry/部署外部 effect、业务验收、原始 evidence 存储 |
| Worker Bridge | 执行环境内的 LoopX CLI 合同与 compact trace | 云端租约裁决与跨节点排他 |
| Agent host | 有界的 read/reproduce/implement/review/observe 工作 | 状态真相、自动解除 gate、提交未经验证的结果 |
| Provider/extension | 在获得 scope 后调用 Sentry、GitHub、部署或验证系统 | 从外部事件自行推断写权限或任务优先级 |

每个有执行资格的节点先使用 Cloudflare coordinator claim 一个 lease。该 claim 提供递增 `epoch`、随机 `lease_id` 和过期时间；后续 command 同时携带 `agent_id`、lease、epoch 与 `expected_state_version`。这使乱序、重放、旧节点恢复、重复 webhook 和多 Agent 竞争都在外部 effect 之前失败关闭。

## 与 Issue Fix 的关系

现有 `issue-fix` capability 已提供从 Issue 到复现、focused PR、reviewer route、CI/review/mergeability monitor、merged/closed outcome 与幂等 rollout event 的长程控制。[1] Cloudflare 控制面不会另建 Issue/PR 状态机，而是对一条 `repair_lineage` 的执行实例提供跨节点协调。

建议将未来 Sentry repair 的稳定键形成为：

```text
repair_key = hash(sentry_project, issue_short_id_or_fingerprint, environment, service, incident_window)
loopx_goal_id = sentry-repair-<public-safe-short-key>
```

该键只用于去重和路由。Sentry 原始 event、用户信息、完整 stacktrace、生产 request body 与 token 必须保留在各自受控来源；Cloudflare coordinator 只保存 compact ID/版本/时间/哈希。

## 推荐执行顺序

1. **Claim：** Agent host 通过 `loopx cloudflare-goal claim-request` 的合同获得 Worker 端 lease。
2. **Guard：** Agent host 再调用本地 LoopX `quota should-run`、任务 scope 和 capability gate；Cloudflare claim 不等于执行授权。
3. **Execute：** Agent 在独立 worktree/container/sandbox 完成一个 bounded action。
4. **Validate：** 独立 validator 验证 artifact、测试、CI 或外部读回。
5. **Write back：** LoopX Kernel 根据 validator receipt 更新 todo/evidence/quota；Cloudflare command receipt 只说明协调层接纳了 wakeup。
6. **Release / renew：** 节点完成、等待或即将超时时释放或续租；不允许旧 epoch 再次提交。

## 部署安全

Worker 需要配置 `CONTROL_PLANE_TOKEN` secret，且生产建议使用 Cloudflare Access/服务身份取代单一静态 bearer token。当前 Cloudflare 连接配置尚未启用，因此本分支不含部署状态、账户标识、API token、域名、Sentry DSN、GitHub credential 或 Claude API key。

Cloudflare Queue consumer 在 v1 只记录 compact wakeup，不执行 effect。任何想将 Queue 接入 Claude Managed Agent、GitHub、Sentry、release 或 merge 的未来变更，必须先提供显式 extension/provider 合同、受限 token、idempotency/epoch 校验、独立 validator、回滚路径与 smoke。

## References

[1]: ../../loopx/capabilities/issue_fix/README.md "LoopX Issue Fix Capability"
