import { many, type Db, type RequestContext } from '../db/pool.js';

/** توحيد الحروف العربية الشائعة لتحسين المطابقة (أ/إ/آ→ا، ة→ه، ى→ي) */
export function normalizeAr(s: string) {
  return s.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ً-ْ]/g, '');
}

function terms(query: string) {
  const words = normalizeAr(query).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    if (w.startsWith('ال') && w.length > 4) out.add(w.slice(2));
  }
  return [...out].slice(0, 12);
}

export function audienceFor(role: RequestContext['role']) {
  return role === 'parent' ? 'parent' : role === 'driver' || role === 'attendant' ? 'driver' : 'staff';
}

const NORM = (col: string) => `translate(lower(${col}), 'أإآةى', 'اااهي')`;

/**
 * بحث بسيط بالكلمات في مقالات الجهة الحالية + مقالات المنصة العامة، مرشّحة بجمهور الدور.
 * RLS تضمن عدم ظهور مقالات جهة أخرى.
 */
export async function searchKnowledge(c: Db, ctx: RequestContext, query: string, limit = 5) {
  const t = terms(query);
  if (!t.length) return [];
  const rows = await many(
    c,
    `select id, title, body, tenant_id is null as "isGlobal",
            (select count(*) from unnest($1::text[]) w where ${NORM('title')} like '%' || w || '%') * 3
          + (select count(*) from unnest($1::text[]) w where ${NORM('body')} like '%' || w || '%')
          + (select count(*) from unnest($1::text[]) w where exists (select 1 from unnest(tags) g where ${NORM('g')} like '%' || w || '%')) * 2 as score
     from knowledge_articles
     where status = 'published' and $2 = any(audience)
     order by score desc, (tenant_id is null) asc, updated_at desc limit $3`,
    [t, audienceFor(ctx.role), limit * 2],
  );
  return rows.filter((r) => r.score > 0).slice(0, limit).map(({ score: _s, ...r }) => r);
}
