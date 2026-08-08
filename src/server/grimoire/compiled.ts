// AUTO-GERADO por scripts/build-grimoire.ts a partir de docs/grimoire/copy/**.
// NAO EDITAR A MAO — rode `npm run grimoire:build` apos alterar o grimoire.
// Fonte compilada e diffavel que o GrimoireService consome (ADR-155 F1.2).

export interface GrimoireRubric {
  id: string;
  estagio: string;
  modulos: string[];
  fonte: string;
  versao: string;
  titulo: string;
  corpo: string;
}

export const GRIMOIRE_INDEX = {
  "schemaVersion": 1,
  "descricao": "Roteamento just-in-time do grimoire de copy: (modulo, estagio) -> rubricas. Consumido pelo GrimoireService (ADR-155 F1.2). Editar aqui ao adicionar/remover rubrica.",
  "estagios": [
    "intake",
    "compose",
    "guardrails",
    "review",
    "glossary"
  ],
  "modulos": {
    "cobranca": {
      "intake": [
        "intake/churn-risk-scoring.md"
      ],
      "compose": [
        "compose/dunning-cadence.md",
        "compose/sequence-timing.md"
      ],
      "guardrails": [
        "guardrails/lgpd-e-whatsapp.md"
      ],
      "review": [
        "review/pre-send-checklist.md"
      ],
      "glossary": [
        "glossary/tom-de-voz.md"
      ]
    },
    "recuperacao": {
      "intake": [
        "intake/churn-risk-scoring.md"
      ],
      "compose": [
        "compose/sales-recovery.md",
        "compose/sequence-timing.md"
      ],
      "guardrails": [
        "guardrails/lgpd-e-whatsapp.md"
      ],
      "review": [
        "review/pre-send-checklist.md"
      ],
      "glossary": [
        "glossary/tom-de-voz.md"
      ]
    },
    "falatu": {
      "intake": [
        "intake/churn-risk-scoring.md"
      ],
      "compose": [
        "compose/save-offer-ladder.md"
      ],
      "guardrails": [
        "guardrails/lgpd-e-whatsapp.md"
      ],
      "review": [
        "review/pre-send-checklist.md"
      ],
      "glossary": [
        "glossary/tom-de-voz.md"
      ]
    }
  }
} as const;

export const GRIMOIRE_RUBRICS: Record<string, GrimoireRubric> = {
  "compose/dunning-cadence.md": {
    "id": "dunning-cadence",
    "estagio": "compose",
    "modulos": [
      "cobranca"
    ],
    "fonte": "coreyhaines31/marketingskills — churn-prevention (dunning cadence). Adaptado, não copiado. MIT.",
    "versao": "1",
    "titulo": "Cadência de cobrança (dunning) — WhatsApp / PIX / boleto",
    "corpo": "# Cadência de cobrança (dunning) — WhatsApp / PIX / boleto\n\n## Quando aplicar\n\nAo compor mensagem de cobrança de fatura/assinatura **vencida ou a vencer** numa cadência multi-tentativa (ADR-152 F4b.3). Antes de escrever, classifique o caso pela rubrica `intake/churn-risk-scoring.md` e distinga **soft decline** (falha recuperável — ex.: PIX não pago ainda, cartão recusado temporário) de **hard decline** (precisa ação nova — ex.: boleto vencido exige 2ª via).\n\n## Deve conter\n\n- **Identificação clara**: valor, referência (o que é) e vencimento. Sem isso a mensagem vira spam.\n- **Um CTA único e acionável**: link PIX / copia-e-cola / 2ª via do boleto. Um só caminho por mensagem.\n- **Tom escalando com a régua** (nunca começa duro):\n  - **D0 (vencimento)** — lembrete gentil, assume esquecimento. \"Passando pra lembrar…\"\n  - **D+3** — reforço prático, facilita o pagamento. Reenvia o PIX.\n  - **D+7** — objetivo, cita consequência factual pactuada (ex.: suspensão do serviço), sem ameaça.\n  - **D+10** — última tentativa amigável + caminho de negociação/contato humano.\n- **Adaptação soft vs hard**: soft decline → \"é só finalizar o PIX\"; hard decline → \"seu boleto venceu, aqui está a 2ª via atualizada\".\n- **Rodapé de opt-out** e remetente identificado (ver `guardrails/lgpd-e-whatsapp.md`).\n\n## Nunca fazer\n\n- **Culpar, envergonhar ou ameaçar** o cliente (nem \"negativação\" fora do que a lei e o contrato permitem).\n- Inventar **juros, multa ou encargo** não pactuados.\n- Enviar **mais de uma cobrança no mesmo dia** ou fora de janela/horário (ver `compose/sequence-timing.md`).\n- Continuar a régua depois do **pagamento confirmado** ou de **opt-out**.\n- Prometer o que não pode (ex.: \"liberamos agora\" sem confirmação real do pagamento — padrão 8, evidência primeiro).\n\n## Exemplos (PT-BR)\n\n- **D0:** \"Oi, {nome}! 👋 Passando pra lembrar que sua fatura de {valor} vence hoje. Se quiser, é só pagar no PIX: {link}. Qualquer dúvida, tô por aqui.\"\n- **D+3:** \"{nome}, tudo certo? Sua fatura de {valor} está em aberto desde {data}. Pra facilitar, deixei o PIX aqui de novo: {link} 🙂\"\n- **D+7:** \"{nome}, sua fatura de {valor} venceu em {data}. Pra manter o serviço ativo, o pagamento pode ser feito por aqui: {link}. Se precisar de outra opção, me avisa.\"\n- **D+10:** \"{nome}, essa é a última lembrança automática sobre a fatura de {valor}. Quer resolver ou combinar outra forma? Me chama que a gente ajeita. 🤝\"\n\n## Lições (post-mortem)\n\n_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_"
  },
  "compose/sales-recovery.md": {
    "id": "sales-recovery",
    "estagio": "compose",
    "modulos": [
      "recuperacao"
    ],
    "fonte": "coreyhaines31/marketingskills — marketing-psychology + copywriting (re-engagement / permission-based re-open). Adaptado, não copiado. MIT.",
    "versao": "1",
    "titulo": "Recuperação comercial — reabrir conversa parada sem virar cobrança",
    "corpo": "# Recuperação comercial — reabrir conversa parada sem virar cobrança\n\n> Copy pra retomar um deal que esfriou no funil (proposta/orçamento/negociação\n> sem resposta). Recuperação comercial **não é cobrança**: aqui o objetivo é\n> preservar a relação e reabrir o diálogo, não arrancar um pagamento. Destila\n> `marketing-psychology` (reciprocidade, prova de compromisso, aversão à perda\n> ética) + `copywriting` (uma ideia por mensagem, CTA único) pro contexto\n> WhatsApp/BR/LGPD. Aplicada pela variante `calibrated` do `SalesRecoveryCopy`.\n\n## Quando aplicar\n\nQuando o `SalesStalledDealDetector` marca um ticket comercial parado (stage\n`proposta`/`orcamento`/`negociacao`/`qualificado`, dias sem update ≥ limite) e o\nplaybook `sales_recovery_v1` vai **propor** (com approval humano) uma mensagem de\nreengajamento. Vale pra tentativa 1, 2 e 3 da cadência (F4c.3) — o **tom suaviza\na cada tentativa**, nunca endurece.\n\n## Deve conter\n\n- **Uma pergunta aberta só** (CTA único): \"faz sentido retomar?\", \"quer que eu\n  revise algo?\". Nunca duas perguntas competindo.\n- **Referência específica ao que ficou pendente** (prova de compromisso /\n  consistência): \"a proposta que te enviei\", \"onde a gente parou na negociação\"\n  — mostra que há um fio concreto, não um disparo genérico.\n- **Reciprocidade concreta e honesta**: oferecer ajustar/revisar o que já existe\n  (\"posso ajustar o que fizer sentido\"), sem inventar vantagem nova.\n- **Permissão e saída fácil** (respeito à autonomia, LGPD): deixar claro que\n  responder é opcional e que dá pra retomar depois — \"sem pressão\", \"se preferir\n  falar mais pra frente, é só me avisar\".\n- **Fechamento respeitoso na última tentativa**: stand-by cordial que mantém a\n  porta aberta (\"deixo em stand-by; quando quiser retomar, me chama\").\n- Mensagem curta (≤ 200 caracteres), tom cordial-brasileiro, no máximo 1 emoji\n  sutil.\n\n## Nunca fazer\n\n- **Urgência falsa**: \"última chance\", \"oferta expira hoje\", \"só até amanhã\" —\n  proibido (não há prazo real; seria dark pattern e fere o informativo LGPD/CDC).\n- **Tom de cobrança/ameaça**: falar em dívida, \"pendência\", consequência, ou\n  qualquer coisa que soe a coação.\n- **Desconto/vantagem não autorizada**: nunca prometer preço, brinde ou condição\n  que o time comercial não aprovou (o gerador não decide comercial).\n- **Culpar o cliente pelo silêncio** (\"você sumiu\", \"cadê você\") ou soar\n  ressentido na 3ª tentativa.\n- **Endurecer com a repetição**: a 2ª/3ª tentativa é MAIS leve que a 1ª, nunca\n  mais insistente.\n- Trocar o canal ou a regra de WhatsApp — a rubrica calibra o **texto**, não o\n  transporte.\n\n## Exemplos (PT-BR)\n\n- **Proposta parada (tentativa 1):** \"Oi, Ana! 🙂 Fiquei de retomar aqui sobre a\n  proposta que te enviei — ela segue de pé e posso ajustar o que fizer sentido.\n  Quer que eu revise algum ponto?\"\n- **Negociação parada (tentativa 1):** \"Oi, Ana! 🙂 Quer retomar de onde a gente\n  parou? Se ficou alguma dúvida ou algo pra ajustar, é só me dizer — sem pressa.\"\n- **Tentativa 2 (mais leve):** \"Oi, Ana! 🙂 Sei que a rotina corre — só passando\n  pra ver se ainda faz sentido a gente conversar. Sem pressão nenhuma.\"\n- **Tentativa 3 (stand-by cordial):** \"Oi, Ana! 🙂 Vou deixar essa conversa em\n  stand-by por aqui — quando quiser retomar, é só me chamar. Obrigado! 🙏\"\n\n## Lições (post-mortem)\n\n_(vazio — acumula via F1.4 quando o A/B (F3.2) marcar a variante calibrada como\npior que o control; cada lição entra datada e passa a ser injetada junto com a\nrubrica.)_"
  },
  "compose/save-offer-ladder.md": {
    "id": "save-offer-ladder",
    "estagio": "compose",
    "modulos": [
      "falatu"
    ],
    "fonte": "coreyhaines31/marketingskills — churn-prevention (cancel flow + save offers). Adaptado, não copiado. MIT.",
    "versao": "1",
    "titulo": "Ladder de save offers (retenção antes do cancelamento/reembolso)",
    "corpo": "# Ladder de save offers (retenção antes do cancelamento/reembolso)\n\n## Quando aplicar\n\nQuando o cliente **pede cancelamento ou reembolso** do FalaTu (ADR-154 F2.2 E), **antes** de executar o hard cancel/refund. O objetivo é **reter oferecendo valor**, não criar fricção. Primeiro **capture o motivo** (uma pergunta curta), depois roteie a oferta pelo motivo. Ofertas de downgrade/pausa ligam no entitlement (ADR-153).\n\n## Deve conter\n\n- **Captura do motivo** antes de qualquer oferta: \"Posso te perguntar rapidinho o que motivou?\"\n- **Oferta mapeada ao motivo** (ladder — ofereça o degrau certo, não todos):\n  - **Preço/custo** → desconto temporário **ou** downgrade pro tier menor (ADR-153).\n  - **Pouco uso / não engatou** → mini-onboarding, dica de uso, ou **pausa** de 1 ciclo.\n  - **Faltou uma feature** → status no roadmap + alternativa atual, se houver.\n  - **Problema técnico** → encaminhar suporte e **resolver** antes de aceitar a saída.\n- **Saída sempre limpa**: se recusar a oferta, o fluxo segue direto pro cancelamento/reembolso — sem novo obstáculo.\n- **Transparência**: deixar claro que dentro da **garantia de 7 dias** o reembolso é um direito (CDC Art. 49).\n\n## Nunca fazer\n\n- **Bloquear ou atrasar a garantia de 7 dias** com a oferta — dentro da janela o reembolso é direito, a oferta é opcional e a recusa vai **direto** ao estorno (ADR-154 RN-E; RN-155 §5).\n- Criar **fricção pra cancelar** (mais de um passo de retenção, esconder o botão, \"fale com um atendente\" obrigatório).\n- Oferta **enganosa** (desconto que não existe, \"última chance\" falsa).\n- Insistir depois do **\"não\"** — uma oferta, uma recusa, encerra.\n\n## Exemplos (PT-BR)\n\n- **Captura:** \"Poxa, que pena que você quer sair 😕 Posso te perguntar rapidinho o que pesou? (preço, pouco uso, faltou algo, ou problema técnico)\"\n- **Preço → downgrade:** \"Se o valor apertou, dá pra continuar no plano {menor} por {valor} — mantém o essencial e reduz o custo. Quer que eu troque, ou prefere seguir com o cancelamento?\"\n- **Pouco uso → pausa:** \"Se foi falta de tempo pra usar, posso **pausar** sua conta por 1 mês sem cobrança — você volta de onde parou. Te serve, ou seguimos com o cancelamento?\"\n- **Recusa (saída limpa):** \"Tranquilo, respeito totalmente. Vou seguir com o cancelamento. Como você está dentro dos 7 dias de garantia, o reembolso é automático — confirma que quer prosseguir?\"\n\n## Lições (post-mortem)\n\n_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_"
  },
  "compose/sequence-timing.md": {
    "id": "sequence-timing",
    "estagio": "compose",
    "modulos": [
      "cobranca",
      "recuperacao"
    ],
    "fonte": "coreyhaines31/marketingskills — sms + emails (lifecycle sequence timing). Adaptado, não copiado. MIT.",
    "versao": "1",
    "titulo": "Timing de sequência (o \"quando\" e o espaçamento)",
    "corpo": "# Timing de sequência (o \"quando\" e o espaçamento)\n\n## Quando aplicar\n\nAo definir **quando** e **com que espaçamento** as mensagens de uma cadência multi-tentativa saem (Cobrança F4b.3, Recuperação F4c.3). Governa o ritmo; o conteúdo de cada passo vem da rubrica de `compose/` do tipo (ex.: `dunning-cadence`). O canal do ZappFlow é **WhatsApp-first** — o framework de sequência transfere, as regras de canal (janela/template) são próprias e vivem em `guardrails/lgpd-e-whatsapp.md`.\n\n## Deve conter\n\n- **Horário humano**: enviar em horário comercial no **fuso da org** (default America/Sao_Paulo). Nada de madrugada.\n- **Espaçamento crescente**: tentativas próximas no início, cada vez mais espaçadas (ex.: D0 → D+3 → D+7 → D+10). Evita fadiga.\n- **Uma por dia por cadência, no máximo**: nunca empilhar mensagens do mesmo fluxo no mesmo dia.\n- **Parada dura por evento**: pagamento confirmado, resposta positiva, objetivo atingido ou opt-out **encerram** a sequência imediatamente.\n- **Teto de tentativas** + escalonamento pra humano quando esgota (padrão 3: terminação garantida; reusa o approval humano das fatias 4b/4c).\n- **Cobrança formal**: preferir dias úteis; evitar fim de semana/feriado pro passo \"sério\" da régua.\n\n## Nunca fazer\n\n- Enviar **de madrugada** ou fora do horário comercial do fuso da org.\n- **Duas mensagens da mesma cadência no mesmo dia.**\n- Ignorar o **fuso** (mandar 8h no horário do servidor ≠ 8h do cliente).\n- Continuar a sequência após **opt-out** ou **objetivo atingido** (padrão 8: o evento real manda, não o cronograma).\n\n## Exemplos (PT-BR)\n\n- **Espaçamento cobrança:** D0 (vencimento, manhã) → D+3 → D+7 → D+10; depois disso, escala pra humano.\n- **Espaçamento recuperação:** D0 (mesmo dia do abandono/perda) → D+2 → D+5; para no engajamento ou opt-out.\n- **Regra de corte:** \"pagamento confirmado no D+2 → cancela D+7 e D+10 automaticamente.\"\n\n## Lições (post-mortem)\n\n_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_"
  },
  "glossary/tom-de-voz.md": {
    "id": "tom-de-voz",
    "estagio": "glossary",
    "modulos": [
      "cobranca",
      "recuperacao",
      "falatu"
    ],
    "fonte": "Interno ZappFlow",
    "versao": "1",
    "titulo": "Tom de voz base do ZappFlow",
    "corpo": "# Tom de voz base do ZappFlow\n\n## Quando aplicar\n\nCamada **global** de tom, herdada por toda composição. A org pode **sobrescrever** via `organization_settings.brand_voice_context` (ADR-155 F1.3) — quando houver contexto por-org, ele prevalece sobre o default aqui.\n\n## Deve conter\n\n- **Respeitoso e direto**, brasileiro, sem juridiquês nem corporativês.\n- **Tratamento**: \"você\" (nunca \"senhor(a)\" robótico por padrão; a org pode ajustar).\n- **Claro e curto**: uma ideia por mensagem, frases curtas, sem parágrafo denso no WhatsApp.\n- **Humano**: pode usar 1 emoji com parcimônia quando cabe o tom; nunca substitui conteúdo por emoji.\n- **Honesto**: não promete o que não pode; incerteza é dita, não escondida (padrão 5).\n\n## Nunca fazer\n\n- **CAPS LOCK**, excesso de exclamação ou emoji.\n- **Gíria pesada** ou informalidade que soe desrespeitosa.\n- Tom **robótico, ameaçador ou passivo-agressivo**.\n- Jargão interno (nomes de fatia, tabela, sistema) vazando pro cliente.\n\n## Exemplos (PT-BR)\n\n- **Preferir:** \"Oi, {nome}! Tudo bem? Passando pra avisar que…\"\n- **Evitar:** \"PREZADO CLIENTE, INFORMAMOS QUE V.SA. ENCONTRA-SE EM DÉBITO!!!\"\n- **Vocabulário:** preferir \"fatura em aberto\" a \"inadimplência\"; \"combinar\" a \"renegociar dívida\".\n\n## Lições (post-mortem)\n\n_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_"
  },
  "guardrails/lgpd-e-whatsapp.md": {
    "id": "lgpd-e-whatsapp",
    "estagio": "guardrails",
    "modulos": [
      "cobranca",
      "recuperacao",
      "falatu"
    ],
    "fonte": "Interno ZappFlow",
    "versao": "1",
    "titulo": "Guardrails transversais — LGPD + WhatsApp",
    "corpo": "# Guardrails transversais — LGPD + WhatsApp\n\n## Quando aplicar\n\n**Sempre.** Regras duras que valem pra toda composição outbound, independente de módulo ou estágio. Toda rubrica de `compose/` herda estes limites; o `review/pre-send-checklist.md` confere que foram respeitados.\n\n## Deve conter\n\n- **Base legal (LGPD)**: comunicação só com base legal válida (execução de contrato Art. 7 pra cobrança; consentimento/legítimo interesse quando aplicável). Envio de leitura sensível segue `dados_sensiveis` (Art. 11); envio em si, `comunicacoes` (Art. 7).\n- **Opt-out honrado e fácil**: toda cadência oferece saída (\"responda SAIR pra não receber mais\"), e o opt-out **encerra** a sequência e é registrado. Reusa o opt-out das fatias 4c.2.\n- **Janela do WhatsApp**: dentro da janela de 24h (sessão iniciada pelo cliente) → mensagem livre; fora da janela → **template aprovado** obrigatoriamente. O framework de copy transfere; a regra de canal é do WhatsApp e não se burla.\n- **Remetente identificado** e tom respeitoso.\n- **Minimização**: só o dado necessário na mensagem; `maskIdentifier` em audit (Fase 32).\n\n## Nunca fazer\n\n- Enviar **sem base legal / sem opt-in** quando exigido.\n- **Ignorar opt-out** (uma vez que saiu, não recebe mais daquela cadência).\n- Mandar **template não aprovado fora da janela** de 24h.\n- Expor **dado sensível** desnecessário (valor de dívida a terceiros, dado de saúde, etc.).\n- Tom de **ameaça, coação ou constrangimento**.\n\n## Exemplos (PT-BR)\n\n- **Rodapé de opt-out:** \"Se não quiser mais receber estas mensagens, responda SAIR.\"\n- **Dentro vs. fora da janela:** cliente respondeu hoje → texto livre; passou 24h sem resposta → só template aprovado (\"Olá {nome}, temos uma atualização sobre sua fatura…\").\n\n## Lições (post-mortem)\n\n_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_"
  },
  "intake/churn-risk-scoring.md": {
    "id": "churn-risk-scoring",
    "estagio": "intake",
    "modulos": [
      "cobranca",
      "recuperacao",
      "falatu"
    ],
    "fonte": "coreyhaines31/marketingskills — churn-prevention (health-score model). Adaptado, não copiado. MIT.",
    "versao": "1",
    "titulo": "Score de risco de churn (classificar antes de agir)",
    "corpo": "# Score de risco de churn (classificar antes de agir)\n\n## Quando aplicar\n\nNo **intake** — antes de decidir escrever/abordar — pra estimar a **temperatura/risco** do cliente e calibrar o tom. É também o modelo de referência do **ChurnRiskDetector** (ADR-155 F4), que publica `business_signal` (`churn_risk_high`). Aqui a rubrica define **os sinais e pesos**; o detector implementa a query.\n\n## Deve conter\n\n- **Score 0–100 derivado por query** sobre sinais que já existem — **nunca contador mutável** (RN-004). Sinais líderes sugeridos (calibrar depois — padrão 10, gate só bloqueia após calibração):\n  - Pagamento atrasado / falha recente (peso alto).\n  - Silêncio no canal (sem resposta a N mensagens).\n  - Uso caindo vs. baseline da própria org.\n  - Tickets/reclamações recentes ou NPS baixo.\n  - Fim de ciclo/contrato se aproximando.\n- **Explicabilidade rica** (padrão 5): cada score acompanha **por que subiu** (quais sinais, com `confidence` e `source_ref`). Proibido codificar certeza que não se tem — baixa `confidence` e marca o status.\n- **Faixas → ação sugerida** (sugerir, não agir): 0–39 baixo (rotina), 40–69 médio (atenção/priorizar), 70–100 alto (cadência de retenção + sinal na operação, ADR-152 aba Operações).\n- **Dedupe** via `dedupe_key` no `business_signal` (convenção nº 12) — nunca tabela própria de alertas.\n\n## Nunca fazer\n\n- **Contador mutável** de risco (é sempre derivado por query — RN-004).\n- **Decidir/agir sozinho**: o score **sugere**, humano/regra decide (RN-014). Não cancela, não dá desconto, não renova.\n- **Inventar sinal** sem evidência (sem `source_ref`, não entra no score).\n- Criar tabela de \"alertas\" própria em vez de `business_signals` (ADR-136).\n\n## Exemplos (PT-BR)\n\n- **Explicação de score:** \"Risco 78/100 (alto): fatura atrasada há 9 dias (peso 40, alta confiança) + sem resposta às últimas 3 mensagens (peso 25) + uso −60% vs. mês passado (peso 13).\"\n- **Faixa → ação:** \"78 → alto: entra na cadência de retenção e publica `churn_risk_high` na operação; humano confirma a ação.\"\n\n## Lições (post-mortem)\n\n_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_"
  },
  "review/pre-send-checklist.md": {
    "id": "pre-send-checklist",
    "estagio": "review",
    "modulos": [
      "cobranca",
      "recuperacao",
      "falatu"
    ],
    "fonte": "Interno ZappFlow",
    "versao": "1",
    "titulo": "Checklist pré-envio (auto-crítica antes de emitir)",
    "corpo": "# Checklist pré-envio (auto-crítica antes de emitir)\n\n## Quando aplicar\n\nDepois de compor e **antes de emitir** qualquer mensagem outbound. É a camada de review do grimoire — o redator (ou um gate) roda este checklist como último portão. Liga nos padrões 2 e 8 (`docs/patterns/agentic-pipeline-lessons.md`): julgamento subordinado a regra + só envia com o essencial verificado.\n\n## Deve conter\n\nChecklist — **todo item precisa passar**:\n\n1. **CTA único e acionável?** Um caminho claro (link/ação), não vários.\n2. **Dados corretos e reais?** Valor, vencimento, nome — sem número inventado (anti-alucinação; se não tem o dado, não afirma).\n3. **Tom certo pro estágio?** Bate com a régua da rubrica de `compose/` (não começou duro).\n4. **Guardrails ok?** Passou por `guardrails/lgpd-e-whatsapp.md`: base legal, opt-out presente, dentro da janela/template, sem dado sensível a mais.\n5. **Timing ok?** Horário/fuso/espaçamento conforme `compose/sequence-timing.md`; não é a 2ª do dia.\n6. **Evento de parada checado?** Não está enviando após pagamento/opt-out/objetivo atingido.\n\n## Nunca fazer\n\n- **Emitir sem passar o checklist inteiro.**\n- **Marcar item como ok sem verificar** (marcar por marcar derrota o gate).\n- Deixar o modelo \"resgatar\" um item que uma regra determinística já reprovou (padrão 2: regra tem veto).\n\n## Exemplos (PT-BR)\n\n- **Reprovado (para o envio):** \"Item 2 falhou — a mensagem cita 'multa de R$ 20' mas não há multa pactuada. Corrigir antes de enviar.\"\n- **Aprovado:** \"6/6 ok → pode emitir.\"\n\n## Lições (post-mortem)\n\n_(vazio — acumula via F1.4 quando A/B ou `business_signal` marcar cadência ruim; cada lição entra datada e passa a ser injetada junto com a rubrica.)_"
  }
};
