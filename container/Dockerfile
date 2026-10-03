FROM ubuntu:24.04 AS base

ENV DEBIAN_FRONTEND=noninteractive \
    STEAMCMDDIR=/usr/games \
    UMU_FOLDERS_PATH=/opt/umu-data \
    UMU_ID=arksa \
    WINEPREFIX=/asa/work/proton-prefix \
    GAMEID=2430930

RUN dpkg --add-architecture i386 \
    && apt-get update \
    && apt-get install -y --no-install-recommends software-properties-common ca-certificates curl gnupg \
    && add-apt-repository multiverse \
    && echo steam steam/question select "I AGREE" | debconf-set-selections \
    && echo steam steam/license note "" | debconf-set-selections \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      curl \
      jq \
      tar \
      unzip \
      zstd \
      procps \
      netcat-openbsd \
      util-linux \
      python3 \
      steamcmd \
      lib32gcc-s1 \
    && curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip \
    && unzip -q /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && curl -fsSL https://github.com/Open-Wine-Components/umu-launcher/releases/download/1.4.0/python3-umu-launcher_1.4.0-1_amd64_ubuntu-noble.deb -o /tmp/umu-launcher.deb \
    && echo "23e1147ac7a5d407292458d5b432658c9a2dac4395d400afa828072605b88b78  /tmp/umu-launcher.deb" | sha256sum -c - \
    && apt-get install -y --no-install-recommends /tmp/umu-launcher.deb \
    && rm /tmp/umu-launcher.deb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/games:${PATH}"

RUN mkdir -p /asa/server /asa/work /asa/tmp /asa/scripts /asa/cluster

FROM base AS asa-server

ARG ASA_BUILD_ID=initial
RUN set -eu; \
    echo "Installing ASA dedicated server build marker: ${ASA_BUILD_ID}"; \
    installed=false; \
    for attempt in 1 2 3 4 5; do \
      if steamcmd +force_install_dir /asa/server +login anonymous +app_update 2430930 validate +quit; then \
        installed=true; \
        break; \
      fi; \
      echo "SteamCMD attempt ${attempt} failed; retrying after its self-update..." >&2; \
      sleep 5; \
    done; \
    "${installed}"; \
    test -f /asa/server/ShooterGame/Binaries/Win64/ArkAscendedServer.exe

FROM base

RUN useradd --create-home --uid 10001 --shell /bin/bash asa \
    && mkdir -p /opt/umu-data \
    && chown -R asa:asa /asa /opt/umu-data \
    && apt-get update \
    && apt-get install -y --no-install-recommends libfreetype6 libfreetype6:i386 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=asa-server --chown=asa:asa /asa/server /asa/server

# ASA runs Proton directly, so installing Steam Runtime through umu-run is unnecessary.
# Pin and verify Proton without depending on Steam Runtime's mutable latest-public-beta URL.
ARG UMU_PROTON_VERSION=UMU-Proton-10.0-4
ARG UMU_PROTON_SHA512=5e1e7c99e773b4d0757f90075c5ff7f5282bedd13a694fc0414486122e68c9452d3fb971f32ab32704d4463c9622475a44e58fbd014069aa1e84e27b4a4ed7e5
RUN curl -fsSL --retry 3 \
      "https://github.com/Open-Wine-Components/umu-proton/releases/download/${UMU_PROTON_VERSION}/${UMU_PROTON_VERSION}.tar.gz" \
      -o /tmp/umu-proton.tar.gz \
    && printf '%s  /tmp/umu-proton.tar.gz\n' "${UMU_PROTON_SHA512}" | sha512sum -c - \
    && mkdir -p /opt/umu-data/umu/compatibilitytools \
    && tar --no-same-owner -xzf /tmp/umu-proton.tar.gz -C /opt/umu-data/umu/compatibilitytools \
    && ln -s "${UMU_PROTON_VERSION}" /opt/umu-data/umu/compatibilitytools/UMU-Latest \
    && chown -R asa:asa /opt/umu-data/umu \
    && test -x /opt/umu-data/umu/compatibilitytools/UMU-Latest/proton \
    && rm /tmp/umu-proton.tar.gz

ENV PROTONPATH=/opt/umu-data/umu/compatibilitytools/UMU-Latest \
    UMU_RUNTIME_UPDATE=0

RUN su -s /bin/bash asa -c 'mkdir -p /home/asa/.local/share/Steam "$WINEPREFIX" \
    && export STEAM_COMPAT_CLIENT_INSTALL_PATH=/home/asa/.local/share/Steam \
    STEAM_COMPAT_DATA_PATH=/asa/work/proton-prefix \
    STEAM_COMPAT_INSTALL_PATH=/asa/server \
    SteamAppId=2430930 SteamGameId=2430930 \
    && "$PROTONPATH/proton" run "$PROTONPATH/files/lib/wine/x86_64-windows/cmd.exe" /c exit'

COPY entrypoint.sh backup.sh restore.sh notify-discord.sh healthcheck.sh cluster-probe.sh migrate-storage.sh rcon.py configure-server.py /asa/scripts/
RUN chmod +x /asa/scripts/*.sh /asa/scripts/*.py

WORKDIR /asa
USER asa
ENTRYPOINT ["/asa/scripts/entrypoint.sh"]
