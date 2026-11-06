"use client";
import { useEffect, useRef, useState } from "react";
import { Bot, Send, Sparkles } from "lucide-react";
import { cn } from "./ui/cn";

export interface ChatMessage { role: "user" | "assistant"; content: string }

/** Generic Arabic chat UI for the Busna assistants (parent & school). */
export function AssistantChat({ endpoint, context, suggestions, intro, className }: {
  endpoint: string;
  context?: Record<string, string | null | undefined>;
  suggestions: string[];
  intro: string;
  className?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, busy]);

  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    const next: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.slice(-12), context }),
      });
      const body = await res.json().catch(() => ({}));
      setMessages([...next, { role: "assistant", content: res.ok ? body.reply : body.error || "تعذّر الحصول على رد، حاول مرة أخرى." }]);
    } catch {
      setMessages([...next, { role: "assistant", content: "لا يوجد اتصال بالإنترنت حاليًا." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn("flex flex-col", className)}>
      <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 && (
          <div className="rounded-2xl border border-line bg-white p-4">
            <p className="flex items-center gap-2 font-semibold"><Sparkles className="size-4 text-brand-600" />المساعد الذكي</p>
            <p className="mt-1 text-sm text-ink-muted">{intro}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {suggestions.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm hover:border-brand-300">{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn("flex", m.role === "user" ? "justify-start" : "justify-end")}>
            <div className={cn("max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
              m.role === "user" ? "rounded-ss-md bg-brand-600 text-white" : "rounded-se-md border border-line bg-white")}>
              {m.role === "assistant" && <Bot className="mb-1 size-4 text-brand-600" aria-hidden />}
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-end"><div className="rounded-2xl border border-line bg-white px-4 py-3">
            <span className="flex gap-1" aria-label="جارٍ الكتابة">{[0, 1, 2].map((i) => <span key={i} className="size-2 animate-bounce rounded-full bg-slate-300" style={{ animationDelay: `${i * 120}ms` }} />)}</span>
          </div></div>
        )}
        <div ref={endRef} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); void send(input); }} className="flex gap-2 border-t border-line bg-white p-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="اكتب سؤالك…" aria-label="رسالتك"
          className="h-11 flex-1 rounded-xl border border-line px-3 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20" />
        <button type="submit" disabled={busy || !input.trim()} aria-label="إرسال"
          className="grid size-11 place-items-center rounded-xl bg-brand-600 text-white disabled:opacity-40">
          <Send className="size-5 -scale-x-100" />
        </button>
      </form>
    </div>
  );
}
