#!/usr/bin/env bash
#
# Deploy flaww to Cloud Run and wire up Cloud Scheduler.
#
# Idempotent — safe to re-run. Reads secrets from .env and pushes them to
# Secret Manager rather than baking them into the image or the revision's
# plaintext env.
#
#   ./deploy/deploy.sh
#
set -euo pipefail

PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${GCP_REGION:-europe-west1}"
SERVICE="${SERVICE_NAME:-flaww}"
SA="flaww-scheduler"

cd "$(dirname "$0")/.."
set -a; source .env; set +a

echo "▸ enabling APIs"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  --project "$PROJECT" --quiet

# ── secrets ────────────────────────────────────────────────────────────────
# Cloud Run env vars are visible to anyone with viewer on the project; Secret
# Manager versions are not, and rotating one doesn't need a redeploy.
put_secret () {
  local name="$1" value="$2"
  [[ -z "$value" ]] && return 0
  if ! gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic --project "$PROJECT" --quiet
  fi
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project "$PROJECT" --quiet >/dev/null
  echo "  · $name"
}

echo "▸ secrets"
put_secret flaww-database-url        "${DATABASE_URL:-}"
put_secret flaww-openai-key          "${OPENAI_API_KEY:-}"
put_secret flaww-telegram-token      "${TELEGRAM_BOT_TOKEN:-}"
put_secret flaww-telegram-secret     "${TELEGRAM_WEBHOOK_SECRET:-}"
put_secret flaww-tasks-secret        "${TASKS_SECRET:-}"
put_secret flaww-reddit-secret       "${REDDIT_CLIENT_SECRET:-}"
put_secret flaww-reddit-password     "${REDDIT_PASSWORD:-}"
put_secret flaww-threads-token       "${THREADS_ACCESS_TOKEN:-}"
put_secret flaww-x-secret            "${X_CLIENT_SECRET:-}"
put_secret flaww-x-refresh           "${X_REFRESH_TOKEN:-}"
put_secret flaww-linkedin-token      "${LINKEDIN_ACCESS_TOKEN:-}"

SECRET_FLAGS="DATABASE_URL=flaww-database-url:latest"
SECRET_FLAGS+=",OPENAI_API_KEY=flaww-openai-key:latest"
SECRET_FLAGS+=",TELEGRAM_BOT_TOKEN=flaww-telegram-token:latest"
SECRET_FLAGS+=",TELEGRAM_WEBHOOK_SECRET=flaww-telegram-secret:latest"
SECRET_FLAGS+=",TASKS_SECRET=flaww-tasks-secret:latest"
[[ -n "${REDDIT_CLIENT_SECRET:-}"  ]] && SECRET_FLAGS+=",REDDIT_CLIENT_SECRET=flaww-reddit-secret:latest"
[[ -n "${REDDIT_PASSWORD:-}"       ]] && SECRET_FLAGS+=",REDDIT_PASSWORD=flaww-reddit-password:latest"
[[ -n "${THREADS_ACCESS_TOKEN:-}"  ]] && SECRET_FLAGS+=",THREADS_ACCESS_TOKEN=flaww-threads-token:latest"
[[ -n "${X_CLIENT_SECRET:-}"       ]] && SECRET_FLAGS+=",X_CLIENT_SECRET=flaww-x-secret:latest"
[[ -n "${X_REFRESH_TOKEN:-}"       ]] && SECRET_FLAGS+=",X_REFRESH_TOKEN=flaww-x-refresh:latest"
[[ -n "${LINKEDIN_ACCESS_TOKEN:-}" ]] && SECRET_FLAGS+=",LINKEDIN_ACCESS_TOKEN=flaww-linkedin-token:latest"

ENV_VARS="LOG_LEVEL=${LOG_LEVEL:-info},DRY_RUN=${DRY_RUN:-0}"
ENV_VARS+=",TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID}"
[[ -n "${REDDIT_CLIENT_ID:-}"   ]] && ENV_VARS+=",REDDIT_CLIENT_ID=${REDDIT_CLIENT_ID}"
[[ -n "${REDDIT_USERNAME:-}"    ]] && ENV_VARS+=",REDDIT_USERNAME=${REDDIT_USERNAME}"
[[ -n "${REDDIT_USER_AGENT:-}"  ]] && ENV_VARS+=",REDDIT_USER_AGENT=${REDDIT_USER_AGENT}"
[[ -n "${X_CLIENT_ID:-}"        ]] && ENV_VARS+=",X_CLIENT_ID=${X_CLIENT_ID}"
[[ -n "${LINKEDIN_AUTHOR_URN:-}" ]] && ENV_VARS+=",LINKEDIN_AUTHOR_URN=${LINKEDIN_AUTHOR_URN}"

# ── deploy ─────────────────────────────────────────────────────────────────
#
# --max-instances=1 is load-bearing, not a cost tweak. flaww holds per-source
# poll cursors and publishes at-most-once; one instance makes both trivially
# correct. The distributed lock in src/lock.ts covers the gap during a
# revision rollover, when Cloud Run briefly runs old and new together.
#
# --min-instances=0 lets it scale to zero. Cold start (~1-2s) is invisible for
# a Telegram card and free for a scheduled poll.
echo "▸ deploying $SERVICE to $REGION"
gcloud run deploy "$SERVICE" \
  --source . \
  --project "$PROJECT" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=10 \
  --cpu=1 \
  --memory=512Mi \
  --timeout=300 \
  --set-env-vars "$ENV_VARS" \
  --set-secrets "$SECRET_FLAGS" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format='value(status.url)')"
echo "▸ service URL: $URL"

# PUBLIC_URL isn't known until the first deploy creates the service, so set it
# on a second pass. The app re-registers its Telegram webhook on boot.
gcloud run services update "$SERVICE" \
  --project "$PROJECT" --region "$REGION" \
  --update-env-vars "PUBLIC_URL=$URL" --quiet

# ── scheduler ──────────────────────────────────────────────────────────────
if ! gcloud iam service-accounts describe "$SA@$PROJECT.iam.gserviceaccount.com" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA" --display-name "flaww scheduler" --project "$PROJECT" --quiet
fi

# Three jobs — the Cloud Scheduler free tier is 3 jobs per billing account.
#
# Poll every 5 min: this is the *tick*, not the poll rate. Each source still
# waits out its own pollMinutes, so the tick just decides who is due.
#
# Publish every 2 min: this bounds how late a scheduled reply can fire. With
# scale-to-zero nothing else is alive to run a timer.
make_job () {
  local name="$1" schedule="$2" path="$3"
  local args=(
    --project "$PROJECT" --location "$REGION"
    --schedule "$schedule"
    --uri "$URL$path"
    --http-method POST
    --headers "X-Flaww-Task-Secret=$TASKS_SECRET"
    --attempt-deadline 300s
    --max-retry-attempts 1
    --quiet
  )
  if gcloud scheduler jobs describe "$name" --project "$PROJECT" --location "$REGION" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$name" "${args[@]}"
  else
    gcloud scheduler jobs create http "$name" "${args[@]}"
  fi
  echo "  · $name  ($schedule)"
}

echo "▸ scheduler"
make_job flaww-poll         "*/5 * * * *"  /tasks/poll
make_job flaww-publish      "*/2 * * * *"  /tasks/publish
make_job flaww-housekeeping "17 4 * * *"   /tasks/housekeeping

echo
echo "Done. $URL"
echo "Send /start to your bot to confirm the webhook is live."
