// Sin Novedad · Copia de seguridad semanal (GitHub Actions).
// Descarga todas las colecciones de Firestore a copia.json. El workflow lo comprime con contraseña.
const admin = require("firebase-admin");
const fs = require("fs");
const sa = JSON.parse(process.env.FIREBASE_SA || "{}");
if (!sa.project_id) { console.error("Falta el secreto FIREBASE_SA"); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const COLECCIONES = ["app", "guardias", "original", "cambios", "oficial", "libres", "aprobados", "solicitudes", "tel", "log", "comunicados"];

async function main() {
  const out = { formato: "sin-novedad-copia-v1", fecha: new Date().toISOString(), colecciones: {} };
  let total = 0;
  for (const c of COLECCIONES) {
    const q = await db.collection(c).get();
    out.colecciones[c] = {};
    q.docs.forEach((d) => { out.colecciones[c][d.id] = d.data(); });
    total += q.size;
    console.log(`${c}: ${q.size}`);
  }
  fs.writeFileSync("copia.json", JSON.stringify(out, null, 1));
  console.log(`✔ Copia hecha: ${total} documentos`);
  // 🩺 Para «Estado del sistema» en la app
  await db.doc("app/estado").set({ ultimaCopia: out.fecha, copiaDocs: total }, { merge: true }).catch((e) => console.log("Estado:", e.message || e));
}
main().catch((e) => { console.error("Error:", e.message || e); process.exit(1); });
