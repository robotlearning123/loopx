from __future__ import annotations

import re
from typing import Any

CLOUDFLARE_GOAL_CONTROL_CONTRACT_VERSION = "loopx_cloudflare_goal_control_contract_v1"
CLOUDFLARE_GOAL_HTTP_REQUEST_VERSION = "loopx_cloudflare_goal_http_request_v1"
DEFAULT_CONTROL_PLANE_BASE_URL = "https://<worker-domain>"
DEFAULT_CONTROL_PLANE_TOKEN_ENV = "LOOPX_CLOUDFLARE_CONTROL_PLANE_TOKEN"
GOAL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
AGENT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
OPAQUE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$")
ACTION_KINDS = {
    "triage",
    "reproduce",
    "implement",
    "review",
    "observe",
    "merge_request",
    "closeout_request",
}
ACTION_SCOPES = {"read_only", "propose", "isolated_write"}


def _required_identifier(value: str, *, field: str, pattern: re.Pattern[str]) -> str:
    candidate = str(value or "").strip()
    if not pattern.fullmatch(candidate):
        raise ValueError(f"{field} is invalid")
    return candidate


def _base_url(value: str) -> str:
    candidate = str(value or "").strip().rstrip("/")
    if not candidate.startswith("https://"):
        raise ValueError("base_url must use https")
    if any(marker in candidate for marker in ("?", "#", "@")):
        raise ValueError("base_url must not contain credentials, query parameters, or fragments")
    return candidate


def _token_env(value: str) -> str:
    candidate = str(value or "").strip()
    if not re.fullmatch(r"[A-Z][A-Z0-9_]{2,127}", candidate):
        raise ValueError("token_env must be an uppercase environment variable name")
    return candidate


def _bounded_int(value: int, *, field: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{field} is invalid")
    return value


def build_cloudflare_goal_control_contract(
    *,
    base_url: str = DEFAULT_CONTROL_PLANE_BASE_URL,
    token_env: str = DEFAULT_CONTROL_PLANE_TOKEN_ENV,
    max_lease_seconds: int = 900,
) -> dict[str, Any]:
    """Render the versioned, effect-free contract for the Cloudflare goal plane."""

    normalized_base_url = _base_url(base_url)
    normalized_token_env = _token_env(token_env)
    maximum = _bounded_int(
        max_lease_seconds,
        field="max_lease_seconds",
        minimum=30,
        maximum=86400,
    )
    return {
        "ok": True,
        "schema_version": CLOUDFLARE_GOAL_CONTROL_CONTRACT_VERSION,
        "surface": "loopx_cloudflare_goal_control_plane_v1",
        "base_url": normalized_base_url,
        "authentication": {
            "type": "bearer_environment_reference",
            "token_env": normalized_token_env,
            "credential_value_rendered": False,
        },
        "goal_coordinator": {
            "identity": "durable_object_per_goal_id",
            "state": [
                "epoch",
                "state_version",
                "active_lease",
                "idempotency_receipts",
                "compact_command_count",
            ],
            "lease_fencing": True,
            "max_lease_seconds": maximum,
        },
        "request_routes": {
            "snapshot": "GET /v1/goals/<goal_id>/snapshot",
            "claim": "POST /v1/goals/<goal_id>/claim",
            "renew": "POST /v1/goals/<goal_id>/renew",
            "release": "POST /v1/goals/<goal_id>/release",
            "command": "POST /v1/goals/<goal_id>/commands",
        },
        "command_boundary": {
            "allowed_action_kinds": sorted(ACTION_KINDS),
            "allowed_action_scopes": sorted(ACTION_SCOPES),
            "external_effects_enabled": False,
            "queue_is_wakeup_only": True,
            "merge_closeout_deploy_and_sentry_effects": "require future explicitly authorized providers",
        },
        "privacy_boundary": {
            "raw_sentry_events_recorded": False,
            "raw_agent_transcripts_recorded": False,
            "credential_values_recorded": False,
            "local_paths_recorded": False,
        },
    }


def _request(
    *,
    base_url: str,
    token_env: str,
    endpoint: str,
    body: dict[str, Any],
) -> dict[str, Any]:
    normalized_base_url = _base_url(base_url)
    normalized_token_env = _token_env(token_env)
    return {
        "ok": True,
        "schema_version": CLOUDFLARE_GOAL_HTTP_REQUEST_VERSION,
        "method": "POST",
        "url": f"{normalized_base_url}{endpoint}",
        "headers": {
            "authorization": f"Bearer ${{{normalized_token_env}}}",
            "content-type": "application/json",
        },
        "body": body,
        "effect": "request_preview_only",
        "credential_value_rendered": False,
    }


def build_cloudflare_goal_claim_request(
    *,
    base_url: str,
    token_env: str,
    goal_id: str,
    agent_id: str,
    idempotency_key: str,
    requested_lease_seconds: int = 300,
) -> dict[str, Any]:
    goal = _required_identifier(goal_id, field="goal_id", pattern=GOAL_ID_RE)
    return _request(
        base_url=base_url,
        token_env=token_env,
        endpoint=f"/v1/goals/{goal}/claim",
        body={
            "agent_id": _required_identifier(agent_id, field="agent_id", pattern=AGENT_ID_RE),
            "idempotency_key": _required_identifier(
                idempotency_key,
                field="idempotency_key",
                pattern=OPAQUE_ID_RE,
            ),
            "requested_lease_seconds": _bounded_int(
                requested_lease_seconds,
                field="requested_lease_seconds",
                minimum=30,
                maximum=86400,
            ),
        },
    )


def build_cloudflare_goal_command_request(
    *,
    base_url: str,
    token_env: str,
    goal_id: str,
    agent_id: str,
    lease_id: str,
    epoch: int,
    command_id: str,
    action_kind: str,
    action_scope: str,
    expected_state_version: int,
) -> dict[str, Any]:
    goal = _required_identifier(goal_id, field="goal_id", pattern=GOAL_ID_RE)
    if action_kind not in ACTION_KINDS:
        raise ValueError("action_kind is invalid")
    if action_scope not in ACTION_SCOPES:
        raise ValueError("action_scope is invalid")
    return _request(
        base_url=base_url,
        token_env=token_env,
        endpoint=f"/v1/goals/{goal}/commands",
        body={
            "agent_id": _required_identifier(agent_id, field="agent_id", pattern=AGENT_ID_RE),
            "lease_id": _required_identifier(lease_id, field="lease_id", pattern=OPAQUE_ID_RE),
            "epoch": _bounded_int(epoch, field="epoch", minimum=1, maximum=2**53 - 1),
            "command_id": _required_identifier(command_id, field="command_id", pattern=OPAQUE_ID_RE),
            "action_kind": action_kind,
            "action_scope": action_scope,
            "expected_state_version": _bounded_int(
                expected_state_version,
                field="expected_state_version",
                minimum=0,
                maximum=2**53 - 1,
            ),
        },
    )


def render_cloudflare_goal_markdown(payload: dict[str, Any]) -> str:
    """Render a compact operator-readable form without credential values."""

    lines = [
        "# LoopX Cloudflare Goal Control Plane",
        "",
        f"- ok: `{payload.get('ok')}`",
        f"- schema_version: `{payload.get('schema_version')}`",
    ]
    if "surface" in payload:
        authentication = payload.get("authentication") or {}
        boundary = payload.get("command_boundary") or {}
        lines.extend(
            [
                f"- base_url: `{payload.get('base_url')}`",
                f"- token_env: `{authentication.get('token_env')}`",
                f"- lease_fencing: `{(payload.get('goal_coordinator') or {}).get('lease_fencing')}`",
                f"- external_effects_enabled: `{boundary.get('external_effects_enabled')}`",
            ]
        )
    else:
        lines.extend(
            [
                f"- method: `{payload.get('method')}`",
                f"- url: `{payload.get('url')}`",
                f"- effect: `{payload.get('effect')}`",
                "- credential_value_rendered: `False`",
                "",
                "```json",
                str(payload.get("body")),
                "```",
            ]
        )
    return "\n".join(lines) + "\n"
