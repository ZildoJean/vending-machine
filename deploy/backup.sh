#!/usr/bin/env bash
# Sauvegarde complète (schéma + données) au format personnalisé de pg_dump.
# Usage : deploy/backup.sh <url-du-rôle-PROPRIÉTAIRE> [dossier]      Variables : KEEP (défaut 14 sauvegardes conservées)
# En conteneur : docker compose -f docker-compose.prod.yml exec -T db pg_dump -U "$POSTGRES_USER" -Fc --no-owner --no-privileges "$POSTGRES_DB" > vending.dump
set -euo pipefail
URL="${1:?usage: backup.sh <url-propriétaire> [dossier]}"
DIR="${2:-./backups}"
KEEP="${KEEP:-14}"
umask 077
mkdir -p "$DIR"
FILE="$DIR/vending-$(date -u +%Y%m%dT%H%M%SZ).dump"
# --no-owner/--no-privileges : la restauration est possible sous un autre propriétaire ; les droits sont reposés par db:roles
pg_dump --format=custom --no-owner --no-privileges --file="$FILE" "$URL"
# contrôle : archive lisible et contenant les tables critiques
LIST="$(pg_restore --list "$FILE")"
for t in wallet_ledger stock_movements orders users machine_state audit_log; do
  grep -q "TABLE public $t " <<<"$LIST" || { echo "Archive suspecte : table $t absente" >&2; rm -f "$FILE"; exit 1; }
done
( cd "$DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )
echo "Sauvegarde : $FILE ($(du -h "$FILE" | cut -f1))"
# rétention
ls -1t "$DIR"/vending-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do rm -f "$old" "$old.sha256"; done
