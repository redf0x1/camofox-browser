# Stage 1: Build TypeScript
FROM node:22-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
COPY plugin.ts ./
COPY openclaw.plugin.json ./

RUN npm run build

# Stage 2: Production
FROM node:22-slim
WORKDIR /app

# Persistent data defaults (profiles/downloads/cookies live under /home/node/.camofox)
ENV CAMOFOX_PROFILES_DIR=/home/node/.camofox/profiles

# Ensure persistent directories exist and are writable by the node user
RUN mkdir -p /home/node/.camofox/profiles /home/node/.camofox/downloads \
	&& chown -R node:node /home/node/.camofox

# Install system dependencies for Camoufox/Firefox (Playwright Firefox runtime deps)
RUN apt-get update && apt-get install -y --no-install-recommends     libgtk-3-0     libdbus-glib-1-2     libxt6     libx11-xcb1     libasound2     libdrm2     libgbm1     libxcomposite1     libxcursor1     libxdamage1     libxfixes3     libxi6     libxrandr2     libxrender1     libxss1     libxtst6     libnss3     libnspr4     libatk1.0-0     libatk-bridge2.0-0     libcups2     libpango-1.0-0     libpangocairo-1.0-0     libxkbcommon0     libxshmfence1     fonts-freefont-ttf     fonts-liberation     fonts-noto     fonts-noto-color-emoji     fontconfig     ca-certificates     curl     python3     make     g++     && rm -rf /var/lib/apt/lists/*

# Install production deps only (as non-root)
COPY package*.json ./
RUN chown -R node:node /app
USER node
RUN npm ci --omit=dev

# Copy built output
COPY --from=builder --chown=node:node /app/dist/ ./dist/
COPY --from=builder --chown=node:node /app/plugin.ts ./
COPY --from=builder --chown=node:node /app/openclaw.plugin.json ./

# Pre-download Camoufox browser binary (~300MB)
RUN npx --yes camoufox-js fetch

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3     CMD curl -f http://localhost:9377/health || exit 1

EXPOSE 9377
ENV PORT=9377
ENV CAMOFOX_PORT=9377
ENV NODE_ENV=production

# Persistent data directory (profiles/cookies/downloads) — mount with `-v ~/.camofox:/home/node/.camofox` to persist across container rebuilds
VOLUME /home/node/.camofox

CMD ["node", "dist/src/server.js"]
