#!/usr/bin/env python3
import os
from pathlib import Path


path = Path(os.environ["ASA_INSTALL_DIR"]) / "ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini"
sections = {
    "SessionSettings": {
        "SessionName": os.environ["ASA_SESSION_NAME"],
    },
    "ServerSettings": {
        "ServerPassword": os.environ["ASA_SERVER_PASSWORD"],
        "ServerAdminPassword": os.environ["ASA_ADMIN_PASSWORD"],
        "RCONEnabled": "True",
        "RCONPort": os.environ["ASA_RCON_PORT"],
    },
}


def apply_section(lines: list[str], section: str, settings: dict[str, str]) -> list[str]:
    header = f"[{section}]"
    section_start = next((index for index, line in enumerate(lines) if line.strip().lower() == header.lower()), None)
    if section_start is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(header)
        section_start = len(lines) - 1

    section_end = next(
        (index for index in range(section_start + 1, len(lines)) if lines[index].strip().startswith("[")),
        len(lines),
    )
    key_lookup = {key.lower(): key for key in settings}
    written: set[str] = set()
    updated: list[str] = []

    for index, line in enumerate(lines):
        if section_start < index < section_end and "=" in line:
            raw_key = line.split("=", 1)[0].strip().lower()
            key = key_lookup.get(raw_key)
            if key:
                if key not in written:
                    updated.append(f"{key}={settings[key]}")
                    written.add(key)
                continue
        if index == section_end:
            updated.extend(f"{key}={value}" for key, value in settings.items() if key not in written)
        updated.append(line)

    if section_end == len(lines):
        updated.extend(f"{key}={value}" for key, value in settings.items() if key not in written)
    return updated


lines = path.read_text(encoding="utf-8-sig").splitlines() if path.exists() else []
for section, settings in sections.items():
    lines = apply_section(lines, section, settings)

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
