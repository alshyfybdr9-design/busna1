/**
 * مزود نموذج الذكاء الاصطناعي — قابل للاستبدال خلف واجهة AiProvider.
 * المفتاح يُقرأ في الخادم فقط (ANTHROPIC_API_KEY) ولا يصل للواجهات أبدًا.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

export interface AiToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}
export interface AiToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface AiTurn {
  stop: 'end' | 'tool_use' | 'refusal' | 'max_tokens' | 'other';
  text: string;
  toolCalls: AiToolCall[];
  /** رسالة المساعد بصيغة المزود — تُخزّن وتُعاد كما هي في الطلبات التالية (إضافة فقط) */
  assistantMessage: unknown;
  usage: { input: number; output: number };
}
export interface AiProvider {
  name: string;
  configured: boolean;
  turn(input: { system: string; tools: AiToolDef[]; messages: unknown[] }): Promise<AiTurn>;
  userMessage(texts: string[]): unknown;
  toolResultsMessage(results: Array<{ id: string; content: string; isError?: boolean }>): unknown;
}

export class AiUnavailableError extends Error {}

class NoAiProvider implements AiProvider {
  name = 'none';
  configured = false;
  async turn(): Promise<AiTurn> {
    throw new AiUnavailableError('ai_not_configured');
  }
  userMessage(texts: string[]) {
    return { role: 'user', content: texts.map((t) => ({ type: 'text', text: t })) };
  }
  toolResultsMessage() {
    return { role: 'user', content: [] };
  }
}

class AnthropicProvider implements AiProvider {
  name = 'anthropic';
  configured = true;
  private client: Anthropic;
  constructor(private model: string, private effort: 'low' | 'medium' | 'high') {
    // يقرأ ANTHROPIC_API_KEY من بيئة الخادم
    this.client = new Anthropic({ timeout: 60_000, maxRetries: 2 });
  }

  async turn(input: { system: string; tools: AiToolDef[]; messages: unknown[] }): Promise<AiTurn> {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 8000,
        system: input.system,
        tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        messages: input.messages as Anthropic.Beta.BetaMessageParam[],
        output_config: { effort: this.effort },
        cache_control: { type: 'ephemeral' },
        // عند رفض مصنّف الأمان للطلب يعيد الخادم تشغيله على نموذج بديل مناسب تلقائيًا
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (e) {
      if (e instanceof Anthropic.APIError || e instanceof Anthropic.APIConnectionError) {
        throw new AiUnavailableError(`provider_error:${(e as any).status ?? 'connection'}`);
      }
      throw e;
    }
    const content = stripBeforeLastFallback(res.content);
    const text = content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    const toolCalls = content
      .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));
    const stop = res.stop_reason === 'end_turn' ? 'end'
      : res.stop_reason === 'tool_use' ? 'tool_use'
      : res.stop_reason === 'refusal' ? 'refusal'
      : res.stop_reason === 'max_tokens' ? 'max_tokens' : 'other';
    return {
      stop,
      text,
      toolCalls: stop === 'refusal' ? [] : toolCalls,
      assistantMessage: { role: 'assistant', content },
      usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
    };
  }

  userMessage(texts: string[]) {
    return { role: 'user', content: texts.map((t) => ({ type: 'text', text: t })) };
  }

  toolResultsMessage(results: Array<{ id: string; content: string; isError?: boolean }>) {
    return {
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
    };
  }
}

/** بعد انتقال إلى نموذج بديل أثناء الإخراج: تُحذف كتل التفكير/الأدوات السابقة لآخر كتلة fallback قبل إعادة الإرسال */
function stripBeforeLastFallback(content: Anthropic.Beta.BetaContentBlock[]) {
  const last = content.map((b) => b.type).lastIndexOf('fallback' as any);
  if (last < 0) return content;
  return content.filter((b, i) => i >= last || !['thinking', 'redacted_thinking', 'tool_use'].includes(b.type));
}

let provider: AiProvider | null = null;
export function aiProvider(): AiProvider {
  if (!provider) {
    const c = config();
    provider = c.AI_PROVIDER === 'anthropic' && process.env.ANTHROPIC_API_KEY
      ? new AnthropicProvider(c.AI_MODEL, c.AI_EFFORT)
      : new NoAiProvider();
  }
  return provider;
}

/** للاختبارات */
export function setAiProvider(p: AiProvider | null) {
  provider = p;
}
