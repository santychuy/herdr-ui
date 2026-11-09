"""Read-only account discovery and quota checks; run on the account's own machine."""
import base64
import concurrent.futures
import hashlib
import json
import math
import os
from pathlib import Path
import time
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Never forward a credential to a redirect destination.
    def redirect_request(self, *args, **kwargs):
        return None


def get_json(url, token, headers=None):
    request = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + token, "Accept": "application/json",
        "User-Agent": "herdr-account-usage", **(headers or {}),
    })
    with urllib.request.build_opener(NoRedirect).open(request, timeout=6) as response:
        return json.load(response)


def read_json(path, warnings):
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            raise ValueError()
        return data
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        warnings.append("Could not read " + path.name)
        return {}


def jwt(token):
    try:
        part = token.split(".")[1]
        data = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
        return data if isinstance(data, dict) else {}
    except (ValueError, IndexError, AttributeError):
        return {}


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def window(label, used, reset=None):
    if not number(used):
        return None
    return {"label": label, "remaining": max(0, min(100, 100 - used)), "reset": reset}


def codex_windows(data):
    windows = []
    for value in (data.get("rate_limit") or {}).values():
        if not isinstance(value, dict):
            continue
        seconds = value.get("limit_window_seconds")
        label = "Weekly" if seconds == 604800 else "5h" if seconds == 18000 else "Limit"
        item = window(label, value.get("used_percent"), value.get("reset_at"))
        if item:
            windows.append(item)
    return windows




def collect():
    home = Path.home()
    warnings, jobs = [], []

    def add(source, provider, credential):
        if not isinstance(credential, dict):
            return
        provider = {"opencodego": "opencode-go", "claude": "anthropic", "grok": "xai"}.get(provider, provider)
        if provider.startswith("openai-codex") or (provider == "openai" and credential.get("type") == "oauth"):
            provider = "openai-codex"
        if source in ("Pi", "OpenCode") and credential.get("type") != "oauth":
            return
        token = credential.get("access", credential.get("access_token", ""))
        if not isinstance(token, str) or not token:
            return
        claims = jwt(token)
        identity = claims.get("https://api.openai.com/auth")
        identity = identity if isinstance(identity, dict) else {}
        account = credential.get("accountId") or credential.get("account_id") or identity.get("chatgpt_account_id")
        if not account and isinstance(claims.get("sub"), str):
            account = claims["sub"] + ":" + str(claims.get("team_id") or credential.get("team_id") or "")
        stable_identity = "account:" + account if isinstance(account, str) and account else "credential:" + token
        account_id = hashlib.sha256(f"{provider}:{stable_identity}".encode()).hexdigest()[:16]
        row = {"id": account_id, "provider": provider, "windows": [], "summary": None,
               "note": "Quota not reported by this provider"}
        jobs.append((row, credential))

    codex_home = Path(os.environ.get("CODEX_HOME", str(home / ".codex")))
    auth = read_json(codex_home / "auth.json", warnings)
    tokens = auth.get("tokens") if isinstance(auth, dict) else None
    if isinstance(tokens, dict):
        add("Codex", "openai-codex", tokens)
    bar_home = home / "Library/Application Support/CodexBar"
    managed = read_json(bar_home / "managed-codex-accounts.json", warnings)
    for account in managed.get("accounts", []) if isinstance(managed, dict) else []:
        if not isinstance(account, dict) or not isinstance(account.get("managedHomePath"), str):
            continue
        path = Path(account["managedHomePath"]) / "auth.json"
        if path == codex_home / "auth.json":
            continue
        auth = read_json(path, warnings)
        tokens = auth.get("tokens") if isinstance(auth, dict) else None
        if isinstance(tokens, dict):
            add("Codex", "openai-codex", tokens)

    claude_home = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(home / ".claude")))
    claude = read_json(claude_home / ".credentials.json", warnings).get("claudeAiOauth")
    if isinstance(claude, dict) and isinstance(claude.get("accessToken"), str):
        add("Claude Code", "anthropic", {"access": claude["accessToken"], "type": "oauth"})

    opencode = read_json(home / ".local/share/opencode/auth.json", warnings)
    if isinstance(opencode, dict):
        for provider, credential in opencode.items():
            add("OpenCode", provider, credential)

    pi_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", str(home / ".pi/agent")))
    pi_auth = read_json(pi_dir / "auth.json", warnings)
    if isinstance(pi_auth, dict):
        for provider, credential in pi_auth.items():
            add("Pi", provider, credential)

    def fetch(job):
        row, credential = job
        token = credential.get("access", credential.get("access_token", ""))
        try:
            if row["provider"] == "opencode-go" and token and not token.startswith("!"):
                data = get_json("https://opencode.ai/zen/go/v1/usage", token)
                row["windows"] = [item for name, label in (("rolling", "5h"), ("weekly", "Weekly"), ("monthly", "Monthly"))
                                  if isinstance((data.get("usage") or {}).get(name), dict)
                                  for value in [data["usage"][name]]
                                  for item in [window(label, value.get("percent"), value.get("resetsAt"))] if item]
            elif row["provider"] == "xai" and token:
                data = get_json("https://cli-chat-proxy.grok.com/v1/billing?format=credits", token, {"x-xai-token-auth": "xai-grok-cli"})
                config = data.get("config") or {}
                period = config.get("currentPeriod") or {}
                label = "Weekly" if period.get("type") == "USAGE_PERIOD_TYPE_WEEKLY" else "Monthly" if period.get("type") == "USAGE_PERIOD_TYPE_MONTHLY" else "Credits"
                value = window(label, config.get("creditUsagePercent"), period.get("end") or config.get("billingPeriodEnd"))
                row["windows"] = [value] if value else []
            elif row["provider"] == "openrouter" and token and not token.startswith("!"):
                data = get_json("https://openrouter.ai/api/v1/key", token).get("data") or {}
                limit, left, used = data.get("limit"), data.get("limit_remaining"), data.get("usage_monthly")
                if number(limit) and limit > 0 and number(left):
                    row["windows"] = [window("Key spending cap", 100 * (limit - left) / limit)]
                else:
                    row["note"] = "No spending cap set" if limit is None else "Key spending cap unavailable"
                if number(used) and used >= 0:
                    row["summary"] = f"${used:.2f} used this month"
            elif row["provider"].startswith("openai-codex") and token:
                identity = jwt(token).get("https://api.openai.com/auth") or {}
                account = credential.get("accountId") or credential.get("account_id") or identity.get("chatgpt_account_id")
                headers = {"ChatGPT-Account-Id": account} if account else {}
                data = get_json("https://chatgpt.com/backend-api/wham/usage", token, headers)
                row["windows"] = codex_windows(data)
            elif row["provider"] == "anthropic" and token:
                data = get_json("https://api.anthropic.com/api/oauth/usage", token, {"anthropic-beta": "oauth-2025-04-20"})
                row["windows"] = [item for key, label in (("five_hour", "5h"), ("seven_day", "Weekly"), ("seven_day_sonnet", "Sonnet weekly"), ("seven_day_opus", "Opus weekly"))
                                  if isinstance(data.get(key), dict)
                                  for item in [window(label, data[key].get("utilization"), data[key].get("resets_at"))] if item]
            if row["windows"]:
                row["note"] = None
        except urllib.error.HTTPError as error:
            row["note"] = "Sign-in expired or usage access denied" if error.code in (401, 403) else f"Usage unavailable · HTTP {error.code}"
            error.close()
        except (OSError, ValueError, TypeError, AttributeError):
            row["note"] = "Usage unavailable · connection or provider error"
        return row

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        accounts = list(pool.map(fetch, jobs))
    merged = {}
    for row in accounts:
        existing = merged.get(row["id"])
        if existing is None:
            merged[row["id"]] = row
        elif not existing["windows"] and (row["windows"] or row["summary"]):
            # Native logins are queued first; Pi only supplies missing usage for the same identity.
            existing.update(windows=row["windows"], summary=row["summary"], note=row["note"])
    return {"accounts": list(merged.values()), "checkedAt": int(time.time() * 1000), "warnings": warnings}


if __name__ == "__main__":
    print(json.dumps(collect(), allow_nan=False))
