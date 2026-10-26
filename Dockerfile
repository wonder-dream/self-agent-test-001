FROM node:24-bookworm-slim

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_NO_WARNINGS=1
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci \
  && npx playwright install --with-deps chromium \
  && mkdir -p /data \
  && chown -R node:node /app /data /ms-playwright

COPY tsconfig.json ./
COPY config ./config
COPY src ./src

USER node
ENV HOME=/home/node
ENV DATA_DIR=/data
ENV PANEL_HOST=0.0.0.0
ENV PANEL_PORT=8080
ENV CHROMIUM_NO_SANDBOX=1
EXPOSE 8080

CMD ["node", "--experimental-strip-types", "src/index.ts"]
