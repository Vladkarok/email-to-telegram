# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build


FROM node:20-alpine AS runner

RUN apk add --no-cache postgresql16-client

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY drizzle/ ./drizzle/
COPY scripts/ ./scripts/

# Persistent storage volumes — all directories must be pre-created and chowned
# before Docker mounts the named volumes over them (volumes are mounted as root).
RUN mkdir -p /data/attachments /data/rawemails /data/backups \
 && chmod +x /app/scripts/backup.sh \
 && chown -R appuser:appgroup /data
VOLUME ["/data/attachments", "/data/rawemails", "/data/backups"]

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1

CMD ["node", "dist/index.js"]
