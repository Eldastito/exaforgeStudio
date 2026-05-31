import React, { useState, useEffect } from 'react';
import { Calendar as CalendarIcon, Clock, Plus, X, BellRing, Bell } from 'lucide-react';
import { Button } from '@/src/components/ui/button';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useStore } from '@/src/store/useStore';
import { apiFetch } from '@/src/lib/api';

export function AgendaView() {
  const [appointments, setAppointments] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', scheduled_start: '', contact_id: '' });
  const { contacts } = useStore();
  const [reminder, setReminder] = useState<{ enabled: boolean; hours: number; message: string } | null>(null);

  const loadAppointments = () => {
    apiFetch('/api/appointments')
      .then(r => r.json())
      .then(data => setAppointments(Array.isArray(data) ? data : []))
      .catch(console.error);
  };

  const loadReminder = () => apiFetch('/api/appointments/reminder-settings').then(r => r.json()).then(setReminder).catch(() => {});

  useEffect(() => {
    loadAppointments();
    loadReminder();
  }, []);

  const saveReminder = async (patch: Partial<{ enabled: boolean; hours: number; message: string }>) => {
    const next = { enabled: reminder?.enabled || false, hours: reminder?.hours || 24, message: reminder?.message || '', ...patch };
    setReminder(next);
    await apiFetch('/api/appointments/reminder-settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next),
    }).catch(() => {});
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
           ...form,
           scheduled_start: new Date(form.scheduled_start).toISOString()
        })
      });
      setShowModal(false);
      setForm({ title: '', description: '', scheduled_start: '', contact_id: '' });
      loadAppointments();
    } catch(e) { }
  };

  return (
    <div className="flex-1 overflow-auto p-6 bg-zinc-950 relative">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
            <CalendarIcon className="w-6 h-6 text-emerald-400" />
            Agenda Central
          </h2>
          <p className="text-zinc-400 text-sm mt-1">Visão geral de agendamentos e entregas</p>
        </div>
        <Button className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setShowModal(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Novo Agendamento
        </Button>
      </div>

      {/* Lembretes automáticos */}
      {reminder && (
        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-zinc-100 flex items-center gap-2"><BellRing className="w-4 h-4 text-emerald-400" /> Lembretes automáticos</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                Envia um lembrete pelo WhatsApp{' '}
                <input type="number" min="1" value={reminder.hours}
                  onChange={e => setReminder({ ...reminder, hours: parseInt(e.target.value, 10) || 24 })}
                  onBlur={e => saveReminder({ hours: parseInt(e.target.value, 10) || 24 })}
                  className="w-14 bg-zinc-950 border border-zinc-800 rounded px-1 text-zinc-200 text-center" /> horas antes do agendamento.
              </p>
            </div>
            <button onClick={() => saveReminder({ enabled: !reminder.enabled })}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${reminder.enabled ? 'bg-emerald-600' : 'bg-zinc-700'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${reminder.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          {reminder.enabled && (
            <textarea
              className="mt-3 w-full h-16 bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 resize-none"
              placeholder="Mensagem. Use {nome}, {titulo} e {quando}. Ex.: Olá {nome}! Lembrete do seu agendamento {titulo} em {quando}."
              value={reminder.message}
              onChange={e => setReminder({ ...reminder, message: e.target.value })}
              onBlur={e => saveReminder({ message: e.target.value })}
            />
          )}
        </div>
      )}

      <div className="space-y-4">
        {appointments.length === 0 ? (
          <div className="py-12 text-center text-zinc-500 border border-dashed border-zinc-800 rounded-xl bg-zinc-900/30">
            Nenhum agendamento programado.
          </div>
        ) : (
          appointments.map(a => (
            <div key={a.id} className="p-4 rounded-xl border border-zinc-800 bg-zinc-900/50 flex align-middle justify-between">
              <div>
                 <h3 className="font-semibold text-zinc-100">{a.title}</h3>
                 <p className="text-sm text-zinc-400 max-w-xl truncate">{a.description}</p>
                 <div className="flex gap-4 mt-2 text-xs text-zinc-500 font-mono">
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {a.scheduled_start ? format(new Date(a.scheduled_start), "PPpp", { locale: ptBR }) : 'Sem data definida'}
                    </span>
                 </div>
              </div>
              <div className="flex flex-col items-end justify-center gap-1.5">
                 <span className="text-xs font-semibold uppercase tracking-wider bg-zinc-800 text-zinc-300 px-2 py-1 rounded">
                    {a.status}
                 </span>
                 {a.reminder_status === 'sent' && (
                   <span className="text-[10px] inline-flex items-center gap-1 text-emerald-400"><Bell className="w-3 h-3" /> lembrete enviado</span>
                 )}
              </div>
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-6 rounded-xl shadow-xl w-[400px]">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-semibold text-zinc-100">Novo Agendamento</h3>
              <button className="text-zinc-400 hover:text-white" onClick={() => setShowModal(false)}><X className="w-5 h-5"/></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Contato</label>
                <select required className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={form.contact_id} onChange={(e) => setForm({...form, contact_id: e.target.value})}>
                   <option value="">Selecione um contato</option>
                   {Object.values(contacts).map(c => (
                     <option key={c.id} value={c.id}>{c.name}</option>
                   ))}
                </select>
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Título</label>
                <input required className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={form.title} onChange={(e) => setForm({...form, title: e.target.value})} />
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Data e Hora</label>
                <input required type="datetime-local" className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100" 
                  value={form.scheduled_start} onChange={(e) => setForm({...form, scheduled_start: e.target.value})} />
              </div>
              <div>
                <label className="text-sm text-zinc-400 mb-1 block">Descrição</label>
                <textarea className="w-full bg-zinc-950 border border-zinc-800 rounded p-2 text-sm text-zinc-100 h-20 resize-none" 
                  value={form.description} onChange={(e) => setForm({...form, description: e.target.value})} />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setShowModal(false)}>Cancelar</Button>
                <Button type="submit" variant="default" className="bg-emerald-600 hover:bg-emerald-700 text-white">Agendar</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
