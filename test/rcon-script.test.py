#!/usr/bin/env python3
import contextlib
import fcntl
import importlib.util
import io
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).resolve().parents[1] / "container" / "rcon.py"
SPEC = importlib.util.spec_from_file_location("asa_rcon", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
RCON = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RCON)


def response_packet(request_id: int, packet_type: int, body: str = "") -> bytes:
    payload = struct.pack("<ii", request_id, packet_type) + body.encode() + b"\x00\x00"
    return struct.pack("<i", len(payload)) + payload


class FakeConnection:
    def __init__(self, responses: bytes):
        self.responses = bytearray(responses)
        self.timeouts: list[float] = []
        self.requests: list[bytes] = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def settimeout(self, timeout: float) -> None:
        self.timeouts.append(timeout)

    def sendall(self, payload: bytes) -> None:
        self.requests.append(payload)

    def recv(self, length: int) -> bytes:
        chunk = bytes(self.responses[:length])
        del self.responses[:length]
        return chunk


class RconScriptTest(unittest.TestCase):
    def environment(self, lock_file: str) -> dict[str, str]:
        return {
            "ASA_ADMIN_PASSWORD": "fixture-password",
            "ASA_RCON_PORT": "27020",
            "RCON_LOCK_FILE": lock_file,
        }

    def test_saveworld_uses_longer_response_timeout(self) -> None:
        connection = FakeConnection(response_packet(1, 2) + response_packet(2, 0, "World Saved"))
        with tempfile.TemporaryDirectory() as temp_dir:
            environment = self.environment(f"{temp_dir}/rcon.lock")
            output = io.StringIO()
            with (
                mock.patch.dict(os.environ, environment, clear=True),
                mock.patch.object(RCON.socket, "create_connection", return_value=connection) as create_connection,
                contextlib.redirect_stdout(output),
            ):
                RCON.run_command("SaveWorld")

        create_connection.assert_called_once_with(("127.0.0.1", 27020), timeout=5)
        self.assertEqual(connection.timeouts, [30])
        self.assertEqual(output.getvalue(), "World Saved\n")

    def test_busy_lock_returns_concise_error_without_connecting(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            lock_path = f"{temp_dir}/rcon.lock"
            with open(lock_path, "a", encoding="utf-8") as lock_handle:
                fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                environment = self.environment(lock_path) | {"RCON_LOCK_TIMEOUT_SECONDS": "0"}
                error_output = io.StringIO()
                with (
                    mock.patch.dict(os.environ, environment, clear=True),
                    mock.patch.object(sys, "argv", [str(MODULE_PATH), "ListPlayers"]),
                    mock.patch.object(RCON.socket, "create_connection") as create_connection,
                    contextlib.redirect_stderr(error_output),
                ):
                    result = RCON.main()

        self.assertEqual(result, 1)
        create_connection.assert_not_called()
        self.assertIn("timed out waiting for the RCON lock", error_output.getvalue())
        self.assertNotIn("Traceback", error_output.getvalue())


if __name__ == "__main__":
    unittest.main()
