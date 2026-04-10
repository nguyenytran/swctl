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
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY server/ server/
COPY --from=build /app/dist dist/
EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]
