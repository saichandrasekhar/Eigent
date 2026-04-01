FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 eigent && \
    adduser --system --uid 1001 eigent
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER eigent
CMD ["node", "dist/index.js"]
