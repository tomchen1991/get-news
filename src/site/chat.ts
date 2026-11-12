import type { AiBinding } from './jev';
import { modelDiagnostic } from './diagnostics';
import { unwrapAiResponse } from './ai-response';

/** OpenAI chat-completions shaped input via the same Gateway binding.
 * Shared transport for bounded daily digest generation and future explicit uses.
 * Accepts provider/model and @cf/author/model IDs with compatible chat schemas.
 * The selected Workers AI DeepSeek Flash schema is checked before configuration.
 */
export function createGatewayChat(ai: AiBinding, gatewayId: string, model: string, maxTokens = 1200) {
  if (!ai || typeof ai.run !== 'function' || !/^[a-zA-Z0-9_-]{1,64}$/.test(gatewayId) || !/^(?:@cf\/[a-zA-Z0-9_-]+|[a-zA-Z0-9_-]+)\/[^\s]{1,180}$/.test(model)) throw new Error('Invalid chat configuration');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new Error('Invalid output limit');
  return { async complete(system: string, data: unknown): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const content = JSON.stringify(data);
      if (!system.trim() || system.length > 12000 || !content || content.length > 48000) throw new Error();
      const limits = model === '@cf/deepseek-ai/deepseek-v4.1-flash-1017'
        ? { max_completion_tokens: maxTokens, reasoning_effort: 'none', response_format: { type: 'json_object' } }
        : { max_tokens: maxTokens };
      const raw = await Promise.race([
        ai.run(model, { messages: [{ role: 'system', content: system }, { role: 'user', content }], stream: false, temperature: 0, ...limits }, { gateway: { id: gatewayId, skipCache: true, collectLog: true } }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Chat timeout')), 30000); }),
      ]);
      if (!raw || typeof raw !== 'object' || JSON.stringify(raw).length > 65536) throw new Error('Missing or oversized chat response');
      const result = unwrapAiResponse(raw);
      const choices = (result as { choices?: unknown })?.choices;
      if (!Array.isArray(choices) || choices.length !== 1) throw new Error('Expected one chat completion choice');
      const choice = choices[0], message = choice?.message;
      if (choice?.finish_reason !== 'stop') throw new Error('Chat did not finish normally (possibly truncated or tool request)');
      if (message?.role !== 'assistant' || message.refusal || (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) || message.function_call || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 24000) throw new Error('Invalid assistant text or disallowed action in chat response');
      return message.content;
    } catch (error) {
      const diagnostic = modelDiagnostic(error);
      console.error('gateway_chat_failed', JSON.stringify(diagnostic));
      throw new Error(`Gateway chat failed: ${diagnostic.message}`, { cause: diagnostic });
    }
    finally { clearTimeout(timer); }
  } };
}
