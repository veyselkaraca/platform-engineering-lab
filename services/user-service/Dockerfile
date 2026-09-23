# Node 22 LTS. The host may run a different Node; the image is the reference runtime.
FROM node:25-alpine AS base
WORKDIR /app

# Full dependency set: used by build and by the dev target.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# Local development / debugging (docker-compose.dev.yml). Never deployed.
FROM deps AS dev
COPY . .
ENV NODE_ENV=development
EXPOSE 3000 9229
CMD ["npm", "run", "start:debug"]

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Runtime: production deps + compiled output only, non-root.
FROM base AS runtime
ARG GIT_SHA=unknown
ARG SOURCE_URL=unknown
LABEL org.opencontainers.image.title="user-service" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.source="${SOURCE_URL}"
ENV NODE_ENV=production
# The app runs with plain `node`; drop npm/npx/corepack (and their bundled deps) from the runtime image.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Run node directly (not via npm) so SIGTERM reaches the app for graceful shutdown.
CMD ["node", "dist/main.js"]
