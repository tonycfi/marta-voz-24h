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

// ---------- Comprobación de variables ----------
const REQUIRED_ENVS = [
  "OPENAI_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_SMS_FROM",
  "ALERT_TO_NUMBER",
];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) console.warn(`⚠️ Falta ENV: ${k}`);
}

const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-4o-mini-realtime-preview";
const REALTIME_VOICE = process.env.REALTIME_VOICE || "alloy";
const EXTRACT_MODEL = process.env.EXTRACT_MODEL || "gpt-4o-mini";

// ---------- Twilio client (para SMS) ----------
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ---------- helpers ----------
function nowInTZ() {
  // Render suele ir en UTC; forzamos TZ
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  // yyyy-mm-ddThh:mm:ss
  return new Date(`${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}`);
}

function isNightWindow(d) {
  const h = d.getHours();
  return h >= 22 || h < 8;
}

function dayPart(d) {
  const h = d.getHours();
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
  return twilioClient.messages.create({ from, to, body });
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- endpoints ----------
app.get("/", (req, res) => res.send("Marta 24h está viva ✅"));

/**
 * Twilio Voice webhook (IMPORTANTE: track="both_tracks" para poder devolver audio al caller)
 */
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-media`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="${escapeXml(wsUrl)}" track="inbound_track" />
      </Connect>
    </Response>`;

  res.type("text/xml").send(twiml);
});

// ---------- Server + WS ----------
const server = app.listen(PORT, () => console.log("✅ Listening on", PORT));
const wss = new WebSocketServer({ server, path: "/twilio-media" });

wss.on("connection", (twilioWs) => {
  const tNow = nowInTZ();
  const night = isNightWindow(tNow);
  const part = dayPart(tNow);

  let callSid = "";
  let streamSid = "";
  let transcript = "";

  console.log("🔌 Twilio WS conectado");

  // ---- Conexión a OpenAI Realtime ----
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
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
`.trim();

  openaiWs.on("open", () => {
    console.log("✅ OpenAI realtime conectado");

    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: `${baseInstructions}\nContexto horario: es_noche=${night}, parte_del_dia=${part}.`,
          voice: REALTIME_VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          modalities: ["audio", "text"],
          temperature: 0.4,
        },
      })
    );

    // Saludo inicial
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Empieza con el saludo exacto del guion y espera respuesta.",
        },
      })
    );
  });

  openaiWs.on("message", (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg) return;

    // ✅ AUDIO: el evento correcto según la doc es response.output_audio.delta
    // (por compatibilidad, aceptamos también el antiguo si alguna vez aparece)
    if (msg.type === "response.output_audio.delta" || msg.type === "response.audio.delta") {
      if (!streamSid) return; // todavía no llegó el start de Twilio

      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta },
        })
      );
    }

    // Transcripción del cliente si el modelo la emite
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = msg.transcript || "";
      transcript += `\nCLIENTE: ${t}`;
    }

    // Si quieres, puedes guardar también lo que dice Marta
    if (msg.type === "response.output_text.delta") {
      // transcript += `\nMARTA: ${msg.delta || ""}`; // opcional
    }
  });

  openaiWs.on("error", (e) => console.error("❌ OpenAI WS error", e));
  openaiWs.on("close", () => {
    console.log("🔵 OpenAI realtime cerrado");
    try { twilioWs.close(); } catch {}
  });

  // ---- Recibe eventos de Twilio ----
  twilioWs.on("message", async (raw) => {
    const data = safeJsonParse(raw.toString());
    if (!data) return;

    if (data.event === "start") {
      callSid = data.start?.callSid || "";
      streamSid = data.start?.streamSid || "";
      console.log("📞 Twilio start", { callSid, streamSid });
      return;
    }

    if (data.event === "media") {
      // Audio μ-law base64 -> OpenAI input buffer
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }
      return;
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stop", { callSid, streamSid });

      // Cuando cuelga: intentamos extraer y mandar SMS (si falla, mandamos “fallback”)
      try {
        const extracted = await extractTicket(transcript, night);
        const smsText = formatSms(extracted, callSid);
        await sendSms(process.env.ALERT_TO_NUMBER, smsText);
        console.log("✅ SMS enviado");
      } catch (e) {
        console.error("❌ Error enviando SMS (extract)", e);

        // Fallback: manda transcripción cruda
        try {
          const fallback = [
            "🛠️ AVISO URGENCIA (MARTA) - FALLBACK",
            callSid ? `CallSid: ${callSid}` : "",
            "Transcripción:",
            transcript || "(sin transcripción)",
          ].filter(Boolean).join("\n");

          await sendSms(process.env.ALERT_TO_NUMBER, fallback.slice(0, 1500));
          console.log("✅ SMS fallback enviado");
        } catch (e2) {
          console.error("❌ Error enviando SMS fallback", e2);
        }
      } finally {
        try { openaiWs.close(); } catch {}
      }
    }
  });

  twilioWs.on("close", () => {
    console.log("🔵 Twilio WS cerrado");
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (e) => console.error("❌ Twilio WS error", e));
});

// ---------- Extractor para SMS (forzando JSON) ----------
async function extractTicket(transcript, night) {
  const prompt = `
Extrae un PARTE de servicio desde esta conversación (en español). Devuelve SOLO JSON válido.
Campos:
nombre, telefono, direccion, zona, servicio (uno de: fontanería/electricidad/cerrajería/persianas/electrodomésticos/pintura/mantenimiento),
averia, urgente (si/no), aceptoNocturno (si/no/n-a), notas.

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
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      input: prompt,
      // ✅ Esto ayuda a que responda como JSON
      response_format: { type: "json_object" },
    }),
  });

  const text = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI extract failed: ${resp.status} ${text}`);

  const json = safeJsonParse(text);
  const out = (json?.output_text || "").trim();
  const parsed = safeJsonParse(out);
  if (!parsed) throw new Error(`Extractor no devolvió JSON. output_text: ${out}`);
  return parsed;
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
    callSid ? `CallSid: ${callSid}` : "",
  ].filter(Boolean).join("\n");
}
