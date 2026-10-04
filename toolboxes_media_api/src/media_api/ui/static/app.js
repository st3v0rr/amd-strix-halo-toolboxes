// Media API playground. Plain JavaScript, no build step. Every request uses
// the session cookie; state-changing ones carry the CSRF token from the page.
"use strict";

const csrf = document.querySelector('meta[name="csrf-token"]').content;
const $ = (id) => document.getElementById(id);
const TASKS = {
  "text-to-image": { label: "Text → image", kind: "image" },
  "image-edit": { label: "Image edit", kind: "image", fields: ["images"] },
  "text-to-video": { label: "Text → video", kind: "video" },
  "image-to-video": { label: "Image → video", kind: "video", fields: ["start"] },
  "start-end-to-video": { label: "Start/end → video", kind: "video", fields: ["start", "end"] },
  "reference-to-video": { label: "References → video", kind: "video", fields: ["references"] },
};
let models = [];
let task = "text-to-image";
let pollTimer = null;
let currentJob = null;

async function api(path, options = {}) {
  const headers = Object.assign({}, options.headers || {});
  if (options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrf;
  const response = await fetch(path, Object.assign({}, options, { headers, credentials: "same-origin" }));
  if (response.status === 401) { window.location.href = "/ui/login"; throw new Error("Session expired."); }
  const body = response.headers.get("content-type")?.includes("json") ? await response.json() : null;
  if (!response.ok) throw new Error(describeError(body, response.status));
  return body;
}

function describeError(body, status) {
  const error = body && body.error;
  if (!error) return `HTTP ${status}`;
  let text = `${error.message} (${error.code})`;
  const details = error.details || {};
  if (details.errors) text += "\n" + details.errors.map((e) => `• ${e.field}: ${e.message}`).join("\n");
  if (details.missing) text += "\nMissing: " + details.missing.join(", ") + (details.hint ? "\n" + details.hint : "");
  return text;
}

function modelsFor(t) { return models.filter((m) => m.tasks.includes(t)); }
function currentModel() { return models.find((m) => m.id === $("model").value); }
function currentProfile() { const m = currentModel(); return m && m.profiles.find((p) => p.id === $("profile").value); }

function renderTasks() {
  const nav = $("tasks");
  nav.textContent = "";
  for (const [id, meta] of Object.entries(TASKS)) {
    if (!modelsFor(id).length) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = meta.label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(id === task));
    button.addEventListener("click", () => { task = id; renderTasks(); renderModels(); });
    nav.appendChild(button);
  }
}

function renderModels() {
  const select = $("model");
  select.textContent = "";
  for (const m of modelsFor(task)) select.add(new Option(m.label, m.id));
  renderProfiles();
}

function renderProfiles() {
  const model = currentModel();
  const select = $("profile");
  select.textContent = "";
  if (!model) return;
  for (const p of model.profiles) {
    const option = new Option(`${p.label}${p.status === "supported" ? "" : " — " + p.status}`, p.id);
    option.disabled = p.status === "unsupported" || !p.tasks.includes(task);
    if (p.id === model.default_profile) option.selected = true;
    select.add(option);
  }
  applyProfile();
}

function applyProfile() {
  const model = currentModel();
  const profile = currentProfile();
  const meta = TASKS[task];
  const c = model ? model.constraints : {};
  const d = profile ? profile.defaults : {};
  let note = profile ? `${profile.description || ""} ≈${profile.estimated_memory_gb} GB.` : "";
  if (profile && profile.available === false) note += ` Missing files: ${profile.missing.join(", ")}`;
  if (profile && profile.reason) note += ` ${profile.reason}`;
  $("profile-note").textContent = note;
  document.querySelectorAll("[data-for]").forEach((el) => {
    const key = el.dataset.for;
    let show = (meta.fields || []).includes(key);
    if (key === "video") show = meta.kind === "video";
    if (key === "negative") show = !!c.negative_prompt;
    if (key === "guidance") show = !!c.guidance;
    el.classList.toggle("hidden", !show);
  });
  $("width").step = $("height").step = c.size_multiple || 8;
  $("width").placeholder = d.width || "auto";
  $("height").placeholder = d.height || "auto";
  $("steps").placeholder = d.steps || "";
  $("guidance").placeholder = d.guidance ?? "";
  $("duration").placeholder = d.duration_seconds || "";
  $("fps").placeholder = d.fps || "";
  const formats = meta.kind === "video" ? ["mp4", "webm"] : ["png", "jpeg", "webp"];
  $("format").textContent = "";
  formats.forEach((f) => $("format").add(new Option(f, f)));
}

function preview(inputId) {
  const box = $(`${inputId}-preview`);
  box.textContent = "";
  for (const file of $(inputId).files) {
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    img.alt = file.name;
    img.onload = () => URL.revokeObjectURL(img.src);
    box.appendChild(img);
  }
}

async function uploadAll(inputId) {
  const ids = [];
  for (const file of $(inputId).files) {
    const form = new FormData();
    form.append("file", file);
    const info = await api("/api/v1/uploads", { method: "POST", body: form });
    ids.push(info.id);
  }
  return ids;
}

function number(id) { const v = $(id).value; return v === "" ? undefined : Number(v); }

async function submit(event) {
  event.preventDefault();
  $("form-error").textContent = "";
  $("submit").disabled = true;
  try {
    const meta = TASKS[task];
    const body = { prompt: $("prompt").value, model: $("model").value, profile: $("profile").value };
    for (const key of ["width", "height", "steps", "seed"]) body[key] = number(key);
    if (!$("guidance").closest("[data-for]").classList.contains("hidden")) body.guidance = number("guidance");
    if (!$("negative_prompt").closest("[data-for]").classList.contains("hidden") && $("negative_prompt").value) {
      body.negative_prompt = $("negative_prompt").value;
    }
    body.output_format = $("format").value;
    let path = "/api/v1/images/generations";
    if (task === "image-edit") {
      path = "/api/v1/images/edits";
      body.image_ids = await uploadAll("images");
      if (!body.image_ids.length) throw new Error("Choose at least one input image.");
    }
    if (meta.kind === "video") {
      path = "/api/v1/videos/generations";
      body.duration_seconds = number("duration");
      body.fps = number("fps");
      body.audio = $("audio").checked;
      if ((meta.fields || []).includes("start")) body.start_image_id = (await uploadAll("start_image"))[0];
      if ((meta.fields || []).includes("end")) body.end_image_id = (await uploadAll("end_image"))[0];
      if ((meta.fields || []).includes("references")) body.reference_image_ids = await uploadAll("references");
      if (task === "image-to-video" && !body.start_image_id) throw new Error("Choose a start image.");
      if (task === "start-end-to-video" && !body.end_image_id) throw new Error("Choose an end image.");
      if (task === "reference-to-video" && !body.reference_image_ids.length) throw new Error("Choose reference images.");
    }
    Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
    const job = await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    watch(job.id);
  } catch (error) {
    $("form-error").textContent = error.message;
  } finally {
    $("submit").disabled = false;
  }
}

function showJob(job) {
  currentJob = job;
  const position = job.queue_position != null ? ` · position ${job.queue_position + 1} in queue` : "";
  $("job-status").textContent = `${job.id} · ${job.task} · ${job.model}/${job.profile} · ${job.status} (${job.stage})${position} · seed ${job.params.seed}`;
  $("job-progress").value = job.progress;
  $("cancel").disabled = !["queued", "running"].includes(job.status);
  const result = $("result");
  if (job.status === "succeeded" && job.result && !result.dataset.job) {
    result.dataset.job = job.id;
    const url = job.result.url;
    const media = job.result.content_type.startsWith("video/") ? document.createElement("video") : document.createElement("img");
    if (media.tagName === "VIDEO") { media.controls = true; media.loop = true; }
    media.src = url;
    const link = document.createElement("a");
    link.href = `${url}?download=1`;
    link.textContent = `Download (${Math.round(job.result.bytes / 1024)} KiB)`;
    result.replaceChildren(media, document.createElement("br"), link);
  } else if (job.status === "failed" || job.status === "cancelled") {
    result.dataset.job = job.id;
    result.textContent = job.error ? describeError({ error: job.error }) : `Job ${job.status}.`;
  }
}

function watch(jobId) {
  clearTimeout(pollTimer);
  delete $("result").dataset.job;
  $("result").textContent = "";
  const tick = async () => {
    try {
      const job = await api(`/api/v1/jobs/${jobId}`);
      showJob(job);
      if (["queued", "running"].includes(job.status)) pollTimer = setTimeout(tick, 1000);
      else refreshRecent();
    } catch (error) {
      $("job-status").textContent = error.message;
    }
  };
  tick();
}

async function refreshRecent() {
  const list = await api("/api/v1/jobs?limit=15");
  const ul = $("recent");
  ul.textContent = "";
  for (const job of list.data) {
    const li = document.createElement("li");
    li.textContent = `${job.status.padEnd(9)} ${job.task} · ${job.model} · ${job.params.prompt.slice(0, 60)}`;
    li.addEventListener("click", () => watch(job.id));
    ul.appendChild(li);
  }
}

async function init() {
  const data = await api("/api/v1/models");
  models = data.data;
  $("backend").textContent = `backend: ${data.backend}`;
  $("model").addEventListener("change", renderProfiles);
  $("profile").addEventListener("change", applyProfile);
  for (const id of ["images", "start_image", "end_image", "references"]) $(id).addEventListener("change", () => preview(id));
  $("gen-form").addEventListener("submit", submit);
  $("prompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !$("submit").disabled) $("gen-form").requestSubmit();
  });
  $("cancel").addEventListener("click", async () => {
    if (!currentJob) return;
    try { showJob(await api(`/api/v1/jobs/${currentJob.id}/cancel`, { method: "POST" })); } catch (error) { $("form-error").textContent = error.message; }
  });
  renderTasks();
  renderModels();
  refreshRecent();
}

document.addEventListener("DOMContentLoaded", () => init().catch((error) => { $("form-error").textContent = error.message; }));
