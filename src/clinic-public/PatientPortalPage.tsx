import { useEffect, useState } from 'react';
import { Stethoscope, Calendar, FileText, FileCheck2, Paperclip, Loader2, ShieldCheck, AlertTriangle, Download } from 'lucide-react';

/**
 * Portal do Paciente (ADR-080 Fase L) — página pública sem login. O token
 * está no path: /paciente/:token. Consulta apenas /api/public/clinic/patient/*.
 * READ-ONLY: paciente vê agenda + recibos, não interage clinicamente.
 * Nada de SOAP, nada de financeiro — o backend já projeta antes de servir.
 */

type PortalData = {
  clinic: { name: string };
  patient: { name: string };
  upcoming: { id: string; title: string; scheduledStart: string; scheduledEnd: string | null; status: string; professionalName: string | null; roomName: string | null }[];
  past: { id: string; title: string; scheduledStart: string; status: string; professionalName: string | null }[];
  prescriptions: { id: string; issuedAt: string; professionalName: string | null }[];
  certificates: { id: string; issuedAt: string; days: number; cid: string | null; professionalName: string | null }[];
  attachments: { id: string; label: string | null; kind: 'image' | 'pdf' | 'other'; mimeType: string; originalFilename: string | null; sizeBytes: number; uploadedAt: string; encounterId: string }[];
};

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR');
}

export function PatientPortalPage() {
  const token = window.location.pathname.replace(/^\/paciente\//, '').split(/[/?#]/)[0];
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (!token) { setError('Link inválido.'); setLoading(false); return; }
    (async () => {
      try {
        const r = await fetch(`/api/public/clinic/patient/${encodeURIComponent(token)}`);
        if (!r.ok) {
          const out = await r.json().catch(() => ({}));
          setError(out?.error || 'Link inválido ou expirado. Peça um novo à recepção.');
          return;
        }
        setData(await r.json());
      } catch { setError('Erro ao carregar. Tente novamente.'); }
      finally { setLoading(false); }
    })();
  }, [token]);

  const openDoc = (kind: 'prescriptions' | 'certificates', id: string) => {
    window.open(`/api/public/clinic/patient/${encodeURIComponent(token)}/${kind}/${id}/pdf`, '_blank');
  };
  const openAttachment = (id: string) => {
    window.open(`/api/public/clinic/patient/${encodeURIComponent(token)}/attachments/${id}/download`, '_blank');
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <div className="text-zinc-400 inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Carregando…</div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-red-500/40 bg-red-500/10 p-6 text-center">
          <AlertTriangle className="w-8 h-8 text-red-300 mx-auto mb-2" />
          <div className="text-red-100 font-medium">{error || 'Não foi possível abrir o portal.'}</div>
          <p className="text-xs text-red-200/80 mt-2">Se o problema persistir, entre em contato com a clínica.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-2xl mx-auto p-4 md:p-8">
        {/* Header */}
        <div className="rounded-2xl border border-zinc-800 bg-gradient-to-br from-emerald-900/30 to-zinc-900 p-5 mb-4">
          <div className="flex items-start gap-3">
            <Stethoscope className="w-8 h-8 text-emerald-300 shrink-0" />
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-widest text-emerald-300/80">{data.clinic.name}</div>
              <h1 className="text-xl md:text-2xl font-semibold truncate">{data.patient.name}</h1>
              <p className="text-[11px] text-zinc-400 mt-1 inline-flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Área privada · link expira automaticamente</p>
            </div>
          </div>
        </div>

        {/* Próximas consultas */}
        <Section title="Próximas consultas" icon={<Calendar className="w-4 h-4 text-emerald-300" />} empty="Nenhuma consulta agendada.">
          {data.upcoming.map((a) => (
            <div key={a.id} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 mb-2">
              <div className="text-sm font-medium text-zinc-100">{a.title || 'Consulta'}</div>
              <div className="text-xs text-zinc-400 mt-0.5">{fmtDateTime(a.scheduledStart)}</div>
              {a.professionalName && <div className="text-xs text-zinc-300">com {a.professionalName}</div>}
              {a.roomName && <div className="text-[11px] text-zinc-500">Sala {a.roomName}</div>}
            </div>
          ))}
        </Section>

        {/* Receitas */}
        <Section title="Suas receitas" icon={<FileText className="w-4 h-4 text-indigo-300" />} empty="Nenhuma receita disponível.">
          {data.prescriptions.map((rx) => (
            <button key={rx.id} onClick={() => openDoc('prescriptions', rx.id)}
              className="w-full text-left rounded-lg border border-zinc-800 bg-zinc-900 p-3 mb-2 hover:bg-zinc-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-zinc-100">Receita — {fmtDate(rx.issuedAt)}</div>
                {rx.professionalName && <div className="text-[11px] text-zinc-400">{rx.professionalName}</div>}
              </div>
              <span className="text-[11px] text-indigo-300 inline-flex items-center gap-1"><Download className="w-3 h-3" /> Abrir PDF</span>
            </button>
          ))}
        </Section>

        {/* Atestados */}
        <Section title="Atestados" icon={<FileCheck2 className="w-4 h-4 text-emerald-300" />} empty="Nenhum atestado disponível.">
          {data.certificates.map((c) => (
            <button key={c.id} onClick={() => openDoc('certificates', c.id)}
              className="w-full text-left rounded-lg border border-zinc-800 bg-zinc-900 p-3 mb-2 hover:bg-zinc-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-zinc-100">Atestado — {c.days} dia(s) · {fmtDate(c.issuedAt)}</div>
                <div className="text-[11px] text-zinc-400">{c.cid ? `CID ${c.cid}` : ''}{c.cid && c.professionalName ? ' · ' : ''}{c.professionalName || ''}</div>
              </div>
              <span className="text-[11px] text-emerald-300 inline-flex items-center gap-1"><Download className="w-3 h-3" /> Abrir PDF</span>
            </button>
          ))}
        </Section>

        {/* Anexos compartilhados */}
        <Section title="Anexos compartilhados" icon={<Paperclip className="w-4 h-4 text-zinc-300" />} empty="Nenhum anexo compartilhado.">
          {data.attachments.map((a) => (
            <button key={a.id} onClick={() => openAttachment(a.id)}
              className="w-full text-left rounded-lg border border-zinc-800 bg-zinc-900 p-3 mb-2 hover:bg-zinc-800 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-zinc-100 truncate">{a.label || a.originalFilename || 'Anexo'}</div>
                <div className="text-[11px] text-zinc-500">{a.kind === 'image' ? 'Imagem' : a.kind === 'pdf' ? 'PDF' : a.mimeType} · {fmtDate(a.uploadedAt)}</div>
              </div>
              <span className="text-[11px] text-zinc-300 inline-flex items-center gap-1"><Download className="w-3 h-3" /> Abrir</span>
            </button>
          ))}
        </Section>

        {/* Histórico */}
        {data.past.length > 0 && (
          <Section title="Consultas anteriores" icon={<Calendar className="w-4 h-4 text-zinc-400" />} empty="">
            {data.past.map((a) => (
              <div key={a.id} className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-2 mb-1.5 text-xs">
                <span className="text-zinc-300">{fmtDate(a.scheduledStart)}</span>
                <span className="text-zinc-500"> · {a.title || 'Consulta'}</span>
                {a.professionalName && <span className="text-zinc-500"> · {a.professionalName}</span>}
              </div>
            ))}
          </Section>
        )}

        <p className="text-[10px] text-zinc-500 text-center mt-8">
          Você acessa esta área por um link seguro. Não compartilhe.
        </p>
      </div>
    </div>
  );
}

function Section({ title, icon, children, empty }: { title: string; icon: any; children: any; empty: string }) {
  const items = Array.isArray(children) ? children : [children].filter(Boolean);
  const hasContent = items.some((c: any) => c);
  return (
    <div className="mb-5">
      <h2 className="text-xs font-medium text-zinc-300 uppercase tracking-wider mb-2 inline-flex items-center gap-2">
        {icon} {title}
      </h2>
      {hasContent ? children : (empty ? <div className="text-xs text-zinc-500 py-2">{empty}</div> : null)}
    </div>
  );
}

export default PatientPortalPage;
