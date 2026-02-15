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

// --------- Twilio SMS ---------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

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
  if (!to) throw new Error("Falta ALERT_TO_NUMBER");
  return twilioClient.messages.create({ from, to, body });
}

// --------- Hora España ---------
function nowInTz() {
  return new Date(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(new Date())
  );
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

// --------- Web ---------
app.get("/", (_, res) => res.send("Marta 24h está viva ✅"));

app.post("/voice", (req, res) => {
  const host = req.get("host");
  const wsUrl = `wss://${escapeXml(host)}/twilio-media`;

  // IMPORTANTE: NO poner track aquí (te daba "Invalid Track configuration")
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// --------- Server + WS ---------
const server = app.listen(PORT, () => console.log("Listening on", PORT));
const wss = new WebSocketServer({ server, path: "/twilio-media" });

// --------- Instrucciones de Marta ---------
function buildInstructions({ night, part }) {
  return `
Eres "Marta", asistente de urgencias de "Reparaciones Express 24h Costa del Sol".
Hablas SIEMPRE en español neutro. Tono profesional, rápido y empático.

MUY IMPORTANTE:
- NO busques técnicos externos.
- NO recomiendes servicios "cerca de su ubicación".
- SIEMPRE: "Voy a pasar los datos al técnico de guardia..."
- Haz SOLO una pregunta por turno y espera la respuesta del cliente antes de continuar.
- Tras hacer una pregunta, NO hables más hasta que el cliente responda.
- Si el cliente no responde, espera en silencio (no repitas el saludo).
- Después de cada pregunta, quédate en silencio y NO enumeres la siguiente pregunta hasta oír respuesta.

Servicios (elige uno): fontanería, electricidad, cerrajería, persianas, electrodomésticos, pintura, mantenimiento, aire acondicionado, termo, otro.

Guion de apertura EXACTO (lo dices tal cual):
"Hola, soy Marta, el asistente de urgencias de Reparaciones Express 24h Costa del Sol. ¿En qué puedo ayudarte?"

Datos a recoger (en este orden, preguntas cortas):
1) Nombre
2) Teléfono de contacto (si es el mismo desde el que llama, confirmarlo)
3) Dirección completa (calle, número, portal/piso si aplica)
4) Zona/municipio (Costa del Sol)
5) Tipo de servicio (uno de la lista)
6) Descripción breve de la avería
7) Urgente: pregunta SOLO "¿Es urgente? Sí o no." (NO hables de riesgos)

Regla nocturna:
Si es noche (22:00-08:00 hora España), di literalmente:
"Te informo: entre las 22:00 y las 08:00 la salida para ver la avería son 70€, y después la mano de obra nocturna suele estar entre 50€ y 70€ por hora, según el trabajo.
¿Lo aceptas para enviar al técnico?"
- Si no acepta: toma nota y ofrece que llamen en horario diurno.

Cierre obligatorio (cuando ya tengas los datos):
"Perfecto. Voy a pasar el aviso al técnico de guardia de nuestra empresa ahora mismo y te llamará para confirmar disponibilidad y tiempo estimado."

Despedida (según parte del día):
- mañana: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenos días, hasta luego."
- tarde: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buenas tardes, hasta luego."
- noche: "Gracias por confiar en Reparaciones Express 24h Costa del Sol. Que tengas buena noche, hasta luego."

Contexto horario: es_noche=${night}, parte_del_dia=${part}.
`;
}

// --------- Extract + SMS formatting ---------
function safeJsonParse(text) {
  if (!text) return null;
  const t = String(text).trim();

  // 1) intento directo
  try {
    return JSON.parse(t);
  } catch {}

  // 2) busca primer bloque JSON
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {}
  }
  return null;
}

async function extractTicket({ transcript, night }) {
  const model = process.env.EXTRACT_MODEL || "gpt-4o-mini";

  const prompt = `
Extrae un PARTE de servicio desde esta conversación (en español).
Devuelve SOLO JSON válido con estas claves EXACTAS:
nombre, telefono, direccion, zona, servicio, averia, urgente, aceptoNocturno, notas.

Reglas:
- servicio debe ser uno de:
  fontanería, electricidad, cerrajería, persianas, electrodomésticos, pintura, mantenimiento, aire acondicionado, termo
- urgente: "si" o "no"
- Si night=${night} entonces aceptoNocturno debe ser "si" o "no" (si no se menciona, "no")
- Si night=${night} es false, aceptoNocturno debe ser "n-a"
- Si falta un dato: string vacío "".
- notas: cualquier detalle útil.

TRANSCRIPCIÓN:
${transcript || ""}
`;

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: prompt
      // (Sin forzar formato para evitar el error "response_format moved")
    })
  });

  const raw = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI extract failed: ${resp.status} ${raw}`);

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    // raro, pero por si acaso
    return null;
  }
  
  function getResponseText(respJson) {
    if (!respJson) return "";
    if (typeof respJson.output_text === "string" && respJson.output_text.trim()) {
      return respJson.output_text.trim();
    }
    const out = respJson.output;
    if (!Array.isArray(out)) return "";
    let acc = "";
    for (const item of out) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === "output_text" && typeof c?.text === "string") acc += c.text;
        if (c?.type === "text" && typeof c?.text === "string") acc += c.text;
      }
    }
    return acc.trim();
  }
  const out = getResponseText(json);
  return safeJsonParse(out);
}

function formatSms(t, callSid) {
  return [
    "🛠️ AVISO URGENCIA (MARTA)\n" +
    `Servicio: ${t?.servicio || "-"}\n` +
    `Nombre: ${t?.nombre || "-"}\n` +
    `Tel: ${t?.telefono || "-"}\n` +
    `Dirección: ${t?.direccion || "-"}\n` +
    `Zona: ${t?.zona || "-"}\n` +
    `Urgente: ${t?.urgente || "-"}\n` +
    `Acepto nocturno: ${t?.aceptoNocturno || "-"}\n` +
    `Avería: ${t?.averia || "-"}\n` +
    `Notas: ${t?.notas || "-"}\n` +
    callSid ? `CallSid: ${callSid}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

// --------- Main WS flow ---------
wss.on("connection", (twilioWs) => {
  const tNow = nowInTz();
  const night = isNightWindow(tNow);
  const part = dayPart(tNow);

  let callSid = "";
  let streamSid = "";
  let fromNumber = "";
  let transcript = "";
  let inAssistantText = false;

  let openaiReady = false;
  let twilioReady = false;
  let greeted = false;
  let responseInFlight = false;

  console.log("📞 Twilio WS conectado");

  const realtimeModel =
    process.env.REALTIME_MODEL || "gpt-4o-realtime-preview-2025-06-03";

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  function trySendGreeting() {
    if (greeted) return;
    if (!openaiReady) return;
    if (!twilioReady) return;
    greeted = true;

    console.log("👋 Enviando saludo de Marta");
    
    if (responseInFlight) return;

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

  openaiWs.on("open", () => {
    console.log("🟢 OpenAI realtime conectado");

    // Configura sesión (IMPORTANTE: temperature >= 0.6)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: buildInstructions({ night, part }),
          voice: process.env.REALTIME_VOICE || "alloy",
          modalities: ["audio", "text"],
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "semantic_vad" },
          input_audio_transcription: { model: "gpt-4o-mini-transcribe" },
          temperature: 0.7
        }
      })
    );

    // Marcamos listo tras configurar (lo hacemos simple)
    openaiReady = true;
    trySendGreeting();
  });

  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    
    if (msg.type === "response.created") responseInFlight = true;
    if (msg.type === "response.done") responseInFlight = false;

    // Captura transcripción del cliente (si llega)
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const t = msg.transcript || "";
      console.log("📝 TRANSCRIPT CLIENTE:", t);
      if (t) {
        transcript += `CLIENTE: ${t}\n`;
      }
    }
    
    if (msg.type === "response.output_text.delta") { ... }
    if (msg.type === "response.output_text.done") { ... }
    
    if (msg.type === "response.output_text.delta") {
      const t = msg.delta || "";
      if (!t) return;

      if (!inAssistantText) {
        transcript += "MARTA: ";
        inAssistantText = true;
      }
      transcript += t;
    }

    if (msg.type === "response.output_text.done") {
      if (inAssistantText) transcript += "\n";
      inAssistantText = false;
    }

    // Audio OpenAI -> Twilio
    if (msg.type === "response.audio.delta") {
      if (!streamSid) return;
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta }
        })
      );
    }

    // Logs de error útiles
    if (msg.type === "error") {
      console.error("❌ OpenAI error payload:", msg);
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log("🔵 OpenAI realtime cerrado", code, reason?.toString?.() || "");
    try {
      twilioWs.close();
    } catch {}
  });

  openaiWs.on("error", (e) => {
    console.error("❌ OpenAI WS error", e);
    try {
      twilioWs.close();
    } catch {}
  });

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
      fromNumber =
        data.start?.customParameters?.From ||
        data.start?.from ||
        data.start?.caller ||
        "";

      twilioReady = Boolean(streamSid);
      console.log("☎️ Twilio start", { callSid, streamSid, fromNumber });

      // IMPORTANTÍSIMO: el saludo solo cuando ya hay streamSid
      trySendGreeting();
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
      console.log("📦 TRANSCRIPT FINAL:\n", transcript);
      console.log("🛑 Twilio stop", { callSid, streamSid });

      // Si no hubo transcripción, mandamos fallback
      let smsBody = "";
      try {
        if (!transcript.trim()) {
          transcript = "SIN TRANSCRIPCIÓN: no se recibió texto del cliente/IA.\n";
        }
        const extracted = await extractTicket({ transcript, night });

        if (!extracted) {
          smsBody = [
            "🛠️ AVISO URGENCIA (MARTA)",
            "Servicio: -",
            "Nombre: -",
            "Tel: -",
            "Dirección: -",
            "Zona: -",
            "Urgente: -",
            `Acepto nocturno: ${night ? "-" : "n-a"}`,
            "Avería: -",
            `Notas: Sin transcripción (posible fallo de audio).`,
            callSid ? `CallSid: ${callSid}` : ""
          ]
            .filter(Boolean)
            .join("\n");
        } else {
          smsBody = formatSms(extracted, callSid);
        }

        await sendSms(process.env.ALERT_TO_NUMBER, smsBody);
        console.log("✅ SMS enviado");
      } catch (e) {
        console.error("❌ Error enviando SMS", e);
        // fallback de emergencia con transcript
        try {
          const fallback = [
            "🛠️ AVISO URGENCIA (MARTA)",
            "Servicio: -",
            "Nombre: -",
            "Tel: -",
            "Dirección: -",
            "Zona: -",
            "Urgente: -",
            `Acepto nocturno: ${night ? "-" : "n-a"}`,
            "Avería: -",
            `Notas: Error generando parte.`,
            callSid ? `CallSid: ${callSid}` : "",
            transcript ? `\nTRANSCRIPCIÓN:\n${transcript}` : ""
          ]
            .filter(Boolean)
            .join("\n");

          await sendSms(process.env.ALERT_TO_NUMBER, fallback);
        } catch {}
      } finally {
        try {
          openaiWs.close();
        } catch {}
      }
    }
  });

  twilioWs.on("close", () => {
    console.log("🔌 Twilio WS cerrado");
    try {
      openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (e) => {
    console.error("❌ Twilio WS error", e);
    try {
      openaiWs.close();
    } catch {}
  });
});
