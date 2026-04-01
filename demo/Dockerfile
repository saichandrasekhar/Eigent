FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci || npm install

FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 eigent && \
    adduser --system --uid 1001 eigent
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY *.ts ./
USER eigent
CMD ["npx", "tsx", "eigent-demo.ts"]
