"""Credential-file and Linear transport contracts; never use real keys or OS stores."""
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("linear_client", Path(__file__).with_name("client.py"))
client = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(client)


class Response(io.BytesIO):
    headers = {}


class Opener:
    def __init__(self, payloads):
        self.payloads = iter(payloads)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return Response(json.dumps(next(self.payloads)).encode())


def team(identifier="team-1"):
    return {"id": identifier, "key": "ENG", "name": "Engineering"}


def identity_page(teams, more=False, cursor=None):
    return {"data": {"viewer": {"id": "viewer-1", "name": "Example"},
                     "organization": {"id": "org-1", "name": "Workspace", "urlKey": "example"},
                     "teams": {"nodes": teams, "pageInfo": {"hasNextPage": more, "endCursor": cursor}}}}


class HandoffTests(unittest.TestCase):
    def setUp(self):
        # Resolve macOS's /var -> /private/var alias; the production walk rejects symlinks.
        self.temporary = tempfile.TemporaryDirectory()
        self.home = str(Path(self.temporary.name).resolve())

    def tearDown(self):
        self.temporary.cleanup()

    def test_clean_install_with_no_backend_is_disconnected_without_network_or_plaintext_fallback(self):
        args = client.arguments(["--home", self.home, "status"])
        with patch.object(client, "credential_store", return_value=client.UnavailableStore()), patch.object(client.urllib.request, "build_opener") as network:
            result = client.execute(args, time.monotonic() + 24)
        self.assertEqual(result, {"connected": False, "storage": {
            "available": False, "label": "OS credential storage unavailable"}})
        network.assert_not_called()
        self.assertFalse((Path(self.home) / "data").exists())

    def test_native_mode_handoff_is_private_consumed_and_missing_discard_is_idempotent(self):
        path = Path(client.prepare(self.home)["handoff"])
        self.assertFalse(path.exists())
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        path.write_text("lin_api_example_not_a_real_key\n")
        path.chmod(0o644)
        self.assertEqual(client.take_handoff(self.home, str(path)), "lin_api_example_not_a_real_key")
        self.assertFalse(path.exists())
        client.take_handoff(self.home, str(path), discard=True)
        client.take_handoff(self.home, str(path), discard=True)
        other_home = Path(self.home) / "new-home"
        other_home.mkdir()
        missing = other_home / "data/linear-issues/credentials" / path.name
        client.take_handoff(str(other_home), str(missing), discard=True)

    def test_handoff_rejects_unsafe_files_without_reading_or_changing_targets(self):
        victim = Path(self.home) / "unrelated"
        victim.write_text("unrelated data")
        original_mode = stat.S_IMODE(victim.stat().st_mode)
        for kind in ("symlink", "hardlink", "writable"):
            with self.subTest(kind=kind):
                path = Path(client.prepare(self.home)["handoff"])
                if kind == "symlink":
                    path.symlink_to(victim)
                elif kind == "hardlink":
                    os.link(victim, path)
                else:
                    path.write_text("not-a-key")
                    path.chmod(0o666)
                with self.assertRaises(client.ClientError) as caught:
                    client.take_handoff(self.home, str(path))
                self.assertEqual(caught.exception.code, "unsafe_handoff")
                self.assertFalse(path.is_symlink())
                self.assertFalse(path.exists())
                self.assertEqual(victim.read_text(), "unrelated data")
                self.assertEqual(stat.S_IMODE(victim.stat().st_mode), original_mode)
        outside = Path(self.home) / "outside.key"
        outside.write_text("unrelated")
        with self.assertRaises(client.ClientError):
            client.take_handoff(self.home, str(outside), discard=True)
        self.assertTrue(outside.exists())

    def test_private_directory_is_not_silently_repaired_or_followed(self):
        path = Path(client.prepare(self.home)["handoff"])
        path.parent.chmod(0o755)
        with self.assertRaises(client.ClientError) as caught:
            client.prepare(self.home)
        self.assertEqual(caught.exception.code, "unsafe_handoff")
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o755)
        path.parent.chmod(0o700)
        target = path.parent.with_name("unrelated-directory")
        path.parent.rename(target)
        path.parent.symlink_to(target, target_is_directory=True)
        with self.assertRaises(client.ClientError):
            client.prepare(self.home)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)

    def test_crash_cleanup_removes_only_old_matching_regular_handoffs(self):
        old = Path(client.prepare(self.home)["handoff"])
        recent = Path(client.prepare(self.home)["handoff"])
        old.write_text("old-test-key")
        recent.write_text("recent-test-key")
        unrelated = old.parent / "keep.txt"
        unrelated.write_text("keep")
        symbolic = old.parent / ("handoff-" + "f" * 48 + ".key")
        symbolic.symlink_to(unrelated)
        now = time.time()
        os.utime(recent, (now + 7200, now + 7200))
        # Advance the clock, not just mtime: ctime must also be old for safe cleanup.
        with patch.object(client.time, "time", return_value=now + 3601):
            client.clean_abandoned_handoffs(self.home)
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(unrelated.exists())
        self.assertTrue(symbolic.is_symlink())

    def test_invalid_replacement_is_removed_and_never_committed(self):
        path = Path(client.prepare(self.home)["handoff"])
        path.write_text("lin_api_replacement_test")
        store = unittest.mock.Mock(available=True, label="Test credential store")
        opener = Opener([{"data": {"viewer": {"id": "partial"}},
                          "errors": [{"message": "sensitive remote diagnostic", "extensions": {"code": "UNAUTHENTICATED"}}]}])
        args = client.arguments(["--home", self.home, "connect", "--handoff", str(path)])
        with patch.object(client, "credential_store", return_value=store), patch.object(client.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(client.ClientError) as caught:
                client.execute(args, time.monotonic() + 24)
        self.assertEqual(caught.exception.code, "unauthorized")
        self.assertNotIn("sensitive", json.dumps(caught.exception.payload()))
        store.put.assert_not_called()
        self.assertFalse(path.exists())


class LinearTransportTests(unittest.TestCase):
    def test_identity_exhausts_team_connection_and_rejects_partial_or_stuck_pagination(self):
        pages = [identity_page([team()], True, "next"), identity_page([team("team-2")], False, "last")]
        opener = Opener(pages)
        with patch.object(client.urllib.request, "build_opener", return_value=opener):
            result = client.identity("test-key", time.monotonic() + 24)
        self.assertEqual([item["id"] for item in result["teams"]], ["team-1", "team-2"])
        self.assertEqual(json.loads(opener.requests[1].data)["variables"], {"after": "next"})
        bad_pages = [identity_page([], True, "next"), identity_page([team()], True, None)]
        for bad in bad_pages:
            with self.subTest(page=bad), patch.object(client.urllib.request, "build_opener", return_value=Opener([bad])):
                with self.assertRaises(client.ClientError) as caught:
                    client.identity("test-key", time.monotonic() + 24)
                self.assertEqual(caught.exception.code, "invalid_response")

    def test_mine_team_and_nonarchived_filters_are_server_side_and_page_is_preserved(self):
        issue = {"id": "issue-1", "identifier": "ENG-1", "title": "Example", "url": "https://linear.app/example/issue/ENG-1",
                 "updatedAt": "2026-11-02T12:00:00Z", "priority": 2,
                 "state": {"id": "state-1", "name": "Done", "type": "completed", "position": 4}, "team": team(),
                 "assignee": {"id": "viewer-1", "name": "Example", "avatarUrl": None}}
        opener = Opener([{"data": {"viewer": {"id": "viewer-1", "name": "Example"}}},
                         {"data": {"issues": {"nodes": [issue], "pageInfo": {"hasNextPage": True, "endCursor": "next-page"}}}}])
        with patch.object(client.urllib.request, "build_opener", return_value=opener):
            result = client.issues("test-key", "mine", "team-1", "previous-page", time.monotonic() + 24)
        self.assertEqual(result, {"issues": [issue], "pageInfo": {"hasNextPage": True, "endCursor": "next-page"}})
        variables = json.loads(opener.requests[1].data)["variables"]
        self.assertEqual(variables, {"after": "previous-page", "filter": {
            "archivedAt": {"null": True},
            "assignee": {"id": {"eq": "viewer-1"}}, "team": {"id": {"eq": "team-1"}}}})
        self.assertEqual(opener.requests[1].get_header("Authorization"), "test-key")
        self.assertEqual(opener.requests[1].full_url, "https://api.linear.app/graphql")

    def test_graphql_partial_errors_never_become_issue_success_or_leak_remote_message(self):
        payload = {"data": {"issues": {"nodes": [], "pageInfo": {"hasNextPage": False, "endCursor": None}}},
                   "errors": [{"message": "secret-value-from-provider", "extensions": {"code": "RATELIMITED"}}]}
        with patch.object(client.urllib.request, "build_opener", return_value=Opener([payload])):
            with self.assertRaises(client.ClientError) as caught:
                client.issues("test-key", "all", None, None, time.monotonic() + 24)
        self.assertEqual(caught.exception.code, "rate_limited")
        self.assertNotIn("secret-value", json.dumps(caught.exception.payload()))

    def test_avatar_cache_fetches_once_without_auth_and_keeps_issues_on_picture_failures(self):
        with tempfile.TemporaryDirectory() as home:
            url = "https://public.linear.app/avatar.png"
            picture = b"\x89PNG\r\n\x1a\n" + b"picture-bytes"
            opener = unittest.mock.Mock()
            opener.open.side_effect = lambda *args, **kwargs: Response(picture)
            rows = {"issues": [
                {"id": "one", "assignee": {"avatarUrl": url}},
                {"id": "two", "assignee": {"avatarUrl": url}},
                {"id": "unassigned", "assignee": None},
                {"id": "custom", "assignee": {"avatarUrl": "https://localhost/private"}},
                {"id": "missing", "assignee": {"avatarUrl": None}},
            ]}
            with patch.object(client.urllib.request, "build_opener", return_value=opener):
                client.cache_avatars(rows, home, time.monotonic() + 24)
                self.assertEqual(opener.open.call_count, 1)
                sent = opener.open.call_args.args[0]
                self.assertEqual(sent.full_url, url)
                self.assertIsNone(sent.get_header("Authorization"))
                path = rows["issues"][0]["assignee"]["avatarPath"]
                self.assertEqual((Path(home) / path).read_bytes(), picture)
                self.assertEqual(rows["issues"][1]["assignee"]["avatarPath"], path)
                for row in rows["issues"][3:]:
                    self.assertIsNone(row["assignee"]["avatarPath"])
                # Another page reuses the file even if the CDN is now offline.
                opener.open.side_effect = OSError("offline")
                client.cache_avatars(rows, home, time.monotonic() + 24)
                self.assertEqual(opener.open.call_count, 1)
                self.assertEqual(rows["issues"][0]["assignee"]["avatarPath"], path)
                failed = {"issues": [{"id": "kept", "assignee": {"avatarUrl": url + "?new"}}]}
                client.cache_avatars(failed, home, time.monotonic() + 24)
                self.assertEqual(failed["issues"][0]["id"], "kept")
                self.assertIsNone(failed["issues"][0]["assignee"]["avatarPath"])


if __name__ == "__main__":
    unittest.main()
