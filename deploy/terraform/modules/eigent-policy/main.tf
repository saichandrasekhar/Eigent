# Eigent Policy Module
#
# Deploys a YAML policy file to the Eigent registry.
# The policy is read from a local file and sent to the registry API.

terraform {
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
}

variable "master_key" {
  description = "Master API key for authentication"
  type        = string
  sensitive   = true
}

variable "policy_file" {
  description = "Path to the YAML policy file"
  type        = string
}

# Read the policy file content
locals {
  policy_content = file(var.policy_file)
  policy_hash    = sha256(local.policy_content)
}

# Deploy policy via POST /api/v1/policies
# Note: This endpoint may need to be implemented in the registry.
# For now, this module reads the file and POSTs it as YAML.
data "http" "deploy_policy" {
  url    = "${var.registry_url}/api/v1/policies"
  method = "POST"

  request_headers = {
    Content-Type  = "application/x-yaml"
    Authorization = "Bearer ${var.master_key}"
  }

  request_body = local.policy_content

  lifecycle {
    # Accept both 200 and 201 as success
    postcondition {
      condition     = contains([200, 201], self.status_code)
      error_message = "Failed to deploy policy: HTTP ${self.status_code} - ${self.response_body}"
    }
  }
}

output "policy_hash" {
  description = "SHA-256 hash of the deployed policy content"
  value       = local.policy_hash
}

output "policy_file" {
  description = "Path to the policy file that was deployed"
  value       = var.policy_file
}

output "response" {
  description = "Registry response"
  value       = data.http.deploy_policy.response_body
}
