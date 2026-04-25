# Stage 1: Build frontend
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production server
FROM node:20-alpine
# `jq` is required by the bundled shopware-resolve skill's scripts.
# `openssh-client` is required for `git push` to SSH remotes.
RUN apk add --no-cache bash git docker-cli docker-cli-compose openssl openssh-client coreutils rsync github-cli jq
# Install both supported AI agent CLIs globally.  Each binary's auth state
# lives under ~/.claude or ~/.codex on the host and is bind-mounted at
# runtime (HOME mount in docker-compose.ui.yml), so neither needs a
# separate in-container login.
#
# `npm_config_cache=/tmp/npm-cache` keeps the install off the bind-mounted
# host HOME — otherwise host-side ~/.npm permissions surface as
# "EACCES: permission denied" inside the container build.
#
# Both:
#   claude  → user-selected via /#/resolve "AI: Claude" radio
#   codex   → user-selected via "AI: Codex" radio (PR #6 wires the spawn).
#             Without this line, picking Codex emits "spawn codex ENOENT".
RUN npm_config_cache=/tmp/npm-cache npm install -g \
        @anthropic-ai/claude-code \
        @openai/codex \
    && rm -rf /tmp/npm-cache
WORKDIR /app
# Pull package manifests + installed deps from the build stage so we don't
# depend on the host build context containing `package.json` or `server/`.
# This makes `docker build` work regardless of cwd as long as stage-1 succeeded.
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/server server/
COPY --from=build /app/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
COPY --from=build /app/dist dist/
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["npx", "tsx", "server/index.ts"]
