# Piloto TOULON — menu simplificado (ADR-203 F2.9)

Roteiro para o **dono** validar a Fase 2 na TOULON, em desktop e celular, e decidir com dados se o menu simplificado fica. Nada aqui apaga tela nem muda dado: tudo é reversível pelos mesmos interruptores.

## 0. Antes de ligar
- [ ] Combine com a equipe: por 2 semanas o menu da TOULON vai mudar e o sistema vai **contar quais telas são abertas** (nunca o conteúdo).
- [ ] Anote o que a equipe faz hoje no sistema (ex.: "abrir Insights de manhã", "fechar o dia", "conferir meta") — é o que vamos comparar.

## 1. Ligar (só a TOULON — as outras empresas não mudam)
Configurações → **Módulos** → role até o fim da página (só dono/admin vê):
1. **Menu simplificado (piloto)** → ligar.
2. **Medir o uso do menu (piloto)** → ligar. *É um consentimento (LGPD): registra só qual tela foi aberta e onde clicou — nunca o conteúdo nem o que foi digitado. Nasce desligado. Desligar para de coletar (não apaga o que já foi coletado).*

**Voltar atrás a qualquer momento:** desligue "Menu simplificado" — o menu completo volta na hora; nenhuma tela, dado ou rota foi removido.

## 2. Validação (marque cada item — desktop E celular)
### Dono
- [ ] Menu mostra **Hoje · FalaTu · Executando · Resultados · Empresa** + Explorar. Toda tela que eu usava continua em **Explorar** (busque pelo nome).
- [ ] **Hoje**: até 3 prioridades, cada uma com causa e um verbo ("Aprovar…", "Cadastrar a escala de…"); a Rede mostra meta do mês, já fechado, falta e o vendido de hoje com "último dado do PDV às HH:MM".
- [ ] **Executando**: 4 blocos (Precisa de você · Em andamento · Aguardando · Concluído); "Concluído" diz se o resultado foi confirmado.
- [ ] **Resultados**: a conclusão vem primeiro; lojas abaixo da meta no topo; abra um **Entender**.
- [ ] **Empresa**: Conexões (ERP Alterdata + canais) em linguagem simples; "Modo avançado" abre a tela técnica.
- [ ] **Operação da Rede**: 5 grupos; toda aba que eu usava está num deles.
- [ ] **FalaTu**: 4 grupos; "Sobre: <loja>" muda a resposta; "Por quê?" e "E a Bangu?" continuam a conversa.
- [ ] **Atendimento Digital** (antigo Dashboard) é a tela de tickets/leads/IA — não é a venda das lojas.

### Gerente (de uma loja)
- [ ] Entra com o usuário do gerente; só vê a loja dele em Hoje/Resultados/FalaTu.
- [ ] Pergunta no FalaTu sobre outra loja → recusa; comparativo da rede → recusa.

### Vendedor
- [ ] Não vê Empresa; não vê números das lojas (R$); vê só as tarefas dele em Executando.

## 3. Como ler o resultado (Empresa → "Como a equipe está usando o menu")
Aparece depois de alguns dias de uso. Estados: **desligada** (sem números) · **sem uso** · **amostra pequena** (mostra, mas não conclua — mínimo 30 aberturas e 2 pessoas) · **ok**.
- **% pelo Explorar alto (≥ 50%)**: o 1º nível não cobre o que a equipe procura → ver "telas mais abertas" e promover/renomear.
- **Hoje → clique em prioridade**: quanto das aberturas do Hoje viram ação.
- **Buscas sem resultado**: a equipe procura um nome que não existe → falta atalho ou renomear.
- **Limite honesto:** o painel mede **aberturas e cliques, não se ajudou**. Decida junto com a conversa com a equipe.

## 4. Decisão (semana 2)
| Sinal | Decisão |
| --- | --- |
| Equipe usa o 1º nível, Explorar baixo, sem reclamação | Manter ligado; estender a outra empresa-piloto |
| Explorar alto / muitas buscas sem resultado | Manter ligado e pedir ajuste de rótulos/atalhos (nova fatia) |
| Equipe volta ao menu completo ou reclama | Desligar o menu simplificado (reversível) e registrar o motivo |

**Retirada de telas antigas continua NÃO sendo feita automaticamente.** O aviso de "pronto para retirar" (Empresa/Scheduler) é advisório e só aparece com adoção real da nova tela E o legado virando resíduo — a decisão é sua, em PR separado.

## 5. Pendências conhecidas (não bloqueiam o piloto)
- "Resolvido automaticamente hoje" (PRD §4): o Hoje mostra "casos resolvidos nas últimas 24h"; a data exata da auto-resolução exige coluna nova (decisão sua).
- Briefings (manhã/16h/noite) **dentro** do FalaTu e continuar a conversa a partir deles.
- A memória de continuidade do FalaTu é do servidor (20 min); reiniciar o servidor a esquece.
- KPIs só-digitais dentro do Atendimento Digital (§21) e estoque/financeiro em Resultados.
