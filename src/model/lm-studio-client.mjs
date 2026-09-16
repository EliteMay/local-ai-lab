function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function serverRootFromBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}`;
}

function createLengthError(result, requestedMaxTokens) {
  const promptTokens = result.usage?.prompt_tokens;
  const completionTokens = result.usage?.completion_tokens;
  const hasUsage = Number.isInteger(promptTokens) && Number.isInteger(completionTokens);
  const total = hasUsage ? promptTokens + completionTokens : null;
  const hitOutputCap = Number.isInteger(requestedMaxTokens)
    && requestedMaxTokens > 0
    && Number.isInteger(completionTokens)
    && completionTokens >= requestedMaxTokens;

  const details = hasUsage
    ? ` (prompt=${promptTokens}, completion=${completionTokens}, total=${total})`
    : "";
  const error = new Error(hitOutputCap
    ? `LM Studio reached max output tokens before structured JSON completed (max_tokens=${requestedMaxTokens})${details}`
    : `LM Studio stopped at the context limit before structured JSON completed${details}`);
  error.code = hitOutputCap ? "OUTPUT_TOKEN_LIMIT" : "CONTEXT_LIMIT";
  error.promptTokens = promptTokens ?? null;
  error.completionTokens = completionTokens ?? null;
  error.totalTokens = total;
  error.maxTokens = requestedMaxTokens ?? null;
  return error;
}

export class LMStudioClient {
  constructor({ baseUrl, model, timeoutMs = 600000, maxTokens = 2048, temperature = 0.2 }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.serverRoot = serverRootFromBaseUrl(this.baseUrl);
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }

  async #requestUrl(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(options.headers ?? {})
        }
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LM Studio request failed (${response.status}): ${body.slice(0, 500)}`);
      }
      return await response.json();
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`LM Studio request timed out after ${Math.round(this.timeoutMs / 1000)} seconds`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(path, options = {}) {
    return this.#requestUrl(`${this.baseUrl}${path}`, options);
  }

  async listModels() {
    const data = await this.#request("/models", { method: "GET", headers: {} });
    return data.data ?? [];
  }

  async listModelDetails() {
    const data = await this.#requestUrl(`${this.serverRoot}/api/v1/models`, { method: "GET", headers: {} });
    return data.models ?? [];
  }

  async chatDetailed({
    system,
    user,
    temperature = this.temperature,
    maxTokens = this.maxTokens,
    json = false,
    jsonSchema = null
  }) {
    const payload = {
      model: this.model,
      temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    };

    if (Number.isInteger(maxTokens) && maxTokens > 0) {
      payload.max_tokens = maxTokens;
    }

    if (json) {
      payload.response_format = {
        type: "json_schema",
        json_schema: {
          name: "structured_response",
          schema: jsonSchema ?? { type: "object" }
        }
      };
    }

    const data = await this.#request("/chat/completions", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      throw new Error("LM Studio returned no assistant content");
    }

    return {
      content,
      finishReason: choice?.finish_reason ?? null,
      usage: data.usage ?? null,
      stats: data.stats ?? null,
      reasoning: choice?.message?.reasoning_content ?? choice?.message?.reasoning ?? null
    };
  }

  async chat(input) {
    const result = await this.chatDetailed(input);
    return result.content;
  }

  async chatJsonDetailed(input) {
    const requestedMaxTokens = Number.isInteger(input.maxTokens) && input.maxTokens > 0
      ? input.maxTokens
      : this.maxTokens;
    const result = await this.chatDetailed({ ...input, json: true });

    if (result.finishReason === "length") {
      throw createLengthError(result, requestedMaxTokens);
    }

    try {
      return {
        value: JSON.parse(stripCodeFence(result.content)),
        meta: {
          finishReason: result.finishReason,
          usage: result.usage,
          stats: result.stats,
          reasoningTokens: result.usage?.completion_tokens_details?.reasoning_tokens ?? null
        }
      };
    } catch (error) {
      throw new Error(`Model output is not valid JSON: ${error.message}`);
    }
  }

  async chatJson(input) {
    const result = await this.chatJsonDetailed(input);
    return result.value;
  }
}
