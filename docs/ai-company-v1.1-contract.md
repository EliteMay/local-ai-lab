# AI Company v1.1 — Whole Repository Audit Contract

Updated: 2026-09-17

This document refines `REQUIREMENTS.md` after the first real local Qwen3-8B audit run. It does not relax the v1 read-only/security boundaries.

## Primary purpose

The preferred audit mode must be able to inspect **every auditable project text chunk**, not only a relevance-selected subset.

`100% coverage` means:

- every file admitted to the auditable inventory was split into line-addressable chunks;
- every planned chunk has a successful Coverage Auditor result;
- no planned chunk is silently omitted or truncated;
- excluded files are separately reported with a deterministic reason.

It does **not** mean feeding secrets, binary files, generated dependency trees, build output, or other explicitly excluded data to the model.

## Read-only boundary

The target repository remains read-only.

Allowed target operations:

- deterministic file inventory;
- regular text file read;
- chunking and hashing;
- local text search/read for evidence;
- read-only metadata inspection.

Forbidden target operations remain:

- create/update/delete target files;
- git commit/push;
- branch mutation;
- arbitrary mutating shell commands.

Runtime evidence may be written only under `runtime-data/runs` owned by Local AI Lab.

## Coverage pipeline

```text
Repository
  ↓
Deterministic inventory
  ↓
Readability / security classification
  ↓
Line-preserving chunks for every auditable text file
  ↓
Bounded batches
  ↓
Coverage Auditor processes every batch
  ↓
Checkpoint after each successful batch
  ↓
Coverage Ledger
  ↓
Evidence-backed findings
  ↓
Improvement Planner
  ↓
Reviewer
```

The Director/Task Broker experimental mode may remain for multi-agent research, but it must not be the only path for whole-repository auditing.

## Exclusions

Exclusion must be explicit and visible in the coverage plan. Initial reason categories include:

- generated/excluded directory by configuration;
- sensitive credential/environment file;
- binary file;
- oversized file above the current safety read limit;
- unreadable/unsupported regular file.

If repository inventory exceeds the configured file count, the run must stop rather than claim complete coverage.

## Checkpoint / Resume

Long local audits must preserve completed work.

After every batch:

- batch result is persisted;
- coverage state is persisted;
- findings discovered so far remain recoverable.

Resume is allowed only when the target file fingerprints used by the saved coverage plan still match the current repository. Completed batches may then be skipped.

A late Planner/Reviewer failure must not erase completed coverage results.

## Structured output

LM Studio must receive the concrete JSON Schema expected for the current response, not merely `{ "type": "object" }`.

The client must distinguish at least:

- valid completion;
- schema/validation failure;
- request timeout;
- context/output limit (`finish_reason = "length"`).

No context/output truncation may be silently reported as a generic malformed-JSON error.

## Context and reasoning policy

The system must reserve enough context for the intended output before calling the model. Whole-repository coverage is achieved through bounded batches, not a single giant prompt.

Initial reasoning policy:

- Coverage batch: non-thinking by default;
- Director: non-thinking by default;
- Researcher local evidence pass: non-thinking by default;
- Improvement Planner: non-thinking by default;
- Reviewer: thinking is allowed over compact findings/proposals/evidence;
- complex cross-file Auditor passes may use thinking when the benefit is measured.

## Evidence requirements

Each confirmed batch finding must include source location evidence:

- file path;
- line start;
- line end;
- concrete claim;
- confidence/severity fields where applicable.

The model must not claim to have inspected chunks that were not supplied. The runtime verifies that `inspectedChunks` exactly matches the batch plan.

## Performance measurements

Each real run should preserve or surface, when available:

- prompt tokens;
- completion tokens;
- reasoning tokens;
- finish reason;
- duration;
- retry reason/count;
- batch count and progress;
- coverage percentage;
- failed/excluded files or chunks.

Performance improvements must not reduce whole-repository coverage without explicitly changing the requirement.

## Completion criteria for v1.1 audit mode

A v1.1 whole-repository audit is considered complete only when:

1. repository inventory did not hit a hidden limit;
2. every auditable file has a fingerprint and chunk plan;
3. every planned chunk completed successfully;
4. coverage ledger reports 100%;
5. no structured output was silently truncated;
6. all completed batch results were checkpointed;
7. target repository remained read-only;
8. findings remain available even if final synthesis fails;
9. final Planner/Reviewer result is produced, or synthesis failure is explicitly recorded without losing coverage evidence.
