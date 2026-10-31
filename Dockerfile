FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
RUN mkdir /data && chown node:node /data && chmod 0700 /data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.NEGEV_PORT||'3000')+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/web/user-server.mjs"]
