import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TZ = process.env.TIMEZONE || "Europe/Madrid";

// --- Twilio SMS client ---
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// --- helpers ---
function nowInTZ(timeZone) {
  // Crea una fecha "equivalente" en la TZ dada usando formatToParts (sin parseos raros)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const h = get("hour");
  const mi = get("minute");
  const s = get("second");

  // ISO “local” (sin Z) — suficiente para reglas horario
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
}

function isNightWindow(dateObj) {
  const h = dateObj.getHours();
  return h >= 22 || h < 8; // 22:00-08:00
}

function dayPart(dateObj) {
  const h = dateObj.getHours();
  if (h >= 8 && h < 14) return "mañana";
  if (h >= 14 && h < 22) return "tarde";
  return "noche";
}

function escapeXml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function sendSms(to, body) {
  const from = process.env.TWILIO_SMS_FROM;
  if (!from) throw new Error("Falta TWILIO_SMS_FROM");
  if (!to) throw new Error("Falta ALERT_TO_NUMBER (destino del SMS)");
  return twilioClient.messages.create({ from, to, body });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    // intenta rescatar el primer bloque {...}
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("No pude parsear JSON desde OpenAI");
  }
}

// Página de prueba
app.get("/", (req, res) => res.send("Marta 24h está viva ✅"));
app.get("/health", (req, res) => res.json({ ok: true }));

// ✅ IMPORTANTE: Twilio llama por POST a /voice.
// Si lo abres en navegador con GET verás "Cannot GET /voice" y es NORMAL.
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-media`;

  // ✅ QUITAMOS track="both_tracks" (te daba 31941Stream)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// 2) WebSocket server para Twilio Media Streams
const server = app.listen(PORT, () => console.log("Listening on", PORT));
const wss = new WebSocketServer({ server, path: "/twilio-media" });

wss.on("connection", (twilioWs) => {
  const tNow = nowInTZ(TZ);
  const night = isNightWindow(tNow);
  const part = dayPart(tNow);

  let callSid = "";
  let streamSid = "";
  let transcript = "";

  const REALTIME_MODEL =
    process.env.REALTIME_MODEL || "gpt-4o-realtime-preview-2025-06-03"; // ejemplo válido  [oai_citation:1‡OpenAI Developers](https://developers.openai.com/blog/realtime-api/?utm_source=chatgpt.com)
  const REALTIME_VOICE = process.env.REALTIME_VOICE || "alloy";

  // Conexión a OpenAI Realtime
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  const baseInstructions = `
Eres "Marta", asistente de urgencias de "Reparaciones Express 24h Costa del Sol". Hablas SIEMPRE en español neutro.
Objetivo: tomar datos y generar un parte. Mantén tono profesional, rápido, empático.

Servicios disponibles: fontanería, electricidad, cerrajería, persianas, electrodomésticos, pintura, mantenimiento.

Guion de apertura EXACTO:
"Hola, soy Marta, el asistente de urgencias de Reparación Express 24h. ¿En qué puedo ayudarte?"

Datos a recoger (en este orden, con preguntas cortas):
1) Nombre
2) Teléfono de contacto (confirmar si es el mismo desde el que llama)
3) Dirección completa (calle, número, portal/piso si aplica)
4) Zona/municipio (Costa del Sol)
5) Tipo de servicio (elige 1 de la lista)
6) Descripción breve de la avería y si hay urgencia o riesgo (agua/fuego/personas atrapadas)

Regla nocturna:
Si la llamada es entre 22:00 y 08:00 (hora España), di literalmente:
"Te informo: entre las 22:00 y las 08:00 la salida para ver la avería son 70€, y después la mano de obra nocturna suele estar entre 50€ y 70€ por hora, según el trabajo.
¿Lo aceptas para enviar al técnico?"
Si no acepta, ofrece tomar nota y que llamen en horario diurno.

Si es horario diurno NO menciones precios nocturnos.

Cierre obligatorio:
"Perfecto. Voy a enviar el aviso al técnico de guardia por WhatsApp ahora mismo y te llamará para confirmar disponibilidad y tiempo estimado."
Luego despedida:
- si parte del día = mañana: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenos días, hasta luego."
- si parte del día = tarde: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenas tardes, hasta luego."
- si parte del día = noche: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buena noche, hasta luego."

IMPORTANTE: Al final de la llamada, genera un resumen interno con los campos del parte para enviar por SMS. No lo leas al cliente.
`.trim();

  openaiWs.on("open", () => {
    console.log("✅ OpenAI realtime conectado", { model: REALTIME_MODEL });

    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions:
            baseInstructions +
            `\nContexto horario: es_noche=${night}, parte_del_dia=${part}.`,
          voice: REALTIME_VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          modalities: ["audio", "text"],
          temperature: 0.4
        }
      })
    );

    // Saludo inicial
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Empieza con el saludo exacto del guion y espera respuesta."
        }
      })
    );
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Audio hacia Twilio
    if (msg.type === "response.audio.delta") {
      if (!streamSid) return; // aún no tenemos streamSid (llega en start)
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta }
        })
      );
    }

    // Transcript del cliente
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = msg.transcript || "";
      transcript += `\nCLIENTE: ${t}`;
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🟦 OpenAI realtime cerrado", { code, reason: reason?.toString?.() });
    try {
      twilioWs.close();
    } catch {}
  });

  openaiWs.on("error", (e) => {
    console.error("🟥 OpenAI WS error", e?.message || e);
  });

  // Twilio WS inbound
  twilioWs.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      callSid = data.start?.callSid || "";
      streamSid = data.start?.streamSid || "";
      console.log("📞 Twilio start", { callSid, streamSid });
      return;
    }

    if (data.event === "media") {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload
          })
        );
      }
      return;
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stop", { callSid, streamSid });

      // SMS al colgar (si falla OpenAI, mandamos algo mínimo)
      try {
        const extracted = await extractTicket(transcript, night);
        const smsText = formatSms(extracted, callSid);
        await sendSms(process.env.ALERT_TO_NUMBER, smsText);
        console.log("✅ SMS enviado");
      } catch (e) {
        console.error("❌ Error enviando SMS", e?.message || e);
      } finally {
        try {
          openaiWs.close();
        } catch {}
      }
    }
  });

  twilioWs.on("close", () => {
    console.log("🟦 Twilio WS cerrado");
    try {
      openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (e) => console.error("🟥 Twilio WS error", e?.message || e));
});

async function extractTicket(transcript, night) {
  const model = process.env.EXTRACT_MODEL || "gpt-4o-mini";

  // Si no hay transcript, devolvemos vacío para no romper JSON.parse
  if (!transcript || transcript.trim().length < 5) {
    return {
      nombre: "",
      telefono: "",
      direccion: "",
      zona: "",
      servicio: "",
      averia: "",
      urgente: "",
      aceptoNocturno: night ? "no" : "n-a",
      notas: "Sin transcripción (posible fallo de audio)."
    };
  }

  const prompt = `
Extrae un PARTE de servicio desde esta conversación (en español). Devuelve SOLO JSON válido.
Campos:
nombre, telefono, direccion, zona, servicio (uno de: fontanería/electricidad/cerrajería/persianas/electrodomésticos/pintura/mantenimiento), averia, urgente (si/no), aceptoNocturno (si/no/n-a), notas.

Reglas:
- Si night=${night} entonces aceptoNocturno debe ser si/no según si aceptó el recargo. Si no se menciona, pon "no".
- Si night=${night} es false, pon aceptoNocturno "n-a".
- Si no hay dato, deja string vacío.

TRANSCRIPCIÓN:
${transcript}
`.trim();

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: prompt
    })
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`OpenAI extract failed: ${resp.status} ${text}`);
  }

  // Responses suele traer output_text, pero si cambia, al menos no rompemos:
  let outText = "";
  try {
    const json = JSON.parse(text);
    outText = (json.output_text || "").trim();
  } catch {
    // si viniese ya como texto, seguimos
    outText = text.trim();
  }

  if (!outText) throw new Error("OpenAI extract devolvió vacío (output_text vacío).");

  return safeJsonParse(outText);
}

function formatSms(t, callSid) {
  return [
    "🛠️ AVISO URGENCIA (MARTA)",
    `Servicio: ${t.servicio || "-"}`,
    `Nombre: ${t.nombre || "-"}`,
    `Tel: ${t.telefono || "-"}`,
    `Dirección: ${t.direccion || "-"}`,
    `Zona: ${t.zona || "-"}`,
    `Urgente: ${t.urgente || "-"}`,
    `Acepto nocturno: ${t.aceptoNocturno || "-"}`,
    `Avería: ${t.averia || "-"}`,
    `Notas: ${t.notas || "-"}`,
    callSid ? `CallSid: ${callSid}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
