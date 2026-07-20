/**
 * TEST — Radar B2B (PRD, T03). Monta uma base radar_rio.db de fixture e valida
 * search (distância crescente + agregados + filtros) e importToProspect
 * (padrão Prospect: accounts/signals/contacts + dedupe).
 * Uso: npm run test:radar-b2b
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-radarb2b-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-radarb2b-1234567890abcdef";

// Base do radar (SQLite separado, read-only em produção — aqui montamos como fixture).
const radarPath = path.join(tmpDir, "radar_rio.db");
process.env.RADAR_DB_PATH = radarPath;

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function seedRadarDb() {
  const r = new Database(radarPath);
  r.exec(`
    CREATE TABLE radar_meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE cnaes (codigo TEXT PRIMARY KEY, descricao TEXT);
    CREATE TABLE empresas (cnpj TEXT PRIMARY KEY, cnpj_basico TEXT, razao_social TEXT, nome_fantasia TEXT,
      situacao TEXT, data_inicio TEXT, cnae TEXT, cnae_secundarias TEXT, logradouro TEXT, numero TEXT,
      complemento TEXT, bairro TEXT, cep TEXT, telefone1 TEXT, telefone2 TEXT, email TEXT,
      natureza_juridica TEXT, capital_social REAL, porte TEXT);
    CREATE TABLE socios (cnpj_basico TEXT, nome TEXT, qualificacao TEXT, data_entrada TEXT, faixa_etaria TEXT);
    CREATE TABLE cep_geo (cep TEXT PRIMARY KEY, lat REAL, lon REAL, n INTEGER);
  `);
  r.exec(`INSERT INTO radar_meta VALUES ('base_month','2024-06')`);
  r.exec(`INSERT INTO radar_meta VALUES ('total_empresas','3')`);
  const cep = r.prepare(`INSERT INTO cep_geo VALUES (?,?,?,?)`);
  cep.run("22041001", -22.9680, -43.1790, 10); // ~0.4 km do centro
  cep.run("22050002", -22.9750, -43.1850, 8);   // ~0.6 km
  cep.run("22071000", -22.9900, -43.1900, 5);   // ~2.3 km (fora de 1 km)
  const cn = r.prepare(`INSERT INTO cnaes VALUES (?,?)`);
  cn.run("4721102", "Padaria e confeitaria"); cn.run("5611201", "Restaurantes e bares"); cn.run("4120400", "Construção de edifícios");
  const emp = r.prepare(`INSERT INTO empresas (cnpj,cnpj_basico,razao_social,nome_fantasia,situacao,data_inicio,cnae,cnae_secundarias,logradouro,numero,complemento,bairro,cep,telefone1,telefone2,email,natureza_juridica,capital_social,porte) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  emp.run("11111111000101","11111111","Padaria Copacabana LTDA","Padoca",  "02","20100101","4721102","","Rua A","1","","Copacabana","22041001","2133334444","","a@x.com","",50000,"01");
  emp.run("22222222000102","22222222","Bar do Ze ME","Bar do Zé",           "02","20180101","5611201","","Rua B","2","","Copacabana","22050002","","","","",10000,"01");
  emp.run("33333333000103","33333333","Construtora Rio SA","",              "02","20000101","4120400","","Av C","3","","Copacabana","22071000","2199998888","","c@x.com","",5000000,"05");
  const soc = r.prepare(`INSERT INTO socios VALUES (?,?,?,?,?)`);
  soc.run("11111111","João Silva","49","20100101","5"); soc.run("22222222","Maria Souza","22","20180101","4");
  r.close();
}

async function main() {
  seedRadarDb();
  const db = (await import("../src/server/db.js")).default;
  const { RadarB2BService } = await import("../src/server/RadarB2BService.js");

  const CENTER = { lat: -22.9711, lon: -43.1822 }; // Copacabana

  // 1. status
  const st = RadarB2BService.status();
  check("1.1 base instalada", st.instalado === true);
  check("1.2 mês da base lido do radar_meta", st.dataBase === "2024-06");

  // 2. search raio 1km — só A e B; ordenado por distância; agregados coerentes.
  const s = RadarB2BService.search({ ...CENTER, radiusKm: 1 });
  check("2.1 search ok", s.ok === true);
  const emp = (s as any).empresas, res = (s as any).resumo;
  check("2.2 retornou 2 empresas (a 3ª está fora do raio)", emp.length === 2);
  check("2.3 ordenado por distância crescente", emp[0].distanciaKm <= emp[1].distanciaKm);
  check("2.4 mais próxima é a Padaria", emp[0].razaoSocial === "Padaria Copacabana LTDA");
  check("2.5 resumo.total = 2", res.total === 2);
  check("2.6 comTelefone = 1", res.comTelefone === 1);
  check("2.7 porPorte ME = 2", res.porPorte.ME === 2);
  check("2.8 CNAE tem descrição (join cnaes)", emp[0].cnaeDescricao === "Padaria e confeitaria");
  check("2.9 sócios sem CPF (só nome/qualif/faixa)", Array.isArray(emp[0].socios) && emp[0].socios[0]?.nome === "João Silva" && !("cpf" in (emp[0].socios[0] || {})));

  // 3. filtros
  check("3.1 filtro comTelefone reduz para 1", (RadarB2BService.search({ ...CENTER, radiusKm: 1, comTelefone: true }) as any).empresas.length === 1);
  check("3.2 filtro cnaePrefix '56' só o bar", (RadarB2BService.search({ ...CENTER, radiusKm: 1, cnaePrefix: "56" }) as any).empresas[0].razaoSocial === "Bar do Ze ME");
  check("3.3 filtro porte Demais (05) não acha nada no raio", (RadarB2BService.search({ ...CENTER, radiusKm: 1, porte: ["05"] }) as any).empresas.length === 0);
  check("3.4 raio 5km inclui a construtora", (RadarB2BService.search({ ...CENTER, radiusKm: 5 }) as any).empresas.length === 3);

  // 4. importToProspect — cria conta no padrão Prospect + dedupe.
  const orgId = randomUUID();
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'Provedor Fibra', 'active')`).run(orgId);
  const imp = await RadarB2BService.importToProspect(orgId, null, ["11111111000101", "22222222000102"], "user-1");
  check("4.1 importou 2 contas", imp.created === 2);
  const acc = db.prepare(`SELECT * FROM prospect_accounts WHERE organization_id = ? ORDER BY display_name`).all(orgId) as any[];
  check("4.2 contas com source rfb_open_data", acc.length === 2 && acc.every(a => a.source === "rfb_open_data"));
  check("4.3 external_ref = cnpj/<cnpj>", acc.some(a => a.external_ref === "cnpj/11111111000101"));
  check("4.4 cnpj gravado na conta", acc.some(a => a.cnpj === "11111111000101"));
  const sig = db.prepare(`SELECT COUNT(*) AS n FROM prospect_signals WHERE organization_id = ? AND source_kind = 'connector'`).get(orgId) as any;
  check("4.5 sinais firmográficos criados (connector)", sig.n >= 4);
  const con = db.prepare(`SELECT * FROM prospect_contacts WHERE organization_id = ?`).all(orgId) as any[];
  check("4.6 contato da padaria com telefone + sócio", con.some(c => c.phone === "2133334444" && c.full_name === "João Silva"));
  const snap = db.prepare(`SELECT COUNT(*) AS n FROM prospect_score_snapshots WHERE organization_id = ?`).get(orgId) as any;
  check("4.7 computeScore rodou (snapshot criado)", snap.n === 2);

  // 5. dedupe: reimportar não duplica.
  const imp2 = await RadarB2BService.importToProspect(orgId, null, ["11111111000101", "22222222000102"], "user-1");
  check("5.1 reimport pula duplicadas", imp2.created === 0 && imp2.skipped === 2);
  check("5.2 segue com 2 contas", (db.prepare(`SELECT COUNT(*) AS n FROM prospect_accounts WHERE organization_id = ?`).get(orgId) as any).n === 2);

  console.log("\n=== test:radar-b2b ===");
  for (const x of results) console.log(`${x.ok ? "✅" : "❌"} ${x.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  if (failures > 0) { console.error(`\n❌ ${failures} falha(s).`); process.exit(1); }
  console.log("\n✅ Radar B2B: search + import no padrão Prospect OK.");
}

main().catch((e) => { console.error(e); process.exit(1); });
