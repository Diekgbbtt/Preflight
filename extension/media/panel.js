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
  /** @type {any} */ let improved = null;

  /** @type {any} */ let scoreState = { state: "idle", score: null, text: "" };
  /** @type {any} */ let feedback = null;
  let clipboardTarget = false;
  let sending = false;
  /** @type {{ text: string, error?: string } | null} */ let rewrite = null;
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
    const score = scoreState.text === ta.value && scoreState.state === "scored" ? scoreState.score : null;
    fill.style.width = score ? score.score + "%" : "0%";
    fill.className = "fill " + (score ? score.level : "");
    fill.parentElement.hidden = !score;
    const localCount = a ? a.findings.filter(f => f.severity !== "info").length : 0;
    $("level").textContent = score ? `Model specification estimate · ${score.score}/100` : empty ? "Local checks · Start typing" : a ? `Local checks · ${localCount ? localCount + " suggestions" : "No warnings found"}` : "Local checks · Checking…";
    $("dims").innerHTML = !score ? (a && !empty ? DIMS.map(([k, label]) => {
      const needsDetail = a.findings.some(f => f.category === k);
      return `<span class="dim ${needsDetail ? "mid" : "ok"}" title="Local heuristic: ${needsDetail ? "check the notes" : "no warning detected"}">${label}${needsDetail ? " · Check" : ""}</span>`;
    }).join("") : "") : DIMS.map(([k, label]) => {
      const v = score.dimensions[k];
      return `<span class="dim ${v >= 25 ? "ok" : v >= 15 ? "mid" : "bad"}" title="${v}/25">${label}</span>`;
    }).join("");
    const advice = feedback ? feedback.feedback : null;

    const qs = $("questions");
    const qList = /** @type {HTMLElement} */ (qs.querySelector("ul"));
    qs.hidden = !advice || empty || advice.questions.length === 0;
    qs.classList.toggle("stale", !!feedback && feedback.text !== ta.value);
    qList.innerHTML = advice ? advice.questions.map((q) => `<li>${md(q)}</li>`).join("") : "";

    const fs = $("findings");
    const fList = /** @type {HTMLElement} */ (fs.querySelector("ul"));
    // one line per message; the first occurrence is the click target
    const seen = new Set();
    const findings = (advice && !empty ? advice.findings : []).filter((f) => !seen.has(f.message) && seen.add(f.message));
    fs.hidden = findings.length === 0;
    fs.classList.toggle("stale", !!feedback && feedback.text !== ta.value);
    fList.innerHTML = "";
    for (const f of findings) {
      const li = document.createElement("li");
      li.className = "finding " + f.severity;
      li.innerHTML = `<span class="dot"></span><span>${esc(f.message)}</span>`;
      if (f.range && feedback.text === ta.value) {
        const button = document.createElement("button");
        button.className = "feedback-link";
        button.textContent = f.message;
        button.title = "Show in prompt";
        button.onclick = () => select(f.range);
        li.lastElementChild?.replaceWith(button);
      }
      fList.appendChild(li);
    }

    const send = /** @type {HTMLButtonElement} */ ($("send"));
    send.disabled = empty || sending;
    send.textContent = sending ? (clipboardTarget ? "Copying…" : "Sending…") : clipboardTarget ? "Copy for Claude Code" : "Send to Claude Code";
    send.title = clipboardTarget ? "Copy and clear the draft (Cmd/Ctrl+Enter)" : "Send and clear the draft (Cmd/Ctrl+Enter)";
    /** @type {HTMLButtonElement} */ ($("deep")).disabled = empty || sending || !!(deep?.loading && deep.text === ta.value) || !!(rewrite?.text === ta.value && !rewrite.error);
    /** @type {HTMLButtonElement} */ ($("copy")).disabled = empty || sending;
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
    const current = r.text === ta.value;
    sec.classList.toggle("stale", !current);
    if (r.loading) {
      body.innerHTML = `<p class="muted" role="status">Reviewing draft…</p>`;
      return;
    }
    if (r.error) {
      body.innerHTML = `<p class="error-text">${esc(r.error)}</p>`;
      return;
    }
    const rv = r.review;
    let html = "";
    if (!rv.issues.length && !rv.questions.length) html += `<p class="muted">No further issues found.</p>`;
    if (rv.issues.length) html += "<ul>" + rv.issues.map((i, n) => {
      const problem = `<b>${esc(i.problem)}</b>`;
      const label = i.range && current ? `<button class="feedback-link" data-n="${n}" title="Show in prompt">${problem}</button>` : problem;
      return `<li class="issue">${label}<br><span class="muted">${esc(i.suggestion)}</span></li>`;
    }).join("") + "</ul>";
    if (rv.questions.length) {
      html += "<h4>Questions</h4><ul>" + rv.questions.map((q) => `<li>${md(q)}</li>`).join("") + "</ul>";
    }
    if (id === "deepOut" && current && improved?.text === ta.value) {
      html += `<h4>Improved prompt</h4><pre class="improved">${esc(improved.improved)}</pre>
        <p class="muted">Text in [brackets] is for you to fill in.</p>
        <button id="useImproved" class="secondary">Use this prompt</button>`;
    }
    else if (id === "deepOut" && current && rv.questions.length) {
      if (rewrite?.text === ta.value && !rewrite.error) {
        html += `<p class="muted" role="status">Writing suggested prompt…</p>`;
      } else {
        const error = rewrite?.text === ta.value && rewrite.error;
        if (error) html += `<p class="error-text" role="status">${esc(error)}</p>`;
        html += `<button id="improve" class="secondary">${error ? "Retry rewrite" : "Suggest improved prompt"}</button>`;
      }
    }
    const u = rv.usage || { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    html += `<p class="usage">${u.inputTokens + u.outputTokens} tokens · $${u.costUsd.toFixed(4)}</p>`;
    body.innerHTML = html;
    body.querySelectorAll("button[data-n]").forEach((button) => {
      const i = rv.issues[Number(/** @type {HTMLElement} */ (button).dataset.n)];
      /** @type {HTMLElement} */ (button).onclick = () => select(i.range);
    });
    const improve = body.querySelector("#improve");
    if (improve) improve.onclick = () => vscode.postMessage({ type: "improve" });
    const use = body.querySelector("#useImproved");
    if (use) /** @type {HTMLElement} */ (use).onclick = () => {
      ta.focus();
      vscode.postMessage({ type: "useImproved" });
    };
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
    improved = null;
    rewrite = null;
    $("actionStatus").hidden = true;
    vscode.postMessage({ type: "input", text: ta.value });
    render();
  });
  function announce(/** @type {string} */ text) {
    const status = $("actionStatus");
    status.hidden = false;
    status.textContent = text;
  }
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      if (!sending && ta.value.trim()) vscode.postMessage({ type: "send" });
    }
  });
  $("send").onclick = () => vscode.postMessage({ type: "send" });
  $("deep").onclick = () => vscode.postMessage({ type: "enhance" });
  $("copy").onclick = () => vscode.postMessage({ type: "copy" });

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    switch (m.type) {
      case "analysis":
        if (m.text !== ta.value) break;
        analysis = { text: m.text, analysis: m.analysis };
        if (m.feedback) feedback = { text: m.text, feedback: m.feedback };
        if (!m.text.trim()) feedback = null;
        break;
      case "setText":
        if (m.text !== ta.value) {
          improved = null;
          rewrite = null;
          $("actionStatus").hidden = true;
        }
        ta.value = m.text;
        break;
      case "score":
        if (m.text === ta.value) scoreState = m;
        break;
      case "reviewing":
        if (m.text !== ta.value) break;
        if (m.mode === "quick") quick = { text: m.text, loading: true };
        else {
          deep = { text: m.text, loading: true };
          improved = null;
          rewrite = null;
        }
        break;
      case "review":
        if (m.text !== ta.value) break;
        if (m.mode === "quick") quick = m;
        else deep = m;
        break;
      case "reviewCancelled":
        if (m.mode === "quick") quick = null;
        else {
          if (deep?.loading) deep = null;
          rewrite = null;
        }
        break;
      case "rewriting":
        if (m.text === ta.value) rewrite = { text: m.text };
        break;
      case "rewriteError":
        if (m.text === ta.value) rewrite = m;
        break;
      case "improved":
        if (m.text === ta.value) {
          improved = m;
          rewrite = null;
        }
        break;
      case "sendTarget":
        clipboardTarget = m.target === "clipboard";
        break;
      case "sending":
        sending = m.busy;
        if (sending) $("actionStatus").hidden = true;
        break;
      case "copied":
        announce("Prompt copied.");
        break;
      case "sent":
        quick = deep = feedback = improved = rewrite = null;
        scoreState = { state: "idle", score: null, text: "" };
        announce(m.target === "clipboard" ? "Prompt copied." : "Prompt opened in the Claude Code terminal.");
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
