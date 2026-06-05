const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { db } = require("./database");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "debugai-secret-key-change-me";

// === REGISTRO ===
router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Todos os campos são obrigatórios." });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Senha deve ter pelo menos 6 caracteres." });
  }

  try {
    // Verifica se email já existe
    const existingUser = await db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existingUser) {
      return res.status(409).json({ error: "Este e-mail já está cadastrado." });
    }

    // Hash da senha
    const hashedPassword = bcrypt.hashSync(password, 10);

    // Insere no banco
    const result = await db.prepare("INSERT INTO users (name, email, password) VALUES (?, ?, ?)").run(name, email, hashedPassword);

    // Gera token JWT
    const token = jwt.sign({ id: result.lastInsertRowid, email, name }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(201).json({
      message: "Conta criada com sucesso!",
      token,
      user: { id: result.lastInsertRowid, name, email, plan: "free", analysis_count: 0 },
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
