// Landing intro: an itemized statement lands on the desk, two charges get circled in red, the balance is struck
// through, a SETTLED stamp comes down, and the sheet folds into the upload card (#upload-doc). About 2.8 seconds.
// Skippable (button, Esc, any click or key). Never runs with prefers-reduced-motion, when resuming a #case link,
// or with ?intro=0. The sheet is illustrative: bars stand in for text and amounts, so no figures are invented.

const DUR = { morph: 520, quickMorph: 260 };
const AT = { line1: 250, rows: 260, circle1: 1000, circle2: 1260, line2: 1050, strike: 1500, stamp: 1720, line3: 1760, morph: 2280 };

function shouldPlay() {
  if (!document.getElementById("patient-app") || !document.getElementById("upload-doc")) return false;
  if (/(^|[#&])case=/.test(location.hash)) return false;
  if (new URLSearchParams(location.search).get("intro") === "0") return false;
  try {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  } catch {}
  return true;
}

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

// widths of the illustrative rows (percent of the description column); flagged rows get a red circle
const ROWS = [
  { w: 78, c: 62, a: 70 },
  { w: 54, c: 48, a: 58 },
  { w: 66, c: 56, a: 74, flag: "billed twice" },
  { w: 66, c: 56, a: 74 },
  { w: 42, c: 62, a: 52 },
  { w: 72, c: 50, a: 88, flag: "upcoded" },
  { w: 58, c: 44, a: 60 },
  { w: 36, c: 58, a: 48 },
];
const CIRCLE =
  '<svg class="ip-circle" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">' +
  '<path pathLength="1" d="M86 7C68-1 22 0 9 11-3 22 18 38 52 37 85 36 101 26 93 12 89 6 78 4 68 6"/></svg>';

function build() {
  const root = el("div", "intro");
  root.id = "intro";
  const stage = el("div", "intro-stage");
  stage.setAttribute("aria-hidden", "true");

  const paper = el("div", "ip");
  paper.append(
    el("div", "ip-head", '<span class="ip-title">Itemized statement</span><span class="ip-meta"><i style="--w:70%"></i><i style="--w:46%"></i></span>'),
    el("div", "ip-cols", "<span>Description</span><span>Code</span><span>Charge</span>"),
  );
  const rows = el("div", "ip-rows");
  ROWS.forEach((r, i) => {
    const row = el("div", `ip-row${r.flag ? " flagged" : ""}`);
    row.style.setProperty("--i", i);
    row.innerHTML =
      `<span class="ip-d"><i style="--w:${r.w}%"></i></span><span class="ip-c"><i style="--w:${r.c}%"></i></span>` +
      `<span class="ip-a"><i style="--w:${r.a}%"></i>${r.flag ? CIRCLE : ""}</span>` +
      (r.flag ? `<span class="ip-note">${r.flag}</span>` : "");
    rows.append(row);
  });
  paper.append(
    rows,
    el(
      "div",
      "ip-total",
      '<span>Balance due</span><span class="ip-a"><i style="--w:92%"></i>' +
        '<svg class="ip-strike" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><path pathLength="1" d="M2 13C30 9 66 8 98 6"/></svg></span>',
    ),
    el("div", "ip-stamp", "<span>Settled</span><small>Vellum</small>"),
  );

  const lines = el(
    "p",
    "intro-lines",
    '<span class="l1">Reads the bill.</span><span class="l2">Circles the errors.</span><span class="l3">Argues it down.</span>',
  );
  stage.append(lines, paper);

  // reuse the masthead's seal + wordmark so the intro and the page share one brand mark
  const seal = document.querySelector(".masthead .seal-mark");
  const brand = el("div", "intro-brand");
  brand.setAttribute("aria-hidden", "true");
  if (seal) brand.append(seal.cloneNode(true));
  brand.append("Vellum");
  const skip = el("button", "intro-skip", "Skip intro");
  skip.type = "button";
  root.append(brand, stage, skip);
  return { root, paper, skip };
}

function play() {
  const target = document.getElementById("upload-doc");
  const { root, paper, skip } = build();
  const timers = [];
  let done = false;

  document.documentElement.classList.add("intro-on");
  target.classList.add("intro-hold");
  document.body.append(root);
  window.scrollTo(0, 0);

  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  const stageClass = (c) => root.classList.add(c);
  at(10, () => stageClass("go"));
  at(AT.line1, () => stageClass("s-l1"));
  at(AT.rows, () => stageClass("s-rows"));
  at(AT.circle1, () => stageClass("s-c1"));
  at(AT.line2, () => stageClass("s-l2"));
  at(AT.circle2, () => stageClass("s-c2"));
  at(AT.strike, () => stageClass("s-strike"));
  at(AT.stamp, () => stageClass("s-stamp"));
  at(AT.line3, () => stageClass("s-l3"));
  at(AT.morph, () => finish(DUR.morph));

  function finish(ms) {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    removeEventListener("keydown", onKey, true);
    root.classList.add("s-out");

    const p = paper.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    const visible = t.top < innerHeight * 0.85 && t.width > 0;
    const anim = visible
      ? paper.animate(
          [
            { transform: getComputedStyle(paper).transform === "none" ? "none" : getComputedStyle(paper).transform, opacity: 1 },
            {
              transform: `translate(${t.left - p.left}px, ${t.top - p.top}px) scale(${t.width / p.width}, ${t.height / p.height})`,
              opacity: 0.0,
            },
          ],
          { duration: ms, easing: "cubic-bezier(.6,0,.2,1)", fill: "forwards" },
        )
      : paper.animate([{ opacity: 1 }, { transform: `translateY(${innerHeight * 0.4}px)`, opacity: 0 }], {
          duration: ms,
          easing: "cubic-bezier(.6,0,.2,1)",
          fill: "forwards",
        });
    root.animate([{ backgroundColor: getComputedStyle(root).backgroundColor }, { backgroundColor: "transparent" }], {
      duration: ms,
      easing: "ease-in",
      fill: "forwards",
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      root.remove();
      document.documentElement.classList.remove("intro-on");
      target.classList.remove("intro-hold");
      target.classList.add("landed");
      setTimeout(() => target.classList.remove("landed"), 700);
    };
    anim.finished.then(end, end);
    setTimeout(end, ms + 400); // belt and braces if the animation promise never settles
  }
  const onKey = (e) => {
    if (e.key === "Tab" || e.key === "Shift") return;
    finish(DUR.quickMorph);
  };
  skip.addEventListener("click", (e) => {
    e.stopPropagation();
    finish(DUR.quickMorph);
  });
  root.addEventListener("click", () => finish(DUR.quickMorph));
  addEventListener("keydown", onKey, true);
}

if (shouldPlay()) play();
