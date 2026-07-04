#!/usr/bin/env python3
import os
import socket
import struct
import sys


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


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"SaveWorld", "DoExit"}:
        print("Usage: rcon.py SaveWorld|DoExit", file=sys.stderr)
        return 2

    host = os.environ.get("ASA_RCON_HOST", "127.0.0.1")
    port = int(os.environ["ASA_RCON_PORT"])
    password = os.environ["ASA_ADMIN_PASSWORD"]
    command = sys.argv[1]

    with socket.create_connection((host, port), timeout=5) as connection:
        connection.settimeout(5)
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
