#!/bin/bash
set -euo pipefail

# Manual deploy helper for the API server
# Usage: ./deploy.sh [host]

HOST="${1:-${DEPLOY_HOST:?Set DEPLOY_HOST or pass host as argument}}"
IMAGE="ghcr.io/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/api:latest"

echo "Building and pushing image..."
docker build -t "$IMAGE" -f apps/api/Dockerfile .
docker push "$IMAGE"

echo "Deploying to $HOST..."
ssh "$HOST" << REMOTE
  docker pull "$IMAGE"
  docker stop wahooks-api || true
  docker rm wahooks-api || true
  docker run -d \
    --name wahooks-api \
    --restart unless-stopped \
    --env-file /opt/wahooks/.env \
    -p 3001:3001 \
    "$IMAGE"
  docker image prune -f
REMOTE

echo "Deployed successfully!"
