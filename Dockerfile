# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

# System deps for Prisma engines
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY prisma ./prisma
RUN npx prisma generate
COPY --from=build /app/dist ./dist
COPY public ./public

EXPOSE 8080 8090
# Apply migrations then start (works for SQLite and Postgres alike).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
