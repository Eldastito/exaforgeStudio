# Runbook — Rede de Lojas (TOULON): acesso do gerente por loja

Doc-of-record (2026-09) de como o gerente enxerga "só a sua loja" no caso TOULON
(rede com guarda-chuva + lojas). Atualizado após confirmação do dono sobre a
topologia real de dados.

## Topologia REAL (confirmada com o dono + verificada no código)

O dado NÃO é homogêneo — vive em lugares diferentes por tipo:

| Dado | Onde vive hoje | Isolamento do gerente |
| --- | --- | --- |
| **WhatsApp / ATENDIMENTO** (conversas, tickets) | **Na conta da loja** (cada loja conecta o seu número na própria conta) | **Já isolado por conta** — o gerente loga na conta da loja e vê só o dela. Zero código. |
| **Contatos & CRM** (contatos do WhatsApp) | **Na conta da loja** (derivam das conversas) | **Já isolado por conta.** Zero código. |
| **Clientes do PDV** (Alterdata) | **Na TOULON** (uma conta só, todas as filiais, etiquetadas por `filial`) | **NÃO isolado** — não estão na conta da loja; o gerente na conta da loja vê a aba vazia. |
| **Consolidado do grupo** (fan-out) | TOULON puxa **vendas/fechamentos** das lojas | Só puxa vendas — **não** puxa contatos/CRM/PDV. |

O gerente loga na **conta separada da loja** (confirmado). Logo, tudo que ENTRA
pela loja (WhatsApp/CRM) já fica isolado por conta; a exceção é o **PDV**, que é
importado centralizado na TOULON.

## Conclusão

- **WhatsApp/ATENDIMENTO + Contatos & CRM do gerente:** já funcionam isolados por
  conta. Nada a construir. (Os PRs #1642/#1643, que escopam *dentro* de uma org
  por loja, ficam **inertes** para este gerente — ele está numa conta de loja
  única; não há o que filtrar. Eles só valem para um usuário logado NA TOULON.)
- **Ainda úteis para o gerente na conta da loja:** #1638 (módulos add-on no editor
  de perfis) e #1640 (`manager`→`admin`, para o gerente passar nos `requireRole`
  da própria conta).
- **Única lacuna real:** o gerente, na conta da loja, **não vê os Clientes do PDV**
  (estão na TOULON). Fecha-la exige uma decisão do dono (abaixo).

## Decisão pendente: PDV na conta da loja?

O gerente precisa dos **Clientes do PDV da loja dele dentro da conta da loja**, ou
o CRM do WhatsApp (já isolado) é o suficiente para o dia a dia dele?

- **Opção 1 — PDV consolidado fica só com o dono (TOULON).** O gerente trabalha o
  CRM do WhatsApp (já funciona). Zero trabalho. O dono vê o PDV consolidado com
  filtro de loja na TOULON.
- **Opção 2 — Rotear o PDV por conta de loja.** Cada loja passa a receber/enxergar
  os seus clientes do PDV na própria conta. Exige apontar o import do Alterdata por
  conta (ou replicar por filial) + migrar/expor os ~20 mil clientes para as contas
  certas. É projeto de dados (dias/semanas + risco de migração).

Recomendação: começar pela **Opção 1** (já funciona; sem risco) e só ir para a
Opção 2 se o cliente exigir o gerente operando a base PDV dentro da conta da loja.

## ATENDIMENTO por loja — NÃO é necessário

Como o WhatsApp conecta na conta de cada loja, o ATENDIMENTO já está isolado por
conta. Não é preciso binding canal→loja nem escopo de tickets. (Só seria preciso
se os números fossem consolidados numa conta só — não é o caso.)

## Como ATIVAR hoje (operacional — do dono)

1. O gerente é **usuário da conta da própria loja** (papel `admin` + perfil
   "Gerente"). Nada de TOULON.
2. Isolamento de WhatsApp/CRM é automático (conta separada).
3. Consolidação (dono): a visão de rede fica na TOULON (Grupo → Consolidado);
   hoje cobre vendas. Puxar contatos/PDV no consolidado é a fatia diferida abaixo.

## Fatias diferidas (só se o cliente pedir)

- **PDV por conta de loja** (Opção 2 acima): import do Alterdata por conta +
  migração dos clientes.
- **Consolidação de contatos/CRM na TOULON** (fan-out): estender
  `GroupConsolidationService` para o dono ver a base de clientes somada da rede.
