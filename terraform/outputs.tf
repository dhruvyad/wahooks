output "kubeconfig" {
  value     = module.kube-hetzner.kubeconfig
  sensitive = true
  description = "Kubeconfig for the cluster (save to ~/.kube/wahooks.yaml)"
}

output "control_planes_public_ipv4" {
  value       = module.kube-hetzner.control_planes_public_ipv4
  description = "Public IPv4 addresses of control plane nodes"
}

output "agents_public_ipv4" {
  value       = module.kube-hetzner.agents_public_ipv4
  description = "Public IPv4 addresses of static agent nodes"
}

output "ingress_public_ipv4" {
  value       = module.kube-hetzner.ingress_public_ipv4
  description = "Public IPv4 for ingress (point api.wahooks.com DNS here)"
}

output "k3s_endpoint" {
  value       = module.kube-hetzner.k3s_endpoint
  description = "k3s API endpoint"
}
