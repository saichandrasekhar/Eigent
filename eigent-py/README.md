# eigent — Python SDK

Python SDK for the **Eigent** agent trust infrastructure. Provides a typed client for agent registration, delegation, verification, revocation, audit, and compliance reporting.

## Quick start

```bash
pip install eigent
```

```python
from eigent import EigentClient

client = EigentClient(registry_url="http://localhost:3456")

# Login (dev mode — unverified identity)
session = client.login(email="alice@acme.com", demo_mode=True)

# Register an agent
agent = client.register_agent(
    name="code-reviewer",
    scope=["read_file", "run_tests"],
    max_delegation_depth=2,
)

# Delegate to a child agent
child = client.delegate(
    parent_token=agent.token,
    child_name="test-runner",
    scope=["run_tests"],
)

# Verify a tool call
result = client.verify(token=child.token, tool="run_tests")
assert result.allowed

result = client.verify(token=child.token, tool="delete_file")
assert not result.allowed

# Revoke (cascade)
revoked = client.revoke(agent_id=agent.agent_id)
print(revoked.cascade_revoked)  # ["test-runner"]

# Audit log
events = client.audit(human="alice@acme.com", limit=20)

# Compliance report
report = client.compliance_report(framework="eu-ai-act", period="30d")
```

## Decorator for tool protection

```python
from eigent import eigent_protected

@eigent_protected(scope=["query_database"])
def my_tool(query: str) -> str:
    return db.execute(query)
```

Set `EIGENT_AGENT_TOKEN` in the environment and the decorator will verify
it against the registry before every call. Raises `EigentPermissionDenied`
if the token lacks the required scope.

## LangChain integration

```python
from langchain_core.tools import tool
from eigent import EigentClient

client = EigentClient()
session = client.login(email="alice@acme.com", demo_mode=True)
agent = client.register_agent(
    name="langchain-agent",
    scope=["search_web", "read_file"],
)

@tool
def search_web(query: str) -> str:
    """Search the web."""
    result = client.verify(token=agent.token, tool="search_web")
    if not result.allowed:
        return f"BLOCKED: {result.reason}"
    return do_search(query)
```

## CrewAI integration

```python
from crewai import Agent, Task, Crew
from eigent import EigentClient

client = EigentClient()
client.login(email="operator@acme.com", demo_mode=True)
agent_cred = client.register_agent(
    name="crewai-researcher",
    scope=["search_web", "summarize"],
    max_delegation_depth=1,
)

# Pass agent_cred.token to your CrewAI tools for verification
# before executing privileged operations.
```

## Risk classification (EU AI Act)

```python
agent = client.register_agent(
    name="medical-advisor",
    scope=["query_patient_records"],
    risk_level="high",  # Enforces stricter controls
)
```

## Development

```bash
pip install -e ".[dev]"
pytest
```
