"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Smartphone, Mail } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { BusnaLogo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { cn } from "@/components/ui/cn";

function normalizeSaPhone(raw: string): string | null {
  const d = raw.replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c))).replace(/[^\d+]/g, "");
  if (/^05\d{8}$/.test(d)) return "+966" + d.slice(1);
  if (/^5\d{8}$/.test(d)) return "+966" + d;
  if (/^\+9665\d{8}$/.test(d)) return d;
  if (/^9665\d{8}$/.test(d)) return "+" + d;
  return null;
}

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next") || "/";
  const [mode, setMode] = useState<"phone" | "email">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [otpSentTo, setOtpSentTo] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supabase = supabaseBrowser();

  const done = () => { router.replace(next.startsWith("/") ? next : "/"); router.refresh(); };

  async function sendOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const p = normalizeSaPhone(phone);
    if (!p) return setError("أدخل رقم جوال سعودي صحيح يبدأ بـ 05");
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ phone: p });
    setBusy(false);
    if (error) return setError("تعذّر إرسال رمز التحقق. حاول بعد قليل.");
    setOtpSentTo(p);
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!otpSentTo) return;
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.verifyOtp({ phone: otpSentTo, token: code.trim(), type: "sms" });
    setBusy(false);
    if (error) return setError("رمز التحقق غير صحيح أو منتهي الصلاحية.");
    done();
  }

  async function emailLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) return setError("البريد الإلكتروني أو كلمة المرور غير صحيحة.");
    done();
  }

  return (
    <div className="w-full max-w-sm">
      <div className="mb-8 text-center">
        <BusnaLogo className="justify-center" />
        <h1 className="mt-6 text-2xl font-bold">تسجيل الدخول</h1>
        <p className="mt-1 text-sm text-ink-muted">النقل المدرسي — للإدارة والسائقين والمشرفين وأولياء الأمور</p>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1" role="tablist">
        {([["phone", "رقم الجوال", Smartphone], ["email", "البريد الإلكتروني", Mail]] as const).map(([m, label, Icon]) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError(null); }}
            className={cn("flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition",
              mode === m ? "bg-white shadow-card text-ink" : "text-ink-muted")}>
            <Icon className="size-4" aria-hidden />{label}
          </button>
        ))}
      </div>

      <div className="rounded-2xl border border-line bg-white p-5 shadow-card">
        {mode === "phone" && !otpSentTo && (
          <form onSubmit={sendOtp} className="space-y-4">
            <Field label="رقم الجوال" hint="سنرسل لك رمز تحقق برسالة نصية">
              <Input inputMode="tel" autoComplete="tel" dir="ltr" placeholder="05XXXXXXXX" value={phone}
                onChange={(e) => setPhone(e.target.value)} className="text-left text-base" required />
            </Field>
            <Button type="submit" className="w-full" size="lg" loading={busy}>إرسال رمز التحقق</Button>
          </form>
        )}
        {mode === "phone" && otpSentTo && (
          <form onSubmit={verifyOtp} className="space-y-4">
            <Field label="رمز التحقق" hint={`أُرسل إلى ${otpSentTo}`}>
              <Input inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} value={code}
                onChange={(e) => setCode(e.target.value)} className="text-center text-lg tracking-[0.4em]" required autoFocus />
            </Field>
            <Button type="submit" className="w-full" size="lg" loading={busy}>دخول</Button>
            <button type="button" className="w-full text-sm text-ink-muted hover:text-ink" onClick={() => { setOtpSentTo(null); setCode(""); }}>
              تغيير الرقم
            </button>
          </form>
        )}
        {mode === "email" && (
          <form onSubmit={emailLogin} className="space-y-4">
            <Field label="البريد الإلكتروني">
              <Input type="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </Field>
            <Field label="كلمة المرور">
              <Input type="password" autoComplete="current-password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <Button type="submit" className="w-full" size="lg" loading={busy}>دخول</Button>
          </form>
        )}
        {error && <p role="alert" className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Suspense><LoginForm /></Suspense>
    </main>
  );
}
