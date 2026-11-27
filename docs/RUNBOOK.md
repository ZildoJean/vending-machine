# Exploitation

## Santé et journaux

- `GET /health` : 200 si la base répond (utilisé par les contrôles de santé Docker).
- `docker compose -f docker-compose.prod.yml logs -f api`
- Messages à surveiller (niveau `warn` / `error`) :

| Message                                         | Signification                                                                | Action                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `reprise au démarrage effectuée`                | Une commande interrompue a été clôturée (crash pendant une distribution)     | Vérifier la commande dans l'audit et le remboursement ; rien à faire |
| `Livraison tardive après délai…`                | Le matériel a livré après 10 s : l'unité avait déjà été remboursée (offerte) | Contrôler le matériel                                                |
| `Machine incohérente à la clôture…`             | État de la machine inattendu à la fin d'une commande                         | Examiner ; envisager une restauration si répété                      |
| `Machine en DISPENSING sans commande en cours…` | État résiduel remis à libre au démarrage                                     | Aucune                                                               |
| `purge des sessions échouée`                    | La purge horaire a échoué                                                    | Vérifier la base                                                     |

## Sauvegarde

    ./deploy/backup.sh postgres://<propriétaire>@<hôte>/<base> /chemin/sauvegardes
    # conteneur : docker compose -f docker-compose.prod.yml exec -T db pg_dump -U "$POSTGRES_USER" -Fc --no-owner --no-privileges "$POSTGRES_DB" > vending.dump

Planification (exemple, tous les jours à 03:15) : `15 3 * * * /opt/vending/deploy/backup.sh <url> /srv/sauvegardes`.
**Copiez les sauvegardes HORS de la machine** (une panne de disque emporterait aussi les sauvegardes locales).
Une sauvegarde ne contient PAS le poivre : conservez `.env.prod` séparément.

## Restauration (testée : données, schéma, déclencheurs et fonctions identiques)

1. Créer une base **vide** (la restauration refuse une base qui contient des tables).
2. `./deploy/restore.sh <url-base-vide> sauvegarde.dump` (vérifie la somme de contrôle ; refuse une archive corrompue).
3. Poser le rôle restreint : `node dist/setup-roles.js` (variables `MIGRATION_DATABASE_URL`, `APP_DB_PASSWORD`).
4. Démarrer l'API **avec le même `PIN_PEPPER` qu'avant** : avec un autre, toutes les connexions échouent (testé).
5. `node scripts/smoke.mjs …`

## Incidents

| Situation                                          | Procédure                                                                                                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panne de courant ou crash pendant une distribution | Redémarrer : la reprise clôture la commande avec les unités réellement servies et rembourse le reste                                                                                   |
| Machine « occupée » par un client parti            | La session expire seule après 2 min d'inactivité ; sinon l'administrateur utilise « Fermer la session client »                                                                         |
| Maintenance oubliée                                | Expire après 15 min d'inactivité ; la déconnexion de l'administrateur la quitte aussi                                                                                                  |
| `503 MACHINE_LOCKED` répétés                       | Un verrou est tenu trop longtemps (délai de 5 s) : examiner les requêtes lentes de la base                                                                                             |
| Compte client verrouillé                           | Se débloque seul au bout de 5 min ; l'administrateur peut réinitialiser le PIN (déverrouille aussi)                                                                                    |
| **Mot de passe administrateur perdu**              | Il n'existe pas de réinitialisation par l'interface. Créer un NOUVEL administrateur avec `seed-admin` (login différent). L'ancien compte reste actif : à traiter en base si nécessaire |
| **Perte ou changement du poivre**                  | Tous les PIN deviennent invalides. Il faut réinitialiser le PIN de chaque client depuis l'administration (les administrateurs doivent être recréés)                                    |
| Changement du mot de passe du rôle applicatif      | Modifier `APP_DB_PASSWORD`, relancer la tâche `migrate` (elle réapplique les droits), redémarrer l'API                                                                                 |
| Disque plein                                       | La base refuse les écritures : l'API répond en erreur sans corrompre les registres (transactions). Libérer de la place puis redémarrer                                                 |

## Ce qui n'est PAS surveillé automatiquement

Pas de métriques ni d'alertes : à ajouter si l'usage devient critique (voir « Limites connues » dans THREAT-MODEL.md).
