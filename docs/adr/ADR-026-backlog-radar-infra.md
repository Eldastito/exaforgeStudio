# ADR-026 — Backlog Radar infra: rate limit público, SLA por canal, integridade de respostas concorrentes, anexo binário e pilar Receita medido

**Status:** Implementado e testado (determinístico; envio real de e-mail com anexo não exercitado contra o Gmail de verdade — mesma classe de ressalva da ADR-017, com o detalhe de codificação comprovado por teste de bytes).
**Origem:** pacote 3 do levantamento de pendências — itens 08, 09, 14, 20 e 21 do backlog aprovado.

## Item 08 — Anti-spam na rota pública: o honeypot JÁ EXISTIA (segundo item desatualizado do backlog)

Mesma lição do item 01 (ADR-025): a ideia registrada na ADR-009 foi implementada na ADR-012 e o backlog não refletia isso. `POST /sessions` já tinha honeypot (campo isca `website` → 201 falso com token de mentira, sem criar nada) e rate limit agressivo (10/h por IP), e os endpoints de resposta já tinham 300/h. **O que faltava de verdade**: vários endpoints sem limite nenhum (sondagem de token em `GET /sessions/:token` e `/respond/:token`, `consent`/`complete`/`result` repetidos). Fechado com um teto genérico por IP na rota inteira (`router.use`, 600/h) — generoso o bastante para nunca atrapalhar um respondente real, e os limites específicos continuam valendo por cima.

## Item 09 — SLA por canal (IVC)

A ADR-010 usou um limiar único por organização (`revenue_intelligence_config.slow_response_seconds`). Agora existe `sla_by_channel_json` ({ channel_id: segundos }, sanitizado na escrita — só 10s a 24h; valor torto nunca vira régua). O cálculo do IVC (`ConversionVelocityService.calculate`) passou a juntar o canal de cada ticket (via `contacts.channel_id`) e avaliar **cada ticket contra o limiar do seu canal** (canal sem entrada herda o padrão) em três lugares: conformidade de SLA, cobertura fora do horário e determinação de risco/follow-up. Decisão de escopo: os percentis (p50/p90/p95) e o `responseTimeScore` continuam agregados no limiar padrão — são métricas da operação inteira; o que muda por canal é a régua de conformidade por ticket. `calculation_json` audita os limiares usados em cada cálculo (mesma disciplina de versionamento do motor). UI: seção "SLA por canal" no drawer de calibração do RIC (vazio herda o padrão). Segmento/prioridade (os outros dois eixos do texto original da ADR-010) continuam de fora — não há dado de segmento/prioridade por ticket para ancorar a régua hoje.

## Item 14 — Edição concorrente: um problema real de integridade encontrado e fechado

A investigação achou mais do que o backlog descrevia: `radar_answers` **não tinha índice único**, e `saveAnswer` fazia SELECT-depois-INSERT não transacional — dois usuários autenticados salvando a mesma pergunta ao mesmo tempo podiam **duplicar a linha** (ambos passam no SELECT, ambos inserem), corrompendo silenciosamente o denominador do score. Fechado em duas camadas:
- **Banco**: dedupe one-shot (mantém a linha mais recente por grupo) + dois índices únicos **parciais** — um para `respondent_id IS NULL` (fluxo autenticado) e um para `respondent_id IS NOT NULL` — parciais porque UNIQUE normal em SQLite trata NULLs como sempre distintos.
- **Código**: `saveAnswer` virou upsert atômico (`INSERT ... ON CONFLICT ... DO UPDATE` contra cada índice parcial). Escrita simultânea agora é last-writer-wins limpo, nunca duplicata.

O modelo multi-respondente em si já estava correto (cada convidado tem linha própria por `respondent_id`); polling/presença em tempo real na tela foi considerado e não incluído — o custo não se justifica para um formulário respondido tipicamente em sessões separadas; a garantia que importa (integridade no banco) está no nível certo.

## Item 20 — Anexo binário no e-mail do relatório

A restrição real (documentada na ADR-017): `gmailSend` codificava o anexo com `Buffer.from(content, "utf-8")` — correto para texto (.ics), **corrompe binário** (PDF tem bytes inválidos em UTF-8). Solução: campo novo `contentBase64` no parâmetro de anexo (os dois campos coexistem; o caller escolhe conforme o tipo — comprovado por teste de bytes que o caminho UTF-8 corromperia exatamente os bytes que o novo caminho preserva). `generateRadarReport` passou a devolver `filePath` junto com a URL (o disco local é a fonte de verdade, ADR-011), e o envio por e-mail agora **anexa o PDF de verdade** além do link — best-effort: arquivo indisponível ou acima de ~20MB (limite do Gmail) manda só o link, como antes; o envio nunca falha por causa do anexo.

## Item 21 — Pilar "Receita e atendimento" com dados medidos

Ideia registrada desde a ADR-009. Implementado como **dica, não resposta automática**: `RadarService.measuredHints()` lê o snapshot mais recente do IVC e monta, por pergunta do pilar Receita, uma linha "Medido na sua operação: ..." (p90 de primeira resposta + conformidade de SLA para a pergunta de tempo de resposta; conformidade de follow-up; rastreabilidade de conversão). `getSession` inclui `measuredHints` e a tela mostra a dica ao lado da pergunta com o aviso "a resposta continua sendo sua". Duas regras preservadas de propósito: o humano continua declarando (regra de "nunca deixar o sistema agir sozinho", ADR-016), e a confiança 1,00 ("baseline medido", reservada desde a ADR-009) **continua reservada** — preencher a resposta sozinho mudaria a semântica do score declarado, e isso é uma decisão de produto que segue em aberto no backlog. Organização sem snapshot não ganha dica nenhuma (nunca inventa medição).

## Validação

`npm run test:backlog-radar-infra` (21 verificações novas) + suíte completa (19 scripts, 366 verificações, zero quebras):
- Honeypot comprovado pré-existente; teto genérico presente na rota inteira.
- `sla_by_channel`: entradas válidas persistem, inválidas descartadas; cálculo real com 2 tickets de mesma velocidade em canais com réguas diferentes → 50% de conformidade (um cumpre, outro estoura); `calculation_json` audita as réguas.
- Concorrência: duas escritas na mesma pergunta = 1 linha (última vence); INSERT direto duplicado bloqueado pelo índice; respondente convidado convive com resposta autenticada; upsert por respondente idem.
- Anexo: bytes binários preservados via `contentBase64` e comprovadamente corrompidos via UTF-8 (justificativa do campo); `filePath` devolvido pelo gerador de PDF.
- Dicas medidas: existem com snapshot, citam o dado real, nunca criam resposta, e organização sem dados não ganha dica.
- `npm run lint` (sem erros novos) e `npm run build` limpos.
