export interface Env {
  GOAL_COORDINATOR: DurableObjectNamespace;
  GOAL_COMMANDS: Queue<GoalCommandMessage>;
  CONTROL_PLANE_TOKEN?: string;
  CONTROL_PLANE_VERSION?: string;
  MAX_LEASE_SECONDS?: string;
}

type GoalStatus = "active" | "blocked" | "completed" | "cancelled";
type ActionKind =
  | "triage"
  | "reproduce"
  | "implement"
  | "review"
  | "observe"
  | "merge_request"
  | "closeout_request";
type ActionScope = "read_only" | "propose" | "isolated_write";

type Lease = {
  agent_id: string;
  lease_id: string;
  epoch: number;
  expires_at: string;
};

type Receipt = {
  idempotency_key: string;
  operation: string;
  response: Record<string, unknown>;
  created_at: string;
};

type GoalState = {
  schema_version: "loopx_cloud_goal_state_v1";
  goal_id: string;
  status: GoalStatus;
  epoch: number;
  state_version: number;
  active_lease?: Lease;
  command_count: number;
  receipts: Receipt[];
  updated_at: string;
};

type GoalCommandMessage = {
  schema_version: "loopx_cloud_goal_command_v1";
  goal_id: string;
  command_id: string;
  action_kind: ActionKind;
  action_scope: ActionScope;
  epoch: number;
  lease_id: string;
  state_version: number;
  submitted_at: string;
};

const GOAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const OPAQUE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/;
const ACTION_KINDS = new Set<ActionKind>([
  "triage",
  "reproduce",
  "implement",
  "review",
  "observe",
  "merge_request",
  "closeout_request",
]);
const ACTION_SCOPES = new Set<ActionScope>([
  "read_only",
  "propose",
  "isolated_write",
]);
const MAX_RECEIPTS = 100;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({
        ok: true,
        schema_version: "loopx_cloud_control_plane_health_v1",
        control_plane_version: env.CONTROL_PLANE_VERSION ?? "cloudflare_goal_control_plane_v1",
      });
    }

    const authFailure = authorize(request, env);
    if (authFailure) return authFailure;

    const match = url.pathname.match(/^\/v1\/goals\/([A-Za-z0-9._-]+)(?:\/(claim|renew|release|commands|snapshot))?$/);
    if (!match) return error(404, "route_not_found", "route is not defined");

    const goalId = match[1];
    const operation = match[2];
    if (!goalId || !GOAL_ID_RE.test(goalId)) {
      return error(400, "invalid_goal_id", "goal_id is invalid");
    }
    if (!operation && request.method === "GET") {
      return goalRequest(env, goalId, "/snapshot", request);
    }
    if (operation === "snapshot" && request.method === "GET") {
      return goalRequest(env, goalId, "/snapshot", request);
    }
    if (!operation || request.method !== "POST") {
      return error(405, "method_not_allowed", "method is not allowed for this route");
    }

    const response = await goalRequest(env, goalId, `/${operation}`, request);
    if (operation !== "commands" || !response.ok) return response;

    const body = (await response.clone().json()) as Record<string, unknown>;
    const message = body.queue_message as GoalCommandMessage | undefined;
    if (!message) return response;

    // Queue delivery is deliberately advisory in v1. Consumers must never execute
    // an external effect; they only wake a separately authorized executor.
    try {
      await env.GOAL_COMMANDS.send(message);
      return json({ ...body, queue_delivery: "accepted" }, response.status);
    } catch {
      return json({ ...body, queue_delivery: "unavailable" }, response.status);
    }
  },

  async queue(batch: MessageBatch<GoalCommandMessage>): Promise<void> {
    for (const message of batch.messages) {
      const item = message.body;
      console.log(JSON.stringify({
        event: "loopx_goal_command_wakeup_v1",
        goal_id: item.goal_id,
        command_id: item.command_id,
        action_kind: item.action_kind,
        epoch: item.epoch,
      }));
      message.ack();
    }
  },
};

export class GoalCoordinator implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const goalId = request.headers.get("x-loopx-goal-id") ?? "";
      if (!GOAL_ID_RE.test(goalId)) return error(400, "invalid_goal_id", "goal_id is invalid");

      switch (`${request.method} ${url.pathname}`) {
        case "GET /snapshot":
          return json({ ok: true, goal: publicGoal(await this.load(goalId)) });
        case "POST /claim":
          return this.claim(goalId, await parseJsonObject(request));
        case "POST /renew":
          return this.renew(goalId, await parseJsonObject(request));
        case "POST /release":
          return this.release(goalId, await parseJsonObject(request));
        case "POST /commands":
          return this.command(goalId, await parseJsonObject(request));
        default:
          return error(404, "route_not_found", "goal route is not defined");
      }
    } catch (caught) {
      if (caught instanceof HttpProblem) {
        return error(caught.status, caught.code, caught.message, caught.details);
      }
      return error(500, "coordinator_internal_error", "goal coordinator failed safely");
    }
  }

  private async load(goalId: string): Promise<GoalState> {
    const stored = await this.state.storage.get<GoalState>("goal_state");
    if (stored) return stored;
    const now = new Date().toISOString();
    return {
      schema_version: "loopx_cloud_goal_state_v1",
      goal_id: goalId,
      status: "active",
      epoch: 0,
      state_version: 0,
      command_count: 0,
      receipts: [],
      updated_at: now,
    };
  }

  private async save(goal: GoalState): Promise<void> {
    await this.state.storage.put("goal_state", goal);
  }

  private prior(goal: GoalState, operation: string, idempotencyKey: string): Response | undefined {
    const prior = goal.receipts.find(
      (receipt) => receipt.operation === operation && receipt.idempotency_key === idempotencyKey,
    );
    if (!prior) return undefined;
    return json({ ...prior.response, idempotent_replay: true });
  }

  private remember(
    goal: GoalState,
    operation: string,
    idempotencyKey: string,
    response: Record<string, unknown>,
  ): void {
    goal.receipts = [
      ...goal.receipts,
      {
        idempotency_key: idempotencyKey,
        operation,
        response,
        created_at: new Date().toISOString(),
      },
    ].slice(-MAX_RECEIPTS);
  }

  private async claim(goalId: string, input: Record<string, unknown>): Promise<Response> {
    const agentId = requiredOpaque(input, "agent_id", AGENT_ID_RE);
    const idempotencyKey = requiredOpaque(input, "idempotency_key", OPAQUE_ID_RE);
    const requestedLeaseSeconds = boundedInteger(
      input.requested_lease_seconds ?? 300,
      "requested_lease_seconds",
      30,
      maxLeaseSeconds(this.env),
    );
    const goal = await this.load(goalId);
    const replay = this.prior(goal, "claim", idempotencyKey);
    if (replay) return replay;

    const now = Date.now();
    if (goal.status !== "active") {
      return error(409, "goal_not_active", "goal cannot be claimed in its current status");
    }
    if (goal.active_lease && !leaseExpired(goal.active_lease, now)) {
      return error(409, "lease_held", "goal already has an active lease", {
        holder: goal.active_lease.agent_id,
        epoch: goal.active_lease.epoch,
      });
    }

    const epoch = goal.epoch + 1;
    const lease: Lease = {
      agent_id: agentId,
      lease_id: crypto.randomUUID(),
      epoch,
      expires_at: new Date(now + requestedLeaseSeconds * 1000).toISOString(),
    };
    goal.epoch = epoch;
    goal.active_lease = lease;
    goal.state_version += 1;
    goal.updated_at = new Date(now).toISOString();
    const response = {
      ok: true,
      schema_version: "loopx_cloud_goal_lease_v1",
      goal_id: goalId,
      lease,
      state_version: goal.state_version,
      guard: "lease_granted",
    };
    this.remember(goal, "claim", idempotencyKey, response);
    await this.save(goal);
    return json(response, 201);
  }

  private async renew(goalId: string, input: Record<string, unknown>): Promise<Response> {
    const idempotencyKey = requiredOpaque(input, "idempotency_key", OPAQUE_ID_RE);
    const goal = await this.load(goalId);
    const replay = this.prior(goal, "renew", idempotencyKey);
    if (replay) return replay;

    const lease = assertCurrentLease(goal, input);
    const requestedLeaseSeconds = boundedInteger(
      input.requested_lease_seconds ?? 300,
      "requested_lease_seconds",
      30,
      maxLeaseSeconds(this.env),
    );
    if (leaseExpired(lease, Date.now())) {
      return error(409, "lease_expired", "expired leases cannot be renewed");
    }

    lease.expires_at = new Date(Date.now() + requestedLeaseSeconds * 1000).toISOString();
    goal.state_version += 1;
    goal.updated_at = new Date().toISOString();
    const response = {
      ok: true,
      schema_version: "loopx_cloud_goal_lease_v1",
      goal_id: goalId,
      lease,
      state_version: goal.state_version,
      guard: "lease_renewed",
    };
    this.remember(goal, "renew", idempotencyKey, response);
    await this.save(goal);
    return json(response);
  }

  private async release(goalId: string, input: Record<string, unknown>): Promise<Response> {
    const idempotencyKey = requiredOpaque(input, "idempotency_key", OPAQUE_ID_RE);
    const goal = await this.load(goalId);
    const replay = this.prior(goal, "release", idempotencyKey);
    if (replay) return replay;

    assertCurrentLease(goal, input);
    goal.active_lease = undefined;
    goal.state_version += 1;
    goal.updated_at = new Date().toISOString();
    const response = {
      ok: true,
      schema_version: "loopx_cloud_goal_lease_v1",
      goal_id: goalId,
      epoch: goal.epoch,
      state_version: goal.state_version,
      guard: "lease_released",
    };
    this.remember(goal, "release", idempotencyKey, response);
    await this.save(goal);
    return json(response);
  }

  private async command(goalId: string, input: Record<string, unknown>): Promise<Response> {
    const commandId = requiredOpaque(input, "command_id", OPAQUE_ID_RE);
    const actionKind = requiredEnum(input, "action_kind", ACTION_KINDS);
    const actionScope = requiredEnum(input, "action_scope", ACTION_SCOPES);
    const goal = await this.load(goalId);
    const replay = this.prior(goal, "command", commandId);
    if (replay) return replay;

    const lease = assertCurrentLease(goal, input);
    if (leaseExpired(lease, Date.now())) {
      return error(409, "lease_expired", "expired leases cannot accept commands");
    }
    const expectedStateVersion = boundedInteger(
      input.expected_state_version,
      "expected_state_version",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (expectedStateVersion !== goal.state_version) {
      return error(409, "stale_state_version", "command does not match the current goal state", {
        current_state_version: goal.state_version,
      });
    }

    // v1 accepts only non-external scopes. Merge, closeout, deployment, Sentry,
    // and GitHub effects are intentionally left for explicitly authorized providers.
    goal.command_count += 1;
    goal.state_version += 1;
    goal.updated_at = new Date().toISOString();
    const queueMessage: GoalCommandMessage = {
      schema_version: "loopx_cloud_goal_command_v1",
      goal_id: goalId,
      command_id: commandId,
      action_kind: actionKind,
      action_scope: actionScope,
      epoch: lease.epoch,
      lease_id: lease.lease_id,
      state_version: goal.state_version,
      submitted_at: goal.updated_at,
    };
    const response = {
      ok: true,
      schema_version: "loopx_cloud_goal_command_receipt_v1",
      goal_id: goalId,
      command_id: commandId,
      action_kind: actionKind,
      action_scope: actionScope,
      epoch: lease.epoch,
      state_version: goal.state_version,
      guard: "command_accepted_without_external_effect",
      queue_message: queueMessage,
    };
    this.remember(goal, "command", commandId, response);
    await this.save(goal);
    return json(response, 202);
  }
}

function authorize(request: Request, env: Env): Response | undefined {
  const configured = env.CONTROL_PLANE_TOKEN;
  if (!configured) {
    return error(503, "control_plane_token_unconfigured", "control plane is not configured for authenticated access");
  }
  const supplied = request.headers.get("authorization");
  if (supplied !== `Bearer ${configured}`) {
    return error(401, "unauthorized", "authorization failed");
  }
  return undefined;
}

async function goalRequest(env: Env, goalId: string, suffix: string, request: Request): Promise<Response> {
  const id = env.GOAL_COORDINATOR.idFromName(`goal:${goalId}`);
  const coordinator = env.GOAL_COORDINATOR.get(id);
  const url = new URL(request.url);
  url.pathname = suffix;
  const coordinatorRequest = new Request(url, request);
  coordinatorRequest.headers.set("x-loopx-goal-id", goalId);
  return coordinator.fetch(coordinatorRequest);
}

async function parseJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not_object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpProblem(400, "invalid_json", "request body must be a JSON object");
  }
}

function requiredOpaque(value: Record<string, unknown>, field: string, pattern: RegExp): string {
  const candidate = value[field];
  if (typeof candidate !== "string" || !pattern.test(candidate)) {
    throw new HttpProblem(400, `invalid_${field}`, `${field} is invalid`);
  }
  return candidate;
}

function requiredEnum<T extends string>(
  value: Record<string, unknown>,
  field: string,
  allowed: Set<T>,
): T {
  const candidate = value[field];
  if (typeof candidate !== "string" || !allowed.has(candidate as T)) {
    throw new HttpProblem(400, `invalid_${field}`, `${field} is invalid`);
  }
  return candidate as T;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new HttpProblem(400, `invalid_${field}`, `${field} is invalid`);
  }
  return value;
}

function assertCurrentLease(goal: GoalState, input: Record<string, unknown>): Lease {
  const lease = goal.active_lease;
  const agentId = requiredOpaque(input, "agent_id", AGENT_ID_RE);
  const leaseId = requiredOpaque(input, "lease_id", OPAQUE_ID_RE);
  const epoch = boundedInteger(input.epoch, "epoch", 1, Number.MAX_SAFE_INTEGER);
  if (!lease || lease.agent_id !== agentId || lease.lease_id !== leaseId || lease.epoch !== epoch) {
    throw new HttpProblem(409, "stale_or_invalid_lease", "lease does not match the goal coordinator");
  }
  return lease;
}

function leaseExpired(lease: Lease, now: number): boolean {
  return Number.isNaN(Date.parse(lease.expires_at)) || Date.parse(lease.expires_at) <= now;
}

function maxLeaseSeconds(env: Env): number {
  const configured = Number.parseInt(env.MAX_LEASE_SECONDS ?? "900", 10);
  return Number.isSafeInteger(configured) && configured >= 30 ? configured : 900;
}

function publicGoal(goal: GoalState): Record<string, unknown> {
  return {
    schema_version: goal.schema_version,
    goal_id: goal.goal_id,
    status: goal.status,
    epoch: goal.epoch,
    state_version: goal.state_version,
    active_lease: goal.active_lease,
    command_count: goal.command_count,
    updated_at: goal.updated_at,
    public_boundary: {
      raw_payloads_recorded: false,
      credential_values_recorded: false,
      external_effects_enabled: false,
    },
  };
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    override readonly message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function error(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return json({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, status);
}

export { HttpProblem };
