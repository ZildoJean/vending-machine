# Distributeur de boissons (simulation)

Un distributeur sans rendu de monnaie : chaque client a un **wallet** alimenté par des billets ; la commande est débitée du
wallet, le reste y demeure pour la prochaine visite. Une seule personne utilise la machine à la fois. L'administrateur gère
produits, stock et comptes.

Ce n'est pas un jouet : l'argent est un **registre** dont le solde est maintenu par la base, les commandes sont
**idempotentes**, une panne de distribution est **remboursée à l'unité**, et la machine reprend seule après un crash.

## Démarrage rapide (développement)

Prérequis : Node 22, pnpm 12, PostgreSQL 16+ (Docker ou installation directe, voir plus bas).

    pnpm install
    copy .env.example .env         (Linux/macOS : cp .env.example .env)
    # éditer .env : PIN_PEPPER (à générer), ADMIN_PASSWORD, et DATABASE_URL si votre rôle/mot de passe diffèrent
    pnpm --filter @vending/server db:migrate
    pnpm --filter @vending/server seed:admin          # crée l'administrateur défini dans .env
    pnpm dev:api                                      # terminal 1 : http://127.0.0.1:3000
    pnpm dev:web                                      # terminal 2 : http://localhost:5173  (ouvrir CETTE adresse)

Le fichier `.env` est **lu automatiquement** (aucun `export` ni `$env:` nécessaire). Une variable déjà définie dans le terminal
reste prioritaire. `docker compose up -d` démarre un PostgreSQL de développement (rôle `vending`, base `vending_dev`).

`pnpm check` exécute types, ESLint, Prettier et tous les tests (la base de tests est créée à la volée : le rôle doit pouvoir
`CREATE DATABASE`, c'est le cas avec `docker-compose.yml`). `pnpm --filter @vending/server test:approle` rejoue la suite HTTP
sous le **rôle restreint** de production.

## Où lire quoi

| Besoin                                          | Document                                     |
| ----------------------------------------------- | -------------------------------------------- |
| Mettre en ligne (domaine gratuit, HTTPS)        | [docs/DEPLOIEMENT.md](docs/DEPLOIEMENT.md)   |
| Exploiter : sauvegarde, restauration, incidents | [docs/RUNBOOK.md](docs/RUNBOOK.md)           |
| Comprendre la conception                        | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Sécurité : menaces, défenses, risques résiduels | [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) |
| Pourquoi chaque choix                           | [docs/DECISIONS.md](docs/DECISIONS.md)       |
| Utiliser l'application                          | [docs/MANUEL.md](docs/MANUEL.md)             |

## Organisation

    packages/shared   types, schémas Zod et codes d'erreur partagés serveur / interface
    apps/server       API Fastify : domain (règles pures) · application · infra (PostgreSQL, matériel, HTTP)
    apps/web          interface React (client + administration) et tests Playwright (e2e/)
    deploy/           Caddyfile, sauvegarde, restauration, génération des secrets
    scripts/          smoke.mjs (test de fumée post-déploiement), load-test.mjs (charge)

## Vérifications automatiques

CI (`.github/workflows/ci.yml`) : types, lint, format, tests avec PostgreSQL · tests sous rôle restreint · audit des
dépendances · analyse de secrets · construction des images Docker, déploiement et test de fumée · parcours Playwright
(Chromium, Firefox, mobile) avec contrôle de contraste.

## PostgreSQL installé directement (Windows, macOS, Linux) — sans Docker

Les tests créent une base **temporaire par fichier** : le rôle utilisé doit avoir `CREATEDB` (et `CREATEROLE` pour le test de
séparation des droits, qui est sinon ignoré). Avec `psql -U postgres` :

    CREATE ROLE vending LOGIN PASSWORD 'vending' CREATEDB CREATEROLE;   -- si le rôle n'existe pas
    ALTER ROLE vending CREATEDB CREATEROLE;                              -- s'il existe déjà
    CREATE DATABASE vending_dev OWNER vending;                           -- base de développement

Autre rôle ou autre port : définir `TEST_PG_ADMIN_URL` (PowerShell : `$env:TEST_PG_ADMIN_URL="postgres://postgres:motdepasse@localhost:5432/postgres"` ;
cmd : `set TEST_PG_ADMIN_URL=...`). Si la configuration est mauvaise, le test s'arrête avec la commande exacte à lancer.

Les scripts `deploy/*.sh` et `scripts/*.mjs` : les `.mjs` fonctionnent partout (Node) ; les `.sh` demandent bash (WSL ou Git Bash).

## Dépannage

| Message                                               | Cause                                                        | Solution                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `droit refusé pour créer une base de données` (tests) | Le rôle de test n'a pas `CREATEDB`                           | `ALTER ROLE vending CREATEDB CREATEROLE;` (voir plus haut) |
| `MIGRATION_DATABASE_URL ou DATABASE_URL requis`       | Pas de fichier `.env` lu                                     | Créer `.env` à la racine (copie de `.env.example`)         |
| `PostgreSQL est injoignable sur …`                    | Serveur arrêté ou mauvaise adresse                           | Démarrer PostgreSQL, vérifier `DATABASE_URL`               |
| `Connexion refusée pour le rôle « … »`                | Mot de passe ou rôle incorrect                               | Corriger `DATABASE_URL`                                    |
| `La base « … » n'existe pas`                          | Base non créée                                               | Lancer la commande `CREATE DATABASE` affichée              |
| `Can't find meta/_journal.json file`                  | (corrigé) chemin du projet contenant une espace ou un accent | Utiliser la dernière version                               |

Les messages d'erreur des tests de base de données ne dépendent pas de la langue de PostgreSQL (les erreurs sont reconnues par
leur code SQLSTATE, vérifié par un test de garde).
