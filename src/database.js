const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "..", "debugai.db"));

// Cria a tabela de usuários se não existir
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    plan TEXT DEFAULT 'free',
    analysis_count INTEGER DEFAULT 0,
    stripe_customer_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Adiciona coluna stripe_customer_id se a tabela já existia sem ela
try {
  db.exec("ALTER TABLE users ADD COLUMN stripe_customer_id TEXT");
} catch (e) {
  // Coluna já existe, ignora
}

// Adiciona coluna de data de reset das análises
try {
  db.exec("ALTER TABLE users ADD COLUMN analysis_reset_date TEXT");
} catch (e) {
  // Coluna já existe, ignora
}

// Tabela de histórico de análises
db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT DEFAULT 'error',
    input_error TEXT,
    input_code TEXT,
    input_context TEXT,
    response TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

module.exports = db;
