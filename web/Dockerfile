FROM node:22.23.1-bookworm-slim

ENV NODE_ENV=production
ENV PORT=4173
ENV TZ=Asia/Bangkok

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ocrmypdf \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    tesseract-ocr-tha \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY src ./src
COPY public ./public
COPY config ./config
COPY data ./data

RUN mkdir -p /app/local-nas/videos /app/local-nas/labels /app/local-nas/cloud-sync

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4173) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "start"]
