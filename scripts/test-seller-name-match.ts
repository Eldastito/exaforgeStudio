/**
 * TESTE — seletor "já cadastrado?" no Cadastrar vendedor (ajuda a achar a pessoa; nunca une sozinho).
 * Uso: npm run test:seller-name-match
 */
import fs from "fs";
import { similarPeople, personLabel, norm, type DirectoryPerson } from "../src/features/sellers/sellerNameMatch.ts";
let failures = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) failures++; };
const P = (id: string, name: string, matricula: string, stores: string[] = []): DirectoryPerson => ({ id, name, matricula, stores });
const people = [P("1", "Lohan Grande Rio", "10060025", ["Grande Rio"]), P("2", "Vinícius Romão", "10660010", ["Av. brasil"]), P("3", "Vinícius Nascimento", "1003-VN"), P("4", "Maria Souza", "1"), P("5", "Mª", "9")];

check("normaliza acento e caixa", norm("  VINÍCIUS  Romão ") === "vinicius romao");
check("nome igual (com acento diferente) acha", similarPeople("vinicius romao", people).map((p) => p.id).join() === "2");
check("nome contido acha", similarPeople("Lohan", people).map((p) => p.id).join() === "1");
check("nome digitado maior que o cadastrado acha", similarPeople("Maria Souza da Silva", people).map((p) => p.id).join() === "4");
check("só o primeiro nome 'Vinícius' mostra os DOIS (usuário decide, nada é unido)", similarPeople("Vinicius", people).length === 2);
check("sobrenome solto não casa 'Souza' sozinho com 'Silva'", similarPeople("Silva", people).length === 0);
check("menos de 3 letras não sugere nada", similarPeople("Ma", people).length === 0 && similarPeople("", people).length === 0);
check("nome curto cadastrado (<3) não vira coringa", !similarPeople("Maria", people).some((p) => p.id === "5"));
check("limita a 4 sugestões", similarPeople("a", Array.from({ length: 9 }, (_, i) => P(String(i), `Ana ${i}`, String(i)))).length === 0 && similarPeople("ana", Array.from({ length: 9 }, (_, i) => P(String(i), `Ana ${i}`, String(i)))).length === 4);
check("rótulo traz nome, matrícula e lojas", personLabel(people[0]) === "Lohan Grande Rio — 10060025 · Grande Rio" && personLabel(people[3]) === "Maria Souza — 1");

const v = fs.readFileSync("src/features/RetailOpsView.tsx", "utf8");
const modal = v.slice(v.indexOf("function SellerNameModal"), v.indexOf("function SellerDeleteModal"));
check("modal: vincula pela rota de alias de matrícula (não cria vendedor)", /sellers\/\$\{picked\.id\}\/aliases/.test(modal) && /kind: 'matricula'/.test(modal));
check("modal: escolher pessoa não altera a lotação", !/sellers\/\$\{picked\.id\}\/stores/.test(modal));
check("modal: matrícula igual à oficial da pessoa é recusada", /matricula === picked\.matricula/.test(modal));
check("modal: seletor só no cadastro", /allowCodeEdit && people\.length > 0/.test(modal));
process.exit(failures ? 1 : 0);
