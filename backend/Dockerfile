# Debian (glibc) base: required for onnxruntime-node (transformers.js / K4) which
# has no musl/alpine prebuilt. Also gives us tesseract (K1 OCR), ffmpeg, poppler.
FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
      ffmpeg \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-vie \
      poppler-utils \
    && rm -rf /var/lib/apt/lists/*

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
