from __future__ import annotations

import argparse
from collections.abc import Callable

from ..cloudflare_goal import (
    ACTION_KINDS,
    ACTION_SCOPES,
    DEFAULT_CONTROL_PLANE_BASE_URL,
    DEFAULT_CONTROL_PLANE_TOKEN_ENV,
    build_cloudflare_goal_claim_request,
    build_cloudflare_goal_command_request,
    build_cloudflare_goal_control_contract,
    render_cloudflare_goal_markdown,
)

PrintPayload = Callable[[dict[str, object], str, Callable[[dict[str, object]], str]], None]
OutputFormat = Callable[[argparse.Namespace], str]
CLOUDFLARE_GOAL_COMMANDS = {"contract", "claim-request", "command-request"}


def register_cloudflare_goal_commands(
    subparsers: argparse._SubParsersAction,
    add_subcommand_format: Callable[[argparse.ArgumentParser], None],
) -> None:
    parser = subparsers.add_parser(
        "cloudflare-goal",
        help="Render fail-closed Cloudflare goal-control contracts and request previews.",
    )
    child = parser.add_subparsers(dest="cloudflare_goal_command")

    contract = child.add_parser("contract", help="Render the Cloudflare goal-control contract.")
    add_subcommand_format(contract)
    _add_connection_args(contract)
    contract.add_argument(
        "--max-lease-seconds",
        type=int,
        default=900,
        help="Maximum coordinator lease duration in seconds.",
    )

    claim = child.add_parser("claim-request", help="Render a lease-claim request preview.")
    add_subcommand_format(claim)
    _add_connection_args(claim)
    claim.add_argument("--goal-id", required=True)
    claim.add_argument("--agent-id", required=True)
    claim.add_argument("--idempotency-key", required=True)
    claim.add_argument("--requested-lease-seconds", type=int, default=300)

    command = child.add_parser(
        "command-request",
        help="Render a non-executing, lease-fenced command request preview.",
    )
    add_subcommand_format(command)
    _add_connection_args(command)
    command.add_argument("--goal-id", required=True)
    command.add_argument("--agent-id", required=True)
    command.add_argument("--lease-id", required=True)
    command.add_argument("--epoch", type=int, required=True)
    command.add_argument("--command-id", required=True)
    command.add_argument("--action-kind", choices=sorted(ACTION_KINDS), required=True)
    command.add_argument("--action-scope", choices=sorted(ACTION_SCOPES), required=True)
    command.add_argument("--expected-state-version", type=int, required=True)


def _add_connection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--base-url",
        default=DEFAULT_CONTROL_PLANE_BASE_URL,
        help="HTTPS URL for the Cloudflare Worker. Defaults to a safe placeholder.",
    )
    parser.add_argument(
        "--token-env",
        default=DEFAULT_CONTROL_PLANE_TOKEN_ENV,
        help="Environment variable name holding the bearer token; no value is printed.",
    )


def handle_cloudflare_goal_command(
    args: argparse.Namespace,
    *,
    print_payload: PrintPayload,
    output_format: OutputFormat,
) -> int | None:
    if args.command != "cloudflare-goal":
        return None
    if args.cloudflare_goal_command not in CLOUDFLARE_GOAL_COMMANDS:
        payload: dict[str, object] = {
            "ok": False,
            "mode": "cloudflare-goal",
            "error": "cloudflare-goal requires contract, claim-request, or command-request",
        }
        print_payload(payload, output_format(args), render_cloudflare_goal_markdown)
        return 1

    try:
        if args.cloudflare_goal_command == "contract":
            payload = build_cloudflare_goal_control_contract(
                base_url=args.base_url,
                token_env=args.token_env,
                max_lease_seconds=args.max_lease_seconds,
            )
        elif args.cloudflare_goal_command == "claim-request":
            payload = build_cloudflare_goal_claim_request(
                base_url=args.base_url,
                token_env=args.token_env,
                goal_id=args.goal_id,
                agent_id=args.agent_id,
                idempotency_key=args.idempotency_key,
                requested_lease_seconds=args.requested_lease_seconds,
            )
        else:
            payload = build_cloudflare_goal_command_request(
                base_url=args.base_url,
                token_env=args.token_env,
                goal_id=args.goal_id,
                agent_id=args.agent_id,
                lease_id=args.lease_id,
                epoch=args.epoch,
                command_id=args.command_id,
                action_kind=args.action_kind,
                action_scope=args.action_scope,
                expected_state_version=args.expected_state_version,
            )
    except Exception as exc:
        payload = {
            "ok": False,
            "mode": "cloudflare-goal",
            "error": str(exc),
        }
    print_payload(payload, output_format(args), render_cloudflare_goal_markdown)
    return 0 if payload.get("ok") else 1
