const $ = id => document.getElementById(id);
let state;
let busy = false;
let polling = false;
function showError(error) {
  $("error").textContent = error.message;
  $("error").hidden = false;
}
async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}
async function action(work) {
  if (busy) return;
  busy = true;
  $("error").hidden = true;
  render();
  try { await work(); await refresh(); } catch (error) { showError(error); }
  finally { busy = false; render(); }
}
function renderAvailability(samples = []) {
  const now = Date.now();
  const start = now - 300_000;
  const visible = samples.filter(sample => sample.at >= start && sample.at <= now);
  const successful = visible.filter(sample => sample.ok).length;
  const summary = visible.length
    ? `${(successful / visible.length * 100).toFixed(1)}% successful checks (${visible.length} ${visible.length === 1 ? "sample" : "samples"})`
    : "Waiting for checkout probes";
  $("availability-summary").textContent = summary;
  $("availability-description").textContent =
    `Last five minutes: ${summary}. Each sample is a synthetic checkout request. UP means success; DOWN means failure. Gaps indicate no recorded checks.`;
  const paths = { up: [], down: [] };
  let previous;
  for (const sample of visible) {
    const x = 54 + (sample.at - start) / 300_000 * 534;
    const y = sample.ok ? 28 : 126;
    const path = paths[sample.ok ? "up" : "down"];
    if (previous && sample.at - previous.at <= 3000) {
      path.push(`M ${previous.x} ${previous.y} H ${x} V ${y}`);
    }
    path.push(`M ${x} ${y} h 0.01`);
    previous = { at: sample.at, x, y };
  }
  $("availability-samples").replaceChildren();
  for (const [status, commands] of Object.entries(paths)) {
    if (!commands.length) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("class", `availability-${status}`);
    path.setAttribute("d", commands.join(" "));
    $("availability-samples").append(path);
  }
}
function render() {
  if (!state) return;
  $("login").hidden = true;
  $("dashboard").hidden = false;
  $("logout").hidden = false;
  $("mode").classList.toggle("cloud", state.mode === "azure");
  $("mode").textContent = state.mode === "local"
    ? "LOCAL REHEARSAL - real local Git and checkout process; Kubernetes/Argo CD are simulated. No Azure SRE Agent is connected. Repairs are operator-attributed."
    : "LIVE AZURE - probe-triggered SRE Agent investigation. Diagnosis is in the Azure SRE Agent portal; events below are independently observed.";
  $("phase").textContent = state.phase.replaceAll("_", " ");
  const probe = state.lastProbe;
  $("health").textContent = probe?.ok ? "CHECKOUT ONLINE" : "CHECKOUT OFFLINE";
  $("health").className = `status ${probe?.ok ? "good" : "bad"}`;
  $("probe-detail").textContent = probe?.detail ?? "Waiting for a checkout probe";
  $("latency").textContent = probe ? `${probe.latencyMs} ms` : "-- ms";
  renderAvailability(state.probeHistory);
  document.querySelectorAll("[data-scenario]").forEach(button => {
    button.disabled = busy || state.phase !== "READY";
    button.hidden = !state.enabledScenarios.includes(button.dataset.scenario);
  });
  $("instruction").textContent = state.phase === "READY" ? "Choose one fault. One visitor run at a time." :
    state.phase === "OPERATOR_REQUIRED" ? "An operator must restore and verify the baseline." :
    state.phase === "INVESTIGATING" && state.mode === "local" ? "Waiting for operator diagnosis and repair. There is no automatic local agent." :
    state.phase === "VERIFYING" || state.phase === "RESETTING" ? `Verifying sustained health: ${state.healthyCount} successful probes.` :
    "Demo in progress. Follow the recovery story below.";
  $("operator").hidden = state.role !== "operator";
  $("local-repair").hidden = state.mode !== "local" || state.phase !== "INVESTIGATING";
  $("inspect").disabled = busy || !state.run;
  $("reset").disabled = busy || state.phase === "RESETTING";
  $("git-change").hidden = !state.change;
  if (state.change) {
    $("change-title").textContent = `${state.change.actor.toUpperCase()} Git change - ${state.change.sha.slice(0, 10)} (expand diff)`;
    $("diff").textContent = state.change.diff;
  }
  document.querySelectorAll("[data-step]").forEach(item => {
    item.classList.toggle("active", item.dataset.step === state.phase ||
      (state.phase === "FAULT_OBSERVED" && item.dataset.step === "INVESTIGATING") ||
      (state.phase === "RECOVERED" && item.dataset.step === "READY"));
  });
  const list = $("events");
  list.replaceChildren();
  for (const event of state.events) {
    const li = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = new Date(event.at).toLocaleTimeString([], { hour12: false });
    const actor = document.createElement("span");
    actor.className = "actor";
    actor.textContent = event.actor;
    const message = document.createElement("span");
    message.className = "message";
    message.textContent = event.message;
    if (event.sha) {
      const code = document.createElement("code");
      code.textContent = `Git ${event.sha}`;
      message.append(code);
    }
    li.append(time, actor, message);
    list.append(li);
  }
}
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    state = await api("/api/state");
    render();
  } catch (error) {
    if (error.message === "Sign in to the booth") {
      state = undefined;
      $("login").hidden = false; $("dashboard").hidden = true; $("logout").hidden = true;
    } else { showError(error); }
  } finally { polling = false; }
}
$("login-form").addEventListener("submit", event => {
  event.preventDefault();
  void action(async () => { await api("/api/login", { token: $("token").value }); $("token").value = ""; });
});
$("logout").addEventListener("click", () => void action(async () => { await api("/api/logout", {}); }));
document.querySelectorAll("[data-scenario]").forEach(button => button.addEventListener("click", () =>
  void action(() => api("/api/runs", { scenario: button.dataset.scenario }))));
$("reset").addEventListener("click", () => {
  if (state?.run && !window.confirm("Stop this run and commit the known-good baseline? This is an operator reset, not agent recovery.")) return;
  void action(() => api("/api/reset", {}));
});
$("inspect").addEventListener("click", () => void action(async () => {
  const result = await api(`/api/evidence?runId=${state.run.id}`);
  $("inspection").textContent = JSON.stringify(result, null, 2);
  $("inspection").hidden = false;
}));
$("repair-form").addEventListener("submit", event => {
  event.preventDefault();
  const field = $("field").value;
  const value = field === "targetPort" ? 8080 : field === "checkoutMode" ? "conference" : { "kubernetes.io/os": "linux" };
  void action(() => api("/api/local-repair", {
    runId: state.run.id, expectedHead: state.run.expectedHead, field, value, evidence: $("evidence").value
  }));
});
setInterval(() => {
  const run = state?.run ?? state?.history.at(-1);
  const seconds = run ? Math.floor(((run.recoveredAt ?? Date.now()) - run.startedAt) / 1000) : 0;
  $("elapsed").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  if (state) void refresh();
}, 1000);
void refresh();
