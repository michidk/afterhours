FROM rust:1-bookworm AS physics
RUN rustup target add wasm32-unknown-unknown && cargo install wasm-bindgen-cli --version 0.2.129 --locked
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release -p afterhours-server \
 && cargo build --release --target wasm32-unknown-unknown --features wasm -p afterhours-physics \
 && wasm-bindgen --target web --out-dir crates/physics/pkg target/wasm32-unknown-unknown/release/afterhours_physics.wasm

FROM node:24-bookworm-slim AS client
COPY --from=oven/bun:1.2.21 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
COPY --from=physics /app/crates/physics/pkg ./crates/physics/pkg
RUN npx tsc --noEmit && npx vite build

FROM node:24-bookworm-slim
COPY --from=oven/bun:1.2.21 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=client /app/dist ./dist
COPY --from=physics /app/target/release/afterhours-server /usr/local/bin/afterhours-server
# The server regenerates the city on every boot through scripts/prepare-city.ts, so the
# generator, converter and the renderer used to bake meshes ship too; data/ must be writable.
COPY shared ./shared
COPY mapgen ./mapgen
COPY scripts ./scripts
COPY client ./client
RUN mkdir -p data && chown node:node data
USER node
ENV NODE_ENV=production PORT=5173 RUST_LOG=info
EXPOSE 5173
CMD ["afterhours-server"]
