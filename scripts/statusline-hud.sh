#!/bin/bash
# Claude Code HUD: 5h rate limit + context window usage
# Reads JSON session data from stdin (piped by Claude Code statusLine)

# Colors
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
DIM='\033[2m'
RESET='\033[0m'

# Read stdin with timeout (avoid hang if no input)
INPUT=""
if read -t 2 -r LINE; then
  INPUT="$LINE"
  # Read remaining lines if any
  while read -t 0.1 -r MORE; do
    INPUT="${INPUT}${MORE}"
  done
fi

# If no input, show placeholder
if [ -z "$INPUT" ]; then
  echo "HUD: waiting..."
  exit 0
fi

# Debug: save last input for troubleshooting
echo "$INPUT" > /tmp/claude-statusline-last.json 2>/dev/null

# Parse JSON with jq if available
if command -v jq >/dev/null 2>&1; then
  MODEL=$(echo "$INPUT" | jq -r '.model.display_name // "Claude"' 2>/dev/null)
  RATE_5H=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
  RATE_RESET=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.resets_at // empty' 2>/dev/null)
  RATE_7D=$(echo "$INPUT" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)
  CTX_USED=$(echo "$INPUT" | jq -r '.context_window.used_percentage // empty' 2>/dev/null)
  CTX_SIZE=$(echo "$INPUT" | jq -r '.context_window.context_window_size // empty' 2>/dev/null)
  CTX_CURRENT=$(echo "$INPUT" | jq '[.context_window.current_usage | .input_tokens, .output_tokens, .cache_creation_input_tokens, .cache_read_input_tokens | values] | add // 0' 2>/dev/null)
else
  # Fallback: grep-based extraction
  MODEL=$(echo "$INPUT" | grep -oP '"display_name"\s*:\s*"\K[^"]+' 2>/dev/null | head -1)
  [ -z "$MODEL" ] && MODEL="Claude"
  RATE_5H=$(echo "$INPUT" | grep -oP '"five_hour"\s*:\s*\{[^}]*"used_percentage"\s*:\s*\K[0-9.]+' 2>/dev/null)
  RATE_RESET=$(echo "$INPUT" | grep -oP '"five_hour"\s*:\s*\{[^}]*"resets_at"\s*:\s*\K[0-9]+' 2>/dev/null)
  RATE_7D=$(echo "$INPUT" | grep -oP '"seven_day"\s*:\s*\{[^}]*"used_percentage"\s*:\s*\K[0-9.]+' 2>/dev/null)
  CTX_USED=$(echo "$INPUT" | grep -oP '"used_percentage"\s*:\s*\K[0-9.]+' 2>/dev/null | tail -1)
  CTX_SIZE=$(echo "$INPUT" | grep -oP '"context_window_size"\s*:\s*\K[0-9]+' 2>/dev/null)
  # Sum current_usage tokens via grep fallback
  CTX_CURRENT=0
  for field in input_tokens output_tokens cache_creation_input_tokens cache_read_input_tokens; do
    val=$(echo "$INPUT" | grep -oP "\"current_usage\"[^}]*\"$field\"\\s*:\\s*\\K[0-9]+" 2>/dev/null)
    [ -n "$val" ] && CTX_CURRENT=$(( CTX_CURRENT + val ))
  done
fi

# Bar rendering function
render_bar() {
  local pct=${1:-0}
  local width=16
  local filled=$(( pct * width / 100 ))
  [ $filled -gt $width ] && filled=$width
  local empty=$(( width - filled ))

  # Color by threshold
  local color="$GREEN"
  if [ "$pct" -ge 85 ] 2>/dev/null; then
    color="$RED"
  elif [ "$pct" -ge 60 ] 2>/dev/null; then
    color="$YELLOW"
  fi

  local bar=""
  for ((i=0; i<filled; i++)); do bar+="█"; done
  for ((i=0; i<empty; i++)); do bar+="░"; done

  printf "${color}%s${RESET}" "$bar"
}

# Format rate limit section
RATE_SECTION=""
if [ -n "$RATE_5H" ]; then
  RATE_INT=${RATE_5H%.*}
  [ -z "$RATE_INT" ] && RATE_INT=0
  # Color by threshold
  RATE_COLOR="$GREEN"
  [ "$RATE_INT" -ge 85 ] 2>/dev/null && RATE_COLOR="$RED"
  [ "$RATE_INT" -ge 60 ] 2>/dev/null && [ "$RATE_INT" -lt 85 ] 2>/dev/null && RATE_COLOR="$YELLOW"

  # Show time remaining if > 80% used
  TIME_REMAINING=""
  if [ "$RATE_INT" -ge 80 ] 2>/dev/null && [ -n "$RATE_RESET" ]; then
    NOW=$(date +%s)
    DIFF=$(( RATE_RESET - NOW ))
    if [ "$DIFF" -gt 0 ]; then
      HOURS=$(( DIFF / 3600 ))
      MINS=$(( (DIFF % 3600) / 60 ))
      TIME_REMAINING=$(printf " %dh%02dm" "$HOURS" "$MINS")
    fi
  fi

  RATE_SECTION="5h: ${RATE_COLOR}${RATE_INT}%${RESET}${TIME_REMAINING}"
else
  RATE_SECTION="5h: ${DIM}--%${RESET}"
fi

# Format weekly rate limit section
WEEKLY_SECTION=""
if [ -n "$RATE_7D" ]; then
  RATE_7D_INT=${RATE_7D%.*}
  [ -z "$RATE_7D_INT" ] && RATE_7D_INT=0
  WEEKLY_COLOR="$GREEN"
  [ "$RATE_7D_INT" -ge 85 ] 2>/dev/null && WEEKLY_COLOR="$RED"
  [ "$RATE_7D_INT" -ge 60 ] 2>/dev/null && [ "$RATE_7D_INT" -lt 85 ] 2>/dev/null && WEEKLY_COLOR="$YELLOW"
  WEEKLY_SECTION="7d: ${WEEKLY_COLOR}${RATE_7D_INT}%${RESET}"
else
  WEEKLY_SECTION="7d: ${DIM}--%${RESET}"
fi

# Format context section
CTX_SECTION=""
if [ -n "$CTX_USED" ]; then
  CTX_INT=${CTX_USED%.*}
  [ -z "$CTX_INT" ] && CTX_INT=0
  CTX_COLOR="$GREEN"
  [ "$CTX_INT" -ge 85 ] 2>/dev/null && CTX_COLOR="$RED"
  [ "$CTX_INT" -ge 60 ] 2>/dev/null && [ "$CTX_INT" -lt 85 ] 2>/dev/null && CTX_COLOR="$YELLOW"

  # Show current/max token count from current_usage (actual context window fill)
  TOKEN_INFO=""
  if [ -n "$CTX_SIZE" ] && [ "$CTX_SIZE" -gt 0 ] 2>/dev/null; then
    CTX_SIZE_K=$(( CTX_SIZE / 1000 ))
    CTX_CURRENT_K=$(( CTX_CURRENT / 1000 ))
    TOKEN_INFO=" ${CTX_CURRENT_K}k/${CTX_SIZE_K}k"
  fi

  CTX_SECTION="Ctx: ${CTX_COLOR}${CTX_INT}%${RESET}${TOKEN_INFO}"
else
  CTX_SECTION="Ctx: ${DIM}--%${RESET}"
fi

# Output
echo -e "${MODEL} | ${RATE_SECTION} | ${WEEKLY_SECTION} | ${CTX_SECTION}"
