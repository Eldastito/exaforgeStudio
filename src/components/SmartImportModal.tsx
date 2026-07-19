import React, { useState } from 'react';
import { UploadCloud, X, Trash2, Loader2, FileText, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/src/lib/api';
import { toast } from '@/src/lib/toast';

interface Field { key: string; label: string; hint?: string; }

/**
 * Modal reusável de "Importar PDF/imagem" (ADR-101). A IA extrai as linhas no
 * schema da tela; o dono REVISA numa tabela editável (preview obrigatório) e só
 * então confirma. O commit real fica por conta da tela (onCommit), reusando o
 * backend de importação que já existe.
 */
export function SmartImportModal({ type, title, onClose, onCommit }: {
  type: string;
  title: string;
  onClose: () => void;
  onCommit: (rows: any[]) => Promise<{ ok: boolean; message?: string }>;
}) {
  const [extracting, setExtracting] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [fields, setFields] = useState<Field[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');

  const onFile = async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setExtracting(true);
    setRows([]); setWarnings([]);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('type', type);
      const r = await apiFetch('/api/import/extract', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast.error(d?.error || 'Não consegui ler o arquivo.'); return; }
      setFields(Array.isArray(d.fields) ? d.fields : []);
      setRows(Array.isArray(d.rows) ? d.rows : []);
      setWarnings(Array.isArray(d.warnings) ? d.warnings : []);
      if (!d.rows?.length) toast.error('Nenhuma linha encontrada no arquivo.');
    } catch { toast.error('Falha ao enviar o arquivo.'); }
    finally { setExtracting(false); }
  };

  const setCell = (i: number, key: string, val: string) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, [key]: val } : r));
  const removeRow = (i: number) => setRows(rs => rs.filter((_, idx) => idx !== i));

  const doCommit = async () => {
    if (!rows.length) return;
    setCommitting(true);
    try {
      const res = await onCommit(rows);
      if (res.ok) { toast.success(res.message || 'Importado com sucesso.'); onClose(); }
      else toast.error(res.message || 'Falha ao importar.');
    } catch { toast.error('Falha ao importar.'); }
    finally { setCommitting(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-zinc-800">
          <h3 className="text-lg font-semibold text-zinc-100 flex items-center gap-2"><UploadCloud className="w-5 h-5 text-indigo-400" /> {title}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200"><X className="w-5 h-5" /></button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-zinc-400">Envie um <b>PDF</b> ou <b>imagem/foto</b> (lista de {title.toLowerCase()}). A IA extrai os dados e você <b>revisa antes de salvar</b>.</p>

          <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-zinc-700 rounded-lg p-6 cursor-pointer hover:border-indigo-500/40">
            {extracting ? <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" /> : <FileText className="w-6 h-6 text-zinc-400" />}
            <span className="text-sm text-zinc-300">{extracting ? 'Lendo o arquivo…' : fileName || 'Clique para escolher PDF ou imagem'}</span>
            <input type="file" accept=".pdf,application/pdf,image/*" className="hidden" disabled={extracting}
              onChange={e => onFile(e.target.files?.[0] || null)} />
          </label>

          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-200/80">
                <p className="font-medium mb-1">A IA sinalizou pontos para conferir:</p>
                <ul className="list-disc list-inside space-y-0.5">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </div>
            </div>
          )}

          {rows.length > 0 && (
            <>
              <p className="text-xs text-zinc-500">{rows.length} linha(s) extraída(s). Confira e corrija antes de importar — nada é salvo até você confirmar.</p>
              <div className="overflow-x-auto border border-zinc-800 rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-zinc-950/60 text-left text-xs text-zinc-500">
                      {fields.map(f => <th key={f.key} className="p-2 font-medium">{f.label}</th>)}
                      <th className="p-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-t border-zinc-800/60">
                        {fields.map(f => (
                          <td key={f.key} className="p-1">
                            <input value={r[f.key] || ''} onChange={e => setCell(i, f.key, e.target.value)}
                              className="w-full bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-100 min-w-[90px]" />
                          </td>
                        ))}
                        <td className="p-1 text-center">
                          <button onClick={() => removeRow(i)} className="text-zinc-500 hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-zinc-800">
          <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-300 hover:text-zinc-100">Cancelar</button>
          <button onClick={doCommit} disabled={!rows.length || committing || extracting}
            className="px-4 py-2 text-sm rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-50 inline-flex items-center gap-2">
            {committing && <Loader2 className="w-4 h-4 animate-spin" />} Importar {rows.length || ''} linha(s)
          </button>
        </div>
      </div>
    </div>
  );
}
