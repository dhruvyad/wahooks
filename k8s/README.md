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

**Session cap.** `WAHA_MAX_SESSIONS` on the API sets `max_sessions` when a
worker row is created or revived; active rows keep their own — update them with
SQL when the env changes (35 live sessions ≈ 1.65 GB; ~47 MB each).

**Every ready WAHA pod takes sessions.** Each scaling check (and every
provision, before it asks for a new pod) registers any Ready pod whose
`waha_workers` row is missing or `stopped`, so a pod that came up after its
provision timed out is used instead of idling. Scale-down only drains the
highest-ordinal pod, the only one a StatefulSet can remove; a pod it couldn't
remove stays `draining` rather than being marked `stopped`.

**A failing scale-up is loud.** A provision fails at once, with the cloud's own
error, when the new pod can't be scheduled and the Cluster Autoscaler reports a
scale-up backoff (e.g. Hetzner's `Primary IP limit exceeded`). The API logs it
as an ERROR, `GET /api/infrastructure` (admin) carries it as `scaleUpFailure`
and `GET /api/health` reports `checks.scaleUp: error` until a scale-up
succeeds. Reading the autoscaler's status needs the `wahooks-api-autoscaler-status`
Role in `rbac.yaml` (`kubectl apply -f k8s/rbac.yaml`); without it the provision
waits out its 5 minutes and reports why the pod can't be scheduled.

**OS updates on autoscaled nodes.** kube-hetzner 2.15.3 applies
`automatically_upgrade_os = false` only to the nodes Terraform creates; nodes
the autoscaler adds run `transactional-update` nightly, and each run leaves a
~1 GB btrfs snapshot until kured reboots the node into it. Kured's lock lives
in the `weave.works/kured-node-lock` annotation on `ds/kured`: a node deleted
mid-reboot held it forever (from 2026-08-06), no node rebooted, and one node
reached disk pressure after ~4 weeks of snapshots (2026-10-21, a WAHA pod
evicted). `kured_options` now sets `lock-ttl`. Clearing a stale lock
(`kubectl -n kube-system annotate ds kured weave.works/kured-node-lock-`) lets
kured reboot every node with a pending update, one at a time — each reboot is a
WhatsApp reconnect for every session on that node. Superseded update snapshots
(`snapper list`: every "Snapshot Update" except the default `+` and the booted
`-`) can be deleted with `snapper delete --sync <n>` to free space.

**Database connections.** The API and every WAHA session store (one
`waha_noweb_<session>` database per session) share one Supabase Postgres with
`max_connections = 60`. Steady state is ~40; pod restarts (full-store sync on
boot) and overlapping API rollouts can hit the cap, which WAHA reports as
`remaining connection slots are reserved for roles with the SUPERUSER attribute`.
Reach the DB with `kubectl port-forward svc/supabase-db 15432:5432` and the
`DATABASE_URL` from secret `wahooks-api-secret`.
