# WAHooks Kubernetes Migration

Migrates WAHA worker orchestration from ad-hoc Hetzner VMs to a k3s cluster
with the Kubernetes Cluster Autoscaler — replacing the custom autoscaler with
battle-tested cooldowns, drain/cordon, and hysteresis.

## Architecture

```
Hetzner CX23 (existing API server)   New CX22 (~€3.79/mo)
├── k3s server node 1                 └── k3s server node 2
├── Redis (Docker, --network host)
└── Caddy (HTTPS proxy)

k3s cluster state → Supabase Postgres (existing, no extra cost)

Autoscaled CX23 worker node pool
└── waha StatefulSet pods
    ├── waha-0  (sessions A, B, C …)
    ├── waha-1  (sessions D, E, F …)
    └── …
```

## Files

| File | Purpose |
|------|---------|
| `hetzner-k3s-config.yaml` | Cluster bootstrap config for the `hetzner-k3s` tool |
| `waha-secret.yaml` | Template — apply with `kubectl create secret` (see below) |
| `waha-service.yaml` | Headless Service for per-pod DNS |
| `waha-statefulset.yaml` | WAHA Plus StatefulSet (Postgres session storage) |
| `api-deployment.yaml` | NestJS API Deployment (inside k8s, uses SA for k8s API access) |
| `api-service.yaml` | NodePort Service — Caddy proxies port 30001 |
| `rbac.yaml` | ServiceAccount + Role for NestJS to manage StatefulSet |
| `cluster-autoscaler.yaml` | Cluster Autoscaler for Hetzner node pool scaling |

## Migration Steps

### Phase 0 — DB schema migration (run before anything else)

```sql
ALTER TABLE waha_workers RENAME COLUMN hetzner_server_id TO pod_name;
```

Or via Drizzle: `pnpm --filter @wahooks/db db:generate && pnpm --filter @wahooks/db db:migrate`

### Phase 1 — Provision k3s cluster

```bash
# Install hetzner-k3s
brew install vitobotta/tap/hetzner-k3s   # or download binary from GitHub

# Edit k8s/hetzner-k3s-config.yaml — fill in HETZNER_API_TOKEN and SUPABASE_DATABASE_URL
hetzner-k3s create --config k8s/hetzner-k3s-config.yaml

# Kubeconfig is written to ~/.kube/wahooks.yaml
export KUBECONFIG=~/.kube/wahooks.yaml
kubectl get nodes   # should show 2 masters + 1 worker
```

### Phase 2 — Apply manifests

```bash
# Secrets (never commit real values)
kubectl create secret generic waha-secret \
  --from-literal=api-key=<WAHA_API_KEY> \
  --from-literal=database-url=<SUPABASE_DATABASE_URL>

kubectl create secret generic hetzner-secret \
  --from-literal=token=<HETZNER_API_TOKEN> \
  --namespace kube-system

# Load all API server env vars as a secret
kubectl create secret generic wahooks-api-secret \
  --from-env-file=/opt/wahooks/.env

# Apply manifests
kubectl apply -f k8s/rbac.yaml
kubectl apply -f k8s/waha-service.yaml
kubectl apply -f k8s/waha-statefulset.yaml
kubectl apply -f k8s/cluster-autoscaler.yaml
kubectl apply -f k8s/api-service.yaml
kubectl apply -f k8s/api-deployment.yaml
```

### Phase 3 — Seed the first worker DB row

After `waha-0` becomes Ready (check: `kubectl get pods -w`):

```sql
INSERT INTO waha_workers (pod_name, internal_ip, api_key_enc, status, max_sessions)
VALUES (
  'waha-0',
  'waha-0.waha.default.svc.cluster.local',
  '<WAHA_API_KEY>',
  'active',
  50
);
```

Then point existing sessions at the new worker:
```sql
UPDATE waha_sessions
SET worker_id = (SELECT id FROM waha_workers WHERE pod_name = 'waha-0')
WHERE status != 'stopped';
```

WAHA Plus will auto-reconnect sessions from Postgres storage within ~1 minute.
The health cron reconciles status on the next poll.

### Phase 4 — Update Caddy & env, cut over

On the API server host:

```bash
# Add ORCHESTRATOR and k8s config to env
echo "ORCHESTRATOR=k8s" >> /opt/wahooks/.env
echo "KUBECONFIG=/opt/wahooks/kubeconfig" >> /opt/wahooks/.env
echo "WAHA_API_KEY=<same key as in waha-secret>" >> /opt/wahooks/.env

# Copy kubeconfig for out-of-cluster access
cp ~/.kube/wahooks.yaml /opt/wahooks/kubeconfig

# Generate a long-lived SA token for the kubeconfig
kubectl create token wahooks-api --duration=8760h
# Add this token to /opt/wahooks/kubeconfig as the user token

# Update Caddy to proxy to NodePort
# /etc/caddy/Caddyfile:
#   api.wahooks.com {
#     reverse_proxy 127.0.0.1:30001
#   }
systemctl reload caddy

# Redeploy API container (or switch to the k8s Deployment)
docker restart wahooks-api
```

### Phase 5 — Validate

```bash
./scripts/e2e-test.sh https://api.wahooks.com --no-scan
kubectl logs -l app=wahooks-api --tail=50
kubectl logs -l app=waha --tail=50
```

### Phase 6 — Decommission old WAHA VMs

Once health cron confirms all sessions are `working` on the k8s pods,
delete the old WAHA Hetzner VMs from the Cloud Console.

## Environment Variables Added

| Variable | Required | Default | Description |
|---|---|---|---|
| `ORCHESTRATOR` | No | `k8s` (prod) | `k8s`, `hetzner`, or `mock` |
| `WAHA_API_KEY` | Yes | — | Shared API key for all WAHA pods |
| `K8S_NAMESPACE` | No | `default` | k8s namespace for WAHA StatefulSet |
| `WAHA_STATEFULSET_NAME` | No | `waha` | StatefulSet name |
| `WAHA_HEADLESS_SERVICE` | No | `waha` | Headless Service name for pod DNS |
| `KUBECONFIG` | No* | `~/.kube/config` | Path to kubeconfig (needed when running outside cluster) |
