import { AgentContext } from './types.js';

/**
 * The reasoning core is provider-agnostic. Pass `null` to the agent to run purely on the
 * deterministic fallback (zero API key, never breaks). Pass an LlmClient to let a model
 * reason over the context.
 */
export interface LlmClient {
  readonly name: string;
  /** Returns the raw JSON object the model produced. Untrusted — validated downstream. */
  reason(systemPrompt: string, context: AgentContext): Promise<Record<string, unknown>>;
}

function stripFences(text: string): string {
  return text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

export class GithubModelsLlm implements LlmClient {
  readonly name = 'github_models';
  constructor(
    private readonly apiKey: string,
    private readonly model: string = process.env.GITHUB_MODEL ?? 'gpt-4o',
  ) {}

  async reason(systemPrompt: string, context: AgentContext): Promise<Record<string, unknown>> {
    const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(context, null, 2) }
        ],
      }),
    });
    if (!res.ok) throw new Error(`github models HTTP ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? '';
    return JSON.parse(stripFences(text)) as Record<string, unknown>;
  }
}
