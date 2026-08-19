import { describe, expect, it } from "vitest";

import { GoalCoordinator, type Env } from "../src/index";

type Store = Map<string, unknown>;

function makeCoordinator(): GoalCoordinator {
  const values: Store = new Map();
  const state = {
    storage: {
      get: async <T>(key: string): Promise<T | undefined> => values.get(key) as T | undefined,
      put: async (key: string, value: unknown): Promise<void> => {
        values.set(key, value);
      },
    },
  } as unknown as DurableObjectState;
  const env = { MAX_LEASE_SECONDS: "900" } as Env;
  return new GoalCoordinator(state, env);
}

function request(path: string, payload?: Record<string, unknown>): Request {
  return new Request(`https://coordinator.example${path}`, {
    method: payload ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-loopx-goal-id": "sentry-repair-orders-42",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

async function body(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

describe("GoalCoordinator", () => {
  it("grants exactly one active lease and replays the same claim idempotently", async () => {
    const coordinator = makeCoordinator();
    const payload = {
      agent_id: "triage-agent",
      idempotency_key: "claim-repair-orders-42-a",
      requested_lease_seconds: 300,
    };

    const first = await coordinator.fetch(request("/claim", payload));
    const firstBody = await body(first);
    expect(first.status).toBe(201);
    expect(firstBody.lease.epoch).toBe(1);
    expect(firstBody.lease.agent_id).toBe("triage-agent");

    const replay = await coordinator.fetch(request("/claim", payload));
    const replayBody = await body(replay);
    expect(replay.status).toBe(200);
    expect(replayBody.idempotent_replay).toBe(true);
    expect(replayBody.lease.lease_id).toBe(firstBody.lease.lease_id);

    const conflict = await coordinator.fetch(request("/claim", {
      agent_id: "implementer-agent",
      idempotency_key: "claim-repair-orders-42-b",
      requested_lease_seconds: 300,
    }));
    const conflictBody = await body(conflict);
    expect(conflict.status).toBe(409);
    expect(conflictBody.error.code).toBe("lease_held");
  });

  it("rejects a stale state version before accepting an agent command", async () => {
    const coordinator = makeCoordinator();
    const claim = await coordinator.fetch(request("/claim", {
      agent_id: "reproducer-agent",
      idempotency_key: "claim-repair-orders-43-a",
      requested_lease_seconds: 300,
    }));
    const claimBody = await body(claim);

    const command = await coordinator.fetch(request("/commands", {
      agent_id: "reproducer-agent",
      lease_id: claimBody.lease.lease_id,
      epoch: claimBody.lease.epoch,
      command_id: "command-repair-orders-43-a",
      action_kind: "reproduce",
      action_scope: "isolated_write",
      expected_state_version: 0,
    }));
    const commandBody = await body(command);
    expect(command.status).toBe(409);
    expect(commandBody.error.code).toBe("stale_state_version");
  });

  it("accepts a current command as a wakeup receipt without executing an external effect", async () => {
    const coordinator = makeCoordinator();
    const claim = await coordinator.fetch(request("/claim", {
      agent_id: "review-agent",
      idempotency_key: "claim-repair-orders-44-a",
      requested_lease_seconds: 300,
    }));
    const claimBody = await body(claim);

    const command = await coordinator.fetch(request("/commands", {
      agent_id: "review-agent",
      lease_id: claimBody.lease.lease_id,
      epoch: claimBody.lease.epoch,
      command_id: "command-repair-orders-44-a",
      action_kind: "review",
      action_scope: "read_only",
      expected_state_version: claimBody.state_version,
    }));
    const commandBody = await body(command);
    expect(command.status).toBe(202);
    expect(commandBody.guard).toBe("command_accepted_without_external_effect");
    expect(commandBody.queue_message.goal_id).toBe("sentry-repair-orders-42");
    expect(commandBody.queue_message.epoch).toBe(claimBody.lease.epoch);
  });
});
