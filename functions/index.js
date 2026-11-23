/* Skyfunksjon «lesArk»: tar imot et skannet ark fra appen og lar Claude lese det.
 * API-nøkkelen ligger som hemmelighet i Firebase og kommer aldri ut til nettleseren.
 * Bare innloggede brukere med rolle "admin" eller "kontroll" får bruke den.
 */
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret, defineString } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = defineString("CLAUDE_MODEL", { default: "claude-sonnet-5-5" });
const INNBOKS_TOKEN = defineSecret("INNBOKS_TOKEN");
const POSTMARK_TOKEN = defineSecret("POSTMARK_TOKEN");
const AVSENDER = defineString("AVSENDER", { default: "tcm@ghv.no" });

const TYPER = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

exports.lesArk = onCall(
  { region: "europe-west1", secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180, memory: "512MiB", maxInstances: 5 },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Logg inn først.");
    const r = await admin.firestore().doc(`roller/${req.auth.uid}`).get();
    if (!r.exists || !["admin", "kontroll"].includes(r.data().rolle)) {
      throw new HttpsError("permission-denied", "Bare kontoret kan lese inn skannede ark.");
    }

    const { prompt, images } = req.data || {};
    if (typeof prompt !== "string" || !prompt || prompt.length > 300000) {
      throw new HttpsError("invalid-argument", "Mangler tekst til Claude.");
    }
    const bilder = Array.isArray(images) ? images.slice(0, 4) : [];
    for (const b of bilder) {
      if (!b || !TYPER.has(b.type) || typeof b.data !== "string") {
        throw new HttpsError("invalid-argument", "Ugyldig bilde.");
      }
    }

    const content = [
      ...bilder.map((b) => ({ type: "image", source: { type: "base64", media_type: b.type, data: b.data } })),
      { type: "text", text: prompt },
    ];

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY.value(),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: CLAUDE_MODEL.value(), max_tokens: 8000, messages: [{ role: "user", content }] }),
    });

    if (res.status === 429 || res.status === 529) {
      throw new HttpsError("resource-exhausted", "Claude er opptatt. Prøv igjen om litt.");
    }
    if (!res.ok) {
      console.error("Anthropic svarte", res.status, await res.text());
      throw new HttpsError("internal", "Claude svarte ikke som forventet.");
    }

    const svar = await res.json();
    const tekst = (svar.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const renset = tekst.replace(/```json|```/g, "");
    const start = renset.indexOf("{"), slutt = renset.lastIndexOf("}");
    try {
      return { json: JSON.parse(renset.slice(start, slutt + 1)) };
    } catch {
      console.error("Kunne ikke tolke svaret som JSON:", tekst.slice(0, 2000));
      throw new HttpsError("internal", "Svaret fra Claude kunne ikke tolkes.");
    }
  }
);

/* Skyfunksjon «innboks»: tar imot e-post fra Postmark (inbound webhook).
 * Kopimaskinen sender skannede ark til Postmark-adressen, Postmark sender e-posten hit,
 * og vedleggene (PDF/JPG/PNG) lagres i Storage under innboks/ med en oppføring i Firestore.
 * Kontoret ser dem i appen under «Skann» → «Innboks fra e-post».
 * Webhook-adressen må ha ?token=<INNBOKS_TOKEN> på slutten, ellers avvises forespørselen.
 */
const crypto = require("crypto");
const GODTATT = /^(application\/pdf|image\/jpeg|image\/png)$/i;

exports.innboks = onRequest(
  { region: "europe-west1", secrets: [INNBOKS_TOKEN], timeoutSeconds: 60, memory: "512MiB", maxInstances: 3 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Bare POST"); return; }
    const gitt = String(req.query.token || "");
    const riktig = INNBOKS_TOKEN.value();
    const ok = gitt.length === riktig.length && crypto.timingSafeEqual(Buffer.from(gitt), Buffer.from(riktig));
    if (!ok) { res.status(403).send("Ugyldig token"); return; }

    const mail = req.body || {};
    const fra = (mail.FromFull && mail.FromFull.Email) || mail.From || "";
    const emne = String(mail.Subject || "").slice(0, 200);
    const vedlegg = Array.isArray(mail.Attachments) ? mail.Attachments : [];
    const bucket = admin.storage().bucket();
    const db = admin.firestore();
    const mottatt = new Date().toISOString();
    let lagret = 0;

    for (const v of vedlegg) {
      const navn = String(v.Name || "skann.pdf");
      let type = String(v.ContentType || "").split(";")[0].trim();
      if (!GODTATT.test(type) && /\.pdf$/i.test(navn)) type = "application/pdf";
      if (!GODTATT.test(type) || !v.Content) continue;
      const id = db.collection("innboks").doc().id;
      const trygt = navn.replace(/[^\wæøåÆØÅ.\-]+/g, "_").slice(0, 120);
      const sti = `innboks/${id}-${trygt}`;
      await bucket.file(sti).save(Buffer.from(v.Content, "base64"), { contentType: type, resumable: false });
      await db.collection("innboks").doc(id).set({ fil: navn, sti, type, fra, emne, mottatt, status: "ny" });
      lagret++;
    }
    console.log(`Innboks: ${lagret} vedlegg lagret fra ${fra}`);
    res.status(200).json({ lagret });
  }
);

/* Skyfunksjon «sendIO»: sender IO-PDF fra «Til regnskap» rett til fakturamottak via Postmark.
 * Mottakeren er fast (fakturamottak@ghv.no) og kan ikke endres fra appen.
 * Bare innloggede med rolle "admin" eller "kontroll" får sende.
 */
const FAKTURAMOTTAK = "fakturamottak@ghv.no";
exports.sendIO = onCall(
  { region: "europe-west1", secrets: [POSTMARK_TOKEN], timeoutSeconds: 60, memory: "256MiB", maxInstances: 3 },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Logg inn først.");
    const r = await admin.firestore().doc(`roller/${req.auth.uid}`).get();
    if (!r.exists || !["admin", "kontroll"].includes(r.data().rolle)) {
      throw new HttpsError("permission-denied", "Bare kontoret kan sende til fakturamottak.");
    }
    const { filnavn, emne, tekst, pdf } = req.data || {};
    if (typeof pdf !== "string" || !pdf || pdf.length > 14000000) throw new HttpsError("invalid-argument", "Mangler PDF.");
    const navn = String(filnavn || "IO.pdf").replace(/[^\wæøåÆØÅ.\-]+/g, "_").slice(0, 120);
    const res = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": POSTMARK_TOKEN.value() },
      body: JSON.stringify({
        From: AVSENDER.value(), To: FAKTURAMOTTAK,
        Subject: String(emne || navn).slice(0, 200),
        TextBody: String(tekst || `Vedlagt: ${navn}`).slice(0, 5000),
        Attachments: [{ Name: navn, Content: pdf, ContentType: "application/pdf" }],
        MessageStream: "outbound",
      }),
    });
    const svar = await res.json().catch(() => ({}));
    if (!res.ok || svar.ErrorCode) {
      console.error("Postmark svarte", res.status, JSON.stringify(svar));
      throw new HttpsError("failed-precondition", svar.Message || "E-posten ble ikke sendt.");
    }
    await admin.firestore().collection("sendt").add({ til: FAKTURAMOTTAK, emne: String(emne || ""), filnavn: navn, av: req.auth.uid, tid: new Date().toISOString(), messageId: svar.MessageID || "" });
    return { messageId: svar.MessageID || "", til: FAKTURAMOTTAK };
  }
);

/* Skyfunksjon «giTilgang»: admin gir en person tilgang med e-post, navn, rolle og (for nye) et midlertidig passord.
 * Finnes kontoen fra før, brukes den. Ellers opprettes den. Rollen skrives til roller/{uid}.
 */
const ROLLER = ["admin", "kontroll", "montor"];
exports.giTilgang = onCall(
  { region: "europe-west1", timeoutSeconds: 30, memory: "256MiB", maxInstances: 2 },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Logg inn først.");
    const meg = await admin.firestore().doc(`roller/${req.auth.uid}`).get();
    if (!meg.exists || meg.data().rolle !== "admin") throw new HttpsError("permission-denied", "Bare admin kan gi tilgang.");
    const epost = String((req.data || {}).epost || "").trim().toLowerCase();
    const navn = String((req.data || {}).navn || "").trim().slice(0, 80);
    const rolle = String((req.data || {}).rolle || "");
    const passord = String((req.data || {}).passord || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(epost)) throw new HttpsError("invalid-argument", "E-postadressen ser ikke riktig ut.");
    if (!ROLLER.includes(rolle)) throw new HttpsError("invalid-argument", "Velg en rolle.");
    let bruker, ny = false;
    try { bruker = await admin.auth().getUserByEmail(epost); }
    catch (e) {
      if (e.code !== "auth/user-not-found") throw new HttpsError("internal", "Kunne ikke slå opp brukeren.");
      if (passord.length < 6) throw new HttpsError("invalid-argument", "Personen har ingen konto ennå. Skriv et midlertidig passord på minst 6 tegn.");
      bruker = await admin.auth().createUser({ email: epost, password: passord, displayName: navn || undefined });
      ny = true;
    }
    if (bruker.uid === req.auth.uid) throw new HttpsError("failed-precondition", "Du kan ikke endre din egen rolle her.");
    await admin.firestore().doc(`roller/${bruker.uid}`).set({ rolle, navn, epost }, { merge: true });
    return { uid: bruker.uid, ny };
  }
);
