import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_DIR = join(ROOT, "artifacts");
const DEV_VARS = join(ROOT, ".dev.vars");
const PORT = Number.parseInt(process.env.LOOPX_ACCEPTANCE_PORT ?? "8799", 10);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TOKEN = "acceptance-local-control-token";
const results = [];
let worker;
let localStateRoot;

function fail(message) {
  throw new Error(message);
}

function requireTrue(condition, message) {
  if (!condition) fail(message);
}

function compact(response) {
  const body = response.body;
  return {
    id: response.id,
    status: response.status,
    error_code: body?.error?.code,
    guard: body?.guard,
    idempotent_replay: body?.idempotent_replay === true,
    epoch: body?.lease?.epoch ?? body?.epoch ?? body?.queue_message?.epoch,
    state_version: body?.state_version ?? body?.queue_message?.state_version,
    command_count: body?.goal?.command_count,
  };
}

async function call(id, method, path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body) headers["content-type"] = "application/json";
  const raw = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await raw.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { parse_error: true };
  }
  const response = { id, status: raw.status, body, text };
  results.push({ status: "passed", ...compact(response) });
  return response;
}

async function waitForHealth() {
  let lastError = "not started";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/healthz`);
      if (response.ok) return;
      lastError = `health status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail(`local Worker did not become healthy: ${lastError}`);
}

async function staticBoundaryCheck() {
  const source = await readFile(join(ROOT, "src", "index.ts"), "utf8");
  const packageFile = await readFile(join(ROOT, "package.json"), "utf8");
  requireTrue(!source.includes("api.github.com"), "coordinator source must not call GitHub");
  requireTrue(!source.includes("sentry.io"), "coordinator source must not call Sentry");
  requireTrue(source.includes("command_accepted_without_external_effect"), "command guard must state no external effect");
  requireTrue(packageFile.includes('"acceptance"'), "acceptance command must be versioned in package.json");
  results.push({
    id: "A-08-static-boundary",
    status: "passed",
    source_calls_github: false,
    source_calls_sentry: false,
    external_effect_guard_present: true,
  });
}

async function run() {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(DEV_VARS, `CONTROL_PLANE_TOKEN=${TOKEN}\n`, { encoding: "utf8", mode: 0o600 });
  localStateRoot = await mkdtemp(join(tmpdir(), "loopx-cloudflare-goal-"));
  worker = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--persist-to", localStateRoot, "--ip", "127.0.0.1", "--port", String(PORT)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLOUDFLARE_SEND_METRICS: "false" },
  });
  worker.stdout.resume();
  worker.stderr.resume();

  await waitForHealth();
  await staticBoundaryCheck();

  const health = await call("A-01-health", "GET", "/healthz");
  requireTrue(health.status === 200 && health.body.ok === true, "healthz must be publicly healthy");

  const unauthenticated = await call("A-03-no-token", "GET", "/v1/goals/sentry-repair-orders-42/snapshot");
  requireTrue(unauthenticated.status === 401, "protected snapshot must reject an absent token");

  const wrongToken = await call("A-03-wrong-token", "GET", "/v1/goals/sentry-repair-orders-42/snapshot", { token: "wrong-token" });
  requireTrue(wrongToken.status === 401, "protected snapshot must reject an incorrect token");
  requireTrue(!wrongToken.text.includes(TOKEN), "authorization failure must not echo the configured token");

  const claimPayload = {
    agent_id: "triage-agent",
    idempotency_key: "claim-repair-orders-42-a",
    requested_lease_seconds: 300,
  };
  const claim = await call("A-02-claim", "POST", "/v1/goals/sentry-repair-orders-42/claim", { token: TOKEN, body: claimPayload });
  requireTrue(claim.status === 201, "first lease claim must succeed");
  requireTrue(claim.body.lease.epoch === 1, "first lease epoch must be one");

  const conflict = await call("A-02-lease-conflict", "POST", "/v1/goals/sentry-repair-orders-42/claim", {
    token: TOKEN,
    body: { agent_id: "implementer-agent", idempotency_key: "claim-repair-orders-42-b", requested_lease_seconds: 300 },
  });
  requireTrue(conflict.status === 409 && conflict.body.error.code === "lease_held", "competing lease must fail closed");

  const replay = await call("A-05-claim-replay", "POST", "/v1/goals/sentry-repair-orders-42/claim", { token: TOKEN, body: claimPayload });
  requireTrue(replay.status === 200 && replay.body.idempotent_replay === true, "same claim must replay without a new lease");
  requireTrue(replay.body.lease.lease_id === claim.body.lease.lease_id, "claim replay must retain the original lease");

  const stale = await call("A-04-stale-state", "POST", "/v1/goals/sentry-repair-orders-42/commands", {
    token: TOKEN,
    body: {
      agent_id: "triage-agent",
      lease_id: claim.body.lease.lease_id,
      epoch: 1,
      command_id: "command-repair-orders-42-stale",
      action_kind: "triage",
      action_scope: "read_only",
      expected_state_version: 0,
    },
  });
  requireTrue(stale.status === 409 && stale.body.error.code === "stale_state_version", "stale command must be rejected");

  const commandPayload = {
    agent_id: "triage-agent",
    lease_id: claim.body.lease.lease_id,
    epoch: 1,
    command_id: "command-repair-orders-42-a",
    action_kind: "triage",
    action_scope: "read_only",
    expected_state_version: claim.body.state_version,
  };
  const command = await call("A-07-command-wakeup", "POST", "/v1/goals/sentry-repair-orders-42/commands", { token: TOKEN, body: commandPayload });
  requireTrue(command.status === 202, "current command must be accepted");
  requireTrue(command.body.guard === "command_accepted_without_external_effect", "command must be explicitly effect-free");
  requireTrue(command.body.queue_message.goal_id === "sentry-repair-orders-42", "queue message must be goal-scoped");

  const commandReplay = await call("A-05-command-replay", "POST", "/v1/goals/sentry-repair-orders-42/commands", { token: TOKEN, body: commandPayload });
  requireTrue(commandReplay.status === 200 && commandReplay.body.idempotent_replay === true, "same command must replay idempotently");

  const snapshot = await call("A-05-snapshot", "GET", "/v1/goals/sentry-repair-orders-42/snapshot", { token: TOKEN });
  requireTrue(snapshot.status === 200, "authenticated snapshot must succeed");
  requireTrue(snapshot.body.goal.command_count === 1, "command replay must not increment command count");
  requireTrue(snapshot.body.goal.public_boundary.external_effects_enabled === false, "snapshot must preserve effect-free boundary");

  const release = await call("A-06-release", "POST", "/v1/goals/sentry-repair-orders-42/release", {
    token: TOKEN,
    body: {
      agent_id: "triage-agent",
      lease_id: claim.body.lease.lease_id,
      epoch: 1,
      idempotency_key: "release-repair-orders-42-a",
    },
  });
  requireTrue(release.status === 200, "current lease must be releasable");

  const reclaim = await call("A-06-reclaim", "POST", "/v1/goals/sentry-repair-orders-42/claim", {
    token: TOKEN,
    body: { agent_id: "review-agent", idempotency_key: "claim-repair-orders-42-c", requested_lease_seconds: 300 },
  });
  requireTrue(reclaim.status === 201 && reclaim.body.lease.epoch === 2, "reclaim after release must advance epoch");

  const oldLease = await call("A-06-old-lease-rejected", "POST", "/v1/goals/sentry-repair-orders-42/commands", {
    token: TOKEN,
    body: {
      agent_id: "triage-agent",
      lease_id: claim.body.lease.lease_id,
      epoch: 1,
      command_id: "command-repair-orders-42-old",
      action_kind: "triage",
      action_scope: "read_only",
      expected_state_version: reclaim.body.state_version,
    },
  });
  requireTrue(oldLease.status === 409 && oldLease.body.error.code === "stale_or_invalid_lease", "old lease must not resume after reclaim");
}

async function closeWorker() {
  if (!worker || worker.exitCode !== null) return;
  worker.kill("SIGTERM");
  await Promise.race([
    once(worker, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
}

let overallStatus = "passed";
let fatalError;
try {
  await run();
} catch (error) {
  overallStatus = "failed";
  fatalError = error instanceof Error ? error.message : String(error);
  results.push({ id: "fatal", status: "failed", message: fatalError });
} finally {
  await closeWorker();
  await rm(DEV_VARS, { force: true });
  if (localStateRoot) await rm(localStateRoot, { recursive: true, force: true });
  const artifact = {
    schema_version: "loopx_cloudflare_goal_control_plane_acceptance_v1",
    executed_at: new Date().toISOString(),
    local_only: true,
    external_effects_executed: false,
    credential_values_recorded: false,
    overall_status: overallStatus,
    checks: results,
  };
  await writeFile(join(ARTIFACT_DIR, "acceptance.json"), `${JSON.stringify(artifact, null, 2)}\n`);
}

if (overallStatus !== "passed") {
  console.error(`Acceptance failed: ${fatalError}`);
  process.exitCode = 1;
} else {
  console.log(`Acceptance passed: ${results.length} checks; artifact written to artifacts/acceptance.json`);
}
