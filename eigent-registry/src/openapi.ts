/**
 * OpenAPI 3.1 specification for the Eigent Registry API.
 */

export function generateOpenAPISpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Eigent Registry API',
      version: '1.0.0',
      description: 'Agent identity management, delegation, and audit trails for AI agent trust infrastructure.',
      contact: {
        name: 'Eigent Team',
      },
    },
    servers: [
      {
        url: '/api/v1',
        description: 'API v1',
      },
    ],
    paths: {
      '/agents': {
        post: {
          summary: 'Register a new agent',
          operationId: 'registerAgent',
          tags: ['Agents'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RegisterAgentRequest' },
              },
            },
          },
          responses: {
            '201': {
              description: 'Agent registered successfully',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RegisterAgentResponse' },
                },
              },
            },
            '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
            '401': { description: 'ID token verification failed' },
          },
        },
        get: {
          summary: 'List agents with optional filters',
          operationId: 'listAgents',
          tags: ['Agents'],
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', default: 'active' } },
            { name: 'human_email', in: 'query', schema: { type: 'string' } },
            { name: 'parent_id', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: 'List of agents',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AgentListResponse' },
                },
              },
            },
          },
        },
      },
      '/agents/stale': {
        get: {
          summary: 'List stale agents',
          operationId: 'listStaleAgents',
          tags: ['Agents', 'Lifecycle'],
          parameters: [
            { name: 'threshold_minutes', in: 'query', schema: { type: 'integer' } },
          ],
          responses: {
            '200': { description: 'List of stale agents' },
          },
        },
      },
      '/agents/{id}': {
        get: {
          summary: 'Get agent details',
          operationId: 'getAgent',
          tags: ['Agents'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Agent details' },
            '404': { description: 'Agent not found' },
          },
        },
        delete: {
          summary: 'Revoke an agent (cascade)',
          operationId: 'revokeAgent',
          tags: ['Agents'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Agent revoked' },
            '404': { description: 'Agent not found' },
            '409': { description: 'Agent already revoked' },
          },
        },
      },
      '/agents/{id}/delegate': {
        post: {
          summary: 'Delegate to a child agent',
          operationId: 'delegateAgent',
          tags: ['Agents', 'Delegation'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/DelegateRequest' },
              },
            },
          },
          responses: {
            '201': { description: 'Delegation successful' },
            '400': { description: 'Validation error' },
            '401': { description: 'Invalid parent token' },
            '403': { description: 'Delegation not allowed' },
            '404': { description: 'Parent agent not found' },
          },
        },
      },
      '/agents/{id}/chain': {
        get: {
          summary: 'Get full delegation chain',
          operationId: 'getDelegationChain',
          tags: ['Agents', 'Delegation'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Delegation chain' },
            '404': { description: 'Agent not found' },
          },
        },
      },
      '/agents/{id}/rotate': {
        post: {
          summary: 'Rotate agent token',
          operationId: 'rotateToken',
          tags: ['Lifecycle'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Token rotated' },
            '404': { description: 'Agent not found' },
            '409': { description: 'Cannot rotate' },
          },
        },
      },
      '/agents/{id}/heartbeat': {
        post: {
          summary: 'Record agent heartbeat',
          operationId: 'recordHeartbeat',
          tags: ['Lifecycle'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Heartbeat recorded' },
            '404': { description: 'Agent not found' },
          },
        },
      },
      '/agents/{id}/deprovision': {
        post: {
          summary: 'Permanently deprovision an agent',
          operationId: 'deprovisionAgent',
          tags: ['Lifecycle'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Agent deprovisioned' },
            '404': { description: 'Agent not found' },
            '409': { description: 'Already deprovisioned' },
          },
        },
      },
      '/agents/{id}/usage': {
        get: {
          summary: 'Get usage stats for an agent',
          operationId: 'getAgentUsage',
          tags: ['Usage'],
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'hours', in: 'query', schema: { type: 'integer', default: 24 } },
          ],
          responses: {
            '200': { description: 'Usage data' },
            '404': { description: 'Agent not found' },
          },
        },
      },
      '/verify': {
        post: {
          summary: 'Verify a token and check scope for a tool',
          operationId: 'verifyToken',
          tags: ['Verification'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/VerifyRequest' },
              },
            },
          },
          responses: {
            '200': { description: 'Verification result' },
            '400': { description: 'Validation error' },
            '401': { description: 'Token verification failed' },
          },
        },
      },
      '/audit': {
        get: {
          summary: 'Query audit log',
          operationId: 'queryAuditLog',
          tags: ['Audit'],
          parameters: [
            { name: 'agent_id', in: 'query', schema: { type: 'string' } },
            { name: 'human_email', in: 'query', schema: { type: 'string' } },
            { name: 'action', in: 'query', schema: { type: 'string' } },
            { name: 'tool_name', in: 'query', schema: { type: 'string' } },
            { name: 'from_date', in: 'query', schema: { type: 'string' } },
            { name: 'to_date', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
          ],
          responses: {
            '200': { description: 'Audit log entries' },
          },
        },
      },
      '/usage/summary': {
        get: {
          summary: 'Organization-wide usage summary',
          operationId: 'getUsageSummary',
          tags: ['Usage'],
          parameters: [
            { name: 'hours', in: 'query', schema: { type: 'integer', default: 24 } },
          ],
          responses: {
            '200': { description: 'Usage summary' },
          },
        },
      },
      '/humans/{email}/deprovision': {
        post: {
          summary: 'Deprovision all agents for a human',
          operationId: 'deprovisionHuman',
          tags: ['Lifecycle'],
          parameters: [
            { name: 'email', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Human deprovisioned' },
          },
        },
      },
      '/compliance/report': {
        get: {
          summary: 'Generate compliance report',
          operationId: 'getComplianceReport',
          tags: ['Compliance'],
          parameters: [
            { name: 'period', in: 'query', schema: { type: 'string', default: '30d' } },
            { name: 'framework', in: 'query', schema: { type: 'string', enum: ['eu-ai-act', 'soc2', 'all'], default: 'all' } },
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['html', 'json'], default: 'html' } },
            { name: 'human', in: 'query', schema: { type: 'string' } },
            { name: 'agents', in: 'query', schema: { type: 'string', description: 'Comma-separated agent IDs' } },
          ],
          responses: {
            '200': { description: 'Compliance report' },
            '400': { description: 'Invalid parameters' },
          },
        },
      },
      '/auth/login': {
        post: {
          summary: 'Initiate OIDC login flow',
          operationId: 'authLogin',
          tags: ['Auth'],
          responses: {
            '200': { description: 'Authorization URL' },
            '500': { description: 'OIDC not configured' },
          },
        },
      },
      '/auth/callback': {
        post: {
          summary: 'OIDC callback: exchange code for tokens',
          operationId: 'authCallback',
          tags: ['Auth'],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['code', 'state'],
                  properties: {
                    code: { type: 'string' },
                    state: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Session created' },
            '400': { description: 'Invalid callback' },
            '401': { description: 'Callback failed' },
          },
        },
      },
      '/auth/providers': {
        get: {
          summary: 'List configured OIDC providers',
          operationId: 'listAuthProviders',
          tags: ['Auth'],
          responses: {
            '200': { description: 'Provider list' },
          },
        },
      },
      '/auth/session/verify': {
        post: {
          summary: 'Verify a session token',
          operationId: 'verifySession',
          tags: ['Auth'],
          responses: {
            '200': { description: 'Session is valid' },
            '401': { description: 'Session invalid or expired' },
          },
        },
      },
      '/auth/logout': {
        post: {
          summary: 'Destroy a session',
          operationId: 'authLogout',
          tags: ['Auth'],
          responses: {
            '200': { description: 'Logged out' },
          },
        },
      },
      '/.well-known/jwks.json': {
        get: {
          summary: 'Public key endpoint (JWKS)',
          operationId: 'getJwks',
          tags: ['Keys'],
          responses: {
            '200': { description: 'JWKS key set' },
          },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'OpenAPI specification',
          operationId: 'getOpenAPISpec',
          tags: ['Meta'],
          responses: {
            '200': { description: 'OpenAPI 3.1 spec' },
          },
        },
      },
    },
    components: {
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            details: { type: 'object' },
          },
          required: ['error'],
        },
        RegisterAgentRequest: {
          type: 'object',
          required: ['name', 'scope'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            human_sub: { type: 'string', description: 'Required in dev mode (no human_id_token)' },
            human_email: { type: 'string', format: 'email', description: 'Required in dev mode' },
            human_iss: { type: 'string', format: 'uri', description: 'Required in dev mode' },
            scope: { type: 'array', items: { type: 'string' }, minItems: 1 },
            max_delegation_depth: { type: 'integer', minimum: 0, maximum: 10, default: 3 },
            can_delegate: { type: 'array', items: { type: 'string' }, default: [] },
            ttl_seconds: { type: 'integer', minimum: 60, maximum: 2592000, default: 3600 },
            metadata: { type: 'object', additionalProperties: true },
            human_id_token: { type: 'string', description: 'OIDC ID token for verified binding' },
          },
        },
        RegisterAgentResponse: {
          type: 'object',
          properties: {
            agent_id: { type: 'string' },
            token: { type: 'string' },
            scope: { type: 'array', items: { type: 'string' } },
            expires_at: { type: 'string', format: 'date-time' },
            identity_verified: { type: 'boolean' },
          },
        },
        DelegateRequest: {
          type: 'object',
          required: ['parent_token', 'child_name', 'requested_scope'],
          properties: {
            parent_token: { type: 'string' },
            child_name: { type: 'string', minLength: 1, maxLength: 255 },
            requested_scope: { type: 'array', items: { type: 'string' }, minItems: 1 },
            ttl_seconds: { type: 'integer', minimum: 60, maximum: 2592000, default: 3600 },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        VerifyRequest: {
          type: 'object',
          required: ['token', 'tool_name'],
          properties: {
            token: { type: 'string' },
            tool_name: { type: 'string' },
          },
        },
        AgentListResponse: {
          type: 'object',
          properties: {
            agents: { type: 'array', items: { $ref: '#/components/schemas/Agent' } },
            total: { type: 'integer' },
          },
        },
        Agent: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            human_sub: { type: 'string' },
            human_email: { type: 'string' },
            human_iss: { type: 'string' },
            scope: { type: 'array', items: { type: 'string' } },
            parent_id: { type: 'string', nullable: true },
            delegation_depth: { type: 'integer' },
            max_delegation_depth: { type: 'integer' },
            can_delegate: { type: 'array', items: { type: 'string' }, nullable: true },
            status: { type: 'string', enum: ['active', 'revoked', 'expired', 'stale', 'deprovisioned'] },
            created_at: { type: 'string', format: 'date-time' },
            expires_at: { type: 'string', format: 'date-time' },
            revoked_at: { type: 'string', format: 'date-time', nullable: true },
            last_seen_at: { type: 'string', format: 'date-time', nullable: true },
            deprovisioned_at: { type: 'string', format: 'date-time', nullable: true },
            metadata: { type: 'object', nullable: true },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            version: { type: 'string' },
            uptime_seconds: { type: 'number' },
          },
        },
        ReadyResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['ready', 'not_ready'] },
            checks: {
              type: 'object',
              properties: {
                database: { type: 'string', enum: ['ok', 'fail'] },
                signing_key: { type: 'string', enum: ['ok', 'fail'] },
              },
            },
          },
        },
      },
    },
  };
}
