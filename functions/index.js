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
