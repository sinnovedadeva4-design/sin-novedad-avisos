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

const movsDe = (c) => Array.isArray(c.movs) ? c.movs : [
  c.diaSolicitante && { dia: c.diaSolicitante, t: c.tipoSolicitante, sale: c.solicita, entra: c.otro },
  c.diaOtro && { dia: c.diaOtro, t: c.tipoOtro, sale: c.otro, entra: c.solicita },
  c.par && { dia: c.par.diaSolicitante, t: c.par.tipoSolicitante, sale: c.solicita, entra: c.otro },
  c.par && { dia: c.par.diaOtro, t: c.par.tipoOtro, sale: c.otro, entra: c.solicita },
  c.extra && { dia: c.extra.dia, t: c.extra.tipo, sale: c.extra.de, entra: c.extra.a },
].filter(Boolean);
const esTriple = (c) => Array.isArray(c.movs);

// Respuestas y peticiones de cambio de los últimos 2 días que aún no se han avisado.
async function avisosCambios(ahora) {
  const desde = new Date(ahora.getTime() - 2 * 864e5).toISOString();
  let n = 0;
  const resp = await db.collection("cambios").where("resuelto", ">=", desde).get();
  for (const doc of resp.docs) {
    const c = doc.data();
    if (c.avisadoResp || !["aceptado", "rechazado"].includes(c.estado)) continue;
    const m0 = movsDe(c)[0] || {}, quien = c.porAdmin && c.estado === "aceptado" ? "El administrador" : c.otro;
    if (esTriple(c)) {
      for (const p of [c.solicita, c.otro, c.tercero]) {
        n += c.estado === "aceptado"
          ? await enviarA(p, "Cambio a tres aceptado ✅", `El cambio a tres entre ${c.solicita}, ${c.otro} y ${c.tercero} ya está hecho. ¡Sin novedad!`)
          : (p === c.rechazadoPor ? 0 : await enviarA(p, "Cambio a tres rechazado ❌", `${c.rechazadoPor || "Alguien"} ha rechazado el cambio a tres.`));
      }
    } else {
      n += c.estado === "aceptado"
        ? await enviarA(c.solicita, "Cambio aceptado ✅", `${quien} ha aceptado tu cambio de la ${servicio(m0.t)} del ${fechaCorta(m0.dia)}. ¡Sin novedad!`)
        : await enviarA(c.solicita, "Cambio rechazado ❌", `${c.rechazadoPor || c.otro} ha rechazado tu cambio de la ${servicio(m0.t)} del ${fechaCorta(m0.dia)}.`);
    }
    await doc.ref.update({ avisadoResp: true });
  }
  const nuevas = await db.collection("cambios").where("creado", ">=", desde).get();
  for (const doc of nuevas.docs) {
    const c = doc.data();
    if (c.avisadoPend || c.estado !== "pendiente") continue;
    const nota = c.nota ? ` 📝 «${c.nota}»` : "";
    if (esTriple(c)) {
      for (const p of [c.otro, c.tercero]) {
        const da = movsDe(c).find((m) => m.sale === p) || {};
        n += await enviarA(p, "Te proponen un cambio a tres 🔁", `${c.solicita} propone un cambio a tres con ${p === c.otro ? c.tercero : c.otro}: tú das tu ${servicio(da.t)} del ${fechaCorta(da.dia)}. Entra para verlo.${nota}`);
      }
    } else {
      const m = movsDe(c).find((x) => x.sale === c.otro) || movsDe(c)[0] || {};
      n += await enviarA(c.otro, "Te piden un cambio 🔄", `${c.solicita} te pide un cambio por tu ${servicio(m.t)} del ${fechaCorta(m.dia)}. Entra en la app para aceptarlo o rechazarlo.${nota}`);
    }
    await doc.ref.update({ avisadoPend: true });
  }
  console.log(`✔ Avisos de cambios enviados: ${n}`);
}

// Cuando se publica un cuadrante nuevo: aviso a todos con los días que quedan hasta el 25 del mes anterior.
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
async function avisoPublicado(ahora) {
  const ref = db.doc("app/publicado"), snap = await ref.get();
  if (!snap.exists) return;
  const d = snap.data() || {}, avisados = d.avisados || [];
  const hoyK = fmt(ahora, { year: "numeric", month: "2-digit", day: "2-digit" }), cur = hoyK.slice(0, 7);
  const nuevos = (d.meses || []).filter((m) => m > cur && !avisados.includes(m)).sort();
  if (!nuevos.length) return;
  const m = nuevos[0], [y, mo] = m.split("-").map(Number);
  const lim = new Date(Date.UTC(y, mo - 2, 25)).toISOString().slice(0, 10);
  const dias = Math.round((Date.parse(lim) - Date.parse(hoyK)) / 864e5);
  const mesN = MESES[mo - 1], limN = MESES[(mo + 10) % 12];
  const body = dias < 0 ? `Ya está colgado el cuadrante de ${mesN}. Entra en la app para verlo.`
    : dias === 0 ? `Ya está el cuadrante de ${mesN}. Hoy, 25 de ${limN}, es el último día para pedir cambios.`
    : `Ya está el cuadrante de ${mesN}. Tenéis hasta el 25 de ${limN} para pedir cambios: os quedan ${dias} día${dias > 1 ? "s" : ""}.`;
  const q = await db.collection("push").get();
  const nombres = [...new Set(q.docs.map((x) => (x.data() || {}).nombre).filter(Boolean))];
  let n = 0;
  for (const p of nombres) n += await enviarA(p, `📅 Cuadrante de ${mesN} publicado`, body);
  await ref.update({ avisados: [...avisados, ...nuevos] });
  console.log(`✔ Aviso de cuadrante publicado (${nuevos.join(", ")}): ${n}`);
}

// Comunicados nuevos del mando: aviso a todos (una vez por comunicado).
async function avisoComunicados(ahora) {
  const desde = new Date(ahora.getTime() - 2 * 864e5).toISOString();
  const q = await db.collection("comunicados").where("fecha", ">=", desde).get();
  const nuevos = q.docs.filter((d) => !(d.data() || {}).avisado);
  if (!nuevos.length) return;
  const push = await db.collection("push").get();
  const nombres = [...new Set(push.docs.map((x) => (x.data() || {}).nombre).filter(Boolean))];
  let n = 0;
  for (const d of nuevos) {
    const c = d.data(), txt = String(c.texto || "");
    for (const p of nombres) n += await enviarA(p, "📢 Comunicado", txt.length > 180 ? txt.slice(0, 177) + "…" : txt);
    await d.ref.update({ avisado: true });
  }
  console.log(`✔ Comunicados avisados: ${nuevos.length} (${n} envíos)`);
}

// Día 24 (desde las 10:00): "mañana se cierran los cambios" a todos, si ya está colgado el cuadrante del mes siguiente.
async function avisoCierre(ahora) {
  const hoyK = fmt(ahora, { year: "numeric", month: "2-digit", day: "2-digit" });
  const hora = Number(fmt(ahora, { hour: "2-digit", hour12: false }));
  if (hoyK.slice(8) !== "24" || hora < 10) return;
  const [y, m] = hoyK.split("-").map(Number), sig = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, "0")}`;
  const ref = db.doc("avisosCierre/" + sig);
  if ((await ref.get()).exists) return;
  const hay = await db.collection("guardias").where(admin.firestore.FieldPath.documentId(), ">=", sig + "-01").limit(1).get();
  if (hay.empty || !hay.docs[0].id.startsWith(sig)) { console.log("Día 24: aún no hay cuadrante de", sig); return; }
  const mesN = MESES[Number(sig.slice(5)) - 1], actN = MESES[m - 1];
  const push = await db.collection("push").get();
  const nombres = [...new Set(push.docs.map((x) => (x.data() || {}).nombre).filter(Boolean))];
  let n = 0;
  for (const p of nombres) n += await enviarA(p, "⏰ Mañana se cierran los cambios", `Mañana, 25 de ${actN}, es el último día para pedir cambios del cuadrante de ${mesN}.`);
  await ref.set({ fecha: ahora.toISOString(), enviados: n });
  console.log(`✔ Aviso de cierre (${sig}): ${n}`);
}

// Avisa al administrador si alguien queda con servicio el día que sale de guardia (una vez por fallo).
async function avisosFallos(ahora) {
  const hoyK = fmt(ahora, { year: "numeric", month: "2-digit", day: "2-digit" });
  const q = await db.collection("guardias").where(admin.firestore.FieldPath.documentId(), ">=", hoyK).get();
  const g = {}; q.docs.forEach((d) => { g[d.id] = (d.data() || {}).s || {}; });
  const prev = (k) => { const d = new Date(k + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
  const ap = await db.collection("aprobados").where("email", "==", ADMIN_EMAIL).get();
  if (ap.empty) return;
  const yo = ap.docs[0].data().nombre;
  let n = 0;
  for (const [k, s] of Object.entries(g)) {
    const ant = g[prev(k)];
    if (!ant) continue;
    for (const [p, t] of Object.entries(s)) {
      if (!["G", "I", "I/E"].includes(t) || ant[p] !== "G") continue;
      const id = `${k}_${p}`.replace(/[^\w-]/g, "_"), ref = db.doc("fallosAvisados/" + id);
      if ((await ref.get()).exists) continue;
      n += await enviarA(yo, "⚠️ Fallo en el cuadrante", `${p} sale de guardia el ${fechaCorta(k)} y tiene ${t === "G" ? "guardia" : "imaginaria"} ese día. Revísalo en la app.`);
      await ref.set({ fecha: ahora.toISOString() });
    }
  }
  if (n) console.log(`✔ Avisos de fallos al administrador: ${n}`);
}

const FRASES_I = [
  "Que no se te olvide: mañana te toca imaginaria. ¡Sin novedad! 🫡",
  "Mañana imaginaria: móvil con batería y el uniforme a mano 🔋",
  "Imaginaria mañana: duerme bien hoy 😴",
  "Mañana te toca estar disponible: nada de planes lejos 📍",
  "Imaginaria a la vista: déjalo todo preparado esta noche 🎒",
  "Mañana imaginaria. Que no suene el teléfono… pero si suena, estás listo 📞",
];

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
  await avisosFallos(ahora).catch((e) => console.error("Fallos:", e.message || e));
  await avisoPublicado(ahora).catch((e) => console.error("Publicado:", e.message || e));
  await avisoComunicados(ahora).catch((e) => console.error("Comunicados:", e.message || e));
  await avisoCierre(ahora).catch((e) => console.error("Cierre:", e.message || e));
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
    else if (t && /(^|\/)I($|\/)|^I\//.test(t)) mensajes.push(msg(p.token, "🌙 Mañana tienes imaginaria", FRASES_I[Math.floor(Math.random() * FRASES_I.length)]));
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
