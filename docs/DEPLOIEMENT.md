# Déploiement

Cible : **une machine** avec Docker Compose (base, migrations, API, point d'entrée HTTPS).

## 1. Choisir comment obtenir un HTTPS gratuit

L'application exige HTTPS en production (le cookie de session est `Secure`). Trois façons gratuites, **non testées ici**
(je n'ai pas d'accès Internet public ni de Docker dans mon environnement) : le Caddyfile, lui, a été exécuté en HTTPS local
et validé de bout en bout.

| Option                          | Domaine obtenu                       | Adapté si…                                                                                                                             | Limites                                                                                               |
| ------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **A. Tailscale Funnel**         | stable : `machine.<réseau>.ts.net`   | La machine est chez vous, derrière une box ou un **NAT d'opérateur** (aucun port à ouvrir)                                             | Compte Tailscale gratuit ; Funnel à activer dans la console ; débit et conditions fixés par Tailscale |
| **B. DuckDNS + Caddy**          | stable : `nom.duckdns.org`           | La machine a une **adresse publique** avec les ports 80 et 443 joignables (serveur en ligne gratuit, ou box avec redirection de ports) | Inutilisable derrière un NAT d'opérateur ; Caddy doit joindre Let's Encrypt                           |
| **C. Cloudflare Tunnel rapide** | aléatoire, change à chaque démarrage | Démonstration d'un jour                                                                                                                | Pas pour un usage durable (l'adresse change : il faut changer `ALLOWED_ORIGINS` à chaque fois)        |

Recommandation : **A** si la machine est à la maison, **B** si elle est sur un serveur en ligne. Dans les deux cas, le domaine
est gratuit ; seul le matériel ou l'hébergement peut avoir un coût.

## 2. Mise en route (modes B ou local)

    cp .env.prod.example .env.prod
    ./deploy/gen-secrets.sh                 # génère les mots de passe et le poivre (jamais affichés)
    # éditer .env.prod :  SITE_ADDRESS=nom.duckdns.org   et   ALLOWED_ORIGINS=https://nom.duckdns.org
    docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
    docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm \
      -e ADMIN_LOGIN=admin -e ADMIN_PASSWORD='<12 caractères minimum>' api node dist/seed-admin.js
    BASE_URL=https://nom.duckdns.org API_PREFIX=/api ADMIN_LOGIN=admin ADMIN_PASSWORD='…' node scripts/smoke.mjs

Le test de fumée crée un produit et un compte de test : à lancer une fois après le déploiement.

## 3. Mode « derrière un tunnel » (option A ou C)

Dans `.env.prod` : `SITE_ADDRESS=http://:8080` et `ALLOWED_ORIGINS=https://<nom-public-du-tunnel>`, puis :

    docker compose -f docker-compose.prod.yml -f docker-compose.tunnel.yml --env-file .env.prod up -d --build
    tailscale funnel 8080                   # option A (ou : cloudflared tunnel --url http://localhost:8080)

Le port 8080 n'est exposé que sur `127.0.0.1` : seul le tunnel y accède.

## 4. Variables importantes

| Variable                                                                                  | Rôle                                                                                                                                                          |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PIN_PEPPER`                                                                              | Poivre des PIN. **Ne jamais perdre ni changer** (voir RUNBOOK)                                                                                                |
| `ALLOWED_ORIGINS`                                                                         | Origine exacte vue par le navigateur ; toute autre est refusée (protection CSRF)                                                                              |
| `RATE_LIMIT_LOGIN_MAX` (10), `RATE_LIMIT_GLOBAL_MAX` (300), `RATE_LIMIT_DEPOSIT_MAX` (60) | Limites par adresse IP et par minute. **Des clients derrière une même adresse (Wi-Fi partagé, NAT d'opérateur) partagent ce quota** : à augmenter dans ce cas |
| `TRUST_PROXY`                                                                             | `true` derrière Caddy/un tunnel, sinon toutes les requêtes semblent venir de la même adresse                                                                  |

## 5. Mise à jour

    ./deploy/backup.sh <url-propriétaire> ./backups     # TOUJOURS avant
    git pull && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
    node scripts/smoke.mjs …                            # vérification

Les migrations s'appliquent seules (tâche `migrate`) ; elles ne vont que vers l'avant : le retour arrière passe par la restauration.
