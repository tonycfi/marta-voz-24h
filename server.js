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

  // transcript solo del cliente (para el SMS)
  let transcript = "";

  // Control para evitar bucles / solapamientos
  let greeted = false;
  let sessionReady = false;
  let awaitingAssistant = false;
  let assistantTextBuffer = "";

  console.log("📞 Twilio WS conectado");

  const realtimeModel = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview-2025-06-03";
  const voice = process.env.REALTIME_VOICE || "alloy";

  const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  // ✅ Instrucciones: sin "buscar técnicos", sin "riesgos", sin repetir saludo.
  // Importante: como vamos en modo MANUAL, Marta solo habla cuando nosotros pedimos response.create.
  const baseInstructions = `
Eres "Marta", asistente de urgencias de "Reparaciones Express 24h Costa del Sol".
Hablas SIEMPRE en español neutro. Tono profesional, rápido y empático.

PROHIBIDO:
- No busques técnicos externos.
- No digas "te busco uno cerca", "te recomiendo alguien", "según tu ubicación", etc.
- No repitas el saludo nunca (solo una vez al principio).
- No preguntes por "riesgos". Solo pregunta si es urgente (sí/no).

OBJETIVO:
Recoger estos datos EN ESTE ORDEN (una pregunta corta cada vez):
1) Nombre
2) Teléfono de contacto (confirmar si es el mismo desde el que llama)
3) Dirección completa
4) Zona/municipio (Costa del Sol)
5) Tipo de servicio (elige 1):
   fontanería, electricidad, cerrajería, persianas, termo/agua caliente,
   aire acondicionado, electrodomésticos, pintura, mantenimiento
6) Descripción breve de la avería
7) ¿Es urgente? (sí/no)

REGLA NOCTURNA:
Si es noche (22:00-08:00 hora España), di literalmente (una sola vez, cuando toque enviar técnico):
"Te informo: entre las 22:00 y las 08:00 la salida para ver la avería son 70€, y después la mano de obra nocturna suele estar entre 50€ y 70€ por hora, según el trabajo. ¿Lo aceptas para enviar al técnico?"
Si no acepta, toma nota y di que pueden llamar en horario diurno.

CIERRE OBLIGATORIO (cuando ya tengas los datos):
"Perfecto. Voy a enviar el aviso al técnico de guardia ahora mismo y te llamará para confirmar disponibilidad y tiempo estimado."

DESPEDIDA según parte del día:
- mañana: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenos días, hasta luego."
- tarde: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenas tardes, hasta luego."
- noche: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buena noche, hasta luego."

Cuando termines el cierre+despedida, añade EXACTAMENTE al final: [END_CALL]
(esto es interno; el cliente lo oirá como texto normal, pero nos sirve para colgar).
`;

  function sendAudioToTwilio(base64ulaw) {
    if (!streamSid) return;
    twilioWs.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: base64ulaw }
      })
    );
  }

  function maybeHangupIfEndCall(text) {
    if (!callSid) return;
    if (!text) return;
    if (!text.includes("[END_CALL]")) return;

    // Colgamos la llamada desde Twilio (para que no se quede abierta y evitar bucles)
    try {
      twilioClient.calls(callSid).update({ status: "completed" }).catch(() => {});
    } catch {}
  }

  function startGreetingIfReady() {
    if (greeted) return;
    if (!streamSid) return;
    if (!sessionReady) return;
    if (openaiWs.readyState !== WebSocket.OPEN) return;

    greeted = true;
    awaitingAssistant = true;
    assistantTextBuffer = "";

    // ✅ Saludo EXACTO (tu punto 1)
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            'Di exactamente: "Hola, soy Marta, el asistente de urgencias de Reparaciones Express 24h Costa del Sol. ¿En qué puedo ayudarte?"'
        }
      })
    );
  }

  function askNextStepAfterUserUtterance() {
    if (openaiWs.readyState !== WebSocket.OPEN) return;
    if (!sessionReady) return;
    if (!greeted) return; // primero el saludo
    if (awaitingAssistant) return; // evita solaparse

    awaitingAssistant = true;
    assistantTextBuffer = "";

    // Le damos contexto con lo que el cliente ya dijo
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `
Sigue el guion y continúa la recogida de datos (sin repetir el saludo).
Contexto horario: es_noche=${night}, parte_del_dia=${part}.
Teléfono origen (si sirve para confirmar): ${fromNumber || "-"}.

Conversación (solo cliente):
${transcript}

Ahora: formula SOLO la siguiente pregunta necesaria según lo que falte.
Si ya tienes todo, haz cierre+despedida y termina con [END_CALL].
`
        }
      })
    );
  }

  openaiWs.on("open", () => {
    console.log("🟢 OpenAI realtime conectado", { model: realtimeModel });

    // ✅ Evitamos el error de temperature (>= 0.6)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: baseInstructions + `\nContexto horario: es_noche=${night}, parte_del_dia=${part}.`,
          voice,
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe" },

          // ✅ CLAVE ANTI-BUCLE: NO auto-turn. Nosotros mandamos response.create manualmente.
          turn_detection: { type: "none" },

          temperature: 0.7
        }
      })
    );

    // si por lo que sea no llega session.updated, no nos quedamos colgados
    setTimeout(() => {
      if (!sessionReady) {
        sessionReady = true;
        console.log("✅ OpenAI session READY (fallback)");
        startGreetingIfReady();
      }
    }, 800);
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // ready signals
    if (msg.type === "session.updated" || msg.type === "session.created") {
      if (!sessionReady) {
        sessionReady = true;
        console.log("✅ OpenAI session READY por", msg.type);
        startGreetingIfReady();
      }
      return;
    }

    // Audio hacia Twilio
    if (msg.type === "response.audio.delta") {
      sendAudioToTwilio(msg.delta);
      return;
    }

    // Texto de Marta (para detectar [END_CALL])
    if (msg.type === "response.output_text.delta") {
      assistantTextBuffer += msg.delta || "";
      maybeHangupIfEndCall(assistantTextBuffer);
      return;
    }

    // Fin de respuesta del asistente -> ya podemos permitir siguiente turno
    if (msg.type === "response.completed") {
      awaitingAssistant = false;
      // Si ha dicho END_CALL, colgaremos nosotros; si no, esperamos al usuario.
      return;
    }

    // Transcripción del cliente
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = (msg.transcript || "").trim();
      if (t) transcript += `CLIENTE: ${t}\n`;
      askNextStepAfterUserUtterance();
      return;
    }

    if (msg.type === "error") {
      console.error("❌ OpenAI error payload:", msg);
      awaitingAssistant = false;
      return;
    }
  });

  openaiWs.on("close", () => console.log("🔵 OpenAI realtime cerrado"));
  openaiWs.on("error", (e) => console.error("❌ OpenAI WS error", e));

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
      startGreetingIfReady();
      return;
    }

    if (data.event === "media") {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
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
          // fallback: siempre en líneas
          await sendSms(
            [
              "🛠️ AVISO URGENCIA (MARTA)",
              "Servicio: -",
              "Nombre: -",
              `Tel: ${fromNumber || "-"}`,
              "Dirección: -",
              "Zona: -",
              "Urgente: -",
              "Acepto nocturno: -",
              "Avería: -",
              `Notas: Error generando parte.`,
              callSid ? `CallSid: ${callSid}` : "",
              "",
              "Transcripción:",
              transcript || "(sin transcripción)"
            ]
              .filter(Boolean)
              .join("\n")
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

  // ✅ Formato EXACTO en líneas (tu punto 3)
  const emptySms = (notes) =>
    [
      "🛠️ AVISO URGENCIA (MARTA)",
      "Servicio: -",
      "Nombre: -",
      `Tel: ${fromNumber || "-"}`,
      "Dirección: -",
      "Zona: -",
      "Urgente: -",
      "Acepto nocturno: -",
      "Avería: -",
      `Notas: ${notes}`,
      callSid ? `CallSid: ${callSid}` : ""
    ]
      .filter(Boolean)
      .join("\n");

  if (!transcript || !transcript.trim()) {
    return emptySms("Sin transcripción (posible fallo de audio).");
  }

  let extracted;
  try {
    extracted = await extractTicket(transcript, night);
  } catch (e) {
    // fallback con transcripción (para que nunca se pierda lo dicho)
    return [
      "🛠️ AVISO URGENCIA (MARTA)",
      "Servicio: -",
      "Nombre: -",
      `Tel: ${fromNumber || "-"}`,
      "Dirección: -",
      "Zona: -",
      "Urgente: -",
      "Acepto nocturno: -",
      "Avería: -",
      "Notas: Error generando parte.",
      callSid ? `CallSid: ${callSid}` : "",
      "",
      "Transcripción:",
      transcript
    ]
      .filter(Boolean)
      .join("\n");
  }

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

  // parse robusto
  const first = out.indexOf("{");
  const last = out.lastIndexOf("}");
  const candidate = first >= 0 && last >= 0 ? out.slice(first, last + 1) : out;

  return JSON.parse(candidate);
}
