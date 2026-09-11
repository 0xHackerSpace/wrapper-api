#!/bin/bash

# Run D1 migrations with wrangler
# Usage: ./scripts/run-migrations.sh <api_token> [environment]

set -e

if [ -z "$1" ]; then
  echo "❌ Usage: ./scripts/run-migrations.sh <cloudflare_api_token> [environment]"
  echo ""
  echo "Example:"
  echo "  ./scripts/run-migrations.sh 'cfk_abc123xyz' dev"
  echo ""
  echo "📖 Get your API token from:"
  echo "   https://dash.cloudflare.com/profile/api-tokens"
  echo ""
  echo "Requirements:"
  echo "  - Token must have D1 Read + Write permissions"
  echo "  - Token must be for your Cloudflare account"
  exit 1
fi

API_TOKEN="$1"
ENVIRONMENT="${2:-dev}"
DB_NAME="${ENVIRONMENT}-auth"
MIGRATIONS_DIR="terraform/migrations"

# Export token for wrangler
export CLOUDFLARE_API_TOKEN="$API_TOKEN"

echo "🚀 Running D1 migrations for: $DB_NAME"
echo "📂 Migrations directory: $MIGRATIONS_DIR"
echo ""

# Check if migrations directory exists
if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "❌ Migrations directory not found: $MIGRATIONS_DIR"
  exit 1
fi

# Count migrations
MIGRATION_COUNT=$(ls -1 "$MIGRATIONS_DIR"/*.sql 2>/dev/null | wc -l)
echo "📊 Found $MIGRATION_COUNT migration(s)"
echo ""

# Run each migration
MIGRATION_NUM=0
for MIGRATION_FILE in $(ls -1 "$MIGRATIONS_DIR"/*.sql | sort); do
  MIGRATION_NUM=$((MIGRATION_NUM + 1))
  MIGRATION_NAME=$(basename "$MIGRATION_FILE")

  echo "⏳ [$MIGRATION_NUM/$MIGRATION_COUNT] Applying: $MIGRATION_NAME"

  if npx wrangler d1 execute "$DB_NAME" --file="$MIGRATION_FILE" --remote; then
    echo "   ✅ Success"
  else
    echo "   ❌ Failed"
    exit 1
  fi

  echo ""
done

echo "✅ All migrations applied successfully!"
echo ""
echo "📊 Verify database:"
echo "   npx wrangler d1 execute $DB_NAME --command=\"SELECT * FROM users;\" --remote"
echo ""
echo "📋 Database info:"
npx wrangler d1 info "$DB_NAME" --remote || echo "Could not fetch database info"
