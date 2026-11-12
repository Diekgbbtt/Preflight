// Webview script for the Prompt Preflight panel. Plain JS, no build step.
// @ts-check
(function () {
  // @ts-ignore provided by VS Code
  const vscode = acquireVsCodeApi();
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
  const ta = /** @type {HTMLTextAreaElement} */ ($("prompt"));
  const hl = $("highlights");
  const pillsWrap = $("pillsWrap");
  const pillsEl = $("pills");
  const qWrap = $("qWrap");
  const qEl = $("questions");
  const meter = /** @type {HTMLElement} */ (document.querySelector(".meter"));
  const levelEl = $("level");
  const ask = /** @type {HTMLButtonElement} */ ($("ask"));
  const send = /** @type {HTMLButtonElement} */ ($("send"));
  const statusEl = $("status");

  const MAC = /Mac/.test(navigator.platform);
  const MOD = MAC ? "⌘" : "Ctrl+";
  const ENTER = MAC ? "↩" : "Enter";

  /**
   * @typedef {{start:number,end:number}} Range
   * @typedef {Range & {cls:string, fresh?:boolean}} Mark
   * @typedef {{label:string,hint:string,range:Range|null,select:boolean}} Pill  select: click selects the words instead of asking
 * @typedef {{question:string,hint:string}} Card
   * @typedef {{n:number,label:string,tone:string,ready:boolean}} Strength
   * @typedef {{text:string,marks:Mark[],pills:Pill[],strength:Strength|null}} Shown
   */

  // Feedback on screen changes only when typing pauses. While typing, marks follow the text and nothing else moves.
  let pauseMs = 1500;
  /** @type {any} */ let live = null; // latest analysis from the host: { text, analysis, added }
  /** @type {any} */ let quick = null; // { text, review?, error?, loading? }
  let asking = false; // Sonnet is preparing detailed questions
  let detailed = false; // Sonnet's questions are among the open cards
  /** @type {Shown} */ let shown = blank("");
  let commitWhenReady = false; // commit as soon as the analysis for the current text arrives
  let typing = false;
  let merging = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let pauseTimer;
  let sendLabel = "Send to Claude Code";

  const esc = (/** @type {string} */ s) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);
  /** Inline `code` only. */
  const md = (/** @type {string} */ s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

  /** @returns {Shown} */
  function blank(/** @type {string} */ text) {
    return { text, marks: [], pills: [], strength: null };
  }

  function setStatus(/** @type {string} */ text, error = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", error);
  }

  function autosize() {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  /** @returns {Strength} */
  function strength(/** @type {any} */ a) {
    const ready = (a.level === "clear" || a.level === "trivial") && !a.shouldClarify;
    if (ready) return { n: 4, label: a.level === "trivial" ? "Simple command" : "Strong prompt", tone: "strong", ready };
    if (a.level === "vague") return { n: 1, label: "Weak prompt", tone: "weak", ready };
    return { n: a.score >= 68 ? 3 : 2, label: "Getting there", tone: "weak", ready };
  }

  // ---- following the text while typing

  /** The single edit that turns `a` into `b`: common prefix and suffix around it. */
  function editBetween(/** @type {string} */ a, /** @type {string} */ b) {
    const max = Math.min(a.length, b.length);
    let at = 0;
    while (at < max && a[at] === b[at]) at++;
    let tail = 0;
    while (tail < max - at && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return { at, removed: a.length - tail - at, inserted: b.length - tail - at };
  }

  /** Move a range through an edit. Null when the edit touched it; the next pause decides again. */
  function mapRange(/** @type {Range} */ r, /** @type {ReturnType<typeof editBetween>} */ e, grow = false) {
    const oldEnd = e.at + e.removed;
    const d = e.inserted - e.removed;
    // typing inside or right after the user's own (green) words keeps them green
    if (grow && r.start <= e.at && oldEnd <= r.end) return { ...r, end: r.end + d };
    if (r.end <= e.at) return r;
    if (r.start >= oldEnd) return { ...r, start: r.start + d, end: r.end + d };
    return null;
  }

  function follow() {
    const e = editBetween(shown.text, ta.value);
    if (e.removed === 0 && e.inserted === 0) return;
    shown.marks = /** @type {Mark[]} */ (
      shown.marks.map((m) => mapRange(m, e, m.cls === "added")).filter(Boolean).map((m) => ({ ...m, fresh: false }))
    );
    shown.pills = shown.pills.map((p) => ({ ...p, range: p.range && mapRange(p.range, e) }));
    shown.text = ta.value;
  }

  // ---- committing a new snapshot after a pause

  /** @returns {Shown} */
  function snapshot() {
    const text = ta.value;
    if (!text.trim() || !live) return blank(text);
    const a = live.analysis;
    const q = quick && quick.review && quick.text === text ? quick.review : null;

    /** @type {Mark[]} */
    const marks = [];
    for (const f of a.findings) if (f.range) marks.push({ ...f.range, cls: f.severity === "info" ? "u-soft" : "u" });
    for (const r of live.added || []) marks.push({ ...r, cls: "added" });
    if (q) for (const i of q.issues) if (i.range && i.range.end - i.range.start < text.length * 0.6) marks.push({ ...i.range, cls: "u" });

    /** @type {Pill[]} */
    const pills = [];
    const add = (/** @type {string} */ label, /** @type {string} */ hint, /** @type {Range|undefined} */ range, select = false) => {
      if (label && !pills.some((p) => p.label === label)) pills.push({ label, hint, range: range || null, select });
    };
    // a secret is fixed by deleting it, so its pill selects the words; every other pill asks a question
    for (const f of a.findings) if (f.range) add(f.short || f.message, f.message, f.range, f.category === "privacy");
    for (const f of a.findings) if (!f.range) add(f.short || f.message, f.message, undefined);
    if (q) for (const i of q.issues) add(i.question || i.problem, i.question ? i.problem : i.suggestion, i.range);

    return { text, marks, pills: pills.slice(0, 4), strength: strength(a) };
  }

  function commit() {
    if (!live || live.text !== ta.value) {
      commitWhenReady = true;
      return;
    }
    commitWhenReady = false;
    const key = (/** @type {Mark} */ m) => `${m.cls}:${m.start}:${m.end}`;
    const before = new Set(shown.marks.map(key));
    shown = snapshot();
    for (const m of shown.marks) m.fresh = !before.has(key(m));
    render();
  }

  // ---- drawing

  /** The prompt text with underlines (Preflight's notes) and green (the user's added words). Ranges may overlap. */
  function renderHighlights() {
    const text = ta.value;
    const marks = shown.marks.filter((m) => m.start >= 0 && m.end <= text.length && m.start < m.end);
    const cuts = [...new Set([0, text.length, ...marks.flatMap((m) => [m.start, m.end])])].sort((x, y) => x - y);
    let html = "";
    for (let k = 0; k < cuts.length - 1; k++) {
      const s = cuts[k], e = cuts[k + 1];
      const over = marks.filter((m) => m.start <= s && m.end >= e);
      const cls = new Set(over.map((m) => m.cls));
      if (cls.has("u")) cls.delete("u-soft");
      if (over.some((m) => m.fresh)) cls.add("fresh");
      const part = esc(text.slice(s, e));
      html += cls.size ? `<span class="${[...cls].join(" ")}">${part}</span>` : part;
    }
    if (text.endsWith("\n") || !text) html += " ";
    hl.innerHTML = html;
  }

  function select(/** @type {Range} */ r) {
    ta.focus();
    ta.setSelectionRange(r.start, r.end);
  }

  /** Keep pills that stay, fade in new ones, fade out old ones. Nothing is rebuilt, so nothing flickers. */
  function renderPills() {
    const kind = (/** @type {Pill} */ p) => p.label;
    /** @type {Map<string, HTMLElement>} */
    const current = new Map();
    for (const el of /** @type {HTMLElement[]} */ ([...pillsEl.children])) {
      if (!el.classList.contains("leave")) current.set(/** @type {string} */ (el.dataset.key), el);
    }
    let prev = /** @type {HTMLElement | null} */ (null);
    for (const p of shown.pills) {
      const k = kind(p);
      let el = current.get(k);
      if (el) current.delete(k);
      else {
        const made = document.createElement("button");
        made.className = "pill tool enter";
        made.dataset.key = k;
        made.textContent = p.label;
        made.addEventListener("animationend", () => made.classList.remove("enter"), { once: true });
        made.onclick = () => {
          const now = shown.pills.find((x) => x.label === p.label) || p;
          if (now.select && now.range) select(now.range);
          else addCards([{ question: now.label, hint: now.hint }]);
        };
        el = made;
      }
      el.title = p.select ? "Select it in the prompt" : p.hint;
      // keep order without re-inserting pills that are already in place
      const want = prev ? prev.nextElementSibling : pillsEl.firstElementChild;
      if (want !== el) pillsEl.insertBefore(el, want);
      prev = el;
    }
    for (const el of current.values()) {
      el.classList.add("leave");
      el.setAttribute("aria-hidden", "true");
      setTimeout(() => el.remove(), 300);
    }
    open(pillsWrap, shown.pills.length > 0);
  }

  function open(/** @type {HTMLElement} */ wrap, /** @type {boolean} */ on) {
    wrap.classList.toggle("open", on);
    wrap.toggleAttribute("inert", !on);
  }

  function renderFooter() {
    const s = ta.value.trim() ? shown.strength : null;
    meter.className = "meter " + (s ? s.tone : "");
    meter.querySelectorAll("i").forEach((seg, k) => seg.classList.toggle("on", !!s && k < s.n));
    const label = s ? s.label : "";
    if (levelEl.textContent !== label && label) levelEl.textContent = label; // keep the old text while it fades out
    levelEl.className = "level " + (s ? s.tone + " show" : "");

    const showAsk = asking || (!!s && !s.ready && !detailed);
    ask.classList.toggle("show", showAsk);
    ask.tabIndex = showAsk ? 0 : -1;
    ask.setAttribute("aria-hidden", String(!showAsk));
    ask.textContent = asking ? "Thinking…" : "Ask me";
    ask.setAttribute("aria-busy", String(asking));
    ask.title = asking ? "Stop asking" : "Get detailed questions about your prompt";

    send.disabled = !ta.value.trim();
    send.classList.toggle("ready", !!s && s.ready);
    send.setAttribute("aria-label", sendLabel);
    send.title = `${sendLabel} (${MOD}${ENTER})`;
  }

  function render() {
    autosize();
    renderHighlights();
    renderPills();
    renderFooter();
    vscode.setState({ text: ta.value });
  }

  // ---- answer cards: from a clicked pill, or Sonnet's detailed questions

  /** @returns {HTMLInputElement[]} */
  function inputs() {
    return [...qEl.querySelectorAll("input")];
  }

  function updateMerge() {
    const btn = /** @type {HTMLButtonElement | null} */ (qEl.querySelector("#merge"));
    if (btn) btn.disabled = merging || !inputs().some((i) => i.value.trim());
  }

  function doMerge() {
    const btn = /** @type {HTMLButtonElement | null} */ (qEl.querySelector("#merge"));
    const answers = [...qEl.querySelectorAll(".qcard")].map((el) => {
      const c = /** @type {HTMLElement} */ (el);
      const hint = c.dataset.hint ? ` (${c.dataset.hint})` : "";
      return { question: c.dataset.q + hint, answer: /** @type {HTMLInputElement} */ (c.querySelector("input")).value };
    });
    if (!btn || merging || !answers.some((a) => a.answer.trim())) return;
    merging = true;
    btn.disabled = true;
    btn.textContent = "Adding…";
    btn.setAttribute("aria-busy", "true");
    setStatus("");
    vscode.postMessage({ type: "merge", answers });
  }

  /** Open a card per question (once each) and put the cursor in the first new one. */
  function addCards(/** @type {Card[]} */ list) {
    const fresh = !qWrap.classList.contains("open");
    if (fresh) {
      qEl.innerHTML = `<div class="qgrid"></div>
        <div class="qactions enter"><button id="merge" class="pill user" disabled>Add to prompt</button><button id="dismiss" class="link">Not now</button></div>`;
      /** @type {HTMLElement} */ (qEl.querySelector("#merge")).onclick = doMerge;
      /** @type {HTMLElement} */ (qEl.querySelector("#dismiss")).onclick = () => {
        closeCards();
        ta.focus();
      };
    }
    const grid = /** @type {HTMLElement} */ (qEl.querySelector(".qgrid"));
    /** @type {HTMLInputElement | null} */ let focus = null;
    let delay = fresh ? 0.15 : 0;
    for (const c of list) {
      const existing = /** @type {HTMLElement[]} */ ([...grid.children]).find((el) => el.dataset.q === c.question);
      if (existing) {
        focus ??= existing.querySelector("input");
        continue;
      }
      const card = document.createElement("label");
      card.className = "qcard enter";
      card.style.animationDelay = `${delay}s`;
      delay += 0.12;
      card.dataset.q = c.question;
      card.dataset.hint = c.hint;
      card.innerHTML = `<span class="q">${md(c.question)}</span>${c.hint ? `<span class="hint">${md(c.hint)}</span>` : ""}<input type="text" placeholder="Your answer" autocomplete="off" spellcheck="true">`;
      const input = /** @type {HTMLInputElement} */ (card.querySelector("input"));
      input.addEventListener("input", updateMerge);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          closeCards();
          ta.focus();
          return;
        }
        if (e.key !== "Enter") return;
        e.preventDefault();
        const all = inputs();
        const k = all.indexOf(input);
        if (k < all.length - 1 && !(e.metaKey || e.ctrlKey)) all[k + 1].focus();
        else doMerge();
      });
      grid.appendChild(card);
      focus ??= input;
    }
    open(qWrap, true);
    updateMerge();
    focus?.focus({ preventScroll: true });
  }

  /** Fold the cards away; their content stays until the section is opened again. */
  function closeCards() {
    detailed = false;
    open(qWrap, false);
    renderFooter();
  }

  /** Replace the prompt in a way the user can undo with Cmd/Ctrl+Z. */
  function applyText(/** @type {string} */ text) {
    ta.focus();
    ta.select();
    // execCommand keeps the textarea's undo history; setting .value would wipe it
    if (!document.execCommand("insertText", false, text)) {
      ta.value = text;
      ta.dispatchEvent(new Event("input"));
    }
  }

  /** Show feedback for text that did not come from typing (restore, selection, merge) without waiting for a pause. */
  function commitSoon() {
    clearTimeout(pauseTimer);
    typing = false;
    commitWhenReady = true;
    if (live && live.text === ta.value) commit();
  }

  // ---- events

  ta.addEventListener("input", () => {
    vscode.postMessage({ type: "input", text: ta.value });
    setStatus("");
    follow();
    clearTimeout(pauseTimer);
    if (!ta.value.trim()) {
      typing = false;
      shown = blank(ta.value);
      render();
      return;
    }
    typing = true;
    pauseTimer = setTimeout(() => {
      typing = false;
      commit();
    }, pauseMs);
    autosize();
    renderHighlights();
    renderFooter();
    vscode.setState({ text: ta.value });
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      vscode.postMessage({ type: "send" });
    }
  });
  send.onclick = () => vscode.postMessage({ type: "send" });
  ask.onclick = () => vscode.postMessage({ type: asking ? "cancel" : "deepReview" });

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    switch (m.type) {
      case "config":
        sendLabel = m.sendLabel;
        pauseMs = m.pauseMs;
        renderFooter();
        break;
      case "analysis":
        live = { text: m.text, analysis: m.analysis, added: m.added };
        if (commitWhenReady && m.text === ta.value) commit();
        break;
      case "setText":
        ta.value = m.text;
        shown = blank(m.text);
        render();
        commitSoon();
        break;
      case "reviewing":
        if (m.mode === "deep") {
          asking = true; // cards the user already opened stay, with their answers
          setStatus("");
          renderFooter();
        }
        break;
      case "review":
        if (m.mode === "quick") {
          quick = m; // a failed quick check stays silent; rules still work
          if (!typing && m.review && m.text === ta.value) commit();
        } else {
          asking = false;
          if (m.error) setStatus(m.error, true);
          else if (m.review.questions.length === 0) setStatus("Nothing to ask. Your prompt covers the basics.");
          else {
            detailed = true;
            addCards(m.review.questions.map((/** @type {string} */ q) => ({ question: q, hint: "" })));
          }
          renderFooter();
        }
        break;
      case "cancelled":
        asking = false;
        renderFooter();
        break;
      case "merged":
        merging = false;
        closeCards();
        applyText(m.text);
        commitSoon();
        setStatus(`Added your answers. ${MOD}Z to undo.`);
        break;
      case "mergeError": {
        merging = false;
        const btn = /** @type {HTMLButtonElement | null} */ (qEl.querySelector("#merge"));
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Add to prompt";
          btn.removeAttribute("aria-busy");
        }
        setStatus(m.error, true);
        break;
      }
      case "sent":
        quick = null;
        asking = merging = false;
        closeCards();
        setStatus("");
        break;
    }
  });

  const saved = vscode.getState();
  if (saved && saved.text) {
    ta.value = saved.text;
    shown = blank(saved.text);
    commitWhenReady = true;
  }
  vscode.postMessage({ type: "ready" });
  if (ta.value) vscode.postMessage({ type: "input", text: ta.value });
  render();
})();
