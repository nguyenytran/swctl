# Stage 1: Build frontend
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Production server
FROM node:20-alpine
RUN apk add --no-cache bash git docker-cli docker-cli-compose openssl coreutils rsync
WORKDIR /app
# Pull package manifests + installed deps from the build stage so we don't
# depend on the host build context containing `package.json` or `server/`.
# This makes `docker build` work regardless of cwd as long as stage-1 succeeded.
COPY --from=build /app/package.json /app/package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/server server/
COPY --from=build /app/dist dist/
EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]
