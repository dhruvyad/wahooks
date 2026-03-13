apiVersion: v1
kind: Secret
metadata:
  name: ghcr-secret
  namespace: default
type: kubernetes.io/dockerconfigjson
stringData:
  .dockerconfigjson: |
    {"auths":{"ghcr.io":{"auth":"${ghcr_auth}"}}}
