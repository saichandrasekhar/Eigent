#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Eigent Demo — OAuth for AI Agents
# ─────────────────────────────────────────────────────────────────────────
#
# Shows the full IAM flow in 90 seconds:
#   human auth -> agent token -> delegation -> permission enforcement -> cascade revocation
#
# Usage:
#   bash demo/run-demo.sh
#
# Prerequisites:
#   - Node.js >= 20
#   - npm
#
# ─────────────────────────────────────────────────────────────────────────

set -e

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors
BOLD='\033[1m'
CYAN='\033[36m'
GREEN='\033[32m'
RED='\033[31m'
DIM='\033[2m'
RESET='\033[0m'

echo ""
echo -e "${BOLD}${CYAN}============================================================${RESET}"
echo -e "${BOLD}${CYAN}  EIGENT DEMO: OAuth for AI Agents${RESET}"
echo -e "${BOLD}${CYAN}============================================================${RESET}"
echo ""
echo -e "${DIM}This demo runs a self-contained TypeScript script that${RESET}"
echo -e "${DIM}demonstrates the full Eigent IAM flow end-to-end.${RESET}"
echo ""

# ── Check prerequisites ─────────────────────────────────────────────────

check_command() {
  if ! command -v "$1" &> /dev/null; then
    echo -e "${RED}Error: $1 is required but not installed.${RESET}"
    exit 1
  fi
}

check_command node
check_command npm

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo -e "${RED}Error: Node.js >= 20 is required. Found: $(node -v)${RESET}"
  exit 1
fi

echo -e "${GREEN}[OK]${RESET} Node.js $(node -v)"
echo ""

# ── Install dependencies ────────────────────────────────────────────────

echo -e "${BOLD}Installing dependencies...${RESET}"

cd "$DEMO_DIR"

if [ ! -d "node_modules" ]; then
  npm install --silent 2>/dev/null
  echo -e "${GREEN}[OK]${RESET} Dependencies installed"
else
  echo -e "${DIM}Dependencies already installed${RESET}"
fi

echo ""

# ── Run the demo ─────────────────────────────────────────────────────────

echo -e "${BOLD}Running Eigent demo...${RESET}"
echo ""

npx tsx eigent-demo.ts

EXIT_CODE=$?

if [ $EXIT_CODE -ne 0 ]; then
  echo -e "${RED}Demo exited with code $EXIT_CODE${RESET}"
  exit $EXIT_CODE
fi
