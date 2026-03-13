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
