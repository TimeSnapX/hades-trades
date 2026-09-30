// Fails if any tracked text file has a UTF-8 BOM, CRLF line endings, invalid UTF-8
// or typical mojibake (UTF-8 read as cp1252). Guards the Windows publish path.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { encoding: "utf8" }).split("\n").filter((f) => f && !/\.(png|jpg|ico)$/.test(f) && fs.existsSync(f));
const bad = [];
const dec = new TextDecoder("utf-8", { fatal: true });
for (const f of files) {
  const b = fs.readFileSync(f);
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bad.push(`${f}: BOM`);
  let s;
  try { s = dec.decode(b); } catch { bad.push(`${f}: invalid UTF-8`); continue; }
  if (s.includes("\r\n")) bad.push(`${f}: CRLF`);
  if (/\u00c3[\u0080-\u00ff]|\u00e2\u20ac|\u00c2\u00b7/.test(s)) bad.push(`${f}: mojibake`);
}
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
console.log(`encoding OK (${files.length} files)`);
