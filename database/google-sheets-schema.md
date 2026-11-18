# Google Sheets-skjema

Regnearket har én fane per tabell. Rad 1 er kolonnenavn; data starter på rad 2.
Appen leser og skriver kolonnene i denne rekkefølgen, så ikke flytt dem.

| Fane | Kolonner | Innhold |
|---|---|---|
| `config` | `key`, `value` | `officeName` og `monthlyPrizeKr` |
| `people` | `id`, `name`, `team` | Deltakere og selskap |
| `tasks` | `id`, `label`, `points`, `dailyMax` | Oppgaver og poeng |
| `entries` | `id`, `person_id`, `person_name`, `team_name`, `task_id`, `task_label`, `task_points`, `awarded_points`, `note`, `created_at` | Én rad per registrering. Fasiten for poeng. |
| `fine_payments` | `id`, `person_id`, `month_key`, `created_at` | Betalte bøter. `month_key` er `ÅÅÅÅ-MM`. Legges inn manuelt. |

- Poeng beregnes alltid på nytt fra `entries`. `person_name`, `task_label`,
  `task_points` og `awarded_points` er bare lesbare kopier.
- Slett en feilregistrering ved å slette raden i `entries`.
- Er `config`, `people` eller `tasks` tom, fyller appen dem fra `data/store.json`.
- I `fine_payments` bør `id`, `month_key` og `created_at` være tekst
  (skriv `'2026-11` med apostrof hvis du legger inn manuelt).
