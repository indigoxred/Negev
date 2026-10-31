FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src ./src
RUN mkdir /data && chown node:node /data && chmod 0700 /data
USER node
CMD ["node", "src/web/user-server.mjs"]
