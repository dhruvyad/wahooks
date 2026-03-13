apiVersion: v1
kind: Secret
metadata:
  name: waha-secret
  namespace: default
type: Opaque
stringData:
  api-key: "${waha_api_key}"
  database-url: "${database_url}"
