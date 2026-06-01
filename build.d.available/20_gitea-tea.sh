#!/usr/bin/env bash
# Gitea CLI (tea).
set -euo pipefail

TEA_VERSION=0.14.1

curl -fsSL "https://dl.gitea.com/tea/${TEA_VERSION}/tea-${TEA_VERSION}-linux-amd64" \
  -o /usr/local/bin/tea
chmod +x /usr/local/bin/tea
