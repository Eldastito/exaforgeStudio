/**
 * TESTE (fiação da UI) — a aba Comissão do GERENTE de loja reaproveita a corrida da rede, só da loja dele
 * ----------------------------------------------------------------------------
 * Decisão do dono (TOULON, 04/10): a tela de comissão que já existe na Operação da Rede é a MESMA que o gerente usa,
 * escopada à loja dele; mudar a regra = PROPOSTA que o dono confirma (backend em test:retail-commission-governance).
 * Como o repo não tem teste de componente, este teste prova a fiação no código-fonte (padrão dos wiring-tests):
 *   - o ramo "só da rede" (403 nas regras) deixa de ser um beco sem saída: carrega as lojas dele e mostra RaceSection `manager`;
 *   - modo gerente: sem "Todas as lojas"/"Rede toda", sem importar por IA, sem gerar prévia, sem "fonte manual", sem cartões da rede;
 *   - salvar no modo gerente POSTa a proposta (submit) e NUNCA faz PUT do plano;
 *   - o dono (sem `manager`) mantém o comportamento de antes (PUT do plano, import, prévia).
 *
 * Uso:  npm run test:commission-manager-view
 */
import fs from "fs";
import path from "path";

const src = fs.readFileSync(path.join(process.cwd(), "src/features/RetailOpsView.tsx"), "utf8");
let failures = 0;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; };
const block = (start: string, end: string) => { const i = src.indexOf(start); const j = src.indexOf(end, i + start.length); return i >= 0 && j > i ? src.slice(i, j) : ""; };

const tab = block("function CommissionTab()", "\nfunction ");
const modal = block("function RacePlanModal(", "\nfunction ");
const race = block("function RaceSection(", "\nfunction ");
const panel = block("function MyCommissionProposals(", "\nfunction ");

check("o ramo da rede carrega as lojas do gerente ANTES de sair (stores escopadas)", /__forbidden\) \{ setStores\(/.test(tab));
check("gerente vê a corrida da loja (RaceSection manager) e as próprias propostas", /if \(networkOnly\) \{[\s\S]*<RaceSection stores=\{stores\} manager \/>[\s\S]*<MyCommissionProposals stores=\{stores\} \/>/.test(tab));
check("o aviso explica: só a sua loja, mudança só vale quando o dono confirmar", /propor mudanças[\s\S]*só valem depois que o dono confirmar/.test(tab));

check("modal: modo gerente envia PROPOSTA (POST proposals com submit:true)", /if \(manager\) \{[\s\S]*commission\/policies\/proposals[\s\S]*submit: true[\s\S]*return;/.test(modal));
check("modal: o PUT do plano vem DEPOIS do ramo do gerente (gerente nunca salva direto)", modal.indexOf("if (manager) {") > 0 && modal.indexOf("method: 'PUT'") > modal.indexOf("if (manager) {"));
check("modal: gerente não vê 'Rede toda' nem a importação por IA", /\{!manager && <option value="">Rede toda/.test(modal) && /manager\s*\?[\s\S]*: <CommissionImportPanel/.test(modal));
check("modal: avisa que a mudança não vale na hora e aceita um motivo", /não vale na hora/.test(modal) && /Por que está pedindo a mudança/.test(modal));
check("modal: botão vira 'Enviar para aprovação do dono'", /Enviar para aprovação do dono/.test(modal));

check("corrida: gerente não vê 'Todas as lojas' e a loja única já vem selecionada", /\{!manager && <option value="">Todas as lojas/.test(race) && /manager && stores\.length === 1/.test(race));
check("corrida: botão vira 'Propor mudança' e a prévia da rede some pro gerente", /manager \? 'Propor mudança' : 'Configurar corrida'/.test(race) && /race && !manager && <button onClick=\{createRun\}/.test(race));
check("corrida: cartões de rede (vendedores a identificar/duplicados) e 'fonte manual' somem pro gerente", /\{!manager && <div className="mt-2"><UnidentifiedSellersCard/.test(race) && /st\.storeId && !manager && \(/.test(race));
check("corrida: o modal recebe `manager`", /<RacePlanModal stores=\{stores\} month=\{month\} manager=\{manager\}/.test(race));

check("propostas: lista status (aguardando/confirmada/recusada) e o motivo da recusa", /Aguardando o dono/.test(panel) && /Confirmada — já vale/.test(panel) && /archiveReason/.test(panel));
check("propostas: só dá pra retirar a PRÓPRIA proposta ainda pendente", /mine && \(p\.status === 'pending_confirmation' \|\| p\.status === 'draft'\)/.test(panel));

const owner = block("function OwnerCommissionProposals(", "\nfunction ");
check("dono: painel de propostas pendentes aparece só no modo rede (antes da corrida) e some quando não há nenhuma", /<OwnerCommissionProposals stores=\{stores\} \/>\s*\{\/\* Corrida do mês/.test(tab) && /if \(items\.length === 0\) return null/.test(owner));
check("dono: vê O QUE MUDA campo a campo contra o plano em vigor antes de confirmar", /commission\/plan\?storeId=/.test(owner) && /O que muda/.test(owner));
check("dono: confirma (com aviso) ou recusa com MOTIVO — as rotas só da rede", /proposals\/\$\{p\.id\}\/\$\{action\}/.test(owner) && /Motivo da recusa/.test(owner));

console.log(`\n${failures === 0 ? "✅" : "❌"} commission-manager-view: ${failures === 0 ? "todos os checks" : failures + " falha(s)"}`);
process.exit(failures === 0 ? 0 : 1);
