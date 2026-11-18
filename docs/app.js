// Siden kjører som PWA på GitHub Pages. Data hentes fra Apps Script-nettappen
// som er satt i config.js.
const IS_PWA_VIEW = true;
const API_URL = window.GRENSEN18_CONFIG?.apiUrl || "";
const POLL_INTERVAL_MS = 15000;

async function callApi(action, body) {
  if (!API_URL) {
    throw new Error("Mangler adressen til Apps Script i config.js");
  }

  // text/plain gjør forespørselen "enkel", slik at Apps Script godtar den uten CORS-preflight.
  const response = body
    ? await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, ...body }),
      })
    : await fetch(`${API_URL}?action=${encodeURIComponent(action)}`);
  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error || "Noe gikk galt");
  }
  return payload;
}

const state = {
  activeTab: IS_PWA_VIEW ? "registration" : "leaderboard",
  selectedPersonId: "",
  selectedTaskId: "",
  selectedFineMonth: getMonthKey(new Date()),
  config: null,
  appState: null,
};

let pollingTimer;

const elements = {
  officeName: document.querySelector("#office-name"),
  iosInstallTrigger: document.querySelector("#ios-install-trigger"),
  iosInstallDialog: document.querySelector("#ios-install-dialog"),
  iosInstallClose: document.querySelector("#ios-install-close"),
  leaderboardTab: document.querySelector("#leaderboard-tab"),
  registrationTab: document.querySelector("#registration-tab"),
  finesTab: document.querySelector("#fines-tab"),
  tabButtons: [...document.querySelectorAll(".app-tab")],
  leaderboardView: document.querySelector("#leaderboard-view"),
  registrationView: document.querySelector("#registration-view"),
  finesView: document.querySelector("#fines-view"),
  personSelect: document.querySelector("#person-select"),
  taskSelect: document.querySelector("#task-select"),
  submitButton: document.querySelector("#submit-button"),
  statusMessage: document.querySelector("#status-message"),
  fineMonthSelect: document.querySelector("#fine-month-select"),
  fineMonthLabel: document.querySelector("#fine-month-label"),
  fineList: document.querySelector("#fine-list"),
  leaderName: document.querySelector("#leader-name"),
  leaderPoints: document.querySelector("#leader-points"),
  teamLeaderName: document.querySelector("#team-leader-name"),
  teamLeaderPoints: document.querySelector("#team-leader-points"),
  actionsToday: document.querySelector("#actions-today"),
  pointsMonth: document.querySelector("#points-month"),
  individualBoard: document.querySelector("#individual-board"),
  teamBoard: document.querySelector("#team-board"),
  recentEntries: document.querySelector("#recent-entries"),
  officeInput: document.querySelector("#office-input"),
  peopleInput: document.querySelector("#people-input"),
  saveConfigButton: document.querySelector("#save-config-button"),
  configStatus: document.querySelector("#config-status"),
};

function configurePwaView() {
  document.documentElement.classList.toggle("is-pwa-view", IS_PWA_VIEW);
}

function setStatus(target, message, type = "neutral") {
  target.textContent = message;
  target.dataset.state = type;
}

function setAppState(nextState) {
  state.config = nextState.config;
  state.appState = nextState;
  render();
}

function openIosInstallDialog() {
  if (typeof elements.iosInstallDialog.showModal === "function") {
    elements.iosInstallDialog.showModal();
    return;
  }

  elements.iosInstallDialog.setAttribute("open", "");
}

function closeIosInstallDialog() {
  if (typeof elements.iosInstallDialog.close === "function") {
    elements.iosInstallDialog.close();
    return;
  }

  elements.iosInstallDialog.removeAttribute("open");
}

function getSelectedPerson() {
  return state.config?.people.find((person) => person.id === state.selectedPersonId) || null;
}

function getSelectedTask() {
  return state.config?.tasks.find((task) => task.id === state.selectedTaskId) || null;
}

function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonth(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const date = new Date(year, month - 1, 1);
  const label = new Intl.DateTimeFormat("nb-NO", {
    month: "long",
    year: "numeric",
  }).format(date);

  return label.charAt(0).toUpperCase() + label.slice(1);
}

function formatPoints(value) {
  return new Intl.NumberFormat("nb-NO", {
    maximumFractionDigits: 1,
  }).format(value);
}

function addPlaceholder(select, label) {
  const option = document.createElement("option");
  option.value = "";
  option.textContent = label;
  select.appendChild(option);
}

function renderPersonSelect() {
  elements.personSelect.replaceChildren();
  addPlaceholder(elements.personSelect, "Velg navn");

  for (const person of state.config.people) {
    const option = document.createElement("option");
    option.value = person.id;
    option.textContent = person.name;
    elements.personSelect.appendChild(option);
  }

  elements.personSelect.value = state.selectedPersonId;
}

function renderFineMonthSelect(months) {
  elements.fineMonthSelect.replaceChildren();

  for (const monthKey of months) {
    const option = document.createElement("option");
    option.value = monthKey;
    option.textContent = formatMonth(monthKey);
    elements.fineMonthSelect.appendChild(option);
  }

  elements.fineMonthSelect.value = state.selectedFineMonth;
}

function renderTaskSelect() {
  elements.taskSelect.replaceChildren();
  addPlaceholder(elements.taskSelect, "Velg oppgave");

  for (const task of state.config.tasks) {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = `${task.label} (+${task.points} poeng)`;
    elements.taskSelect.appendChild(option);
  }

  elements.taskSelect.value = state.selectedTaskId;
}

function renderBoard(target, rows, type) {
  target.replaceChildren();

  for (const row of rows) {
    const item = document.createElement("article");
    item.className = "board-row";
    if (row.place <= 3) {
      item.dataset.top = String(row.place);
    }

    const place = document.createElement("div");
    place.className = "board-place";
    place.textContent = row.place;

    const details = document.createElement("div");
    details.className = "board-person";
    const name = document.createElement("strong");
    name.textContent = row.name;
    const meta = document.createElement("span");
    meta.textContent =
      type === "team"
        ? row.memberCount + " ansatte · " + row.contributors + " bidragsytere"
        : `${row.activeDays} aktive dager · ${row.taskTypes} oppgavetyper`;
    details.append(name, meta);

    const score = document.createElement("div");
    score.className = "board-score";
    score.textContent = type === "team" ? formatPoints(row.averagePoints ?? row.points) : row.points;
    if (type === "team") {
      score.setAttribute("aria-label", formatPoints(row.averagePoints ?? row.points) + " poeng per ansatt");
    }

    item.append(place, details, score);
    target.appendChild(item);
  }
}

function renderRecentEntries() {
  elements.recentEntries.replaceChildren();

  if (!state.appState.recentEntries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "Ingen innsendinger enda.";
    elements.recentEntries.appendChild(empty);
    return;
  }

  for (const entry of state.appState.recentEntries) {
    const item = document.createElement("article");
    item.className = "recent-item";

    const details = document.createElement("div");
    const person = document.createElement("strong");
    person.textContent = entry.personName;
    const task = document.createElement("span");
    task.textContent = entry.taskLabel;
    details.append(person, task);

    const meta = document.createElement("div");
    meta.className = "recent-meta";
    const status = document.createElement("strong");
    status.textContent = entry.status;
    const stamp = document.createElement("span");
    stamp.textContent = entry.stamp;
    meta.append(status, stamp);

    item.append(details, meta);
    elements.recentEntries.appendChild(item);
  }
}

function renderSummary() {
  elements.officeName.textContent = state.config.officeName;
  elements.leaderName.textContent = state.appState.summary.leaderName;
  elements.leaderPoints.textContent = `${state.appState.summary.leaderPoints} poeng`;
  elements.teamLeaderName.textContent = state.appState.summary.teamLeaderName;
  elements.teamLeaderPoints.textContent =
    formatPoints(state.appState.summary.teamLeaderPoints) + " poeng per ansatt";
  elements.actionsToday.textContent = state.appState.summary.totalActionsToday;
  elements.pointsMonth.textContent = state.appState.summary.totalPointsThisMonth;
}

function renderRegistration() {
  if (!state.config.people.some((person) => person.id === state.selectedPersonId)) {
    state.selectedPersonId = "";
  }
  if (!state.config.tasks.some((task) => task.id === state.selectedTaskId)) {
    state.selectedTaskId = "";
  }

  renderPersonSelect();
  renderTaskSelect();
  elements.submitButton.disabled = !(getSelectedPerson() && getSelectedTask());
}

function getFinesForSelectedMonth() {
  return state.appState.fineOverview?.byMonth?.[state.selectedFineMonth] || [];
}

function renderFineOverview() {
  elements.fineList.replaceChildren();
  elements.fineMonthLabel.textContent = formatMonth(state.selectedFineMonth);

  const fines = getFinesForSelectedMonth();
  if (!fines.length) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "Ingen har bot denne måneden.";
    elements.fineList.appendChild(empty);
    return;
  }

  for (const fine of fines) {
    const item = document.createElement("article");
    item.className = "fine-row";
    item.dataset.paid = String(fine.paid);

    const details = document.createElement("div");
    details.className = "fine-details";
    const name = document.createElement("strong");
    name.textContent = fine.personName;
    const meta = document.createElement("span");
    meta.textContent = fine.points + " poeng · Bot: " + fine.amountKr + " kr";
    details.append(name, meta);

    const paymentStatus = document.createElement("span");
    paymentStatus.className = "fine-payment-status";
    paymentStatus.dataset.paid = String(fine.paid);
    paymentStatus.textContent = fine.paid ? "✓ Betalt" : "Ikke registrert";
    paymentStatus.setAttribute(
      "aria-label",
      fine.paid ? "Bot er registrert som betalt" : "Bot er ikke registrert som betalt",
    );

    item.append(details, paymentStatus);
    elements.fineList.appendChild(item);
  }
}

function renderFines() {
  const fineOverview = state.appState.fineOverview;
  const months = fineOverview?.months || [];

  if (!months.length) {
    elements.fineMonthSelect.replaceChildren();
    elements.fineMonthLabel.textContent = "";
    elements.fineList.replaceChildren();
    return;
  }

  if (!months.includes(state.selectedFineMonth)) {
    state.selectedFineMonth = fineOverview.currentMonthKey || months[0];
  }

  renderFineMonthSelect(months);
  renderFineOverview();
}

function renderAdmin() {
  if (document.activeElement !== elements.officeInput) {
    elements.officeInput.value = state.config.officeName;
  }
  if (document.activeElement !== elements.peopleInput) {
    elements.peopleInput.value = state.config.people
      .map((person) => `${person.team} | ${person.name}`)
      .join("\n");
  }
}

function setActiveTab(tabName) {
  const views = {
    leaderboard: elements.leaderboardView,
    registration: elements.registrationView,
    fines: elements.finesView,
  };
  state.activeTab = views[tabName] ? tabName : "leaderboard";

  for (const button of elements.tabButtons) {
    const isActive = button.dataset.tab === state.activeTab;
    button.setAttribute("aria-selected", String(isActive));
    button.tabIndex = isActive ? 0 : -1;
    views[button.dataset.tab].hidden = !isActive;
  }
}

function render() {
  if (!state.config || !state.appState) {
    return;
  }

  renderSummary();
  renderRegistration();
  renderFines();
  renderBoard(elements.individualBoard, state.appState.leaderboards.individual, "individual");
  renderBoard(elements.teamBoard, state.appState.leaderboards.teams, "team");
  renderRecentEntries();
  renderAdmin();
  setActiveTab(state.activeTab);
}

async function fetchState() {
  setAppState(await callApi("state"));
}

async function submitEntry() {
  const selectedPerson = getSelectedPerson();
  const selectedTask = getSelectedTask();
  if (!selectedPerson || !selectedTask) {
    return;
  }

  elements.submitButton.disabled = true;
  setStatus(elements.statusMessage, "Sender inn...", "neutral");

  const payload = await callApi("entry", {
    personId: selectedPerson.id,
    taskId: selectedTask.id,
  });

  state.selectedTaskId = "";
  setAppState(payload.state);
  setStatus(elements.statusMessage, "Registrert. Leaderboardet er oppdatert.", "success");
}

async function saveConfig() {
  const people = elements.peopleInput.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const divider = line.indexOf("|");
      return {
        team: divider >= 0 ? line.slice(0, divider).trim() : "",
        name: divider >= 0 ? line.slice(divider + 1).trim() : "",
      };
    });

  if (people.length === 0 || people.some((person) => !person.team || !person.name)) {
    throw new Error("Bruk formatet Team | Navn på hver linje.");
  }

  setStatus(elements.configStatus, "Lagrer oppsett...", "neutral");

  const payload = await callApi("config", {
    officeName: elements.officeInput.value.trim(),
    monthlyPrizeKr: state.config.monthlyPrizeKr,
    people,
  });

  setAppState(payload.state);
  setStatus(elements.configStatus, "Oppsett lagret.", "success");
}

function startLiveUpdates() {
  if (pollingTimer) {
    return;
  }

  pollingTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") {
      fetchState().catch(() => undefined);
    }
  }, POLL_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      fetchState().catch(() => undefined);
    }
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js", { scope: "./" }).catch(() => undefined);
  });
}

elements.tabButtons.forEach((button, index) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }

    event.preventDefault();
    let nextIndex = index;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = elements.tabButtons.length - 1;
    } else {
      const direction = event.key === "ArrowRight" ? 1 : -1;
      nextIndex = (index + direction + elements.tabButtons.length) % elements.tabButtons.length;
    }

    const nextButton = elements.tabButtons[nextIndex];
    nextButton.focus();
    setActiveTab(nextButton.dataset.tab);
  });
});

if (IS_PWA_VIEW) {
  elements.iosInstallTrigger.addEventListener("click", openIosInstallDialog);
  elements.iosInstallClose.addEventListener("click", closeIosInstallDialog);
  elements.iosInstallDialog.addEventListener("click", (event) => {
    if (event.target === elements.iosInstallDialog) {
      closeIosInstallDialog();
    }
  });
}

elements.personSelect.addEventListener("change", () => {
  state.selectedPersonId = elements.personSelect.value;
  renderRegistration();
});

elements.taskSelect.addEventListener("change", () => {
  state.selectedTaskId = elements.taskSelect.value;
  renderRegistration();
});

elements.fineMonthSelect.addEventListener("change", () => {
  state.selectedFineMonth = elements.fineMonthSelect.value;
  renderFines();
});

elements.submitButton.addEventListener("click", async () => {
  try {
    await submitEntry();
  } catch (error) {
    setStatus(elements.statusMessage, error.message, "error");
    renderRegistration();
  }
});

elements.saveConfigButton.addEventListener("click", async () => {
  try {
    await saveConfig();
  } catch (error) {
    setStatus(elements.configStatus, error.message, "error");
  }
});

configurePwaView();

fetchState()
  .then(startLiveUpdates)
  .catch((error) => setStatus(elements.statusMessage, error.message, "error"));
registerServiceWorker();
