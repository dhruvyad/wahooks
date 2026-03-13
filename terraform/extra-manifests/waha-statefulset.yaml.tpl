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
          image: devlikeapro/waha:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 3000
          env:
            - name: WHATSAPP_DEFAULT_ENGINE
              value: NOWEB
            - name: WAHA_MAX_SESSIONS
              value: "1"
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
            - name: WHATSAPP_NOWEB_STORE_ENABLED
              value: "true"
            - name: WHATSAPP_NOWEB_STORE_FULL_SYNC
              value: "true"
          resources:
            requests:
              cpu: "1"
              memory: "1Gi"
            limits:
              cpu: "4"
              memory: "4Gi"
          readinessProbe:
            exec:
              command:
                - sh
                - -c
                - 'wget -q --header="X-Api-Key: $WHATSAPP_API_KEY" -O /dev/null http://localhost:3000/api/server/version'
            initialDelaySeconds: 15
            periodSeconds: 5
            failureThreshold: 12
          livenessProbe:
            exec:
              command:
                - sh
                - -c
                - 'wget -q --header="X-Api-Key: $WHATSAPP_API_KEY" -O /dev/null http://localhost:3000/api/server/version'
            initialDelaySeconds: 60
            periodSeconds: 30
            failureThreshold: 3
          terminationMessagePolicy: FallbackToLogsOnError
      terminationGracePeriodSeconds: 60
