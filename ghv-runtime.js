/* ghv-runtime.js
 * Gir appen det samme grensesnittet som den hadde i Claude (window.claude.use(...)),
 * men med Firebase bak: Firestore (data), Authentication (innlogging og roller),
 * Cloud Functions (Claude leser skannede ark) og Storage (bilder av originalark).
 *
 * Roller ligger i Firestore: roller/{uid} = { rolle: "admin" | "montor", navn: "..." }
 */
(function () {
  "use strict";
  const cfg = window.GHV_FIREBASE_CONFIG;
  if (!window.firebase || !cfg || !cfg.apiKey || String(cfg.apiKey).startsWith("FYLL")) {
    console.warn("Lageruttak: firebase-config.js er ikke fylt ut. Appen kjører uten lagring.");
    return; // window.claude finnes ikke -> appen viser «ingen kontakt»-banneret
  }

  firebase.initializeApp(cfg);
  const auth = firebase.auth();
  const fs = firebase.firestore();
  fs.settings({ ignoreUndefinedProperties: true, merge: true });

  // I Claude-appen fletter update() inn feltene (også i nestede objekter, f.eks. priser.items[id]).
  // Firestore sin update() erstatter hele nestede objekter, så vi bruker set(..., {merge:true}).
  firebase.firestore.DocumentReference.prototype.update = function (data) {
    return this.set(data, { merge: true });
  };

  const REGION = window.GHV_FUNCTIONS_REGION || "europe-west1";
  const storage = firebase.storage ? firebase.storage() : null;
  let rolle = null, navn = "";
  // admin = kontoret (alt). kontroll = sjekker skannede ark, sender til regnskap og ser innpriser (kan ikke endre priser).
  const erKontor = () => rolle === "admin" || rolle === "kontroll";

  /* ---------- Innlogging ---------- */
  const css = `
  #ghv-login{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;
    background:var(--band,#003478);color:var(--band-ink,#F3F5F4);font-family:var(--sans,system-ui,sans-serif)}
  #ghv-login[hidden]{display:none}
  #ghv-login form,#ghv-login .ghv-box{width:100%;max-width:340px;display:grid;gap:12px}
  #ghv-login .ghv-mark{display:flex;align-items:center;gap:10px;font-family:var(--cond,"Arial Narrow",sans-serif);
    font-weight:600;font-size:15px;letter-spacing:.02em}
  #ghv-login .ghv-mark span{width:4px;height:22px;background:var(--vis,#F1B434)}
  #ghv-login h2{margin:4px 0 8px;font-family:var(--cond,"Arial Narrow",sans-serif);font-size:34px;line-height:1.05;font-weight:700}
  #ghv-login label{display:grid;gap:4px;font-size:14px}
  #ghv-login input{font:inherit;font-size:16px;padding:11px 12px;border-radius:4px;border:1px solid rgba(255,255,255,.35);
    background:rgba(255,255,255,.08);color:inherit}
  #ghv-login input:focus{outline:3px solid var(--vis,#F1B434);outline-offset:1px}
  #ghv-login button{font:inherit;font-weight:600;font-size:16px;padding:12px;border:0;border-radius:4px;cursor:pointer;
    background:var(--vis,#F1B434);color:var(--vis-ink,#1E2932)}
  #ghv-login button.ghv-link{background:none;color:inherit;text-decoration:underline;font-weight:400;padding:4px;justify-self:start}
  #ghv-login button:focus-visible{outline:3px solid #fff;outline-offset:2px}
  #ghv-login .ghv-msg{min-height:1.4em;font-size:14px}
  #ghv-login code{font-size:13px;word-break:break-all;background:rgba(255,255,255,.1);padding:2px 4px;border-radius:3px}
  .ghv-userbar{position:fixed;z-index:60;top:calc(env(safe-area-inset-top,0px) + 8px);right:12px;display:flex;gap:10px;align-items:center;
    font-size:13px;color:var(--band-ink,#F3F5F4);background:var(--band,#003478);padding:4px 4px 4px 12px;border-radius:6px;
    box-shadow:0 2px 10px rgba(0,0,0,.25);max-width:calc(100vw - 24px)}
  .ghv-userbar span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  @media (max-width:560px){ .ghv-userbar span{display:none} .ghv-userbar{padding:4px} }
  body .ghv-userbar button{font:inherit;font-size:14px;font-weight:700;color:var(--vis-ink,#1E2932)!important;background:var(--vis,#F1B434)!important;
    border:0!important;border-radius:4px;padding:6px 14px;cursor:pointer;min-height:0;width:auto;box-shadow:none}
  body .ghv-userbar button:hover{filter:brightness(1.08)}
  body .ghv-userbar button:focus-visible{outline:2px solid var(--vis,#F1B434);outline-offset:2px}`;

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
    }
    kids.flat().forEach(c => c != null && e.append(c));
    return e;
  }
  let box, cssLagt = false;
  function leggTilCss() { if (!cssLagt) { document.head.append(el("style", {}, css)); cssLagt = true; } }
  function overlay() {
    if (box) return box;
    leggTilCss();
    box = el("div", { id: "ghv-login", role: "dialog", "aria-modal": "true", "aria-label": "Logg inn" });
    document.body.append(box);
    return box;
  }
  const whenBody = fn => document.body ? fn() : document.addEventListener("DOMContentLoaded", fn, { once: true });
  const mark = () => el("div", { class: "ghv-mark" }, el("span"), "GHV Arendal");

  function showLogin(msg) {
    whenBody(() => {
      const o = overlay(); o.hidden = false; o.textContent = "";
      const m = el("div", { class: "ghv-msg", role: "status" }, msg || "");
      const ep = el("input", { type: "email", name: "email", autocomplete: "username", required: "" });
      const pw = el("input", { type: "password", name: "password", autocomplete: "current-password", required: "" });
      const f = el("form", {
        onsubmit: async e => {
          e.preventDefault(); m.textContent = "Logger inn …";
          try { await auth.signInWithEmailAndPassword(ep.value.trim(), pw.value); }
          catch (err) { m.textContent = feilTekst(err); }
        }
      },
        mark(), el("h2", {}, "Lageruttak"),
        el("label", {}, "E-post", ep), el("label", {}, "Passord", pw),
        el("button", { type: "submit" }, "Logg inn"),
        el("button", {
          type: "button", class: "ghv-link", onclick: async () => {
            if (!ep.value.trim()) { m.textContent = "Skriv inn e-postadressen først."; ep.focus(); return; }
            try { await auth.sendPasswordResetEmail(ep.value.trim()); m.textContent = "Vi har sendt en lenke for nytt passord til " + ep.value.trim() + "."; }
            catch (err) { m.textContent = feilTekst(err); }
          }
        }, "Glemt passordet?"),
        m);
      o.append(f); ep.focus();
    });
  }
  function showNoAccess(u) {
    whenBody(() => {
      const o = overlay(); o.hidden = false; o.textContent = "";
      o.append(el("div", { class: "ghv-box" }, mark(), el("h2", {}, "Ingen tilgang ennå"),
        el("p", {}, `Du er logget inn som ${u.email}, men kontoen har ikke fått en rolle i appen. Be kontoret legge deg til.`),
        el("p", {}, "Bruker-ID (kontoret trenger denne): ", el("code", {}, u.uid)),
        el("button", { type: "button", onclick: () => auth.signOut().then(() => location.reload()) }, "Logg ut")));
    });
  }
  function hideLogin() { if (box) box.hidden = true; }
  function userBar(u) {
    whenBody(() => {
      leggTilCss();
      if (document.querySelector(".ghv-userbar")) return;
      document.body.append(el("div", { class: "ghv-userbar" },
        el("span", {}, `Innlogget som ${navn || u.email}${rolle === "admin" ? " (kontor)" : rolle === "kontroll" ? " (kontroll)" : ""}.`),
        el("button", { type: "button", onclick: () => auth.signOut().then(() => location.reload()) }, "Logg ut")));
    });
  }
  function feilTekst(err) {
    const c = (err && err.code) || "";
    if (/invalid-credential|wrong-password|user-not-found|invalid-email/.test(c)) return "Feil e-post eller passord.";
    if (/too-many-requests/.test(c)) return "For mange forsøk. Vent litt og prøv igjen.";
    if (/network/.test(c)) return "Ingen nettforbindelse.";
    if (/referer|referrer|api-key|unauthorized-domain/i.test(c + " " + ((err && err.message) || ""))) return "Innlogging er ikke tillatt fra denne adressen ennå (" + c + "). Vent noen minutter og prøv igjen.";
    return "Det gikk ikke (" + (c || "ukjent feil") + "). Prøv igjen.";
  }

  const ready = new Promise(resolve => {
    auth.onAuthStateChanged(async u => {
      if (!u) { showLogin(); return; }
      try {
        const s = await fs.collection("roller").doc(u.uid).get();
        rolle = s.exists ? s.data().rolle : null; navn = s.exists ? (s.data().navn || "") : "";
      } catch { rolle = null; }
      if (!["admin", "kontroll", "montor"].includes(rolle)) { showNoAccess(u); return; }
      window.ghvRolle = rolle;
      hideLogin(); userBar(u); resolve(u);
    });
  });

  /* ---------- Hjelpere ---------- */
  const feil = (code, msg) => Object.assign(new Error(msg || code), { code });
  const blobB64 = b => new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(b);
  });
  // Claude tar bilder opptil 5 MB; skannede sider skaleres ned og blir JPEG ved behov.
  async function bildeForClaude(blob) {
    const ok = /^image\/(png|jpeg|gif|webp)$/.test(blob.type);
    if (ok && blob.size < 3.5e6) return { type: blob.type, data: await blobB64(blob) };
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    const j = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
    return { type: "image/jpeg", data: await blobB64(j) };
  }
  function lastNed(filename, data) {
    const ext = (filename.split(".").pop() || "").toLowerCase();
    const types = { csv: "text/csv;charset=utf-8", pdf: "application/pdf", zip: "application/zip", json: "application/json" };
    const blob = data instanceof Blob ? data : new Blob([data], { type: types[ext] || "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /* ---------- Det appen ber om ---------- */
  const tjenester = {
    async db() { await ready; return fs; },
    async user() {
      await ready;
      return {
        id: async () => auth.currentUser && auth.currentUser.uid,
        canEdit: async () => erKontor(),
        can: async p => p === "data.write" ? ["admin", "kontroll", "montor"].includes(rolle) : true
      };
    },
    async downloads() { return { save: async ({ filename, data }) => lastNed(filename, data) }; },
    async sample() {
      await ready; if (!erKontor()) return null;
      const call = firebase.app().functions(REGION).httpsCallable("lesArk", { timeout: 180000 });
      return {
        async json(prompt, opts) {
          const { images = [], signal } = opts || {};
          if (signal && signal.aborted) throw feil("cancelled");
          const imgs = await Promise.all(images.map(bildeForClaude));
          const avbryt = new Promise((_, rej) => signal && signal.addEventListener("abort", () => rej(feil("cancelled")), { once: true }));
          try {
            const r = await Promise.race([call({ prompt, images: imgs }), avbryt]);
            return r.data.json;
          } catch (e) {
            if (e && e.code === "cancelled") throw e;
            const c = (e && e.code) || "";
            if (/resource-exhausted/.test(c)) throw feil("rate_limited", e.message);
            if (/permission-denied|unauthenticated/.test(c)) throw feil("not_granted", e.message);
            throw feil("error", e && e.message);
          }
        }
      };
    },
    async assets() {
      await ready; if (!storage || !erKontor()) return null;
      const ref = id => storage.ref("skann/" + String(id).replace(/[^\w-]/g, ""));
      return {
        async upload(blob) {
          const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^\w]/g, "");
          await ref(id).put(blob, { contentType: blob.type || "image/jpeg" });
          return { id };
        },
        delete: id => ref(id).delete(),
        url: id => ref(id).getDownloadURL()
      };
    }
  };
  // Henter en fil fra innboksen (e-postvedlegg lagret av skyfunksjonen «innboks»). Bare kontoret.
  window.ghvHentFil = async sti => {
    await ready;
    if (!storage || !erKontor()) throw feil("not_granted");
    const url = await storage.ref(String(sti)).getDownloadURL();
    const r = await fetch(url);
    if (!r.ok) throw feil("error", "HTTP " + r.status);
    return r.blob();
  };
  // Sender IO-PDF til fakturamottak via skyfunksjonen «sendIO». Bare kontoret.
  window.ghvSendIO = async ({ filnavn, emne, tekst, pdf }) => {
    await ready;
    if (!erKontor()) throw feil("not_granted");
    const call = firebase.app().functions(REGION).httpsCallable("sendIO", { timeout: 60000 });
    const r = await call({ filnavn, emne, tekst, pdf: await blobB64(pdf) });
    return r.data;
  };
  window.ghvBildeUrl = async id => { const a = await tjenester.assets(); if (!a) throw feil("not_granted"); return a.url(id); };
  window.claude = {
    use(navn) { const f = tjenester[navn]; return f ? f() : Promise.resolve(null); }
  };
})();
