#!/usr/bin/env bash
#
# Deploy the MetaMCP fork on its host (VM 175).
#
# Run ON the VM:   bash /home/raymatos/metamcp/scripts/deploy.sh
# From a laptop:   ssh raymatos@192.168.10.192 'bash /home/raymatos/metamcp/scripts/deploy.sh'
#
# The build takes several minutes. When invoking over SSH from an agent
# session that may end, detach it so the build survives:
#
#   ssh host 'setsid bash /home/.../scripts/deploy.sh > /tmp/mm-deploy.log 2>&1 &'
#   then poll /tmp/mm-deploy.log for DEPLOY_OK / DEPLOY_FAIL.
#
set -uo pipefail

REPO="${REPO:-/home/raymatos/metamcp}"
BRANCH="${BRANCH:-ai-dev}"
BUILD_LOG="${BUILD_LOG:-/tmp/mm-build.log}"
# Cap the build cache rather than wiping it: keeps same-day rebuilds fast
# while bounding growth. Unbounded, ~7 rebuilds in a day grew it to 40GB and
# took the root filesystem to 82% (2026-09-09).
#
# Set the cap BELOW the size you actually want to sit at. Measured on docker
# 29: --max-used-space only evicts *reclaimable* entries and leaves a margin,
# so a cap at the steady-state size is a no-op — at 10.56GB of cache, a 10GB
# cap reclaimed 0B while a 5GB cap reclaimed 2.47GB (down to ~8GB). One build
# adds roughly 5GB.
CACHE_CAP="${CACHE_CAP:-5GB}"

fail() { echo "DEPLOY_FAIL: $*" >&2; exit 1; }

cd "$REPO" || fail "no repo at $REPO"
# The checkout is owned by raymatos but git may be invoked as another user.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="$REPO"

echo "==> pull ($BRANCH)"
git pull --ff-only origin "$BRANCH" || fail "git pull"

echo "==> build (log: $BUILD_LOG)"
rm -f "$BUILD_LOG"
if ! docker compose build app > "$BUILD_LOG" 2>&1; then
  echo "--- last 30 lines of build log ---" >&2
  tail -30 "$BUILD_LOG" >&2
  fail "docker compose build"
fi
echo "    build OK"

# Prune AFTER the build so this run still benefits from the cache.
echo "==> cap build cache at $CACHE_CAP"
docker builder prune -f --max-used-space "$CACHE_CAP" 2>&1 | tail -1
docker image prune -f >/dev/null 2>&1 || true

echo "==> recreate app"
docker compose up -d app || fail "docker compose up"

echo "==> wait for health"
status=starting
for _ in $(seq 1 60); do
  status=$(docker inspect -f '{{.State.Health.Status}}' metamcp 2>/dev/null || echo starting)
  [ "$status" = healthy ] && break
  sleep 5
done
[ "$status" = healthy ] || fail "container not healthy (status=$status)"
echo "    healthy"

echo "==> disk"
df -h / | tail -1
docker system df | awk 'NR==1 || /Build Cache|Images/'

echo "==> deployed: $(git log --oneline -1)"
echo "DEPLOY_OK"
