FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# FFmpeg is used to join all generated sections into one WAV file.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && chown -R node:node /app

COPY --chown=node:node package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY --chown=node:node . .

USER node
EXPOSE 10000
CMD ["node", "server.js"]
