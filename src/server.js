require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
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

// === INICIA SERVIDOR ===
async function start() {
  await initDatabase();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`DebugAI rodando em http://localhost:${PORT}`);
  });
}

start();
