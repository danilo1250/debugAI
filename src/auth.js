const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { db } = require("./database");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "debugai-secret-key-change-me";

// Gera código de referral único (6 caracteres alfanuméricos)
function generateReferralCode() {
  return crypto.randomBytes(4).toString("base64url").substring(0, 6).toUpperCase();
}

// === REGISTRO ===
router.post("/register", async (req, res) => {
  const { name, email, password, referralCode } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios." });
  }

  // Sanitização básica
  const cleanName = name.trim().substring(0, 100).replace(/[<>]/g, "");
  const cleanEmail = email.trim().toLowerCase().substring(0, 255);

  if (password.length < 6) {
    return res.status(400).json({ error: "Senha deve ter pelo menos 6 caracteres." });
  }

  if (password.length > 128) {
    return res.status(400).json({ error: "Senha muito longa." });
  }

  // Validação básica de email
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: "E-mail inválido." });
  }

  try {
    // Verifica se email já existe
    const existingUser = await db.prepare("SELECT id FROM users WHERE email = ?").get(cleanEmail);
    if (existingUser) {
      return res.status(409).json({ error: "Este e-mail já está cadastrado." });
    }

    // Hash da senha
    const hashedPassword = bcrypt.hashSync(password, 10);

    // Gera código de referral único para o novo usuário
    let newReferralCode = generateReferralCode();
    let attempts = 0;
    while (attempts < 10) {
      const existing = await db.prepare("SELECT id FROM users WHERE referral_code = ?").get(newReferralCode);
      if (!existing) break;
      newReferralCode = generateReferralCode();
      attempts++;
    }

    // Verifica se o referralCode enviado é válido (referenciado por alguém)
    let referrerId = null;
    if (referralCode && referralCode.trim()) {
      const referrer = await db.prepare("SELECT id FROM users WHERE referral_code = ?").get(referralCode.trim().toUpperCase());
      if (referrer) {
        referrerId = referrer.id;
      }
    }

    // Insere no banco com referral_code e referred_by
    const result = await db.prepare(
      "INSERT INTO users (name, email, password, referral_code, referred_by) VALUES (?, ?, ?, ?, ?)"
    ).run(cleanName, cleanEmail, hashedPassword, newReferralCode, referrerId);

    // Se foi referido, dá +5 bônus de análises ao referenciador
    if (referrerId) {
      await db.prepare("UPDATE users SET bonus_analyses = bonus_analyses + 5 WHERE id = ?").run(referrerId);
    }

    // Gera token JWT
    const token = jwt.sign({ id: result.lastInsertRowid, email: cleanEmail, name: cleanName }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(201).json({
      message: "Conta criada com sucesso!",
      token,
      user: { id: result.lastInsertRowid, name: cleanName, email: cleanEmail, plan: "free", analysis_count: 0 },
    });
  } catch (err) {
    console.error("Erro no registro:", err);
    res.status(500).json({ error: "Erro interno ao criar conta." });
  }
});

// === LOGIN ===
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "E-mail e senha são obrigatórios." });
  }

  try {
    // Busca usuário
    const user = await db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) {
      return res.status(401).json({ error: "E-mail ou senha inválidos." });
    }

    // Verifica senha
    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: "E-mail ou senha inválidos." });
    }

    // Gera token JWT
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({
      message: "Login realizado!",
      token,
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan, analysis_count: user.analysis_count },
    });
  } catch (err) {
    console.error("Erro no login:", err);
    res.status(500).json({ error: "Erro interno ao fazer login." });
  }
});

// === MIDDLEWARE DE AUTENTICAÇÃO ===
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Token não fornecido." });
  }

  const token = authHeader.replace("Bearer ", "");
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Token inválido ou expirado." });
  }
}

// === ROTA PARA PEGAR DADOS DO USUÁRIO LOGADO ===
router.get("/me", authMiddleware, async (req, res) => {
  try {
    const user = await db.prepare("SELECT id, name, email, plan, analysis_count, created_at FROM users WHERE id = ?").get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: "Usuário não encontrado." });
    }
    res.json({ user });
  } catch (err) {
    console.error("Erro ao buscar usuário:", err);
    res.status(500).json({ error: "Erro interno." });
  }
});

module.exports = { router, authMiddleware };
