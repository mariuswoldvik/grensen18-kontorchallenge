# Grensen 18 kontorchallenge

PWA som registrerer kontoroppgaver, viser individuelt leaderboard og
teamleaderboard, og holder oversikt over månedsbøter.

- **Nettside:** GitHub Pages, fra mappen `docs/`
  → https://mariuswoldvik.github.io/grensen18-kontorchallenge/
- **Database:** et Google-regneark (skjema i `database/google-sheets-schema.md`)
- **Backend:** Google Apps Script (`apps-script/Code.gs`) distribuert som nettapp

Det finnes ingen hemmelige nøkler. Apps Script kjører med eierens tilgang til
regnearket, og nettsiden snakker bare med Apps Script-adressen i `docs/config.js`.

## Innhold

- `docs/` - PWA-en: `index.html`, `app.js`, `config.js`, CSS, manifest, service worker og ikoner.
- `apps-script/Code.gs` - API, poengberegning, leaderboard og bøter.
- `apps-script/appsscript.json` - manifest for Apps Script-prosjektet.
- `database/google-sheets-schema.md` - fanene og kolonnene regnearket må ha.

## Sett opp på nytt

1. **Regneark:** lag fanene i `database/google-sheets-schema.md` og fyll inn
   `config`, `people` og `tasks`.
2. **Apps Script:** gå til script.google.com, lag et nytt prosjekt og lim inn
   `apps-script/Code.gs`. Sett `SHEET_ID` øverst til ID-en fra regnearkets URL.
3. **Distribuer:** Implementer → Ny implementering → Nettapp, med
   *Utfør som: meg* og *Hvem har tilgang: Alle*. Godkjenn tilgangen.
4. **Koble til:** lim inn nettapp-URL-en (slutter på `/exec`) i `docs/config.js`.
5. **GitHub Pages:** Settings → Pages → *Deploy from a branch*, `main`, mappe `/docs`.

Etter en endring i `Code.gs` må du lage en ny versjon: Implementer →
Administrer implementeringer → rediger → *Ny versjon*. Da beholdes samme URL.

## Daglig bruk

- Endre deltakere og kontornavn i appen eller direkte i regnearket.
- Feilregistreringer slettes ved å slette raden i `entries`.
- Betalte bøter føres i `fine_payments`.

Alle som har adressen til appen kan registrere poeng og endre deltakerlisten,
på samme måte som i foos-ligaen.

## Test lokalt

Åpne `docs/` med en hvilken som helst statisk server, for eksempel:

```bash
python3 -m http.server --directory docs 8000
```
