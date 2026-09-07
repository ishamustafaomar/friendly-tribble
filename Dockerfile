# o_typefully — one Node process, SQLite and uploads on a disk mounted at /data.
# Build: docker build -t o_typefully .
# Run:   docker run -p 3000:3000 -v otf_data:/data -e APP_PASSWORD=change-me o_typefully
FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    CONFIG_PATH=/app/config.json

WORKDIR /app

# Install only runtime dependencies (express, twitter-text); node:sqlite is built in.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Posting slots and timezone live in config.json; edit it and rebuild, or mount
# your own over /app/config.json.
COPY config.json ./
COPY src ./src
COPY public ./public

# The database and uploaded images live on /data. Mount a volume there.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

EXPOSE 3000

# /healthz needs no password and ignores the Host header.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Same flags as `npm start`: silence the node:sqlite experimental notice and
# twitter-text's punycode deprecation.
CMD ["node", "--disable-warning=ExperimentalWarning", "--disable-warning=DEP0040", "src/server.js"]
