# Eigent Agent Module
#
# Registers an agent with the Eigent registry via HTTP API.

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

variable "agent_name" {
  description = "Name of the agent to register"
  type        = string
}

variable "human_sub" {
  description = "Human subject identifier"
  type        = string
}

variable "human_email" {
  description = "Human email address"
  type        = string
}

variable "human_iss" {
  description = "Human identity issuer URL"
  type        = string
}

variable "scope" {
  description = "List of tool scopes the agent can access"
  type        = list(string)
}

variable "ttl_seconds" {
  description = "Token TTL in seconds"
  type        = number
  default     = 3600
}

variable "max_delegation" {
  description = "Maximum delegation depth"
  type        = number
  default     = 3
}

variable "can_delegate" {
  description = "Scopes the agent can delegate (defaults to full scope)"
  type        = list(string)
  default     = []
}

variable "metadata" {
  description = "Additional metadata as JSON string"
  type        = string
  default     = "{}"
}

# Register the agent via POST /api/agents
data "http" "register_agent" {
  url    = "${var.registry_url}/api/agents"
  method = "POST"

  request_headers = {
    Content-Type  = "application/json"
    Authorization = "Bearer ${var.master_key}"
  }

  request_body = jsonencode({
    name                 = var.agent_name
    human_sub            = var.human_sub
    human_email          = var.human_email
    human_iss            = var.human_iss
    scope                = var.scope
    ttl_seconds          = var.ttl_seconds
    max_delegation_depth = var.max_delegation
    can_delegate         = var.can_delegate
    metadata             = jsondecode(var.metadata)
  })

  lifecycle {
    postcondition {
      condition     = self.status_code == 201
      error_message = "Failed to register agent: HTTP ${self.status_code} - ${self.response_body}"
    }
  }
}

locals {
  response = jsondecode(data.http.register_agent.response_body)
}

output "agent_id" {
  description = "The registered agent's ID"
  value       = local.response.agent_id
}

output "agent_token" {
  description = "The agent's bearer token"
  value       = local.response.token
  sensitive   = true
}

output "scope" {
  description = "The granted scope"
  value       = local.response.scope
}

output "expires_at" {
  description = "Token expiration timestamp"
  value       = local.response.expires_at
}
