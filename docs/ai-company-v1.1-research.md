# AI Company v1.1 Research Notes

Updated: 2026-09-17

## Why v1 needs redesign

The first real Qwen3-8B run exposed several problems that unit tests could not reveal:

- Role calls repeatedly received roughly 13k-15k prompt tokens.
- Prompt evaluation itself was relatively fast (roughly 10-15 seconds in the observed run), while generation fell to roughly 6-7 tokens/second at long context.
- Schema mistakes caused full expensive retries because LM Studio only received `{ "type": "object" }` rather than the actual response contract.
- The final Reviewer reached the loaded 16,384-token context limit: 14,864 prompt tokens + 1,520 completion tokens = 16,384, and LM Studio returned `finish_reason = "length"`.
- The client did not inspect `finish_reason`, so a context-limit truncation surfaced only as an invalid JSON parse.
- LM Studio was loaded with four parallel prediction slots although AI Company v1 executes sequentially. Logs also showed prompt-cache eviction and KV-cache pressure.
- The existing repository context builder selects only a bounded subset of files. That cannot satisfy the intended whole-repository audit use case.

## Research findings

### 1. Use the full JSON Schema

LM Studio Structured Output supports a real JSON Schema and uses grammar-based constrained generation for GGUF models. The current implementation only constrains the root to an object. v1.1 should pass the same types and required fields that the Node.js validator expects.

Reference: https://lmstudio.ai/docs/developer/openai-compat/structured-output

### 2. Thinking must be intentional

The original Qwen3 models think by default. Qwen documents `/no_think` as a per-turn soft switch and `enable_thinking=false` as the hard switch when the inference framework exposes it. Roles that mostly route, normalize, or summarize should not spend hundreds of generation tokens on reasoning by default.

References:
- https://github.com/QwenLM/Qwen3/blob/main/docs/source/getting_started/quickstart.md
- https://github.com/QwenLM/Qwen3/blob/main/docs/source/inference/transformers.md

Initial v1.1 policy:

- Director: non-thinking
- Researcher (local evidence pass): non-thinking by default
- Improvement Planner: non-thinking by default
- Auditor: thinking only for cross-file/complex validation; batch scan can be non-thinking
- Reviewer: thinking, but only over compact findings/proposals/evidence rather than raw repository content

### 3. Whole-repository coverage should be hierarchical, not one giant prompt

Research on repository-level local-LLM summarization uses hierarchical processing: analyze smaller code units, aggregate to file/package summaries, then reason at repository level. RepoAudit likewise addresses context-window and cost problems with targeted exploration, memory, and a validation stage. Long-context research also shows that simply adding more context can reduce reliable use of information in the middle.

References:
- Hierarchical Repository-Level Code Summarization for Business Applications Using Local LLMs (IEEE/ACM LLM4Code 2025), DOI 10.1109/LLM4Code66737.2025.00023
- RepoAudit: An Autonomous LLM-Agent for Repository-Level Code Auditing (ICML 2025), https://proceedings.mlr.press/v267/guo25n.html
- Lost in the Middle: How Language Models Use Long Contexts (TACL 2024), DOI 10.1162/tacl_a_00638

For this project, retrieval must not replace full coverage. The design should be:

1. Build a deterministic inventory of every auditable project file.
2. Split every readable text file into bounded line-preserving chunks.
3. Process every chunk exactly once in coverage batches.
4. Persist each completed batch immediately.
5. Maintain a coverage ledger so the final report cannot claim 100% unless all planned chunks succeeded.
6. Aggregate batch findings/summaries hierarchically.
7. Run cross-file validation over compact summaries plus targeted source excerpts.
8. Planner and Reviewer consume findings/evidence, not the entire repository again.

### 4. Checkpoint/resume is mandatory

A 30-60 minute local audit must never lose all useful work because the final call fails. Batch results should be committed to runtime-data after each successful model call. A resumed run should skip completed batches only when the target file fingerprints still match the saved plan.

### 5. Context budget must include output budget

Before every request:

`estimatedPromptTokens + reservedOutputTokens + safetyMargin <= loadedContextLength`

When this cannot be guaranteed, split or compact the request before calling the model. `finish_reason = "length"` must be treated as an explicit budget failure, not a generic JSON error.

### 6. LM Studio load configuration matters

LM Studio 0.4 uses Max Concurrent Predictions, default 4, with a unified KV cache. AI Company currently runs one model call at a time, so v1.1 should surface the loaded `context_length` and `parallel` values in `doctor` and warn when parallel > 1 for the sequential audit mode. We should benchmark parallel=1 with a larger context before changing it automatically.

References:
- https://lmstudio.ai/docs/app/advanced/parallel-requests
- https://lmstudio.ai/docs/developer/rest/list

### 7. Speculative decoding is a later benchmark, not a correctness fix

LM Studio supports speculative decoding with a smaller compatible draft model. This can improve generation throughput without changing the main model's accepted output, but it uses extra resources and can be slower when draft acceptance is poor. Add it only after the correctness/coverage redesign and benchmark it on representative audit prompts.

Reference: https://lmstudio.ai/docs/typescript/llm-prediction/speculative-decoding

## v1.1 acceptance targets

The next real run should not be considered improved merely because it finishes. It should report:

- auditable files discovered
- files/chunks completed
- excluded files with explicit reason categories
- coverage percentage
- prompt/completion/reasoning tokens per call when available
- finish reason per call
- duration per call and per batch
- retry count and retry reason
- checkpoint path and resume capability
- no silent context truncation
- no whole-run data loss when a late stage fails

The target repository remains read-only throughout.