#!/usr/bin/env bash

set -Eeuo pipefail

# ------------------------------------------------------------
# Configuration
# ------------------------------------------------------------

PM2_APP="foundry"
FOUNDRY_DATA="/home/foundry/foundrydata"

# pm2 name of the headless GM (pf2e-ra-logging-gm). Leave empty to skip.
GM_BOT_APP="foundry-gm"

# How long to wait for the world to come up after starting Foundry.
READY_TIMEOUT_SECONDS=180

OPTIONS_FILE="$FOUNDRY_DATA/Config/options.json"
WORLDS_DIR="$FOUNDRY_DATA/Data/worlds"

# date +%u:
# 1 = Monday
# 2 = Tuesday
# 3 = Wednesday
# 4 = Thursday
# 5 = Friday
# 6 = Saturday
# 7 = Sunday

# Worlds
# rusthenge
# secrets-of-grayce
# seven-dooms-of-sandpoint
# abomination-vault

declare -A WORLD_BY_DAY=(
    [1]="abomination-vault"
    [2]="secrets-of-grayce"
    [3]="secrets-of-grayce"
    [4]="secrets-of-grayce"
    [5]="secrets-of-grayce"
    [6]="abomination-vault"
    [7]="abomination-vault"
)

# ------------------------------------------------------------
# Select today's world
# ------------------------------------------------------------

DAY_NUMBER="$(date +%u)"
WORLD="${WORLD_BY_DAY[$DAY_NUMBER]:-}"

if [[ -z "$WORLD" ]]; then
    echo "ERROR: No world configured for weekday $DAY_NUMBER."
    exit 1
fi

if [[ ! -d "$WORLDS_DIR/$WORLD" ]]; then
    echo "ERROR: World directory does not exist:"
    echo "$WORLDS_DIR/$WORLD"
    exit 1
fi

if [[ ! -f "$OPTIONS_FILE" ]]; then
    echo "ERROR: Foundry options file does not exist:"
    echo "$OPTIONS_FILE"
    exit 1
fi

if ! jq empty "$OPTIONS_FILE"; then
    echo "ERROR: $OPTIONS_FILE is not valid JSON."
    exit 1
fi

CURRENT_WORLD="$(jq -r '.world // empty' "$OPTIONS_FILE")"

echo "Date: $(date --iso-8601=seconds)"
echo "Weekday number: $DAY_NUMBER"
echo "Current default world: ${CURRENT_WORLD:-none}"
echo "Selected world: $WORLD"

# ------------------------------------------------------------
# Stop Foundry gracefully
# ------------------------------------------------------------

echo "Stopping Foundry..."
pm2 stop "$PM2_APP"

# ------------------------------------------------------------
# Update options.json atomically
# ------------------------------------------------------------

BACKUP_FILE="${OPTIONS_FILE}.daily-backup"
TEMP_FILE="$(mktemp "${OPTIONS_FILE}.tmp.XXXXXX")"

cp --preserve=mode,ownership,timestamps "$OPTIONS_FILE" "$BACKUP_FILE"

if ! jq --arg world "$WORLD" \
    '.world = $world' \
    "$OPTIONS_FILE" > "$TEMP_FILE"; then

    echo "ERROR: Failed to generate the updated options file."
    rm -f "$TEMP_FILE"
    pm2 start "$PM2_APP"
    exit 1
fi

# Keep the original permissions and ownership.
chmod --reference="$OPTIONS_FILE" "$TEMP_FILE"
chown --reference="$OPTIONS_FILE" "$TEMP_FILE"

mv "$TEMP_FILE" "$OPTIONS_FILE"

# Verify the result before starting Foundry.
UPDATED_WORLD="$(jq -r '.world // empty' "$OPTIONS_FILE")"

if [[ "$UPDATED_WORLD" != "$WORLD" ]]; then
    echo "ERROR: options.json verification failed."
    cp --preserve=mode,ownership,timestamps "$BACKUP_FILE" "$OPTIONS_FILE"
    pm2 start "$PM2_APP"
    exit 1
fi

# ------------------------------------------------------------
# Start Foundry
# ------------------------------------------------------------

echo "Starting Foundry with world: $WORLD"
pm2 start "$PM2_APP"

# ------------------------------------------------------------
# Wait until the selected world is actually running
# ------------------------------------------------------------

FOUNDRY_PORT="$(jq -r '.port // 30000' "$OPTIONS_FILE")"
ROUTE_PREFIX="$(jq -r '.routePrefix // empty' "$OPTIONS_FILE")"
ROUTE_PREFIX="${ROUTE_PREFIX#/}"
ROUTE_PREFIX="${ROUTE_PREFIX%/}"

if [[ -n "$(jq -r '.sslCert // empty' "$OPTIONS_FILE")" ]]; then
    SCHEME="https"
else
    SCHEME="http"
fi

STATUS_URL="${SCHEME}://127.0.0.1:${FOUNDRY_PORT}${ROUTE_PREFIX:+/$ROUTE_PREFIX}/api/status"

echo "Waiting up to ${READY_TIMEOUT_SECONDS}s for world '$WORLD' ($STATUS_URL)..."

WORLD_ACTIVE=0
DEADLINE=$((SECONDS + READY_TIMEOUT_SECONDS))

while ((SECONDS < DEADLINE)); do
    if curl -fsSk --max-time 5 "$STATUS_URL" 2>/dev/null |
        jq -e --arg world "$WORLD" '.active == true and .world == $world' >/dev/null 2>&1; then
        WORLD_ACTIVE=1
        break
    fi
    sleep 3
done

if ((WORLD_ACTIVE == 0)); then
    echo "ERROR: World '$WORLD' did not become active within ${READY_TIMEOUT_SECONDS}s."
    echo "Last status: $(curl -fsSk --max-time 5 "$STATUS_URL" 2>/dev/null || echo 'no response')"
    pm2 show "$PM2_APP"
    exit 1
fi

echo "World '$WORLD' is active."

# ------------------------------------------------------------
# Restart the headless GM: fresh browser, joins the new world
# ------------------------------------------------------------

if [[ -n "$GM_BOT_APP" ]]; then
    if pm2 describe "$GM_BOT_APP" >/dev/null 2>&1; then
        echo "Restarting headless GM ($GM_BOT_APP)..."
        pm2 restart "$GM_BOT_APP"
    else
        echo "WARNING: pm2 app '$GM_BOT_APP' is not registered; skipping headless GM restart."
    fi
fi

echo "Foundry startup status:"
pm2 show "$PM2_APP"

echo "Completed successfully."
