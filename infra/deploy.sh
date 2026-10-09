#!/usr/bin/env bash
# Deploy from the Mac: bash infra/deploy.sh
# Checks locally, syncs the working tree (never .env), installs, migrates, reloads.
set -euo pipefail
HOST="${DEPLOY_HOST:-fc@159.223.171.42}"
DIR="${DEPLOY_DIR:-apps/contractor-ops}"

echo "==> local checks"
pnpm typecheck
pnpm test:unit

echo "==> sync to $HOST:$DIR"
ssh "$HOST" "mkdir -p $DIR"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude '.env' --exclude '.env.*' --exclude '.DS_Store' \
  ./ "$HOST:$DIR/"

echo "==> install, migrate, reload"
ssh "$HOST" "cd $DIR && test -f .env || { echo 'missing .env on server'; exit 1; }
  pnpm install --frozen-lockfile
  pnpm db:migrate
  pm2 startOrReload infra/ecosystem.config.cjs --update-env
  pm2 save"

echo "==> health"
for i in $(seq 1 20); do
  if curl -fsS "https://contractor-ops.houghworks.com/health" 2>/dev/null; then echo; exit 0; fi
  sleep 1
done
echo "health check failed after 20s; run: ssh $HOST 'pm2 logs co-core --lines 40 --nostream'" >&2
exit 1
