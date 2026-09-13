#!/bin/bash

# Helper script to create new D1 migrations
# Usage: ./scripts/create-migration.sh "create_new_table"

set -e

if [ -z "$1" ]; then
  echo "Usage: ./scripts/create-migration.sh <migration_description>"
  echo "Example: ./scripts/create-migration.sh 'add_column_to_users'"
  exit 1
fi

DESCRIPTION="$1"
MIGRATIONS_DIR="terraform/migrations"

# Find the highest migration number
if [ ! -d "$MIGRATIONS_DIR" ]; then
  mkdir -p "$MIGRATIONS_DIR"
  NEXT_NUM=1
else
  LAST_MIGRATION=$(ls -1 "$MIGRATIONS_DIR"/*.sql 2>/dev/null | tail -1 | xargs basename || echo "0000")
  LAST_NUM=$(echo "$LAST_MIGRATION" | cut -d_ -f1)
  NEXT_NUM=$((LAST_NUM + 1))
fi

# Pad to 4 digits
MIGRATION_NUM=$(printf "%04d" "$NEXT_NUM")
MIGRATION_FILE="${MIGRATIONS_DIR}/${MIGRATION_NUM}_${DESCRIPTION}.sql"

# Check if file already exists
if [ -f "$MIGRATION_FILE" ]; then
  echo "❌ Migration file already exists: $MIGRATION_FILE"
  exit 1
fi

# Get current date
CURRENT_DATE=$(date +%Y-%m-%d)

# Create migration file
cat > "$MIGRATION_FILE" << 'MIGRATION_TEMPLATE'
-- Migration: MIGRATION_NUM_DESCRIPTION
-- Description: YOUR_DESCRIPTION_HERE
-- Created: CURRENT_DATE_HERE

-- TODO: Add your SQL changes here
-- Example:
-- CREATE TABLE IF NOT EXISTS my_table (
--   id TEXT PRIMARY KEY,
--   name TEXT NOT NULL,
--   created_at DATETIME DEFAULT CURRENT_TIMESTAMP
-- );
MIGRATION_TEMPLATE

# Replace placeholders
sed -i "s|MIGRATION_NUM_DESCRIPTION|${MIGRATION_NUM}_${DESCRIPTION}|g" "$MIGRATION_FILE"
sed -i "s|YOUR_DESCRIPTION_HERE|Add description for ${DESCRIPTION}|g" "$MIGRATION_FILE"
sed -i "s|CURRENT_DATE_HERE|${CURRENT_DATE}|g" "$MIGRATION_FILE"

echo "✅ Created migration: $MIGRATION_FILE"
echo ""
echo "Next steps:"
echo "1. Edit the migration file and add your SQL"
echo "2. Add migration path to terraform/environments/*/terraform.tfvars:"
echo "   \"terraform/migrations/${MIGRATION_NUM}_${DESCRIPTION}.sql\","
echo "3. Run: terraform apply -var-file=environments/dev/terraform.tfvars"
echo ""
echo "📖 See MIGRATIONS.md for more information"
