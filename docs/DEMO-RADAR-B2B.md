# Roteiro de demonstração — Radar B2B

Demo comercial para provedor de fibra óptica. Empresas **reais** da base pública
da Receita Federal (município do Rio), com filtros e importação para o Prospect AI.

## Antes da reunião (checklist)

- [ ] App rodando local (`npm run dev`) na máquina do Emerson.
- [ ] Base instalada: `data/radar_rio.db` gerado pelo ETL (T01) + `cep_geo` (T02).
      Confira em **Radar B2B** que aparece "N empresas · base AAAA-MM" (e não o
      estado "base não instalada").
- [ ] 3 cenários testados **no mesmo dia** (bairros onde o cliente tem rede;
      sugestão: **Barra da Tijuca, Centro, Tijuca**).
- [ ] Internet OK (o geocode do endereço central usa ViaCEP/Nominatim).
- [ ] (Opcional) **Overlay de fibra** instalado — ver seção abaixo. Sem ele o
      mapa funciona igual, só não mostra o traçado da rede.

## Overlay de fibra (opcional — mapa Fatia 3)

Sobrepõe o **traçado da própria rede do provedor** no mapa da busca, pra ver
quais empresas caem em cima / perto da fibra. É opt-in por presença de arquivo,
no mesmo espírito da base `radar_rio.db`:

1. Peça ao cliente a exportação da rede. Aceitamos **KML** (Google Earth / QGIS /
   OSS de telecom — o mais comum) ou **GeoJSON** já pronto.
2. Coloque o arquivo em `data/radar_fibra.kml` (ou `.geojson`), ou aponte
   `RADAR_FIBER_PATH=/caminho/arquivo`.
3. Recarregue o Radar B2B: a legenda mostra "**N trecho(s)**" e o traçado aparece
   em ciano, com toggle **"Mostrar fibra"**. Se o arquivo estiver ilegível, a
   legenda mostra "overlay não instalado" (o resto do Radar segue normal).

> Só geometria da rede do provedor — não é dado de cliente. A camada é de
> plataforma (sem `organization_id`), read-only, igual à base pública da RFB.

## Roteiro (≈10 min)

### 1. A dor (1 min)
"Hoje, pra achar empresas novas na sua área de cobertura, você usa N ferramentas
soltas — Google Maps, lista telefônica, planilha. Nada fala com o seu comercial."

### 2. Demo ao vivo (4 min)
1. Abrir **Radar B2B**.
2. Endereço **perto da rede dele** (ex.: um CEP da Barra), raio **2 km**.
3. Filtros: **porte ME + EPP**, **somente com telefone** ligado.
4. Buscar → mostrar os **cards de resumo** (quantas empresas, com telefone, por
   porte, top segmentos) e a **tabela** com razão social, segmento, bairro,
   distância, telefone e sócios — tudo real, da Receita.
5. Ordenar por distância e por capital pra mostrar priorização.

### 3. Integração com o comercial (3 min)
1. Selecionar ~10 empresas → **"Importar selecionadas para Prospecção"**.
2. Abrir **Prospect AI** e mostrar que cada empresa virou uma conta com **score**
   e **hipóteses** geradas pela IA (fit, evidências, pergunta recomendada).
3. Mensagem: "o Radar acha, o Prospect qualifica e sugere a abordagem."

### 4. Fechamento (2 min)
- **Vantagem de dados:** fonte pública e licenciada, sem as restrições de
  armazenamento do Google Places.
- **Fase 2 (próxima etapa comercial):** faturamento estimado, nº de funcionários
  e decisores por senioridade via parceiro de dados.
- **Próximo passo:** levantar com ele os campos que ele usa hoje pra qualificar →
  proposta sob medida.

## Conformidade (para citar se perguntarem)

- Dados da RFB são públicos por lei; o uso B2B se apoia em **legítimo interesse**.
- O **opt-out** do Prospect é inviolável (nunca contornado).
- **CPF de sócios** vem mascarado pela RFB e **não é exibido nem armazenado**.
