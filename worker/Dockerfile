# ffmpeg and ffprobe are required by the transcribe stage: a meeting's 60-second
# segments are joined into one file before Sarvam sees them, so diarization runs
# once over the whole meeting (see README, "Audio concatenation").
FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "src/main.ts"]
