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
  // Hora en Europe/Madrid aunque Render esté en UTC
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
  // en-CA => YYYY-MM-DD
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

  // Pasamos From/CallSid en querystring => Twilio los mete en start.customParameters
  const from = encodeURIComponent(req.body.From || "");
  const callSid = encodeURIComponent(req.body.CallSid || "");

  const wsUrl = `wss://${host}/twilio-media?from=${from}&callSid=${callSid}`;

  // OJO: NO ponemos track=... porque te daba "Invalid Track configuration"
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// --- Start server ---
const server = app.listen(PORT, () => {
  console.log("Listening on", PORT);
});

// --- WS server for Twilio Media Streams ---
const wss = new WebSocketServer({ server, path: "/twilio-media" });

wss.on("connection", (twilioWs, req) => {
  const tNow = nowInTZ();
  const night = isNightWindow(tNow);
  const part = dayPart(tNow);

  let streamSid = "";
  let callSid = "";
  let fromNumber = "";
  let transcript = ""; // lo que dice el cliente (transcrito)

  let greeted = false;

  console.log("📞 Twilio WS conectado");

  // Modelo realtime (ponlo en env REALTIME_MODEL si quieres)
  const realtimeModel = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview-2025-06-03";
  const voice = process.env.REALTIME_VOICE || "alloy";

  // Conexión a OpenAI Realtime
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
- NO recomiendes "buscar a alguien cerca".
- SIEMPRE di que vas a pasar el aviso a NUESTRO técnico de guardia y que contactará para confirmar.

Guion de apertura (dilo tal cual):
"Hola, soy Marta, el asistente de urgencias de Reparaciones Express 24h Costa del Sol. ¿En qué puedo ayudarte?"

Objetivo: recopilar datos en ESTE ORDEN (preguntas cortas, una por una):
1) Nombre
2) Teléfono de contacto (confirmar si es el mismo desde el que llama)
3) Dirección completa (calle, número, portal/piso si aplica)
4) Zona/municipio (Costa del Sol)
5) Tipo de servicio (elige 1): fontanería, electricidad, cerrajería, persianas, termo/agua caliente, aire acondicionado, electrodomésticos, pintura, mantenimiento
6) Descripción breve de la avería
7) ¿Es urgente o hay riesgo? (agua/fuego/personas atrapadas) => urgente: sí/no

Regla nocturna:
Si es entre 22:00 y 08:00 (hora España), di literalmente:
"Te informo: entre las 22:00 y las 08:00 la salida para ver la avería son 70€, y después la mano de obra nocturna suele estar entre 50€ y 70€ por hora, según el trabajo. ¿Lo aceptas para enviar al técnico?"
- Si no acepta, ofrece tomar nota y que llamen en horario diurno.

Cierre obligatorio (dilo tal cual):
"Perfecto. Voy a enviar el aviso al técnico de guardia ahora mismo y te llamará para confirmar disponibilidad y tiempo estimado."

Despedida según parte del día:
- mañana: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenos días, hasta luego."
- tarde: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenas tardes, hasta luego."
- noche: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buena noche, hasta luego."
`;

  function startGreetingIfReady() {
    if (greeted) return;
    if (!streamSid) return; // sin streamSid no mandamos audio a Twilio
    if (openaiWs.readyState !== WebSocket.OPEN) return;

    greeted = true;

    // Forzamos saludo inicial (ya con streamSid listo)
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
    console.log("🟢 OpenAI realtime conectado", { model: realtimeModel });

    // Configuración compatible con Twilio (G.711 u-law)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice,
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          // Transcripción del cliente (para SMS)
          input_audio_transcription: { model: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe" },
          turn_detection: { type: "server_vad" },
          temperature: 0.4,
          instructions: `${baseInstructions}\nContexto horario: es_noche=${night}, parte_del_dia=${part}.`
        }
      })
    );

    // Si Twilio ya envió start, saludamos ya
    startGreetingIfReady();
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Audio OpenAI -> Twilio
    if (msg.type === "response.audio.delta") {
      if (!streamSid) return;
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta } // base64 g711_ulaw
        })
      );
    }

    // Transcripción del cliente
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = (msg.transcript || "").trim();
      if (t) transcript += `CLIENTE: ${t}\n`;
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

      // customParameters via querystring del WS
      fromNumber = data.start?.customParameters?.from || "";
      const callFromQuery = data.start?.customParameters?.callSid || "";
      if (!callSid && callFromQuery) callSid = callFromQuery;

      console.log("☎️ Twilio start", { callSid, streamSid, fromNumber });

      // Ahora ya podemos lanzar el saludo
      startGreetingIfReady();
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
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stop", { callSid, streamSid });

      try {
        const smsText = await buildSmsFromTranscript(transcript, {
          callSid,
          fromNumber,
          night,
          part,
          tz: TZ
        });
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
        try {
          openaiWs.close();
        } catch {}
      }
    }
  });

  twilioWs.on("close", () => console.log("🔌 Twilio WS cerrado"));
});

// -------- Extract + SMS formatting (Responses API) --------

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

  // Intentar extraer campos con OpenAI
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
- Si night=${night} es true => aceptoNocturno debe ser "si" o "no" (si no se menciona, "no").
- Si night=${night} es false => aceptoNocturno debe ser "n-a".
- Si no hay dato, deja "" (string vacío). No inventes.

CONVERSACIÓN (transcripción del cliente):
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
      // IMPORTANTE: el parámetro correcto es text.format (no response_format)
      text: { format: { type: "json_object" } }
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI extract failed: ${resp.status} ${text}`);
  }

  const json = await resp.json();
  const out = (json.output_text || "").trim();

  // Si por lo que sea devuelve texto alrededor, intentamos “recortar” el JSON
  const firstBrace = out.indexOf("{");
  const lastBrace = out.lastIndexOf("}");
  const candidate = firstBrace >= 0 && lastBrace >= 0 ? out.slice(firstBrace, lastBrace + 1) : out;

  return JSON.parse(candidate);
}
