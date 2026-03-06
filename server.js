const express  = require("express");
const crypto   = require("crypto");
const cors     = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// CORS — autorise toutes les origines (nécessaire pour Claude.ai)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id                   TEXT PRIMARY KEY,
      created_at           TIMESTAMPTZ DEFAULT NOW(),
      source               TEXT,
      typeform_response_id TEXT UNIQUE,
      status               TEXT DEFAULT 'new',
      freelance_id         TEXT,
      deadline             TEXT,
      project_type         TEXT,
      client_name          TEXT,
      client_email         TEXT,
      client_phone         TEXT,
      company              TEXT,
      description          TEXT,
      landing_objective    TEXT,
      offers               TEXT,
      assets               TEXT,
      colors               TEXT,
      inspiration          TEXT
    )
  `);
  console.log("✅ Table orders prête");
}

function deadline7() {
  return new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
}

function getByIndex(answers, idx) {
  const ans = answers[idx];
  if (!ans) return "";
  return ans.text
    || ans.email
    || ans.phone_number
    || ans.url
    || ans.choice?.label
    || ans.choices?.labels?.join(", ")
    || ans.number?.toString()
    || "";
}

// ─── POST /webhook/typeform ───────────────────────────────────────────────────
app.post("/webhook/typeform", async (req, res) => {
  try {
    const { form_response } = req.body;
    if (!form_response) return res.sendStatus(400);

    const answers = form_response.answers || [];
    const id = crypto.randomUUID();

    await pool.query(`
      INSERT INTO orders (
        id, source, typeform_response_id, status, freelance_id, deadline, project_type,
        description, client_name, client_phone, client_email, company,
        landing_objective, offers, assets, colors, inspiration
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (typeform_response_id) DO NOTHING
    `, [
      id, "typeform", form_response.token, "new", null, deadline7(), "Landing page",
      getByIndex(answers, 0),  // description
      getByIndex(answers, 1),  // clientName
      getByIndex(answers, 2),  // clientPhone
      getByIndex(answers, 3),  // clientEmail
      getByIndex(answers, 4),  // company
      getByIndex(answers, 5),  // landingObjective
      getByIndex(answers, 6),  // offers
      getByIndex(answers, 7),  // assets
      getByIndex(answers, 8),  // colors
      getByIndex(answers, 9),  // inspiration
    ]);

    console.log(`✅ Commande reçue : ${getByIndex(answers, 1)}`);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erreur webhook :", err.message);
    res.sendStatus(500);
  }
});

// ─── GET /orders ──────────────────────────────────────────────────────────────
app.get("/orders", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
    res.json(rows.map(r => ({
      id:                 r.id,
      createdAt:          r.created_at,
      source:             r.source,
      typeformResponseId: r.typeform_response_id,
      status:             r.status,
      freelanceId:        r.freelance_id,
      deadline:           r.deadline,
      projectType:        r.project_type,
      clientName:         r.client_name,
      clientEmail:        r.client_email,
      clientPhone:        r.client_phone,
      company:            r.company,
      description:        r.description,
      landingObjective:   r.landing_objective,
      offers:             r.offers,
      assets:             r.assets,
      colors:             r.colors,
      inspiration:        r.inspiration,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET / — health check ─────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT COUNT(*) FROM orders");
    res.json({
      status: "✅ Openshore Webhook Server running",
      db:     "✅ PostgreSQL connecté",
      orders: parseInt(rows[0].count),
      uptime: Math.floor(process.uptime()) + "s",
    });
  } catch (err) {
    res.json({ status: "✅ Server running", db: "❌ DB non connectée", error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Port ${PORT}`)))
  .catch(err => { console.error("❌ DB init failed:", err); process.exit(1); });
