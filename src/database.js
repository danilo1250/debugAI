const { createClient } = require("@libsql/client");

// Se tiver URL do Turso, usa banco na nuvem. Senão, usa arquivo local.
const isProduction = !!process.env.TURSO_DATABASE_URL;

const db = createClient(
  isProduction
    ? {
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN,
      }
    : {
        url: "file:debugai.db",
      }
);

// Inicializa as tabelas
async function initDatabase() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      plan TEXT DEFAULT 'free',
      analysis_count INTEGER DEFAULT 0,
      stripe_customer_id TEXT,
      analysis_reset_date TEXT,
      referral_code TEXT UNIQUE,
      referred_by INTEGER,
      bonus_analyses INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migrações para colunas de referral (tabelas existentes)
  try { await db.execute("ALTER TABLE users ADD COLUMN referral_code TEXT"); } catch (e) {}
  try { await db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_code ON users(referral_code)"); } catch (e) {}
  try { await db.execute("ALTER TABLE users ADD COLUMN referred_by INTEGER"); } catch (e) {}
  try { await db.execute("ALTER TABLE users ADD COLUMN bonus_analyses INTEGER DEFAULT 0"); } catch (e) {}

  // Migração: coluna de favorito no histórico
  try { await db.execute("ALTER TABLE history ADD COLUMN is_favorite INTEGER DEFAULT 0"); } catch (e) {}

  // Migração: coluna de share_id no histórico (Feature: Compartilhar Análise)
  try { await db.execute("ALTER TABLE history ADD COLUMN share_id TEXT"); } catch (e) {}

  await db.execute(`
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

  await db.execute(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT 'Default',
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS team_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_owner_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      added_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (team_owner_id) REFERENCES users(id),
      FOREIGN KEY (member_id) REFERENCES users(id)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'aberto',
      priority TEXT DEFAULT 'normal',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  console.log("✓ Banco de dados inicializado");
}

// Helpers para manter compatibilidade com o código existente (que usava better-sqlite3)
const dbHelper = {
  prepare(sql) {
    return {
      async get(...params) {
        const result = await db.execute({ sql, args: params });
        return result.rows[0] || null;
      },
      async all(...params) {
        const result = await db.execute({ sql, args: params });
        return result.rows;
      },
      async run(...params) {
        const result = await db.execute({ sql, args: params });
        return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.rowsAffected };
      },
    };
  },
};

module.exports = { db: dbHelper, initDatabase };
