FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    STEAMCMDDIR=/usr/games \
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
      awscli \
      curl \
      jq \
      tar \
      zstd \
      procps \
      netcat-openbsd \
      python3 \
      python3-pip \
      steamcmd \
      lib32gcc-s1 \
    && pip3 install --break-system-packages --no-cache-dir umu-launcher \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /asa/server /asa/work /asa/tmp /asa/scripts

COPY entrypoint.sh backup.sh restore.sh notify-discord.sh healthcheck.sh /asa/scripts/
RUN chmod +x /asa/scripts/*.sh

WORKDIR /asa
ENTRYPOINT ["/asa/scripts/entrypoint.sh"]

