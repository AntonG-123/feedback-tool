# Single image for both services (SERVICE_MODE=app | proxy | all).
# The Playwright base image ships Node.js and the Chromium build matching
# playwright@1.63.0 (used for screenshots and snapshot rendering).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    STORAGE_DIR=/data/storage

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .
RUN npm run build && npm prune --omit=dev && rm -rf tests docs/screenshots

EXPOSE 3000 3001
CMD ["node", "server/index.js"]
