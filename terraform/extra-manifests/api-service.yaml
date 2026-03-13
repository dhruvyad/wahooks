apiVersion: v1
kind: Service
metadata:
  name: wahooks-api
  namespace: default
spec:
  type: NodePort
  selector:
    app: wahooks-api
  ports:
    - name: http
      port: 3001
      targetPort: 3001
      nodePort: 30001
