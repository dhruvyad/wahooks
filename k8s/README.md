# WAHooks Kubernetes Infrastructure

Manages WAHA worker orchestration on a k3s cluster with the Kubernetes Cluster
Autoscaler — replacing the custom Hetzner VM autoscaler with battle-tested
cooldowns, drain/cordon, and hysteresis.

## Architecture

```
3× CX22 control-plane nodes (HA etcd)
├── flannel CNI + Traefik ingress
├── wahooks-api Deployment
├── Redis Deployment
└── Load Balancer (k8s API)

Autoscaled CX23 worker node pool (1–10 nodes)
└── waha StatefulSet pods
    ├── waha-0  (sessions A, B, C …)
    ├── waha-1  (sessions D, E, F …)
    └── …
```

## Deployment

Infrastructure is managed declaratively with Terraform using the
[kube-hetzner](https://github.com/kube-hetzner/terraform-hcloud-kube-hetzner)
module. One `terraform apply` provisions the entire cluster, applies all
k8s manifests, and configures the autoscaler.

See [`../terraform/`](../terraform/) for the Terraform configuration.

### Prerequisites

1. **SSH key** (ed25519, no passphrase):
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/wahooks_k8s -N ""
   ```

2. **MicroOS snapshots** (one-time, ~10 min):
   ```bash
   export HCLOUD_TOKEN="your-token"
   # Download packer template from kube-hetzner repo
   packer init hcloud-microos-snapshots.pkr.hcl
   packer build hcloud-microos-snapshots.pkr.hcl
   ```

3. **Terraform** >= 1.5.0

### Deploy

```bash
cd terraform/

# Copy and fill in secrets
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with real values

terraform init
terraform plan
terraform apply

# Save kubeconfig
terraform output -raw kubeconfig > ~/.kube/wahooks.yaml
export KUBECONFIG=~/.kube/wahooks.yaml
kubectl get nodes
```

### Post-deploy: Seed first worker

After `waha-0` becomes Ready (`kubectl get pods -w`):

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

### CI/CD

The GitHub Actions workflow (`.github/workflows/deploy-api.yml`) builds the API
image, pushes to GHCR, and updates the k8s Deployment via `kubectl set image`.

Store the kubeconfig as a base64-encoded GitHub secret (`DEPLOY_KUBECONFIG`):
```bash
base64 < ~/.kube/wahooks.yaml | pbcopy
# Paste into GitHub repo Settings → Secrets → DEPLOY_KUBECONFIG
```

### DNS

Point `api.wahooks.com` to the ingress IP:
```bash
terraform output ingress_public_ipv4
```

## Reference Files

| Directory | Purpose |
|-----------|---------|
| `terraform/` | Terraform config (kube-hetzner module + variables) |
| `terraform/extra-manifests/` | K8s manifests applied via kustomize |
| `k8s/` | Legacy manual manifests (reference only) |

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ORCHESTRATOR` | No | `k8s` (prod) | `k8s`, `hetzner`, or `mock` |
| `WAHA_API_KEY` | Yes | — | Shared API key for all WAHA pods |
| `K8S_NAMESPACE` | No | `default` | k8s namespace for WAHA StatefulSet |
| `WAHA_STATEFULSET_NAME` | No | `waha` | StatefulSet name |
| `WAHA_HEADLESS_SERVICE` | No | `waha` | Headless Service name for pod DNS |

## Operations (2026-09-14)

**What owns what.** The cluster, the Cluster Autoscaler and the k3s version are
Terraform/kube-hetzner territory, but the live cluster has drifted from
`terraform/` (k3s auto-upgrades; hand patches) — treat `terraform apply` as
destructive until the config is re-imported. Workloads (`waha` StatefulSet,
`wahooks-api`, `wahooks-mcp`) are changed with `kubectl` and mirrored into the
manifests here; `deploy-api.yml` only does `kubectl set image`.

**WAHA workers never share a node with the control plane.** The StatefulSet
carries node affinity `node-role.kubernetes.io/control-plane DoesNotExist`,
requests 1 cpu / 2 GiB, limits 2 cpu / 3 GiB (under a cx23's memory, so a
runaway worker is OOM-killed alone), `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`,
and `updateStrategy: OnDelete`. A worker that grew on the 4 GB control-plane
node thrashed the whole node until kubelet killed it (2026-09-14: every
session flapped and every owner was emailed for nothing).

**Rolling a WAHA pod = a WhatsApp reconnect for every session on it.** Never
`kubectl rollout restart statefulset/waha`. To pick up a template change:

1. Pre-provision a node: `kubectl patch deploy -n kube-system cluster-autoscaler`
   with `--nodes=2:10:…` **and** `--enforce-node-group-min-size=true`; wait for
   `kubectl get nodes` to show it Ready (~3 min). Revert both flags afterwards.
2. `kubectl delete pod waha-N --grace-period=60` — the pod re-schedules with the
   new template; sessions are WORKING again ~90 s later. Verify with
   `kubectl exec waha-N -- sh -c 'curl -s -H "X-Api-Key: $WHATSAPP_API_KEY" localhost:3000/api/sessions'`.
3. One pod per maintenance window.

**Session cap.** `WAHA_MAX_SESSIONS` on the API only seeds NEW `waha_workers`
rows; existing rows keep their own `max_sessions` — update them with SQL when
the env changes (35 live sessions ≈ 1.65 GB; ~47 MB each).

**Database connections.** The API and every WAHA session store (one
`waha_noweb_<session>` database per session) share one Supabase Postgres with
`max_connections = 60`. Steady state is ~40; pod restarts (full-store sync on
boot) and overlapping API rollouts can hit the cap, which WAHA reports as
`remaining connection slots are reserved for roles with the SUPERUSER attribute`.
Reach the DB with `kubectl port-forward svc/supabase-db 15432:5432` and the
`DATABASE_URL` from secret `wahooks-api-secret`.
