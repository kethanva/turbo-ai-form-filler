export const ALLOWED_FETCH_HOSTS = new Set([
  'api.groq.com',
  'router.huggingface.co',
]);

export const MAX_LLM_MAX_TOKENS = 2048;
export const MAX_LLM_MESSAGE_CHARS = 20_000;
export const MAX_LLM_MESSAGES = 4;

export function isAllowedProviderUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string' || !rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_FETCH_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

export type SanitizedLlmBody = {
  model: string;
  messages: { role: string; content: string }[];
  max_tokens: number;
  temperature: number;
};

/**
 * Content scripts choose the prompt text; background chooses model, token
 * cap, and shape. Unknown keys are dropped so a hostile page's content
 * world cannot inflate cost via max_tokens / extra fields.
 */
export function sanitizeLlmRequestBody(
  body: unknown,
  allowedModel: string
): SanitizedLlmBody | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  const model = (allowedModel || '').trim();
  if (!model) return null;

  const rawMessages = Array.isArray(raw.messages) ? raw.messages : [];
  const messages: { role: string; content: string }[] = [];
  for (const item of rawMessages.slice(0, MAX_LLM_MESSAGES)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const role = rec.role === 'system' || rec.role === 'assistant' ? rec.role : 'user';
    const content = String(rec.content ?? '').slice(0, MAX_LLM_MESSAGE_CHARS);
    if (!content) continue;
    messages.push({ role, content });
  }
  if (messages.length === 0) return null;

  const requested = Number(raw.max_tokens);
  const max_tokens = Number.isFinite(requested)
    ? Math.min(Math.max(1, Math.floor(requested)), MAX_LLM_MAX_TOKENS)
    : 1024;

  return {
    model,
    messages,
    max_tokens,
    temperature: 0.1,
  };
}
