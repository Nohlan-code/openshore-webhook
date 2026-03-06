const express  = require("express");
const crypto   = require("crypto");
const cors     = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// CORS — autorise tout
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Init DB ──────────────────────────────────────────────────────────────────
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
      inspiration          TEXT,
      budget               TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS freelancers (
      id         TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      name       TEXT,
      email      TEXT UNIQUE,
      password   TEXT,
      phone      TEXT,
      specialty  TEXT,
      avatar     TEXT,
      active     BOOLEAN DEFAULT true
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tools (
      id          TEXT PRIMARY KEY,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      name        TEXT,
      url         TEXT,
      category    TEXT,
      icon        TEXT,
      description TEXT
    )
  `);

  // Seed freelancers si vide
  const flCount = await pool.query("SELECT COUNT(*) FROM freelancers");
  if (parseInt(flCount.rows[0].count) === 0) {
    await pool.query(`
      INSERT INTO freelancers (id, name, email, password, phone, specialty, avatar, active) VALUES
      ('f1','Sophie Martin','sophie@example.com','sophie123','+33600000001','WordPress','SM',true),
      ('f2','Lucas Bernard','lucas@example.com','lucas123','+33600000002','Shopify','LB',true),
      ('f3','Emma Dupont','emma@example.com','emma123','+33600000003','React/Next.js','ED',true)
      ON CONFLICT DO NOTHING
    `);
    console.log("✅ Freelancers seedés");
  }

  // Seed tools si vide
  const tlCount = await pool.query("SELECT COUNT(*) FROM tools");
  if (parseInt(tlCount.rows[0].count) === 0) {
    const tools = [
      ['t1','Fonts','https://docs.google.com/document/d/13hSWUderWjJANRQYFqInfckQLtnC1l2wJCjkwyTCkKM/edit','Fonts','🔤','Typographies approuvées'],
      ['t2','Icons','https://docs.google.com/document/d/1_ONUWb15xvWOAQsru_OrJ28GhOIo_gKQYCZv28CLWWw/edit','Icons','✨','Bibliothèque d\'icônes'],
      ['t3','Plugins','https://docs.google.com/document/d/1azomTQDR8mJDBf6jBUKRZ7I49n9dTEq5wSVlejKtB3Y/edit','Plugins','🔌','Plugins essentiels'],
      ['t4','Copywriting','https://openshore.eu/tools','Copywriting','✍️','Outils de copywriting'],
      ['t5','Checklist Website','https://claude.ai/public/artifacts/baf00510-0c04-449a-b15e-ca3778d68cd9','Checklist','✅','Checklist avant livraison'],
      ['t6','How to Deliver','https://www.loom.com/share/bb1e54bd460b446eb38da575532e0cf4','How to Deliver','🎬','Tutoriel vidéo livraison'],
    ];
    for (const [id, name, url, category, icon, description] of tools) {
      await pool.query(
        "INSERT INTO tools (id,name,url,category,icon,description) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [id, name, url, category, icon, description]
      );
    }
    console.log("✅ Tools seedés");
  }

  console.log("✅ DB initialisée");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function deadline7() {
  return new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
}
function getByIndex(answers, idx) {
  const ans = answers[idx];
  if (!ans) return "";
  return ans.text || ans.email || ans.phone_number || ans.url
    || ans.choice?.label || ans.choices?.labels?.join(", ") || "";
}
function rowToOrder(r) {
  return {
    id: r.id, createdAt: r.created_at, source: r.source,
    typeformResponseId: r.typeform_response_id, status: r.status,
    freelanceId: r.freelance_id, deadline: r.deadline, projectType: r.project_type,
    clientName: r.client_name, clientEmail: r.client_email, clientPhone: r.client_phone,
    company: r.company, description: r.description, landingObjective: r.landing_objective,
    offers: r.offers, assets: r.assets, colors: r.colors, inspiration: r.inspiration,
    budget: r.budget,
  };
}
function rowToFl(r) {
  return {
    id: r.id, name: r.name, email: r.email, password: r.password,
    phone: r.phone, specialty: r.specialty, avatar: r.avatar, active: r.active,
  };
}
function rowToTool(r) {
  return {
    id: r.id, name: r.name, url: r.url, category: r.category,
    icon: r.icon, description: r.description,
  };
}

// ════════════════════════════════════════════════════════════════════
// ORDERS
// ════════════════════════════════════════════════════════════════════
app.post("/webhook/typeform", async (req, res) => {
  try {
    const { form_response } = req.body;
    if (!form_response) return res.sendStatus(400);
    const answers = form_response.answers || [];
    const id = crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id,source,typeform_response_id,status,freelance_id,deadline,project_type,
        description,client_name,client_phone,client_email,company,
        landing_objective,offers,assets,colors,inspiration)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (typeform_response_id) DO NOTHING
    `, [
      id,"typeform",form_response.token,"new",null,deadline7(),"Landing page",
      getByIndex(answers,0),getByIndex(answers,1),getByIndex(answers,2),
      getByIndex(answers,3),getByIndex(answers,4),getByIndex(answers,5),
      getByIndex(answers,6),getByIndex(answers,7),getByIndex(answers,8),getByIndex(answers,9),
    ]);
    console.log(`✅ Commande Typeform reçue`);
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(500);
  }
});

app.get("/orders", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
    res.json(rows.map(rowToOrder));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/orders", async (req, res) => {
  try {
    const o = req.body;
    const id = o.id || crypto.randomUUID();
    await pool.query(`
      INSERT INTO orders (id,source,status,freelance_id,deadline,project_type,
        client_name,client_email,client_phone,company,description,budget)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        status=$3,freelance_id=$4,deadline=$5,project_type=$6,
        client_name=$7,client_email=$8,client_phone=$9,company=$10,description=$11,budget=$12
    `, [id, o.source||"manual", o.status||"new", o.freelanceId||null,
        o.deadline||deadline7(), o.projectType||"Landing page",
        o.clientName||"", o.clientEmail||"", o.clientPhone||"",
        o.company||"", o.description||"", o.budget||""]);
    const { rows } = await pool.query("SELECT * FROM orders WHERE id=$1", [id]);
    res.json(rowToOrder(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/orders/:id", async (req, res) => {
  try {
    const o = req.body;
    await pool.query(`
      UPDATE orders SET status=$2,freelance_id=$3,deadline=$4,project_type=$5,
        client_name=$6,client_email=$7,client_phone=$8,company=$9,description=$10,budget=$11
      WHERE id=$1
    `, [req.params.id, o.status, o.freelanceId||null, o.deadline,
        o.projectType, o.clientName, o.clientEmail, o.clientPhone,
        o.company, o.description, o.budget||""]);
    const { rows } = await pool.query("SELECT * FROM orders WHERE id=$1", [req.params.id]);
    res.json(rowToOrder(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/orders/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM orders WHERE id=$1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════
// FREELANCERS
// ════════════════════════════════════════════════════════════════════
app.get("/freelancers", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM freelancers ORDER BY created_at ASC");
    res.json(rows.map(rowToFl));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/freelancers", async (req, res) => {
  try {
    const f = req.body;
    const id = f.id || crypto.randomUUID();
    await pool.query(`
      INSERT INTO freelancers (id,name,email,password,phone,specialty,avatar,active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET
        name=$2,email=$3,password=$4,phone=$5,specialty=$6,avatar=$7,active=$8
    `, [id, f.name, f.email, f.password||"", f.phone||"", f.specialty||"", f.avatar||"", f.active!==false]);
    const { rows } = await pool.query("SELECT * FROM freelancers WHERE id=$1", [id]);
    res.json(rowToFl(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/freelancers/:id", async (req, res) => {
  try {
    const f = req.body;
    await pool.query(`
      UPDATE freelancers SET name=$2,email=$3,password=$4,phone=$5,specialty=$6,avatar=$7,active=$8
      WHERE id=$1
    `, [req.params.id, f.name, f.email, f.password||"", f.phone||"", f.specialty||"", f.avatar||"", f.active!==false]);
    const { rows } = await pool.query("SELECT * FROM freelancers WHERE id=$1", [req.params.id]);
    res.json(rowToFl(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/freelancers/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM freelancers WHERE id=$1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════════════════
// TOOLS
// ════════════════════════════════════════════════════════════════════
app.get("/tools", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM tools ORDER BY created_at ASC");
    res.json(rows.map(rowToTool));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/tools", async (req, res) => {
  try {
    const tl = req.body;
    const id = tl.id || crypto.randomUUID();
    await pool.query(`
      INSERT INTO tools (id,name,url,category,icon,description)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET name=$2,url=$3,category=$4,icon=$5,description=$6
    `, [id, tl.name, tl.url||"", tl.category||"", tl.icon||"🔗", tl.description||""]);
    const { rows } = await pool.query("SELECT * FROM tools WHERE id=$1", [id]);
    res.json(rowToTool(rows[0]));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/tools/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM tools WHERE id=$1", [req.params.id]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  try {
    const o = await pool.query("SELECT COUNT(*) FROM orders");
    const f = await pool.query("SELECT COUNT(*) FROM freelancers");
    res.json({
      status: "✅ Openshore Webhook Server running",
      db:     "✅ PostgreSQL connecté",
      orders: parseInt(o.rows[0].count),
      freelancers: parseInt(f.rows[0].count),
      uptime: Math.floor(process.uptime()) + "s",
    });
  } catch (err) {
    res.json({ status: "✅ Server running", db: "❌ DB non connectée", error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`🚀 Port ${PORT}`)))
  .catch(err => { console.error("❌ DB init failed:", err); process.exit(1); });
