import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { BusinessManifestoService } from "../BusinessManifestoService.js";
import { chat, isAIConfigured } from "../llm.js";
import { logAuthEvent } from "../auditLog.js";

const router = Router();

// GET /api/manifesto — devolve o manifesto atual (ou objeto vazio para primeira edição).
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const m = BusinessManifestoService.get(orgId) || {
    organizationId: orgId, whyStatement: "", howPrinciples: [], whatSummary: "",
    founderStory: "", transformationPromise: "", toneVoice: "",
  };
  res.json(m);
});

// PUT /api/manifesto — atualiza (upsert).
router.put("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  if (req.user?.role !== "owner" && req.user?.role !== "admin") {
    return res.status(403).json({ error: "Apenas donos/administradores editam o Manifesto da Marca." });
  }
  try {
    const b = req.body || {};
    const next = BusinessManifestoService.save(orgId, {
      whyStatement: b.whyStatement,
      howPrinciples: b.howPrinciples,
      whatSummary: b.whatSummary,
      founderStory: b.founderStory,
      transformationPromise: b.transformationPromise,
      toneVoice: b.toneVoice,
    });
    logAuthEvent(orgId, userId, undefined, "MANIFESTO_UPDATED", {});
    res.json(next);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/manifesto/assist — workflow guiado: dado um rascunho parcial + respostas
// do dono, a IA sugere versões refinadas de cada campo do Manifesto.
// Body: { section: 'why'|'transformation'|'story'|'principles'|'tone', context: { businessType, currentDraft, answers } }
router.post("/assist", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!isAIConfigured()) return res.status(400).json({ error: "IA não configurada nesta instância." });
  const { section, context } = req.body || {};
  const validSections = ["why", "transformation", "story", "principles", "tone"];
  if (!validSections.includes(section)) return res.status(400).json({ error: "section inválida" });

  const sectionInstructions: Record<string, string> = {
    why: `O usuário está articulando o POR QUÊ da marca (Golden Circle de Sinek). Ajude a chegar em 1-2 frases que responsam "por que essa marca existe?" — NÃO "o que ela vende", NÃO "como faz". O Por Quê é a razão de existir. Ex: "Existimos para desafogar donos de negócio de tudo que não é o trabalho de verdade." Evite chavões vazios ("qualidade", "excelência", "melhor").`,
    transformation: `O usuário está articulando a PROMESSA DE TRANSFORMAÇÃO — o resultado concreto na vida do cliente. Ajude a chegar em 1-2 frases que descrevem o "antes vs depois" do cliente que consome esta marca. Ex: "Antes o dono trabalhava 14h/dia e sabia que estava perdendo receita sem saber onde; depois ele dorme com o negócio rodando e o painel mostra exatamente o que fazer amanhã." Precisa ser concreta.`,
    story: `O usuário está escrevendo a HISTÓRIA FUNDADORA (StorySelling). Ajude a estruturar em 3-5 parágrafos curtos que contêm: MOMENTO ORIGEM (por que começaram? qual dor/observação?), CONFLITO (o obstáculo enfrentado), VIRADA (a descoberta que mudou tudo), PROMESSA (o que se comprometem a entregar hoje). Use detalhes sensoriais (data, lugar, cena) — NÃO invente detalhes; refine o material do usuário.`,
    principles: `O usuário está definindo os PRINCÍPIOS (o Como do Golden Circle). Ajude a chegar em 3-5 princípios operacionais INEGOCIÁVEIS. Não valores vagos ("respeito", "qualidade"), mas regras de comportamento acionáveis. Ex: "Nunca vender o que não usaríamos", "Responder em até 30 min mesmo aos sábados", "Falar a verdade dura quando o cliente pede opinião real". Devolva como array JSON de strings.`,
    tone: `O usuário está definindo o TOM DE VOZ. Ajude a descrever em 2-4 frases: (1) registro (formal/casual/próximo/técnico), (2) 3-5 palavras-âncora que a marca USA muito, (3) 3-5 palavras/expressões que a marca EVITA. Ex: "Registro próximo mas não íntimo. Usamos: 'a gente', 'olha só', 'combinado'. Evitamos: 'querido(a)', 'fofo(a)', gírias regionais fortes."`,
  };

  const prompt = `Você é um consultor de marca especializado em Golden Circle (Sinek) e StorySelling. Sua missão: ajudar o dono a articular o Manifesto da marca dele. RECUSE: chavões vazios ("qualidade", "excelência", "compromisso"), lugares-comuns, respostas que servem para qualquer negócio.

${sectionInstructions[section]}

TIPO DE NEGÓCIO: ${context?.businessType || "não informado"}
RASCUNHO ATUAL DO CAMPO: ${context?.currentDraft || "(vazio)"}
RESPOSTAS DO DONO A PERGUNTAS AUXILIARES:
${(context?.answers || []).map((a: any, i: number) => `${i + 1}. P: ${a.question}\n   R: ${a.answer}`).join("\n\n") || "(nenhuma)"}

Devolva SOMENTE JSON:
{
  "suggestion": "${section === "principles" ? "[\"princípio 1\", \"princípio 2\", ...]" : "texto refinado, direto ao ponto"}",
  "notes": "1-2 frases explicando por que essa formulação está mais forte que o rascunho",
  "next_questions": ["pergunta que ainda ajudaria a apertar essa sessão", "outra"]
}`;

  try {
    const raw = await chat(prompt, { system: "Você é consultor de marca. Responda SOMENTE em JSON válido." });
    let parsed: any = {};
    try {
      // Aceita a resposta com ou sem markdown fences
      const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch { parsed = { suggestion: raw, notes: "", next_questions: [] }; }
    res.json(parsed);
  } catch (e: any) { res.status(500).json({ error: e.message || "Falha ao gerar sugestão." }); }
});

export default router;
