import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

/**
 * Shared engine for the Busna assistants.
 *
 * Safety model:
 * - Every tool runs with the SIGNED-IN USER's Supabase session, so Postgres
 *   RLS + RPC checks decide what data is reachable. The model can never see
 *   another school's or another family's data, whatever it asks for.
 * - Tools return real system data only; the system prompt forbids inventing
 *   locations, times or attendance.
 * - Tools that change data either act on the user's own records (a parent's
 *   own request) or only create a *proposal* that an admin must approve.
 */

export interface AssistantTool {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema;
  run: (input: Record<string, unknown>) => Promise<unknown>;
}

export const ChatBody = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(2000) })).min(1).max(12),
  context: z.record(z.string(), z.string().nullable().optional()).optional(),
});

const MODEL = "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_RESULT_CHARS = 24_000;

let client: Anthropic | null = null;
export function assistantAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function toolResult(value: unknown): string {
  const s = JSON.stringify(value ?? null);
  return s.length > MAX_TOOL_RESULT_CHARS ? s.slice(0, MAX_TOOL_RESULT_CHARS) + "…(تم اقتطاع النتيجة)" : s;
}

export async function runAssistant(opts: {
  system: string;
  tools: AssistantTool[];
  messages: { role: "user" | "assistant"; content: string }[];
}): Promise<string> {
  client ??= new Anthropic();
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const tools = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
    strict: true,
  }));
  const messages: Anthropic.Beta.BetaMessageParam[] = opts.messages.map((m) => ({ role: m.role, content: m.content }));

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // Chat-style Q&A over tool data: low effort keeps answers fast.
      output_config: { effort: "low" },
      // On a safety decline, the API re-runs the request on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: opts.system,
      tools,
      messages,
    });

    if (response.stop_reason === "refusal") {
      return "عذرًا، لا أستطيع المساعدة في هذا الطلب. يمكنك التواصل مع إدارة المدرسة مباشرة.";
    }
    if (response.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: response.content });
      continue;
    }

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return text || "لم أتمكن من تكوين رد. حاول صياغة السؤال بطريقة أخرى.";
    }

    // Keep the assistant turn unchanged (including thinking blocks).
    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (tu) => {
        const tool = byName.get(tu.name);
        if (!tool) return { type: "tool_result" as const, tool_use_id: tu.id, is_error: true, content: "أداة غير معروفة" };
        try {
          return { type: "tool_result" as const, tool_use_id: tu.id, content: toolResult(await tool.run(tu.input as Record<string, unknown>)) };
        } catch (err) {
          const e = err as { hint?: string; message?: string };
          return { type: "tool_result" as const, tool_use_id: tu.id, is_error: true, content: e.hint || e.message || "تعذّر تنفيذ الأداة" };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return "استغرق البحث وقتًا أطول من المتوقع. حاول سؤالًا أكثر تحديدًا.";
}

export function assistantErrorMessage(err: unknown): { status: number; error: string } {
  if (err instanceof Anthropic.RateLimitError) return { status: 429, error: "المساعد مشغول حاليًا، حاول بعد دقيقة." };
  if (err instanceof Anthropic.AuthenticationError) return { status: 503, error: "المساعد غير مهيأ بشكل صحيح. تواصل مع الدعم." };
  if (err instanceof Anthropic.APIConnectionError) return { status: 503, error: "تعذّر الوصول لخدمة المساعد، حاول لاحقًا." };
  if (err instanceof Anthropic.APIError) return { status: 502, error: "حدث خطأ في خدمة المساعد، حاول مرة أخرى." };
  return { status: 500, error: "حدث خطأ غير متوقع." };
}

/** Helper for JSON-schema objects used with strict tools. */
export function obj(properties: Record<string, unknown>, required: string[] = Object.keys(properties)): Anthropic.Tool.InputSchema {
  return { type: "object", properties, required, additionalProperties: false } as Anthropic.Tool.InputSchema;
}
