#!/usr/bin/env bash
#
# Eigent Scan — quick installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/saichandrasekhar/Eigent/main/eigent-scan/install.sh | bash
#
set -euo pipefail

PACKAGE_NAME="eigent-scan"

echo "==> Installing ${PACKAGE_NAME}..."

# Find Python 3
PYTHON=""
for cmd in python3 python; do
  if command -v "$cmd" &>/dev/null; then
    version=$("$cmd" --version 2>&1)
    if echo "$version" | grep -q "Python 3"; then
      PYTHON="$cmd"
      break
    fi
  fi
done

if [ -z "$PYTHON" ]; then
  echo "Error: Python 3 is required but not found."
  echo "Install Python 3 from https://python.org and try again."
  exit 1
fi

echo "    Found $($PYTHON --version)"

# Find pip
PIP_CMD=""
for cmd in pip3 pip; do
  if command -v "$cmd" &>/dev/null; then
    PIP_CMD="$cmd"
    break
  fi
done

if [ -z "$PIP_CMD" ]; then
  if "$PYTHON" -m pip --version &>/dev/null; then
    PIP_CMD="$PYTHON -m pip"
  else
    echo "Error: pip is required but not found."
    echo "Install pip: https://pip.pypa.io/en/stable/installation/"
    exit 1
  fi
fi

echo "    Found $($PIP_CMD --version)"

# Install
$PIP_CMD install "$PACKAGE_NAME"

echo ""
echo "==> ${PACKAGE_NAME} installed successfully!"
echo "    Run: eigent-scan --help"
