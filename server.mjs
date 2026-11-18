import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hasGoogleSheetsDatabase, readSheetStore, updateSheetStore } from "./lib/google-sheets-store.mjs";

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.resolve(".");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const OSLO_TZ = "Europe/Oslo";
const PWA_PREFIX = "/pwa";
const FINE_THRESHOLD_POINTS = 20;
const MONTHLY_FINE_KR = 20;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const sseClients = new Map();
let writeQueue = Promise.resolve();

function createSlug(value) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getPersonName(person) {
  return cleanText(person?.name);
}

function getTeamName(person) {
  return cleanText(person?.team) || "Uten team";
}

function getPersonIdentity(person) {
  return `${getTeamName(person).toLowerCase()}\u0000${getPersonName(person).toLowerCase()}`;
}

function normalizePersonInput(value, knownTeams) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const team = cleanText(value.team);
    const name = cleanText(value.name);
    return team && name ? { team, name } : null;
  }

  const line = cleanText(value);
  if (!line) {
    return null;
  }

  const separatorIndex = line.includes("|") ? line.indexOf("|") : line.indexOf(":");
  if (separatorIndex >= 0) {
    const team = line.slice(0, separatorIndex).trim();
    const name = line.slice(separatorIndex + 1).trim();
    return team && name ? { team, name } : null;
  }

  const team = [...knownTeams]
    .sort((left, right) => right.length - left.length)
    .find((candidate) => line.toLowerCase().startsWith(`${candidate.toLowerCase()} `));

  if (!team) {
    return null;
  }

  const name = line.slice(team.length).trim();
  return name ? { team, name } : null;
}

function getDateParts(dateLike) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: OSLO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(dateLike));
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: lookup.year,
    month: lookup.month,
    day: lookup.day,
  };
}

function getDateKey(dateLike) {
  const { year, month, day } = getDateParts(dateLike);
  return `${year}-${month}-${day}`;
}

function getMonthKey(dateLike) {
  const { year, month } = getDateParts(dateLike);
  return `${year}-${month}`;
}

function isValidMonthKey(value) {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    return false;
  }
  return true;
}

function getWeekStartKey(dateLike) {
  const dateKey = getDateKey(dateLike);
  const pivot = new Date(`${dateKey}T12:00:00Z`);
  const weekday = pivot.getUTCDay() || 7;
  pivot.setUTCDate(pivot.getUTCDate() - weekday + 1);
  return pivot.toISOString().slice(0, 10);
}

function formatStamp(dateLike) {
  return new Intl.DateTimeFormat("nb-NO", {
    timeZone: OSLO_TZ,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(dateLike));
}

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.access(STORE_PATH);
}

async function readLocalStore() {
  await ensureStore();
  const raw = await fs.readFile(STORE_PATH, "utf8");
  return normalizeStore(JSON.parse(raw));
}

async function readSeedStore() {
  const raw = await fs.readFile(STORE_PATH, "utf8");
  return normalizeStore(JSON.parse(raw));
}

async function writeLocalStore(nextStore) {
  const payload = {
    ...normalizeStore(nextStore),
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${STORE_PATH}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, STORE_PATH);
  return payload;
}

function normalizeStore(store) {
  const { prizeContributions: _legacyPrizeContributions, finePayments, ...rest } = store;
  return {
    ...rest,
    finePayments: Array.isArray(finePayments) ? finePayments : [],
  };
}

async function readStore() {
  if (hasGoogleSheetsDatabase()) {
    // Registreringene i fanen "entries" er fasiten, sa en eier trygt kan slette
    // en rad direkte i regnearket.
    return normalizeStore(await readSheetStore(readSeedStore));
  }

  return readLocalStore();
}

async function updateStore(mutator) {
  if (hasGoogleSheetsDatabase()) {
    return normalizeStore(
      await updateSheetStore(mutator, { readSeedStore, scoreEntries: computeScoredEntries }),
    );
  }

  writeQueue = writeQueue.catch(() => undefined).then(async () => {
    const currentStore = await readLocalStore();
    const nextStore = await mutator(currentStore);
    return writeLocalStore(nextStore);
  });
  return writeQueue;
}

function computeScoredEntries(store) {
  const taskById = new Map(store.tasks.map((task) => [task.id, task]));
  const personById = new Map(store.people.map((person) => [person.id, person]));
  const usage = new Map();

  return [...store.entries]
    .filter((entry) => taskById.has(entry.taskId) && personById.has(entry.personId))
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))
    .map((entry) => {
      const task = taskById.get(entry.taskId);
      const person = personById.get(entry.personId);
      const dateKey = getDateKey(entry.createdAt);
      const monthKey = getMonthKey(entry.createdAt);
      const weekKey = getWeekStartKey(entry.createdAt);
      const usageKey = `${entry.personId}:${entry.taskId}:${dateKey}`;
      const alreadyUsed = usage.get(usageKey) || 0;
      const approvedQuantity = Math.max(0, Math.min(1, task.dailyMax - alreadyUsed));
      usage.set(usageKey, alreadyUsed + approvedQuantity);

      return {
        ...entry,
        personName: getPersonName(person),
        teamName: getTeamName(person),
        taskLabel: task.label,
        taskPoints: task.points,
        dateKey,
        monthKey,
        weekKey,
        approvedQuantity,
        awardedPoints: approvedQuantity * task.points,
        wasCapped: approvedQuantity === 0,
      };
    });
}

function buildLeaderboard(store, scoredEntries, periodKey, periodType) {
  const rows = store.people.map((person) => ({
    personId: person.id,
    name: getPersonName(person),
    points: 0,
    activeDays: new Set(),
    taskTypes: new Set(),
    totalSubmissions: 0,
  }));
  const rowByPersonId = new Map(rows.map((row) => [row.personId, row]));

  for (const entry of scoredEntries) {
    const matchesPeriod =
      periodType === "month" ? entry.monthKey === periodKey : entry.weekKey === periodKey;
    if (!matchesPeriod) {
      continue;
    }
    const row = rowByPersonId.get(entry.personId);
    row.totalSubmissions += 1;
    if (entry.awardedPoints > 0) {
      row.points += entry.awardedPoints;
      row.activeDays.add(entry.dateKey);
      row.taskTypes.add(entry.taskId);
    }
  }

  return rows
    .map((row) => ({
      name: row.name,
      personId: row.personId,
      points: row.points,
      activeDays: row.activeDays.size,
      taskTypes: row.taskTypes.size,
      totalSubmissions: row.totalSubmissions,
    }))
    .sort((left, right) => {
      if (right.points !== left.points) return right.points - left.points;
      if (right.activeDays !== left.activeDays) return right.activeDays - left.activeDays;
      if (right.taskTypes !== left.taskTypes) return right.taskTypes - left.taskTypes;
      return left.name.localeCompare(right.name, "nb");
    })
    .map((row, index) => ({
      ...row,
      place: index + 1,
      isLeading: index === 0 && row.points > 0,
    }));
}

function buildTeamLeaderboard(store, scoredEntries, monthKey) {
  const rowsByTeam = new Map();

  for (const person of store.people) {
    const team = getTeamName(person);
    if (!rowsByTeam.has(team)) {
      rowsByTeam.set(team, {
        name: team,
        totalPoints: 0,
        memberCount: 0,
        activeDays: new Set(),
        taskTypes: new Set(),
        contributors: new Set(),
      });
    }
    rowsByTeam.get(team).memberCount += 1;
  }

  for (const entry of scoredEntries) {
    if (entry.monthKey !== monthKey) {
      continue;
    }

    const row = rowsByTeam.get(entry.teamName);
    if (!row || entry.awardedPoints <= 0) {
      continue;
    }

    row.totalPoints += entry.awardedPoints;
    row.activeDays.add(entry.dateKey);
    row.taskTypes.add(entry.taskId);
    row.contributors.add(entry.personId);
  }

  return [...rowsByTeam.values()]
    .map((row) => {
      const averagePoints = row.totalPoints / row.memberCount;
      return {
        name: row.name,
        points: averagePoints,
        averagePoints,
        totalPoints: row.totalPoints,
        memberCount: row.memberCount,
        activeDays: row.activeDays.size,
        taskTypes: row.taskTypes.size,
        contributors: row.contributors.size,
      };
    })
    .sort((left, right) => {
      if (right.averagePoints !== left.averagePoints) {
        return right.averagePoints - left.averagePoints;
      }
      if (right.totalPoints !== left.totalPoints) return right.totalPoints - left.totalPoints;
      if (right.activeDays !== left.activeDays) return right.activeDays - left.activeDays;
      if (right.taskTypes !== left.taskTypes) return right.taskTypes - left.taskTypes;
      return left.name.localeCompare(right.name, "nb");
    })
    .map((row, index) => ({
      ...row,
      place: index + 1,
      isLeading: index === 0 && row.averagePoints > 0,
    }));
}

function buildFinePayments(store) {
  const personById = new Map(store.people.map((person) => [person.id, person]));
  const seen = new Set();
  const payments = Array.isArray(store.finePayments) ? store.finePayments : [];

  return payments
    .filter((payment) => {
      const key = payment.personId + ":" + payment.monthKey;
      if (!personById.has(payment.personId) || !isValidMonthKey(payment.monthKey) || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map((payment) => ({
      id: payment.id,
      personId: payment.personId,
      personName: getPersonName(personById.get(payment.personId)),
      monthKey: payment.monthKey,
      createdAt: payment.createdAt,
    }))
    .sort((left, right) => {
      if (right.monthKey !== left.monthKey) return right.monthKey.localeCompare(left.monthKey);
      return left.personName.localeCompare(right.personName, "nb");
    });
}

function buildFineOverview(store, scoredEntries, payments, currentMonthKey) {
  const monthKeys = new Set([currentMonthKey]);
  const paymentByPersonAndMonth = new Map();

  for (const entry of scoredEntries) {
    monthKeys.add(entry.monthKey);
  }

  for (const payment of payments) {
    monthKeys.add(payment.monthKey);
    paymentByPersonAndMonth.set(payment.personId + ":" + payment.monthKey, payment);
  }

  const months = [...monthKeys].filter(isValidMonthKey).sort((left, right) => right.localeCompare(left));
  const byMonth = Object.fromEntries(
    months.map((fineMonthKey) => {
      const fines = buildLeaderboard(store, scoredEntries, fineMonthKey, "month")
        .filter((row) => row.points < FINE_THRESHOLD_POINTS)
        .map((row) => {
          const payment = paymentByPersonAndMonth.get(row.personId + ":" + fineMonthKey);
          return {
            personId: row.personId,
            personName: row.name,
            points: row.points,
            amountKr: MONTHLY_FINE_KR,
            paid: Boolean(payment),
            paidAt: payment?.createdAt || null,
          };
        });

      return [fineMonthKey, fines];
    }),
  );

  return {
    currentMonthKey,
    thresholdPoints: FINE_THRESHOLD_POINTS,
    amountKr: MONTHLY_FINE_KR,
    months,
    byMonth,
  };
}

function computeState(store) {
  const now = new Date();
  const todayKey = getDateKey(now);
  const monthKey = getMonthKey(now);
  const weekKey = getWeekStartKey(now);
  const scoredEntries = computeScoredEntries(store);
  const monthlyLeaderboard = buildLeaderboard(store, scoredEntries, monthKey, "month");
  const weeklyLeaderboard = buildLeaderboard(store, scoredEntries, weekKey, "week");
  const teamLeaderboard = buildTeamLeaderboard(store, scoredEntries, monthKey);
  const finePayments = buildFinePayments(store);
  const fineOverview = buildFineOverview(store, scoredEntries, finePayments, monthKey);
  const recentEntries = [...scoredEntries]
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, 12)
    .map((entry) => ({
      id: entry.id,
      personName: entry.personName,
      taskLabel: entry.taskLabel,
      awardedPoints: entry.awardedPoints,
      createdAt: entry.createdAt,
      stamp: formatStamp(entry.createdAt),
      status: entry.wasCapped ? "Daglig tak nådd" : `+${entry.awardedPoints} poeng`,
    }));

  const leader = monthlyLeaderboard[0];
  const teamLeader = teamLeaderboard[0];
  const totalPointsThisMonth = monthlyLeaderboard.reduce((sum, row) => sum + row.points, 0);
  const totalActionsToday = scoredEntries.filter((entry) => entry.dateKey === todayKey).length;

  return {
    config: {
      officeName: store.officeName,
      monthlyPrizeKr: store.monthlyPrizeKr,
      people: store.people,
      tasks: store.tasks,
    },
    meta: {
      todayKey,
      monthKey,
      weekKey,
      liveUpdatedAt: new Date().toISOString(),
      liveUpdateMode: process.env.VERCEL ? "polling" : "sse",
    },
    summary: {
      leaderName: leader && leader.points > 0 ? leader.name : "Ingen har tatt ledelsen ennå",
      leaderPoints: leader ? leader.points : 0,
      teamLeaderName:
        teamLeader && teamLeader.averagePoints > 0
          ? teamLeader.name
          : "Ingen selskaper har tatt ledelsen ennå",
      teamLeaderPoints: teamLeader ? teamLeader.points : 0,
      totalPointsThisMonth,
      totalActionsToday,
    },
    leaderboards: {
      individual: monthlyLeaderboard,
      teams: teamLeaderboard,
      monthly: monthlyLeaderboard,
      weekly: weeklyLeaderboard,
    },
    recentEntries,
    fineOverview,
  };
}

async function broadcastState() {
  if (sseClients.size === 0) {
    return;
  }
  const state = computeState(await readStore());
  const payload = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const res of sseClients.values()) {
    res.write(payload);
  }
}

async function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

async function servePwaDocument(res) {
  const source = await fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const pwaHead = `    <base href="${PWA_PREFIX}/" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="Grensen 18" />
    <link rel="manifest" href="manifest.webmanifest" />
    <link rel="apple-touch-icon" href="icons/office-challenge-192.png" />`;
  const document = source.replace("    <!-- pwa-head -->", pwaHead);

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(document);
}

async function parseJsonBody(req) {
  const chunks = [];
  let totalLength = 0;

  for await (const chunk of req) {
    totalLength += chunk.length;
    if (totalLength > 1024 * 1024) {
      throw new Error("Body too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/pwa-view") {
    return servePwaDocument(res);
  }

  if (req.method === "GET" && pathname === "/api/state") {
    return sendJson(res, 200, computeState(await readStore()));
  }

  if (req.method === "POST" && pathname === "/api/entries") {
    const body = await parseJsonBody(req);
    const personId = typeof body.personId === "string" ? body.personId : "";
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    const note = typeof body.note === "string" ? body.note.trim().slice(0, 140) : "";

    const nextStore = await updateStore((store) => {
      if (!store.people.some((person) => person.id === personId)) {
        throw new Error("Unknown person");
      }
      if (!store.tasks.some((task) => task.id === taskId)) {
        throw new Error("Unknown task");
      }

      store.entries.push({
        id: randomUUID(),
        personId,
        taskId,
        note,
        createdAt: new Date().toISOString(),
      });

      return store;
    });

    await broadcastState();
    return sendJson(res, 201, {
      ok: true,
      state: computeState(nextStore),
    });
  }

  if (req.method === "PUT" && pathname === "/api/config") {
    const body = await parseJsonBody(req);
    const officeName = typeof body.officeName === "string" ? body.officeName.trim() : "";
    const monthlyPrizeKr = Number(body.monthlyPrizeKr || 0);
    const peopleInput = Array.isArray(body.people) ? body.people : [];

    if (!officeName || peopleInput.length === 0 || monthlyPrizeKr <= 0) {
      throw new Error("Missing config values");
    }

    const nextStore = await updateStore((store) => {
      const knownTeams = new Set(store.people.map(getTeamName).filter((team) => team !== "Uten team"));
      const cleanedPeople = peopleInput.map((person) => normalizePersonInput(person, knownTeams));

      if (cleanedPeople.some((person) => !person)) {
        throw new Error("Each person needs both a team and a name");
      }

      const existingByIdentity = new Map();
      for (const person of store.people) {
        const identity = getPersonIdentity(person);
        const matches = existingByIdentity.get(identity) || [];
        matches.push(person);
        existingByIdentity.set(identity, matches);
      }

      const usedIds = new Set();
      const nextPeople = cleanedPeople.map((person, index) => {
        const matches = existingByIdentity.get(getPersonIdentity(person)) || [];
        const existing = matches.find((candidate) => !usedIds.has(candidate.id));
        let id = existing?.id || `${createSlug(`${person.team}-${person.name}`)}-${index + 1}`;
        let suffix = 2;
        while (usedIds.has(id)) {
          id = `${createSlug(`${person.team}-${person.name}`)}-${index + 1}-${suffix}`;
          suffix += 1;
        }
        usedIds.add(id);
        return { id, name: person.name, team: person.team };
      });

      return {
        ...store,
        officeName,
        monthlyPrizeKr,
        people: nextPeople,
      };
    });

    await broadcastState();
    return sendJson(res, 200, {
      ok: true,
      state: computeState(nextStore),
    });
  }

  if (req.method === "GET" && pathname === "/api/events") {
    if (process.env.VERCEL) {
      return sendJson(res, 204, {});
    }

    const clientId = randomUUID();
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write("\n");
    sseClients.set(clientId, res);
    res.write(`event: state\ndata: ${JSON.stringify(computeState(await readStore()))}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(clientId);
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "Not found" });
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const resolvedPath = path.resolve(path.join(PUBLIC_DIR, `.${safePath}`));

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(resolvedPath);
  const contentType = contentTypes[ext] || "application/octet-stream";
  const file = await fs.readFile(resolvedPath);
  const headers = { "Content-Type": contentType };
  if (safePath === "/service-worker.js") {
    headers["Cache-Control"] = "no-cache";
  }
  res.writeHead(200, headers);
  res.end(file);
}

export async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (process.env.VERCEL && url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }

    if (url.pathname === PWA_PREFIX) {
      res.writeHead(308, { Location: `${PWA_PREFIX}/` });
      res.end();
      return;
    }

    if (url.pathname.startsWith(`${PWA_PREFIX}/api/`)) {
      await handleApi(req, res, url.pathname.slice(PWA_PREFIX.length));
      return;
    }

    if (url.pathname === `${PWA_PREFIX}/` || url.pathname === `${PWA_PREFIX}/index.html`) {
      await servePwaDocument(res);
      return;
    }

    if (url.pathname.startsWith(`${PWA_PREFIX}/`)) {
      await serveStatic(res, url.pathname.slice(PWA_PREFIX.length));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    const statusCode = error.code === "ENOENT" ? 404 : 400;
    await sendJson(res, statusCode, {
      error: error.message || "Unexpected error",
    });
  }
}

if (!process.env.VERCEL) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Kontorchallenge app listening on http://localhost:${PORT}`);
  });
}
