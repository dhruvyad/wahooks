apiVersion: v1
kind: ServiceAccount
metadata:
  name: wahooks-api
  namespace: default
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: wahooks-api-role
  namespace: default
rules:
  - apiGroups: ["apps"]
    resources: ["statefulsets"]
    resourceNames: ["waha"]
    verbs: ["get", "patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: wahooks-api-rolebinding
  namespace: default
subjects:
  - kind: ServiceAccount
    name: wahooks-api
    namespace: default
roleRef:
  kind: Role
  name: wahooks-api-role
  apiGroup: rbac.authorization.k8s.io
