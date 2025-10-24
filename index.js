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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

const app = express();
app.use(express.json());

let clientReady = false;
let latestQrDataUrl = null;
let lastQrAt = null;
let localQueueFile = path.join(__dirname, "local_queue.json");
let localQueue = []; // array of {type, payload, created_at}

// load local queue from disk if exists
try {
  if (fs.existsSync(localQueueFile)) {
    const raw = fs.readFileSync(localQueueFile, "utf8");
    localQueue = JSON.parse(raw || "[]");
    console.log("Loaded local queue:", localQueue.length);
  }
} catch (err) {
  console.warn("Could not load local queue file:", err.message);
}

// utility: persist local queue
function persistLocalQueue() {
  try {
    fs.writeFileSync(localQueueFile, JSON.stringify(localQueue, null, 2));
  } catch (err) {
    console.error("Error persisting local queue:", err.message);
  }
}

function enqueueLocal(item) {
  localQueue.push({ ...item, created_at: new Date().toISOString() });
  persistLocalQueue();
}

// logging helper
function audit(action, meta = {}) {
  // best-effort: insert audit record to supabase, if fails, write to local queue
  (async () => {
    try {
      const { error } = await supabase.from("audit_log").insert([{ actor: INSTANCE_ID, action, meta }]);
      if (error) throw error;
    } catch (err) {
      console.error("Audit insert failed, queueing locally:", err.message || err);
      enqueueLocal({ type: "audit", payload: { actor: INSTANCE_ID, action, meta } });
    }
  })();
}

// helper normalize numbers -> only digits
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

// Backoff helper
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
      console.warn(`Retry ${i}/${attempts} after ${wait}ms due to error:`, err.message || err);
      await sleep(wait);
    }
  }
}

// whatsapp-web.js client
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

client.on("qr", async (qr) => {
  try {
    latestQrDataUrl = await QRCode.toDataURL(qr);
    lastQrAt = new Date();
    console.log("QR GENERATO (base64).");
    // write status to DB via RPC (best-effort)
    try {
      const { error } = await supabase.rpc("set_whatsapp_status", {
        p_status: "qr_generated",
        p_client_info: null,
        p_qr: latestQrDataUrl
      });
      if (error) throw error;
    } catch (err) {
      console.warn("set_whatsapp_status rpc failed:", err.message || err);
      enqueueLocal({ type: "status", payload: { status: "qr_generated", qr: latestQrDataUrl } });
    }
    audit("qr_generated", { instance: INSTANCE_ID });
  } catch (err) {
    console.error("Errore QR:", err.message || err);
  }
});

client.on("ready", async () => {
  clientReady = true;
  console.log("WHATSAPP READY -> connected");
  try {
    const { error } = await supabase.rpc("set_whatsapp_status", {
      p_status: "connected",
      p_client_info: JSON.stringify({ instance: INSTANCE_ID }),
      p_qr: null
    });
    if (error) throw error;
  } catch (err) {
    console.warn("Failed to update status on ready:", err.message || err);
    enqueueLocal({ type: "status", payload: { status: "connected" } });
  }
  audit("client_ready", { instance: INSTANCE_ID });
});

client.on("disconnected", async (reason) => {
  clientReady = false;
  console.warn("WHATSAPP DISCONNECTED:", reason);
  try {
    const { error } = await supabase.rpc("set_whatsapp_status", {
      p_status: "disconnected",
      p_client_info: JSON.stringify({ instance: INSTANCE_ID, reason }),
      p_qr: null
    });
    if (error) throw error;
  } catch (err) {
    enqueueLocal({ type: "status", payload: { status: "disconnected", reason } });
  }
  audit("client_disconnected", { reason });
});

client.on("auth_failure", async (msg) => {
  clientReady = false;
  console.error("AUTH FAILURE:", msg);
  try {
    const { error } = await supabase.rpc("set_whatsapp_status", {
      p_status: "auth_needed",
      p_client_info: JSON.stringify({ instance: INSTANCE_ID, msg }),
      p_qr: null
    });
    if (error) throw error;
  } catch (err) {
    enqueueLocal({ type: "status", payload: { status: "auth_needed", msg } });
  }
  audit("auth_failure", { msg });
});

// message handler (incoming from WhatsApp)
client.on("message", async (msg) => {
  console.log("Incoming message", msg.id?.id, msg.from, msg.body?.slice(0,100));
  try {
    const from = msg.from; // jid
    const participant = msg.author || null; // for groups
    const normalized = normalizeNumber(from);
    const jid = toJid(normalized) || from;

    // ensure chat exists (upsert)
    let chatId = null;
    try {
      // try to find chat
      const { data: found, error: qerr } = await supabase
        .from("chats")
        .select("id,numero_normalized,status")
        .eq("numero_normalized", normalized)
        .limit(1);

      if (qerr) throw qerr;
      if (found && found.length) {
        chatId = found[0].id;
        // update last_message_at
        const { error: uerr } = await supabase.from("chats").update({ last_message_at: new Date() }).eq("id", chatId);
        if (uerr) console.warn("Unable to update last_message_at:", uerr.message || uerr);
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
      console.warn("Error upserting chat to supabase:", err.message || err);
      // fallback: enqueue and return
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
            console.warn("Storage upload failed:", uploadErr.message || uploadErr);
            // fallback: enqueue media for later
            enqueueLocal({ type: "media_upload", payload: { filename, buffer: buffer.toString("base64"), contentType: media.mimetype }});
          } else {
            const { data: publicData } = supabase.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(filename);
            media_url = publicData?.publicUrl || null;
          }
        }
      }
    } catch (err) {
      console.warn("media handling error:", err.message || err);
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
      console.warn("Insert message failed, queue locally:", insertMsgErr.message || insertMsgErr);
      enqueueLocal({ type: "incoming_msg", payload: { from: jid, body: msg.body, media_url, whatsapp_message_id: msg.id?.id }});
    } else {
      audit("message_received", { chat_id: chatId, whatsapp_id: msg.id?.id });
    }

  } catch (err) {
    console.error("Error handling message:", err.message || err);
  }
});

// Helper: dispatch approved messages
async function dispatchLoop() {
  console.log("Dispatch loop started. instance:", INSTANCE_ID);
  while (true) {
    try {
      // fetch candidate messages approved and not in_progress and attempt_count < 5
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
        // try to claim (optimistic)
        const { data: claimed, error: claimErr } = await supabase
          .from("messages")
          .update({ in_progress: true })
          .match({ id: msg.id, in_progress: false, status: "approved" })
          .select();

        if (claimErr) {
          console.warn("Claim error:", claimErr.message || claimErr);
          continue;
        }
        if (!claimed || claimed.length === 0) {
          // someone else claimed
          continue;
        }

        // now send
        try {
          if (!clientReady) throw new Error("WhatsApp client not ready");

          const jid = (msg.numero) ? toJid(normalizeNumber(msg.numero)) : null;
          if (!jid && !msg.chat_id) {
            throw new Error("No destination jid");
          }

          // If media_url present, download from storage and send as media
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
            // update DB
            const { error: updErr } = await supabase.from("messages").update({ status: "sent", whatsapp_message_id: sendRes.id?.id || null, in_progress: false }).eq("id", msg.id);
            if (updErr) throw updErr;
            audit("message_sent", { id: msg.id, whatsapp_id: sendRes.id?.id });
          } else {
            const sendRes = await client.sendMessage(jid || msg.chat_id, msg.message || "");
            const { error: updErr } = await supabase.from("messages").update({ status: "sent", whatsapp_message_id: sendRes.id?.id, in_progress: false }).eq("id", msg.id);
            if (updErr) throw updErr;
            audit("message_sent", { id: msg.id, whatsapp_id: sendRes.id?.id });
          }
        } catch (sendErr) {
          console.error("Send error for message ", msg.id, sendErr.message || sendErr);
          // increment attempt_count, set in_progress false; maybe set status failed after many attempts
          const newAttempts = (msg.attempt_count || 0) + 1;
          const newStatus = (newAttempts >= 5) ? "failed" : "approved";
          const { error: incErr } = await supabase.from("messages").update({ attempt_count: newAttempts, in_progress: false, status: newStatus }).eq("id", msg.id);
          if (incErr) console.warn("Failed to update attempt_count:", incErr.message || incErr);
          audit("send_failed", { id: msg.id, error: sendErr.message || sendErr });
        }
      }

    } catch (err) {
      console.error("Dispatch loop error:", err.message || err);
      // if supabase problem, we'll pause and retry, also persist localQueue marker
      enqueueLocal({ type: "dispatch_error", payload: { message: err.message }});
      await sleep(3000);
    }
  }
}

// periodic worker to flush local queue -> try to sync with supabase
async function flushLocalQueueLoop() {
  while (true) {
    if (localQueue.length === 0) {
      await sleep(5000);
      continue;
    }
    console.log("Flushing local queue:", localQueue.length);
    const copy = [...localQueue];
    for (const item of copy) {
      try {
        if (item.type === "audit") {
          const { actor, action, meta } = item.payload;
          const { error } = await supabase.from("audit_log").insert([{ actor, action, meta }]);
          if (error) throw error;
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
        } else if (item.type === "status") {
          const p = item.payload;
          const { error } = await supabase.rpc("set_whatsapp_status", { p_status: p.status || "disconnected", p_client_info: JSON.stringify(p.client_info || {}), p_qr: p.qr || null });
          if (error) throw error;
        } else if (item.type === "media_upload") {
          const filename = item.payload.filename;
          const buffer = Buffer.from(item.payload.buffer, "base64");
          const { error } = await supabase.storage.from(SUPABASE_STORAGE_BUCKET).upload(filename, buffer, { contentType: item.payload.contentType });
          if (error) throw error;
        }
        // if succeeded, remove from localQueue
        localQueue = localQueue.filter(x => x !== item);
        persistLocalQueue();
      } catch (err) {
        console.warn("Error flushing queue item type", item.type, err.message || err);
        // leave in queue, maybe wait and retry later
      }
    }
    await sleep(2000);
  }
}

// HTTP endpoints
app.get("/health", (req, res) => {
  res.json({ ok: true, clientReady, instance: INSTANCE_ID });
});

app.get("/status", async (req, res) => {
  try {
    const { data } = await supabase.from("whatsapp_status").select("*").limit(1).maybeSingle();
    res.json({ clientReady, status: data?.status || (clientReady ? "connected" : "disconnected"), whatsapp_status: data || null });
  } catch (err) {
    res.json({ clientReady, status: clientReady ? "connected" : "disconnected", error: err.message || err});
  }
});

app.get("/qr", (req, res) => {
  if (latestQrDataUrl && lastQrAt) {
    res.json({ qr: latestQrDataUrl, qr_generated_at: lastQrAt });
  } else {
    res.status(404).json({ message: "No QR available" });
  }
});

// POST /send -> admin (server) endpoint to add an approved message into messages table
// Expected body: { to: "3933...", message: "test", nome, cognome, chat_id }
// This endpoint assumes it's called by server/admin system; still we insert as approved so dispatch sends it
app.post("/send", async (req, res) => {
  const { to, message, nome, cognome, chat_id } = req.body;
  console.log("[API] /send", { to, chat_id, message: message?.slice?.(0,50) });
  if (!clientReady) return res.status(503).json({ error: "WhatsApp client not ready" });
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
    res.json({ success: true, message: "Queued for send", id });
  } catch (err) {
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
    res.status(500).json({ error: err.message || err });
  }
});

// Start server and workers
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
  audit("server_started", { port: PORT, instance: INSTANCE_ID });
  // initialize workers
  dispatchLoop().catch(e => console.error("dispatchLoop crashed:", e));
  flushLocalQueueLoop().catch(e => console.error("flushLocalQueue crashed:", e));
});

client.initialize();
