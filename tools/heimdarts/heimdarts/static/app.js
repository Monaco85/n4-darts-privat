"use strict";

const SEGMENTS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const R = { bull: 6.35, outerBull: 15.9, trebleIn: 99, trebleOut: 107, doubleIn: 162, doubleOut: 170, board: 225.5 };
const COORD_SCALE = 0.99 / 170; // Board-Manager-Koordinaten -> mm
const NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

let status = null;
let camKey = "";
let sourcesDirty = false;

// ------------------------------------------------------------------ Hilfen
async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

function el(tag, attrs = {}, parent) {
  const svgTags = ["svg", "path", "circle", "text", "g", "line"];
  const e = svgTags.includes(tag) ? document.createElementNS(NS, tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}

const pt = (r, deg) => [r * Math.cos((deg * Math.PI) / 180), -r * Math.sin((deg * Math.PI) / 180)];

function wedge(r1, r2, a1, a2) {
  const [x1, y1] = pt(r2, a1), [x2, y2] = pt(r2, a2), [x3, y3] = pt(r1, a2), [x4, y4] = pt(r1, a1);
  return `M${x1} ${y1}A${r2} ${r2} 0 0 0 ${x2} ${y2}L${x3} ${y3}A${r1} ${r1} 0 0 1 ${x4} ${y4}Z`;
}

function drawBoard(svg) {
  svg.replaceChildren();
  el("circle", { r: R.board, fill: "#111" }, svg);
  SEGMENTS.forEach((num, i) => {
    const c = 90 - 18 * i, a1 = c - 9, a2 = c + 9;
    const dark = i % 2 === 0;
    const single = dark ? "#1c1c1c" : "#e9dcc0";
    const ring = dark ? "#c8352e" : "#2e8b3a";
    el("path", { d: wedge(R.outerBull, R.trebleIn, a1, a2), fill: single }, svg);
    el("path", { d: wedge(R.trebleIn, R.trebleOut, a1, a2), fill: ring }, svg);
    el("path", { d: wedge(R.trebleOut, R.doubleIn, a1, a2), fill: single }, svg);
    el("path", { d: wedge(R.doubleIn, R.doubleOut, a1, a2), fill: ring }, svg);
    const [tx, ty] = pt(197, c);
    el("text", { x: tx, y: ty, fill: "#ddd", "font-size": 19, "font-family": "monospace", "text-anchor": "middle", "dominant-baseline": "central", text: num }, svg);
  });
  el("circle", { r: R.outerBull, fill: "#2e8b3a" }, svg);
  el("circle", { r: R.bull, fill: "#c8352e" }, svg);
  return el("g", { class: "marks" }, svg);
}

// ------------------------------------------------------------------ Scheibe mit Darts
const boardSvg = $("board");
const boardMarks = drawBoard(boardSvg);

boardSvg.addEventListener("click", async (e) => {
  if (!status?.sim) return;
  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(boardSvg.getScreenCTM().inverse());
  try {
    await api("/hd/sim/throw", { x: p.x, y: -p.y });
  } catch (err) {
    alert(err.message);
  }
});

function renderVisit(board) {
  const throws = board.throws || [];
  const slots = $("slots");
  slots.replaceChildren();
  for (let i = 0; i < 3; i++) {
    const t = throws[i];
    el("div", { class: `slot${t ? " filled" : ""}`, text: t ? t.segment.name : "–" }, slots);
  }
  boardMarks.replaceChildren();
  throws.forEach((t, i) => {
    const x = t.coords.x / COORD_SCALE, y = -t.coords.y / COORD_SCALE;
    el("circle", { cx: x, cy: y, r: 7, fill: "#a68cff", stroke: "#060708", "stroke-width": 2 }, boardMarks);
    el("text", { x, y: y + 0.5, fill: "#060708", "font-size": 9, "font-family": "monospace", "text-anchor": "middle", "dominant-baseline": "central", text: i + 1 }, boardMarks);
  });
  const text = { Throw: "Wurf", Takeout: "Bitte Darts ziehen", "Takeout in progress": "Darts werden gezogen", Stopped: "Gestoppt", Calibrating: "Kalibriert …" };
  $("board-status").textContent = text[board.status] || board.status;
  $("btn-startstop").textContent = board.running ? "Stopp" : "Start";
}

// ------------------------------------------------------------------ Kameras
async function autocal(i) {
  try {
    const r = await api("/hd/autocalibrate", { cam: i });
    if (r.ok && r.needs_twenty) openCalibration(i);
    return r;
  } catch (err) {
    alert(err.message);
  }
}

function renderCams(cams) {
  const debug = $("chk-debug").checked ? 1 : 0;
  const key = cams.map((c) => c.spec).join("|") + `#${debug}`;
  const box = $("cams");
  if (key !== camKey) {
    camKey = key;
    box.replaceChildren();
    cams.forEach((c, i) => {
      const card = el("div", { class: "cam", "data-i": i }, box);
      el("img", { src: `/hd/camera/${i}/stream?overlay=1&debug=${debug}`, alt: `Kamera ${i + 1}` }, card);
      const info = el("div", { class: "cam-info" }, card);
      el("span", { class: "cam-name", text: `Kamera ${i + 1} · ${c.spec}` }, info);
      el("span", { class: "cam-state" }, info);
      const actions = el("div", { class: "cam-actions" }, info);
      el("button", { class: "accent", text: "Auto" }, actions).addEventListener("click", () => autocal(i));
      el("button", { text: "Kalibrieren …" }, actions).addEventListener("click", () => openCalibration(i));
      el("div", { class: "cam-note" }, card);
    });
  }
  box.querySelectorAll(".cam").forEach((card) => {
    const c = cams[Number(card.dataset.i)];
    if (!c) return;
    const s = card.querySelector(".cam-state");
    const rate = c.fps ? ` · ${Math.round(c.fps)} FPS` : "";
    if (!c.ok) {
      s.className = "cam-state bad";
      s.textContent = c.error || "kein Bild";
    } else if (!c.calibrated) {
      s.className = "cam-state warn";
      s.textContent = `${c.width}×${c.height}${rate} · nicht kalibriert`;
    } else {
      s.className = "cam-state ok";
      s.textContent = `${c.width}×${c.height}${rate} · kalibriert`;
    }
    if (c.ok && c.exposure) {
      s.title = `Belichtung: ${c.exposure}`;
    }
    const note = card.querySelector(".cam-note");
    const a = c.autocal;
    note.className = `cam-note${a && !a.ok ? " bad" : a?.needs_twenty ? " warn" : ""}`;
    note.textContent = a ? a.message : "";
  });
}
$("chk-debug").addEventListener("change", () => status && renderCams(status.cameras));
$("btn-autocal-all").addEventListener("click", async (e) => {
  e.target.disabled = true;
  try {
    const { results } = await api("/hd/autocalibrate", {});
    const first = results.findIndex((r) => r.ok && r.needs_twenty);
    if (first >= 0) openCalibration(first);
  } catch (err) {
    alert(err.message);
  } finally {
    e.target.disabled = false;
  }
});

// ------------------------------------------------------------------ Status
function setPill(id, text, cls) {
  const p = $(id);
  p.textContent = text;
  p.className = `pill ${cls || ""}`;
}

function render(s) {
  status = s;
  const det = { bereit: ["Erkennung bereit", "ok"], bewegung: ["Bewegung", "warn"], hand: ["Hand im Bild", "warn"], start: ["Startet", ""] };
  const [dt, dc] = s.board.running ? det[s.detector.state] || [s.detector.message, ""] : ["Erkennung gestoppt", "bad"];
  setPill("pill-detector", dt, dc);
  setPill("pill-n4", s.clients ? `n4-darts verbunden (${s.clients})` : "n4-darts nicht verbunden", s.clients ? "ok" : "");
  const ok = s.cameras.filter((c) => c.ok).length, cal = s.cameras.filter((c) => c.calibrated).length;
  setPill("pill-cams", `${ok}/${s.cameras.length} Kameras · ${cal} kalibriert`, ok === s.cameras.length && cal >= 2 ? "ok" : "warn");

  renderVisit(s.board);
  renderCams(s.cameras);
  $("sim-hint").hidden = !s.sim;
  $("btn-takeout").hidden = !s.sim;
  boardSvg.classList.toggle("clickable", s.sim);

  if (!sourcesDirty && document.activeElement !== $("sources")) {
    $("sources").value = s.cameras.map((c) => c.spec).join("\n");
  }
  syncSliders(s.settings);
  if (document.activeElement !== $("set-fps")) $("set-fps").value = s.fps.value;
  $("chk-exposure").checked = !!s.lock_exposure;
  $("val-fps").textContent = `${document.activeElement === $("set-fps") ? $("set-fps").value : s.fps.value} FPS (Erkennung läuft mit ${Math.round(s.fps.loop)})`;
  if ($("cal-dialog").open) renderCalSide();

  const log = $("log");
  log.replaceChildren();
  for (const l of s.log) {
    const li = el("li", {}, log);
    el("time", { text: l.time }, li);
    el("span", { class: l.kind, text: l.text }, li);
  }
}

async function poll() {
  try {
    render(await api("/hd/status"));
  } catch {
    setPill("pill-detector", "HeimDarts nicht erreichbar", "bad");
  }
  setTimeout(poll, 400);
}

// ------------------------------------------------------------------ Knöpfe
$("btn-reset").addEventListener("click", () => api("/hd/board/reset", {}));
$("btn-startstop").addEventListener("click", () => api(status?.board.running ? "/hd/board/stop" : "/hd/board/start", {}));
$("btn-reference").addEventListener("click", () => {
  if (confirm("Ist die Scheibe leer? Das aktuelle Bild wird zur Referenz der leeren Scheibe.")) api("/hd/reference", {});
});
$("btn-takeout").addEventListener("click", () => api("/hd/sim/takeout", {}));
$("api-url").textContent = `${location.protocol}//${location.host}`;

$("sources").addEventListener("input", () => (sourcesDirty = true));
$("btn-sources").addEventListener("click", async () => {
  const sources = $("sources").value.split("\n").map((s) => s.trim()).filter(Boolean);
  try {
    await api("/hd/cameras", { sources });
    sourcesDirty = false;
    camKey = "";
  } catch (err) {
    alert(err.message);
  }
});
$("btn-probe").addEventListener("click", async () => {
  $("probe-result").textContent = "Suche Kameras … (einige Sekunden)";
  try {
    const { cameras } = await api("/hd/probe");
    const found = cameras.map((c) => (c.in_use ? `${c.index} (in Benutzung)` : `${c.index} (${c.width}×${c.height})`));
    $("probe-result").textContent = found.length ? `Gefunden: ${found.join(", ")}` : "Keine USB-Kamera gefunden.";
  } catch (err) {
    $("probe-result").textContent = err.message;
  }
});

// ------------------------------------------------------------------ Regler
const sliders = [
  { id: "set-thr", key: "diff_threshold", show: (v) => v, toUi: (v) => v, fromUi: (v) => Number(v) },
  { id: "set-min", key: "min_dart_area", show: (v) => `${(v * 1000).toFixed(2)} ‰`, toUi: (v) => v * 1000, fromUi: (v) => Number(v) / 1000 },
  { id: "set-max", key: "max_dart_area", show: (v) => `${(v * 100).toFixed(1)} %`, toUi: (v) => v * 100, fromUi: (v) => Number(v) / 100 },
];
let sliderTimer;
function syncSliders(settings) {
  for (const s of sliders) {
    const input = $(s.id);
    if (document.activeElement !== input) input.value = s.toUi(settings[s.key]);
    $(s.id.replace("set-", "val-")).textContent = s.show(document.activeElement === input ? s.fromUi(input.value) : settings[s.key]);
  }
}
for (const s of sliders) {
  $(s.id).addEventListener("input", () => {
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(() => api("/hd/settings", { detector: Object.fromEntries(sliders.map((x) => [x.key, x.fromUi($(x.id).value)])) }), 300);
  });
}
let fpsTimer;
$("chk-exposure").addEventListener("change", (e) => api("/hd/exposure", { lock: e.target.checked }));
$("set-fps").addEventListener("input", () => {
  $("val-fps").textContent = `${$("set-fps").value} FPS`;
  clearTimeout(fpsTimer);
  fpsTimer = setTimeout(() => api("/hd/fps", { fps: Number($("set-fps").value) }), 300);
});

// ------------------------------------------------------------------ Kalibrierung
// Zwei Arten: "auto" (Standbild mit eingeblendetem Gitter, ein Klick ins Feld der 20 legt die
// Drehung fest) und "hand" (fünf Punkte genau anklicken).
const cal = { cam: 0, mode: "auto", points: [] };
const calImg = $("cal-img"), calMarks = $("cal-marks"), loupe = $("cal-loupe");
const miniMarks = drawBoard($("cal-mini"));

function openCalibration(i) {
  cal.cam = i;
  cal.points = [];
  setMode("auto");
  $("cal-title").textContent = `Kamera ${i + 1} kalibrieren`;
  $("cal-msg").textContent = "";
  if (!$("cal-dialog").open) $("cal-dialog").showModal();
}

function setMode(mode) {
  cal.mode = mode;
  cal.points = [];
  $("cal-auto").hidden = mode !== "auto";
  $("cal-hand").hidden = mode !== "hand";
  $("cal-msg").textContent = "";
  loadSnapshot();
  renderCal();
}

function loadSnapshot() {
  const overlay = cal.mode === "auto" ? 1 : 0;
  calImg.src = `/hd/camera/${cal.cam}.jpg?overlay=${overlay}&t=${Date.now()}`;
}
calImg.addEventListener("load", () => {
  calMarks.setAttribute("viewBox", `0 0 ${calImg.naturalWidth} ${calImg.naturalHeight}`);
  renderCal();
});

function renderCalSide() {
  const c = status?.cameras?.[cal.cam];
  const a = c?.autocal;
  let text = "Noch nicht automatisch erkannt.";
  if (a) text = a.message;
  else if (c?.calibrated) text = "Kalibriert. Liegt das gelbe Gitter auf der Scheibe?";
  $("cal-result").textContent = text;
  $("cal-rot-left").disabled = !c?.calibrated;
  $("cal-rot-right").disabled = !c?.calibrated;
}

function renderCal() {
  renderCalSide();
  calMarks.replaceChildren();
  if (cal.mode !== "hand") return;
  const names = status?.calibration_points || [];
  const k = cal.points.length;
  $("cal-step").textContent = k < names.length ? `Punkt ${k + 1} von ${names.length}: ${names[k].name}` : "Alle Punkte gesetzt – speichern.";
  $("cal-save").disabled = k < names.length;
  $("cal-undo").disabled = k === 0;
  miniMarks.replaceChildren();
  names.forEach((p, j) => {
    el("circle", { cx: p.x, cy: -p.y, r: j === k ? 12 : 7, fill: j < k ? "#5cffa0" : j === k ? "#a68cff" : "#3a3f44", stroke: "#060708", "stroke-width": 2 }, miniMarks);
  });
  const size = Math.max(6, (calImg.naturalWidth || 1280) / 160);
  cal.points.forEach(([x, y], j) => {
    el("circle", { cx: x, cy: y, r: size, fill: "none", stroke: "#5cffa0", "stroke-width": size / 3 }, calMarks);
    el("text", { x: x + size * 1.4, y: y - size * 1.4, fill: "#5cffa0", "font-size": size * 2.4, "font-family": "monospace", text: j + 1 }, calMarks);
  });
}

function imagePoint(e) {
  const r = calImg.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * calImg.naturalWidth, ((e.clientY - r.top) / r.height) * calImg.naturalHeight];
}

calImg.addEventListener("click", async (e) => {
  const [x, y] = imagePoint(e);
  if (cal.mode === "auto") {
    if (!status?.cameras?.[cal.cam]?.calibrated) {
      $("cal-msg").textContent = "Erst „Automatisch erkennen“ drücken.";
      return;
    }
    try {
      await api("/hd/calibration/twenty", { cam: cal.cam, x, y });
      $("cal-msg").textContent = "Lage der 20 übernommen.";
      loadSnapshot();
    } catch (err) {
      $("cal-msg").textContent = err.message;
    }
    return;
  }
  const n = status?.calibration_points?.length || 5;
  if (cal.points.length >= n) return;
  cal.points.push([x, y]);
  renderCal();
});
calImg.addEventListener("mousemove", (e) => {
  if (cal.mode !== "hand") return;
  const [x, y] = imagePoint(e);
  const r = calImg.getBoundingClientRect();
  loupe.hidden = false;
  loupe.style.left = `${e.clientX - r.left + 20}px`;
  loupe.style.top = `${e.clientY - r.top - 200}px`;
  const ctx = loupe.getContext("2d");
  const src = 40; // Ausschnitt in Bildpixeln
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, 180, 180);
  ctx.drawImage(calImg, x - src / 2, y - src / 2, src, src, 0, 0, 180, 180);
  ctx.strokeStyle = "#a68cff";
  ctx.beginPath();
  ctx.moveTo(90, 0); ctx.lineTo(90, 180); ctx.moveTo(0, 90); ctx.lineTo(180, 90);
  ctx.stroke();
});
calImg.addEventListener("mouseleave", () => (loupe.hidden = true));

$("cal-run").addEventListener("click", async () => {
  $("cal-msg").textContent = "Suche die Scheibe …";
  const r = await autocal(cal.cam);
  $("cal-msg").textContent = r ? (r.ok ? "" : "Nicht gefunden – siehe oben.") : "";
  loadSnapshot();
});
const rotate = async (steps) => {
  try {
    await api("/hd/calibration/rotate", { cam: cal.cam, steps });
    loadSnapshot();
  } catch (err) {
    $("cal-msg").textContent = err.message;
  }
};
$("cal-rot-left").addEventListener("click", () => rotate(1));
$("cal-rot-right").addEventListener("click", () => rotate(-1));
$("cal-to-hand").addEventListener("click", () => setMode("hand"));
$("cal-to-auto").addEventListener("click", () => setMode("auto"));
$("cal-undo").addEventListener("click", () => { cal.points.pop(); renderCal(); });
$("cal-refresh").addEventListener("click", loadSnapshot);
$("cal-close").addEventListener("click", () => $("cal-dialog").close());
$("cal-save").addEventListener("click", async () => {
  try {
    const r = await api("/hd/calibrate", { cam: cal.cam, points: cal.points });
    $("cal-msg").textContent = `Gespeichert. Abweichung ±${r.error_px} px.`;
    setTimeout(() => setMode("auto"), 900);
  } catch (err) {
    $("cal-msg").textContent = err.message;
  }
});
$("cal-clear").addEventListener("click", async () => {
  await api("/hd/calibration/clear", { cam: cal.cam });
  $("cal-msg").textContent = "Kalibrierung gelöscht.";
  loadSnapshot();
});

poll();
