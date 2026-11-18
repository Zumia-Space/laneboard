FROM node:22-alpine
WORKDIR /app
COPY package.json LICENSE NOTICE README.md AGENTS.md ./
COPY src ./src
COPY bin ./bin
COPY public ./public
COPY schema ./schema
COPY scripts ./scripts
COPY fixtures ./fixtures
ENV NODE_ENV=production BOARD_DATA=/data HOST=0.0.0.0 PORT=8787
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/server.mjs"]
