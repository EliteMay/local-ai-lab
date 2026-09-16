function stripCodeFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

export class LMStudioClient {
  constructor({ baseUrl, model, timeoutMs = 600000, maxTokens = 2048, temperature = 0.2 }) {
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
  }

  async #request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
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

  async listModels() {
    const data = await this.#request("/models", { method: "GET", headers: {} });
    return data.data ?? [];
  }

  async chat({
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

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("LM Studio returned no assistant content");
    }
    return content;
  }

  async chatJson(input) {
    const content = await this.chat({ ...input, json: true });
    try {
      return JSON.parse(stripCodeFence(content));
    } catch (error) {
      throw new Error(`Model output is not valid JSON: ${error.message}`);
    }
  }
}
