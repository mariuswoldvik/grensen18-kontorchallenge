// Google Sheets som database for kontorchallengen.
//
// Regnearket har fem faner (se database/google-sheets-schema.md):
//   config         key | value
//   people         id | name | team
//   tasks          id | label | points | dailyMax
//   entries        id | person_id | person_name | team_name | task_id | task_label |
//                  task_points | awarded_points | note | created_at
//   fine_payments  id | person_id | month_key | created_at
//
// Autentisering skjer med en Google-tjenestekonto. Nokkelen leses kun fra
// miljovariabler og sendes aldri til nettleseren.

import { createSign } from "node:crypto";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

const RANGES = {
  config: "config!A2:B",
  people: "people!A2:C",
  tasks: "tasks!A2:D",
  entries: "entries!A2:J",
  finePayments: "fine_payments!A2:D",
};

let cachedToken = null;
let writeQueue = Promise.resolve();

function readCredentials() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  let clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  // Alternativt: hele JSON-nokkelfilen i en variabel (ra JSON eller base64).
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json && (!clientEmail || !privateKey)) {
    const text = json.trim().startsWith("{") ? json : Buffer.from(json, "base64").toString("utf8");
    const parsed = JSON.parse(text);
    clientEmail = clientEmail || parsed.client_email;
    privateKey = privateKey || parsed.private_key;
  }

  if (!spreadsheetId || !clientEmail || !privateKey) {
    return null;
  }

  return {
    spreadsheetId,
    clientEmail,
    // Vercel og .env lagrer ofte linjeskift som bokstavelig "\n".
    privateKey: privateKey.replace(/\\n/g, "\n"),
  };
}

export function hasGoogleSheetsDatabase() {
  return readCredentials() !== null;
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

async function getAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt - 60 > now) {
    return cachedToken.value;
  }

  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.privateKey, "base64url");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google auth failed: ${body.error_description || body.error || response.status}`);
  }

  cachedToken = { value: body.access_token, expiresAt: now + Number(body.expires_in || 3600) };
  return cachedToken.value;
}

async function sheetsRequest(credentials, method, suffix, body) {
  const token = await getAccessToken(credentials);
  const response = await fetch(`${SHEETS_API}/${credentials.spreadsheetId}${suffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Google Sheets ${method} failed: ${payload.error?.message || response.status}`);
  }
  return payload;
}

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIso(value) {
  const raw = text(value);
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toISOString();
}

async function readRaw(credentials) {
  const query = new URLSearchParams({ valueRenderOption: "UNFORMATTED_VALUE" });
  for (const range of Object.values(RANGES)) {
    query.append("ranges", range);
  }
  const { valueRanges = [] } = await sheetsRequest(credentials, "GET", `/values:batchGet?${query}`);
  const [config, people, tasks, entries, finePayments] = valueRanges.map((range) => range.values || []);
  return { config, people, tasks, entries, finePayments };
}

function rowsToStore(raw) {
  const config = Object.fromEntries(raw.config.filter((row) => text(row[0])).map((row) => [text(row[0]), row[1]]));

  return {
    officeName: text(config.officeName),
    monthlyPrizeKr: number(config.monthlyPrizeKr),
    people: raw.people
      .filter((row) => text(row[0]))
      .map((row) => ({ id: text(row[0]), name: text(row[1]), team: text(row[2]) })),
    tasks: raw.tasks
      .filter((row) => text(row[0]))
      .map((row) => ({
        id: text(row[0]),
        label: text(row[1]),
        points: number(row[2]),
        dailyMax: number(row[3], 1),
      })),
    entries: raw.entries
      .filter((row) => text(row[0]))
      .map((row) => ({
        id: text(row[0]),
        personId: text(row[1]),
        taskId: text(row[4]),
        note: text(row[8]),
        createdAt: toIso(row[9]),
      })),
    finePayments: raw.finePayments
      .filter((row) => text(row[0]))
      .map((row) => ({
        id: text(row[0]),
        personId: text(row[1]),
        monthKey: text(row[2]),
        createdAt: toIso(row[3]),
      })),
  };
}

function configRows(store) {
  return [
    ["officeName", store.officeName],
    ["monthlyPrizeKr", store.monthlyPrizeKr],
  ];
}

function peopleRows(store) {
  return store.people.map((person) => [person.id, person.name, person.team]);
}

function taskRows(store) {
  return store.tasks.map((task) => [task.id, task.label, task.points, task.dailyMax]);
}

async function replaceRange(credentials, sheet, lastColumn, rows) {
  const data = rows.length > 0 ? [{ range: `${sheet}!A2:${lastColumn}${rows.length + 1}`, values: rows }] : [];
  if (data.length > 0) {
    await sheetsRequest(credentials, "POST", "/values:batchUpdate", { valueInputOption: "RAW", data });
  }
  // Fjern rader som ikke lenger finnes, uten a tomme fanen underveis.
  await sheetsRequest(
    credentials,
    "POST",
    `/values/${encodeURIComponent(`${sheet}!A${rows.length + 2}:${lastColumn}`)}:clear`,
    {},
  );
}

async function appendRows(credentials, range, rows) {
  if (rows.length === 0) {
    return;
  }
  const query = new URLSearchParams({ valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" });
  await sheetsRequest(credentials, "POST", `/values/${encodeURIComponent(range)}:append?${query}`, {
    values: rows,
  });
}

async function seedIfEmpty(credentials, store, readSeedStore) {
  const missingConfig = !store.officeName || store.monthlyPrizeKr <= 0;
  const missingPeople = store.people.length === 0;
  const missingTasks = store.tasks.length === 0;
  if (!missingConfig && !missingPeople && !missingTasks) {
    return store;
  }

  const seed = await readSeedStore();
  const next = { ...store };
  if (missingConfig) {
    next.officeName = seed.officeName;
    next.monthlyPrizeKr = seed.monthlyPrizeKr;
    await replaceRange(credentials, "config", "B", configRows(next));
  }
  if (missingPeople) {
    next.people = seed.people;
    await replaceRange(credentials, "people", "C", peopleRows(next));
  }
  if (missingTasks) {
    next.tasks = seed.tasks;
    await replaceRange(credentials, "tasks", "D", taskRows(next));
  }
  return next;
}

export async function readSheetStore(readSeedStore) {
  const credentials = readCredentials();
  const store = rowsToStore(await readRaw(credentials));
  return seedIfEmpty(credentials, store, readSeedStore);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Kjorer mutator mot gjeldende data og skriver bare endringene tilbake.
// Nye registreringer legges til med append, slik at samtidige innsendinger
// fra flere serverinstanser ikke overskriver hverandre.
export function updateSheetStore(mutator, { readSeedStore, scoreEntries }) {
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const credentials = readCredentials();
      const current = await readSheetStore(readSeedStore);
      const next = await mutator(structuredClone(current));

      if (next.officeName !== current.officeName || next.monthlyPrizeKr !== current.monthlyPrizeKr) {
        await replaceRange(credentials, "config", "B", configRows(next));
      }
      if (!sameJson(next.people, current.people)) {
        await replaceRange(credentials, "people", "C", peopleRows(next));
      }
      if (!sameJson(next.tasks, current.tasks)) {
        await replaceRange(credentials, "tasks", "D", taskRows(next));
      }

      const knownEntryIds = new Set(current.entries.map((entry) => entry.id));
      const newEntryIds = new Set(next.entries.filter((entry) => !knownEntryIds.has(entry.id)).map((e) => e.id));
      const newEntryRows = scoreEntries(next)
        .filter((entry) => newEntryIds.has(entry.id))
        .map((entry) => [
          entry.id,
          entry.personId,
          entry.personName || "Ukjent",
          entry.teamName || "Uten team",
          entry.taskId,
          entry.taskLabel,
          entry.taskPoints,
          entry.awardedPoints,
          entry.note || "",
          entry.createdAt,
        ]);
      await appendRows(credentials, "entries!A1:J1", newEntryRows);

      const knownPaymentIds = new Set(current.finePayments.map((payment) => payment.id));
      const newPaymentRows = next.finePayments
        .filter((payment) => !knownPaymentIds.has(payment.id))
        .map((payment) => [payment.id, payment.personId, payment.monthKey, payment.createdAt]);
      await appendRows(credentials, "fine_payments!A1:D1", newPaymentRows);

      return { ...next, updatedAt: new Date().toISOString() };
    });

  return writeQueue;
}
