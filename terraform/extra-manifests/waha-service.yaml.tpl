apiVersion: v1
kind: Service
metadata:
  name: waha
  namespace: default
spec:
  clusterIP: None
  selector:
    app: waha
  ports:
    - name: http
      port: 3000
      targetPort: 3000
