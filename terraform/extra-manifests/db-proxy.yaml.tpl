apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: supabase-db-proxy
  namespace: default
spec:
  selector:
    matchLabels:
      app: supabase-db-proxy
  template:
    metadata:
      labels:
        app: supabase-db-proxy
    spec:
      hostNetwork: true
      dnsPolicy: ClusterFirstWithHostNet
      tolerations:
        - operator: Exists
      containers:
        - name: socat
          image: alpine/socat:latest
          args:
            - "TCP-LISTEN:15432,fork,reuseaddr"
            - "TCP6:[2a05:d014:1c06:5f4a:ac21:6f41:435:974]:5432"
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              cpu: 100m
              memory: 32Mi
---
apiVersion: v1
kind: Service
metadata:
  name: supabase-db
  namespace: default
spec:
  selector:
    app: supabase-db-proxy
  ports:
    - port: 5432
      targetPort: 15432
