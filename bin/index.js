#!/usr/bin/env node
import chalk from "chalk";
import figlet from "figlet";
import generateCode from "../commands/generate.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version
let version = "1.0.0";
try {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")
  );
  version = pkg.version || "1.0.0";
} catch (e) {}

const terminalWidth = process.stdout.columns || 80;

console.clear();

// ─── BANNER + INFO BOX ──────────────────────────────
function drawBannerWithBox() {
  const cwd = process.cwd();

  const banner = figlet.textSync("Spark AI", {
    font: "Standard",
    horizontalLayout: "default",
    verticalLayout: "default",
    width: 80,
    whitespaceBreak: true,
  });

  const bannerLines = banner.split("\n");
  const bannerWidth = Math.max(...bannerLines.map((l) => l.length));

  const rawLines = [
    ` >_ Spark AI (v${version})`,
    ``,
    ` Spark AI | coder-model (/model to change)`,
    ` ${cwd}`,
  ];

  const coloredLines = [
    ` ${chalk.gray(">_")} ${chalk.bold.magenta("Spark AI")} ${chalk.gray(`(v${version})`)}`,
    ``,
    ` ${chalk.white("Spark AI")} ${chalk.gray("| coder-model (/model to change)")}`,
    ` ${chalk.gray(cwd)}`,
  ];

  const boxInnerWidth = Math.max(...rawLines.map((l) => l.length)) + 2;
  const gap = 4;

  const boxTop = chalk.gray("┌" + "─".repeat(boxInnerWidth) + "┐");
  const boxBottom = chalk.gray("└" + "─".repeat(boxInnerWidth) + "┘");

  function boxRow(colored, raw) {
    const pad = boxInnerWidth - raw.length;
    return chalk.gray("│") + colored + " ".repeat(Math.max(0, pad)) + chalk.gray("│");
  }

  const boxLines = [
    boxTop,
    boxRow(coloredLines[0], rawLines[0]),
    boxRow(coloredLines[1], rawLines[1]),
    boxRow(coloredLines[2], rawLines[2]),
    boxRow(coloredLines[3], rawLines[3]),
    boxBottom,
  ];

  const totalLines = Math.max(bannerLines.length, boxLines.length);
  const boxOffset = Math.floor((bannerLines.length - boxLines.length) / 2);

  for (let i = 0; i < totalLines; i++) {
    const leftLine = (bannerLines[i] || "").padEnd(bannerWidth);
    const boxIndex = i - boxOffset;
    const rightLine =
      boxIndex >= 0 && boxIndex < boxLines.length ? boxLines[boxIndex] : "";
    console.log(chalk.cyan(leftLine) + " ".repeat(gap) + rightLine);
  }
}

drawBannerWithBox();
console.log();
console.log(chalk.yellow("  ✨ AI Code Generator.") + "\n");
console.log(chalk.gray('  Type "exit", "quit" or Ctrl+C to stop the Terminal.\n'));
console.log(chalk.gray("━".repeat(terminalWidth)));
console.log();

// ─── INPUT ──────────────────────────────────────────
const w = terminalWidth - 2;
const TOP    = chalk.gray("─".repeat(w));
const BOTTOM = chalk.gray("─".repeat(w)) + chalk.gray("  ? for shortcuts");
const PREFIX_COLOR = chalk.gray("✔  ") + chalk.gray("Type your message or @path/to/file ");

async function getInput() {
  return new Promise((resolve) => {
    let buf = "";

    // ✅ Sirf 3 lines print karo — koi upar/neeche cursor movement nahi
    // Line 1: TOP
    // Line 2: PREFIX + cursor yahan rukta hai (NO \n)
    // After user types and hits enter → Line 3: BOTTOM
    process.stdout.write(TOP + "\n");   // line 1
    process.stdout.write(PREFIX_COLOR);
    // line 2 — cursor yahan, NO newline
    

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    function cleanup() {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onKey);
    }

    function onKey(key) {
      // Ctrl+C
      if (key === "\u0003") {
        cleanup();
        process.stdout.write("\n\n");
        console.log(chalk.gray("  Goodbye!\n"));
        process.exit(0);
      }

      // Enter
      if (key === "\r" || key === "\n") {
        if (buf.trim().length === 0) return; // ignore empty
        cleanup();
        // ✅ Newline phir bottom line print karo
        process.stdout.write("\n" + BOTTOM + "\n\n");
        resolve(buf.trim());
        return;
      }

      // Backspace
      if (key === "\u007f" || key === "\b") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }

      // Printable char
      if (key >= " ") {
        buf += key;
        process.stdout.write(chalk.white(key));
      }
    }

    process.stdin.on("data", onKey);
  });
}

// ─── SHORTCUTS ──────────────────────────────────────
function showShortcuts() {
  console.log(chalk.gray("\n  Shortcuts:\n"));
  console.log("  " + chalk.white("exit, quit") + "   " + chalk.gray("→ Exit"));
  console.log("  " + chalk.white("?          ") + "   " + chalk.gray("→ Show shortcuts"));
  console.log("  " + chalk.white("clear      ") + "   " + chalk.gray("→ Clear screen"));
  console.log("  " + chalk.white("Ctrl+C     ") + "   " + chalk.gray("→ Force exit"));
  console.log();
}

process.on("SIGINT", () => {
  console.log(chalk.gray("\n\n  Goodbye!\n"));
  process.exit(0);
});

// ─── MAIN LOOP ───────────────────────────────────────
async function main() {
  while (true) {
    try {
      const input = await getInput();
      const trimmed = input.trim();

      if (trimmed === "?") {
        showShortcuts();
        continue;
      }

      if (trimmed.toLowerCase() === "clear") {
        console.clear();
        drawBannerWithBox();
        console.log();
        console.log(chalk.yellow("  ✨ AI Code Generator"));
        console.log(chalk.gray('  Type "exit", "quit" or Ctrl+C to stop\n'));
        console.log(chalk.gray("━".repeat(terminalWidth)));
        console.log();
        continue;
      }

      if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
        console.log(chalk.gray("\n  Goodbye!\n"));
        process.exit(0);
      }

      console.log();
      await generateCode(trimmed);
      console.log();

    } catch (error) {
      if (error.isTtyError || error.name === "ExitPromptError") {
        console.log(chalk.gray("\n\n  Goodbye!\n"));
        process.exit(0);
      }
      console.log(chalk.red("\n❌ Error:"), error.message);
      console.log();
    }
  }
}

main().catch((error) => {
  console.log(chalk.red("Fatal error:"), error.message);
  process.exit(1);
});
