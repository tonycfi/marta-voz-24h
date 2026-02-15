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
  return String(str)
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
  // Render suele ir en UTC; convertimos a Europe/Madrid (o el que pongas)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  // YYYY-MM-DDTHH:mm:ss
  const isoLike = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  return new Date(isoLike);
}

function isNightWindow(dateObj) {
  const h = dateObj.getHours();
  return h >= 22 || h < 8;
}

function dayPart(dateObj) {
  const h = dateObj.getHours();
  if (h >= 8 && h < 14) return "mañana";
  if (h >= 14 && h < 22) return "tarde";
  return "noche";
}

function formatSmsFromTicket(t, callSid) {
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
  ]
    .filter(Boolean)
    .join("\n");
}

// Página de prueba
app.get("/", (_, res) => res.send("Marta voz activa ✅"));

// Twilio Voice webhook
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-media`;

  // IMPORTANTE: NO pongas track="both_tracks" aquí (Twilio da 31941 con <Connect>)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// Servidor HTTP
const server = app.listen(PORT, () => {
  console.log("Listening on", PORT);
});

// WebSocket para Twilio Media Streams
const wss = new WebSocketServer({ server, path: "/twilio-media" });

wss.on("connection", (twilioWs) => {
  let streamSid = "";
  let callSid = "";
  let transcript = "";
  let martaText = "";

  const tNow = nowInTZ();
  const night = isNightWindow(tNow);
  const part = dayPart(tNow);

  // Si OpenAI manda audio antes de que Twilio mande "start", lo guardamos aquí
  const pendingOutboundAudio = [];

  console.log("📞 Twilio WS conectado");

  const realtimeModel = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview-2025-06-03";
  const realtimeVoice = process.env.REALTIME_VOICE || "alloy";

  // OpenAI Realtime WS
  const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  function safeSendToTwilio(payloadObj) {
    if (twilioWs.readyState !== WebSocket.OPEN) return;
    try {
      twilioWs.send(JSON.stringify(payloadObj));
    } catch {}
  }

  function flushPendingAudio() {
    if (!streamSid) return;
    while (pendingOutboundAudio.length) {
      const b64 = pendingOutboundAudio.shift();
      safeSendToTwilio({
        event: "media",
        streamSid,
        media: { payload: b64 },
      });
    }
  }

  const BASE_INSTRUCTIONS = `
Eres "Marta", asistente de urgencias de la empresa "Reparaciones Express 24h Costa del Sol".
Hablas SIEMPRE en español neutro. Tono profesional, rápido, empático.

MUY IMPORTANTE (PROHIBICIONES):
- NO busques técnicos fuera de la empresa.
- NO recomiendes profesionales externos.
- NO uses internet ni “buscar cerca”.
- Tu único objetivo es tomar datos y PASARLO al técnico de guardia de la empresa.

Guion de apertura (MARTA HABLA PRIMERA, sin esperar "hola"):
"Hola, soy Marta, el asistente de urgencias de Reparaciones Express 24h. ¿En qué puedo ayudarte?"

Datos a recoger (en este orden, preguntas cortas, confirmando cada dato):
1) Nombre
2) Teléfono de contacto (confirmar si es el mismo desde el que llama)
3) Dirección completa (calle, número, portal/piso si aplica)
4) Zona/municipio (Costa del Sol)
5) Tipo de servicio (elige 1): fontanería, electricidad, cerrajería, persianas, termo, aire acondicionado, electrodomésticos, pintura, mantenimiento
6) Descripción breve de la avería
7) ¿Es urgente? (si/no). ¿Hay riesgo? (agua/fuego/personas atrapadas)

Regla nocturna:
Si es entre 22:00 y 08:00 (hora España), di literalmente:
"Te informo: entre las 22:00 y las 08:00 la salida para ver la avería son 70€, y después la mano de obra nocturna suele estar entre 50€ y 70€ por hora, según el trabajo. ¿Lo aceptas para enviar al técnico?"
- Si acepta: marca aceptoNocturno=si.
- Si no acepta: aceptoNocturno=no y ofrece dejarlo para horario diurno.

Cierre obligatorio (SIEMPRE, sin hablar de buscar técnicos):
"Perfecto. Voy a pasar ahora mismo los datos al técnico de guardia de nuestra empresa y te llamará o te enviará un mensaje para confirmar disponibilidad y tiempo estimado."

Despedida según parte del día (${part}):
- mañana: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenos días, hasta luego."
- tarde: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenas tardes, hasta luego."
- noche: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buena noche, hasta luego."

NO leas el parte en voz alta. Solo conversas con el cliente.
`;

  openaiWs.on("open", () => {
    console.log("🟢 OpenAI realtime conectado", { model: realtimeModel });

    // Config sesión: audio Twilio (mulaw), y habilitamos transcripción de entrada
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          voice: realtimeVoice,
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          temperature: 0.4,
          instructions: BASE_INSTRUCTIONS + `\nContexto: es_noche=${night}, parte_del_dia=${part}.`,
          // Esto ayuda a que lleguen eventos de transcripción del cliente
          input_audio_transcription: { model: process.env.TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe" },
        },
      })
    );

    // Marta habla PRIMERA
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: 'Di exactamente: "Hola, soy Marta, el asistente de urgencias de Reparaciones Express 24h. ¿En qué puedo ayudarte?"',
        },
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

    // AUDIO de OpenAI -> Twilio
    if (msg.type === "response.audio.delta") {
      const b64 = msg.delta;

      // Si todavía no llegó el start de Twilio con streamSid, lo guardamos
      if (!streamSid) {
        pendingOutboundAudio.push(b64);
        return;
      }

      safeSendToTwilio({
        event: "media",
        streamSid,
        media: { payload: b64 },
      });
      return;
    }

    // Texto que dice Marta (por si quieres depurar)
    if (msg.type === "response.output_text.delta") {
      if (typeof msg.delta === "string") martaText += msg.delta;
      return;
    }

    // Transcripción del CLIENTE
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = (msg.transcript || "").trim();
      if (t) {
        transcript += `\nCLIENTE: ${t}`;
      }
      return;
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🔵 OpenAI realtime cerrado", { code, reason: String(reason || "") });
    try {
      twilioWs.close();
    } catch {}
  });

  openaiWs.on("error", (e) => console.error("❌ OpenAI WS error", e));

  // Mensajes desde Twilio (start/media/stop)
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
      console.log("☎️ Twilio start", { callSid, streamSid });

      // Ahora que ya tenemos streamSid, enviamos el audio pendiente (saludo)
      flushPendingAudio();
      return;
    }

    if (data.event === "media") {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media?.payload,
          })
        );
      }
      return;
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stop", { callSid, streamSid });

      // Cerramos realtime
      try {
        openaiWs.close();
      } catch {}

      // Si no hay transcripción, aún así mandamos un SMS claro
      try {
        const extracted = await extractTicketToJson(transcript, night);
        const smsText = formatSmsFromTicket(extracted, callSid);
        await sendSms(smsText);
        console.log("✅ SMS enviado");
      } catch (e) {
        console.error("❌ Error enviando SMS", e);
        try {
          await sendSms(
            transcript
              ? "Transcripción de llamada:\n" + transcript
              : "Llamada sin audio reconocido (posible fallo de transcripción)."
          );
        } catch {}
      }

      return;
    }
  });

  twilioWs.on("close", () => console.log("🔌 Twilio WS cerrado"));
});

// --- EXTRACCIÓN (Responses API) ---
async function extractTicketToJson(transcript, night) {
  const model = process.env.EXTRACT_MODEL || "gpt-4o-mini";

  const prompt = `
Extrae un PARTE de servicio desde la conversación. Devuelve SOLO JSON válido con estos campos:

nombre (string),
telefono (string),
direccion (string),
zona (string),
servicio (string; uno de: fontanería/electricidad/cerrajería/persianas/termo/aire acondicionado/electrodomésticos/pintura/mantenimiento),
averia (string),
urgente (si/no),
aceptoNocturno (si/no/n-a),
notas (string)

Reglas:
- Si night=${night} entonces aceptoNocturno debe ser "si" o "no" según si aceptó el recargo. Si no se menciona, "no".
- Si night=${night} es false, aceptoNocturno = "n-a".
- Si falta un dato, pon string vacío "".
- Si no hay transcripción útil, pon notas="Sin transcripción (posible fallo de audio)."

CONVERSACIÓN:
${transcript || "(sin transcripción)"}
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: prompt,
      // 👇 IMPORTANTE: lo nuevo es text.format (evita el error de response_format)
      text: { format: { type: "json_object" } },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI extract failed: ${resp.status} ${text}`);
  }

  const json = await resp.json();
  const out = (json.output_text || "").trim();

  // Por seguridad, si por cualquier cosa viene vacío:
  if (!out) {
    return {
      nombre: "",
      telefono: "",
      direccion: "",
      zona: "",
      servicio: "",
      averia: "",
      urgente: "",
      aceptoNocturno: night ? "no" : "n-a",
      notas: "Sin transcripción (posible fallo de audio).",
    };
  }

  // output_text ya debería ser JSON válido
  return JSON.parse(out);
}
