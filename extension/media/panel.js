// Webview script for the Prompt Preflight panel. Plain JS, no build step.
// Renders only what the host sends: Gap[] plus the meter. The host owns all gap state.
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
  const meterEl = /** @type {HTMLElement} */ (document.querySelector(".meter"));
  const levelEl = $("level");
  const ask = /** @type {HTMLButtonElement} */ ($("ask"));
  const send = /** @type {HTMLButtonElement} */ ($("send"));
  const copy = /** @type {HTMLButtonElement} */ ($("copy"));
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let copiedTimer;
  const statusEl = $("status");

  const MAC = /Mac/.test(navigator.platform);
  const MOD = MAC ? "⌘" : "Ctrl+";
  const ENTER = MAC ? "↩" : "Enter";
  const MAX_PILLS = 4;
  const RANK = { blocking: 0, important: 1, advisory: 2 };

  /**
   * @typedef {{start:number,end:number,text:string}} Span
   * @typedef {{id:string,category:string,priority:"blocking"|"important"|"advisory",span?:Span,question:string,reason:string,suggestion?:string,source:"rules"|"quick"|"deep",status:"open"|"answered"|"dismissed"}} Gap
   * @typedef {{segments:number,label:string,tone:string}} Meter
   * @typedef {{gaps:Gap[],meter:Meter|null,added:{start:number,end:number}[]}} View
   */

  // The latest gaps from the host, and the ones on screen. The screen only changes when typing pauses.
  /** @type {View} */ let latest = { gaps: [], meter: null, added: [] };
  /** @type {View} */ let shown = latest;
  /** @type {Set<string>} */ const shownMarks = new Set(); // marks already on screen, so only new ones animate
  let typing = false;
  let awaitingGaps = false; // text changed without typing; show the host's next gaps at once
  let asking = false;
  let merging = false;
  let pauseMs = 1500;
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let pauseTimer;
  let sendLabel = "Send to Claude Code";

  const esc = (/** @type {string} */ s) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);
  /** Inline `code` only. */
  const md = (/** @type {string} */ s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

  const open = (/** @type {Gap} */ g) => g.status === "open";
  const byRank = (/** @type {Gap} */ a, /** @type {Gap} */ b) =>
    RANK[a.priority] - RANK[b.priority] || (a.span ? a.span.start : Infinity) - (b.span ? b.span.start : Infinity);
  /** A span is drawn only while its words are still where the host saw them. */
  const fits = (/** @type {{start:number,end:number,text?:string}} */ s) =>
    s.start < s.end && s.end <= ta.value.length && (s.text === undefined || ta.value.slice(s.start, s.end) === s.text);

  function setStatus(/** @type {string} */ text, error = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", error);
  }

  function autosize() {
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  function toggle(/** @type {HTMLElement} */ wrap, /** @type {boolean} */ on) {
    wrap.classList.toggle("open", on);
    wrap.toggleAttribute("inert", !on);
  }

  // ---- underlines and green text (spans are hidden while typing; never moved)

  function renderHighlights() {
    const text = ta.value;
    /** @type {{start:number,end:number,cls:string,key:string}[]} */
    const marks = [];
    if (!typing) {
      for (const g of shown.gaps.filter(open)) {
        if (g.span && fits(g.span)) marks.push({ ...g.span, cls: g.priority === "advisory" ? "u-soft" : "u", key: g.id });
      }
      for (const r of shown.added) if (fits(r)) marks.push({ ...r, cls: "added", key: `added:${r.start}:${r.end}` });
    }
    const cuts = [...new Set([0, text.length, ...marks.flatMap((m) => [m.start, m.end])])].sort((x, y) => x - y);
    let html = "";
    for (let k = 0; k < cuts.length - 1; k++) {
      const s = cuts[k], e = cuts[k + 1];
      const over = marks.filter((m) => m.start <= s && m.end >= e);
      const cls = new Set(over.map((m) => m.cls));
      if (cls.has("u")) cls.delete("u-soft");
      if (over.some((m) => !shownMarks.has(m.key))) cls.add("fresh");
      const part = esc(text.slice(s, e));
      html += cls.size ? `<span class="${[...cls].join(" ")}">${part}</span>` : part;
    }
    if (text.endsWith("\n") || !text) html += " ";
    hl.innerHTML = html;
    shownMarks.clear();
    for (const m of marks) shownMarks.add(m.key);
  }

  // ---- pills: open rule and quick gaps, keyed by gap id

  function renderPills() {
    const gaps = shown.gaps.filter((g) => open(g) && g.source !== "deep").sort(byRank).slice(0, MAX_PILLS);
    /** @type {Map<string, HTMLElement>} */
    const current = new Map();
    for (const el of /** @type {HTMLElement[]} */ ([...pillsEl.children])) {
      if (!el.classList.contains("leave")) current.set(/** @type {string} */ (el.dataset.id), el);
    }
    let prev = /** @type {HTMLElement | null} */ (null);
    for (const g of gaps) {
      let el = current.get(g.id);
      if (el) current.delete(g.id);
      else {
        const made = document.createElement("button");
        made.className = "pill tool enter";
        made.dataset.id = g.id;
        made.addEventListener("animationend", () => made.classList.remove("enter"), { once: true });
        made.onclick = () => pillClicked(/** @type {string} */ (made.dataset.id));
        el = made;
      }
      el.textContent = g.question;
      el.title = g.category === "privacy" ? "Select it in the prompt" : g.reason;
      const want = prev ? prev.nextElementSibling : pillsEl.firstElementChild;
      if (want !== el) pillsEl.insertBefore(el, want);
      prev = el;
    }
    for (const el of current.values()) {
      el.classList.add("leave");
      el.setAttribute("aria-hidden", "true");
      setTimeout(() => el.remove(), 300);
    }
    toggle(pillsWrap, gaps.length > 0);
  }

  function pillClicked(/** @type {string} */ id) {
    const g = shown.gaps.find((x) => x.id === id);
    if (!g) return;
    // a secret is fixed by deleting it, so its pill selects the words
    if (g.category === "privacy" && g.span && fits(g.span)) {
      ta.focus();
      ta.setSelectionRange(g.span.start, g.span.end);
    } else openCards([g.id]);
  }

  // ---- answer cards, keyed by gap id

  /** @returns {HTMLElement[]} */
  function cards() {
    return [...qEl.querySelectorAll("div.qcard")].map((el) => /** @type {HTMLElement} */ (el));
  }

  function updateMerge() {
    const btn = /** @type {HTMLButtonElement | null} */ (qEl.querySelector("#merge"));
    if (btn) btn.disabled = merging || !cards().some((c) => /** @type {HTMLInputElement} */ (c.querySelector("input")).value.trim());
  }

  function doMerge() {
    const answers = cards().map((c) => ({ id: /** @type {string} */ (c.dataset.id), text: /** @type {HTMLInputElement} */ (c.querySelector("input")).value }));
    const btn = /** @type {HTMLButtonElement | null} */ (qEl.querySelector("#merge"));
    if (!btn || merging || !answers.some((a) => a.text.trim())) return;
    merging = true;
    btn.disabled = true;
    btn.textContent = "Adding…";
    btn.setAttribute("aria-busy", "true");
    setStatus("");
    vscode.postMessage({ type: "answer", answers });
  }

  function makeCard(/** @type {Gap} */ g, /** @type {number} */ delay) {
    const card = document.createElement("div");
    card.className = "qcard enter";
    card.style.animationDelay = `${delay}s`;
    card.dataset.id = g.id;
    card.innerHTML = `<span class="q">${md(g.question)}</span>
      ${g.reason ? `<span class="reason">${md(g.reason)}</span>` : ""}
      ${g.suggestion ? `<span class="suggestion">Try: ${md(g.suggestion)}</span>` : ""}
      <input type="text" placeholder="Your answer" autocomplete="off" spellcheck="true">
      <button class="link dismiss" type="button">Not now</button>`;
    const input = /** @type {HTMLInputElement} */ (card.querySelector("input"));
    input.setAttribute("aria-label", g.question);
    input.addEventListener("input", updateMerge);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") return ta.focus();
      if (e.key !== "Enter") return;
      e.preventDefault();
      const all = cards().map((c) => /** @type {HTMLInputElement} */ (c.querySelector("input")));
      const k = all.indexOf(input);
      if (k < all.length - 1 && !(e.metaKey || e.ctrlKey)) all[k + 1].focus();
      else doMerge();
    });
    /** @type {HTMLElement} */ (card.querySelector(".dismiss")).onclick = () => {
      vscode.postMessage({ type: "dismiss", id: g.id });
      removeCard(card);
    };
    return card;
  }

  function removeCard(/** @type {HTMLElement} */ card) {
    card.remove();
    if (cards().length === 0) toggle(qWrap, false);
    updateMerge();
    renderFooter();
  }

  /** Open a card for each gap id (once) and put the cursor in the first one asked for. */
  function openCards(/** @type {string[]} */ ids, focus = true) {
    if (!qWrap.classList.contains("open")) {
      qEl.innerHTML = `<div class="qgrid"></div>
        <div class="qactions enter"><button id="merge" class="pill user" disabled>Add to prompt</button></div>`;
      /** @type {HTMLElement} */ (qEl.querySelector("#merge")).onclick = doMerge;
    }
    const grid = /** @type {HTMLElement} */ (qEl.querySelector(".qgrid"));
    /** @type {HTMLInputElement | null} */ let first = null;
    let delay = qWrap.classList.contains("open") ? 0 : 0.15;
    for (const id of ids) {
      const g = shown.gaps.find((x) => x.id === id && open(x));
      if (!g) continue;
      let card = cards().find((c) => c.dataset.id === id);
      if (!card) {
        card = makeCard(g, delay);
        delay += 0.12;
        grid.appendChild(card);
      }
      first ??= card.querySelector("input");
    }
    toggle(qWrap, cards().length > 0);
    updateMerge();
    renderFooter();
    if (focus) first?.focus({ preventScroll: true });
  }

  /** Cards follow the gaps on screen: a gap that is gone or dismissed takes its card with it; new deep gaps open as cards. */
  function syncCards() {
    const live = new Set(shown.gaps.filter(open).map((g) => g.id));
    for (const c of cards()) if (!live.has(/** @type {string} */ (c.dataset.id))) c.remove();
    if (cards().length === 0) toggle(qWrap, false);
    const deep = shown.gaps.filter((g) => open(g) && g.source === "deep" && !cards().some((c) => c.dataset.id === g.id));
    if (deep.length) openCards(deep.map((g) => g.id), cards().length === 0);
    updateMerge();
  }

  function closeCards() {
    toggle(qWrap, false);
    qEl.replaceChildren();
  }

  // ---- meter, Ask me, send

  function renderFooter() {
    const m = ta.value.trim() ? shown.meter : null;
    meterEl.className = "meter " + (m ? m.tone : "");
    meterEl.querySelectorAll("i").forEach((seg, k) => seg.classList.toggle("on", !!m && k < m.segments));
    if (m && levelEl.textContent !== m.label) levelEl.textContent = m.label; // keep the old text while it fades out
    levelEl.className = "level " + (m ? m.tone + " show" : "");

    const deepOpen = shown.gaps.some((g) => open(g) && g.source === "deep");
    const showAsk = asking || (!!m && m.segments < 4 && !deepOpen);
    ask.classList.toggle("show", showAsk);
    ask.tabIndex = showAsk ? 0 : -1;
    ask.setAttribute("aria-hidden", String(!showAsk));
    ask.textContent = asking ? "Thinking…" : "Ask me";
    ask.setAttribute("aria-busy", String(asking));
    ask.title = asking ? "Stop asking" : "Get detailed questions about your prompt";

    send.disabled = !ta.value.trim();
    copy.disabled = !ta.value.trim();
    send.classList.toggle("ready", !!m && m.segments === 4);
    send.setAttribute("aria-label", sendLabel);
    send.title = `${sendLabel} (${MOD}${ENTER})`;
  }

  // ---- putting it together

  /** Show the latest gaps from the host. */
  function show() {
    shown = latest;
    autosize();
    renderHighlights();
    renderPills();
    syncCards();
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

  /** Text that did not come from typing (restore, selection, merge) shows its gaps without waiting for a pause. */
  function settle() {
    clearTimeout(pauseTimer);
    typing = false;
    show();
  }

  /** For text set by the host or a merge: keep the old gaps hidden until the gaps for the new text arrive. */
  function settleOnNextGaps() {
    clearTimeout(pauseTimer);
    typing = true;
    awaitingGaps = true;
    autosize();
    renderHighlights();
    renderFooter();
  }

  ta.addEventListener("input", () => {
    vscode.postMessage({ type: "input", text: ta.value });
    vscode.setState({ text: ta.value });
    setStatus("");
    clearTimeout(pauseTimer);
    awaitingGaps = false; // typing again; wait for the pause instead
    if (!ta.value.trim()) {
      typing = false;
      latest = shown = { gaps: [], meter: null, added: [] };
      closeCards();
      show();
      return;
    }
    typing = true;
    pauseTimer = setTimeout(settle, pauseMs);
    autosize();
    renderHighlights();
    renderFooter();
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      vscode.postMessage({ type: "send" });
    }
  });
  send.onclick = () => vscode.postMessage({ type: "send" });
  copy.onclick = () => vscode.postMessage({ type: "copy", text: ta.value });
  ask.onclick = () => {
    if (!asking) setStatus("");
    vscode.postMessage({ type: asking ? "cancel" : "deepReview" });
  };

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    switch (m.type) {
      case "config":
        sendLabel = m.sendLabel;
        pauseMs = m.pauseMs;
        renderFooter();
        break;
      case "gaps":
        latest = { gaps: m.gaps, meter: m.meter, added: m.added || [] };
        if (awaitingGaps) {
          awaitingGaps = false;
          settle();
        } else if (!typing) show();
        break;
      case "setText":
        ta.value = m.text;
        vscode.setState({ text: m.text });
        settleOnNextGaps();
        break;
      case "reviewing":
        if (m.mode === "deep") {
          asking = true;
          renderFooter();
        }
        break;
      case "reviewDone":
        if (m.mode !== "deep") break;
        asking = false;
        if (m.error) setStatus(m.error, true);
        else if (m.empty) setStatus("Nothing to ask. Your prompt covers the basics.");
        renderFooter();
        break;
      case "merged":
        merging = false;
        closeCards();
        applyText(m.text);
        settleOnNextGaps();
        setStatus(`Added your answers. ${MOD}Z to undo.`);
        break;
      case "mergeError": {
        merging = false;
        const btn = /** @type {HTMLButtonElement | null} */ (qEl.querySelector("#merge"));
        if (btn) {
          btn.textContent = "Add to prompt";
          btn.removeAttribute("aria-busy");
        }
        updateMerge();
        setStatus(m.error, true);
        break;
      }
      case "copied":
        copy.classList.add("done");
        copy.setAttribute("aria-label", "Copied");
        setStatus("Copied. Your next edit starts a new prompt.");
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => {
          copy.classList.remove("done");
          copy.setAttribute("aria-label", "Copy prompt");
        }, 1400);
        break;
      case "sent":
        asking = merging = false;
        closeCards();
        setStatus("");
        renderFooter();
        break;
    }
  });

  const saved = vscode.getState();
  if (saved && saved.text) {
    ta.value = saved.text;
    settleOnNextGaps();
  }
  vscode.postMessage({ type: "ready" });
  if (ta.value) vscode.postMessage({ type: "input", text: ta.value });
  show();
})();
