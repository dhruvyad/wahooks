apiVersion: apps/v1
kind: Deployment
metadata:
  name: wahooks-api
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: wahooks-api
  template:
    metadata:
      labels:
        app: wahooks-api
    spec:
      serviceAccountName: wahooks-api
      containers:
        - name: api
          image: "${api_image}"
          ports:
            - containerPort: 3001
          envFrom:
            - secretRef:
                name: wahooks-api-secret
          env:
            - name: NODE_OPTIONS
              value: "--dns-result-order=ipv4first"
            - name: REDIS_URL
              value: "redis://redis.default.svc.cluster.local:6379"
            - name: ORCHESTRATOR
              value: "k8s"
            - name: K8S_NAMESPACE
              value: "default"
            - name: WAHA_STATEFULSET_NAME
              value: "waha"
            - name: WAHA_HEADLESS_SERVICE
              value: "waha"
          readinessProbe:
            httpGet:
              path: /api
              port: 3001
            initialDelaySeconds: 10
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /api
              port: 3001
            initialDelaySeconds: 30
            periodSeconds: 30
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: "2"
              memory: 1Gi
