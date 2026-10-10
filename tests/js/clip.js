// The clipboard as markdown (md.js): what pasted text becomes, and where it lands in
// the note. Pasting a list used to make a paragraph per line, with a blank line
// between each on save; these pin the text side of the fix. The DOM side (pasteMd,
// clipHtmlToMd, clipOfRange) needs a browser. Run by tests/test_md_roundtrip.py.
"use strict";

const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "../../src/enqueue/static/js/md.js"), "utf8");
const { clipTextToMd, clipToMd, spliceMd } = new Function(
  "esc",
  src + "\nreturn { clipTextToMd, clipToMd, spliceMd };",
)((s) => s);

const C = "";
const A = "";
let failed = 0;
let total = 0;
const eq = (name, got, want) => {
  total++;
  if (got === want) return;
  failed++;
  console.log(`FAIL ${name}\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`);
};

// ---- text from other apps ------------------------------------------------------
eq("markdown bullets pass through", clipTextToMd("- a\n- b"), "- a\n- b");
eq("glyph bullets become markers", clipTextToMd("• a\n•\tb\n◦ c"), "- a\n- b\n- c");
eq("numbers with a bracket", clipTextToMd("1) a\n2) b"), "1. a\n2. b");
eq(
  "any indent width is one level",
  clipTextToMd("• a\n    ◦ b\n        ▪ c\n• d"),
  "- a\n  - b\n    - c\n- d",
);
eq("a tab is a level", clipTextToMd("- a\n\t- b"), "- a\n  - b");
eq("blank lines between items go", clipTextToMd("- a\n\n- b\n\n\n- c"), "- a\n- b\n- c");
eq("a blank line before prose stays", clipTextToMd("- a\n\nafter"), "- a\n\nafter");
eq("windows line ends", clipTextToMd("- a\r\n- b\r\n"), "- a\n- b");
eq("prose is left alone", clipTextToMd("one\ntwo - three"), "one\ntwo - three");
eq("a hyphenated word is not a bullet", clipTextToMd("-dash\n*star*"), "-dash\n*star*");

eq("one line is typed, not pasted as blocks", clipToMd("just words", "").blocks, false);
eq("lines are blocks", clipToMd("a\nb", "").blocks, true);
eq("a single bullet is a block", clipToMd("• a", "").blocks, true);

// ---- where a paste lands -------------------------------------------------------
eq("text goes in at the caret", spliceMd(`ab${C}cd`, "X"), `abX${A}cd`);
eq("lines go in at the caret", spliceMd(`ab${C}cd`, "X\nY"), `abX\nY${A}cd`);
eq("a list goes under the paragraph", spliceMd(`intro${C}`, "- a\n- b"), `intro\n- a\n- b${A}`);
eq("a list replaces an empty line", spliceMd(`# T\n\n${C}`, "- a\n- b"), `# T\n\n- a\n- b${A}`);
eq(
  "a list splits the paragraph it lands in",
  spliceMd(`ab${C}cd`, "- a"),
  `ab\n- a${A}\ncd`,
);
eq("a list joins the list it lands in", spliceMd(`- x${C}\n- y`, "- a\n- b"), `- x\n- a\n- b${A}\n- y`);
eq("at the depth of the item", spliceMd(`- x\n  - y${C}`, "- a\n  - b"), `- x\n  - y\n  - a\n    - b${A}`);
eq("an empty item is replaced", spliceMd(`- x\n- ${C}`, "- a\n- b"), `- x\n- a\n- b${A}`);
eq(
  "the rest of the item becomes its own",
  spliceMd(`1. on${C}e`, "- a"),
  `1. on\n- a${A}\n1. e`,
);
eq("no caret: at the end", spliceMd("x", "- a"), `x\n\n- a${A}`);
eq("no caret, after a list: more of the list", spliceMd("- x", "- a"), `- x\n- a${A}`);

console.log(`${total - failed}/${total} clipboard cases hold`);
process.exit(failed ? 1 : 0);
