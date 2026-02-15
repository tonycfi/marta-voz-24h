import express from "express";
import dotenv from "dotenv";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = process.env.PORT || 10000;
const TZ = process.env.TIMEZONE || "Europe/Madrid";

// --- Twilio ---
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function escapeXml(str = "") {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function sendSms(body) {
  const from = process.env.TWILIO_SMS_FROM;
  const to = process.env.ALERT_TO_NUMBER;
  if (!from) throw new Error("Falta TWILIO_SMS_FROM");
  if (!to) throw new Error("Falta ALERT_TO_NUMBER");
  return twilioClient.messages.create({ from, to, body });
}

function nowInTZ() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
    .formatToParts(new Date())
    .reduce((acc, p) => ((acc[p.type] = p.value), acc), {});
  return new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`);
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

// --- Health check ---
app.get("/", (_, res) => res.send("Marta voz activa ✅"));

// --- Twilio Voice webhook ---
app.post("/voice", (req, res) => {
  const host = req.get("host");

  // No usamos track=... (te daba "Invalid Track configuration")
  const wsUrl = `wss://${host}/twilio-media`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// --- Start server ---
const server = app.listen(PORT, () => console.log("Listening on", PORT));

// --- WS server for Twilio Media Streams ---
const wss = new WebSocketServer({ server, path: "/twilio-media" });

wss.on("connection", (twilioWs) => {
  const tNow = nowInTZ();
  const night = isNightWindow(tNow);
  const part = dayPart(tNow);

  let streamSid = "";
  let callSid = "";
  let fromNumber = "";

  let transcript = "";
  let greeted = false;

  // READY si llega session.created/updated, o por fallback en 1s
  let sessionReady = false;
  let openaiConnected = false;

  console.log("📞 Twilio WS conectado");

  const realtimeModel = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview-2025-06-03";
  const voice = process.env.REALTIME_VOICE || "alloy";

  const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  const baseInstructions = `
Eres "Marta", asistente de urgencias de "Reparaciones Express 24h Costa del Sol".
Hablas SIEMPRE en español neutro. Tono profesional, rápido y empático.

IMPORTANTE:
- NO busques técnicos externos.
- NO digas "te busco uno cerca" ni nada parecido.
- SIEMPRE di que pasarás el aviso a NUESTRO técnico de guardia.

Guion de apertura (dilo tal cual):
"Hola, soy Marta, el asistente de urgencias de Reparaciones Express 24h Costa del Sol. ¿En qué puedo ayudarte?"

Datos a recoger (en este orden, 1 pregunta cada vez):
1) Nombre
2) Teléfono de contacto (confirmar si es el mismo desde el que llama)
3) Dirección completa
4) Zona/municipio (Costa del Sol)
5) Tipo de servicio (elige 1):
   fontanería, electricidad, cerrajería, persianas, termo/agua caliente,
   aire acondicionado, electrodomésticos, pintura, mantenimiento
6) Descripción breve de la avería
7) ¿Es urgente o hay riesgo? (agua/fuego/personas atrapadas) => urgente si/no

Regla nocturna:
Si es entre 22:00 y 08:00 (hora España), di literalmente:
"Te informo: entre las 22:00 y las 08:00 la salida para ver la avería son 70€, y después la mano de obra nocturna suele estar entre 50€ y 70€ por hora, según el trabajo. ¿Lo aceptas para enviar al técnico?"
Si no acepta, toma nota y sugiere llamar en horario diurno.

Cierre obligatorio (dilo tal cual):
"Perfecto. Voy a enviar el aviso al técnico de guardia ahora mismo y te llamará para confirmar disponibilidad y tiempo estimado."

Despedida según parte del día:
- mañana: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenos días, hasta luego."
- tarde: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenas tardes, hasta luego."
- noche: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buena noche, hasta luego."
`;

  function markReady(reason) {
    if (sessionReady) return;
    sessionReady = true;
    console.log("✅ OpenAI session READY por:", reason);
    startGreetingIfReady();
  }

  function startGreetingIfReady() {
    if (greeted) return;
    if (!streamSid) return; // sin streamSid no mandamos audio a Twilio
    if (openaiWs.readyState !== WebSocket.OPEN) return;
    if (!sessionReady) return;

    greeted = true;
    console.log("🗣️ Enviando saludo de Marta...");

    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Empieza con el saludo exacto del guion y espera respuesta. Contexto: es_noche=${night}, parte_del_dia=${part}.`
        }
      })
    );
  }

  openaiWs.on("open", () => {
    openaiConnected = true;
    console.log("🟢 OpenAI realtime conectado", { model: realtimeModel });

    // Config de sesión
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: `${baseInstructions}\nContexto horario: es_noche=${night}, parte_del_dia=${part}.`,
          voice,
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe" },
          turn_detection: { type: "server_vad" },
          temperature: 0.4
        }
      })
    );

    // ✅ Fallback: si no llega session.created/updated, a los 1000ms lo damos por ready
    setTimeout(() => {
      if (!sessionReady && openaiConnected) markReady("fallback_1000ms");
    }, 1000);
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // 🔎 (Opcional) si quieres ver el tipo de eventos:
    // console.log("OpenAI msg.type:", msg.type);

    if (msg.type === "session.created") {
      markReady("session.created");
      return;
    }
    if (msg.type === "session.updated") {
      markReady("session.updated");
      return;
    }

    // Audio OpenAI -> Twilio
    if (msg.type === "response.audio.delta") {
      if (!streamSid) return;
      // Log muy ligero (si quieres: comenta la línea)
      // console.log("🔊 audio.delta -> Twilio");
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta }
        })
      );
      return;
    }

    // Transcripción del cliente
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = (msg.transcript || "").trim();
      if (t) transcript += `CLIENTE: ${t}\n`;
      return;
    }

    // Si OpenAI responde con error
    if (msg.type === "error") {
      console.error("❌ OpenAI error payload:", msg);
      return;
    }
  });

  openaiWs.on("close", () => console.log("🔵 OpenAI realtime cerrado"));
  openaiWs.on("error", (e) => console.error("❌ OpenAI WS error", e));

  // Twilio events
  twilioWs.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (data.event === "start") {
      streamSid = data.start?.streamSid || "";
      callSid = data.start?.callSid || "";
      fromNumber = data.start?.customParameters?.From || "";

      console.log("☎️ Twilio start", { callSid, streamSid, fromNumber });

      // Si ya está ready, saluda ya
      startGreetingIfReady();
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

      try {
        const smsText = await buildSmsFromTranscript(transcript, { callSid, fromNumber, night });
        await sendSms(smsText);
        console.log("✅ SMS enviado");
      } catch (e) {
        console.error("❌ Error enviando SMS", e);
        try {
          await sendSms(
            `🛠️ AVISO URGENCIA (MARTA)\nNotas: Error generando parte.\nCallSid: ${callSid || "-"}\nTranscripción:\n${transcript || "(sin transcripción)"}`
          );
        } catch {}
      } finally {
        try { openaiWs.close(); } catch {}
      }
      return;
    }
  });

  twilioWs.on("close", () => console.log("🔌 Twilio WS cerrado"));
});

// -------- Extract + SMS (Responses API) --------

async function buildSmsFromTranscript(transcript, meta) {
  const { callSid, fromNumber, night } = meta;

  if (!transcript || !transcript.trim()) {
    return [
      "🛠️ AVISO URGENCIA (MARTA)",
      `Tel (origen): ${fromNumber || "-"}`,
      "Notas: Sin transcripción (posible fallo de audio).",
      callSid ? `CallSid: ${callSid}` : ""
    ]
      .filter(Boolean)
      .join("\n");
  }

  const extracted = await extractTicket(transcript, night);

  return [
    "🛠️ AVISO URGENCIA (MARTA)",
    `Servicio: ${extracted.servicio || "-"}`,
    `Nombre: ${extracted.nombre || "-"}`,
    `Tel: ${extracted.telefono || fromNumber || "-"}`,
    `Dirección: ${extracted.direccion || "-"}`,
    `Zona: ${extracted.zona || "-"}`,
    `Urgente: ${extracted.urgente || "-"}`,
    `Acepto nocturno: ${extracted.aceptoNocturno || "-"}`,
    `Avería: ${extracted.averia || "-"}`,
    `Notas: ${extracted.notas || "-"}`,
    callSid ? `CallSid: ${callSid}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

async function extractTicket(transcript, night) {
  const model = process.env.EXTRACT_MODEL || "gpt-4o-mini";

  const prompt = `
Extrae un PARTE de servicio desde esta conversación.
Devuelve SOLO JSON válido con estas claves EXACTAS:
{
  "nombre": "",
  "telefono": "",
  "direccion": "",
  "zona": "",
  "servicio": "",
  "averia": "",
  "urgente": "si|no",
  "aceptoNocturno": "si|no|n-a",
  "notas": ""
}

Reglas:
- "servicio" debe ser UNO de:
  "fontanería" | "electricidad" | "cerrajería" | "persianas" | "termo/agua caliente" | "aire acondicionado" | "electrodomésticos" | "pintura" | "mantenimiento"
- Si night=${night} es true => aceptoNocturno "si" o "no" (si no se menciona, "no").
- Si night=${night} es false => aceptoNocturno "n-a".
- Si no hay dato, deja "" y NO inventes.

CONVERSACIÓN:
${transcript}
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: prompt,
      text: { format: { type: "json_object" } }
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI extract failed: ${resp.status} ${text}`);
  }

  const json = await resp.json();
  const out = (json.output_text || "").trim();

  const first = out.indexOf("{");
  const last = out.lastIndexOf("}");
  const candidate = first >= 0 && last >= 0 ? out.slice(first, last + 1) : out;

  return JSON.parse(candidate);
}
