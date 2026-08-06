#!/usr/bin/env python3
import fcntl
import os
import socket
import struct
import sys
import time


ALLOWED_COMMANDS = {"SaveWorld", "DoExit", "ListPlayers"}


def receive_exact(connection: socket.socket, length: int) -> bytes:
    data = bytearray()
    while len(data) < length:
        chunk = connection.recv(length - len(data))
        if not chunk:
            raise ConnectionError("RCON connection closed unexpectedly")
        data.extend(chunk)
    return bytes(data)


def send_packet(connection: socket.socket, request_id: int, packet_type: int, body: str) -> None:
    payload = struct.pack("<ii", request_id, packet_type) + body.encode() + b"\x00\x00"
    connection.sendall(struct.pack("<i", len(payload)) + payload)


def receive_packet(connection: socket.socket) -> tuple[int, int, str]:
    size = struct.unpack("<i", receive_exact(connection, 4))[0]
    payload = receive_exact(connection, size)
    request_id, packet_type = struct.unpack("<ii", payload[:8])
    return request_id, packet_type, payload[8:-2].decode(errors="replace")


def env_timeout(name: str, default: float, *, allow_zero: bool = False) -> float:
    value = float(os.environ.get(name, str(default)))
    if value < 0 or (value == 0 and not allow_zero):
        qualifier = "non-negative" if allow_zero else "positive"
        raise ValueError(f"{name} must be a {qualifier} number")
    return value


def acquire_lock(command: str):
    lock_path = os.environ.get("RCON_LOCK_FILE", "/asa/tmp/rcon.lock")
    lock_directory = os.path.dirname(lock_path)
    if lock_directory:
        os.makedirs(lock_directory, exist_ok=True)
    lock_handle = open(lock_path, "a", encoding="utf-8")
    timeout = env_timeout("RCON_LOCK_TIMEOUT_SECONDS", 10, allow_zero=True)
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock_handle
        except BlockingIOError:
            if time.monotonic() >= deadline:
                lock_handle.close()
                raise TimeoutError(f"timed out waiting for the RCON lock before {command}") from None
            time.sleep(min(0.1, max(0, deadline - time.monotonic())))


def run_command(command: str) -> None:
    host = os.environ.get("ASA_RCON_HOST", "127.0.0.1")
    port = int(os.environ["ASA_RCON_PORT"])
    password = os.environ["ASA_ADMIN_PASSWORD"]
    connect_timeout = env_timeout("RCON_CONNECT_TIMEOUT_SECONDS", 5)
    response_timeout_name = "RCON_SAVEWORLD_TIMEOUT_SECONDS" if command == "SaveWorld" else "RCON_RESPONSE_TIMEOUT_SECONDS"
    response_timeout = env_timeout(response_timeout_name, 30 if command == "SaveWorld" else 5)

    with acquire_lock(command):
        with socket.create_connection((host, port), timeout=connect_timeout) as connection:
            connection.settimeout(response_timeout)
            send_packet(connection, 1, 3, password)
            auth_id = None
            for _ in range(2):
                response_id, packet_type, _ = receive_packet(connection)
                if packet_type == 2:
                    auth_id = response_id
                    break
            if auth_id is None:
                raise RuntimeError("RCON authentication response was not received")
            if auth_id == -1:
                raise PermissionError("RCON authentication failed")
            send_packet(connection, 2, 2, command)
            if command != "DoExit":
                response_id, _, response = receive_packet(connection)
                if response_id != 2:
                    raise RuntimeError("Unexpected RCON response")
                if response:
                    print(response)


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in ALLOWED_COMMANDS:
        print("Usage: rcon.py SaveWorld|DoExit|ListPlayers", file=sys.stderr)
        return 2

    command = sys.argv[1]
    try:
        run_command(command)
    except Exception as error:
        print(f"RCON {command} failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
