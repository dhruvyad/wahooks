# ── Hetzner Cloud ─────────────────────────────────────
variable "hcloud_token" {
  type        = string
  sensitive   = true
  description = "Hetzner Cloud API token (read+write)"
}

variable "ssh_public_key_path" {
  type        = string
  default     = "~/.ssh/wahooks_k8s.pub"
  description = "Path to SSH public key (ed25519, no passphrase recommended)"
}

variable "ssh_private_key_path" {
  type        = string
  default     = "~/.ssh/wahooks_k8s"
  description = "Path to SSH private key"
}

# ── Firewall ──────────────────────────────────────────
variable "firewall_ssh_source" {
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
  description = "CIDRs allowed SSH access (restrict in production)"
}

variable "firewall_kube_api_source" {
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
  description = "CIDRs allowed k8s API access (restrict in production)"
}

# ── Container Registry ───────────────────────────────
variable "ghcr_auth" {
  type        = string
  sensitive   = true
  description = "Base64-encoded 'username:token' for ghcr.io image pulls"
}

# ── Application Secrets ───────────────────────────────
variable "waha_api_key" {
  type        = string
  sensitive   = true
  description = "Shared WAHA API key for all pods"
}

variable "database_url" {
  type        = string
  sensitive   = true
  description = "Supabase Postgres connection string"
}

variable "supabase_url" {
  type        = string
  description = "Supabase project URL (for JWT verification)"
}

variable "stripe_secret_key" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Stripe secret key (optional — billing disabled if empty)"
}

variable "stripe_price_id" {
  type        = string
  default     = ""
  description = "Stripe price ID for usage billing (optional)"
}

variable "stripe_webhook_secret" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Stripe webhook signing secret (optional)"
}

# ── URLs ──────────────────────────────────────────────
variable "api_url" {
  type        = string
  default     = "https://api.wahooks.com"
  description = "Public API URL"
}

variable "frontend_url" {
  type        = string
  default     = "https://wahooks.com"
  description = "Public frontend URL"
}

variable "api_image" {
  type        = string
  default     = "ghcr.io/dhruvyad/wahooks/api:latest"
  description = "API container image (updated by CI/CD)"
}
