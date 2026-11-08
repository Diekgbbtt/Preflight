// Webview script for the Prompt Preflight panel. Plain JS, no build step.
// @ts-check
(function () {
  // @ts-ignore provided by VS Code
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const ta = /** @type {HTMLTextAreaElement} */ ($("prompt"));
  const hl = $("highlights");

  /** @type {any} */ let analysis = null;
  /** @type {any} */ let quick = null; // { text, review?, error?, loading? }
  /** @type {any} */ let deep = null;

  const LEVELS = {
    trivial: "Simple command",
    clear: "Clear, ready to send",
    "needs-work": "Needs a bit more",
    vague: "Too vague, the agent will guess",
  };
  const DIMS = [["target", "Target"], ["action", "Action"], ["scope", "Scope"], ["done", "Done when"]];
  const RANK = { error: 0, warning: 1, info: 2, ai: 3 };

  const esc = (/** @type {string} */ s) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);

  function autosize() {
    ta.style.height = "auto";
    ta.style.height = Math.max(160, ta.scrollHeight + 2) + "px";
  }

  /** Non-overlapping highlight ranges; rule findings win over model notes. */
  function marks() {
    const text = ta.value;
    const cands = [];
    if (analysis && analysis.text === text) {
      for (const f of analysis.analysis.findings) if (f.range) cands.push({ ...f.range, cls: f.severity, title: f.message });
    }
    for (const r of [quick, deep]) {
      if (!r || !r.review || r.text !== text) continue;
      for (const i of r.review.issues) {
        if (i.range && i.range.end - i.range.start < text.length * 0.6) cands.push({ ...i.range, cls: "ai", title: i.problem });
      }
    }
    cands.sort((a, b) => RANK[a.cls] - RANK[b.cls]);
    const out = [];
    for (const c of cands) if (!out.some((o) => c.start < o.end && o.start < c.end)) out.push(c);
    return out.sort((a, b) => a.start - b.start);
  }

  function renderHighlights() {
    const text = ta.value;
    let html = "";
    let pos = 0;
    for (const m of marks()) {
      html += esc(text.slice(pos, m.start)) + `<mark class="${m.cls}">${esc(text.slice(m.start, m.end))}</mark>`;
      pos = m.end;
    }
    html += esc(text.slice(pos));
    if (text.endsWith("\n") || !text) html += " ";
    hl.innerHTML = html;
  }

  function select(/** @type {{start:number,end:number}} */ r) {
    ta.focus();
    ta.setSelectionRange(r.start, r.end);
  }

  function renderAnalysis() {
    const a = analysis && analysis.text === ta.value ? analysis.analysis : null;
    const empty = !ta.value.trim();
    const fill = $("fill");
    fill.style.width = empty || !a ? "0%" : a.score + "%";
    fill.className = "fill " + (a ? a.level : "");
    $("level").textContent = empty || !a ? "Start typing" : `${LEVELS[a.level]} · ${a.score}/100`;

    $("dims").innerHTML = empty || !a || a.level === "trivial"
      ? ""
      : DIMS.map(([k, label]) => {
          const v = a.dimensions[k];
          const cls = v >= 25 ? "ok" : v >= 15 ? "mid" : "bad";
          return `<span class="dim ${cls}" title="${v}/25">${label}</span>`;
        }).join("");

    const qs = $("questions");
    const qList = /** @type {HTMLElement} */ (qs.querySelector("ul"));
    qs.hidden = !a || empty || a.questions.length === 0;
    qList.innerHTML = a ? a.questions.map((q) => `<li>${md(q)}</li>`).join("") : "";

    const fs = $("findings");
    const fList = /** @type {HTMLElement} */ (fs.querySelector("ul"));
    // one line per message; the first occurrence is the click target
    const seen = new Set();
    const findings = (a && !empty ? a.findings : []).filter((f) => !seen.has(f.message) && seen.add(f.message));
    fs.hidden = findings.length === 0;
    fList.innerHTML = "";
    for (const f of findings) {
      const li = document.createElement("li");
      li.className = "finding " + f.severity;
      li.innerHTML = `<span class="dot"></span><span>${esc(f.message)}</span>`;
      if (f.range) {
        li.classList.add("clickable");
        li.title = "Show in prompt";
        li.onclick = () => select(f.range);
      }
      fList.appendChild(li);
    }

    const send = /** @type {HTMLButtonElement} */ ($("send"));
    send.disabled = empty;
    send.classList.toggle("warn", !!a && a.shouldClarify);
    /** @type {HTMLButtonElement} */ ($("deep")).disabled = empty;
  }

  /** Inline `code` only. */
  function md(/** @type {string} */ s) {
    return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  }

  function renderReview(/** @type {string} */ id, /** @type {any} */ r) {
    const sec = $(id);
    const body = /** @type {HTMLElement} */ (sec.querySelector(".body"));
    sec.hidden = !r;
    if (!r) return;
    sec.classList.toggle("stale", !r.loading && r.text !== ta.value);
    if (r.loading) {
      body.innerHTML = `<p class="muted">Checking…</p>`;
      return;
    }
    if (r.error) {
      body.innerHTML = `<p class="error-text">${esc(r.error)}</p>`;
      return;
    }
    const rv = r.review;
    let html = "";
    if (rv.issues.length === 0) html += `<p class="muted">${rv.verdict === "ready" ? "Nothing else missing." : "No further issues found."}</p>`;
    html += "<ul>" + rv.issues.map((i, n) =>
      `<li class="issue${i.range ? " clickable" : ""}" data-n="${n}"><b>${esc(i.problem)}</b><br><span class="muted">${esc(i.suggestion)}</span></li>`,
    ).join("") + "</ul>";
    if (rv.questions.length && id === "deepOut") {
      html += "<h4>Questions</h4><ul>" + rv.questions.map((q) => `<li>${md(q)}</li>`).join("") + "</ul>";
    }
    if (rv.improvedPrompt) {
      html += `<h4>Improved prompt</h4><pre class="improved">${esc(rv.improvedPrompt)}</pre>
        <p class="muted">Text in [brackets] is for you to fill in.</p>
        <button id="useImproved" class="secondary">Use this prompt</button>`;
    }
    const u = rv.usage;
    html += `<p class="usage">${u.inputTokens + u.outputTokens} tokens · $${u.costUsd.toFixed(4)}</p>`;
    body.innerHTML = html;
    body.querySelectorAll("li.issue.clickable").forEach((li) => {
      const i = rv.issues[Number(/** @type {HTMLElement} */ (li).dataset.n)];
      /** @type {HTMLElement} */ (li).onclick = () => select(i.range);
    });
    const use = body.querySelector("#useImproved");
    if (use) /** @type {HTMLElement} */ (use).onclick = () => vscode.postMessage({ type: "useImproved" });
  }

  function render() {
    autosize();
    renderHighlights();
    renderAnalysis();
    renderReview("quick", quick);
    renderReview("deepOut", deep);
    vscode.setState({ text: ta.value });
  }

  ta.addEventListener("input", () => {
    vscode.postMessage({ type: "input", text: ta.value });
    render();
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      vscode.postMessage({ type: "send" });
    }
  });
  $("send").onclick = () => vscode.postMessage({ type: "send" });
  $("deep").onclick = () => vscode.postMessage({ type: "deepReview" });
  $("copy").onclick = () => vscode.postMessage({ type: "copy" });

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    switch (m.type) {
      case "analysis":
        analysis = { text: m.text, analysis: m.analysis };
        break;
      case "setText":
        ta.value = m.text;
        break;
      case "reviewing":
        if (m.mode === "quick") quick = { text: ta.value, loading: true };
        else deep = { text: ta.value, loading: true };
        break;
      case "review":
        if (m.mode === "quick") quick = m;
        else deep = m;
        break;
      case "sent":
        quick = deep = null;
        break;
    }
    render();
  });

  const saved = vscode.getState();
  if (saved && saved.text) ta.value = saved.text;
  vscode.postMessage({ type: "ready" });
  if (ta.value) vscode.postMessage({ type: "input", text: ta.value });
  render();
})();
