require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
const { debugCode } = require("./debug");
const { router: authRouter, authMiddleware } = require("./auth");
const paymentsRouter = require("./payments");
const { db, initDatabase } = require("./database");
const { canAnalyze, hasFeature, getPlanInfo } = require("./plans");

const app = express();

// IMPORTANTE: webhook do Stripe precisa do body raw, antes do express.json()
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));

app.use(cors());
app.use(express.json());

// Serve arquivos estáticos (HTML, CSS, JS) da pasta public
app.use(express.static(path.join(__dirname, "..", "public")));

// Rotas de autenticação (register, login, me)
app.use("/api/auth", authRouter);

// Rotas de pagamento (checkout, webhook)
app.use("/api/payments", paymentsRouter);

// === API DE DEBUG ===
app.post("/api/debug", authMiddleware, async (req, res) => {
  const { linguagem, erro, codigo, contexto } = req.body;

  if (!erro) {
    return res.status(400).json({ error: "Campo 'erro' é obrigatório." });
  }

  // Busca usuário no banco
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  // Verifica se é revisão de código (precisa de plano Pro ou Team)
  const isCodeReview = erro === "Revisão de código solicitada";
  if (isCodeReview && !hasFeature(user, "codeReview")) {
    return res.status(403).json({
      error: "Revisão de código disponível apenas nos planos Pro e Team.",
      upgrade: true,
    });
  }

  // Verifica limite de análises do mês
  const analysis = canAnalyze(user);

  if (analysis.needsReset) {
    await db.prepare("UPDATE users SET analysis_count = 0, analysis_reset_date = ? WHERE id = ?")
      .run(new Date().toISOString(), user.id);
    user.analysis_count = 0;
  }

  if (!analysis.allowed) {
    return res.status(429).json({
      error: "Você atingiu o limite de análises deste mês. Faça upgrade para o plano Pro para análises ilimitadas.",
      upgrade: true,
    });
  }

  try {
    const resultado = await debugCode({ linguagem, erro, codigo, contexto });

    // Incrementa contador de análises
    await db.prepare("UPDATE users SET analysis_count = analysis_count + 1 WHERE id = ?").run(user.id);

    // Salva no histórico
    const type = isCodeReview ? "review" : "error";
    await db.prepare("INSERT INTO history (user_id, type, input_error, input_code, input_context, response) VALUES (?, ?, ?, ?, ?, ?)")
      .run(req.user.id, type, erro, codigo || null, contexto || null, resultado);

    res.json({ resultado });
  } catch (err) {
    console.error("Erro na IA:", err.message || err);
    res.status(500).json({ error: "Erro ao chamar a IA: " + (err.message || "erro desconhecido") });
  }
});

// === INFO DO PLANO ===
app.get("/api/plan", authMiddleware, async (req, res) => {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }
  res.json(getPlanInfo(user));
});

// === HISTÓRICO ===
app.get("/api/history", authMiddleware, async (req, res) => {
  const history = await db.prepare(
    "SELECT id, type, input_error, input_code, input_context, response, created_at FROM history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
  ).all(req.user.id);

  res.json({ history });
});

app.delete("/api/history/:id", authMiddleware, async (req, res) => {
  const item = await db.prepare("SELECT * FROM history WHERE id = ? AND user_id = ?").get(parseInt(req.params.id), req.user.id);
  if (!item) {
    return res.status(404).json({ error: "Item não encontrado." });
  }
  await db.prepare("DELETE FROM history WHERE id = ?").run(parseInt(req.params.id));
  res.json({ message: "Removido do histórico." });
});

// ============================================================
// === API PRÓPRIA (Feature 1) ===
// ============================================================

// Gera chave de API para usuários Team
app.post("/api/apikeys", authMiddleware, async (req, res) => {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user || user.plan !== "team") {
    return res.status(403).json({ error: "API própria disponível apenas no plano Team." });
  }

  const { name } = req.body;
  const key = "dai_" + crypto.randomBytes(24).toString("hex");

  await db.prepare("INSERT INTO api_keys (user_id, key, name) VALUES (?, ?, ?)").run(req.user.id, key, name || "Default");

  res.status(201).json({ key, name: name || "Default" });
});

// Lista chaves de API do usuário
app.get("/api/apikeys", authMiddleware, async (req, res) => {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user || user.plan !== "team") {
    return res.status(403).json({ error: "API própria disponível apenas no plano Team." });
  }

  const keys = await db.prepare("SELECT id, name, key, created_at, last_used_at FROM api_keys WHERE user_id = ?").all(req.user.id);
  res.json({ keys });
});

// Revoga chave de API
app.delete("/api/apikeys/:id", authMiddleware, async (req, res) => {
  const key = await db.prepare("SELECT * FROM api_keys WHERE id = ? AND user_id = ?").get(parseInt(req.params.id), req.user.id);
  if (!key) {
    return res.status(404).json({ error: "Chave não encontrada." });
  }
  await db.prepare("DELETE FROM api_keys WHERE id = ?").run(parseInt(req.params.id));
  res.json({ message: "Chave revogada com sucesso." });
});

// Endpoint público da API (autenticação via X-API-Key)
app.post("/api/v1/analyze", async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return res.status(401).json({ error: "Header X-API-Key é obrigatório." });
  }

  const keyRecord = await db.prepare("SELECT * FROM api_keys WHERE key = ?").get(apiKey);
  if (!keyRecord) {
    return res.status(401).json({ error: "Chave de API inválida." });
  }

  // Atualiza último uso
  await db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(keyRecord.id);

  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(keyRecord.user_id);
  if (!user || user.plan !== "team") {
    return res.status(403).json({ error: "Chave vinculada a um plano sem acesso à API." });
  }

  const { linguagem, erro, codigo, contexto } = req.body;
  if (!erro) {
    return res.status(400).json({ error: "Campo 'erro' é obrigatório." });
  }

  try {
    const resultado = await debugCode({ linguagem, erro, codigo, contexto });

    // Incrementa contador e salva no histórico
    await db.prepare("UPDATE users SET analysis_count = analysis_count + 1 WHERE id = ?").run(user.id);
    await db.prepare("INSERT INTO history (user_id, type, input_error, input_code, input_context, response) VALUES (?, ?, ?, ?, ?, ?)")
      .run(user.id, "api", erro, codigo || null, contexto || null, resultado);

    res.json({ resultado });
  } catch (err) {
    console.error("Erro na API v1:", err.message || err);
    res.status(500).json({ error: "Erro ao processar análise." });
  }
});

// ============================================================
// === DASHBOARD DO TIME (Feature 2) ===
// ============================================================

// Lista membros do time
app.get("/api/team/members", authMiddleware, async (req, res) => {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user || user.plan !== "team") {
    return res.status(403).json({ error: "Dashboard do time disponível apenas no plano Team." });
  }

  const members = await db.prepare(
    "SELECT tm.id, tm.added_at, u.id as user_id, u.name, u.email, u.plan FROM team_members tm JOIN users u ON tm.member_id = u.id WHERE tm.team_owner_id = ?"
  ).all(req.user.id);

  res.json({ members });
});

// Convida membro por email
app.post("/api/team/invite", authMiddleware, async (req, res) => {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user || user.plan !== "team") {
    return res.status(403).json({ error: "Dashboard do time disponível apenas no plano Team." });
  }

  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: "E-mail é obrigatório." });
  }

  // Verifica limite de 10 membros
  const currentMembers = await db.prepare("SELECT COUNT(*) as count FROM team_members WHERE team_owner_id = ?").get(req.user.id);
  if (currentMembers.count >= 10) {
    return res.status(400).json({ error: "Limite de 10 membros atingido." });
  }

  // Busca usuário pelo email
  const member = await db.prepare("SELECT id, name, email FROM users WHERE email = ?").get(email);
  if (!member) {
    return res.status(404).json({ error: "Usuário não encontrado. O membro precisa ter uma conta no debugAI." });
  }

  if (member.id === req.user.id) {
    return res.status(400).json({ error: "Você não pode se convidar." });
  }

  // Verifica se já é membro
  const existing = await db.prepare("SELECT id FROM team_members WHERE team_owner_id = ? AND member_id = ?").get(req.user.id, member.id);
  if (existing) {
    return res.status(409).json({ error: "Este usuário já é membro do seu time." });
  }

  await db.prepare("INSERT INTO team_members (team_owner_id, member_id) VALUES (?, ?)").run(req.user.id, member.id);

  res.status(201).json({ message: "Membro adicionado com sucesso!", member: { id: member.id, name: member.name, email: member.email } });
});

// Remove membro do time
app.delete("/api/team/members/:id", authMiddleware, async (req, res) => {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user || user.plan !== "team") {
    return res.status(403).json({ error: "Dashboard do time disponível apenas no plano Team." });
  }

  const membership = await db.prepare("SELECT * FROM team_members WHERE id = ? AND team_owner_id = ?").get(parseInt(req.params.id), req.user.id);
  if (!membership) {
    return res.status(404).json({ error: "Membro não encontrado." });
  }

  await db.prepare("DELETE FROM team_members WHERE id = ?").run(parseInt(req.params.id));
  res.json({ message: "Membro removido com sucesso." });
});

// ============================================================
// === SUPORTE PRIORITÁRIO (Feature 3) ===
// ============================================================

// Cria ticket de suporte
app.post("/api/support", authMiddleware, async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message) {
    return res.status(400).json({ error: "Assunto e mensagem são obrigatórios." });
  }

  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  const priority = user && user.plan === "team" ? "prioritário" : "normal";

  await db.prepare("INSERT INTO support_tickets (user_id, subject, message, priority) VALUES (?, ?, ?, ?)")
    .run(req.user.id, subject, message, priority);

  res.status(201).json({ message: "Ticket criado com sucesso!", priority });
});

// Lista tickets do usuário
app.get("/api/support", authMiddleware, async (req, res) => {
  const tickets = await db.prepare(
    "SELECT id, subject, message, status, priority, created_at FROM support_tickets WHERE user_id = ? ORDER BY created_at DESC"
  ).all(req.user.id);

  res.json({ tickets });
});

// ============================================================
// === RELATÓRIOS DE BUGS (Feature 4) ===
// ============================================================

app.get("/api/reports", authMiddleware, async (req, res) => {
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user || user.plan !== "team") {
    return res.status(403).json({ error: "Relatórios disponíveis apenas no plano Team." });
  }

  // Total de análises
  const totalResult = await db.prepare("SELECT COUNT(*) as total FROM history WHERE user_id = ?").get(req.user.id);
  const total = totalResult ? totalResult.total : 0;

  // Erros por tipo
  const errorsByType = await db.prepare(
    "SELECT type, COUNT(*) as count FROM history WHERE user_id = ? GROUP BY type"
  ).all(req.user.id);

  // Erros mais comuns (top 5 por input_error)
  const mostCommon = await db.prepare(
    "SELECT input_error, COUNT(*) as count FROM history WHERE user_id = ? AND input_error IS NOT NULL GROUP BY input_error ORDER BY count DESC LIMIT 5"
  ).all(req.user.id);

  // Uso semanal (últimos 7 dias)
  const weeklyUsage = await db.prepare(
    "SELECT DATE(created_at) as day, COUNT(*) as count FROM history WHERE user_id = ? AND created_at >= datetime('now', '-7 days') GROUP BY DATE(created_at) ORDER BY day"
  ).all(req.user.id);

  res.json({
    total,
    errorsByType,
    mostCommon,
    weeklyUsage,
  });
});

// === INICIA SERVIDOR ===
async function start() {
  await initDatabase();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`DebugAI rodando em http://localhost:${PORT}`);
  });
}

start();
