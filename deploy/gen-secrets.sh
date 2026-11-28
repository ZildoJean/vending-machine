#!/usr/bin/env bash
# Génère les secrets de .env.prod (sans jamais les afficher). N'écrase JAMAIS une valeur déjà renseignée.
set -euo pipefail
cd "$(dirname "$0")/.."
FILE=".env.prod"
[ -f "$FILE" ] || cp .env.prod.example "$FILE"
chmod 600 "$FILE"
gen() { openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48; }
fill() {
  local key="$1"
  if grep -qE "^${key}=.+" "$FILE"; then echo "  $key : déjà renseigné (conservé)"; return; fi
  local value; value="$(gen)"
  if grep -qE "^${key}=" "$FILE"; then sed -i "s|^${key}=.*|${key}=${value}|" "$FILE"; else echo "${key}=${value}" >> "$FILE"; fi
  echo "  $key : généré"
}
echo "Secrets de $FILE :"
fill POSTGRES_PASSWORD
fill APP_DB_PASSWORD
fill PIN_PEPPER
echo "Terminé. ATTENTION : PIN_PEPPER ne doit JAMAIS être perdu ni changé (tous les PIN deviendraient invalides)."
echo "Sauvegardez .env.prod dans un gestionnaire de mots de passe. Éditez SITE_ADDRESS et ALLOWED_ORIGINS."
