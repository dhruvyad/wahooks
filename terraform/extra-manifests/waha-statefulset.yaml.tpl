apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: waha
  namespace: default
spec:
  serviceName: waha
  replicas: 1
  selector:
    matchLabels:
      app: waha
  template:
    metadata:
      labels:
        app: waha
    spec:
      containers:
        - name: waha
          image: devlikeapro/waha-plus:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 3000
          env:
            - name: WHATSAPP_DEFAULT_ENGINE
              value: NOWEB
            - name: WAHA_MAX_SESSIONS
              value: "50"
            - name: WHATSAPP_API_KEY
              valueFrom:
                secretKeyRef:
                  name: waha-secret
                  key: api-key
            - name: WAHA_WORKER_ID
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: WHATSAPP_SESSIONS_POSTGRESQL_URL
              valueFrom:
                secretKeyRef:
                  name: waha-secret
                  key: database-url
          resources:
            requests:
              cpu: "1"
              memory: "1Gi"
            limits:
              cpu: "4"
              memory: "4Gi"
          readinessProbe:
            httpGet:
              path: /api/server/version
              port: 3000
              httpHeaders:
                - name: X-Api-Key
                  value: "$(WHATSAPP_API_KEY)"
            initialDelaySeconds: 15
            periodSeconds: 5
            failureThreshold: 12
          livenessProbe:
            httpGet:
              path: /api/server/version
              port: 3000
              httpHeaders:
                - name: X-Api-Key
                  value: "$(WHATSAPP_API_KEY)"
            initialDelaySeconds: 60
            periodSeconds: 30
            failureThreshold: 3
          terminationMessagePolicy: FallbackToLogsOnError
      terminationGracePeriodSeconds: 60
