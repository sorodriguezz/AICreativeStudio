#!/usr/bin/env node
// Prepara lo que el instalador lleva dentro, antes de `tauri build`:
//   1. Versiones exactas del motor (engine/bundle/*.txt) exportadas desde uv.lock:
//        core.txt       base (API, imagen, ONNX) — siempre se instala
//        torch.txt      torch + torchvision — se instala desde el índice de la variante (CUDA / CPU / PyPI)
//        diffusion.txt  resto de la difusión (diffusers, transformers, spandrel…) — sólo si torch se instaló
//   2. El binario de uv para la plataforma destino en src-tauri/binaries/uv-<target>[.exe].
//
// Uso: node scripts/prepare-bundle.mjs [--target <triple>]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const engine = join(root, "engine");
const UV_VERSION = "0.11.28";

const argTarget = process.argv.indexOf("--target");
const hostTriple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/host: (\S+)/)[1];
// Tauri define TAURI_ENV_TARGET_TRIPLE al ejecutar beforeBuildCommand (también con --target).
const target = argTarget > -1 ? process.argv[argTarget + 1] : process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple;
const isWindows = target.includes("windows");

// ---------- 1. Requisitos ----------
// Sin color ni anotaciones: en CI uv colorea los "# via …" y los códigos ANSI llegaban al instalador
// como requisitos inválidos ("Unexpected '\x1b[32m…'"), y el primer arranque fallaba.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const REQUIREMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]+\])?\s*(==|>=|<=|~=|!=|>|<|@)\s*\S[^\s;]*(\s*;\s*.+)?$/;
const exportReqs = (extra) => {
  const lines = execFileSync("uv", ["export", "--project", engine, "--frozen", "--no-hashes", "--no-dev", "--no-emit-project", "--no-header",
    "--no-annotate", "--color", "never", ...(extra ? ["--extra", extra] : [])], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR_FORCE: "0" } })
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("-e"));
  const bad = lines.filter((l) => !REQUIREMENT.test(l));
  if (bad.length) throw new Error(`uv export devolvió líneas que no son requisitos:\n${bad.join("\n")}`);
  return lines;
};
const name = (l) => l.split(/[=<>;\s]/)[0].toLowerCase();

const core = exportReqs();
const full = exportReqs("diffusion");
const coreNames = new Set(core.map(name));
const torch = full.filter((l) => ["torch", "torchvision"].includes(name(l))).map((l) => l.split(";")[0].trim());
const diffusion = full.filter((l) => !coreNames.has(name(l)) && !["torch", "torchvision"].includes(name(l)));

const out = join(engine, "bundle");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "core.txt"), core.join("\n") + "\n");
writeFileSync(join(out, "torch.txt"), torch.join("\n") + "\n");
writeFileSync(join(out, "diffusion.txt"), diffusion.join("\n") + "\n");
console.log(`requisitos: ${core.length} base, ${torch.join(" ")}, ${diffusion.length} de difusión`);

// Variantes CUDA publicadas para esta versión exacta de torch en Windows x64 (de más nueva a más vieja),
// con el driver NVIDIA mínimo de cada una. La app elige la mejor que soporte el driver del usuario.
const CUDA = [["cu130", 580], ["cu129", 575], ["cu128", 570], ["cu126", 560], ["cu124", 551]];
const torchVersion = torch.find((l) => l.startsWith("torch=="))?.split("==")[1];
const variants = [];
if (isWindows && !target.startsWith("aarch64")) {
  for (const [v, driver] of CUDA) {
    const html = await (await fetch(`https://download.pytorch.org/whl/${v}/torch/`)).text();
    if (html.includes(`torch-${torchVersion}+${v}-cp312-cp312-win_amd64.whl`)) variants.push({ name: v, min_driver: driver });
  }
}
writeFileSync(join(out, "torch-variants.json"), JSON.stringify({ torch: torchVersion, cuda: variants }, null, 2));
console.log(`variantes CUDA para ${target}: ${variants.map((v) => v.name).join(", ") || "ninguna (CPU / Metal)"}`);

// El código del motor viaja como recurso: sin cachés de bytecode ni tests.
const purge = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f === "__pycache__") rmSync(p, { recursive: true, force: true });
    else if (statSync(p).isDirectory()) purge(p);
  }
};
purge(join(engine, "src"));

// ---------- 2. uv ----------
const binDir = join(root, "src-tauri", "binaries");
mkdirSync(binDir, { recursive: true });
const dest = join(binDir, `uv-${target}${isWindows ? ".exe" : ""}`);
if (target === hostTriple && !process.env.UV_DOWNLOAD) {
  const local = execFileSync(isWindows ? "where" : "which", ["uv"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
  copyFileSync(local, dest);
} else {
  const archive = `uv-${target}.${isWindows ? "zip" : "tar.gz"}`;
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${archive}`;
  const tmp = mkdtempSync(join(tmpdir(), "uv-"));
  const file = join(tmp, archive);
  console.log(`descargando ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar uv: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  execFileSync("tar", ["-xf", file, "-C", tmp]);
  const find = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? find(join(dir, f)) : [join(dir, f)]));
  const bin = find(tmp).find((f) => /(^|[\\/])uv(\.exe)?$/.test(f));
  copyFileSync(bin, dest);
  rmSync(tmp, { recursive: true, force: true });
}
if (!isWindows) chmodSync(dest, 0o755);
console.log(`uv → ${dest} (${(statSync(dest).size / 1e6).toFixed(1)} MB)`);
if (!existsSync(dest)) process.exit(1);
