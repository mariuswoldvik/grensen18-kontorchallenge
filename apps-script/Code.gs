// Grensen 18 kontorchallenge - backend i Google Apps Script.
//
// Scriptet distribueres som nettapp ("Utfor som: meg", "Tilgang: alle").
// Det kjorer med eierens tilgang til regnearket, sa ingen nokler trengs i koden.
// SHEET_ID er ikke hemmelig: regnearket er bare tilgjengelig for de det er delt med.
//
// GET  ?action=state                       -> hele app-tilstanden
// POST {"action":"entry","personId","taskId","note"}
// POST {"action":"config","officeName","monthlyPrizeKr","people":[{team,name}]}

const SHEET_ID = "1Yx6E-KXxlKcm9HrZyCzyMZ2uUkR1xTcsjr-l5tQUR_k";
const OSLO_TZ = "Europe/Oslo";
const FINE_THRESHOLD_POINTS = 20;
const MONTHLY_FINE_KR = 20;
const SHEETS = {
  config: "config",
  people: "people",
  tasks: "tasks",
  entries: "entries",
  finePayments: "fine_payments",
};

// ---------- HTTP ----------

function doGet(e) {
  return handle_(() => {
    const action = (e && e.parameter && e.parameter.action) || "state";
    if (action !== "state") {
      throw new Error("Unknown action");
    }
    return computeState_(readStore_());
  });
}

function doPost(e) {
  return handle_(() => {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (body.action === "entry") {
      return { ok: true, state: computeState_(addEntry_(body)) };
    }
    if (body.action === "config") {
      return { ok: true, state: computeState_(saveConfig_(body)) };
    }
    throw new Error("Unknown action");
  });
}

function handle_(fn) {
  let payload;
  try {
    payload = fn();
  } catch (error) {
    payload = { error: (error && error.message) || "Unexpected error" };
  }
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

// ---------- Lagring i regnearket ----------

function spreadsheet_() {
  // Bundet script bruker sitt eget regneark; frittstaende script bruker SHEET_ID.
  return SpreadsheetApp.getActive() || SpreadsheetApp.openById(SHEET_ID);
}

function sheet_(name) {
  const sheet = spreadsheet_().getSheetByName(name);
  if (!sheet) {
    throw new Error("Mangler fanen " + name);
  }
  return sheet;
}

function rows_(name, width) {
  const sheet = sheet_(name);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }
  return sheet
    .getRange(2, 1, lastRow - 1, width)
    .getValues()
    .filter((row) => text_(row[0]));
}

function text_(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value === undefined || value === null ? "" : String(value).trim();
}

function number_(value, fallback) {
  const parsed = Number(value);
  return isFinite(parsed) && text_(value) !== "" ? parsed : fallback;
}

function iso_(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const date = new Date(text_(value));
  return isNaN(date.getTime()) ? text_(value) : date.toISOString();
}

function monthText_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, OSLO_TZ, "yyyy-MM");
  }
  return text_(value);
}

function readStore_() {
  const config = {};
  rows_(SHEETS.config, 2).forEach((row) => {
    config[text_(row[0])] = row[1];
  });

  return {
    officeName: text_(config.officeName),
    monthlyPrizeKr: number_(config.monthlyPrizeKr, 0),
    people: rows_(SHEETS.people, 3).map((row) => ({
      id: text_(row[0]),
      name: text_(row[1]),
      team: text_(row[2]),
    })),
    tasks: rows_(SHEETS.tasks, 4).map((row) => ({
      id: text_(row[0]),
      label: text_(row[1]),
      points: number_(row[2], 0),
      dailyMax: number_(row[3], 1),
    })),
    entries: rows_(SHEETS.entries, 10).map((row) => ({
      id: text_(row[0]),
      personId: text_(row[1]),
      taskId: text_(row[4]),
      note: text_(row[8]),
      createdAt: iso_(row[9]),
    })),
    finePayments: rows_(SHEETS.finePayments, 4).map((row) => ({
      id: text_(row[0]),
      personId: text_(row[1]),
      monthKey: monthText_(row[2]),
      createdAt: iso_(row[3]),
    })),
  };
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function addEntry_(body) {
  const personId = typeof body.personId === "string" ? body.personId : "";
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 140) : "";

  return withLock_(() => {
    const store = readStore_();
    if (!store.people.some((person) => person.id === personId)) {
      throw new Error("Unknown person");
    }
    if (!store.tasks.some((task) => task.id === taskId)) {
      throw new Error("Unknown task");
    }

    const entry = {
      id: Utilities.getUuid(),
      personId: personId,
      taskId: taskId,
      note: note,
      createdAt: new Date().toISOString(),
    };
    store.entries.push(entry);

    const scored = computeScoredEntries_(store).find((candidate) => candidate.id === entry.id);
    const sheet = sheet_(SHEETS.entries);
    const row = sheet.getLastRow() + 1;
    const range = sheet.getRange(row, 1, 1, 10);
    // Tekstformat hindrer at Sheets gjor ID-er og tidsstempler om til tall/datoer.
    range.setNumberFormats([["@", "@", "@", "@", "@", "@", "0", "0", "@", "@"]]);
    range.setValues([
      [
        entry.id,
        entry.personId,
        scored.personName || "Ukjent",
        scored.teamName || "Uten team",
        entry.taskId,
        scored.taskLabel,
        scored.taskPoints,
        scored.awardedPoints,
        entry.note,
        entry.createdAt,
      ],
    ]);
    SpreadsheetApp.flush();
    return store;
  });
}

function saveConfig_(body) {
  const officeName = typeof body.officeName === "string" ? body.officeName.trim() : "";
  const monthlyPrizeKr = Number(body.monthlyPrizeKr || 0);
  const peopleInput = Array.isArray(body.people) ? body.people : [];

  if (!officeName || peopleInput.length === 0 || !(monthlyPrizeKr > 0)) {
    throw new Error("Missing config values");
  }

  return withLock_(() => {
    const store = readStore_();
    const knownTeams = store.people.map(getTeamName_).filter((team) => team !== "Uten team");
    const cleanedPeople = peopleInput.map((person) => normalizePersonInput_(person, knownTeams));
    if (cleanedPeople.some((person) => !person)) {
      throw new Error("Each person needs both a team and a name");
    }

    const existingByIdentity = {};
    store.people.forEach((person) => {
      const identity = getPersonIdentity_(person);
      (existingByIdentity[identity] = existingByIdentity[identity] || []).push(person);
    });

    const usedIds = {};
    const nextPeople = cleanedPeople.map((person, index) => {
      const matches = existingByIdentity[getPersonIdentity_(person)] || [];
      const existing = matches.find((candidate) => !usedIds[candidate.id]);
      const base = createSlug_(person.team + "-" + person.name) + "-" + (index + 1);
      let id = existing ? existing.id : base;
      let suffix = 2;
      while (usedIds[id]) {
        id = base + "-" + suffix;
        suffix += 1;
      }
      usedIds[id] = true;
      return { id: id, name: person.name, team: person.team };
    });

    const configSheet = sheet_(SHEETS.config);
    configSheet.getRange(2, 1, 2, 2).setValues([
      ["officeName", officeName],
      ["monthlyPrizeKr", monthlyPrizeKr],
    ]);

    const peopleSheet = sheet_(SHEETS.people);
    const oldCount = Math.max(peopleSheet.getLastRow() - 1, 0);
    const peopleRange = peopleSheet.getRange(2, 1, nextPeople.length, 3);
    peopleRange.setNumberFormat("@");
    peopleRange.setValues(nextPeople.map((person) => [person.id, person.name, person.team]));
    if (oldCount > nextPeople.length) {
      peopleSheet.getRange(nextPeople.length + 2, 1, oldCount - nextPeople.length, 3).clearContent();
    }
    SpreadsheetApp.flush();

    store.officeName = officeName;
    store.monthlyPrizeKr = monthlyPrizeKr;
    store.people = nextPeople;
    return store;
  });
}

// ---------- Hjelpefunksjoner ----------

function createSlug_(value) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function cleanText_(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getPersonName_(person) {
  return cleanText_(person && person.name);
}

function getTeamName_(person) {
  return cleanText_(person && person.team) || "Uten team";
}

function getPersonIdentity_(person) {
  return getTeamName_(person).toLowerCase() + "\u0000" + getPersonName_(person).toLowerCase();
}

function normalizePersonInput_(value, knownTeams) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const team = cleanText_(value.team);
    const name = cleanText_(value.name);
    return team && name ? { team: team, name: name } : null;
  }

  const line = cleanText_(value);
  if (!line) {
    return null;
  }

  const separatorIndex = line.indexOf("|") >= 0 ? line.indexOf("|") : line.indexOf(":");
  if (separatorIndex >= 0) {
    const team = line.slice(0, separatorIndex).trim();
    const name = line.slice(separatorIndex + 1).trim();
    return team && name ? { team: team, name: name } : null;
  }

  const team = knownTeams
    .slice()
    .sort((left, right) => right.length - left.length)
    .find((candidate) => line.toLowerCase().indexOf(candidate.toLowerCase() + " ") === 0);
  if (!team) {
    return null;
  }
  const name = line.slice(team.length).trim();
  return name ? { team: team, name: name } : null;
}

function getDateKey_(dateLike) {
  return Utilities.formatDate(new Date(dateLike), OSLO_TZ, "yyyy-MM-dd");
}

function getMonthKey_(dateLike) {
  return Utilities.formatDate(new Date(dateLike), OSLO_TZ, "yyyy-MM");
}

function isValidMonthKey_(value) {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function getWeekStartKey_(dateLike) {
  const pivot = new Date(getDateKey_(dateLike) + "T12:00:00Z");
  const weekday = pivot.getUTCDay() || 7;
  pivot.setUTCDate(pivot.getUTCDate() - weekday + 1);
  return pivot.toISOString().slice(0, 10);
}

function formatStamp_(dateLike) {
  return Utilities.formatDate(new Date(dateLike), OSLO_TZ, "dd.MM, HH:mm");
}

function compareNames_(left, right) {
  return left.localeCompare(right, "nb");
}

// ---------- Poeng og oversikter (samme regler som for) ----------

function computeScoredEntries_(store) {
  const taskById = {};
  store.tasks.forEach((task) => (taskById[task.id] = task));
  const personById = {};
  store.people.forEach((person) => (personById[person.id] = person));
  const usage = {};

  return store.entries
    .filter((entry) => taskById[entry.taskId] && personById[entry.personId])
    .slice()
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))
    .map((entry) => {
      const task = taskById[entry.taskId];
      const person = personById[entry.personId];
      const dateKey = getDateKey_(entry.createdAt);
      const usageKey = entry.personId + ":" + entry.taskId + ":" + dateKey;
      const alreadyUsed = usage[usageKey] || 0;
      const approvedQuantity = Math.max(0, Math.min(1, task.dailyMax - alreadyUsed));
      usage[usageKey] = alreadyUsed + approvedQuantity;

      return Object.assign({}, entry, {
        personName: getPersonName_(person),
        teamName: getTeamName_(person),
        taskLabel: task.label,
        taskPoints: task.points,
        dateKey: dateKey,
        monthKey: getMonthKey_(entry.createdAt),
        weekKey: getWeekStartKey_(entry.createdAt),
        approvedQuantity: approvedQuantity,
        awardedPoints: approvedQuantity * task.points,
        wasCapped: approvedQuantity === 0,
      });
    });
}

function buildLeaderboard_(store, scoredEntries, periodKey, periodType) {
  const rows = store.people.map((person) => ({
    personId: person.id,
    name: getPersonName_(person),
    points: 0,
    activeDays: {},
    taskTypes: {},
    totalSubmissions: 0,
  }));
  const rowByPersonId = {};
  rows.forEach((row) => (rowByPersonId[row.personId] = row));

  scoredEntries.forEach((entry) => {
    const matches = periodType === "month" ? entry.monthKey === periodKey : entry.weekKey === periodKey;
    if (!matches) {
      return;
    }
    const row = rowByPersonId[entry.personId];
    row.totalSubmissions += 1;
    if (entry.awardedPoints > 0) {
      row.points += entry.awardedPoints;
      row.activeDays[entry.dateKey] = true;
      row.taskTypes[entry.taskId] = true;
    }
  });

  return rows
    .map((row) => ({
      name: row.name,
      personId: row.personId,
      points: row.points,
      activeDays: Object.keys(row.activeDays).length,
      taskTypes: Object.keys(row.taskTypes).length,
      totalSubmissions: row.totalSubmissions,
    }))
    .sort((left, right) => {
      if (right.points !== left.points) return right.points - left.points;
      if (right.activeDays !== left.activeDays) return right.activeDays - left.activeDays;
      if (right.taskTypes !== left.taskTypes) return right.taskTypes - left.taskTypes;
      return compareNames_(left.name, right.name);
    })
    .map((row, index) => Object.assign(row, { place: index + 1, isLeading: index === 0 && row.points > 0 }));
}

function buildTeamLeaderboard_(store, scoredEntries, monthKey) {
  const rowsByTeam = {};
  store.people.forEach((person) => {
    const team = getTeamName_(person);
    if (!rowsByTeam[team]) {
      rowsByTeam[team] = { name: team, totalPoints: 0, memberCount: 0, activeDays: {}, taskTypes: {}, contributors: {} };
    }
    rowsByTeam[team].memberCount += 1;
  });

  scoredEntries.forEach((entry) => {
    const row = rowsByTeam[entry.teamName];
    if (entry.monthKey !== monthKey || !row || entry.awardedPoints <= 0) {
      return;
    }
    row.totalPoints += entry.awardedPoints;
    row.activeDays[entry.dateKey] = true;
    row.taskTypes[entry.taskId] = true;
    row.contributors[entry.personId] = true;
  });

  return Object.keys(rowsByTeam)
    .map((team) => {
      const row = rowsByTeam[team];
      const averagePoints = row.totalPoints / row.memberCount;
      return {
        name: row.name,
        points: averagePoints,
        averagePoints: averagePoints,
        totalPoints: row.totalPoints,
        memberCount: row.memberCount,
        activeDays: Object.keys(row.activeDays).length,
        taskTypes: Object.keys(row.taskTypes).length,
        contributors: Object.keys(row.contributors).length,
      };
    })
    .sort((left, right) => {
      if (right.averagePoints !== left.averagePoints) return right.averagePoints - left.averagePoints;
      if (right.totalPoints !== left.totalPoints) return right.totalPoints - left.totalPoints;
      if (right.activeDays !== left.activeDays) return right.activeDays - left.activeDays;
      if (right.taskTypes !== left.taskTypes) return right.taskTypes - left.taskTypes;
      return compareNames_(left.name, right.name);
    })
    .map((row, index) => Object.assign(row, { place: index + 1, isLeading: index === 0 && row.averagePoints > 0 }));
}

function buildFinePayments_(store) {
  const personById = {};
  store.people.forEach((person) => (personById[person.id] = person));
  const seen = {};

  return store.finePayments
    .filter((payment) => {
      const key = payment.personId + ":" + payment.monthKey;
      if (!personById[payment.personId] || !isValidMonthKey_(payment.monthKey) || seen[key]) {
        return false;
      }
      seen[key] = true;
      return true;
    })
    .map((payment) => ({
      id: payment.id,
      personId: payment.personId,
      personName: getPersonName_(personById[payment.personId]),
      monthKey: payment.monthKey,
      createdAt: payment.createdAt,
    }));
}

function buildFineOverview_(store, scoredEntries, payments, currentMonthKey) {
  const monthKeys = {};
  monthKeys[currentMonthKey] = true;
  const paymentByKey = {};
  scoredEntries.forEach((entry) => (monthKeys[entry.monthKey] = true));
  payments.forEach((payment) => {
    monthKeys[payment.monthKey] = true;
    paymentByKey[payment.personId + ":" + payment.monthKey] = payment;
  });

  const months = Object.keys(monthKeys)
    .filter(isValidMonthKey_)
    .sort((left, right) => right.localeCompare(left));
  const byMonth = {};
  months.forEach((monthKey) => {
    byMonth[monthKey] = buildLeaderboard_(store, scoredEntries, monthKey, "month")
      .filter((row) => row.points < FINE_THRESHOLD_POINTS)
      .map((row) => {
        const payment = paymentByKey[row.personId + ":" + monthKey];
        return {
          personId: row.personId,
          personName: row.name,
          points: row.points,
          amountKr: MONTHLY_FINE_KR,
          paid: Boolean(payment),
          paidAt: payment ? payment.createdAt : null,
        };
      });
  });

  return {
    currentMonthKey: currentMonthKey,
    thresholdPoints: FINE_THRESHOLD_POINTS,
    amountKr: MONTHLY_FINE_KR,
    months: months,
    byMonth: byMonth,
  };
}

function computeState_(store) {
  const now = new Date();
  const todayKey = getDateKey_(now);
  const monthKey = getMonthKey_(now);
  const weekKey = getWeekStartKey_(now);
  const scoredEntries = computeScoredEntries_(store);
  const monthly = buildLeaderboard_(store, scoredEntries, monthKey, "month");
  const weekly = buildLeaderboard_(store, scoredEntries, weekKey, "week");
  const teams = buildTeamLeaderboard_(store, scoredEntries, monthKey);
  const fineOverview = buildFineOverview_(store, scoredEntries, buildFinePayments_(store), monthKey);
  const recentEntries = scoredEntries
    .slice()
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, 12)
    .map((entry) => ({
      id: entry.id,
      personName: entry.personName,
      taskLabel: entry.taskLabel,
      awardedPoints: entry.awardedPoints,
      createdAt: entry.createdAt,
      stamp: formatStamp_(entry.createdAt),
      status: entry.wasCapped ? "Daglig tak n\u00e5dd" : "+" + entry.awardedPoints + " poeng",
    }));

  const leader = monthly[0];
  const teamLeader = teams[0];

  return {
    config: {
      officeName: store.officeName,
      monthlyPrizeKr: store.monthlyPrizeKr,
      people: store.people,
      tasks: store.tasks,
    },
    meta: {
      todayKey: todayKey,
      monthKey: monthKey,
      weekKey: weekKey,
      liveUpdatedAt: now.toISOString(),
      liveUpdateMode: "polling",
    },
    summary: {
      leaderName: leader && leader.points > 0 ? leader.name : "Ingen har tatt ledelsen enn\u00e5",
      leaderPoints: leader ? leader.points : 0,
      teamLeaderName:
        teamLeader && teamLeader.averagePoints > 0 ? teamLeader.name : "Ingen selskaper har tatt ledelsen enn\u00e5",
      teamLeaderPoints: teamLeader ? teamLeader.points : 0,
      totalPointsThisMonth: monthly.reduce((sum, row) => sum + row.points, 0),
      totalActionsToday: scoredEntries.filter((entry) => entry.dateKey === todayKey).length,
    },
    leaderboards: { individual: monthly, teams: teams, monthly: monthly, weekly: weekly },
    recentEntries: recentEntries,
    fineOverview: fineOverview,
  };
}
