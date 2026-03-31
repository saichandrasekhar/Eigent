# Contributing to the MCP Semantic Conventions Proposal

Thank you for your interest in contributing to the OpenTelemetry semantic
conventions for the Model Context Protocol (MCP). This document explains how
to participate in the development of this proposal and how it will be submitted
to the OpenTelemetry project.

## Proposal Status

This proposal is currently in **draft** stage. It has not yet been submitted to
the OpenTelemetry specification repository. The submission process is outlined
below.

## How to Contribute

### Feedback and Discussion

1. **Open an issue** in this repository describing the feedback, question, or
   suggestion. Use a descriptive title that references the affected file (e.g.,
   "mcp-spans: clarify span kind for sampling/createMessage").

2. **Join the discussion** in the
   [CNCF Slack](https://cloud-native.slack.com/) channel `#otel-semconv` where
   semantic convention proposals are discussed.

3. **Attend SIG meetings** -- the OpenTelemetry Semantic Conventions SIG meets
   regularly. Meeting times and agenda are posted in the
   [community repository](https://github.com/open-telemetry/community#semantic-conventions-sig).

### Making Changes

1. Fork this repository.
2. Create a feature branch from `main`.
3. Make your changes following the style guidelines below.
4. Open a pull request with a clear description of what changed and why.

### Style Guidelines

- Follow the [OpenTelemetry Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/)
  formatting and structure exactly.
- Attribute definitions MUST use the YAML schema format defined by the
  [semconv build tools](https://github.com/open-telemetry/build-tools/tree/main/semantic-conventions).
- Use present tense and imperative mood in requirement statements (e.g.,
  "The attribute MUST be set" not "The attribute should be set").
- RFC 2119 keywords (`MUST`, `SHOULD`, `MAY`, `MUST NOT`, `SHOULD NOT`)
  carry their standard meaning and MUST be rendered in uppercase.
- All examples MUST be realistic and self-consistent (valid attribute values,
  plausible timestamps, correct types).

## Submission Process

### Step 1: OTEP (OpenTelemetry Enhancement Proposal)

Before semantic conventions can be merged into the specification, an OTEP is
required for significant new convention areas. The process:

1. Draft an OTEP following the
   [OTEP template](https://github.com/open-telemetry/oteps/blob/main/0000-template.md).
2. Open a pull request against the
   [oteps repository](https://github.com/open-telemetry/oteps).
3. The OTEP will be reviewed by specification approvers and discussed in SIG
   meetings.
4. Once the OTEP is approved and merged, proceed to Step 2.

The OTEP for this proposal should cover:

- **Motivation**: Why MCP needs dedicated semantic conventions (as described in
  the README).
- **Scope**: The operations, attributes, and metrics covered.
- **Design decisions**: Why certain attributes are required vs. recommended,
  the span name format rationale, and the relationship to existing RPC and
  GenAI conventions.
- **Alternatives considered**: Alternative namespace structures, attribute
  groupings, and metric designs that were evaluated.

### Step 2: Semantic Convention PR

After OTEP approval:

1. Open a pull request against the
   [semantic-conventions repository](https://github.com/open-telemetry/semantic-conventions).
2. Place files under `docs/mcp/` in that repository.
3. Add YAML attribute definitions to `model/` following the existing directory
   structure.
4. Update the `mkdocs.yml` navigation to include the new pages.
5. Ensure the build tools generate the attribute tables correctly by running
   `make table-generation`.

### Step 3: Review and Approval

The PR will go through the standard OpenTelemetry review process:

- At least two approvers from the Semantic Conventions SIG must approve.
- A minimum review period of one week is required.
- The proposal must address all review feedback before merge.
- Once merged, the conventions enter `Experimental` status.

### Step 4: Stabilization

After implementation experience is gathered from at least two independent
instrumentation libraries:

1. Open a stabilization PR to move the conventions from `Experimental` to
   `Stable`.
2. Provide evidence of real-world usage and any necessary adjustments.
3. The stabilization PR follows the same review process as Step 3.

## Versioning and Stability

- All attributes and metrics in this proposal start at **Experimental**
  stability.
- Experimental conventions MAY change in breaking ways between minor versions.
- Once promoted to **Stable**, conventions follow
  [OpenTelemetry's stability guarantees](https://opentelemetry.io/docs/specs/otel/document-status/).

## Code of Conduct

This project follows the
[CNCF Code of Conduct](https://github.com/cncf/foundation/blob/main/code-of-conduct.md).

## License

By contributing to this proposal, you agree that your contributions will be
licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
