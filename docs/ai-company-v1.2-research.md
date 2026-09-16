# AI Company v1.2 Research Notes

Updated: 2026-09-17
Status: Research / benchmark plan — do not treat unbenchmarked ideas as proven improvements

## Goal

Keep the original product requirement: every auditable text file must be read by the local audit system. The redesign must improve reliability and throughput without replacing full coverage with retrieval-only sampling.

The key distinction is:

- **Coverage pass:** every auditable text chunk is processed.
- **Cross-file validation pass:** relationships between files are analyzed after coverage, using deterministic dependency/symbol evidence plus targeted source excerpts.
- **Synthesis pass:** compact validated findings are converted into improvement proposals and reviewed.

This avoids both failure modes: giant-context review and retrieval-only review.

## Evidence from the real local runs

The current machine/model run already established several facts:

- Qwen3-8B can process the repository batches locally and checkpoint results.
- The first whole-company pipeline lost large amounts of work to schema failures and a final context-window truncation.
- The first coverage run reached 42.11% and preserved successful batches.
- Most failed coverage batches ended exactly at `completion_tokens = 1000`, showing that the immediate bottleneck was the configured output cap, not the 16,384-token model context.
- Batches with no findings can complete very quickly; finding-heavy batches dominate wall-clock time because decoding is the expensive phase.

The next design should therefore optimize **decoded output per unit of source coverage**, not merely reduce source input.

## Research finding 1 — Full coverage should stay segmented

Repository-level audit research does not support the idea that one giant context is inherently the best representation of a repository.

RepoAudit explicitly identifies context limits, hallucinations, and token cost as repository-level audit problems. Its design uses an agent memory plus a validator rather than relying on a single monolithic context. Its reported system explores code on demand and validates facts/path conditions before accepting bug reports.

AACR-Bench (2026) also reports that context granularity and retrieval choice materially affect automatic code-review performance, and that the effect depends on model/language/agent setup.

PRWeaver (2026), although focused on malicious PR review rather than whole-repository static auditing, shows another important warning: giving an auditor a larger whole-window context did not monotonically improve detection. In that benchmark, whole-window review under long interleaved histories performed worse than smaller review windows.

### Design consequence

Do **not** replace the coverage batches with one 32k/64k/128k prompt even if a model supports it.

Use:

1. exhaustive chunk coverage;
2. deterministic aggregation;
3. a separate cross-file graph pass;
4. targeted re-reading for validation.

References:

- RepoAudit: https://arxiv.org/abs/2501.18160
- AACR-Bench: https://arxiv.org/abs/2601.19494
- PRWeaver: https://arxiv.org/abs/2608.02693
- Hierarchical Repository-Level Code Summarization: https://arxiv.org/abs/2501.07857

## Research finding 2 — Decoding is the scarce resource

The real run shows that prompt ingestion is not the dominant cost for the current batches; long generated JSON is.

A coverage worker should therefore emit the smallest useful evidence record possible.

### Proposed internal record

Instead of verbose objects such as:

```json
{
  "severity": "high",
  "title": "Long explanation...",
  "explanation": "Long explanation...",
  "confidence": "high",
  "evidence": [{
    "file": "src/a.js",
    "lineStart": 10,
    "lineEnd": 14,
    "claim": "Long claim..."
  }]
}
```

benchmark a compact tuple/record representation such as:

```json
{
  "c": ["chunk-id"],
  "f": [
    ["H", "src/a.js", 10, 14, "unsafe unchecked input", "high"]
  ]
}
```

Node.js can deterministically expand the compact representation into the rich persisted schema after generation.

The LLM should spend tokens describing evidence, not repeatedly spelling JSON property names.

## Research finding 3 — Split source further before raising output limits

When a multi-chunk batch reaches the output cap, adaptive batch splitting is appropriate. The next edge case is a **single source chunk** that still produces too many findings.

The current fallback of raising the token limit is bounded, but the more scalable strategy is recursive source splitting:

```text
chunk L1-L300
  ↓ output cap
chunk L1-L150 + chunk L151-L300
  ↓
process both
```

This keeps output bounded and preserves full line coverage.

### Proposed rule

1. Multi-chunk output cap -> split batch by chunks.
2. Single-chunk output cap -> split that chunk by line range.
3. Only if the minimum line-range threshold is reached should output tokens be increased.
4. Persist the split tree in the checkpoint so resume is deterministic.

This is preferable to repeatedly increasing `max_tokens`, because generation speed is currently the expensive resource.

## Research finding 4 — Coverage and cross-file understanding must be separate

A chunk-only pass can read every line and still miss bugs whose evidence is distributed across files.

Examples:

- an exported function is safe alone but misused by callers;
- authorization is checked in one layer but bypassed on another route;
- environment/config defaults conflict with runtime assumptions;
- a value is validated before one code path but not another;
- frontend and backend disagree on an API contract.

### Proposed cross-file pipeline

After 100% coverage:

1. Build a deterministic repository relationship graph.
2. Extract imports/exports, dependency edges, configuration references, routes, entry points, tests, and obvious symbol references.
3. Form **relation groups** rather than arbitrary retrieval groups.
4. Give the validator only the compact finding plus the directly related source excerpts.
5. Confirm/reject/merge findings.

This preserves the requirement that every file was read while adding a second pass designed specifically for cross-file reasoning.

RepoAudit's memory/validator architecture is strong evidence for separating candidate discovery from validation rather than treating first-pass findings as final.

## Research finding 5 — Add deterministic/static evidence before asking the LLM

The model should not spend decoding tokens rediscovering facts that software can compute exactly.

A deterministic prepass can collect:

- file inventory and hashes;
- language/file type;
- import/export relationships;
- package dependencies;
- config keys and environment-variable names (not secret values);
- route declarations where safely parseable;
- test/source relationships;
- TODO/FIXME counts;
- duplicate dependency/config declarations;
- lint/type/test results when explicitly enabled in a safe read-only execution mode.

Agent Audit (2026) combines dataflow analysis, credential detection, structured configuration parsing, and privilege-risk checks and reports that hybrid analysis can detect agent-application security issues quickly. This is not a direct benchmark for our repository auditor, but it supports the principle that deterministic analysis should complement, not be replaced by, the LLM.

Reference: https://arxiv.org/abs/2603.22853

## Research finding 6 — Keep structured output, but simplify it

LM Studio supports JSON-Schema-constrained output. Its documentation warns that schema compliance is only guaranteed when generation completes; hitting `maxTokens` can leave incomplete output. It also notes that smaller models can become stuck in an unfinished structure under constrained generation.

Research on constrained decoding also shows that schema design and decoding framework matter. JSONSchemaBench evaluates efficiency and coverage across constrained-decoding implementations. A 2026 study on very small models reports a semantic “constraint tax”; that result is not directly transferable to Qwen3-8B, but it is enough reason to benchmark semantic accuracy separately from schema validity.

### Design consequence

- Keep constrained output for machine reliability.
- Make the coverage schema shallow and compact.
- Avoid repeated verbose nested objects in the hot path.
- Measure **valid JSON rate** and **correct finding rate** separately.

References:

- LM Studio Structured Output: https://lmstudio.ai/docs/developer/openai-compat/structured-output
- LM Studio Structured Response limitations: https://lmstudio.ai/docs/typescript/llm-prediction/structured-response
- JSONSchemaBench: https://arxiv.org/abs/2501.10868
- Constraint Tax: https://arxiv.org/abs/2605.26128

## Research finding 7 — Thinking should be reserved for validation

Qwen3 supports `/no_think` and `/think`; Qwen documentation explicitly describes non-thinking as useful when efficiency matters.

The coverage pass is primarily exhaustive extraction, so it should remain non-thinking unless benchmarks show a meaningful recall loss.

Recommended policy to benchmark:

- Coverage candidate extraction: **non-thinking**.
- Deterministic aggregation: no LLM.
- Cross-file validator: **thinking** for suspicious/complex candidates only.
- Planner: non-thinking first; thinking only for complex conflicting findings.
- Reviewer: thinking, but over compact validated evidence rather than raw repository chunks.

References:

- https://github.com/QwenLM/Qwen3/blob/main/docs/source/inference/transformers.md
- https://github.com/QwenLM/Qwen3/blob/main/docs/source/getting_started/quickstart.md

## Research finding 8 — LM Studio tuning needs controlled benchmarks

LM Studio documents that Max Concurrent Predictions defaults to 4 and is intended to improve throughput for concurrent workflows. The audit currently runs sequentially. Therefore `parallel=1` is a valid benchmark candidate, but should not be assumed faster without measurement.

llama.cpp also supports prompt/KV caching for repeated prefixes. Repeated coverage prompts share a large stable system/schema prefix, so prefix reuse may reduce time-to-first-token. This needs measurement through LM Studio rather than being assumed available/configured in exactly the same way as raw llama-server.

### Benchmark matrix

Test the same fixed batches with:

- parallel 4 vs 1;
- current context vs 32k context;
- prompt prefix kept byte-identical vs dynamically reordered prompt;
- flash attention current setting vs enabled if supported;
- same quantization/model in every other respect.

Measure:

- prompt tokens;
- prompt eval time / TTFT when available;
- completion tokens;
- tokens/sec;
- total latency;
- VRAM;
- failure rate.

References:

- LM Studio parallel requests: https://lmstudio.ai/docs/app/advanced/parallel-requests
- llama.cpp server prompt cache: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md

## Research finding 9 — Speculative decoding is especially relevant because output is the bottleneck

LM Studio supports speculative decoding with a smaller compatible draft model. Its documentation says it can increase generation speed without changing the accepted main-model output, but performance depends on draft speed and acceptance rate and can become worse with a poor pairing.

Because the real audit is decode-heavy, speculative decoding is now more relevant than it looked after the first run.

For Qwen3-8B, `Qwen3-1.7B` is an obvious same-family draft candidate to benchmark. The Qwen3-1.7B LM Studio model is roughly a 1–2B-class model and supports the same Qwen3 family behavior. Compatibility and VRAM fit still need an actual test; do not assume a speedup.

References:

- LM Studio speculative decoding: https://lmstudio.ai/docs/app/advanced/speculative-decoding
- Qwen3-1.7B in LM Studio: https://lmstudio.ai/models/qwen/qwen3-1.7b

## Research finding 10 — The model itself should be benchmarked, not assumed fixed

The current Qwen3-8B is a first-generation Qwen3 model. LM Studio now lists newer small local candidates.

### Candidate A — Qwen3.5-9B

LM Studio lists Qwen3.5-9B at about 7 GB minimum system memory and a native 262k context. Qwen describes Qwen3.5 as improved across coding and agent workloads. It is a plausible successor candidate on this machine, but its practical VRAM use, speed, and audit accuracy on the RTX 4060 must be measured.

### Candidate B — Granite 4.1 8B

LM Studio lists Granite 4.1 8B at about 5.3 GB model size, with improved tool use, instruction following, and coding relative to Granite 4.0. It is a useful comparison for structured extraction/tool-oriented work.

### Candidate C — Ministral 3 8B

LM Studio lists Ministral 3 8B with native function calling and JSON output generation. It is another useful structured-output baseline.

Do not choose a new default based on catalog claims alone. Run the same repository/batches through all candidates.

References:

- Qwen3.5-9B: https://lmstudio.ai/models/qwen/qwen3.5-9b
- Qwen3.5 announcement: https://qwen.ai/blog?id=qwen3.5
- Granite 4.1 8B: https://lmstudio.ai/models/ibm/granite-4.1-8b
- Ministral 3 8B: https://lmstudio.ai/models/mistralai/ministral-3-8b

## Proposed v1.2 architecture

```text
Repository
   |
   v
Deterministic inventory + hashes
   |
   v
Static relationship extraction
   |
   v
100% source coverage
  - compact schema
  - non-thinking
  - adaptive batch split
  - adaptive line split
  - checkpoint every completed unit
   |
   v
Candidate Finding Store
   |
   v
Cross-file relationship groups
   |
   v
Validator
  - targeted source excerpts
  - thinking only when useful
  - confirm / reject / merge
   |
   v
Validated Finding Store
   |
   +--> Planner
   |
   +--> Reviewer
   |
   v
Final report + coverage ledger + performance metrics
```

Retrieval/RAG may be used in the validation phase to locate related evidence, but it must never replace the exhaustive coverage phase.

## Proposed performance controls

### Output budget control

- compact tuple schema in coverage hot path;
- no prose explanation beyond a short evidence claim;
- recursive batch split on output cap;
- recursive line-range split on single-chunk output cap;
- deterministic duplicate merging after each batch.

### Validation budget control

Only candidates that survive deterministic sanity checks should receive expensive cross-file reasoning.

Examples of cheap rejection/merge checks:

- evidence line outside supplied range -> reject;
- missing file -> reject;
- exact duplicate `(file, line, category)` -> merge;
- conflicting severity only -> keep one candidate and send to validator;
- finding references an identifier not present in evidence -> mark for validator rather than immediately finalizing.

## Benchmark plan before v1.2 implementation is declared successful

Use the same frozen repository snapshot and goal.

### Models

1. Qwen3-8B baseline.
2. Qwen3.5-9B.
3. Granite 4.1 8B or Ministral 3 8B.

### Runtime variants

1. parallel=4 baseline.
2. parallel=1.
3. speculative decoding candidate where compatible.

### Pipeline variants

1. current coverage implementation.
2. compact-output coverage.
3. compact-output + recursive line split.
4. full v1.2 with cross-file validator.

### Metrics

Correctness:

- auditable-file coverage;
- chunk/line coverage;
- confirmed true findings;
- false positives;
- duplicate findings;
- cross-file findings;
- evidence-line accuracy;
- reviewer reversals.

Reliability:

- structured-output failures;
- output-limit events;
- context-limit events;
- retries;
- checkpoint/resume success;
- complete-run success rate.

Performance:

- total wall time;
- prompt tokens;
- completion tokens;
- generated tokens per confirmed finding;
- tokens/sec;
- time per 1,000 source lines;
- VRAM/RAM peak where available.

## Acceptance criteria for the next major redesign

Do not call v1.2 better merely because it reaches 100% coverage.

A successful redesign should satisfy all of the following on the fixed benchmark repository:

- 100% of auditable source chunks are processed;
- no completed batch is lost after a later failure;
- no unchanged request is blindly retried after a known output-cap failure;
- single-chunk overflow can be subdivided without dropping lines;
- candidate findings are validated against actual source evidence;
- cross-file relationships receive a dedicated validation pass;
- schema validity and semantic correctness are measured separately;
- total completion-token usage is materially lower than the verbose baseline for comparable coverage;
- performance differences between model/runtime variants are measured rather than assumed.

## What not to do next

- Do not solve the problem by simply increasing every `max_tokens` value.
- Do not solve it by putting the entire repository into a larger context window.
- Do not replace full coverage with embedding retrieval.
- Do not add more LLM roles just to make the system look more agentic.
- Do not switch to a larger model before measuring the current decode/output bottleneck.
- Do not trust `100% coverage` as equivalent to `100% issue detection`.

The next implementation should be driven by this benchmark plan and the persisted real-run logs.