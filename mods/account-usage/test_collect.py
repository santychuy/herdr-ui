import base64
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch
from urllib.error import HTTPError

import collect


class AccountsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.home_patch = patch.object(Path, "home", return_value=self.home)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)
        self.env_patch = patch.dict(os.environ, {}, clear=True)
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

    def save(self, name, data):
        path = self.home / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))
        return path

    def test_provider_logins_merge_matching_oauth_and_never_export_credentials(self):
        claims = {"email": "owner@example.com", "https://api.openai.com/auth": {"chatgpt_account_id": "account-one"}}
        token = "header." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + ".secret-signature"
        self.save(".pi/agent/auth.json", {
            "openai-codex": {"type": "oauth", "access": token, "refresh": "never-export-refresh"},
            "meta": {"type": "api_key", "key": "never-export-api-key"},
        })
        self.save(".codex/auth.json", {"tokens": {"access_token": token, "account_id": "account-one"}})
        before = {str(p): p.read_bytes() for p in self.home.rglob("*") if p.is_file()}
        usage = {"rate_limit": {"primary_window": {"used_percent": 100, "limit_window_seconds": 18000, "reset_at": 2000000000},
                                 "secondary_window": {"used_percent": 4, "limit_window_seconds": 604800}}}
        with patch.object(collect, "get_json", return_value=usage):
            result = collect.collect()
        self.assertEqual(len(result["accounts"]), 1, "Pi OAuth matching Codex is one provider account; API keys are not subscriptions")
        account = result["accounts"][0]
        self.assertEqual(account["provider"], "openai-codex")
        self.assertEqual([(w["label"], w["remaining"]) for w in account["windows"]], [("5h", 0), ("Weekly", 96)])
        self.assertNotIn("label", account)
        self.assertNotIn("harnesses", account)
        output = json.dumps(result)
        for secret in (token, "never-export-refresh", "never-export-api-key", "owner@example.com"):
            self.assertNotIn(secret, output)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.home.rglob("*") if p.is_file()})

    def test_one_failed_account_does_not_hide_another_accounts_usage(self):
        self.save(".pi/agent/auth.json", {"openai-codex": {"type": "oauth", "access": "expired"}, "anthropic": {"type": "oauth", "access": "fresh"}})

        def usage(url, token, headers=None):
            if token == "expired":
                raise HTTPError(url, 401, "sensitive response must not be shown", {}, None)
            return {"five_hour": {"utilization": 35, "resets_at": "2030-01-01T00:00:00Z"}}

        with patch.object(collect, "get_json", side_effect=usage):
            failed, good = collect.collect()["accounts"]
        self.assertEqual(failed["windows"], [])
        self.assertIn("Sign-in expired", failed["note"])
        self.assertEqual(good["windows"][0]["remaining"], 65)
        self.assertIsNone(good["note"])

    def test_native_login_is_preferred_and_same_email_workspaces_stay_separate(self):
        def token(account, suffix):
            claims = {"email": "same@example.com", "https://api.openai.com/auth": {"chatgpt_account_id": account}}
            return "h." + base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=") + "." + suffix

        self.save(".pi/agent/auth.json", {"openai-codex": {"type": "oauth", "access": token("personal", "pi")}})
        self.save(".codex/auth.json", {"tokens": {"access_token": token("personal", "native")}})
        work = self.save("work/auth.json", {"tokens": {"access_token": token("work", "native")}})
        self.save("Library/Application Support/CodexBar/managed-codex-accounts.json", {"accounts": [{"managedHomePath": str(work.parent), "email": "same@example.com", "workspaceLabel": "Work"}]})

        def usage(url, token, headers=None):
            used = 60 if token.endswith(".pi") else 4 if headers["ChatGPT-Account-Id"] == "personal" else 25
            return {"rate_limit": {"primary_window": {"used_percent": used, "limit_window_seconds": 604800}}}

        with patch.object(collect, "get_json", side_effect=usage):
            accounts = collect.collect()["accounts"]
        self.assertEqual(len(accounts), 2)
        self.assertEqual([row["windows"][0]["remaining"] for row in accounts], [96, 75])
        self.assertTrue(all(row["note"] is None for row in accounts))

    def test_provider_oauth_usage_excludes_api_keys_and_codexbar_provider_entries(self):
        self.save(".pi/agent/auth.json", {
            "xai": {"type": "oauth", "access": "grok-secret"},
            "opencode-go": {"type": "api_key", "key": "pi-go-secret"},
            "openrouter": {"type": "oauth", "access": "router-secret"},
            "anthropic": {"type": "api_key", "key": "anthropic-secret"},
        })
        self.save(".config/codexbar/config.json", {"providers": [{"id": "opencodego", "enabled": True, "apiKey": "bar-go-secret"}]})
        self.save(".local/share/opencode/auth.json", {"opencode-go": {"type": "oauth", "access": "go-oauth"}, "openrouter": {"type": "api", "key": "other-router-secret"}})
        calls = []

        def usage(url, token, headers=None):
            calls.append((url, token))
            if token == "grok-secret":
                return {"config": {"creditUsagePercent": 12, "currentPeriod": {"type": "USAGE_PERIOD_TYPE_WEEKLY", "end": "2030-01-01T00:00:00Z"}}}
            if token == "go-oauth":
                return {"usage": {"rolling": {"percent": 0.5}, "weekly": {"percent": 5}, "monthly": {"percent": 15}}}
            return {"data": {"limit": None, "usage_monthly": 1.25}}

        with patch.object(collect, "get_json", side_effect=usage):
            accounts = collect.collect()["accounts"]
        by_provider = {account["provider"]: account for account in accounts}
        self.assertEqual(set(by_provider), {"xai", "opencode-go", "openrouter"})
        self.assertEqual(by_provider["xai"]["windows"][0]["remaining"], 88)
        self.assertEqual([w["remaining"] for w in by_provider["opencode-go"]["windows"]], [99.5, 95, 85])
        router = by_provider["openrouter"]
        self.assertEqual(router["windows"], [])
        self.assertEqual(router["summary"], "$1.25 used this month")
        self.assertIn("No spending cap", router["note"])
        self.assertEqual({token for _, token in calls}, {"grok-secret", "go-oauth", "router-secret"})

    def test_missing_provider_logins_are_empty_and_malformed_credentials_report_a_warning(self):
        self.assertEqual(collect.collect()["accounts"], [])
        self.save(".claude/settings.json", {})
        self.save(".pi/agent/auth.json", {"anthropic": {"type": "api_key", "key": "api-only"}})
        self.assertEqual(collect.collect()["accounts"], [])
        path = self.save(".pi/agent/auth.json", {})
        path.write_text("broken JSON")
        result = collect.collect()
        self.assertEqual(result["accounts"], [])
        self.assertEqual(result["warnings"], ["Could not read auth.json"])

    def test_redirect_does_not_forward_authorization(self):
        paths = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                paths.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/credential-leak")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with self.assertRaises(HTTPError) as raised:
                collect.get_json(f"http://127.0.0.1:{server.server_port}/usage", "private-token")
            raised.exception.close()
            self.assertEqual(paths, ["/usage"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
