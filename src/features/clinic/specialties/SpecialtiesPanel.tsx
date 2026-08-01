/**
 * SpecialtiesPanel — Módulo Clínica Fatia 51 (UI da ADR-146).
 * -------------------------------------------------------------------
 * Primeira superfície visual da Jornada de Tratamento. Consome F35 da
 * ADR-145: `clinic_specialties` normalizadas + vínculos N:N com
 * `clinic_professionals`. Substitui o campo texto livre `specialty` de
 * profissional (que continua vivo por retrocompat — a coluna legada
 * NÃO foi apagada, mas o cliente novo opera pela lista normalizada).
 *
 * Layout: 3 colunas (list de especialidades / editor + vínculos / stats).
 * Segue o "sotaque" já cristalizado no `ProfessionalsPanel` / `RoomsPanel`
 * do ADR-080 (padrão canônico definido pela ADR-146 D2): paleta
 * zinc/emerald/amber/rose, form controlado com `useState`, `apiFetch`
 * direto (sem HTTP client novo), `toast` pra feedback, PT-BR em labels.
 *
 * Endpoints consumidos:
 *   GET  /api/clinic/specialties[?includeInactive=1]
 *   POST /api/clinic/specialties
 *   PATCH /api/clinic/specialties/:id
 *   GET  /api/clinic/professionals/:id/specialties
 *   PUT  /api/clinic/professionals/:id/specialties
 *   POST /api/clinic/specialties/backfill
 *
 * Guardrails (ADR-146 §Guardrails):
 *   - Escrita respeita `requireRole("owner","admin")` — a rota devolve
 *     403 pra recepção; a UI mostra a mensagem, não esconde o botão.
 *   - Backfill nunca é acionado sozinho — botão dedicado com
 *     `confirmDialog` (é idempotente mas é uma ação de setup e queremos
 *     controle do momento — mesma razão do backend F35).
 *   - "Inativar" NUNCA deleta — a coluna `active=0` preserva histórico
 *     dos vínculos (RN da Fase 25/29).
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { Loader2, Plus, Users, Layers, Info, RotateCcw } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { apiFetch } from '@/src/lib/api';
import { toast, confirmDialog } from '@/src/lib/toast';

type Specialty = {
  id: string;
  organizationId: string;
  name: string;
  code: string | null;
  color: string | null;
  defaultDurationMinutes: number;
  defaultCycleSessions: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type ProfessionalLite = {
  id: string;
  name: string;
  color?: string | null;
  active?: number | boolean;
  specialty?: string | null;
};

type ProfessionalLinkView = {
  professionalId: string;
  professionalName: string | null;
  isPrimary: boolean;
};

type SpecialtyLinkForProfessional = {
  specialtyId: string;
  specialtyName: string | null;
  isPrimary: boolean;
};

const DEFAULT_DURATION = 60;
const DEFAULT_CYCLE = 10;
const COLOR_PRESETS = ['#34d399', '#60a5fa', '#a78bfa', '#f472b6', '#fb923c', '#f87171', '#facc15', '#22d3ee'];

export default function SpecialtiesPanel() {
  const [items, setItems] = useState<Specialty[]>([]);
  const [professionals, setProfessionals] = useState<ProfessionalLite[]>([]);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyBackfill, setBusyBackfill] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = includeInactive ? '?includeInactive=1' : '';
      const [rSp, rPr] = await Promise.all([
        apiFetch(`/api/clinic/specialties${qs}`),
        apiFetch('/api/clinic/professionals'),
      ]);
      const dSp = await rSp.json().catch(() => ({}));
      const dPr = await rPr.json().catch(() => ([]));
      const list = Array.isArray(dSp?.specialties) ? dSp.specialties : [];
      setItems(list);
      setProfessionals(Array.isArray(dPr) ? dPr : []);
      // Mantém seleção se ainda existir; senão seleciona a 1ª.
      setSelectedId(prev => {
        if (prev && list.some((s: Specialty) => s.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar especialidades.');
    } finally {
      setLoading(false);
    }
  }, [includeInactive]);

  useEffect(() => { load(); }, [load]);

  const selected = useMemo(
    () => items.find(s => s.id === selectedId) ?? null,
    [items, selectedId],
  );

  const runBackfill = async () => {
    const ok = await confirmDialog(
      'Rodar o backfill converte cada valor distinto de "especialidade" já cadastrado nos profissionais em uma especialidade normalizada + vínculo. É idempotente (pode rodar de novo sem duplicar), mas normalmente só é usado uma vez no go-live. Prosseguir?',
      { title: 'Backfill de especialidades legadas', confirmText: 'Rodar backfill' },
    );
    if (!ok) return;
    setBusyBackfill(true);
    try {
      const r = await apiFetch('/api/clinic/specialties/backfill', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha no backfill.');
      const s = d.summary || {};
      toast.success(
        `Backfill OK — ${s.specialtiesCreated ?? 0} especialidades novas, ${s.linksCreated ?? 0} vínculos.`,
      );
      await load();
    } catch (e: any) {
      toast.error(e?.message || 'Falha no backfill.');
    } finally {
      setBusyBackfill(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-base font-semibold text-zinc-100 flex items-center gap-2">
            <Layers className="w-4 h-4 text-emerald-400" /> Especialidades
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            Especialidades normalizadas da clínica. Cada profissional vincula 1..N.
            Ao abrir um episódio, o sistema lista só quem tem a especialidade escolhida.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[11px] text-zinc-400 inline-flex items-center gap-1">
            <input type="checkbox" checked={includeInactive} onChange={e => setIncludeInactive(e.target.checked)}
              className="accent-emerald-500" />
            Incluir inativas
          </label>
          <Button onClick={runBackfill} disabled={busyBackfill}
            className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100 h-8 px-3 text-xs">
            {busyBackfill ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 mr-1" />}
            Backfill do legado
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-zinc-500 text-sm py-10">
          <Loader2 className="w-4 h-4 animate-spin" /> Carregando especialidades…
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
          {/* Coluna 1 — lista */}
          <SpecialtyList
            items={items}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCreated={async (id) => { await load(); setSelectedId(id); }}
          />

          {/* Coluna 2 — editor + vínculos. Fragment com key força remount
              ao trocar a seleção (reseta form + refetch dos vínculos). */}
          {selected ? (
            <React.Fragment key={selected.id}>
              <SpecialtyEditor
                specialty={selected}
                professionals={professionals}
                onChanged={load}
              />
            </React.Fragment>
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-zinc-500 text-sm">
              Nenhuma especialidade selecionada. Cadastre a primeira à esquerda.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Coluna 1: lista + formulário de criação ───────────────────────────
function SpecialtyList({ items, selectedId, onSelect, onCreated }: {
  items: Specialty[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreated: (id: string) => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(COLOR_PRESETS[0]);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Informe o nome da especialidade.'); return; }
    setBusy(true);
    try {
      const r = await apiFetch('/api/clinic/specialties', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed, color,
          defaultDurationMinutes: DEFAULT_DURATION,
          defaultCycleSessions: DEFAULT_CYCLE,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao criar especialidade.');
      toast.success('Especialidade cadastrada.');
      setName(''); setColor(COLOR_PRESETS[0]);
      await onCreated(d.specialty?.id);
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao criar.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="space-y-1 mb-3 max-h-[420px] overflow-auto pr-1">
        {items.length === 0 ? (
          <p className="text-[11px] text-zinc-600 px-2 py-3">
            Nenhuma especialidade cadastrada ainda.
          </p>
        ) : items.map(s => {
          const isSel = s.id === selectedId;
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`w-full text-left rounded-lg border px-2.5 py-2 flex items-center gap-2 transition-colors ${
                isSel
                  ? 'border-emerald-500/50 bg-emerald-500/5'
                  : 'border-zinc-800 bg-zinc-950 hover:border-zinc-700'
              }`}
            >
              <span className="inline-block w-2.5 h-2.5 rounded-full border border-zinc-600 shrink-0"
                style={{ backgroundColor: s.color || '#71717a' }} />
              <span className={`text-sm truncate ${isSel ? 'text-emerald-200' : 'text-zinc-200'}`}>
                {s.name}
              </span>
              {!s.active && (
                <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded border text-zinc-500 border-zinc-700">
                  Inativa
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 space-y-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome da especialidade"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-emerald-500" />
        <div className="flex items-center gap-1.5 flex-wrap">
          {COLOR_PRESETS.map(c => (
            <button key={c} onClick={() => setColor(c)}
              title={c}
              className={`w-5 h-5 rounded-full border ${color === c ? 'border-emerald-400 ring-2 ring-emerald-500/40' : 'border-zinc-700'}`}
              style={{ backgroundColor: c }} />
          ))}
        </div>
        <div className="flex justify-end">
          <Button onClick={create} disabled={busy}
            className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
            {busy ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
            Adicionar
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Coluna 2: editor da selecionada + vínculos N:N ────────────────────
function SpecialtyEditor({ specialty, professionals, onChanged }: {
  specialty: Specialty;
  professionals: ProfessionalLite[];
  onChanged: () => void | Promise<void>;
}) {
  const [name, setName] = useState(specialty.name);
  const [code, setCode] = useState(specialty.code || '');
  const [color, setColor] = useState(specialty.color || COLOR_PRESETS[0]);
  const [duration, setDuration] = useState<number>(specialty.defaultDurationMinutes || DEFAULT_DURATION);
  const [cycle, setCycle] = useState<number>(specialty.defaultCycleSessions || DEFAULT_CYCLE);
  const [active, setActive] = useState<boolean>(specialty.active);
  const [saving, setSaving] = useState(false);

  const [links, setLinks] = useState<ProfessionalLinkView[]>([]);
  const [linksLoaded, setLinksLoaded] = useState(false);
  const [linksLoading, setLinksLoading] = useState(false);
  const [savingLinks, setSavingLinks] = useState(false);

  const loadLinks = useCallback(async () => {
    setLinksLoading(true);
    try {
      const r = await apiFetch(`/api/clinic/specialties/${specialty.id}/professionals?activeOnly=0`);
      const d = await r.json().catch(() => ({}));
      const list = Array.isArray(d?.professionals) ? d.professionals : [];
      setLinks(list.map((it: any) => ({
        professionalId: it.professionalId || it.professional_id,
        professionalName: it.professionalName || it.name || null,
        isPrimary: !!it.isPrimary,
      })));
      setLinksLoaded(true);
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao carregar vínculos.');
    } finally {
      setLinksLoading(false);
    }
  }, [specialty.id]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  const dirty = useMemo(() =>
    name !== specialty.name ||
    (code || '') !== (specialty.code || '') ||
    (color || '') !== (specialty.color || '') ||
    duration !== specialty.defaultDurationMinutes ||
    cycle !== specialty.defaultCycleSessions ||
    active !== specialty.active,
    [name, code, color, duration, cycle, active, specialty],
  );

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Nome não pode ser vazio.'); return; }
    if (duration < 5 || duration > 480) { toast.error('Duração deve estar entre 5 e 480 min.'); return; }
    if (cycle < 1 || cycle > 200) { toast.error('Sessões por ciclo entre 1 e 200.'); return; }
    setSaving(true);
    try {
      const r = await apiFetch(`/api/clinic/specialties/${specialty.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          code: code.trim() || null,
          color,
          defaultDurationMinutes: duration,
          defaultCycleSessions: cycle,
          active,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || 'Falha ao salvar.');
      toast.success('Especialidade atualizada.');
      await onChanged();
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  const linkedIds = useMemo(() => new Set(links.map(l => l.professionalId)), [links]);
  const primaryId = useMemo(() => links.find(l => l.isPrimary)?.professionalId ?? null, [links]);

  const toggleLink = (pId: string) => {
    setLinks(prev => {
      if (prev.some(l => l.professionalId === pId)) {
        // Remoção — se era primário, apaga a marca; a UI força escolher outro
        // antes de salvar (validação abaixo).
        return prev.filter(l => l.professionalId !== pId);
      }
      const p = professionals.find(x => x.id === pId);
      return [...prev, {
        professionalId: pId,
        professionalName: p?.name || null,
        isPrimary: false,
      }];
    });
  };

  const setPrimary = (pId: string) => {
    setLinks(prev => prev.map(l => ({ ...l, isPrimary: l.professionalId === pId })));
  };

  // Vínculos são editados pela LENTE da especialidade, mas a rota PUT
  // (`/professionals/:id/specialties`) substitui atomicamente o conjunto
  // de UM profissional. Então, ao salvar, precisamos:
  //  1) Descobrir quem foi afetado (adicionado ou removido em relação ao
  //     estado carregado no `loadLinks`).
  //  2) Pra cada afetado: GET seu conjunto atual completo, ajustar a linha
  //     desta especialty (add/remove/isPrimary), PUT de volta.
  // Assim nunca perdemos as outras especialidades já vinculadas.
  const saveLinks = async () => {
    if (links.length > 0 && !links.some(l => l.isPrimary)) {
      toast.error('Marque 1 profissional como principal antes de salvar.');
      return;
    }
    setSavingLinks(true);
    try {
      // Estado atual da UI vs. estado carregado do backend (via loadLinks).
      // Como `loadLinks` reseta `links` do server, comparar contra ele nos
      // dá o diff exato.
      const desiredById = new Map<string, ProfessionalLinkView>(
        links.map(l => [l.professionalId, l] as const),
      );
      const serverIds = await fetchServerLinkedIds();

      const toChange = new Set<string>([
        ...desiredById.keys(),
        ...serverIds, // inclui os que foram REMOVIDOS na UI
      ]);

      let failed = 0;
      for (const pid of toChange) {
        // Reconstitui o conjunto atual do profissional (todas as
        // especialidades dele), ajusta apenas a linha desta specialty.
        const rr = await apiFetch(`/api/clinic/professionals/${pid}/specialties?activeOnly=0`);
        const dd = await rr.json().catch(() => ({}));
        const cur: SpecialtyLinkForProfessional[] = (Array.isArray(dd?.specialties) ? dd.specialties : []).map((x: any) => ({
          specialtyId: x.specialtyId || x.specialty_id,
          specialtyName: x.specialtyName || x.name || null,
          isPrimary: !!x.isPrimary,
        }));
        const desired = desiredById.get(pid);
        let next = cur.filter(x => x.specialtyId !== specialty.id);
        if (desired) {
          next.push({
            specialtyId: specialty.id,
            specialtyName: specialty.name,
            isPrimary: desired.isPrimary,
          });
          // Se a nova é primária, garante que só ela seja primária.
          if (desired.isPrimary) {
            next = next.map(x => x.specialtyId === specialty.id ? x : { ...x, isPrimary: false });
          }
        }
        const put = await apiFetch(`/api/clinic/professionals/${pid}/specialties`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            specialties: next.map(x => ({ specialtyId: x.specialtyId, isPrimary: !!x.isPrimary })),
          }),
        });
        if (!put.ok) failed++;
      }
      if (toChange.size === 0) {
        toast.info('Nada para salvar.');
      } else if (failed) {
        toast.error(`Alguns vínculos não foram salvos (${failed} falha(s)).`);
      } else {
        toast.success('Vínculos atualizados.');
      }
      await loadLinks();
    } catch (e: any) {
      toast.error(e?.message || 'Falha ao salvar vínculos.');
    } finally {
      setSavingLinks(false);
    }
  };

  // Descobre no server quem estava vinculado a esta specialty AGORA
  // (baseline antes do save). Usa a rota GET dedicada — 1 request.
  const fetchServerLinkedIds = async (): Promise<Set<string>> => {
    const r = await apiFetch(`/api/clinic/specialties/${specialty.id}/professionals?activeOnly=0`);
    const d = await r.json().catch(() => ({}));
    const arr = (Array.isArray(d?.professionals) ? d.professionals : []) as any[];
    return new Set(arr.map((x: any) => String(x.professionalId || x.professional_id)));
  };

  return (
    <div className="space-y-4">
      {/* Editor da especialidade */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="inline-block w-3 h-3 rounded-full border border-zinc-600"
            style={{ backgroundColor: color || '#71717a' }} />
          <h4 className="text-sm font-semibold text-zinc-100">Detalhes</h4>
          {!specialty.active && (
            <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded border text-zinc-500 border-zinc-700">Inativa</span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Nome</span>
            <input value={name} onChange={e => setName(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Código (opcional)</span>
            <input value={code} onChange={e => setCode(e.target.value)}
              placeholder="Ex.: CBO-2251-05"
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Duração padrão (min)</span>
            <input type="number" min={5} max={480} value={duration}
              onChange={e => setDuration(Number(e.target.value) || DEFAULT_DURATION)}
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-zinc-400">Sessões por ciclo (padrão)</span>
            <input type="number" min={1} max={200} value={cycle}
              onChange={e => setCycle(Number(e.target.value) || DEFAULT_CYCLE)}
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-500" />
          </label>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-[11px] text-zinc-400">Cor</span>
            <div className="flex items-center gap-1.5 flex-wrap">
              {COLOR_PRESETS.map(c => (
                <button key={c} onClick={() => setColor(c)} title={c}
                  className={`w-5 h-5 rounded-full border ${color === c ? 'border-emerald-400 ring-2 ring-emerald-500/40' : 'border-zinc-700'}`}
                  style={{ backgroundColor: c }} />
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 sm:col-span-2">
            <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)}
              className="accent-emerald-500" />
            <span className="text-xs text-zinc-300">
              Ativa {!active && <span className="text-zinc-500">(fica oculta da agenda; histórico preservado)</span>}
            </span>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 mt-3">
          <Button onClick={save} disabled={!dirty || saving}
            className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
            {saving ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
            Salvar
          </Button>
        </div>
      </div>

      {/* Vínculos N:N */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-emerald-400" />
          <h4 className="text-sm font-semibold text-zinc-100">Profissionais desta especialidade</h4>
          <span className="ml-auto text-[11px] text-zinc-500">{links.length} vínculo(s)</span>
        </div>

        {!linksLoaded || linksLoading ? (
          <div className="flex items-center gap-2 text-zinc-500 text-sm py-4">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando vínculos…
          </div>
        ) : professionals.length === 0 ? (
          <p className="text-[11px] text-zinc-600 py-2">Cadastre profissionais primeiro (aba Configurar).</p>
        ) : (
          <>
            <div className="space-y-1 mb-3 max-h-[280px] overflow-auto pr-1">
              {professionals.map(p => {
                const linked = linkedIds.has(p.id);
                const isPrimary = primaryId === p.id;
                return (
                  <div key={p.id}
                    className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                      linked ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-zinc-800 bg-zinc-950'
                    }`}>
                    <input type="checkbox" checked={linked} onChange={() => toggleLink(p.id)}
                      className="accent-emerald-500" />
                    <span className="inline-block w-2 h-2 rounded-full border border-zinc-600"
                      style={{ backgroundColor: p.color || '#71717a' }} />
                    <span className="text-sm text-zinc-200 truncate">{p.name}</span>
                    {linked && (
                      <button onClick={() => setPrimary(p.id)}
                        className={`ml-auto text-[10px] px-1.5 py-0.5 rounded border ${
                          isPrimary
                            ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
                            : 'text-zinc-500 border-zinc-700 hover:text-zinc-300'
                        }`}>
                        {isPrimary ? 'Principal ✓' : 'Marcar principal'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-zinc-500 inline-flex items-start gap-1">
                <Info className="w-3 h-3 mt-0.5 shrink-0" />
                <span>
                  "Principal" é usado como sugestão padrão ao abrir um novo episódio.
                  Cada profissional pode ter só 1 especialidade principal.
                </span>
              </p>
              <Button onClick={saveLinks} disabled={savingLinks}
                className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs">
                {savingLinks ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : null}
                Salvar vínculos
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
