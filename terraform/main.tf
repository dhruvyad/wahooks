terraform {
  required_version = ">= 1.5.0"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = ">= 1.49.1"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

module "kube-hetzner" {
  providers = {
    hcloud = hcloud
  }

  source  = "kube-hetzner/kube-hetzner/hcloud"
  version = "2.15.3"

  hcloud_token = var.hcloud_token

  # ── SSH ──────────────────────────────────────────────
  ssh_public_key  = file(var.ssh_public_key_path)
  ssh_private_key = file(var.ssh_private_key_path)

  # ── Cluster ─────────────────────────────────────────
  cluster_name        = "wahooks"
  network_region      = "eu-central"
  initial_k3s_channel = "stable"

  # ── Control Plane (single node, no HA — sufficient for early stage)
  control_plane_nodepools = [
    {
      name        = "cp-nbg1"
      server_type = "cx23"
      location    = "nbg1"
      labels      = []
      taints      = []
      count       = 1
    }
  ]

  # ── No static agents — workloads run on control plane + autoscaled workers
  agent_nodepools = [
    {
      name        = "placeholder"
      server_type = "cx23"
      location    = "nbg1"
      labels      = []
      taints      = []
      count       = 0
    }
  ]

  # ── Autoscaling Worker Pool (WAHA pods) ─────────────
  autoscaler_nodepools = [
    {
      name        = "waha-workers"
      server_type = "cx23"
      location    = "nbg1"
      min_nodes   = 1
      max_nodes   = 10
      labels      = {}
      kubelet_args = []
      taints      = []
    }
  ]

  # ── Scheduling ─────────────────────────────────────
  allow_scheduling_on_control_plane = true  # run API+Redis on CP node
  use_control_plane_lb              = false # no LB needed with single CP
  automatically_upgrade_os          = false
  automatically_upgrade_k3s         = true

  # ── Networking ──────────────────────────────────────
  firewall_ssh_source      = var.firewall_ssh_source
  firewall_kube_api_source = var.firewall_kube_api_source

  # ── K3s Components ──────────────────────────────────
  cni_plugin            = "flannel"
  ingress_controller    = "traefik"
  traefik_version       = "27.0.2" # pin: v28+ removed globalArguments schema
  enable_cert_manager   = true
  enable_longhorn       = false
  enable_metrics_server = true
  kured_version         = "1.16.0" # pin to avoid GitHub API rate-limit failures

  # ── Extra Manifests (applied via kustomize) ─────────
  extra_kustomize_parameters = {
    waha_api_key          = var.waha_api_key
    database_url          = var.database_url
    supabase_url          = var.supabase_url
    stripe_secret_key     = var.stripe_secret_key
    stripe_price_id       = var.stripe_price_id
    stripe_webhook_secret = var.stripe_webhook_secret
    api_url               = var.api_url
    frontend_url          = var.frontend_url
    api_image             = var.api_image
  }

  # ── Kubeconfig ──────────────────────────────────────
  create_kubeconfig = true
}
