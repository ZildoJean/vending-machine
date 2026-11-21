# Distributeur de boissons (simulation)

Prérequis : Node >= 20, pnpm.

    pnpm install
    pnpm check      # typecheck + tests

Règle de dépendance : domain n'importe rien ; application importe domain ;
infra implémente les interfaces de application.

## Base de données (PostgreSQL 16)

    docker compose up -d          # démarre PostgreSQL
    cp .env.example .env
    pnpm check                    # typecheck + tests unitaires + tests de schéma (vrai PostgreSQL)

Les tests de schéma (`*.db.test.ts`) créent une base neuve par fichier : le rôle doit avoir
le droit CREATE DATABASE (c'est le cas avec docker-compose.yml).

Migrations : `pnpm --filter @vending/server db:generate` (Drizzle), la migration `triggers`
est écrite à la main (déclencheurs, amorçage du singleton).
