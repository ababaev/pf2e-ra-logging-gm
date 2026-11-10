#!/usr/bin/env bash
# Human-readable view of the headless GM's action log.
#
#   ./report.sh                  today, players only
#   ./report.sh -w               only tagged entries (hp, coins, xp, quantity, rules, chat-delete, ...)
#   ./report.sh -d yesterday     another day: YYYY-MM-DD | today | yesterday | all
#   ./report.sh -u Vasya         one user (case-insensitive)
#   ./report.sh -t coins         one tag
#   ./report.sh -a               also GM and Server GM entries
#   ./report.sh -j               raw JSON lines instead of text (pipe into jq)
#
# Options combine: ./report.sh -d all -u Vasya -w

set -Eeuo pipefail
shopt -s nullglob

LOG_DIR="${LOG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/logs}"
DAY="today"
ONLY_USER=""
TAG=""
WATCH=false
ALL=false
RAW=false

usage() {
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while getopts "d:u:t:wajh" opt; do
    case "$opt" in
        d) DAY="$OPTARG" ;;
        u) ONLY_USER="$OPTARG" ;;
        t) TAG="$OPTARG" ;;
        w) WATCH=true ;;
        a) ALL=true ;;
        j) RAW=true ;;
        h) usage 0 ;;
        *) usage 1 ;;
    esac
done

case "$DAY" in
    today) DAY="$(date +%F)" ;;
    yesterday) DAY="$(date -d yesterday +%F)" ;;
esac

if [[ "$DAY" == "all" ]]; then
    FILES=("$LOG_DIR"/actions-*.jsonl*)
else
    FILES=("$LOG_DIR"/actions-"$DAY".jsonl*)
fi

if (( ${#FILES[@]} == 0 )); then
    echo "No action log for '$DAY' in $LOG_DIR" >&2
    exit 1
fi

# shellcheck disable=SC2016  # $vars below are jq variables, not shell
FILTER='
  select($all or (.isGM != true) or .kind == "logger-start")
  | select($user == "" or ((.user // "") | ascii_downcase) == ($user | ascii_downcase))
  | select(($watch | not) or ((.tags // []) | length > 0))
  | select($tag == "" or ((.tags // []) | any(. == $tag)))
'
FORMAT='"\(.time[0:19] | sub("T"; " "))  \(if ((.tags // []) | length) > 0 then "[" + (.tags | join(",")) + "] " else "" end)\(.summary // .kind)"'

JQ_ARGS=(--arg user "$ONLY_USER" --arg tag "$TAG" --argjson watch "$WATCH" --argjson all "$ALL")

if $RAW; then
    zcat -f -- "${FILES[@]}" | jq -c "${JQ_ARGS[@]}" "$FILTER"
else
    zcat -f -- "${FILES[@]}" | jq -r "${JQ_ARGS[@]}" "$FILTER | $FORMAT"
fi
