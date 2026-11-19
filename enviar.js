// Sin Novedad · Avisos al móvil (se ejecuta en GitHub Actions cada ~10 minutos).
// 1) Avisa a quien pidió un cambio cuando se lo aceptan o rechazan, y a quien recibe una petición nueva.
// 2) Entre las 21:00 y las 22:59 (hora de España), avisa a quien tiene guardia o imaginaria MAÑANA (una vez al día).
const admin = require("firebase-admin");
const FRASES = require("./frases.json");
const ADMIN_EMAIL = "eric.romrub1996@gmail.com";

const sa = JSON.parse(process.env.FIREBASE_SA || "{}");
if (!sa.project_id) { console.error("Falta el secreto FIREBASE_SA"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const prueba = (process.env.PRUEBA || "").toLowerCase().startsWith("s");

const fmt = (d, o) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", ...o }).format(d);
const frase = () => FRASES[Math.floor(Math.random() * FRASES.length)];
const msg = (token, title, body) => ({ token, notification: { title, body }, webpush: { fcmOptions: { link: "/" } } });

const fechaCorta = (k) => { const [y, m, d] = String(k || "").split("-"); return d ? `${Number(d)}/${Number(m)}` : ""; };
const servicio = (t) => (t === "I" ? "imaginaria" : "guardia");

async function tokensDe(nombre) {
  const q = await db.collection("push").where("nombre", "==", nombre).get();
  return q.docs.filter((d) => d.data().token).map((d) => ({ token: d.data().token, ref: d.ref }));
}
async function enviarA(nombre, title, body) {
  const ts = await tokensDe(nombre);
  if (!ts.length) return 0;
  const r = await admin.messaging().sendEach(ts.map((t) => msg(t.token, title, body)));
  await Promise.all(r.responses.map((x, i) => !x.success && x.error && /registration-token-not-registered|invalid-registration-token/.test(x.error.code) ? ts[i].ref.delete() : null));
  return r.successCount;
}

// Respuestas y peticiones de cambio de los últimos 2 días que aún no se han avisado.
async function avisosCambios(ahora) {
  const desde = new Date(ahora.getTime() - 2 * 864e5).toISOString();
  let n = 0;
  const resp = await db.collection("cambios").where("resuelto", ">=", desde).get();
  for (const doc of resp.docs) {
    const c = doc.data();
    if (c.avisadoResp || !["aceptado", "rechazado"].includes(c.estado)) continue;
    const dia = c.diaSolicitante || c.diaOtro, t = c.diaSolicitante ? c.tipoSolicitante : c.tipoOtro;
    const quien = c.porAdmin && c.estado === "aceptado" ? "El administrador" : c.otro;
    n += c.estado === "aceptado"
      ? await enviarA(c.solicita, "Cambio aceptado ✅", `${quien} ha aceptado tu cambio de la ${servicio(t)} del ${fechaCorta(dia)}. ¡Sin novedad!`)
      : await enviarA(c.solicita, "Cambio rechazado ❌", `${c.otro} ha rechazado tu cambio de la ${servicio(t)} del ${fechaCorta(dia)}.`);
    await doc.ref.update({ avisadoResp: true });
  }
  const nuevas = await db.collection("cambios").where("creado", ">=", desde).get();
  for (const doc of nuevas.docs) {
    const c = doc.data();
    if (c.avisadoPend || c.estado !== "pendiente") continue;
    const dia = c.diaOtro || c.diaSolicitante, t = c.diaOtro ? c.tipoOtro : c.tipoSolicitante;
    n += await enviarA(c.otro, "Te piden un cambio 🔄", `${c.solicita} te pide un cambio por tu ${servicio(t)} del ${fechaCorta(dia)}. Entra en la app para aceptarlo o rechazarlo.`);
    await doc.ref.update({ avisadoPend: true });
  }
  console.log(`✔ Avisos de cambios enviados: ${n}`);
}

async function main() {
  if (prueba) {
    const ap = await db.collection("aprobados").where("email", "==", ADMIN_EMAIL).get();
    if (ap.empty) throw new Error("No encuentro tu cuenta de administrador en 'aprobados'.");
    const p = await db.doc("push/" + ap.docs[0].id).get();
    if (!p.exists) throw new Error("Primero pulsa 'Activar avisos' en la app de tu móvil.");
    await admin.messaging().send(msg(p.data().token, "🪖 Mañana tienes guardia (prueba)", frase()));
    console.log("✔ Aviso de prueba enviado a", ADMIN_EMAIL);
    return;
  }
  const ahora = new Date();
  await avisosCambios(ahora);
  const hora = Number(fmt(ahora, { hour: "2-digit", hour12: false }));
  if (hora < 21 || hora > 22) { console.log("Recordatorio de la víspera: fuera de hora en España (" + hora + "h)."); return; }
  const hoy = fmt(ahora, { year: "numeric", month: "2-digit", day: "2-digit" });
  const d = new Date(hoy + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
  const k = d.toISOString().slice(0, 10);
  const marca = db.doc("avisosEnviados/" + k);
  if ((await marca.get()).exists) { console.log("Los avisos para", k, "ya se enviaron."); return; }
  const g = await db.doc("guardias/" + k).get();
  if (!g.exists) { console.log("No hay cuadrante para", k); await marca.set({ enviados: 0, fecha: ahora.toISOString() }); return; }
  const s = g.data().s || {};
  const push = await db.collection("push").get();
  const mensajes = [], refs = [];
  for (const doc of push.docs) {
    const p = doc.data(), t = p && p.token && s[p.nombre];
    if (t === "G") mensajes.push(msg(p.token, "🪖 Mañana tienes guardia", frase()));
    else if (t === "I") mensajes.push(msg(p.token, "🌙 Mañana tienes imaginaria", "Que no se te olvide: mañana te toca imaginaria. ¡Sin novedad! 🫡"));
    else continue;
    refs.push(doc.ref);
  }
  let ok = 0;
  if (mensajes.length) {
    const r = await admin.messaging().sendEach(mensajes);
    ok = r.successCount;
    await Promise.all(r.responses.map((x, i) => !x.success && x.error && /registration-token-not-registered|invalid-registration-token/.test(x.error.code) ? refs[i].delete() : null));
  }
  await marca.set({ enviados: ok, fecha: ahora.toISOString() });
  console.log(`✔ ${k}: ${ok} avisos enviados de ${mensajes.length}.`);
}
main().catch((e) => { console.error("Error:", e.message || e); process.exit(1); });
