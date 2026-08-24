# LEGACY-REDUCTION-PLAN — simplificar sem quebrar produção (Fase 0)

Como reduzir a complexidade VISÍVEL do ZapFlow sem apagar capacidade nem quebrar o fluxo atual.
Regra fundante (PRD §52/§80): **Sidebar menor ≠ deletar backend.** Nada sai de produção por preferência
estética; só sai do 1º nível quando a telemetria provar substituição, e só deprecia após período de
segurança. Reusa `LegacyReductionService` (ADR-163 F12/F16, gate advisório por telemetria) — **sem
motor de retirada novo**.

---

## 1. Sequência obrigatória (por elemento)

```
telemetria (baseline)
   ↓
nova experiência (flag, shadow)
   ↓
adoção medida (UARR, uso, erro, abandono)
   ↓
comparação legado × novo (A/B §74)
   ↓
retirada do 1º nível (vai pra "Explorar")
   ↓
período de segurança (tela continua acessível)
   ↓
deprecação (só com telemetria comprovando substituição)
```

O `LegacyReductionService` já implementa o gate ADVISÓRIO: ele **sinaliza** um candidato à retirada em
`business_signals` quando a telemetria prova substituição — nunca remove tela sozinho (§112 do ADR-163).

## 2. Classificação por elemento (das telas do `SIDEBAR-UX-AUDIT.md`)

| Classe | O que significa | Elementos (hipótese) |
| --- | --- | --- |
| **MANTER** | essencial e usado | Vendas, Agenda, Caixa, Catálogo, Atendimento, Comigo, verticais |
| **ESCONDER** | necessário, 2º nível | Radar B2B, Vision, Radar Execução, Integrações, Manifesto, Escuta |
| **AUTOMATIZAR** | ação humana some | Campanhas, Cadências, Configurações (via missão/inferência) |
| **CONVERSAR** | Fala Tu primeiro | Relatórios, Diretor IA, Revenue Intelligence, Jurídica |
| **FUNDIR** | duas viram uma | Tarefas→Missões, Executando→Missões, Insights/Dashboard→Hoje |
| **DEPRECAR** | só com telemetria | *(nenhum nesta fase)* |

## 3. Candidato principal: "Executando" → "Missões" (§25)
`ExecutionResultsService` alimenta a tela "Executando". A hipótese é que Missões absorve integralmente
(Planejando/Executando/Em risco/Aguardando você/Concluídas). **Plano:** manter "Executando"
funcionando; "Missões" nasce em shadow; A/B; só quando a telemetria mostrar que Missões cobre o uso de
"Executando" é que "Executando" sai do 1º nível — o serviço backend permanece.

## 4. Radar & Decision Intelligence: mudar exposição, não função (§26/§27)
`RadarService` e `DecisionEngine` continuam rodando. Seus achados passam a aparecer em "Hoje"/Fala
Tu/Missões/Resultados. Os menus "Radar de Execução IA" e "Diretor IA" viram candidatos a ESCONDER —
capacidade invisível, zero perda de função. Master Admin mantém acesso direto.

## 5. Salvaguardas
- **Feature flags** (§53): toda mudança atrás de flag opt-in (`mission_simplified_nav_enabled` etc.).
- **A/B (§74):** grupo A (nav atual) × grupo B (simplificada); mede tempo/cliques/erro/abandono/ajuda/
  **resultado**/satisfação/**taxa de retorno ao legado**.
- **Retorno ao legado** é KPI de segurança: se o usuário volta pro menu antigo, a nova experiência falhou.
- **Nada de big-bang (§80):** o fluxo antigo continua funcional até o novo estar comprovado.
- **Deprecação** exige: telemetria de substituição + período de segurança + decisão explícita.

## 6. Métrica de sucesso (não perseguir estética)
Reduzir 1º nível só quando os dados provarem que **não** reduz descoberta nem resultado (§50/§84).
Objetivo quantitativo inicial (após baseline F0): −50% de interações nas 10 jornadas top; −30% de
elementos primários de nav **se** a telemetria provar que não fere descoberta/resultado.
