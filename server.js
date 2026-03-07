const express  = require("express");
const crypto   = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

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

// ─── Email via Resend (optionnel — set RESEND_API_KEY dans Railway) ────────────
async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !to || !to.includes("@")) return;
  try {
    const from = process.env.RESEND_FROM || "Openshore <noreply@openshore.eu>";
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html })
    });
    console.log(`📧 Email envoyé à ${to}`);
  } catch (e) { console.log("Email skip:", e.message); }
}

function emailAssignOrder(fl, order) {
  return sendEmail(fl.email, `[Openshore] Nouvelle mission : ${order.client_name}`, `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
      <h2 style="color:#F0A500">⚡ Openshore Workspace</h2>
      <p>Bonjour <strong>${fl.name}</strong>,</p>
      <p>Une nouvelle commande t'a été assignée :</p>
      <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0">
        <p><strong>Client :</strong> ${order.client_name}</p>
        <p><strong>Projet :</strong> ${order.project_type||"Landing page"}</p>
        <p><strong>Deadline :</strong> ${order.deadline||"—"}</p>
      </div>
      <p>Connecte-toi sur <a href="https://openshore-crm.vercel.app">Openshore Workspace</a> pour voir les détails.</p>
      <p style="color:#999;font-size:12px">— Equipe Openshore</p>
    </div>`);
}
function emailAssignRevision(fl, rev) {
  return sendEmail(fl.email, `[Openshore] Nouvelle révision : ${rev.client_name}`, `
    <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:20px">
      <h2 style="color:#F0A500">⚡ Openshore Workspace</h2>
      <p>Bonjour <strong>${fl.name}</strong>,</p>
      <p>Une nouvelle révision t'a été assignée :</p>
      <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin:16px 0">
        <p><strong>Client :</strong> ${rev.client_name}</p>
        <p><strong>Projet :</strong> ${rev.project_name||"—"}</p>
        <p><strong>⏰ Deadline :</strong> <strong style="color:#F85149">24h</strong></p>
      </div>
      <p>Connecte-toi sur <a href="https://openshore-crm.vercel.app">Openshore Workspace</a> pour voir les détails.</p>
      <p style="color:#999;font-size:12px">— Equipe Openshore</p>
    </div>`);
}

// ─── Init DB ──────────────────────────────────────────────────────────────────
async function initDB() {
  // ORDERS
  await pool.query(`CREATE TABLE IF NOT EXISTS orders (
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
    budget               TEXT,
    delivery_url         TEXT
  )`);

  // FREELANCERS
  await pool.query(`CREATE TABLE IF NOT EXISTS freelancers (
    id         TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    name       TEXT,
    email      TEXT UNIQUE,
    password   TEXT,
    phone      TEXT,
    specialty  TEXT,
    avatar     TEXT,
    active     BOOLEAN DEFAULT true
  )`);

  // TOOLS
  await pool.query(`CREATE TABLE IF NOT EXISTS tools (
    id          TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    name        TEXT,
    url         TEXT,
    category    TEXT,
    icon        TEXT,
    description TEXT
  )`);

  // REVISIONS
  await pool.query(`CREATE TABLE IF NOT EXISTS revisions (
    id                   TEXT PRIMARY KEY,
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    source               TEXT DEFAULT 'manual',
    typeform_response_id TEXT UNIQUE,
    status               TEXT DEFAULT 'new',
    freelance_id         TEXT,
    deadline             TIMESTAMPTZ,
    client_name          TEXT,
    client_email         TEXT,
    client_phone         TEXT,
    project_name         TEXT,
    revision_aspect      TEXT,
    revision_content     TEXT,
    revision_text        TEXT,
    revision_other       TEXT,
    delivery_url         TEXT
  )`);

  // COMMENTS
  await pool.query(`CREATE TABLE IF NOT EXISTS comments (
    id          TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    item_type   TEXT,
    item_id     TEXT,
    author_name TEXT,
    author_role TEXT,
    content     TEXT
  )`);

  // STATUS HISTORY
  await pool.query(`CREATE TABLE IF NOT EXISTS status_history (
    id          TEXT PRIMARY KEY,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    item_type   TEXT,
    item_id     TEXT,
    old_status  TEXT,
    new_status  TEXT,
    changed_by  TEXT
  )`);

  // Migrations colonnes manquantes
  const migrations = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS budget TEXT DEFAULT ''`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS company TEXT DEFAULT ''`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_url TEXT DEFAULT ''`,
    `ALTER TABLE revisions ADD COLUMN IF NOT EXISTS project_name TEXT DEFAULT ''`,
    `ALTER TABLE revisions ADD COLUMN IF NOT EXISTS revision_aspect TEXT DEFAULT ''`,
    `ALTER TABLE revisions ADD COLUMN IF NOT EXISTS revision_content TEXT DEFAULT ''`,
    `ALTER TABLE revisions ADD COLUMN IF NOT EXISTS revision_text TEXT DEFAULT ''`,
    `ALTER TABLE revisions ADD COLUMN IF NOT EXISTS revision_other TEXT DEFAULT ''`,
    `ALTER TABLE revisions ADD COLUMN IF NOT EXISTS delivery_url TEXT DEFAULT ''`,
  ];
  for (const m of migrations) await pool.query(m);

  // Seed freelancers
  const flCount = await pool.query("SELECT COUNT(*) FROM freelancers");
  if (parseInt(flCount.rows[0].count) === 0) {
    await pool.query(`INSERT INTO freelancers (id,name,email,password,phone,specialty,avatar,active) VALUES
      ('f1','Sophie Martin','sophie@example.com','sophie123','+33600000001','Niveau 1','SM',true),
      ('f2','Lucas Bernard','lucas@example.com','lucas123','+33600000002','Niveau 2','LB',true),
      ('f3','Emma Dupont','emma@example.com','emma123','+33600000003','Niveau 3','ED',true)
      ON CONFLICT DO NOTHING`);
  }

  // Seed tools
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
    for (const [id,name,url,category,icon,description] of tools) {
      await pool.query("INSERT INTO tools (id,name,url,category,icon,description) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
        [id,name,url,category,icon,description]);
    }
  }

  console.log("✅ DB initialisée");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function deadline7()  { return new Date(Date.now()+7*86400000).toISOString(); }
function deadline24() { return new Date(Date.now()+24*3600000).toISOString(); }

function getByIndex(answers, idx) {
  const ans = answers[idx];
  if (!ans) return "";
  return ans.text||ans.email||ans.phone_number||ans.url||ans.choice?.label||ans.choices?.labels?.join(", ")||"";
}

function rowToOrder(r) {
  return { id:r.id, createdAt:r.created_at, source:r.source, typeformResponseId:r.typeform_response_id,
    status:r.status, freelanceId:r.freelance_id, deadline:r.deadline, projectType:r.project_type,
    clientName:r.client_name, clientEmail:r.client_email, clientPhone:r.client_phone,
    company:r.company, description:r.description, landingObjective:r.landing_objective,
    offers:r.offers, assets:r.assets, colors:r.colors, inspiration:r.inspiration,
    budget:r.budget, deliveryUrl:r.delivery_url };
}
function rowToFl(r) {
  return { id:r.id, name:r.name, email:r.email, password:r.password,
    phone:r.phone, specialty:r.specialty, avatar:r.avatar, active:r.active, createdAt:r.created_at };
}
function rowToTool(r) {
  return { id:r.id, name:r.name, url:r.url, category:r.category, icon:r.icon, description:r.description };
}
function rowToRevision(r) {
  return { id:r.id, createdAt:r.created_at, source:r.source, typeformResponseId:r.typeform_response_id,
    status:r.status, freelanceId:r.freelance_id, deadline:r.deadline,
    clientName:r.client_name, clientEmail:r.client_email, clientPhone:r.client_phone,
    projectName:r.project_name, revisionAspect:r.revision_aspect, revisionContent:r.revision_content,
    revisionText:r.revision_text, revisionOther:r.revision_other, deliveryUrl:r.delivery_url };
}
function rowToComment(r) {
  return { id:r.id, createdAt:r.created_at, itemType:r.item_type, itemId:r.item_id,
    authorName:r.author_name, authorRole:r.author_role, content:r.content };
}
function rowToHistory(r) {
  return { id:r.id, createdAt:r.created_at, itemType:r.item_type, itemId:r.item_id,
    oldStatus:r.old_status, newStatus:r.new_status, changedBy:r.changed_by };
}

async function recordHistory(itemType, itemId, oldStatus, newStatus, changedBy) {
  if (oldStatus === newStatus) return;
  await pool.query(
    "INSERT INTO status_history (id,item_type,item_id,old_status,new_status,changed_by) VALUES ($1,$2,$3,$4,$5,$6)",
    [crypto.randomUUID(), itemType, itemId, oldStatus, newStatus, changedBy||"admin"]
  );
}

// ════════════════════════════════════════════════════════════════════
// TYPEFORM WEBHOOKS
// ════════════════════════════════════════════════════════════════════
app.post("/webhook/typeform", async (req, res) => {
  try {
    const { form_response } = req.body;
    if (!form_response) return res.sendStatus(400);
    const answers = form_response.answers || [];
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO orders (id,source,typeform_response_id,status,freelance_id,deadline,project_type,
        description,client_name,client_phone,client_email,company,landing_objective,offers,assets,colors,inspiration)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (typeform_response_id) DO NOTHING`,
      [id,"typeform",form_response.token,"new",null,deadline7(),"Landing page",
       getByIndex(answers,0),getByIndex(answers,1),getByIndex(answers,2),
       getByIndex(answers,3),getByIndex(answers,4),getByIndex(answers,5),
       getByIndex(answers,6),getByIndex(answers,7),getByIndex(answers,8),getByIndex(answers,9)]);
    console.log("✅ Commande Typeform reçue");
    res.sendStatus(200);
  } catch (err) { console.error("❌ Webhook commande:", err.message); res.sendStatus(500); }
});

app.post("/webhook/typeform-revision", async (req, res) => {
  try {
    const { form_response } = req.body;
    if (!form_response) return res.sendStatus(400);
    const answers = form_response.answers || [];
    const ci = answers[0]?.contact_info || {};
    const clientName  = [ci.first_name||"", ci.last_name||""].filter(Boolean).join(" ") || getByIndex(answers,0);
    const clientEmail = ci.email        || "";
    const clientPhone = ci.phone_number || "";
    const id = crypto.randomUUID();
    await pool.query(`INSERT INTO revisions (id,source,typeform_response_id,status,freelance_id,deadline,
        client_name,client_email,client_phone,project_name,revision_aspect,revision_content,revision_text,revision_other)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (typeform_response_id) DO NOTHING`,
      [id,"typeform",form_response.token,"new",null,deadline24(),
       clientName, clientEmail, clientPhone,
       getByIndex(answers,1), getByIndex(answers,2), getByIndex(answers,3),
       getByIndex(answers,4), getByIndex(answers,5)]);
    console.log(`✅ Révision reçue — ${clientName}`);
    res.sendStatus(200);
  } catch (err) { console.error("❌ Webhook révision:", err.message); res.sendStatus(500); }
});

// ════════════════════════════════════════════════════════════════════
// ORDERS CRUD
// ════════════════════════════════════════════════════════════════════
app.get("/orders", async (req, res) => {
  try { const {rows}=await pool.query("SELECT * FROM orders ORDER BY created_at DESC"); res.json(rows.map(rowToOrder)); }
  catch (err) { res.status(500).json({error:err.message}); }
});
app.post("/orders", async (req, res) => {
  try {
    const o=req.body; const id=o.id||crypto.randomUUID();
    await pool.query(`INSERT INTO orders (id,source,status,freelance_id,deadline,project_type,client_name,client_email,client_phone,company,description,budget,delivery_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET status=$3,freelance_id=$4,deadline=$5,project_type=$6,
        client_name=$7,client_email=$8,client_phone=$9,company=$10,description=$11,budget=$12,delivery_url=$13`,
      [id,o.source||"manual",o.status||"new",o.freelanceId||null,o.deadline||deadline7(),
       o.projectType||"Landing page",o.clientName||"",o.clientEmail||"",o.clientPhone||"",
       o.company||"",o.description||"",o.budget||"",o.deliveryUrl||""]);
    const {rows}=await pool.query("SELECT * FROM orders WHERE id=$1",[id]);
    res.json(rowToOrder(rows[0]));
  } catch (err) { res.status(500).json({error:err.message}); }
});
app.put("/orders/:id", async (req, res) => {
  try {
    const {rows:existing}=await pool.query("SELECT * FROM orders WHERE id=$1",[req.params.id]);
    if(!existing.length) return res.status(404).json({error:"Not found"});
    const e=existing[0]; const o=req.body;
    const status      = o.status      ?? e.status      ?? "new";
    const freelanceId = o.freelanceId !== undefined ? (o.freelanceId||null) : e.freelance_id;
    const deadline    = o.deadline    ?? e.deadline    ?? null;
    const projectType = o.projectType ?? e.project_type ?? "Landing page";
    const clientName  = o.clientName  ?? e.client_name  ?? "";
    const clientEmail = o.clientEmail ?? e.client_email ?? "";
    const clientPhone = o.clientPhone ?? e.client_phone ?? "";
    const company     = o.company     ?? e.company      ?? "";
    const description = o.description ?? e.description  ?? "";
    const budget      = o.budget      ?? e.budget       ?? "";
    const deliveryUrl = o.deliveryUrl ?? e.delivery_url ?? "";
    await pool.query(`UPDATE orders SET status=$2,freelance_id=$3,deadline=$4,project_type=$5,
      client_name=$6,client_email=$7,client_phone=$8,company=$9,description=$10,budget=$11,delivery_url=$12 WHERE id=$1`,
      [req.params.id,status,freelanceId,deadline,projectType,clientName,clientEmail,clientPhone,company,description,budget,deliveryUrl]);
    // Historique
    if(e.status !== status) await recordHistory("order",req.params.id,e.status,status,o.changedBy||"admin");
    // Email si assignation
    if(freelanceId && freelanceId !== e.freelance_id) {
      const {rows:fls}=await pool.query("SELECT * FROM freelancers WHERE id=$1",[freelanceId]);
      if(fls.length) emailAssignOrder(fls[0], {...e, project_type:projectType, client_name:clientName, deadline});
    }
    const {rows}=await pool.query("SELECT * FROM orders WHERE id=$1",[req.params.id]);
    res.json(rowToOrder(rows[0]));
  } catch (err) { console.error("❌ PUT order:",err.message); res.status(500).json({error:err.message}); }
});
app.delete("/orders/:id", async (req, res) => {
  try { await pool.query("DELETE FROM orders WHERE id=$1",[req.params.id]); res.json({deleted:true}); }
  catch (err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════
// REVISIONS CRUD
// ════════════════════════════════════════════════════════════════════
app.get("/revisions", async (req, res) => {
  try {
    const {rows}=await pool.query("SELECT * FROM revisions ORDER BY deadline ASC NULLS LAST");
    res.json(rows.map(rowToRevision));
  } catch (err) { res.status(500).json({error:err.message}); }
});
app.post("/revisions", async (req, res) => {
  try {
    const rv=req.body; const id=rv.id||crypto.randomUUID();
    await pool.query(`INSERT INTO revisions (id,source,status,freelance_id,deadline,client_name,client_email,client_phone,
        project_name,revision_aspect,revision_content,revision_text,revision_other,delivery_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (id) DO UPDATE SET status=$3,freelance_id=$4,deadline=$5,client_name=$6,
        client_email=$7,client_phone=$8,project_name=$9,revision_aspect=$10,
        revision_content=$11,revision_text=$12,revision_other=$13,delivery_url=$14`,
      [id,rv.source||"manual",rv.status||"new",rv.freelanceId||null,rv.deadline||deadline24(),
       rv.clientName||"",rv.clientEmail||"",rv.clientPhone||"",rv.projectName||"",
       rv.revisionAspect||"",rv.revisionContent||"",rv.revisionText||"",rv.revisionOther||"",rv.deliveryUrl||""]);
    const {rows}=await pool.query("SELECT * FROM revisions WHERE id=$1",[id]);
    res.json(rowToRevision(rows[0]));
  } catch (err) { res.status(500).json({error:err.message}); }
});
app.put("/revisions/:id", async (req, res) => {
  try {
    const {rows:existing}=await pool.query("SELECT * FROM revisions WHERE id=$1",[req.params.id]);
    if(!existing.length) return res.status(404).json({error:"Not found"});
    const e=existing[0]; const rv=req.body;
    const status          = rv.status          ?? e.status          ?? "new";
    const freelanceId     = rv.freelanceId     !== undefined ? (rv.freelanceId||null) : e.freelance_id;
    const deadline        = rv.deadline        ?? e.deadline        ?? null;
    const clientName      = rv.clientName      ?? e.client_name     ?? "";
    const clientEmail     = rv.clientEmail     ?? e.client_email    ?? "";
    const clientPhone     = rv.clientPhone     ?? e.client_phone    ?? "";
    const projectName     = rv.projectName     ?? e.project_name    ?? "";
    const revisionAspect  = rv.revisionAspect  ?? e.revision_aspect  ?? "";
    const revisionContent = rv.revisionContent ?? e.revision_content ?? "";
    const revisionText    = rv.revisionText    ?? e.revision_text    ?? "";
    const revisionOther   = rv.revisionOther   ?? e.revision_other   ?? "";
    const deliveryUrl     = rv.deliveryUrl     ?? e.delivery_url    ?? "";
    await pool.query(`UPDATE revisions SET status=$2,freelance_id=$3,deadline=$4,client_name=$5,
      client_email=$6,client_phone=$7,project_name=$8,revision_aspect=$9,
      revision_content=$10,revision_text=$11,revision_other=$12,delivery_url=$13 WHERE id=$1`,
      [req.params.id,status,freelanceId,deadline,clientName,clientEmail,clientPhone,projectName,
       revisionAspect,revisionContent,revisionText,revisionOther,deliveryUrl]);
    // Historique
    if(e.status !== status) await recordHistory("revision",req.params.id,e.status,status,rv.changedBy||"admin");
    // Email si assignation
    if(freelanceId && freelanceId !== e.freelance_id) {
      const {rows:fls}=await pool.query("SELECT * FROM freelancers WHERE id=$1",[freelanceId]);
      if(fls.length) emailAssignRevision(fls[0], {...e, client_name:clientName, project_name:projectName});
    }
    const {rows}=await pool.query("SELECT * FROM revisions WHERE id=$1",[req.params.id]);
    res.json(rowToRevision(rows[0]));
  } catch (err) { console.error("❌ PUT revision:",err.message); res.status(500).json({error:err.message}); }
});
app.delete("/revisions/:id", async (req, res) => {
  try { await pool.query("DELETE FROM revisions WHERE id=$1",[req.params.id]); res.json({deleted:true}); }
  catch (err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════
// COMMENTS
// ════════════════════════════════════════════════════════════════════
app.get("/comments/:type/:id", async (req, res) => {
  try {
    const {rows}=await pool.query(
      "SELECT * FROM comments WHERE item_type=$1 AND item_id=$2 ORDER BY created_at ASC",
      [req.params.type, req.params.id]);
    res.json(rows.map(rowToComment));
  } catch (err) { res.status(500).json({error:err.message}); }
});
app.post("/comments", async (req, res) => {
  try {
    const c=req.body;
    const id=crypto.randomUUID();
    await pool.query("INSERT INTO comments (id,item_type,item_id,author_name,author_role,content) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, c.itemType, c.itemId, c.authorName||"Admin", c.authorRole||"admin", c.content]);
    const {rows}=await pool.query("SELECT * FROM comments WHERE id=$1",[id]);
    res.json(rowToComment(rows[0]));
  } catch (err) { res.status(500).json({error:err.message}); }
});
app.delete("/comments/:id", async (req, res) => {
  try { await pool.query("DELETE FROM comments WHERE id=$1",[req.params.id]); res.json({deleted:true}); }
  catch (err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════
// STATUS HISTORY
// ════════════════════════════════════════════════════════════════════
app.get("/history/:type/:id", async (req, res) => {
  try {
    const {rows}=await pool.query(
      "SELECT * FROM status_history WHERE item_type=$1 AND item_id=$2 ORDER BY created_at ASC",
      [req.params.type, req.params.id]);
    res.json(rows.map(rowToHistory));
  } catch (err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════
// FREELANCERS CRUD
// ════════════════════════════════════════════════════════════════════
app.get("/freelancers", async (req, res) => {
  try { const {rows}=await pool.query("SELECT * FROM freelancers ORDER BY created_at ASC"); res.json(rows.map(rowToFl)); }
  catch (err) { res.status(500).json({error:err.message}); }
});
app.post("/freelancers", async (req, res) => {
  try {
    const f=req.body; const id=f.id||crypto.randomUUID();
    await pool.query(`INSERT INTO freelancers (id,name,email,password,phone,specialty,avatar,active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET name=$2,email=$3,password=$4,phone=$5,specialty=$6,avatar=$7,active=$8`,
      [id,f.name,f.email,f.password||"",f.phone||"",f.specialty||"",f.avatar||"",f.active!==false]);
    const {rows}=await pool.query("SELECT * FROM freelancers WHERE id=$1",[id]);
    res.json(rowToFl(rows[0]));
  } catch (err) { res.status(500).json({error:err.message}); }
});
app.put("/freelancers/:id", async (req, res) => {
  try {
    const f=req.body;
    await pool.query(`UPDATE freelancers SET name=$2,email=$3,password=$4,phone=$5,specialty=$6,avatar=$7,active=$8 WHERE id=$1`,
      [req.params.id,f.name,f.email,f.password||"",f.phone||"",f.specialty||"",f.avatar||"",f.active!==false]);
    const {rows}=await pool.query("SELECT * FROM freelancers WHERE id=$1",[req.params.id]);
    res.json(rowToFl(rows[0]));
  } catch (err) { res.status(500).json({error:err.message}); }
});
app.delete("/freelancers/:id", async (req, res) => {
  try { await pool.query("DELETE FROM freelancers WHERE id=$1",[req.params.id]); res.json({deleted:true}); }
  catch (err) { res.status(500).json({error:err.message}); }
});

// ════════════════════════════════════════════════════════════════════
// TOOLS CRUD
// ════════════════════════════════════════════════════════════════════
app.get("/tools", async (req, res) => {
  try { const {rows}=await pool.query("SELECT * FROM tools ORDER BY created_at ASC"); res.json(rows.map(rowToTool)); }
  catch (err) { res.status(500).json({error:err.message}); }
});
app.post("/tools", async (req, res) => {
  try {
    const tl=req.body; const id=tl.id||crypto.randomUUID();
    await pool.query(`INSERT INTO tools (id,name,url,category,icon,description) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET name=$2,url=$3,category=$4,icon=$5,description=$6`,
      [id,tl.name,tl.url||"",tl.category||"",tl.icon||"🔗",tl.description||""]);
    const {rows}=await pool.query("SELECT * FROM tools WHERE id=$1",[id]);
    res.json(rowToTool(rows[0]));
  } catch (err) { res.status(500).json({error:err.message}); }
});
app.delete("/tools/:id", async (req, res) => {
  try { await pool.query("DELETE FROM tools WHERE id=$1",[req.params.id]); res.json({deleted:true}); }
  catch (err) { res.status(500).json({error:err.message}); }
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  try {
    const o=await pool.query("SELECT COUNT(*) FROM orders");
    const f=await pool.query("SELECT COUNT(*) FROM freelancers");
    const rv=await pool.query("SELECT COUNT(*) FROM revisions");
    res.json({ status:"✅ Openshore v3 running", db:"✅ PostgreSQL",
      orders:parseInt(o.rows[0].count), freelancers:parseInt(f.rows[0].count),
      revisions:parseInt(rv.rows[0].count), uptime:Math.floor(process.uptime())+"s" });
  } catch (err) { res.json({status:"✅ Server running",db:"❌",error:err.message}); }
});

const PORT = process.env.PORT || 3000;
initDB()
  .then(()=>app.listen(PORT,()=>console.log(`🚀 Port ${PORT}`)))
  .catch(err=>{console.error("❌ DB init failed:",err);process.exit(1);});
