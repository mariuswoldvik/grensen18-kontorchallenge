# Grensen 18 kontorchallenge

PWA som registrerer kontoroppgaver, viser individuelt leaderboard og
teamleaderboard, og holder oversikt over månedsbøter. Data lagres i et
Google-regneark.

## Dette ligger i pakken

- `public/` - PWA-grensesnittet, JavaScript, CSS, manifest og ikoner.
- `server.mjs` - Node-server og API for registreringer og leaderboard.
- `lib/google-sheets-store.mjs` - lagring i Google Sheets (ingen eksterne avhengigheter).
- `api/[...path].mjs` - Vercel-inngangspunktet.
- `data/store.json` - startoppsett for personer, selskaper og oppgaver.
- `database/google-sheets-schema.md` - fanene og kolonnene regnearket må ha.
- `vercel.json` - PWA-ruting for Vercel.

## Miljøvariabler

| Variabel | Innhold |
|---|---|
| `GOOGLE_SHEET_ID` | ID-en fra regnearkets URL (`/spreadsheets/d/<ID>/edit`) |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | `client_email` fra tjenestekontoens JSON-nøkkel |
| `GOOGLE_PRIVATE_KEY` | `private_key` fra samme JSON-nøkkel (med `\n` for linjeskift) |

I stedet for de to siste kan `GOOGLE_SERVICE_ACCOUNT_JSON` inneholde hele
JSON-nøkkelen, rå eller base64-kodet.

Nøkkelen skal bare ligge i `.env` lokalt og i Vercel sine Environment Variables,
aldri i `public/`, Git eller nettleserkode.

## Sett opp Google Sheets

1. Opprett et regneark med fanene i `database/google-sheets-schema.md`
   (bare rad 1 med kolonnenavn trengs; appen fyller `config`, `people` og
   `tasks` fra `data/store.json` hvis de er tomme).
2. I Google Cloud Console: lag et prosjekt, slå på **Google Sheets API**, lag en
   **tjenestekonto** og last ned en JSON-nøkkel for den.
3. Del regnearket med tjenestekontoens e-post som **Redigerer**.
4. Legg verdiene inn i `.env` (se `.env.example`).

## Start lokalt

Krever Node.js 22.9 eller nyere.

```bash
cp .env.example .env   # og fyll inn verdiene
npm start
```

Appen blir tilgjengelig på `http://localhost:3000/pwa/`.

Uten miljøvariablene brukes `data/store.json` som lokal demo. Da blir dataene
ikke delt eller lagret varig.

## Tilpass utfordringen

Rediger fanene `config`, `people` og `tasks` direkte i regnearket, eller bruk
innstillingene i appen. Feilregistreringer slettes ved å slette raden i
`entries`. Betalte bøter føres i `fine_payments`.

## Publiser på Vercel

1. Importer GitHub-repoet som et nytt Vercel-prosjekt.
2. Legg `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL` og
   `GOOGLE_PRIVATE_KEY` inn under Settings → Environment Variables for
   Production.
3. Distribuer prosjektet.
4. Del PWA-visningen på `/pwa/`.
