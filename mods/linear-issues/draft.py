"""Insert one Linear issue prompt through hc's framed attach stream, without Enter."""
import argparse
import json
import os
import re
import select
import struct
import subprocess
import sys
import time


class DraftError(Exception):
    pass


class CoreConnection:
    def __init__(self):
        self.process = subprocess.Popen(["hc", "connect"], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.buffer = bytearray()
        self.deadline = time.monotonic() + 12
        self.sequence = 0
        self.framed = False

    def read(self, size):
        while len(self.buffer) < size:
            left = self.deadline - time.monotonic()
            if left <= 0 or not select.select([self.process.stdout], [], [], max(0, left))[0]:
                raise DraftError("The agent connection timed out. Check the terminal before trying again.")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise DraftError("The agent connection closed. Check the terminal before trying again.")
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:size])
        del self.buffer[:size]
        return result

    def line(self):
        result = bytearray()
        while True:
            char = self.read(1)
            if char == b"\n":
                return bytes(result)
            result.extend(char)
            if len(result) > 1024 * 1024:
                raise DraftError("Herdr returned an invalid connection response.")

    def frame(self, channel, kind, payload):
        self.process.stdin.write(struct.pack("<IBI", channel, kind, len(payload)) + payload)
        self.process.stdin.flush()

    def receive(self):
        channel, kind, length = struct.unpack("<IBI", self.read(9))
        if length > 16 * 1024 * 1024:
            raise DraftError("Herdr returned an invalid stream frame.")
        return channel, kind, self.read(length)

    def rpc(self, method, params):
        self.sequence += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self.sequence,
                           "method": method, "params": params}).encode()
        if self.framed:
            self.frame(0, 0, body)
        else:
            self.process.stdin.write(body + b"\n")
            self.process.stdin.flush()
        while True:
            if self.framed:
                channel, kind, payload = self.receive()
                if channel != 0:
                    if kind == 0:
                        self.frame(channel, 1, struct.pack("<I", len(payload)))
                    continue
                if kind != 0:
                    continue
                response = json.loads(payload)
            else:
                response = json.loads(self.line())
            if response.get("id") != self.sequence:
                continue
            if "error" in response:
                raise DraftError("The selected agent is no longer available. Focus an agent and try again.")
            if "result" not in response:
                raise DraftError("Herdr returned an invalid connection response.")
            return response["result"]

    def close_stream(self, channel):
        self.frame(channel, 2, b"")
        while True:
            source, kind, payload = self.receive()
            if source == channel and kind == 2:
                return
            if source and kind == 0:
                self.frame(source, 1, struct.pack("<I", len(payload)))

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=2)
        self.process.stdout.close()


def require_agent(terminal, app):
    status = terminal.get("status") or {}
    if (terminal.get("state") != "live" or not terminal.get("reported")
            or status.get("app") != app or status.get("state") not in ("idle", "done", "working")):
        raise DraftError("Focus a live agent that is not blocked or in an error state, then click the issue again.")
    if not isinstance(terminal.get("cols"), int) or not isinstance(terminal.get("rows"), int):
        raise DraftError("The selected agent's terminal size is unavailable.")


def draft(terminal, app, identifier):
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*-[0-9]+", identifier):
        raise DraftError("This issue has an invalid Linear identifier.")
    text = f"Let's analyze this linear issue: {identifier}"
    connection = CoreConnection()
    try:
        target = connection.rpc("terminal.get", {"terminal": terminal})
        require_agent(target, app)
        connection.rpc("hello", {"generation": 1, "framed": True})
        connection.framed = True
        attached = connection.rpc("terminal.attach", {
            "terminal": terminal, "cols": target["cols"], "rows": target["rows"],
            "history": 0, "resumed": True,
        })
        require_agent(attached["terminal"], app)
        channel = attached["channel"]
        if not isinstance(channel, int) or channel <= 0:
            raise DraftError("Herdr did not open an agent input stream.")
        # Literal single-line text only: no key encoding, clipboard, paste wrappers, or Enter.
        connection.frame(channel, 0, text.encode("ascii"))
        connection.close_stream(channel)
        return {"ok": True, "terminal": terminal, "identifier": identifier}
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--terminal", required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--issue", required=True)
    args = parser.parse_args()
    try:
        result = draft(args.terminal, args.app, args.issue)
    except DraftError as error:
        result = {"ok": False, "message": str(error)}
    except Exception:
        result = {"ok": False, "message": "Could not confirm draft delivery. Check the agent input before clicking again."}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
