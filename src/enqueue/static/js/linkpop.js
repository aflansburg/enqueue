// Link actions (LINKPOP.1). A link inside rendered content - a note, a chat answer -
// does not whisk the person off to a browser on click. It opens a small bar on the link
// with two actions: copy the address, or open it outside the app. A pasted link is as
// often something to paste somewhere else as somewhere to go, and in the note editor a
// click that navigates away is a click that fought the caret.
//
// Only links md() rendered (class "mdlink") get the bar. Deliberate action links such as
// the saved address on a link are not content, so they keep opening directly.
//
// One implementation for both shells. Each passes its own platform plumbing to
// LinkPop.attach: the desktop hands the URL to the OS through open_external and copies
// with the async clipboard; the phone goes through the opener and clipboard plugins.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  // The icon set's 24px stroke grammar. Built with createElementNS in this document:
  // the Android WebView will not paint paths adopted from a DOMParser document.
  const GLYPHS = {
    copy: [
      "M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
      "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3",
    ],
    open: ["M14 3h7v7", "M10 14 21 3", "M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"],
    check: ["M20 6 9 17l-5-5"],
    edit: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"],
  };

  function glyph(name) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("aria-hidden", "true");
    for (const d of GLYPHS[name]) {
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  // The copy for a shell without a clipboard plugin (the desktop). The async API first;
  // when it is refused (a permission policy, or focus not in the document) fall back to
  // execCommand, which is still honoured inside the click's user gesture.
  async function defaultCopy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (e) {
        // refused - fall through to the command path
      }
    }
    if (!copyViaEvent(text) && !copyViaTextarea(text)) throw new Error("copy refused");
  }

  // Set the clipboard from a one-shot copy event: no selection change, so the note
  // editor keeps its caret and never blurs (which would also fire its save).
  function copyViaEvent(text) {
    let wrote = false;
    const onCopy = (e) => {
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
      wrote = true;
    };
    document.addEventListener("copy", onCopy, true);
    try {
      document.execCommand("copy");
    } catch (e) {
      // unsupported - handled by the flag
    }
    document.removeEventListener("copy", onCopy, true);
    return wrote;
  }

  // Last resort for an engine that only copies a real selection. Restores focus and the
  // person's selection afterwards.
  function copyViaTextarea(text) {
    const active = document.activeElement;
    const sel = window.getSelection();
    const saved = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (e) {
      ok = false;
    }
    ta.remove();
    if (active && active.focus) active.focus({ preventScroll: true });
    if (saved) {
      sel.removeAllRanges();
      sel.addRange(saved);
    }
    return ok;
  }

  let opts = null;
  let pop = null;
  let bar = null;
  let form = null;
  let current = null;
  let doneTimer = 0;

  function button(act, label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "linkpop-btn";
    b.dataset.act = act;
    b.setAttribute("aria-label", label);
    b.title = label;
    b.appendChild(glyph(act));
    return b;
  }

  function build() {
    if (pop) return pop;
    pop = document.createElement("div");
    pop.className = "linkpop";
    pop.setAttribute("role", "toolbar");
    pop.setAttribute("aria-label", "Link");
    pop.hidden = true;
    bar = document.createElement("div");
    bar.className = "linkpop-bar";
    bar.append(
      button("copy", "Copy link"),
      button("open", "Open in browser"),
      button("edit", "Edit link"),
    );
    pop.append(bar, buildForm());
    // Keep focus (and the caret) where it was: a click on the bar must not blur the
    // note editor underneath, which would also fire its save-on-blur. The form's own
    // fields are the exception: they have to take focus to be typed in.
    pop.addEventListener("mousedown", (e) => {
      if (e.target.tagName !== "INPUT") e.preventDefault();
    });
    pop.addEventListener("click", onAction);
    pop.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        hide();
      } else if (e.key === "Enter" && e.target.tagName === "INPUT") {
        e.preventDefault();
        applyEdit();
      }
    });
    document.body.appendChild(pop);
    return pop;
  }

  // The edit form, for a link in a note being edited: what the link says and where it
  // goes, with "Remove link" leaving the words as plain text.
  function buildForm() {
    form = document.createElement("div");
    form.className = "linkpop-form";
    form.hidden = true;
    const field = (name, label) => {
      const wrap = document.createElement("label");
      wrap.className = "linkpop-field";
      const cap = document.createElement("span");
      cap.textContent = label;
      const input = document.createElement("input");
      input.type = name === "href" ? "url" : "text";
      input.name = name;
      input.autocomplete = "off";
      input.spellcheck = false;
      wrap.append(cap, input);
      return wrap;
    };
    const row = document.createElement("div");
    row.className = "linkpop-row";
    const textButton = (act, label) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "linkpop-text";
      b.dataset.act = act;
      b.textContent = label;
      return b;
    };
    row.append(textButton("unlink", "Remove link"), textButton("apply", "Done"));
    form.append(field("text", "Text"), field("href", "Link"), row);
    return form;
  }

  const input = (name) => form.querySelector('input[name="' + name + '"]');

  function openEdit() {
    if (!current) return;
    bar.hidden = true;
    form.hidden = false;
    input("text").value = current.textContent;
    input("href").value = current.getAttribute("href") || "";
    const r = current.getBoundingClientRect();
    place(current, r.left, r.top, true);
    input("text").focus();
    input("text").select();
  }

  // Tell the editor its content changed, so it saves.
  function touched(editor) {
    if (editor) editor.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function applyEdit() {
    const link = current;
    if (!link) return;
    const editor = link.closest('[contenteditable="true"]');
    const was = link.getAttribute("href") || "";
    const href = input("href").value.trim();
    if (!/^https?:\/\/\S+$/i.test(href)) {
      input("href").focus();
      say("A link needs an address that starts with http:// or https://", true);
      return;
    }
    let text = input("text").value.trim();
    // A bare address shows itself: when only the address changed, it still does.
    if (!text || (text === was && link.textContent === was)) text = href;
    link.textContent = text;
    link.setAttribute("href", href);
    hide();
    touched(editor);
  }

  function unlink() {
    const link = current;
    if (!link) return;
    const editor = link.closest('[contenteditable="true"]');
    link.replaceWith(document.createTextNode(link.textContent));
    hide();
    touched(editor);
  }

  function resetCopy() {
    clearTimeout(doneTimer);
    const b = pop && pop.querySelector('[data-act="copy"]');
    if (!b || !b.classList.contains("is-done")) return;
    b.classList.remove("is-done");
    b.replaceChildren(glyph("copy"));
    b.setAttribute("aria-label", "Copy link");
    b.title = "Copy link";
  }

  // Sit under the part of the link that was clicked (a wrapped link has several line
  // boxes), centred on the click so the bar appears where the finger or pointer is,
  // clamped inside the viewport, flipping above when there is no room below. A keyboard
  // activation has no pointer position, so it anchors to the link's start instead.
  function place(link, x, y, keyboard) {
    const rects = Array.from(link.getClientRects());
    const r =
      rects.find((rc) => y >= rc.top - 2 && y <= rc.bottom + 2) ||
      rects[0] ||
      link.getBoundingClientRect();
    const m = 8;
    const gap = 6;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const anchor = keyboard ? r.left + w / 2 : Math.max(r.left, Math.min(x, r.right));
    const left = Math.max(m, Math.min(anchor - w / 2, window.innerWidth - w - m));
    let top = r.bottom + gap;
    if (top + h > window.innerHeight - m) top = r.top - gap - h;
    pop.style.left = left + "px";
    pop.style.top = Math.max(m, top) + "px";
  }

  function show(link, e) {
    build();
    resetCopy();
    current = link;
    pop.dataset.href = link.href;
    bar.hidden = false;
    form.hidden = true;
    // Editing is for a link in a note that is being edited, not one being read.
    bar.querySelector('[data-act="edit"]').hidden = !link.isContentEditable;
    pop.hidden = false;
    place(link, e.clientX, e.clientY, e.detail === 0);
    // A keyboard activation (Enter on a focused link) reports detail 0: move focus into
    // the bar so it is reachable. A pointer click leaves focus where it was.
    if (e.detail === 0) pop.querySelector("button").focus();
  }

  function hide() {
    if (!pop || pop.hidden) return;
    resetCopy();
    pop.hidden = true;
    current = null;
  }

  function say(message, bad) {
    if (opts && typeof opts.notify === "function") opts.notify(message, bad);
  }

  async function onAction(e) {
    const b = e.target.closest && e.target.closest(".linkpop-btn, .linkpop-text");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.act === "edit") return openEdit();
    if (b.dataset.act === "apply") return applyEdit();
    if (b.dataset.act === "unlink") return unlink();
    const url = pop.dataset.href || "";
    if (b.dataset.act === "open") {
      hide();
      try {
        await opts.open(url);
      } catch (err) {
        console.warn("[linkpop] open failed:", err);
        say("Couldn't open the link. Copy it and paste it into your browser.", true);
      }
      return;
    }
    try {
      await (opts.copy || defaultCopy)(url);
    } catch (err) {
      console.warn("[linkpop] copy failed:", err);
      say("Couldn't copy the link. Select it in the note and copy it instead.", true);
      return;
    }
    b.classList.add("is-done");
    b.replaceChildren(glyph("check"));
    b.setAttribute("aria-label", "Copied");
    b.title = "Copied";
    say("Link copied");
    doneTimer = setTimeout(hide, 900);
  }

  function attach(options) {
    opts = options || {};
    // Capture phase on window, so this runs before any other click handler - the
    // desktop's direct-open bridge, the editor, the opener plugin's own link hook - and
    // a link click becomes exactly one thing: the bar.
    window.addEventListener(
      "click",
      (e) => {
        const a = e.target.closest && e.target.closest("a.mdlink[href]");
        if (!a) return;
        if (!/^https?:/i.test(a.getAttribute("href") || "")) return;
        e.preventDefault();
        e.stopPropagation();
        if (current === a && pop && !pop.hidden) hide();
        else show(a, e);
      },
      true,
    );
    // Anything else dismisses it: a press outside, Escape, a scroll (the bar is fixed
    // and would drift off its link), or a resize.
    window.addEventListener(
      "pointerdown",
      (e) => {
        if (!pop || pop.hidden) return;
        if (pop.contains(e.target)) return;
        if (e.target.closest && e.target.closest("a.mdlink")) return; // click decides
        hide();
      },
      true,
    );
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") hide();
    });
    window.addEventListener(
      "scroll",
      (e) => {
        // A long address scrolls inside its own field; that is not the page moving.
        if (pop && e.target !== document && pop.contains(e.target)) return;
        hide();
      },
      true,
    );
    window.addEventListener("resize", hide);
  }

  window.LinkPop = { attach, hide };
})();
