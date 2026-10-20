"""Resolve and enforce the observable contracts declared by each runtime patch."""

from __future__ import annotations

import json
from pathlib import Path

CHECKS = {
    "locked-build": {},
    "protocol": {},
    "helper-dispatch": {},
    "runtime-e2e": {},
    "dependency-boundary": {"dependencies": ["codex-cli", "codex-tui", "codex-exec", "codex-cloud-tasks", "codex-app-server-daemon"]},
    "explicit-provider": {},
    "local-config": {"dependencies": ["codex-cloud-config"]},
    "no-remote-control": {"methods": ["remoteControl/enable", "remoteControl/disable", "remoteControl/status/read", "remoteControl/pairing/start", "remoteControl/pairing/status", "remoteControl/client/list", "remoteControl/client/revoke", "remoteControl/status/changed"]},
    "no-native-skills": {},
    "no-native-plugins": {"methods": ["marketplace/add", "marketplace/remove", "marketplace/upgrade", "plugin/list", "plugin/search", "plugin/installed", "plugin/reconcile", "plugin/read", "plugin/skill/read", "plugin/share/save", "plugin/share/updateTargets", "plugin/share/list", "plugin/share/checkout", "plugin/share/delete", "plugin/install", "plugin/uninstall"]},
    "no-official-apps": {"methods": ["app/read", "app/list", "app/installed", "app/list/updated"]},
    "no-cloud-history-notes": {"dependencies": ["codex-history-notes-extension"]},
    "no-cloud-git-attribution": {"dependencies": ["codex-git-attribution"]},
    "provider-model-catalog": {},
    "provider-compaction": {},
    "no-feedback-upload": {"methods": ["feedback/upload"]},
    "no-analytics-upload": {},
    "no-otel-exporters": {"dependencies": ["opentelemetry-otlp", "opentelemetry-appender-tracing"]},
    "provider-auth-only": {"methods": ["account/login/start", "account/login/cancel", "account/logout", "account/read", "account/rateLimits/read", "account/rateLimitResetCredit/consume", "account/usage/read", "account/workspaceMessages/read", "account/sendAddCreditsNudgeEmail", "account/chatgptAuthTokens/refresh", "account/updated", "account/rateLimits/updated", "account/login/completed", "getAuthStatus", "account/bedrock/discover", "account/bedrock/setup", "account/bedrock/checkGovCloudRequirements"]},
    "araceae-executable-names": {"references": ["codex-linux-sandbox", "codex-code-mode-host", "codex-command-runner", "codex-windows-sandbox-setup"]},
    "araceae-package-layout": {"references": ["codex-resources", "codex-path", "codex-package.json"]},
    "araceae-home-directory": {"references": ["~/.codex"]},
    "provider-auth-rejected-token": {},
    "platform-error-envelope": {},
    "subagent-model-lock": {},
    "application-context-world-state": {},
    "apply-patch-function-tool": {},
    "raw-usage-notifications": {},
    "chat-wire-api": {},
}


def selected_checks(root: Path, patches: list[dict]) -> dict:
    metadata = json.loads((root / "patches/codex/metadata.json").read_text(encoding="utf-8"))
    names = dict.fromkeys(check for patch in patches for check in metadata[patch["name"]].get("checks", []))
    unknown = names.keys() - CHECKS.keys()
    if unknown:
        raise ValueError(f"Unknown patch checks: {sorted(unknown)}")
    return {name: CHECKS[name] for name in names}


def check_removed_surface(checks: dict, methods: set[str], dependencies: set[str]):
    for name, contract in checks.items():
        remaining = methods.intersection(contract.get("methods", []))
        reachable = dependencies.intersection(contract.get("dependencies", []))
        if remaining or reachable:
            raise ValueError(f"{name} failed: remaining methods {sorted(remaining)}, reachable dependencies {sorted(reachable)}")


def check_binary_references(checks: dict, binary: Path):
    """Reject an entrypoint that still embeds names retired by a selected patch.

    The entrypoint resolves helpers, arg0 aliases, and package layout paths from names stored in its
    read-only data, so a remaining name means some code path can still look up the retired name.
    """
    references = {name: contract["references"] for name, contract in checks.items() if contract.get("references")}
    if not references:
        return
    content = Path(binary).read_bytes()
    for name, names in references.items():
        remaining = [reference for reference in names if reference.encode() in content]
        if remaining:
            raise ValueError(f"{name} failed: {Path(binary).name} still references {remaining}")
