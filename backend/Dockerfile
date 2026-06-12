# Task5 #10 — build whisper.cpp's CLI from source (no prebuilt Linux binary is
# published). Static ggml libs so the runtime stage only needs libstdc++/libgomp.
FROM debian:bookworm-slim AS whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
    && git clone --depth 1 --branch v1.7.5 https://github.com/ggml-org/whisper.cpp /w \
    && cmake -S /w -B /w/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    && cmake --build /w/build -j"$(nproc)" --target whisper-cli

# Debian (glibc) base: required for onnxruntime-node (transformers.js / K4) which
# has no musl/alpine prebuilt. Also gives us tesseract (K1 OCR), ffmpeg, poppler.
FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl \
      ffmpeg \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-vie \
      poppler-utils \
      libgomp1 \
    # yt-dlp standalone binary (bundles its own Python) for YouTube import.
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
         -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# whisper.cpp CLI (Task5 #10 — transcription). The ggml model is downloaded
# lazily at runtime into /app/models/whisper (persisted by the models volume).
COPY --from=whisper /w/build/bin/whisper-cli /usr/local/bin/whisper-cli

COPY package.json ./
COPY prisma ./prisma
RUN npm install --omit=dev && npx prisma generate

COPY src ./src
COPY scripts ./scripts

# Where transformers.js caches downloaded models (mount a volume here to persist).
ENV TRANSFORMERS_CACHE=/app/models
RUN mkdir -p /app/models

EXPOSE 4000
# Apply committed migrations on startup. The existing db-push database was
# baselined with `prisma migrate resolve --applied 0_init`; fresh databases get
# the 0_init migration applied automatically.
CMD ["sh", "-c", "npx prisma migrate deploy && node src/server.js"]
