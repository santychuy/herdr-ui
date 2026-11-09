"""Local-only Linear personal-key bridge. Stdout is a single sanitized JSON result."""
import argparse
import ctypes
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from email.utils import parsedate_to_datetime


ENDPOINT = "https://api.linear.app/graphql"
SERVICE = "app.herdr.linear-issues"
MAX_KEY_BYTES = 4096
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
HANDOFF_TTL = 3600
HANDOFF_NAME = re.compile(r"handoff-[0-9a-f]{48}\.key\Z")
IDENTITY_QUERY = """query HerdrIdentity($after: String) {
  viewer { id name }
  organization { id name urlKey }
  teams(first: 100, after: $after) {
    nodes { id key name }
    pageInfo { hasNextPage endCursor }
  }
}"""
ISSUES_QUERY = """query HerdrIssues($filter: IssueFilter!, $after: String) {
  issues(first: 50, after: $after, orderBy: updatedAt, filter: $filter) {
    nodes {
      id identifier title url updatedAt priority
      state { id name type position }
      team { id key name }
      assignee { id name avatarUrl }
    }
    pageInfo { hasNextPage endCursor }
  }
}"""
VIEWER_QUERY = "query HerdrViewer { viewer { id name } }"


class ClientError(Exception):
    def __init__(self, code, message, retry_after=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after = retry_after

    def payload(self):
        error = {"code": self.code, "message": self.message}
        if self.retry_after is not None:
            error["retryAfter"] = self.retry_after
        return {"ok": False, "error": error}


def invalid_response():
    raise ClientError("invalid_response", "Linear returned an incomplete or invalid response. Refresh to try again.")


def remaining(deadline, maximum=8):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise ClientError("timeout", "Linear took too long to respond. Try again.")
    return min(maximum, seconds)


def validate_key(value):
    if not isinstance(value, str):
        raise ClientError("invalid_key", "Enter a Linear personal API key.")
    value = value.strip()
    if not value or len(value) > MAX_KEY_BYTES or any(ord(c) < 33 or ord(c) > 126 for c in value):
        raise ClientError("invalid_key", "Enter a valid Linear personal API key without spaces or line breaks.")
    return value


@contextmanager
def credential_directory(home, create=False):
    """Walk using directory descriptors: never follow a symlink or chmod a caller path."""
    path = Path(home)
    if not path.is_absolute() or str(path) != home or ".." in path.parts:
        raise ClientError("unsafe_handoff", "The local credential directory is not safe to use.")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        # Root-owned ancestors are allowed; appHome and all our children must be user-owned.
        for index, component in enumerate(path.parts[1:]):
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            last = index == len(path.parts) - 2
            if info.st_uid not in ((os.getuid(),) if last else (0, os.getuid())):
                raise ClientError("unsafe_handoff", "The local credential directory has an unexpected owner.")
            if info.st_mode & 0o022 and not (info.st_uid == 0 and info.st_mode & stat.S_ISVTX and not last):
                raise ClientError("unsafe_handoff", "The local credential directory is writable by another user.")
        for component in ("data", "linear-issues", "credentials"):
            if create:
                try:
                    os.mkdir(component, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise ClientError("unsafe_handoff", "The local credential directory has unsafe ownership or permissions.")
            if component == "credentials" and stat.S_IMODE(info.st_mode) != 0o700:
                raise ClientError("unsafe_handoff", "The credential handoff directory must have private 0700 permissions.")
        yield fd, path / "data" / "linear-issues" / "credentials"
    except ClientError:
        raise
    except OSError as error:
        raise ClientError("unsafe_handoff", "The private local credential directory could not be accessed safely.") from error
    finally:
        os.close(fd)


def handoff_name(directory, supplied):
    path = Path(supplied)
    if not path.is_absolute() or str(path) != supplied or path.parent != directory or not HANDOFF_NAME.fullmatch(path.name):
        raise ClientError("unsafe_handoff", "The credential handoff path is not valid.")
    return path.name


def clean_directory(fd):
    # Bounded, conservative crash recovery. A normal connect unlinks before its network work.
    cutoff = time.time() - HANDOFF_TTL
    with os.scandir(fd) as entries:
        for index, entry in enumerate(entries):
            if index >= 256:
                break
            if not HANDOFF_NAME.fullmatch(entry.name):
                continue
            try:
                info = entry.stat(follow_symlinks=False)
                if (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                        and max(info.st_mtime, info.st_ctime) < cutoff):
                    os.unlink(entry.name, dir_fd=fd)
            except FileNotFoundError:
                pass


def clean_abandoned_handoffs(home):
    try:
        with credential_directory(home) as (fd, directory):
            clean_directory(fd)
    except ClientError as error:
        if not isinstance(error.__cause__, FileNotFoundError):
            raise


def prepare(home):
    with credential_directory(home, create=True) as (fd, directory):
        clean_directory(fd)
        while True:
            name = "handoff-" + secrets.token_hex(24) + ".key"
            try:
                os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                return {"handoff": str(directory / name)}


def take_handoff(home, supplied, discard=False):
    # A missing abandoned handoff (including its missing parent) is a successful discard.
    name = handoff_name(Path(home) / "data" / "linear-issues" / "credentials", supplied)
    try:
        with credential_directory(home) as (fd, directory):
            try:
                if discard:
                    try:
                        os.unlink(name, dir_fd=fd)
                    except FileNotFoundError:
                        pass
                    return None
                file_fd = None
                try:
                    file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    info = os.fstat(file_fd)
                    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                            or info.st_nlink != 1 or info.st_mode & 0o022 or info.st_size > MAX_KEY_BYTES):
                        raise ClientError("unsafe_handoff", "The credential handoff file is not safe to read.")
                    # writeTextFile may create 0644; its parent is already private 0700.
                    # Only tighten this proven, user-owned regular file through its descriptor.
                    os.fchmod(file_fd, 0o600)
                    with os.fdopen(file_fd, "rb") as stream:
                        file_fd = None
                        value = stream.read(MAX_KEY_BYTES + 1)
                    if len(value) > MAX_KEY_BYTES:
                        raise ClientError("invalid_key", "The Linear personal API key is too long.")
                    try:
                        return validate_key(value.decode("ascii"))
                    except UnicodeError:
                        raise ClientError("invalid_key", "Enter a valid Linear personal API key.") from None
                finally:
                    if file_fd is not None:
                        os.close(file_fd)
                    # Unlink the directory entry, never its target (even if it was a symlink).
                    try:
                        os.unlink(name, dir_fd=fd)
                    except FileNotFoundError:
                        pass
            except ClientError:
                raise
            except OSError:
                raise ClientError("unsafe_handoff", "The credential handoff file could not be accessed safely.") from None
    except ClientError as error:
        if discard and isinstance(error.__cause__, FileNotFoundError):
            return None
        raise


class UnavailableStore:
    available = False
    label = "OS credential storage unavailable"

    def get(self):
        return None

    def put(self, key):
        raise ClientError("storage_unavailable", "OS credential storage is unavailable. Install and unlock a supported credential store.")

    def delete(self):
        self.put(None)


class KeychainStore:
    available = True
    label = "macOS Keychain"

    def __init__(self, account):
        self.account = account
        self.cf = ctypes.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        self.sec = ctypes.CDLL("/System/Library/Frameworks/Security.framework/Security")
        # kSecUseAuthenticationUIFail alone does not suppress legacy macOS keychain UI.
        # This isolated helper never needs to prompt: callers unlock via Keychain Access.
        self.sec.SecKeychainSetUserInteractionAllowed.argtypes = [ctypes.c_ubyte]
        self.sec.SecKeychainSetUserInteractionAllowed.restype = ctypes.c_int32
        self.check(self.sec.SecKeychainSetUserInteractionAllowed(False))
        ptr = ctypes.c_void_p
        self.cf.CFStringCreateWithCString.argtypes = [ptr, ctypes.c_char_p, ctypes.c_uint32]
        self.cf.CFStringCreateWithCString.restype = ptr
        self.cf.CFDataCreate.argtypes = [ptr, ptr, ctypes.c_long]
        self.cf.CFDataCreate.restype = ptr
        self.cf.CFDataGetLength.argtypes = [ptr]
        self.cf.CFDataGetLength.restype = ctypes.c_long
        self.cf.CFDataGetBytePtr.argtypes = [ptr]
        self.cf.CFDataGetBytePtr.restype = ptr
        self.cf.CFGetTypeID.argtypes = [ptr]
        self.cf.CFGetTypeID.restype = ctypes.c_ulong
        self.cf.CFDataGetTypeID.argtypes = []
        self.cf.CFDataGetTypeID.restype = ctypes.c_ulong
        self.cf.CFDictionaryCreateMutable.argtypes = [ptr, ctypes.c_long, ptr, ptr]
        self.cf.CFDictionaryCreateMutable.restype = ptr
        self.cf.CFDictionarySetValue.argtypes = [ptr, ptr, ptr]
        self.cf.CFDictionarySetValue.restype = None
        self.cf.CFRelease.argtypes = [ptr]
        self.cf.CFRelease.restype = None
        self.sec.SecItemCopyMatching.argtypes = [ptr, ctypes.POINTER(ptr)]
        self.sec.SecItemCopyMatching.restype = ctypes.c_int32
        self.sec.SecItemAdd.argtypes = [ptr, ctypes.POINTER(ptr)]
        self.sec.SecItemAdd.restype = ctypes.c_int32
        self.sec.SecItemUpdate.argtypes = [ptr, ptr]
        self.sec.SecItemUpdate.restype = ctypes.c_int32
        self.sec.SecItemDelete.argtypes = [ptr]
        self.sec.SecItemDelete.restype = ctypes.c_int32
        self.keys = ctypes.addressof(ctypes.c_byte.in_dll(self.cf, "kCFTypeDictionaryKeyCallBacks"))
        self.values = ctypes.addressof(ctypes.c_byte.in_dll(self.cf, "kCFTypeDictionaryValueCallBacks"))

    def constant(self, name):
        library = self.cf if name.startswith("kCF") else self.sec
        return ctypes.c_void_p.in_dll(library, name).value

    @contextmanager
    def dictionary(self, values):
        dictionary = self.cf.CFDictionaryCreateMutable(None, 0, self.keys, self.values)
        if not dictionary:
            raise ClientError("storage_error", "macOS Keychain could not allocate a credential request.")
        try:
            for name, value in values.items():
                ref = None
                if isinstance(value, bytes):
                    ref = self.cf.CFDataCreate(None, ctypes.c_char_p(value), len(value))
                elif isinstance(value, str) and not value.startswith("kSec") and not value.startswith("kCF"):
                    ref = self.cf.CFStringCreateWithCString(None, value.encode("utf-8"), 0x08000100)
                else:
                    self.cf.CFDictionarySetValue(dictionary, self.constant(name), self.constant(value))
                    continue
                if not ref:
                    raise ClientError("storage_error", "macOS Keychain could not allocate a credential request.")
                try:
                    self.cf.CFDictionarySetValue(dictionary, self.constant(name), ref)
                finally:
                    self.cf.CFRelease(ref)
            yield dictionary
        finally:
            self.cf.CFRelease(dictionary)

    def query(self):
        # Never show a system authentication dialog during status or background reads.
        return {"kSecClass": "kSecClassGenericPassword", "kSecAttrService": SERVICE,
                "kSecAttrAccount": self.account, "kSecUseAuthenticationUI": "kSecUseAuthenticationUIFail"}

    def check(self, status):
        if status == 0:
            return
        if status in (-25308, -25291):
            raise ClientError("storage_locked", "macOS Keychain is locked or unavailable. Unlock it and try again.")
        if status in (-25293, -128, -25294):
            raise ClientError("storage_denied", "macOS Keychain denied credential access. Allow access in Keychain Access and try again.")
        raise ClientError("storage_error", "macOS Keychain could not complete the credential operation.")

    def get(self):
        query = dict(self.query(), kSecReturnData="kCFBooleanTrue", kSecMatchLimit="kSecMatchLimitOne")
        result = ctypes.c_void_p()
        with self.dictionary(query) as dictionary:
            status = self.sec.SecItemCopyMatching(dictionary, ctypes.byref(result))
        try:
            if status == -25300:
                return None
            self.check(status)
            if not result.value or self.cf.CFGetTypeID(result) != self.cf.CFDataGetTypeID():
                raise ClientError("storage_error", "The saved Keychain credential could not be read.")
            length = self.cf.CFDataGetLength(result)
            if not 0 < length <= MAX_KEY_BYTES:
                raise ClientError("storage_error", "The saved Keychain credential is invalid. Connect again.")
            try:
                return validate_key(ctypes.string_at(self.cf.CFDataGetBytePtr(result), length).decode("ascii"))
            except UnicodeError:
                raise ClientError("storage_error", "The saved Keychain credential is invalid. Connect again.") from None
        finally:
            if result.value:
                self.cf.CFRelease(result)

    def put(self, key):
        with self.dictionary(self.query()) as query:
            with self.dictionary({"kSecValueData": key.encode("ascii")}) as changes:
                status = self.sec.SecItemUpdate(query, changes)
        if status == -25300:
            attributes = dict(self.query(), kSecValueData=key.encode("ascii"), kSecAttrLabel="Herdr Linear personal API key")
            with self.dictionary(attributes) as dictionary:
                status = self.sec.SecItemAdd(dictionary, None)
        self.check(status)

    def delete(self):
        with self.dictionary(self.query()) as query:
            status = self.sec.SecItemDelete(query)
        if status != -25300:
            self.check(status)


class SecretServiceStore:
    available = True
    label = "Linux Secret Service"

    def __init__(self, executable, account, deadline):
        self.executable = executable
        self.attributes = ["service", SERVICE, "account", account]
        self.deadline = deadline

    def run(self, action, key=None):
        args = [self.executable, action]
        if action == "store":
            args += ["--label=Herdr Linear personal API key"]
        args += self.attributes
        try:
            result = subprocess.run(args, input=key.encode("ascii") if key is not None else None,
                                    stdin=subprocess.DEVNULL if key is None else None,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=remaining(self.deadline, 5), check=False)
        except subprocess.TimeoutExpired:
            raise ClientError("storage_locked", "Linux Secret Service did not respond. Unlock your keyring and try again.") from None
        except OSError:
            raise ClientError("storage_unavailable", "Linux Secret Service is unavailable. Start a supported keyring and try again.") from None
        if result.returncode != 0:
            # secret-tool uses exit 1 with no output for an absent item. Diagnostics distinguish backend failures.
            if action in ("lookup", "clear") and result.returncode == 1 and not result.stdout and not result.stderr:
                return None
            raise ClientError("storage_denied", "Linux Secret Service could not access the credential. Unlock your keyring and try again.")
        return result.stdout

    def get(self):
        value = self.run("lookup")
        if value is None or not value.strip():
            return None
        if len(value) > MAX_KEY_BYTES + 1:
            raise ClientError("storage_error", "The saved keyring credential is invalid. Connect again.")
        try:
            return validate_key(value.decode("ascii"))
        except UnicodeError:
            raise ClientError("storage_error", "The saved keyring credential is invalid. Connect again.") from None

    def put(self, key):
        self.run("store", key)

    def delete(self):
        self.run("clear")


def credential_store(home, deadline):
    account = hashlib.sha256(home.encode("utf-8")).hexdigest()
    if sys.platform == "darwin":
        try:
            return KeychainStore(account)
        except (OSError, ValueError, AttributeError):
            return UnavailableStore()
    if sys.platform.startswith("linux"):
        executable = shutil.which("secret-tool")
        if executable:
            return SecretServiceStore(executable, account, deadline)
    return UnavailableStore()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        # Never forward a credential to another URL, even another HTTPS host.
        return None


def retry_after(headers):
    value = headers.get("Retry-After", "") if headers else ""
    try:
        if value.isdigit():
            return min(int(value), 86400)
        timestamp = parsedate_to_datetime(value).timestamp()
        return min(86400, max(0, math.ceil(timestamp - time.time())))
    except (ValueError, TypeError, OverflowError):
        return None


def request(key, query, variables, deadline):
    body = json.dumps({"query": query, "variables": variables}, allow_nan=False).encode("utf-8")
    http_request = urllib.request.Request(ENDPOINT, data=body, headers={
        "Authorization": key, "Content-Type": "application/json", "Accept": "application/json",
        "User-Agent": "herdr-linear-issues",
    }, method="POST")
    try:
        with urllib.request.build_opener(NoRedirect).open(http_request, timeout=remaining(deadline)) as response:
            headers = response.headers
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            invalid_response()
        try:
            payload = json.loads(raw)
        except (ValueError, UnicodeError):
            invalid_response()
    except urllib.error.HTTPError as error:
        status = error.code
        wait = retry_after(error.headers)
        error.close()
        if status == 401:
            raise ClientError("unauthorized", "Linear rejected this API key. Create or connect a valid personal API key.") from None
        if status == 403:
            raise ClientError("forbidden", "This Linear API key cannot access the requested workspace or team.") from None
        if status == 429:
            raise ClientError("rate_limited", "Linear's rate limit was reached. Wait before refreshing.", wait) from None
        raise ClientError("network_error", "Linear is temporarily unavailable. Try again.") from None
    except (TimeoutError, socket.timeout):
        raise ClientError("timeout", "Linear took too long to respond. Try again.") from None
    except (urllib.error.URLError, OSError):
        raise ClientError("network_error", "Could not reach Linear. Check your connection and try again.") from None
    if not isinstance(payload, dict):
        invalid_response()
    if payload.get("errors"):
        errors = payload["errors"]
        if not isinstance(errors, list) or any(not isinstance(error, dict) for error in errors):
            invalid_response()
        codes = {str(error.get("extensions", {}).get("code", "")).upper()
                 for error in errors if isinstance(error.get("extensions"), dict)}
        if codes & {"RATELIMITED", "RATE_LIMITED", "TOO_MANY_REQUESTS"}:
            raise ClientError("rate_limited", "Linear's rate limit was reached. Wait before refreshing.", retry_after(headers))
        if codes & {"UNAUTHENTICATED", "AUTHENTICATION_ERROR", "AUTHENTICATION_REQUIRED", "INVALID_API_KEY"}:
            raise ClientError("unauthorized", "Linear rejected this API key. Connect a valid personal API key.")
        if codes & {"FORBIDDEN", "AUTHORIZATION_ERROR"}:
            raise ClientError("forbidden", "This Linear API key cannot access the requested workspace or team.")
        # Never print the remote message: it may contain request or credential material.
        raise ClientError("graphql_error", "Linear could not complete the query. Check this key's read permissions and try again.")
    if "errors" in payload and payload["errors"] not in (None, []):
        invalid_response()
    data = payload.get("data")
    if not isinstance(data, dict):
        invalid_response()
    return data


def fields(value, names):
    if not isinstance(value, dict) or any(not isinstance(value.get(name), str) or not value[name] for name in names):
        invalid_response()
    return {name: value[name] for name in names}


def page(connection, previous=None):
    if not isinstance(connection, dict) or not isinstance(connection.get("nodes"), list):
        invalid_response()
    info = connection.get("pageInfo")
    if not isinstance(info, dict) or type(info.get("hasNextPage")) is not bool or "endCursor" not in info:
        invalid_response()
    cursor = info["endCursor"]
    if cursor is not None and (not isinstance(cursor, str) or not cursor or len(cursor) > 8192):
        invalid_response()
    if info["hasNextPage"] and (not cursor or cursor == previous or not connection["nodes"]):
        invalid_response()
    return connection["nodes"], {"hasNextPage": info["hasNextPage"], "endCursor": cursor}


def identity(key, deadline):
    teams = []
    team_ids = set()
    cursors = set()
    after = None
    viewer = workspace = None
    while True:
        data = request(key, IDENTITY_QUERY, {"after": after}, deadline)
        current_viewer = fields(data.get("viewer"), ("id", "name"))
        current_workspace = fields(data.get("organization"), ("id", "name", "urlKey"))
        if viewer is not None and (viewer != current_viewer or workspace != current_workspace):
            invalid_response()
        viewer, workspace = current_viewer, current_workspace
        nodes, info = page(data.get("teams"), after)
        for node in nodes:
            team = fields(node, ("id", "key", "name"))
            if team["id"] in team_ids:
                invalid_response()
            team_ids.add(team["id"])
            teams.append(team)
        if not info["hasNextPage"]:
            break
        after = info["endCursor"]
        if after in cursors:
            invalid_response()
        cursors.add(after)
    return {"viewer": viewer, "workspace": workspace, "teams": teams}


def safe_issue_url(value):
    try:
        url = urllib.parse.urlsplit(value)
        return (url.scheme == "https" and url.hostname == "linear.app" and url.port in (None, 443)
                and not url.username and not url.password and not any(ord(c) < 33 for c in value))
    except (ValueError, TypeError):
        return False


def issues(key, scope, team, after, deadline):
    issue_filter = {"archivedAt": {"null": True}}
    if scope == "mine":
        viewer = fields(request(key, VIEWER_QUERY, {}, deadline).get("viewer"), ("id", "name"))
        issue_filter["assignee"] = {"id": {"eq": viewer["id"]}}
    if team:
        issue_filter["team"] = {"id": {"eq": team}}
    data = request(key, ISSUES_QUERY, {"filter": issue_filter, "after": after}, deadline)
    nodes, info = page(data.get("issues"), after)
    result = []
    seen = set()
    for node in nodes:
        issue = fields(node, ("id", "identifier", "title", "url", "updatedAt"))
        priority = node.get("priority")
        if (not isinstance(priority, (int, float)) or isinstance(priority, bool)
                or not math.isfinite(priority) or priority not in range(5)
                or not safe_issue_url(issue["url"]) or issue["id"] in seen):
            invalid_response()
        seen.add(issue["id"])
        issue["priority"] = priority
        issue["state"] = fields(node.get("state"), ("id", "name", "type"))
        position = node["state"].get("position")
        if not isinstance(position, (int, float)) or isinstance(position, bool) or not math.isfinite(position):
            invalid_response()
        issue["state"]["position"] = position
        issue["team"] = fields(node.get("team"), ("id", "key", "name"))
        if "assignee" not in node:
            invalid_response()
        issue["assignee"] = None if node["assignee"] is None else fields(node["assignee"], ("id", "name"))
        if issue["assignee"] is not None:
            avatar_url = node["assignee"].get("avatarUrl")
            if avatar_url is not None and not isinstance(avatar_url, str):
                invalid_response()
            issue["assignee"]["avatarUrl"] = avatar_url
        result.append(issue)
    return {"issues": result, "pageInfo": info}


def cache_avatars(result, home, deadline):
    """Best-effort local pictures: never send the Linear key to an image host."""
    deadline = min(deadline - 0.25, time.monotonic() + 5)
    directory = Path(home) / "data" / "linear-issues" / "avatars"
    cached = {}
    opener = urllib.request.build_opener(NoRedirect)
    for issue in result["issues"]:
        user = issue["assignee"]
        if user is None:
            continue
        user["avatarPath"] = None
        url = user["avatarUrl"]
        if not url:
            continue
        if url in cached:
            user["avatarPath"] = cached[url]
            continue
        cached[url] = None
        temporary = None
        try:
            parsed = urllib.parse.urlsplit(url)
            # Linear's own public CDN only; arbitrary profile URLs must not
            # turn the local helper into an authenticated or private-network fetch.
            if (parsed.scheme != "https" or parsed.netloc != "public.linear.app"
                    or any(ord(c) < 33 for c in url)):
                continue
            digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
            relative = Path("data") / "linear-issues" / "avatars" / (digest + ".png")
            target = Path(home) / relative
            if not target.is_file():
                seconds = deadline - time.monotonic()
                if seconds <= 0:
                    continue
                with opener.open(urllib.request.Request(url), timeout=min(3, seconds)) as response:
                    picture = response.read(2 * 1024 * 1024 + 1)
                if len(picture) > 2 * 1024 * 1024 or not (
                        picture.startswith(b"\x89PNG\r\n\x1a\n") or picture.startswith(b"\xff\xd8\xff")
                        or (picture.startswith(b"RIFF") and picture[8:12] == b"WEBP")):
                    continue
                directory.mkdir(parents=True, exist_ok=True, mode=0o700)
                temporary = directory / (digest + "." + secrets.token_hex(8) + ".tmp")
                with temporary.open("xb") as output:
                    output.write(picture)
                os.replace(temporary, target)
            cached[url] = str(relative)
            user["avatarPath"] = cached[url]
        except (OSError, ValueError):
            # A missing picture must not hide an issue or break pagination.
            pass
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ClientError("invalid_arguments", "The Linear helper received invalid arguments.")


def arguments(argv):
    parser = Parser(add_help=False)
    parser.add_argument("--home", required=True)
    commands = parser.add_subparsers(dest="action", required=True, parser_class=Parser)
    for action in ("status", "prepare", "disconnect"):
        commands.add_parser(action, add_help=False)
    for action in ("connect", "discard"):
        command = commands.add_parser(action, add_help=False)
        command.add_argument("--handoff", required=True)
    command = commands.add_parser("issues", add_help=False)
    command.add_argument("--scope", choices=("all", "mine"), required=True)
    command.add_argument("--team")
    command.add_argument("--after")
    args = parser.parse_args(argv)
    home = Path(args.home)
    if not home.is_absolute() or str(home) != args.home or ".." in home.parts or str(home) == "/":
        parser.error("")
    if args.action == "issues":
        if args.team:
            try:
                if str(uuid.UUID(args.team)) != args.team.lower():
                    parser.error("")
            except ValueError:
                parser.error("")
        if args.after is not None and (not args.after or len(args.after) > 8192 or any(ord(c) < 32 for c in args.after)):
            parser.error("")
    return args


def execute(args, deadline):
    if args.action == "prepare":
        return prepare(args.home)
    if args.action == "discard":
        take_handoff(args.home, args.handoff, discard=True)
        return {}
    if args.action == "status":
        clean_abandoned_handoffs(args.home)
    # Read/unlink before anything that might fail: unsupported storage cannot leave a key on disk.
    key = take_handoff(args.home, args.handoff) if args.action == "connect" else None
    store = credential_store(args.home, deadline)
    storage = {"available": store.available, "label": store.label}
    if args.action == "connect":
        if not store.available:
            store.put(key)
        details = identity(key, deadline)
        store.put(key)  # Only replace an existing working key after complete remote validation.
        return {"connected": True, "storage": storage, **details}
    if args.action == "disconnect":
        store.delete()
        return {"connected": False, "storage": storage}
    key = store.get()
    if args.action == "status":
        if key is None:
            return {"connected": False, "storage": storage}
        return {"connected": True, "storage": storage, **identity(key, deadline)}
    if not store.available:
        store.put(None)
    if key is None:
        raise ClientError("not_connected", "Connect a Linear personal API key before loading issues.")
    result = issues(key, args.scope, args.team, args.after, deadline)
    cache_avatars(result, args.home, deadline)
    return result


def timed_out(signum, frame):
    raise ClientError("timeout", "The Linear operation took too long. Try again.")


def main(argv=None):
    # Native exec is capped at 30 seconds. Bound the entire operation as well as each I/O call.
    signal.signal(signal.SIGALRM, timed_out)
    signal.setitimer(signal.ITIMER_REAL, 26)
    try:
        args = arguments(sys.argv[1:] if argv is None else argv)
        result = {"ok": True, **execute(args, time.monotonic() + 24)}
    except ClientError as error:
        result = error.payload()
    except Exception:
        # No raw exception, key, header, subprocess diagnostic, or remote body reaches stdout/stderr.
        result = ClientError("internal_error", "The Linear helper could not complete the operation. Try again.").payload()
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    print(json.dumps(result, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
