// "Já existe alguém parecido?" — só aponta; quem decide é a pessoa que cadastra (nunca une sozinho).
export type DirectoryPerson = { id: string; name: string; matricula: string; stores: string[] };

export const norm = (v: unknown): string =>
  String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

export const personLabel = (p: DirectoryPerson): string => `${p.name} — ${p.matricula}${p.stores.length ? ` · ${p.stores.join(", ")}` : ""}`;

/** Nome digitado (≥3 letras) igual ou contido no nome de alguém da rede, ou o contrário. Sem fuzzy, sem sobrenome solto. */
export function similarPeople(typed: string, people: DirectoryPerson[], max = 4): DirectoryPerson[] {
  const t = norm(typed);
  if (t.length < 3) return [];
  return people.filter((p) => { const n = norm(p.name); return n === t || n.includes(t) || (n.length >= 3 && t.includes(n)); }).slice(0, max);
}
