FROM node:22-bookworm-slim@sha256:f576cc608b02e6b04bb0700e13be83eb5ceb7bb24584c3181b0f4ecfa0cd0edf AS deps

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package*.json ./
# Lifecycle scripts are disabled so the verified native/model artifacts below
# are the only Vosk artifacts added to the final image.
RUN npm ci --ignore-scripts

FROM node:22-bookworm-slim@sha256:f576cc608b02e6b04bb0700e13be83eb5ceb7bb24584c3181b0f4ecfa0cd0edf AS vosk-artifacts

ARG TARGETARCH
ARG VOSK_LIB_VERSION=0.3.45
ARG VOSK_MODEL_VERSION=0.15
ARG VOSK_MODEL_SHA256=30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) \
        vosk_archive="vosk-linux-x86_64-${VOSK_LIB_VERSION}.zip"; \
        vosk_sha256="bbdc8ed85c43979f6443142889770ea95cbfbc56cffb5c5dcd73afa875c5fbb2"; \
        vosk_directory="vosk-linux-x86_64-${VOSK_LIB_VERSION}" ;; \
      arm64) \
        vosk_archive="vosk-linux-aarch64-${VOSK_LIB_VERSION}.zip"; \
        vosk_sha256="45e95d37755deb07568e79497d7feba8c03aee5a9e071df29961aa023fd94541"; \
        vosk_directory="vosk-linux-aarch64-${VOSK_LIB_VERSION}" ;; \
      *) echo "Unsupported Vosk architecture: $TARGETARCH" >&2; exit 64 ;; \
    esac; \
    curl --fail --location --silent --show-error \
      "https://github.com/alphacep/vosk-api/releases/download/v${VOSK_LIB_VERSION}/${vosk_archive}" \
      --output "/tmp/${vosk_archive}"; \
    echo "${vosk_sha256}  /tmp/${vosk_archive}" | sha256sum --check --strict; \
    unzip -q "/tmp/${vosk_archive}" -d /tmp/vosk-library; \
    install -D -m 0555 "/tmp/vosk-library/${vosk_directory}/libvosk.so" /opt/vosk/lib/libvosk.so

RUN set -eux; \
    model_archive="vosk-model-small-en-us-${VOSK_MODEL_VERSION}.zip"; \
    curl --fail --location --silent --show-error \
      "https://alphacephei.com/vosk/models/${model_archive}" \
      --output "/tmp/${model_archive}"; \
    echo "${VOSK_MODEL_SHA256}  /tmp/${model_archive}" | sha256sum --check --strict; \
    unzip -q "/tmp/${model_archive}" -d /tmp/vosk-model; \
    install -d /opt/models; \
    mv "/tmp/vosk-model/vosk-model-small-en-us-${VOSK_MODEL_VERSION}" /opt/models/vosk; \
    find /opt/models/vosk -type d -exec chmod 0555 {} +; \
    find /opt/models/vosk -type f -exec chmod 0444 {} +

FROM deps AS build

COPY tsconfig.json ./
COPY main.ts ./
COPY accuracy_probe.ts ./
COPY preflight_audio_probe.ts ./
COPY src/ ./src/
COPY tests/ ./tests/
RUN npx tsc --project tsconfig.json
RUN npm prune --omit=dev --ignore-scripts

FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48
ARG FFMPEG_VERSION=7:6.1.1-3ubuntu5

WORKDIR /app
ENV NODE_ENV=production \
    CAPTCHA_FFMPEG_PATH=/usr/bin/ffmpeg \
    CAPTCHA_VOSK_LIBRARY_PATH=/opt/vosk/lib/libvosk.so \
    CAPTCHA_VOSK_MODEL_PATH=/opt/models/vosk

RUN apt-get update \
    && apt-get install --yes --no-install-recommends "ffmpeg=${FFMPEG_VERSION}" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/tests/fixtures/vosk-api-test.wav ./dist/tests/fixtures/vosk-api-test.wav
COPY --from=vosk-artifacts /opt/vosk/lib/libvosk.so /opt/vosk/lib/libvosk.so
COPY --from=vosk-artifacts /opt/models/vosk /opt/models/vosk

RUN set -eux; \
    find /opt/models/vosk -type d -exec chmod 0555 {} +; \
    find /opt/models/vosk -type f -exec chmod 0444 {} +; \
    chmod 0555 "$CAPTCHA_VOSK_LIBRARY_PATH"; \
    test -x "$CAPTCHA_FFMPEG_PATH"; \
    test -r "$CAPTCHA_VOSK_MODEL_PATH/am/final.mdl"; \
    test -r "$CAPTCHA_VOSK_LIBRARY_PATH"; \
    su -s /bin/sh pwuser -c 'test -x "$CAPTCHA_FFMPEG_PATH" && test -r "$CAPTCHA_VOSK_MODEL_PATH/am/final.mdl" && test ! -w "$CAPTCHA_VOSK_MODEL_PATH/am/final.mdl" && test -r "$CAPTCHA_VOSK_LIBRARY_PATH" && node -e "require(\"koffi\").load(process.env.CAPTCHA_VOSK_LIBRARY_PATH)" && node --test dist/tests/vosk_image_smoke.test.js'

USER pwuser
ENTRYPOINT ["node", "dist/main.js"]
