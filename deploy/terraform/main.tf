# Eigent Terraform Configuration
#
# Uses the hashicorp/http provider to manage Eigent resources via the
# registry REST API. This is a lightweight alternative to a full custom
# Terraform provider (which would require Go).

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

variable "registry_url" {
  description = "URL of the Eigent registry"
  type        = string
  default     = "http://localhost:3456"
}

variable "master_key" {
  description = "Master API key for the Eigent registry"
  type        = string
  sensitive   = true
}

# Example: Register an agent using the eigent-agent module
module "code_review_agent" {
  source = "./modules/eigent-agent"

  registry_url = var.registry_url
  master_key   = var.master_key

  agent_name       = "code-review-bot"
  human_sub        = "user-001"
  human_email      = "dev@example.com"
  human_iss        = "https://accounts.google.com"
  scope            = ["read_file", "write_file", "run_tests"]
  ttl_seconds      = 3600
  max_delegation   = 2
}

# Example: Deploy a policy using the eigent-policy module
module "production_policy" {
  source = "./modules/eigent-policy"

  registry_url = var.registry_url
  master_key   = var.master_key

  policy_file = "${path.module}/policies/production.yaml"
}

output "agent_id" {
  description = "The registered agent ID"
  value       = module.code_review_agent.agent_id
}

output "agent_token" {
  description = "The agent's bearer token"
  value       = module.code_review_agent.agent_token
  sensitive   = true
}
