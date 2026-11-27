#!/usr/bin/env bash
# Restauration dans une base VIDE. Usage : deploy/restore.sh <url-propriétaire-de-la-base-vide> <fichier.dump>
# Ne remplace JAMAIS une base qui contient déjà des tables (créez une base neuve : createdb ...).
# Après la restauration : relancer « db:roles » (les droits ne sont pas sauvegardés), puis démarrer l'API.
set -euo pipefail
URL="${1:?usage: restore.sh <url-base-vide> <fichier.dump>}"
FILE="${2:?usage: restore.sh <url-base-vide> <fichier.dump>}"
[ -f "$FILE" ] || { echo "Fichier introuvable : $FILE" >&2; exit 1; }
if [ -f "$FILE.sha256" ]; then
  ( cd "$(dirname "$FILE")" && sha256sum --check --status "$(basename "$FILE").sha256" ) || { echo "Somme de contrôle INVALIDE : archive corrompue, restauration refusée" >&2; exit 1; }
  echo "Somme de contrôle valide."
else
  echo "Attention : pas de somme de contrôle ($FILE.sha256) : intégrité non vérifiée." >&2
fi
TABLES="$(psql "$URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
[ "$TABLES" = "0" ] || { echo "La base cible contient déjà $TABLES table(s) : restauration refusée (utilisez une base vide)." >&2; exit 1; }
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$URL" "$FILE"
echo "Restauration terminée. Étape suivante : db:roles (rôle applicatif), puis démarrage de l'API."
