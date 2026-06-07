require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const crypto = require("crypto");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { debugCode } = require("./debug");
const { router: authRouter, authMiddleware } = require("./auth");
const paymentsRouter = require("./payments");
const { db, initDatabase } = require("./database");
const { canAnalyze, hasFeature, getPlanInfo } = require("./plans");

const app = express();

// === SEGURANÇA ===

// Helmet - headers de segurança (XSS, clickjacking, etc)
app.use(helmet({
  contentSecurityPolicy: false, // desativa pra não quebrar inline scripts
  crossOriginEmbedderPolicy: false,
}));

// CORS - restringe para o domínio correto
const allowedOrigins = [
  process.env.BASE_URL || "http://localhost:3000",
  "https://debugai-uhqi.onrender.com",
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // em dev permite tudo, em prod pode restringir
    }
  },
  credentials: true,
}));

// Rate limiting geral - 200 req por 15 min por IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: "Muitas requisições. Tente novamente em alguns minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting para auth - 30 tentativas por 15 min (previne brute force)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Muitas tentativas de login. Aguarde 15 minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting para API de debug - 30 req por minuto
const debugLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Limite de requisições atingido. Aguarde 1 minuto." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Aplica rate limit geral
app.use("/api/", generalLimiter);

// IMPORTANTE: webhook do Stripe precisa do body raw, antes do express.json()
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// Serve arquivos estáticos (HTML, CSS, JS) da pasta public
app.use(express.static(path.join(__dirname, "..", "public")));

// Rotas de autenticação (register, login, me) - com rate limit anti brute force
app.use("/api/auth", authLimiter, authRouter);

// === ALTERAR SENHA ===
app.put("/api/auth/change-password", authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Senha atual e nova senha são obrigatórios." });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: "Nova senha deve ter pelo menos 6 caracteres." });
  }

  if (newPassword.length > 128) {
    return res.status(400).json({ error: "Nova senha muito longa." });
  }

  try {
    const user = await db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    const bcrypt = require("bcryptjs");
    const validPassword = bcrypt.compareSync(currentPassword, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: "Senha atual incorreta." });
    }

    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    await db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashedPassword, user.id);

    res.json({ message: "Senha alterada com sucesso!" });
  } catch (err) {
    console.error("Erro ao alterar senha:", err);
    res.status(500).json({ error: "Erro interno ao alterar senha." });
  }
});

// Rotas de pagamento (checkout, webhook)
app.use("/api/payments", paymentsRouter);

// === API DE DEBUG ===
app.post("/api/debug", debugLimiter, authMiddleware, async (req, res) => {
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

// Limpa todo o histórico do usuário
app.delete("/api/history", authMiddleware, async (req, res) => {
  await db.prepare("DELETE FROM history WHERE user_id = ?").run(req.user.id);
  res.json({ message: "Histórico limpo." });
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

// ============================================================
// === ADMIN PANEL ===
// ============================================================

// Middleware de admin - só permite acesso ao email configurado
function adminMiddleware(req, res, next) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail || req.user.email !== adminEmail) {
    return res.status(403).json({ error: "Acesso negado." });
  }
  next();
}

// Lista todos os usuários
app.get("/api/admin/users", authMiddleware, adminMiddleware, async (req, res) => {
  const users = await db.prepare(
    "SELECT id, name, email, plan, analysis_count, created_at FROM users ORDER BY created_at DESC"
  ).all();
  res.json({ users });
});

// Muda plano de um usuário
app.put("/api/admin/users/:id/plan", authMiddleware, adminMiddleware, async (req, res) => {
  const { plan } = req.body;
  if (!["free", "pro", "team"].includes(plan)) {
    return res.status(400).json({ error: "Plano inválido." });
  }
  await db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, parseInt(req.params.id));
  res.json({ message: `Plano atualizado para ${plan}.` });
});

// Deleta um usuário
app.delete("/api/admin/users/:id", authMiddleware, adminMiddleware, async (req, res) => {
  const userId = parseInt(req.params.id);
  if (userId === req.user.id) {
    return res.status(400).json({ error: "Você não pode deletar a si mesmo." });
  }
  await db.prepare("DELETE FROM history WHERE user_id = ?").run(userId);
  await db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(userId);
  await db.prepare("DELETE FROM team_members WHERE team_owner_id = ? OR member_id = ?").run(userId, userId);
  await db.prepare("DELETE FROM support_tickets WHERE user_id = ?").run(userId);
  await db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  res.json({ message: "Usuário removido." });
});

// Lista todos os tickets (admin vê todos)
app.get("/api/admin/tickets", authMiddleware, adminMiddleware, async (req, res) => {
  const tickets = await db.prepare(
    "SELECT t.*, u.name as user_name, u.email as user_email FROM support_tickets t JOIN users u ON t.user_id = u.id ORDER BY t.created_at DESC"
  ).all();
  res.json({ tickets });
});

// Responde/atualiza status de um ticket
app.put("/api/admin/tickets/:id", authMiddleware, adminMiddleware, async (req, res) => {
  const { status } = req.body;
  if (!["aberto", "resolvido"].includes(status)) {
    return res.status(400).json({ error: "Status inválido." });
  }
  await db.prepare("UPDATE support_tickets SET status = ? WHERE id = ?").run(status, parseInt(req.params.id));
  res.json({ message: `Ticket atualizado para ${status}.` });
});

// Estatísticas gerais (admin)
app.get("/api/admin/stats", authMiddleware, adminMiddleware, async (req, res) => {
  const totalUsers = await db.prepare("SELECT COUNT(*) as count FROM users").get();
  const totalAnalyses = await db.prepare("SELECT COUNT(*) as count FROM history").get();
  const totalTickets = await db.prepare("SELECT COUNT(*) as count FROM support_tickets").get();
  const openTickets = await db.prepare("SELECT COUNT(*) as count FROM support_tickets WHERE status = 'aberto'").get();
  const planCounts = await db.prepare("SELECT plan, COUNT(*) as count FROM users GROUP BY plan").all();

  res.json({
    totalUsers: totalUsers.count,
    totalAnalyses: totalAnalyses.count,
    totalTickets: totalTickets.count,
    openTickets: openTickets.count,
    planCounts,
  });
});

// Reseta senha de um usuário (admin gera senha temporária)
app.post("/api/admin/users/:id/reset-password", authMiddleware, adminMiddleware, async (req, res) => {
  const userId = parseInt(req.params.id);
  const user = await db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId);
  if (!user) {
    return res.status(404).json({ error: "Usuário não encontrado." });
  }

  // Gera senha temporária de 8 caracteres
  const tempPassword = crypto.randomBytes(4).toString("hex"); // 8 chars hex
  const bcrypt = require("bcryptjs");
  const hashedPassword = bcrypt.hashSync(tempPassword, 10);

  await db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashedPassword, userId);

  res.json({ message: "Senha resetada com sucesso.", tempPassword, user: { name: user.name, email: user.email } });
});

// Verifica se é admin
app.get("/api/admin/check", authMiddleware, (req, res) => {
  const adminEmail = process.env.ADMIN_EMAIL;
  const isAdmin = adminEmail && req.user.email === adminEmail;
  res.json({ isAdmin });
});

// ============================================================
// === STATS PESSOAIS ===
// ============================================================

app.get("/api/stats/personal", authMiddleware, async (req, res) => {
  try {
    // Total bugs resolvidos (total de itens no histórico)
    const totalResult = await db.prepare("SELECT COUNT(*) as total FROM history WHERE user_id = ?").get(req.user.id);
    const totalBugs = totalResult ? totalResult.total : 0;

    // Tempo economizado (estimativa: 3 min por análise)
    const tempoEconomizado = totalBugs * 3;

    // Linguagem mais usada (extraída do input_error ou input_code — usamos o campo que mais aparece)
    const linguagemResult = await db.prepare(
      "SELECT input_error, input_code FROM history WHERE user_id = ? AND input_error IS NOT NULL"
    ).all(req.user.id);

    // Tenta detectar linguagens por keywords comuns nos erros
    const langCounts = {};
    const langKeywords = {
      "JavaScript": ["TypeError", "ReferenceError", "undefined is not", "Cannot read prop", "node_modules", ".js:", "const ", "let ", "var "],
      "Python": ["Traceback", "IndentationError", "NameError", "ImportError", ".py", "def ", "self."],
      "TypeScript": [".ts:", "Type '", "is not assignable", "interface ", "TSError"],
      "Java": [".java:", "NullPointerException", "ClassNotFoundException", "public class"],
      "PHP": ["Fatal error", ".php:", "Undefined variable", "<?php"],
      "C#": [".cs:", "NullReferenceException", "System.", "namespace "],
      "Ruby": [".rb:", "NoMethodError", "undefined method"],
      "Go": [".go:", "panic:", "goroutine"],
      "React": ["jsx", "useState", "useEffect", "Component", "React"],
      "SQL": ["SELECT", "INSERT", "UPDATE", "DELETE", "FROM", "WHERE"],
    };

    for (const item of linguagemResult) {
      const text = (item.input_error || "") + " " + (item.input_code || "");
      for (const [lang, keywords] of Object.entries(langKeywords)) {
        for (const kw of keywords) {
          if (text.includes(kw)) {
            langCounts[lang] = (langCounts[lang] || 0) + 1;
            break;
          }
        }
      }
    }

    let linguagemMaisUsada = "N/A";
    let maxCount = 0;
    for (const [lang, count] of Object.entries(langCounts)) {
      if (count > maxCount) {
        maxCount = count;
        linguagemMaisUsada = lang;
      }
    }

    // Streak: dias consecutivos usando (contando para trás a partir de hoje)
    const daysResult = await db.prepare(
      "SELECT DISTINCT DATE(created_at) as day FROM history WHERE user_id = ? ORDER BY day DESC"
    ).all(req.user.id);

    let streak = 0;
    if (daysResult && daysResult.length > 0) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      // Verifica se usou hoje ou ontem pra iniciar o streak
      const lastDay = new Date(daysResult[0].day);
      lastDay.setHours(0, 0, 0, 0);
      
      const diffFromToday = Math.floor((today - lastDay) / (1000 * 60 * 60 * 24));
      
      if (diffFromToday <= 1) {
        streak = 1;
        for (let i = 1; i < daysResult.length; i++) {
          const prevDay = new Date(daysResult[i - 1].day);
          const currDay = new Date(daysResult[i].day);
          const diff = Math.floor((prevDay - currDay) / (1000 * 60 * 60 * 24));
          if (diff === 1) {
            streak++;
          } else {
            break;
          }
        }
      }
    }

    res.json({
      totalBugs,
      tempoEconomizado,
      linguagemMaisUsada,
      streak,
    });
  } catch (err) {
    console.error("Erro ao buscar stats pessoais:", err);
    res.status(500).json({ error: "Erro ao buscar estatísticas." });
  }
});

// ============================================================
// === REFERRAL SYSTEM ===
// ============================================================

app.get("/api/referral", authMiddleware, async (req, res) => {
  try {
    const user = await db.prepare("SELECT referral_code, bonus_analyses FROM users WHERE id = ?").get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }

    // Conta quantas pessoas foram referidas por este usuário
    const referredResult = await db.prepare("SELECT COUNT(*) as count FROM users WHERE referred_by = ?").get(req.user.id);
    const referredCount = referredResult ? referredResult.count : 0;

    res.json({
      referralCode: user.referral_code,
      referralLink: `https://debugai-uhqi.onrender.com/?ref=${user.referral_code}`,
      referredCount,
      bonusAnalyses: user.bonus_analyses || 0,
    });
  } catch (err) {
    console.error("Erro ao buscar referral:", err);
    res.status(500).json({ error: "Erro ao buscar dados de referral." });
  }
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
