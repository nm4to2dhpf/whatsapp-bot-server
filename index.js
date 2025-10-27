// index.js
import express from "express";
import dotenv from "dotenv";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

// ---- Config / constants
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPABASE_URL =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  "https://mwpskchcxhjrhqvrrgpj.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im13cHNrY2hjeGhqcmhxdnJyZ3BqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEyNTc2ODQsImV4cCI6MjA3NjgzMzY4NH0.VB0rj4SER2W5EOpxnI06Bx-U7D5KlHIFNBJ93AzU9I8";
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "whatsapp-media";
const SESSION_PATH = process.env.SESSION_PATH || "./session";
const INSTANCE_ID = process.env.INSTANCE_ID || `instance-${Math.random().toString(36).slice(2,8)}`;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("FATAL: manca SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// ---- Express init
const app = express();
app.use(express.json());

// ---- State
let clientReady = false;
let latestQrDataUrl = null;
let lastQrAt = null;
let localQueueFile = path.join(__dirname, "local_queue.json");
let localQueue = []; // array of {type, payload, created_at}

// ---- Load local queue if present
try {
  if (fs.existsSync(localQueueFile)) {
    const raw = fs.readFileSync(localQueueFile, "utf8");
    localQueue = JSON.parse(raw || "[]");
    console.log(`[STARTUP] 📥 Loaded local queue: ${localQueue.length} items`);
  } else {
    console.log("[STARTUP] 📥 No local queue file found, starting fresh");
  }
} catch (err) {
  console.warn("[STARTUP] Could not load local queue file:", err.message || err);
}

// ---- Utilities for local queue persistence
function persistLocalQueue() {
  try {
    fs.writeFileSync(localQueueFile, JSON.stringify(localQueue, null, 2));
  } catch (err) {
    console.error("[QUEUE] Error persisting local queue:", err.message || err);
  }
}
function enqueueLocal(item) {
  localQueue.push({ ...item, created_at: new Date().toISOString() });
  persistLocalQueue();
  console.log("[QUEUE] ➕ Enqueued local item:", item.type);
}

// ---- Audit helper (best-effort)
function audit(action, meta = {}) {
  (async () => {
    try {
      const { error } = await supabase.from("audit_log").insert([{ actor: INSTANCE_ID, action, meta }]);
      if (error) throw error;
      console.log(`[AUDIT] ✔️ Logged action '${action}'`);
    } catch (err) {
      console.error("[AUDIT] insert failed, queueing locally:", err.message || err);
      enqueueLocal({ type: "audit", payload: { actor: INSTANCE_ID, action, meta } });
    }
  })();
}

// ---- Helpers
function normalizeNumber(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return digits; // assume includes country code (e.g. 39...)
}
function toJid(num) {
  if (!num) return null;
  if (num.includes("@")) return num;
  return `${num}@c.us`;
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
async function exponentialBackoff(fn, attempts = 5, base = 500) {
  let i = 0;
  while (i < attempts) {
    try {
      return await fn();
    } catch (err) {
      i++;
      if (i >= attempts) throw err;
      const wait = base * Math.pow(2, i - 1);
      console.warn(`[BACKOFF] Retry ${i}/${attempts} after ${wait}ms due to error:`, err.message || err);
      await sleep(wait);
    }
  }
}

// ---- WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ clientId: "session-whatsapp", dataPath: SESSION_PATH }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--single-process",
    ],
  },
});

// ---- Events: qr, ready, disconnected, auth_failure
client.on("qr", async (qr) => {
  try {
    latestQrDataUrl = await QRCode.toDataURL(qr);
    lastQrAt = new Date();
    console.log("\n[QR] ✅ QR CODE GENERATO!");
    console.log("[QR] timestamp:", lastQrAt.toISOString());
    // write status to DB via RPC (best-effort)
    try {
      const { error } = await supabase.rpc("set_whatsapp_status", {
        p_status: "qr_generated",
        p_client_info: null,
        p_qr: latestQrDataUrl
      });
      if (error) throw error;
      console.log("[DB] set_whatsapp_status -> qr_generated");
    } catch (err) {
      console.warn("[DB] set_whatsapp_status rpc failed:", err.message || err);
      enqueueLocal({ type: "status", payload: { status: "qr_generated", qr: latestQrDataUrl } });
    }
    audit("qr_generated", { instance: INSTANCE_ID });
  } catch (err) {
    console.error("[QR] Errore QR:", err.message || err);
  }
});

client.on("ready", async () => {
  clientReady = true;
  console.log("\n[CLIENT] ✅ WHATSAPP READY -> connected");
  try {
    const { error } = await supabase.rpc("set_whatsapp_status", {
      p_status: "connected",
      p_client_info: JSON.stringify({ instance: INSTANCE_ID }),
      p_qr: null
    });
    if (error) throw error;
    console.log("[DB] set_whatsapp_status -> connected");
  } catch (err) {
    console.warn("[DB] Failed to update status on ready:", err.message || err);
    enqueueLocal({ type: "status", payload: { status: "connected" } });
  }
  audit("client_ready", { instance: INSTANCE_ID });
});

client.on("disconnected", async (reason) => {
  clientReady = false;
  console.warn("\n[CLIENT] ⚠️ DISCONNESSO:", reason);
  try {
    const { error } = await supabase.rpc("set_whatsapp_status", {
      p_status: "disconnected",
      p_client_info: JSON.stringify({ instance: INSTANCE_ID, reason }),
      p_qr: null
    });
    if (error) throw error;
    console.log("[DB] set_whatsapp_status -> disconnected");
  } catch (err) {
    enqueueLocal({ type: "status", payload: { status: "disconnected", reason } });
  }
  audit("client_disconnected", { reason });
});

client.on("auth_failure", async (msg) => {
  clientReady = false;
  console.error("\n[AUTH] ❌ AUTH FAILURE:", msg);
  try {
    const { error } = await supabase.rpc("set_whatsapp_status", {
      p_status: "auth_needed",
      p_client_info: JSON.stringify({ instance: INSTANCE_ID, msg }),
      p_qr: null
    });
    if (error) throw error;
    console.log("[DB] set_whatsapp_status -> auth_needed");
  } catch (err) {
    enqueueLocal({ type: "status", payload: { status: "auth_needed", msg } });
  }
  audit("auth_failure", { msg });
});

// ---- Message handler (incoming)
client.on("message", async (msg) => {
  console.log("[MSG] Incoming", msg.id?.id, msg.from, msg.body?.slice(0,100));
  try {
    const from = msg.from; // jid
    const participant = msg.author || null; // for groups (unused here)
    const normalized = normalizeNumber(from);
    const jid = toJid(normalized) || from;

    // upsert chat
    let chatId = null;
    try {
      const { data: found, error: qerr } = await supabase
        .from("chats")
        .select("id,numero_normalized,status")
        .eq("numero_normalized", normalized)
        .limit(1);

      if (qerr) throw qerr;
      if (found && found.length) {
        chatId = found[0].id;
        const { error: uerr } = await supabase.from("chats").update({ last_message_at: new Date() }).eq("id", chatId);
        if (uerr) console.warn("[DB] Unable to update last_message_at:", uerr.message || uerr);
      } else {
        const { data: insertData, error: insertErr } = await supabase.from("chats").insert([{
          numero_normalized: normalized,
          jid,
          nome: null,
          cognome: null,
          status: "inactive",
          last_message_at: new Date()
        }]).select("id");
        if (insertErr) throw insertErr;
        chatId = Array.isArray(insertData) ? insertData[0].id : insertData.id;
      }
    } catch (err) {
      console.warn("[MSG] Error upserting chat to supabase:", err.message || err);
      enqueueLocal({ type: "incoming_msg", payload: { from: jid, body: msg.body, id: msg.id?.id }});
      return;
    }

    // media handling
    let media_url = null;
    try {
      if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media && media.data) {
          const buffer = Buffer.from(media.data, "base64");
          const ext = media.mimetype ? media.mimetype.split("/")[1] : "bin";
          const filename = `msg_media/${chatId}_${Date.now()}.${ext}`;
          const { error: uploadErr } = await supabase.storage.from(SUPABASE_STORAGE_BUCKET).upload(filename, buffer, {
            contentType: media.mimetype
          });

          if (uploadErr) {
            console.warn("[MEDIA] Storage upload failed:", uploadErr.message || uploadErr);
            enqueueLocal({ type: "media_upload", payload: { filename, buffer: buffer.toString("base64"), contentType: media.mimetype }});
          } else {
            const { data: publicData } = supabase.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(filename);
            media_url = publicData?.publicUrl || null;
            console.log("[MEDIA] Uploaded media, public URL:", media_url);
          }
        }
      }
    } catch (err) {
      console.warn("[MEDIA] media handling error:", err.message || err);
    }

    // insert message record
    const { data: inserted, error: insertMsgErr } = await supabase.from("messages").insert([{
      chat_id: chatId,
      sender: "whatsapp",
      numero: normalized,
      message: msg.body || null,
      media_url,
      status: "received",
      whatsapp_message_id: msg.id?.id
    }]);
    if (insertMsgErr) {
      console.warn("[DB] Insert message failed, queue locally:", insertMsgErr.message || insertMsgErr);
      enqueueLocal({ type: "incoming_msg", payload: { from: jid, body: msg.body, media_url, whatsapp_message_id: msg.id?.id }});
    } else {
      audit("message_received", { chat_id: chatId, whatsapp_id: msg.id?.id });
      console.log(`[MSG] Stored incoming message ${msg.id?.id} for chat ${chatId}`);
    }

  } catch (err) {
    console.error("[MSG] Error handling message:", err.message || err);
  }
});

// ---- Dispatch loop: invia messaggi approvati
async function dispatchLoop() {
  console.log("[WORKER] Dispatch loop started. instance:", INSTANCE_ID);
  while (true) {
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("status", "approved")
        .lte("attempt_count", 4)
        .is("in_progress", false)
        .order("created_at", { ascending: true })
        .limit(5);

      if (error) throw error;
      if (!data || data.length === 0) {
        await sleep(1500);
        continue;
      }

      for (const msg of data) {
        // try to claim message
        const { data: claimed, error: claimErr } = await supabase
          .from("messages")
          .update({ in_progress: true })
          .match({ id: msg.id, in_progress: false, status: "approved" })
          .select();

        if (claimErr) {
          console.warn("[DISPATCH] Claim error:", claimErr.message || claimErr);
          continue;
        }
        if (!claimed || claimed.length === 0) {
          // someone else claimed
          continue;
        }

        // send
        try {
          if (!clientReady) throw new Error("WhatsApp client not ready");

          const jid = (msg.numero) ? toJid(normalizeNumber(msg.numero)) : null;
          if (!jid && !msg.chat_id) throw new Error("No destination jid");

          if (msg.media_url) {
            // download file
            const fileRes = await fetch(msg.media_url);
            if (!fileRes.ok) throw new Error(`Failed download media: ${fileRes.status}`);
            const arrayBuffer = await fileRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const mime = fileRes.headers.get("content-type") || "application/octet-stream";
            const { MessageMedia } = await import("whatsapp-web.js");
            const base64 = buffer.toString("base64");
            const media = new MessageMedia(mime, base64);
            const sendRes = await client.sendMessage(jid || msg.chat_id, media, { caption: msg.message || "" });
            const { error: updErr } = await supabase.from("messages").update({ status: "sent", whatsapp_message_id: sendRes.id?.id || null, in_progress: false }).eq("id", msg.id);
            if (updErr) throw updErr;
            audit("message_sent", { id: msg.id, whatsapp_id: sendRes.id?.id });
            console.log(`[DISPATCH] Sent media message ${msg.id} -> ${jid || msg.chat_id}`);
          } else {
            const sendRes = await client.sendMessage(jid || msg.chat_id, msg.message || "");
            const { error: updErr } = await supabase.from("messages").update({ status: "sent", whatsapp_message_id: sendRes.id?.id, in_progress: false }).eq("id", msg.id);
            if (updErr) throw updErr;
            audit("message_sent", { id: msg.id, whatsapp_id: sendRes.id?.id });
            console.log(`[DISPATCH] Sent text message ${msg.id} -> ${jid || msg.chat_id}`);
          }
        } catch (sendErr) {
          console.error("[DISPATCH] Send error for message", msg.id, sendErr.message || sendErr);
          const newAttempts = (msg.attempt_count || 0) + 1;
          const newStatus = (newAttempts >= 5) ? "failed" : "approved";
          const { error: incErr } = await supabase.from("messages").update({ attempt_count: newAttempts, in_progress: false, status: newStatus }).eq("id", msg.id);
          if (incErr) console.warn("[DB] Failed to update attempt_count:", incErr.message || incErr);
          audit("send_failed", { id: msg.id, error: sendErr.message || sendErr });
        }
      }

    } catch (err) {
      console.error("[WORKER] Dispatch loop error:", err.message || err);
      enqueueLocal({ type: "dispatch_error", payload: { message: err.message }});
      await sleep(3000);
    }
  }
}

// ---- Flush local queue worker
async function flushLocalQueueLoop() {
  console.log("[WORKER] Flush local queue loop started");
  while (true) {
    if (localQueue.length === 0) {
      await sleep(5000);
      continue;
    }
    console.log("[WORKER] Flushing local queue:", localQueue.length);
    const copy = [...localQueue];
    for (const item of copy) {
      try {
        if (item.type === "audit") {
          const { actor, action, meta } = item.payload;
          const { error } = await supabase.from("audit_log").insert([{ actor, action, meta }]);
          if (error) throw error;
          console.log("[FLUSH] audit flushed");
        } else if (item.type === "incoming_msg") {
          const { error } = await supabase.from("messages").insert([{
            chat_id: item.payload.chat_id || null,
            sender: "whatsapp",
            numero: item.payload.from || null,
            message: item.payload.body || null,
            media_url: item.payload.media_url || null,
            status: "received",
            whatsapp_message_id: item.payload.whatsapp_message_id || null
          }]);
          if (error) throw error;
          console.log("[FLUSH] incoming_msg flushed");
        } else if (item.type === "status") {
          const p = item.payload;
          const { error } = await supabase.rpc("set_whatsapp_status", { p_status: p.status || "disconnected", p_client_info: JSON.stringify(p.client_info || {}), p_qr: p.qr || null });
          if (error) throw error;
          console.log("[FLUSH] status flushed:", p.status);
        } else if (item.type === "media_upload") {
          const filename = item.payload.filename;
          const buffer = Buffer.from(item.payload.buffer, "base64");
          const { error } = await supabase.storage.from(SUPABASE_STORAGE_BUCKET).upload(filename, buffer, { contentType: item.payload.contentType });
          if (error) throw error;
          console.log("[FLUSH] media_upload flushed:", filename);
        }
        // remove from queue after success
        localQueue = localQueue.filter(x => x !== item);
        persistLocalQueue();
      } catch (err) {
        console.warn("[FLUSH] Error flushing queue item type", item.type, err.message || err);
        // leave in queue; try again later
      }
    }
    await sleep(2000);
  }
}

// ---- MOCK: login via numero di telefono
// Nota: whatsapp-web.js non espone una API "login via phone" stabile per ora.
// Qui simuliamo il comportamento: se riceviamo phone-> settiamo clientReady=true,
// aggiorniamo lo stato su supabase con `connected_via_phone` e logghiamo audit.
// Questo ti permette di integrare lato client/dashboard la feature "login via phone"
// finché non implementi la procedura reale/OTP.
async function loginViaPhone(phoneNumber) {
  console.log("\n[AUTH] 📱 Tentativo di accesso via numero di telefono:", phoneNumber);
  try {
    // Simulazione delay autenticazione
    console.log("[AUTH] Simulazione autenticazione... (2s)");
    await sleep(2000);

    // Mock: consideriamo il login andato a buon fine
    clientReady = true;
    console.log("[AUTH] ✅ Accesso via numero completato con successo (mock).");

    // Scriviamo su supabase lo stato
    try {
      const { error } = await supabase.rpc("set_whatsapp_status", {
        p_status: "connected_via_phone",
        p_client_info: JSON.stringify({ instance: INSTANCE_ID, phoneNumber }),
        p_qr: null
      });
      if (error) throw error;
      console.log("[DB] set_whatsapp_status -> connected_via_phone");
    } catch (err) {
      console.warn("[DB] Failed to update status after phone login:", err.message || err);
      enqueueLocal({ type: "status", payload: { status: "connected_via_phone", client_info: { phoneNumber } } });
    }

    audit("login_via_phone_success", { instance: INSTANCE_ID, phoneNumber });
    return true;
  } catch (err) {
    console.error("[AUTH] Errore loginViaPhone:", err.message || err);
    audit("login_via_phone_failed", { instance: INSTANCE_ID, phoneNumber, err: err.message || err });
    throw err;
  }
}

// ---- HTTP endpoints

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true, clientReady, instance: INSTANCE_ID });
});

// Status (reads whatsapp_status table single row)
app.get("/status", async (req, res) => {
  try {
    const { data } = await supabase.from("whatsapp_status").select("*").limit(1).maybeSingle();
    res.json({
      clientReady,
      status: data?.status || (clientReady ? "connected" : "disconnected"),
      whatsapp_status: data || null
    });
  } catch (err) {
    res.json({ clientReady, status: clientReady ? "connected" : "disconnected", error: err.message || err});
  }
});

// QR legacy endpoint
app.get("/qr", (req, res) => {
  if (latestQrDataUrl && lastQrAt) {
    res.json({ qr: latestQrDataUrl, qr_generated_at: lastQrAt });
  } else {
    res.status(404).json({ message: "No QR available" });
  }
});

// ---- NEW: /auth endpoint
// GET /auth -> returns both QR (if exists) and flags about login methods
// POST /auth { phone } -> attempts login via phone (mock)
app.get("/auth", (req, res) => {
  console.log("\n[API] GET /auth - richiesta opzioni auth");
  const resp = {
    login_via_phone_available: true, // per tua indicazione il numero è sempre disponibile
    login_via_qr_available: Boolean(latestQrDataUrl),
    qr: latestQrDataUrl || null,
    qr_generated_at: lastQrAt || null
  };
  console.log("[API] GET /auth ->", {
    phone_available: resp.login_via_phone_available,
    qr_available: resp.login_via_qr_available
  });
  res.json(resp);
});

app.post("/auth", async (req, res) => {
  const { phone } = req.body;
  if (!phone) {
    console.warn("[API] POST /auth senza 'phone' nel body");
    return res.status(400).json({ error: "Parametro 'phone' mancante" });
  }
  console.log(`[API] POST /auth -> richiesta login via phone: ${phone}`);
  try {
    await loginViaPhone(phone);
    res.json({ success: true, message: "Accesso via numero completato (mock)", phone });
  } catch (err) {
    console.error("[API] POST /auth errore:", err.message || err);
    res.status(500).json({ success: false, error: err.message || err });
  }
});

// POST /send -> admin endpoint to add an approved message into messages table
app.post("/send", async (req, res) => {
  const { to, message, nome, cognome, chat_id } = req.body;
  console.log("[API] /send", { to, chat_id, message: message?.slice?.(0,50) });
  if (!clientReady) {
    console.warn("[API] /send called but client not ready");
    return res.status(503).json({ error: "WhatsApp client not ready" });
  }
  if (!to && !chat_id) return res.status(400).json({ error: "Missing 'to' or 'chat_id' "});
  try {
    const numero = to ? normalizeNumber(to) : null;
    const { data: insertData, error } = await supabase.from("messages").insert([{
      chat_id,
      sender: "admin",
      numero,
      message,
      status: "approved",
      nome,
      cognome
    }]);
    if (error) throw error;
    const id = Array.isArray(insertData) ? insertData[0].id : insertData.id;
    console.log("[API] /send -> queued message id:", id);
    res.json({ success: true, message: "Queued for send", id });
  } catch (err) {
    console.error("[API] /send error:", err.message || err);
    res.status(500).json({ error: err.message || err });
  }
});

// GET /chats -> returns active chats
app.get("/chats", async (req, res) => {
  try {
    const { data, error } = await supabase.from("chats").select("id,nome,cognome,numero_normalized,jid,status,last_message_at").order("last_message_at", { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("[API] /chats error:", err.message || err);
    res.status(500).json({ error: err.message || err });
  }
});

// GET /messages?chat_id=...
app.get("/messages", async (req, res) => {
  const { chat_id } = req.query;
  if (!chat_id) return res.status(400).json({ error: "chat_id required" });
  try {
    const { data, error } = await supabase.from("messages").select("*").eq("chat_id", chat_id).order("created_at", { ascending: true });
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("[API] /messages error:", err.message || err);
    res.status(500).json({ error: err.message || err });
  }
});

// ---- Start server and workers
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server listening on port ${PORT}`);
  console.log(`Instance ID: ${INSTANCE_ID}`);
  console.log("------------------------------------------------\n");

  audit("server_started", { port: PORT, instance: INSTANCE_ID });

  // initialize workers
  dispatchLoop().catch(e => console.error("[WORKER] dispatchLoop crashed:", e));
  flushLocalQueueLoop().catch(e => console.error("[WORKER] flushLocalQueue crashed:", e));
});

// ---- Initialize WhatsApp client
console.log("[STARTUP] Inizializzo client WhatsApp...");
client.initialize();
