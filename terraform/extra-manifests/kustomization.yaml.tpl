apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - waha-secret.yaml
  - wahooks-api-secret.yaml
  - rbac.yaml
  - redis.yaml
  - waha-service.yaml
  - waha-statefulset.yaml
  - api-deployment.yaml
  - api-service.yaml
