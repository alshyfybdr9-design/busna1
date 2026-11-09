import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useI18n, fmtDateTime } from '../../i18n';
import { Empty, ErrorBox, Loading, Modal } from '../../components/ui';

const AUD: Record<string, string> = { parent: 'أولياء الأمور', driver: 'السائقون', staff: 'الإدارة' };

/** قاعدة المعرفة: scope=tenant (أسئلة وسياسات الجهة) أو platform (دليل التطبيق العام) */
export function KnowledgePage({ scope, canEdit }: { scope: 'tenant' | 'platform'; canEdit: boolean }) {
  const { lang } = useI18n();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<any>(null);
  const q = useQuery({ queryKey: ['kb', scope], queryFn: () => api('GET', `/${scope}/knowledge`) });
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/${scope}/knowledge/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['kb', scope] }) });
  const items = (q.data?.articles ?? []) as any[];
  return (
    <div className="card">
      <div className="row between">
        <h2>{scope === 'platform' ? (lang === 'ar' ? 'دليل استخدام التطبيق (عام لكل الجهات)' : 'App guide (all organizations)') : (lang === 'ar' ? 'قاعدة المعرفة والسياسات' : 'Knowledge & policies')}</h2>
        {canEdit && <button className="btn" onClick={() => setEditing({})}>+ {lang === 'ar' ? 'مقال' : 'Article'}</button>}
      </div>
      <p className="small muted">
        {scope === 'tenant'
          ? (lang === 'ar' ? '«مساعد باصنا» يجيب فقط من هذه المقالات المعتمدة ومن دليل التطبيق العام ومن البيانات الفعلية. اكتب هنا سياسات جهتك (الغياب، الرسوم والاسترداد، أوقات الدعم...) حتى لا يخمّن.' : 'The assistant answers only from these approved articles, the app guide and real data.')
          : (lang === 'ar' ? 'مقالات عن استخدام التطبيق تظهر لجميع الجهات. لا تضع هنا سياسات خاصة بجهة.' : 'App how-to articles visible to all organizations.')}
      </p>
      {q.isLoading && <Loading />}
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (items.length === 0 ? <Empty /> : (
        <div className="table-wrap"><table><tbody>{items.map((a) => (
          <tr key={a.id}>
            <td>
              <strong>{a.title}</strong> {a.isGlobal && scope === 'tenant' && <span className="badge gray">{lang === 'ar' ? 'دليل باصنا' : 'Busna guide'}</span>} {a.status === 'draft' && <span className="badge amber">{lang === 'ar' ? 'مسودة' : 'Draft'}</span>}
              <div className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{a.body.slice(0, 220)}{a.body.length > 220 ? '…' : ''}</div>
              <div className="small muted">{(a.audience ?? []).map((x: string) => AUD[x]).join('، ')} · {fmtDateTime(a.updatedAt, lang)}</div>
            </td>
            <td className="row" style={{ flexWrap: 'nowrap' }}>
              {canEdit && (!a.isGlobal || scope === 'platform') && <>
                <button className="btn sm secondary" onClick={() => setEditing(a)}>{lang === 'ar' ? 'تعديل' : 'Edit'}</button>
                <button className="btn sm ghost" onClick={() => confirm(lang === 'ar' ? 'حذف المقال؟' : 'Delete?') && del.mutate(a.id)}>✕</button>
              </>}
            </td>
          </tr>
        ))}</tbody></table></div>
      ))}
      {editing && <ArticleModal scope={scope} article={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['kb', scope] }); }} />}
    </div>
  );
}

function ArticleModal({ scope, article, onClose, onSaved }: { scope: string; article: any; onClose: () => void; onSaved: () => void }) {
  const { lang } = useI18n();
  const [f, setF] = useState({
    title: article.title ?? '', body: article.body ?? '', tags: (article.tags ?? []).join('، '),
    audience: (article.audience ?? ['parent', 'driver', 'staff']) as string[], status: article.status ?? 'published',
  });
  const m = useMutation({
    mutationFn: () => {
      const body = { title: f.title, body: f.body, audience: f.audience, status: f.status, tags: f.tags.split(/[,،]/).map((s: string) => s.trim()).filter(Boolean) };
      return article.id ? api('PATCH', `/${scope}/knowledge/${article.id}`, body) : api('POST', `/${scope}/knowledge`, body);
    },
    onSuccess: onSaved,
  });
  return (
    <Modal title={article.id ? (lang === 'ar' ? 'تعديل مقال' : 'Edit article') : (lang === 'ar' ? 'مقال جديد' : 'New article')} onClose={onClose}>
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); m.mutate(); }}>
        <div className="field"><label>{lang === 'ar' ? 'العنوان (كسؤال يطرحه المستخدم)' : 'Title'}</label><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} /></div>
        <div className="field"><label>{lang === 'ar' ? 'الإجابة / نص السياسة' : 'Body'}</label><textarea rows={7} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required minLength={3} /></div>
        <div className="field"><label>{lang === 'ar' ? 'كلمات مفتاحية (مفصولة بفاصلة)' : 'Tags'}</label><input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></div>
        <div className="field"><label>{lang === 'ar' ? 'يظهر لـ' : 'Audience'}</label>
          <div className="row">{Object.entries(AUD).map(([k, v]) => (
            <label key={k} className="row small"><input type="checkbox" style={{ width: 'auto', minHeight: 0 }} checked={f.audience.includes(k)} onChange={(e) => setF({ ...f, audience: e.target.checked ? [...f.audience, k] : f.audience.filter((x) => x !== k) })} />{v}</label>
          ))}</div></div>
        <div className="field"><label>{lang === 'ar' ? 'الحالة' : 'Status'}</label>
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="published">{lang === 'ar' ? 'منشور' : 'Published'}</option><option value="draft">{lang === 'ar' ? 'مسودة' : 'Draft'}</option></select></div>
        {m.error && <ErrorBox error={m.error} />}
        <button className="btn" disabled={m.isPending || f.audience.length === 0}>{lang === 'ar' ? 'حفظ' : 'Save'}</button>
      </form>
    </Modal>
  );
}
