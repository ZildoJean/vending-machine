# Architecture

```mermaid
flowchart LR
  B[Navigateur] -->|HTTPS| C[Caddy]
  C -->|/ : fichiers statiques| W[(interface compilée)]
  C -->|/api| A[API Fastify]
  A --> D[(PostgreSQL)]
  A --> H[[Matériel simulé: monnayeur, distributeur]]
```

Un seul point d'entrée : l'interface et l'API partagent la **même origine** (cookie `SameSite=Strict`, pas de CORS).

## Couches du serveur

```mermaid
flowchart TB
  HTTP[infra/http : routes, authentification, erreurs] --> APP[application : cas d'usage]
  APP --> DOM[domain : règles pures, sans base ni horloge]
  APP -. ports .-> INF[infra : PostgreSQL, matériel, horloge, hachage]
  INF --> DOM
```

`domain` n'importe rien d'autre que `shared`. Les règles d'argent, de panier, de remboursement et la machine à états y sont des **fonctions pures**, testées en propriétés. `application` orchestre dans des transactions ; `infra` branche la base et le matériel.

## Machine à états (globale, un seul propriétaire)

```mermaid
stateDiagram-v2
  [*] --> IDLE
  IDLE --> SELECTING: connexion client
  SELECTING --> DISPENSING: validation
  DISPENSING --> IDLE: fin (toute issue : servie, partielle, échec)
  SELECTING --> IDLE: déconnexion / 2 min d'inactivité / fermeture forcée
  IDLE --> MAINTENANCE: administrateur
  MAINTENANCE --> IDLE: sortie / 15 min d'inactivité
```

L'expiration est évaluée **à la demande** (pas de minuteur) ; `DISPENSING` n'expire jamais.

## Commande : trois phases

```mermaid
sequenceDiagram
  participant C as Client
  participant A as API
  participant D as PostgreSQL
  participant M as Distributeur
  C->>A: POST /orders (Idempotency-Key)
  A->>D: 1. TRANSACTION : session, panier, débit, stock, commande, état DISPENSING
  loop pour chaque unité (délai 10 s)
    A->>M: distribuer
    M-->>A: livrée ?
    A->>D: unité enregistrée (transaction courte)
  end
  A->>D: 3. TRANSACTION : remboursement des non-livrées + retour à IDLE
  A-->>C: résultat (livré / remboursé / solde)
```

Aucun verrou n'est tenu pendant l'appel au matériel. Un crash laisse la commande « en cours » : la **reprise au démarrage** la clôt avec les unités réellement enregistrées.

## Invariants garantis par la base (en plus du code)

Solde et stock **maintenus par déclencheurs** ; registres en ajout seul ; une seule commande en cours ; au plus un achat et un remboursement par commande ; forme de `machine_state` contrainte ; rôle applicatif sans droit d'écriture directe sur solde, stock ni registres.
