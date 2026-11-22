# Lageruttak – GHV Arendal

Lageruttak-appen som vanlig nettside på GitHub Pages, med Firebase (Google) som database, innlogging og bildelager. Kollegaer trenger verken Claude eller Microsoft 365, bare en innlogging i appen.

## Slik henger det sammen

| Del | Hvor | Hva |
|---|---|---|
| Selve appen | GitHub Pages | `index.html`, `ghv-runtime.js`, `firebase-config.js` |
| Data (uttak, priser, kost, bestillinger) | Firebase Firestore | Reglene i `firestore.rules` bestemmer hvem som ser hva |
| Innlogging og roller | Firebase Authentication | Rollene ligger i samlingen `roller` |
| Bilder av skannede ark | Firebase Storage | Bare kontoret har tilgang |
| Claude leser skannede ark | Firebase Cloud Functions (`functions/`) | API-nøkkelen ligger skjult på serveren |

Roller: `admin` er kontoret (ser priser og alt annet). `montor` ser registrerte uttak, men aldri priser, kostpriser eller bestillinger. Dette håndheves i databasen, ikke bare i skjermbildet.

Ingenting i dette repoet er hemmelig. Verdiene i `firebase-config.js` er laget for å være offentlige, og sikkerheten ligger i reglene. Legg aldri API-nøkler eller eksporterte data inn i repoet.

---

## Del 1: Firebase (ca. 30 minutter)

1. Gå til <https://console.firebase.google.com> og logg inn med en Google-konto (helst en firmakonto som flere kan bruke). Velg «Opprett prosjekt», gi det navnet `ghv-lageruttak`, og slå av Google Analytics.
2. Oppgrader til **Blaze**-planen (nederst til venstre, «Spark» → «Oppgrader»). Den krever et betalingskort, men bruken her ligger godt innenfor gratiskvoten. Sett et budsjettvarsel, for eksempel 100 kr i måneden, så får du e-post hvis noe er galt. Blaze trengs for skyfunksjonen og bildelageret.
3. **Firestore Database** → «Opprett database» → velg plassering `eur3 (europe)` → start i **produksjonsmodus**.
4. **Authentication** → «Kom i gang» → slå på **E-post/passord**.
5. **Storage** → «Kom i gang» → produksjonsmodus, samme region.
6. Prosjektinnstillinger (tannhjulet) → «Dine apper» → trykk på `</>` (web) → kall den `lageruttak` (ikke kryss av for Hosting). Kopier verdiene i `firebaseConfig` inn i `firebase-config.js` i stedet for `FYLL_INN`.

## Del 2: API-nøkkel til Claude (for innlesing av skannede ark)

1. Gå til <https://console.anthropic.com>, opprett en konto for firmaet og kjøp litt kreditt under «Billing».
2. «API keys» → «Create key». Kopier nøkkelen; du trenger den i del 3. Den skal ikke lagres noe annet sted.

Hver innlest side koster litt. Se prisene hos Anthropic. Du kan sette en månedsgrense i Anthropic-konsollen.

## Del 3: Legg ut regler og skyfunksjon (ca. 15 minutter)

Dette gjøres fra **Google Cloud Shell** i nettleseren, så du trenger ikke installere noe på kontor-PC-en.

1. Åpne <https://shell.cloud.google.com> med samme Google-konto.
2. Trykk på menyen med tre prikker → «Upload» og last opp zip-fila med dette prosjektet. Pakk den ut:
   ```
   unzip lageruttak-github.zip && cd lageruttak
   ```
3. Installer Firebase-verktøyet og logg inn:
   ```
   npm install -g firebase-tools
   firebase login --no-localhost
   firebase use --add
   ```
   Velg prosjektet `ghv-lageruttak` og kall aliaset `default`.
4. Legg inn API-nøkkelen som hemmelighet (lim inn nøkkelen når du blir spurt):
   ```
   firebase functions:secrets:set ANTHROPIC_API_KEY
   ```
5. Installer og legg ut alt:
   ```
   cd functions && npm install && cd ..
   firebase deploy
   ```
   Hvis du får spørsmål om å gi Storage tilgang til Firestore-roller, svar ja. Når du får spørsmål om `CLAUDE_MODEL`, trykk Enter for standard.

## Del 4: Legg appen på GitHub (ca. 10 minutter)

1. Lag en konto på <https://github.com> (eller bruk firmaets) og velg «New repository». Kall det `lageruttak`.
   Med gratis GitHub-konto må repoet være **offentlig** for at GitHub Pages skal virke. Det er greit, siden repoet ikke inneholder priser, data eller nøkler.
2. Trykk «uploading an existing file» og dra inn alle filene og mappene fra prosjektet (med utfylt `firebase-config.js`). Trykk «Commit changes».
3. Settings → **Pages** → under «Build and deployment» velger du «Deploy from a branch», gren `main` og mappe `/ (root)`. Lagre.
4. Etter et par minutter ligger appen på `https://<brukernavn>.github.io/lageruttak/`.
5. Tilbake i Firebase: **Authentication → Innstillinger → Autoriserte domener** → legg til `<brukernavn>.github.io`. Uten dette virker ikke innloggingen.

## Del 5: Brukere og roller

1. Lag deg selv som bruker: Firebase → **Authentication → Brukere → Legg til bruker** (e-post og et midlertidig passord).
2. Åpne appen og logg inn. Da står det «Ingen tilgang ennå» sammen med din **bruker-ID**. Kopier den.
3. Firebase → **Firestore** → «Start samling» → samlings-ID `roller` → dokument-ID = bruker-ID-en din → felter:
   - `rolle` (string): `admin`
   - `navn` (string): navnet ditt
4. Last appen på nytt. Nå er du inne som kontor.
5. Gjør det samme for hver montør, med `rolle` = `montor`. Montører som ikke har e-post, kan få en adresse som `fornavn@lager.ghv.no`. Den trenger ikke finnes, men da kan de ikke bruke «Glemt passordet?», og du må sette nytt passord for dem i Firebase.

## Del 6: Flytt over data fra Claude-appen

Når Firebase er klart, kan Claude hente ut dataene fra den gamle appen til en JSON-fil. Åpne så `https://<brukernavn>.github.io/lageruttak/verktoy/importer.html`, logg inn som admin, velg fila og trykk «Importer». Ikke last opp JSON-fila til GitHub.

Bilder av ark som er skannet i den gamle appen blir ikke med. Uttakene blir med, men bildet av originalarket kan bare vises for ark som skannes etter flyttingen.

## Del 7 (valgfritt): Egen adresse, f.eks. lager.ghv.no

1. Be IT legge inn en DNS-oppføring: `CNAME lager → <brukernavn>.github.io`.
2. GitHub: Settings → Pages → «Custom domain» → `lager.ghv.no` → lagre, og kryss av for «Enforce HTTPS» når det blir mulig.
3. Firebase: legg `lager.ghv.no` til under autoriserte domener.
4. Be den som drifter portal.ghv.no legge inn en lenke til appen.

---

## Test før dere tar den i bruk

- Logg inn som montør: fanene for priser, skann, bestilling og salg skal ikke vises, og ingen priser skal synes noe sted.
- Logg inn som admin: priser, uttak og «Til regnskap» skal fungere som før.
- Skann ett testark og sjekk at Claude leser det, at uttaket lagres, og at «Vis originalark» viser bildet.
- Lag en PDF til fakturamottak og sjekk at nedlasting og e-postlenken virker.
- Slett testuttaket etterpå.

## Hva er annerledes enn i Claude-appen

- Innlogging med e-post og passord, og «Logg ut» øverst.
- Lenkene «Startside» og «Kontroll av skannede IO-ark» peker fortsatt til Claude.
- Innlesing av skannede ark bruker firmaets egen API-nøkkel og koster per side.

## Oppdatere appen senere

Bytt ut `index.html` i GitHub-repoet («Add file → Upload files») med den nye versjonen. Endringer i `firestore.rules`, `storage.rules` eller `functions/` legges ut med `firebase deploy` fra Cloud Shell.

## Filer

| Fil | Innhold |
|---|---|
| `index.html` | Appen (samme som i Claude, med små tilpasninger) |
| `ghv-runtime.js` | Kobler appen til Firebase og viser innloggingen |
| `firebase-config.js` | Prosjektets Firebase-verdier (fylles ut) |
| `firestore.rules`, `storage.rules` | Hvem som kan se og endre hva |
| `functions/` | Skyfunksjonen som sender skannede ark til Claude |
| `verktoy/importer.html` | Engangsverktøy for å flytte data |
| `firebase.json` | Oppsett for `firebase deploy` |
