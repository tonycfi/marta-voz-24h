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

// ====== Twilio ======
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Falta variable de entorno: ${name}`);
  return v;
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
  const from = requireEnv("TWILIO_SMS_FROM");
  return twilioClient.messages.create({ from, to, body });
}

// ====== Hora local (España) sin librerías ======
function getMadridInfo() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type)?.value || "00";
  const hour = Number(get("hour"));
  const isoLike = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;

  const esNoche = hour >= 22 || hour < 8;
  const parteDelDia = hour >= 8 && hour < 14 ? "mañana" : hour >= 14 && hour < 22 ? "tarde" : "noche";

  return { hour, esNoche, parteDelDia, isoLike };
}

// ====== Página de prueba ======
app.get("/", (req, res) => res.send("Marta 24h está viva ✅"));

// ====== Webhook de llamada entrante ======
app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${host}/twilio-media`;

  // IMPORTANTE: NO pongas track="both_tracks" (da error en Twilio)
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// ====== Servidor HTTP + WS ======
const server = app.listen(PORT, () => console.log("Listening on", PORT));
const wss = new WebSocketServer({ server, path: "/twilio-media" });

// ====== Prompt (lo más importante) ======
function buildInstructions({ esNoche, parteDelDia }) {
  return `
Eres "Marta", asistente de urgencias de "Reparaciones Express 24h Costa del Sol".
Hablas SIEMPRE en español (neutro), tono profesional, rápido y empático.

PROHIBIDO:
- NO busques técnicos externos.
- NO digas "te busco uno cerca".
- NO recomiendes servicios de terceros.
SIEMPRE debes decir que enviarás el aviso al técnico de guardia DE NUESTRA EMPRESA.

OBJETIVO:
Tomar datos y dejar un parte perfecto para enviar al técnico.

Guion de apertura (debes decirlo tú al empezar, sin esperar al cliente):
"Hola, soy Marta, el asistente de urgencias de Reparaciones Express 24h Costa del Sol. ¿En qué puedo ayudarte?"

Datos a recoger (en este orden, preguntas cortas):
1) Nombre
2) Teléfono de contacto (confirmar si es el mismo desde el que llama)
3) Dirección completa (calle, número, portal/piso/puerta si aplica)
4) Zona/municipio (Costa del Sol)
5) Tipo de servicio (elige 1): fontanería, electricidad, cerrajería, persianas, termo, aire acondicionado, electrodomésticos, pintura, mantenimiento
6) Descripción breve de la avería
7) ¿Es urgente o hay riesgo? (agua/fuego/personas atrapadas/niños/mayores)

Regla nocturna:
Si es entre 22:00 y 08:00 (hora España), di literalmente:
"Te informo: entre las 22:00 y las 08:00 la salida para ver la avería son 70€, y después la mano de obra nocturna suele estar entre 50€ y 70€ por hora, según el trabajo. ¿Lo aceptas para enviar al técnico?"
- Si NO acepta: toma nota y ofrece llamar en horario diurno.
- Si SÍ acepta: continúa normal.

Cierre obligatorio (siempre):
"Perfecto. Voy a enviar el aviso al técnico de guardia ahora mismo y te llamará para confirmar disponibilidad y tiempo estimado."

Despedida según parte del día:
- mañana: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenos días, hasta luego."
- tarde: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenas tardes, hasta luego."
- noche: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buena noche, hasta luego."

IMPORTANTE:
- No leas el parte en voz alta.
- Tu misión es recopilar datos. Si falta un dato, pregunta.
Contexto: es_noche=${esNoche}, parte_del_dia=${parteDelDia}.
`;
}

// ====== Helper: SMS bonito ======
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
  ].filter(Boolean).join("\n");
}

// ====== Extract con Responses API (SIN response_format; usa text.format) ======
async function extractTicket({ transcript, esNoche }) {
  const model = process.env.EXTRACT_MODEL || "gpt-4o-mini";

  const prompt = `
Extrae un PARTE de servicio desde esta conversación (español).
Devuelve SOLO JSON válido (sin texto extra).

Campos (strings):
nombre, telefono, direccion, zona, servicio, averia, urgente, aceptoNocturno, notas

Reglas:
- servicio debe ser uno de:
  fontanería | electricidad | cerrajería | persianas | termo | aire acondicionado | electrodomésticos | pintura | mantenimiento
- urgente: "si" o "no"
- aceptoNocturno:
  - si es_noche=${esNoche} => "si" o "no" (si no se menciona, "no")
  - si es_noche=false => "n-a"
- Si falta un dato, deja "".

TRANSCRIPCIÓN:
${transcript}
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: prompt,
      // 👇 esto evita el error que viste: response_format -> ahora es text.format
      text: { format: { type: "json_object" } }
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI extract failed: ${resp.status} ${text}`);
  }

  const json = await resp.json();
  const out = (json.output_text || "").trim();
  if (!out) throw new Error("OpenAI extract: output_text vacío");
  return JSON.parse(out);
}

// ====== WebSocket: Twilio <-> OpenAI Realtime ======
wss.on("connection", (twilioWs) => {
  const { esNoche, parteDelDia } = getMadridInfo();
  const instructions = buildInstructions({ esNoche, parteDelDia });

  let streamSid = "";
  let callSid = "";
  let fromNumber = "";
  let transcript = "";

  // Para que Marta hable SIEMPRE primero:
  // guardamos audio de OpenAI hasta que Twilio nos dé streamSid
  const pendingAudio = [];

  console.log("📞 Twilio WS conectado");

  const realtimeModel = process.env.REALTIME_MODEL || "gpt-4o-realtime-preview-2025-06-03";
  const voice = process.env.REALTIME_VOICE || "alloy";

  const openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`, {
    headers: {
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  function sendAudioToTwilio(base64UlawChunk) {
    if (!streamSid) {
      pendingAudio.push(base64UlawChunk);
      return;
    }
    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: base64UlawChunk } }));
  }

  function flushPendingAudio() {
    if (!streamSid || pendingAudio.length === 0) return;
    for (const chunk of pendingAudio.splice(0, pendingAudio.length)) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: chunk } }));
    }
  }

  openaiWs.on("open", () => {
    console.log("🟢 OpenAI realtime conectado", { model: realtimeModel });

    // Config session (Twilio usa g711_ulaw)
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions,
        voice,
        modalities: ["audio", "text"],
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        temperature: 0.4
      }
    }));

    // Marta debe hablar SIEMPRE primero
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Empieza AHORA con el saludo exacto del guion. No esperes a que el cliente diga "hola".`
      }
    }));
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Audio de OpenAI -> Twilio
    if (msg.type === "response.audio.delta" && msg.delta) {
      sendAudioToTwilio(msg.delta);
    }

    // Transcripción del cliente (si llega)
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = (msg.transcript || "").trim();
      if (t) transcript += `\nCLIENTE: ${t}`;
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🔵 OpenAI realtime cerrado", { code, reason: String(reason || "") });
    try { twilioWs.close(); } catch {}
  });

  openaiWs.on("error", (e) => {
    console.error("❌ OpenAI WS error", e?.message || e);
    try { twilioWs.close(); } catch {}
  });

  // Mensajes desde Twilio
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
      fromNumber = data.start?.customParameters?.From || "";

      console.log("☎️ Twilio start", { callSid, streamSid, fromNumber });
      flushPendingAudio(); // 👈 clave para que Marta hable aunque su audio llegara antes del streamSid
    }

    if (data.event === "media") {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload
        }));
      }
    }

    if (data.event === "stop") {
      console.log("🛑 Twilio stop", { callSid, streamSid });

      const alertTo = requireEnv("ALERT_TO_NUMBER");

      try {
        let smsText = "";

        if (!transcript.trim()) {
          smsText = [
            "🛠️ AVISO URGENCIA (MARTA)",
            "Notas: Sin transcripción (posible fallo de audio).",
            callSid ? `CallSid: ${callSid}` : ""
          ].filter(Boolean).join("\n");
        } else {
          const extracted = await extractTicket({ transcript, esNoche });
          smsText = formatSms(extracted, callSid);
        }

        await sendSms(alertTo, smsText);
        console.log("✅ SMS enviado");
      } catch (e) {
        console.error("❌ Error enviando SMS", e?.message || e);
        try {
          await sendSms(requireEnv("ALERT_TO_NUMBER"), `❌ Error generando parte (MARTA). CallSid: ${callSid || "-"}\n${String(e?.message || e)}`);
        } catch {}
      } finally {
        try { openaiWs.close(); } catch {}
      }
    }
  });

  twilioWs.on("close", () => {
    console.log("🔌 Twilio WS cerrado");
    try { openaiWs.close(); } catch {}
  });

  twilioWs.on("error", (e) => {
    console.error("❌ Twilio WS error", e?.message || e);
    try { openaiWs.close(); } catch {}
  });
});
