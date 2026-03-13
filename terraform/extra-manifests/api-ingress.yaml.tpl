apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: dhruvyadav@berkeley.edu
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - http01:
          ingress:
            class: traefik
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: wahooks-api
  namespace: default
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: traefik
  tls:
    - hosts:
        - api.wahooks.com
      secretName: wahooks-api-tls
  rules:
    - host: api.wahooks.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: wahooks-api
                port:
                  number: 3001
