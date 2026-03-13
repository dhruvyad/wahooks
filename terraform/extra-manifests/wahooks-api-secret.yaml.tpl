apiVersion: v1
kind: Secret
metadata:
  name: wahooks-api-secret
  namespace: default
type: Opaque
stringData:
  DATABASE_URL: "${database_url}"
  SUPABASE_URL: "${supabase_url}"
  WAHA_API_KEY: "${waha_api_key}"
  WAHA_MAX_SESSIONS: "50"
  STRIPE_SECRET_KEY: "${stripe_secret_key}"
  STRIPE_PRICE_ID: "${stripe_price_id}"
  STRIPE_WEBHOOK_SECRET: "${stripe_webhook_secret}"
  PORT: "3001"
  API_URL: "${api_url}"
  FRONTEND_URL: "${frontend_url}"
  NODE_ENV: "production"
