import { useState, useEffect, useCallback, type ReactNode } from 'react';
import { GraduationCap, Plus, X, Loader2, Users, UserCog, Sparkles, RefreshCw, Link2, ShieldCheck, ShieldOff, CalendarDays, Send, Trash2, ClipboardList, Star } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';

/**
 * EscolaView (ADR-144 — UI da vertical Escola/educacao). Consome as rotas
 * /api/escola/* (backend já em produção: alunos+responsáveis+consentimento+
 * resumo diário, professores+grade, extracurriculares, coordenação, import).
 * Só aparece quando o módulo `escola` está ligado (preset da vertical educacao;
 * gate no Sidebar/App). Espelha os padrões do AdvocaciaView/ClinicAgendaView
 * (apiFetch, tabs locais, toast, cards Tailwind). UI-only — nenhum backend novo.
 */

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const AGENDA_KINDS: Record<string, string> = { class: 'Aula', activity: 'Atividade', notice: 'Recado', pickup: 'Saída' };

const today = () => new Date().toISOString().slice(0, 10);

async function postJson(path: string, body?: any) {
  const r = await apiFetch(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error || 'Não foi possível concluir a ação.');
  return d;
}

type Tab = 'coordenacao' | 'alunos' | 'professores' | 'atividades';

export function EscolaView() {
  const [tab, setTab] = useState<Tab>('coordenacao');
  const tabs: [Tab, string][] = [
    ['coordenacao', 'Coordenação'],
    ['alunos', 'Alunos'],
    ['professores', 'Professores'],
    ['atividades', 'Atividades'],
  ];

  return (
    <div className="max-w-5xl mx-auto">
      <div className="mb-5">
        <p className="zf-kicker mb-1">Escola</p>
        <h2 className="zf-page-title flex items-center gap-2">
          <GraduationCap className="w-6 h-6 text-sky-400" /> Secretaria
        </h2>
      </div>

      <div className="mb-5 flex items-center gap-1 border-b border-zinc-800 overflow-x-auto">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors whitespace-nowrap ${
              tab === id ? 'border-sky-500 text-sky-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'coordenacao' && <CoordenacaoTab />}
      {tab === 'alunos' && <AlunosTab />}
      {tab === 'professores' && <ProfessoresTab />}
      {tab === 'atividades' && <AtividadesTab />}
    </div>
  );
}

// ───────────────────────── Coordenação ─────────────────────────

function CoordenacaoTab() {
  const [panel, setPanel] = useState<{ signals: any[]; priorities: any[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const load = useCallback(() => {
    return apiFetch('/api/escola/coordenacao/panel')
      .then((r) => r.json())
      .then((d) => setPanel({ signals: Array.isArray(d?.signals) ? d.signals : [], priorities: Array.isArray(d?.priorities) ? d.priorities : [] }))
      .catch(() => setPanel({ signals: [], priorities: [] }));
  }, []);

  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [load]);

  const scan = async () => {
    setScanning(true);
    try { await postJson('/api/escola/coordenacao/scan'); await load(); toast.success('Sinais recomputados.'); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
    finally { setScanning(false); }
  };

  if (loading) return <Loading />;
  const signals = panel?.signals || [];

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-400">Sinais da coordenação: turma sem professor, faltas recorrentes, aulas não realizadas e lista de espera.</p>
        <Button onClick={scan} disabled={scanning} className="zf-button zf-button-secondary whitespace-nowrap">
          {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          <span className="ml-1.5">Recomputar</span>
        </Button>
      </div>

      {signals.length === 0 ? (
        <Empty icon={<Sparkles className="w-8 h-8" />} title="Nada pendente" sub="Nenhum sinal aberto na coordenação. Use “Recomputar” após lançar aulas e faltas." />
      ) : (
        <div className="space-y-2">
          {signals.map((s) => (
            <div key={s.id} className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-zinc-100">{s.title || s.signal_type}</p>
                  {s.description && <p className="text-xs text-zinc-400 mt-0.5">{s.description}</p>}
                  {s.action && <p className="text-xs text-sky-300/80 mt-1">→ {s.action}</p>}
                </div>
                {s.severity && <SeverityBadge severity={s.severity} />}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const map: Record<string, string> = {
    fatal: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
    risk: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
    opportunity: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
    info: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  };
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${map[severity] || map.info}`}>{severity}</span>;
}

// ───────────────────────── Alunos ─────────────────────────

function AlunosTab() {
  const [students, setStudents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [turma, setTurma] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (turma.trim()) params.set('turma', turma.trim());
    return apiFetch(`/api/escola/students?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => setStudents(Array.isArray(d) ? d : []))
      .catch(() => setStudents([]));
  }, [q, turma]);

  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [load]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome ou matrícula…"
          className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-sky-400 outline-none" />
        <input value={turma} onChange={(e) => setTurma(e.target.value)} placeholder="Turma"
          className="w-28 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-sky-400 outline-none" />
        <Button onClick={() => setShowNew(true)} className="zf-button zf-button-primary whitespace-nowrap"><Plus className="w-4 h-4 mr-1" />Novo aluno</Button>
      </div>

      {loading ? <Loading /> : students.length === 0 ? (
        <Empty icon={<Users className="w-8 h-8" />} title="Nenhum aluno" sub="Cadastre o primeiro aluno ou importe a planilha da secretaria." />
      ) : (
        <div className="space-y-1.5">
          {students.map((s) => (
            <button key={s.id} onClick={() => setSelected(s.id)}
              className="w-full text-left bg-zinc-900/50 hover:bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 flex items-center justify-between transition-colors">
              <div>
                <p className="text-sm font-medium text-zinc-100">{s.full_name}</p>
                <p className="text-xs text-zinc-500">{s.enrollment_code ? `Matrícula ${s.enrollment_code}` : 'Sem matrícula'}</p>
              </div>
              {s.turma && <span className="text-[11px] px-2 py-0.5 rounded-full border border-sky-500/30 bg-sky-500/10 text-sky-300">{s.turma}</span>}
            </button>
          ))}
        </div>
      )}

      {showNew && <NewStudentModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
      {selected && <StudentDetail studentId={selected} onClose={() => { setSelected(null); load(); }} />}
    </div>
  );
}

function NewStudentModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ fullName: '', turma: '', birthDate: '', enrollmentCode: '' });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!form.fullName.trim()) { toast.error('Nome do aluno é obrigatório.'); return; }
    setSaving(true);
    try { await postJson('/api/escola/students', form); toast.success('Aluno cadastrado.'); onSaved(); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
    finally { setSaving(false); }
  };
  return (
    <Modal title="Novo aluno" onClose={onClose}>
      <Field label="Nome completo"><input autoFocus value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className={inputCls} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Turma"><input value={form.turma} onChange={(e) => setForm({ ...form, turma: e.target.value })} className={inputCls} placeholder="Ex: 3ºA" /></Field>
        <Field label="Matrícula"><input value={form.enrollmentCode} onChange={(e) => setForm({ ...form, enrollmentCode: e.target.value })} className={inputCls} /></Field>
      </div>
      <Field label="Nascimento"><input type="date" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} className={inputCls} /></Field>
      <ModalActions onClose={onClose} onSave={save} saving={saving} />
    </Modal>
  );
}

function StudentDetail({ studentId, onClose }: { studentId: string; onClose: () => void }) {
  const [data, setData] = useState<{ student: any; guardians: any[] } | null>(null);
  const [contacts, setContacts] = useState<any[]>([]);
  const [date, setDate] = useState(today());
  const [agenda, setAgenda] = useState<any[]>([]);

  const load = useCallback(() => apiFetch(`/api/escola/students/${studentId}`).then((r) => r.json()).then(setData).catch(() => setData(null)), [studentId]);
  const loadAgenda = useCallback(() => apiFetch(`/api/escola/students/${studentId}/agenda?date=${date}`).then((r) => r.json()).then((d) => setAgenda(Array.isArray(d) ? d : [])).catch(() => setAgenda([])), [studentId, date]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadAgenda(); }, [loadAgenda]);
  useEffect(() => { apiFetch('/api/contacts').then((r) => r.json()).then((d) => setContacts(Array.isArray(d) ? d : [])).catch(() => {}); }, []);

  const act = async (fn: () => Promise<any>, ok: string) => {
    try { await fn(); toast.success(ok); await load(); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };

  // Guardian linking
  const [gContact, setGContact] = useState('');
  const [gRel, setGRel] = useState('');
  const linkGuardian = () => {
    if (!gContact) { toast.error('Escolha um contato.'); return; }
    act(() => postJson(`/api/escola/students/${studentId}/guardians`, { guardianContactId: gContact, relationship: gRel, isPrimary: !(data?.guardians?.length) }), 'Responsável vinculado.')
      .then(() => { setGContact(''); setGRel(''); });
  };
  const toggleConsent = (g: any) =>
    act(() => apiFetch(`/api/escola/students/${studentId}/guardians/${g.guardian_contact_id}/consent`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consent: !g.digest_consent }),
    }).then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error); }), g.digest_consent ? 'Consentimento revogado.' : 'Consentimento concedido.');

  // Agenda add
  const [ai, setAi] = useState({ title: '', kind: 'notice', timeLabel: '' });
  const addAgenda = async () => {
    if (!ai.title.trim()) { toast.error('Título é obrigatório.'); return; }
    try { await postJson(`/api/escola/students/${studentId}/agenda`, { ...ai, date }); setAi({ title: '', kind: 'notice', timeLabel: '' }); await loadAgenda(); toast.success('Item adicionado.'); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };

  // Absence + digest
  const [absReason, setAbsReason] = useState('');
  const recordAbsence = () =>
    act(() => postJson(`/api/escola/students/${studentId}/absence`, { date, reason: absReason }), 'Falta registrada.').then(() => { setAbsReason(''); loadAgenda(); });
  const sendTest = async () => {
    try { await postJson(`/api/escola/students/${studentId}/digest/send-test`); toast.success('Resumo de teste enviado.'); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };

  const s = data?.student;
  return (
    <Modal title={s?.full_name || 'Aluno'} onClose={onClose} wide>
      {!data ? <Loading /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2 text-xs">
            {s.turma && <Chip>Turma {s.turma}</Chip>}
            {s.enrollment_code && <Chip>Matrícula {s.enrollment_code}</Chip>}
            {s.birth_date && <Chip>Nasc. {s.birth_date}</Chip>}
          </div>

          {/* Responsáveis + consentimento */}
          <Section title="Responsáveis" icon={<Users className="w-4 h-4" />}>
            {data.guardians.length === 0 ? <p className="text-xs text-zinc-500">Nenhum responsável vinculado.</p> : (
              <div className="space-y-1.5 mb-3">
                {data.guardians.map((g) => (
                  <div key={g.id} className="flex items-center justify-between bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {g.is_primary ? <Star className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" /> : null}
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-200 truncate">{g.guardian_name}{g.relationship ? <span className="text-zinc-500"> · {g.relationship}</span> : null}</p>
                        <p className="text-[11px] text-zinc-500 truncate">{g.guardian_identifier || 'sem telefone'}</p>
                      </div>
                    </div>
                    <button onClick={() => toggleConsent(g)}
                      className={`text-[11px] px-2 py-1 rounded-md border flex items-center gap-1 whitespace-nowrap ${g.digest_consent ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : 'text-zinc-400 border-zinc-700 hover:text-zinc-200'}`}>
                      {g.digest_consent ? <ShieldCheck className="w-3 h-3" /> : <ShieldOff className="w-3 h-3" />}
                      {g.digest_consent ? 'Consentido' : 'Sem consentimento'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <select value={gContact} onChange={(e) => setGContact(e.target.value)} className={`${inputCls} flex-1`}>
                <option value="">Vincular contato como responsável…</option>
                {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}{c.identifier ? ` (${c.identifier})` : ''}</option>)}
              </select>
              <input value={gRel} onChange={(e) => setGRel(e.target.value)} placeholder="Parentesco" className={`${inputCls} w-32`} />
              <Button onClick={linkGuardian} className="zf-button zf-button-secondary"><Link2 className="w-4 h-4" /></Button>
            </div>
            <p className="text-[11px] text-zinc-600 mt-1.5">O resumo diário só é enviado a responsável com consentimento e telefone válido (ADR-144).</p>
          </Section>

          {/* Agenda do dia */}
          <Section title="Agenda do dia" icon={<CalendarDays className="w-4 h-4" />}>
            <div className="flex items-center gap-2 mb-2">
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${inputCls} w-40`} />
              <Button onClick={sendTest} className="zf-button zf-button-secondary whitespace-nowrap"><Send className="w-4 h-4 mr-1" />Enviar resumo (teste)</Button>
            </div>
            {agenda.length === 0 ? <p className="text-xs text-zinc-500 mb-2">Sem itens para {date}.</p> : (
              <div className="space-y-1 mb-2">
                {agenda.map((it) => (
                  <div key={it.id} className="flex items-center gap-2 text-sm bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-1.5">
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-300 border border-sky-500/20">{AGENDA_KINDS[it.kind] || it.kind}</span>
                    {it.time_label && <span className="text-xs text-zinc-500">{it.time_label}</span>}
                    <span className="text-zinc-200">{it.title}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <select value={ai.kind} onChange={(e) => setAi({ ...ai, kind: e.target.value })} className={`${inputCls} w-28`}>
                {Object.entries(AGENDA_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <input value={ai.timeLabel} onChange={(e) => setAi({ ...ai, timeLabel: e.target.value })} placeholder="Hora" className={`${inputCls} w-20`} />
              <input value={ai.title} onChange={(e) => setAi({ ...ai, title: e.target.value })} placeholder="Título do item" className={`${inputCls} flex-1`} />
              <Button onClick={addAgenda} className="zf-button zf-button-secondary"><Plus className="w-4 h-4" /></Button>
            </div>
          </Section>

          {/* Falta */}
          <Section title="Registrar falta" icon={<ClipboardList className="w-4 h-4" />}>
            <div className="flex items-center gap-2">
              <input value={absReason} onChange={(e) => setAbsReason(e.target.value)} placeholder={`Motivo da falta em ${date} (opcional)`} className={`${inputCls} flex-1`} />
              <Button onClick={recordAbsence} className="zf-button zf-button-secondary whitespace-nowrap">Registrar falta</Button>
            </div>
          </Section>
        </div>
      )}
    </Modal>
  );
}

// ───────────────────────── Professores ─────────────────────────

function ProfessoresTab() {
  const [teachers, setTeachers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    return apiFetch(`/api/escola/teachers?${params.toString()}`).then((r) => r.json()).then((d) => setTeachers(Array.isArray(d) ? d : [])).catch(() => setTeachers([]));
  }, [q]);
  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [load]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar professor…" className="flex-1 bg-zinc-950 border border-zinc-800 rounded-lg p-2.5 text-sm text-zinc-100 focus:border-sky-400 outline-none" />
        <Button onClick={() => setShowNew(true)} className="zf-button zf-button-primary whitespace-nowrap"><Plus className="w-4 h-4 mr-1" />Novo professor</Button>
      </div>
      {loading ? <Loading /> : teachers.length === 0 ? (
        <Empty icon={<UserCog className="w-8 h-8" />} title="Nenhum professor" sub="Cadastre professores para montar a grade das turmas." />
      ) : (
        <div className="space-y-1.5">
          {teachers.map((t) => (
            <button key={t.id} onClick={() => setSelected(t.id)} className="w-full text-left bg-zinc-900/50 hover:bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 flex items-center justify-between transition-colors">
              <div className="flex items-center gap-2.5">
                {t.color && <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: t.color }} />}
                <div>
                  <p className="text-sm font-medium text-zinc-100">{t.full_name}</p>
                  <p className="text-xs text-zinc-500">{t.subject || 'Sem disciplina'}{t.phone ? ` · ${t.phone}` : ''}</p>
                </div>
              </div>
              {t.notify_opt_in ? <span className="text-[11px] px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">Avisos ON</span> : null}
            </button>
          ))}
        </div>
      )}
      {showNew && <NewTeacherModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
      {selected && <TeacherDetail teacherId={selected} onClose={() => { setSelected(null); load(); }} />}
    </div>
  );
}

function NewTeacherModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ fullName: '', subject: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!form.fullName.trim()) { toast.error('Nome do professor é obrigatório.'); return; }
    setSaving(true);
    try { await postJson('/api/escola/teachers', form); toast.success('Professor cadastrado.'); onSaved(); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
    finally { setSaving(false); }
  };
  return (
    <Modal title="Novo professor" onClose={onClose}>
      <Field label="Nome completo"><input autoFocus value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className={inputCls} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Disciplina"><input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} className={inputCls} /></Field>
        <Field label="Telefone"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputCls} placeholder="Para avisos" /></Field>
      </div>
      <ModalActions onClose={onClose} onSave={save} saving={saving} />
    </Modal>
  );
}

function TeacherDetail({ teacherId, onClose }: { teacherId: string; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [schedule, setSchedule] = useState<any[]>([]);

  const load = useCallback(() => apiFetch(`/api/escola/teachers/${teacherId}`).then((r) => r.json()).then(setData).catch(() => setData(null)), [teacherId]);
  // A grade é recorrente por turma; getTeacher devolve os itens quando disponível,
  // mas buscamos também via lista de itens da grade completa quando o serviço expõe.
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // getTeacher pode incluir os itens; se vier em data.schedule usamos, senão fica vazio.
    setSchedule(Array.isArray(data?.schedule) ? data.schedule : (Array.isArray(data?.scheduleItems) ? data.scheduleItems : []));
  }, [data]);

  const teacher = data?.teacher || data;

  const [si, setSi] = useState({ turma: '', weekday: 1, timeLabel: '', subject: '' });
  const addItem = async () => {
    if (!si.turma.trim()) { toast.error('Turma é obrigatória.'); return; }
    try { await postJson(`/api/escola/teachers/${teacherId}/schedule`, si); setSi({ turma: '', weekday: 1, timeLabel: '', subject: '' }); await load(); toast.success('Aula adicionada à grade.'); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };
  const removeItem = async (id: string) => {
    if (!(await confirmDialog('Remover esta aula da grade?'))) return;
    try { await apiFetch(`/api/escola/schedule/${id}`, { method: 'DELETE' }); await load(); toast.success('Aula removida.'); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };
  const toggleNotify = async () => {
    try {
      const r = await apiFetch(`/api/escola/teachers/${teacherId}/notify`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optIn: !teacher?.notify_opt_in }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error);
      await load(); toast.success('Preferência de aviso atualizada.');
    } catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };

  return (
    <Modal title={teacher?.full_name || 'Professor'} onClose={onClose} wide>
      {!data ? <Loading /> : (
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap gap-2 text-xs">
              {teacher.subject && <Chip>{teacher.subject}</Chip>}
              {teacher.phone && <Chip>{teacher.phone}</Chip>}
            </div>
            <button onClick={toggleNotify}
              className={`text-[11px] px-2.5 py-1 rounded-md border flex items-center gap-1 ${teacher?.notify_opt_in ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10' : 'text-zinc-400 border-zinc-700 hover:text-zinc-200'}`}>
              {teacher?.notify_opt_in ? <ShieldCheck className="w-3 h-3" /> : <ShieldOff className="w-3 h-3" />}
              Resumo antes da aula
            </button>
          </div>

          <Section title="Grade de aulas" icon={<CalendarDays className="w-4 h-4" />}>
            {schedule.length === 0 ? <p className="text-xs text-zinc-500 mb-3">Nenhuma aula na grade ainda.</p> : (
              <div className="space-y-1 mb-3">
                {schedule.map((it) => (
                  <div key={it.id} className="flex items-center justify-between bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm">
                    <span className="text-zinc-200">
                      <span className="text-sky-300">{WEEKDAYS[it.weekday] || it.weekday}</span>
                      {it.time_label ? ` · ${it.time_label}` : ''} · Turma {it.turma}{it.subject ? ` · ${it.subject}` : ''}
                    </span>
                    <button onClick={() => removeItem(it.id)} className="text-zinc-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <input value={si.turma} onChange={(e) => setSi({ ...si, turma: e.target.value })} placeholder="Turma" className={inputCls} />
              <select value={si.weekday} onChange={(e) => setSi({ ...si, weekday: Number(e.target.value) })} className={inputCls}>
                {WEEKDAYS.map((w, i) => <option key={i} value={i}>{w}</option>)}
              </select>
              <input value={si.timeLabel} onChange={(e) => setSi({ ...si, timeLabel: e.target.value })} placeholder="Hora" className={inputCls} />
              <div className="flex gap-2">
                <input value={si.subject} onChange={(e) => setSi({ ...si, subject: e.target.value })} placeholder="Disciplina" className={`${inputCls} flex-1`} />
                <Button onClick={addItem} className="zf-button zf-button-secondary"><Plus className="w-4 h-4" /></Button>
              </div>
            </div>
          </Section>
        </div>
      )}
    </Modal>
  );
}

// ───────────────────────── Atividades ─────────────────────────

function AtividadesTab() {
  const [activities, setActivities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(() => apiFetch('/api/escola/activities').then((r) => r.json()).then((d) => setActivities(Array.isArray(d) ? d : [])).catch(() => setActivities([])), []);
  useEffect(() => { setLoading(true); load().finally(() => setLoading(false)); }, [load]);

  return (
    <div>
      <div className="flex items-center justify-end mb-4">
        <Button onClick={() => setShowNew(true)} className="zf-button zf-button-primary whitespace-nowrap"><Plus className="w-4 h-4 mr-1" />Nova atividade</Button>
      </div>
      {loading ? <Loading /> : activities.length === 0 ? (
        <Empty icon={<Sparkles className="w-8 h-8" />} title="Nenhuma atividade" sub="Crie atividades extracurriculares (esporte, reforço, oficinas) com vagas e lista de espera." />
      ) : (
        <div className="space-y-1.5">
          {activities.map((a) => (
            <button key={a.id} onClick={() => setSelected(a.id)} className="w-full text-left bg-zinc-900/50 hover:bg-zinc-900 border border-zinc-800 rounded-xl p-3.5 flex items-center justify-between transition-colors">
              <div>
                <p className="text-sm font-medium text-zinc-100">{a.name}</p>
                <p className="text-xs text-zinc-500">{[a.day_label, a.time_label, a.location].filter(Boolean).join(' · ') || 'Sem horário definido'}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-zinc-300">{a.enrolled}/{a.capacity} vagas</p>
                {a.waitlisted > 0 && <p className="text-[11px] text-amber-400">{a.waitlisted} na espera</p>}
              </div>
            </button>
          ))}
        </div>
      )}
      {showNew && <NewActivityModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
      {selected && <ActivityDetail activityId={selected} onClose={() => { setSelected(null); load(); }} />}
    </div>
  );
}

function NewActivityModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ name: '', capacity: '20', dayLabel: '', timeLabel: '', location: '' });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!form.name.trim()) { toast.error('Nome da atividade é obrigatório.'); return; }
    setSaving(true);
    try { await postJson('/api/escola/activities', { ...form, capacity: Number(form.capacity) || 1 }); toast.success('Atividade criada.'); onSaved(); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
    finally { setSaving(false); }
  };
  return (
    <Modal title="Nova atividade" onClose={onClose}>
      <Field label="Nome"><input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Vagas"><input type="number" min={1} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} className={inputCls} /></Field>
        <Field label="Local"><input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={inputCls} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Dia"><input value={form.dayLabel} onChange={(e) => setForm({ ...form, dayLabel: e.target.value })} className={inputCls} placeholder="Ex: Terças" /></Field>
        <Field label="Hora"><input value={form.timeLabel} onChange={(e) => setForm({ ...form, timeLabel: e.target.value })} className={inputCls} placeholder="Ex: 14h" /></Field>
      </div>
      <ModalActions onClose={onClose} onSave={save} saving={saving} />
    </Modal>
  );
}

function ActivityDetail({ activityId, onClose }: { activityId: string; onClose: () => void }) {
  const [roster, setRoster] = useState<{ enrolled: any[]; waitlist: any[] } | null>(null);
  const [students, setStudents] = useState<any[]>([]);
  const [pick, setPick] = useState('');

  const load = useCallback(() => apiFetch(`/api/escola/activities/${activityId}/roster`).then((r) => r.json()).then((d) => setRoster({ enrolled: Array.isArray(d?.enrolled) ? d.enrolled : [], waitlist: Array.isArray(d?.waitlist) ? d.waitlist : [] })).catch(() => setRoster({ enrolled: [], waitlist: [] })), [activityId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { apiFetch('/api/escola/students').then((r) => r.json()).then((d) => setStudents(Array.isArray(d) ? d : [])).catch(() => {}); }, []);

  const enroll = async () => {
    if (!pick) { toast.error('Escolha um aluno.'); return; }
    try { const r = await postJson(`/api/escola/activities/${activityId}/enroll`, { studentId: pick }); setPick(''); await load(); toast.success(r?.status === 'waitlisted' ? 'Aluno na lista de espera.' : 'Aluno matriculado.'); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };
  const cancel = async (studentId: string) => {
    if (!(await confirmDialog('Cancelar a matrícula deste aluno?'))) return;
    try { await postJson(`/api/escola/activities/${activityId}/cancel`, { studentId }); await load(); toast.success('Matrícula cancelada.'); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };
  const mark = async (studentId: string, status: string) => {
    try { await postJson(`/api/escola/activities/${activityId}/attendance`, { studentId, date: today(), status }); toast.success(status === 'absent' ? 'Falta registrada (responsável avisado).' : 'Presença registrada.'); }
    catch (e: any) { toast.error(e?.message || 'Erro.'); }
  };

  return (
    <Modal title="Atividade" onClose={onClose} wide>
      {!roster ? <Loading /> : (
        <div className="space-y-5">
          <Section title="Matriculados" icon={<Users className="w-4 h-4" />}>
            {roster.enrolled.length === 0 ? <p className="text-xs text-zinc-500">Nenhum aluno matriculado.</p> : (
              <div className="space-y-1">
                {roster.enrolled.map((e) => (
                  <div key={e.id} className="flex items-center justify-between bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm">
                    <span className="text-zinc-200">{e.student_name}{e.student_turma ? <span className="text-zinc-500"> · {e.student_turma}</span> : null}</span>
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => mark(e.student_id, 'present')} className="text-[11px] px-2 py-0.5 rounded border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10">Presente</button>
                      <button onClick={() => mark(e.student_id, 'absent')} className="text-[11px] px-2 py-0.5 rounded border border-amber-500/30 text-amber-300 hover:bg-amber-500/10">Falta</button>
                      <button onClick={() => cancel(e.student_id)} className="text-zinc-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {roster.waitlist.length > 0 && (
            <Section title="Lista de espera" icon={<ClipboardList className="w-4 h-4" />}>
              <div className="space-y-1">
                {roster.waitlist.map((e) => (
                  <div key={e.id} className="flex items-center justify-between bg-zinc-950/60 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm">
                    <span className="text-zinc-300">{e.position ? `${e.position}º · ` : ''}{e.student_name}</span>
                    <button onClick={() => cancel(e.student_id)} className="text-zinc-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
            </Section>
          )}

          <Section title="Matricular aluno" icon={<Plus className="w-4 h-4" />}>
            <div className="flex items-center gap-2">
              <select value={pick} onChange={(e) => setPick(e.target.value)} className={`${inputCls} flex-1`}>
                <option value="">Escolha um aluno…</option>
                {students.map((s) => <option key={s.id} value={s.id}>{s.full_name}{s.turma ? ` (${s.turma})` : ''}</option>)}
              </select>
              <Button onClick={enroll} className="zf-button zf-button-secondary whitespace-nowrap">Matricular</Button>
            </div>
            <p className="text-[11px] text-zinc-600 mt-1.5">Sem vaga, o aluno entra na lista de espera e o responsável é avisado.</p>
          </Section>
        </div>
      )}
    </Modal>
  );
}

// ───────────────────────── UI helpers ─────────────────────────

const inputCls = 'w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-sm text-zinc-100 focus:border-sky-400 outline-none';

function Loading() {
  return <div className="flex items-center justify-center py-16 text-zinc-500"><Loader2 className="w-6 h-6 animate-spin" /></div>;
}

function Empty({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="text-zinc-600 mb-3">{icon}</div>
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      <p className="text-xs text-zinc-500 mt-1 max-w-sm">{sub}</p>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="px-2 py-0.5 rounded-full border border-zinc-700 bg-zinc-800/50 text-zinc-300">{children}</span>;
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4">
      <p className="text-sm font-semibold text-zinc-200 flex items-center gap-1.5 mb-3">{icon}{title}</p>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-3">
      <label className="text-xs font-medium text-zinc-400 mb-1 block">{label}</label>
      {children}
    </div>
  );
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className={`bg-zinc-950 border border-zinc-800 rounded-2xl w-full ${wide ? 'max-w-2xl' : 'max-w-md'} max-h-[88vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
          <h3 className="text-base font-semibold text-zinc-100">{title}</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function ModalActions({ onClose, onSave, saving }: { onClose: () => void; onSave: () => void; saving: boolean }) {
  return (
    <div className="flex justify-end gap-2 mt-4">
      <Button onClick={onClose} className="zf-button zf-button-secondary">Cancelar</Button>
      <Button onClick={onSave} disabled={saving} className="zf-button zf-button-primary">{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Salvar'}</Button>
    </div>
  );
}
