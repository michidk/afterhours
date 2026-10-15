FROM node:24-bookworm-slim AS build
COPY --from=oven/bun:1.2.21 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM node:24-bookworm-slim
COPY --from=oven/bun:1.2.21 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
# The server regenerates the city on every boot: generator, converter and the
# renderer used to bake meshes ship too, and data/ must be writable.
COPY mapgen ./mapgen
COPY scripts ./scripts
COPY client ./client
RUN mkdir -p data && chown node:node data
USER node
ENV NODE_ENV=production PORT=5173 ALLOW_DEBUG=0
EXPOSE 5173
CMD ["node", "--import", "tsx", "server/index.ts", "--production"]
