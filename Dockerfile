# syntax=docker/dockerfile:1.7
# Trois cibles : `api` (serveur), `web` (Caddy + interface compilée).  Construire : docker build --target api .
# Pour figer les images par empreinte (recommandé en production), laisser Dependabot (docker) proposer les mises à jour.

FROM node:22-bookworm-slim AS build
RUN npm install -g pnpm@12.18.0
WORKDIR /repo
# 1. dépendances (couche mise en cache tant que les package.json ne changent pas)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
# 2. sources, compilation, arbre de production du serveur
COPY . .
RUN pnpm --filter @vending/server build && pnpm --filter @vending/web build
RUN pnpm --filter @vending/server deploy --prod --legacy /out/api

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /out/api/node_modules ./node_modules
COPY --from=build --chown=node:node /out/api/package.json ./
COPY --from=build --chown=node:node /repo/apps/server/dist ./dist
COPY --from=build --chown=node:node /repo/apps/server/drizzle ./drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM caddy:2-alpine AS web
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
