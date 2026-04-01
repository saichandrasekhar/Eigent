# Eigent Terraform Provider

Manage Eigent resources using Terraform with the `hashicorp/http` provider.

This is a lightweight alternative to a full custom Terraform provider (which would require Go). It uses HTTP REST API calls to the Eigent registry.

## Prerequisites

- Terraform >= 1.5.0
- A running Eigent registry instance

## Quick Start

1. Set your variables:

```bash
export TF_VAR_registry_url="http://localhost:3456"
export TF_VAR_master_key="your-master-key"
```

2. Initialize and apply:

```bash
terraform init
terraform plan
terraform apply
```

## Modules

### eigent-agent

Registers an agent with the Eigent registry.

```hcl
module "my_agent" {
  source = "./modules/eigent-agent"

  registry_url = var.registry_url
  master_key   = var.master_key

  agent_name    = "my-agent"
  human_sub     = "user-001"
  human_email   = "user@example.com"
  human_iss     = "https://accounts.google.com"
  scope         = ["read_file", "write_file"]
  ttl_seconds   = 7200
  max_delegation = 3
}
```

**Inputs:**

| Name | Description | Type | Default |
|------|-------------|------|---------|
| registry_url | Eigent registry URL | string | - |
| master_key | Master API key | string | - |
| agent_name | Agent display name | string | - |
| human_sub | Human subject ID | string | - |
| human_email | Human email | string | - |
| human_iss | Identity issuer URL | string | - |
| scope | Tool scopes | list(string) | - |
| ttl_seconds | Token TTL | number | 3600 |
| max_delegation | Max delegation depth | number | 3 |
| can_delegate | Delegatable scopes | list(string) | [] |
| metadata | JSON metadata | string | "{}" |

**Outputs:**

| Name | Description |
|------|-------------|
| agent_id | Registered agent ID |
| agent_token | Bearer token (sensitive) |
| scope | Granted scope |
| expires_at | Token expiration |

### eigent-policy

Deploys a YAML policy file to the registry.

```hcl
module "my_policy" {
  source = "./modules/eigent-policy"

  registry_url = var.registry_url
  master_key   = var.master_key
  policy_file  = "${path.module}/policies/production.yaml"
}
```

**Inputs:**

| Name | Description | Type |
|------|-------------|------|
| registry_url | Eigent registry URL | string |
| master_key | Master API key | string |
| policy_file | Path to YAML policy | string |

**Outputs:**

| Name | Description |
|------|-------------|
| policy_hash | SHA-256 hash of deployed policy |
| policy_file | Path to policy file |

## Notes

- The `master_key` is marked as `sensitive` and will not appear in plan output
- Agent tokens are also `sensitive` outputs
- For production, consider using a remote state backend with encryption
- A full custom Terraform provider (in Go) would provide better state management and drift detection
