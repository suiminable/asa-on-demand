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
        "noTributeDownloads": "False",
        "PreventDownloadDinos": "False",
        "PreventDownloadItems": "False",
        "PreventDownloadSurvivors": "False",
        "PreventUploadDinos": "False",
        "PreventUploadItems": "False",
        "PreventUploadSurvivors": "False",
        "TributeCharacterExpirationSeconds": os.environ.get("TRIBUTE_CHARACTER_EXPIRATION_SECONDS", "86400"),
        "TributeDinoExpirationSeconds": os.environ.get("TRIBUTE_DINO_EXPIRATION_SECONDS", "86400"),
        "TributeItemExpirationSeconds": os.environ.get("TRIBUTE_ITEM_EXPIRATION_SECONDS", "86400"),
        "MinimumDinoReuploadInterval": os.environ.get("MINIMUM_DINO_REUPLOAD_INTERVAL", "0"),
    },
}


def remove_forced_keys(lines: list[str], section: str, settings: dict[str, str]) -> list[str]:
    current_section = ""
    forced_keys = {key.lower() for key in settings}
    updated: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            current_section = stripped[1:-1].lower()
        if current_section == section.lower() and "=" in line:
            key = line.split("=", 1)[0].strip().lower()
            if key in forced_keys:
                continue
        updated.append(line)
    return updated


lines = path.read_text(encoding="utf-8-sig").splitlines() if path.exists() else []
for section, settings in sections.items():
    lines = remove_forced_keys(lines, section, settings)
    if lines and lines[-1].strip():
        lines.append("")
    lines.append(f"[{section}]")
    lines.extend(f"{key}={value}" for key, value in settings.items())

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
print(
    "Forced Cross-ARK policy: downloads/uploads enabled; "
    f"character={sections['ServerSettings']['TributeCharacterExpirationSeconds']}s, "
    f"dino={sections['ServerSettings']['TributeDinoExpirationSeconds']}s, "
    f"item={sections['ServerSettings']['TributeItemExpirationSeconds']}s, "
    f"minimum-dino-reupload={sections['ServerSettings']['MinimumDinoReuploadInterval']}s"
)
