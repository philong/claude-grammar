// Any OpenAI-compatible chat completions endpoint (llama.cpp, LM Studio, Ollama, vLLM, OpenRouter, OpenAI, a gateway)
// in place of Claude's models, when the `endpoint` setting names one. Answers in the shape of $.model.complete, so the
// callers stay as they are.
import type { EngineInterface } from 'claude-code'

export type EndpointRequest = { system: string; prompt: string; maxTokens: number; timeoutMs: number }
export type EndpointAnswer = { isAnswered: true; text: string } | { isAnswered: false; reason: string }

/** The chat completions URL: `http://localhost:9931`, `https://openrouter.ai/api/v1` and the full path all work. */
export const chatUrl = (endpoint: string) => {
  const base = endpoint.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(base)) {
    return base
  }
  return /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

/** `https://host:port`, without the path or any user:password in it: what the help and errors name. */
export const hostOf = (endpoint: string) => {
  try {
    const u = new URL(endpoint)
    return `${u.protocol}//${u.host}`
  } catch {
    return endpoint
  }
}

/**
 * What a server turned down, and how the request does without it:
 * - `thinking`: llama.cpp's `chat_template_kwargs` to turn thinking off (a thinking model spends minutes and its whole
 *   token budget on one short prompt); OpenAI refuses fields it does not know.
 * - `temperature`: reasoning models (OpenAI's o and gpt-5 series) take only their default.
 * - `maxTokens`: those want `max_completion_tokens` instead of `max_tokens`.
 */
export type Quirks = { thinking: boolean; temperature: boolean; maxTokens: boolean }
export const NO_QUIRKS: Quirks = { thinking: false, temperature: false, maxTokens: false }

/** The request body, as the endpoint's quirks so far allow. */
export const chatBody = (model: string, r: EndpointRequest, q: Quirks = NO_QUIRKS) =>
  JSON.stringify({
    ...(model === '' ? {} : { model }),
    ...(q.maxTokens ? { max_completion_tokens: r.maxTokens } : { max_tokens: r.maxTokens }),
    ...(q.temperature ? {} : { temperature: 0 }),
    ...(q.thinking ? {} : { chat_template_kwargs: { enable_thinking: false } }),
    stream: false,
    messages: [
      { role: 'system', content: r.system },
      { role: 'user', content: r.prompt },
    ],
  })

/** The quirks with the one a 400's error names added, or undefined when it names none not already handled. */
export const quirkOf = (q: Quirks, error: string): Quirks | undefined => {
  const e = error.toLowerCase()
  if (!q.thinking && e.includes('chat_template_kwargs')) {
    return { ...q, thinking: true }
  }
  if (!q.maxTokens && e.includes('max_tokens')) {
    return { ...q, maxTokens: true }
  }
  if (!q.temperature && e.includes('temperature')) {
    return { ...q, temperature: true }
  }
  return undefined
}

type Parsed = EndpointAnswer & { status: number; error?: string }

/** The reply's text, or why there is none. */
export const chatAnswer = (status: number, text: string): Parsed => {
  let j: { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]; error?: unknown }
  try {
    j = JSON.parse(text) as typeof j
  } catch {
    return { status, isAnswered: false, reason: `endpoint: HTTP ${status}, not JSON: ${text.slice(0, 120)}` }
  }
  const err = j.error as { message?: unknown } | string | undefined
  if (status < 200 || status >= 300 || err !== undefined) {
    const why = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : text.slice(0, 160)
    return { status, isAnswered: false, reason: `endpoint: HTTP ${status}: ${why}`, error: why }
  }
  const choice = j.choices?.[0]
  const content = choice?.message?.content
  if (typeof content !== 'string' || content.trim() === '') {
    const cut = choice?.finish_reason === 'length' ? ' (cut off at max tokens)' : ''
    return { status, isAnswered: false, reason: `endpoint: empty answer${cut}` }
  }
  return { status, isAnswered: true, text: content }
}

// What each endpoint turned down this session, so only its first call pays for the retries.
const quirks = new Map<string, Quirks>()

/** One call to the endpoint, retried without what a 400 says it does not take; never rejects. The key stays out of every message. */
export async function endpointComplete($: EngineInterface, endpoint: string, model: string, key: string, r: EndpointRequest): Promise<EndpointAnswer> {
  const url = chatUrl(endpoint)
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(key === '' ? {} : { authorization: `Bearer ${key}` }) }
  const hide = (s: string) => (key === '' ? s : s.split(key).join('***'))
  const once = (q: Quirks) =>
    $.http
      .fetch(url, { method: 'POST', headers, body: chatBody(model, r, q) })
      .then(res => chatAnswer(res.status, res.text))
      .catch((err: unknown): Parsed => ({ status: 0, isAnswered: false, reason: `endpoint ${hostOf(endpoint)}: ${err instanceof Error ? err.message : String(err)}` }))
  const call = (async (): Promise<EndpointAnswer> => {
    let q = quirks.get(url) ?? NO_QUIRKS
    for (let attempt = 0; attempt < 4; attempt++) {
      const a = await once(q)
      const next = !a.isAnswered && a.status === 400 && a.error !== undefined ? quirkOf(q, a.error) : undefined
      if (next === undefined) {
        return a.isAnswered ? { isAnswered: true, text: a.text } : { isAnswered: false, reason: hide(a.reason) }
      }
      q = next
      quirks.set(url, q)
    }
    return { isAnswered: false, reason: 'endpoint: refused every form of the request' }
  })()
  const late = $.clock
    .sleep(r.timeoutMs)
    .then((): EndpointAnswer => ({ isAnswered: false, reason: `endpoint ${hostOf(endpoint)}: no answer in ${Math.round(r.timeoutMs / 1000)} s` }))
  return Promise.race([call, late])
}
