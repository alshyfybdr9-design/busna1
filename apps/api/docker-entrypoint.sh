#!/bin/sh
# تشغيل محلي عبر Docker: تهيئة قاعدة البيانات والترحيلات، ثم البيانات التجريبية (اختياري)، ثم الخادم.
set -e
cd /app
echo "[busna] preparing database (roles + migrations)..."
node apps/api/dist/db/bootstrap.js
if [ "$SEED_DEMO" = "true" ]; then
  echo "[busna] seeding clearly-labelled demo data..."
  node apps/api/dist/db/seed.js
fi
echo "[busna] starting API on port ${PORT:-4000}"
exec node apps/api/dist/server.js
