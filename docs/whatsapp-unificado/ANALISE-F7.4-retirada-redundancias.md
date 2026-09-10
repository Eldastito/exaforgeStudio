# F7.4 — Auditoria de retirada de redundâncias + pendências de remoção física

> **F7.4 (RF §21 §532 / §19 / Gate G7).** "Retirar interfaces e implementações
> duplicadas ELEGÍVEIS, preservando compatibilidade/histórico e **documentando
> pendências de remoção física**." **Doc-only.** Não remove nada de código:
> a remoção física é **pilot-gated** e só ocorre com o piloto **aprovado**.
>
> **Conclusão honesta:** **nenhuma redundância é elegível para remoção AGORA.**
> O alvo principal (as ~20 cópias do "primeiro canal", A5) sequer está superado
> ainda — o resolvedor único existe mas **nenhum produtor o consome**; e todo o
> resto é pilot-gated. Este documento registra a matriz de elegibilidade e a
> **lista de pendências de remoção física**, cada uma com sua pré-condição.

## 0. Regra de retirada (§15/§19 + gate da F7.4)

Remoção só é elegível quando **TODAS** se cumprem (§19 / drive-to-green da Fase 7):
1. **Consumidores migrados** — nada mais chama o caminho antigo.
2. **Equivalência comprovada** — o caminho novo produz o mesmo efeito (provado, não presumido).
3. **Dados reconciliados** — migração sem drift (`pilot-readiness` verde, F7.3).
4. **Rollback exercitado** — reversão real feita ao menos uma vez (F7.1/piloto).
5. **Sem escritor paralelo** — não há dois caminhos escrevendo o mesmo estado.

Os itens 1–5 dependem, na prática, do **piloto real aprovado** (F7.2) — que é
decisão do dono. Até lá: `IMPLEMENTADO` = auditoria; `VALIDADO`/remoção = após piloto.

## 1. Matriz de elegibilidade (inventário F0 × estado atual)

| # | Redundância (F0) | Estado atual (arquivo:linha) | Superada? | Elegível agora? | Pré-condição p/ remover |
|---|---|---|---|---|---|
| **A5** | ~20 cópias do SQL "primeiro canal" (Pattern 1) | **AINDA VIVAS**: `Scheduler.ts:181,249,284,313,665,744,1919,1988,2054,2178,2266,2329`, `QuoteService.ts`, `TaskReminderService.ts`, `routes/escola.ts`, `routes/admin.ts`, `routes/falatu.ts`, `routes/health.ts`. `ChannelBindingService.resolve` existe mas **nenhum produtor o consome** (grep 0) — hoje só o GATE (`assertOutboundAllowed`) é aplicado no sink | **NÃO** — o resolvedor não é o caminho de SELEÇÃO ainda | **NÃO** | (a) migrar a SELEÇÃO dos produtores p/ `resolve()` [fatia de código futura]; (b) piloto provar equivalência; (c) então remover as cópias |
| **A7** | Pareamento legado inline (create+connect+QR) divergente do typed | `/api/evolution/instance/connect` (`server.ts:805`) **já DELEGA** a `EvolutionService.provision` (`:826`, F1.4) — a lógica inline foi colapsada | **SIM (colapsado)** | **NÃO** (ainda) | rota legada é caminho vivo do ChannelsPanel; remover exige piloto provar que o fluxo autenticado (F2.1) a substitui p/ todos os clientes + janela de compat |
| **A9** | `default_org` na atribuição + config module-global + diagnóstico global | atribuição por `default_org` no inbound **já corrigida** (F1.2c, resolução por `identifier` — `server.ts:1055` comentário); `default_org` remanescente em `server.ts:371,376,401` é **seed de MOCK/dev**, não o bug de atribuição | atribuição: **SIM**; seed mock: N/A | **NÃO** | o seed mock sai só quando o provisionamento real (ASAAS/onboarding) substituir o mock — fora do escopo deste PRD |
| **X1** | Leitura de token em texto puro | **RESOLVIDO** por MODIFICAÇÃO (não duplicata): leituras embrulhadas em `EncryptionService.decrypt` (transparente ao legado) | N/A (não é duplicata) | — | nada a remover (foi correção in-place) |
| **wa.me** | 5 atalhos `wa.me` (F0.2) | preservados por design (abrem conversa manual; **não** viram envio automático) | N/A | **NÃO (preservar)** | não são duplicata de envio — não retirar |
| **Legado send path** | caminhos de envio fora do sink único | envio já passa por `MessageProviderService.sendMessage/sendDocument` (sink com gate F2.4); fila durável carrega `feature` (F6.1) | parcial | **NÃO** | idem A5: enquanto a SELEÇÃO não migrar pro resolvedor, coexistem seleção-antiga + gate-novo (não é escritor duplo de estado, mas é caminho duplo de escolha) |

## 2. O que NÃO fazer (armadilhas §15/§19)

- **NÃO** remover as ~20 cópias de A5 antes de migrar a seleção pro resolvedor:
  hoje elas SÃO o caminho de seleção. Removê-las quebraria o envio.
- **NÃO** apagar a rota legada `/api/evolution/instance/connect`: o ChannelsPanel
  ainda a usa; ela já delega ao serviço typed (F1.4), então o risco é baixo, mas
  a retirada exige a UI 100% no fluxo autenticado (F2.1) + janela de compat.
- **NÃO** remover o seed `default_org` de mock como parte deste PRD — é
  infra de dev/mock, não redundância do WhatsApp Unificado.
- **NÃO** tratar os atalhos `wa.me` como duplicata de envio.

## 3. Pendências de remoção física (a executar SÓ com piloto aprovado)

Ordem correta, cada passo com sua pré-condição (nenhum é feito agora):

1. **Adotar o resolvedor único** (fatia de código, ainda pilot-gated p/ ativar):
   migrar a SELEÇÃO de canal dos ~20 pontos de A5 para
   `ChannelBindingService.resolve` (o gate já está no sink). **Aditivo/reversível**;
   com bindings de compatibilidade (F2.3) o comportamento default não muda.
2. **Piloto provar equivalência** (F7.2/F7.3): `pilot-readiness` verde + ciclo real
   aprovado + rollback exercitado.
3. **Remover as ~20 cópias de A5** (item 1 do gate cumprido: nenhum consumidor
   usa mais o SQL antigo).
4. **Retirar a rota legada** `/api/evolution/instance/connect` **depois** de a UI
   estar 100% no fluxo autenticado (F2.1) e passada a janela de compat.
5. **Preservar sempre** (nunca remover): histórico (retenção), vínculos de ponte
   (F4), atalhos `wa.me`, seed mock enquanto o provisionamento real não existir.

Cada remoção física acima é uma **fatia própria**, com teste de equivalência e
rollback, feita **quando o dono autorizar após o piloto** — não neste ciclo.

## 4. Estado (Gate G7)

Auditoria de retirada **IMPLEMENTADA (doc-only)**. **Nenhuma remoção física
executada** — corretamente, porque nenhuma redundância é elegível sem o piloto
aprovado, e o alvo principal (A5) nem superado está. Status honesto:
**"pendências de remoção física documentadas; execução pendente do piloto
aprovado do dono"**. Isto **fecha o que a IA pode entregar na F7.4 sem produção**;
a remoção em si é ação futura, pilot-gated, fatia por fatia.
