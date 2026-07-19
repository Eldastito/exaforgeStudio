# ADR-093 — Reorganização de Configurações (Quick-Start, Planos, LGPD)

**Status:** Aprovado (aguardando implementação; parte junto do Bloco A do ADR-091).

**Origem:** Item #3 do `docs/BACKLOG-CAMPO-TOULON.md`. A tela de Configurações acumulou 10 abas; três precisam de revisão de posicionamento e de UX: Quick-Start (poluindo como aba fixa), Planos disponíveis (será reescrito com a grade nova), e LGPD (obrigatória mas com linguagem técnica demais).

---

## Contexto

Configurações hoje tem 10 abas: Quick-Start, Empresa, Atendimento (IA), Usuários e Permissões, Cobrança e Plano, Módulos, Segurança (2FA), Privacidade (LGPD), Radar, Painel Padrão.

Problemas observados no piloto TOULON:
- **Quick-Start** é a 1ª aba e fica lá pra sempre, mesmo depois de aplicado. Polui a navegação de quem já configurou.
- **Planos disponíveis** vive dentro de "Cobrança e Plano" (ok), mas usa a grade antiga (Starter/Pro/Business) e não mostra uso vs limite.
- **LGPD (Privacidade)** tem linguagem jurídica densa; dono não-jurídico não entende. Mas é obrigatória: o lojista é o **controlador** dos dados dos clientes dele (LGPD), o ZappFlow é apenas **operador**.

## Decisão

### 1. Quick-Start sai das abas de Configurações

- Remove a aba fixa "Quick-Start" de Configurações.
- Vira **card de onboarding no Dashboard** que aparece só enquanto o setup não foi aplicado, e **some após o uso** (ou após X produtos cadastrados / X dias).
- A lógica de aplicação (`/api/quickstart/apply`, idempotente) é preservada — muda só onde o gatilho aparece.
- O wizard de onboarding no signup já faz o essencial; o Quick-Start passa a ser o "empurrão" opcional pós-cadastro, não uma aba permanente.

### 2. Planos disponíveis fica em "Cobrança e Plano", reescrito no Bloco A

Confirmado: o lugar está certo. No Bloco A do ADR-091:
- Renomear os planos pra grade nova (Autônomo/Start/Growth/Scale/Enterprise).
- Mostrar **uso atual vs limite** (barra de IA consumida no mês, contatos, canais, usuários).
- Botão de upgrade → checkout ASAAS (Bloco B).

Sem ação separada — cai dentro do Bloco A.

### 3. LGPD: mantém a aba (obrigatório legal) + simplifica + pré-popula por vertical

O dono PRECISA ter acesso à tela LGPD porque é o controlador dos dados:
- Ver consentimentos dados/revogados (responsabilidade legal dele)
- Exportar dados de um cliente (portabilidade, prazo legal)
- Executar esquecimento (direito do titular)
- Ajustar o texto do banner de consentimento (responsabilidade dele)

Consentimento automático por vertical **facilita** mas **não substitui** o acesso. Não é "ou", é "e".

Melhorias:
- **Pré-popular categorias de consentimento conforme a vertical** (moda → marketing + dados_pessoais + perfilamento; saúde → + dados sensíveis com base legal reforçada).
- **Modo simples** (3 toggles: "coleto dados pra atender", "mando marketing", "faço perfilamento de compra") + **modo avançado** (config completa atual).
- Linguagem menos jurídica no modo simples, com tooltip explicando cada item.

## Consequências

**Positivas:**
- Configurações fica mais limpa (9 abas em vez de 10; Quick-Start vira card contextual).
- Dono novo é guiado pelo Quick-Start no Dashboard, mas quem já configurou não vê mais.
- LGPD acessível e compreensível reduz risco legal do lojista (e do ZappFlow como operador).
- Pré-população por vertical acelera o compliance sem tirar o controle do dono.

**Trade-offs aceitos:**
- Mover Quick-Start pro Dashboard exige lógica de "já foi aplicado?" (flag na org) + card condicional — não existe hoje.
- LGPD modo simples/avançado é retrabalho de UI (o painel atual é só "avançado").
- Pré-população por vertical precisa de um mapa vertical → categorias que ainda não existe (hoje as categorias são fixas: marketing/dados_pessoais/perfilamento/comunicações).

## Implementação

- **Bloco A (junto do ADR-091):** Planos reescritos + uso vs limite.
- **Item separado (pós-Bloco A):** Quick-Start → Dashboard card + LGPD simples/avançado + pré-população por vertical. Não bloqueia o Bloco A.

## Aprovação

Aprovado por Emerson (jul/26): Quick-Start pro Dashboard (some após uso); Planos ficam em Cobrança e Plano, renomeados; LGPD mantém a aba com as recomendações (simplificar + pré-popular por vertical). Item #3 do backlog marcado `[x] decidido`.
