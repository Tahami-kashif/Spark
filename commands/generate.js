import path from "path";
import axios from "axios";
import fs from "fs";
import open from "open";
import ora from "ora";
import chalk from "chalk";
import { execSync } from "child_process";
import { emitKeypressEvents } from "readline";
import inquirer from "inquirer";
import { spawn } from "child_process";
import { createInterface } from "readline";
import dotenv from "dotenv";

// Load .env file
dotenv.config();

// ============================================================
//  GLOBAL STATE
// ============================================================
let devServerProcess = null;
let devServerUrl = null;
let browserOpened = false;  // Track if browser was already opened (prevent infinite reload)
let isBuildingProject = false;  // Skip image detection during project build

// ============================================================
//  MCP (MODEL CONTEXT PROTOCOL) CLIENT — QWEN EXCLUSIVE
// ============================================================

/**
 * MCP Client for connecting to external tools and services
 * Qwen Code uses MCP to integrate with: databases, APIs, cloud services, etc.
 */
const MCP_SERVERS = {
  filesystem: { name: "File System", commands: ["read", "write", "list", "search"] },
  github: { name: "GitHub API", commands: ["repos", "issues", "pulls", "commits"] },
  database: { name: "Database", commands: ["query", "migrate", "seed"] },
  cloud: { name: "Cloud Deploy", commands: ["deploy", "logs", "status"] },
};

let mcpConnected = false;
let mcpServers = new Map();

/**
 * Initialize MCP connection to external servers
 */
async function initializeMCP() {
  if (mcpConnected) return;
  
  try {
    // Auto-connect to filesystem MCP (always available)
    mcpServers.set("filesystem", { connected: true, ...MCP_SERVERS.filesystem });
    
    // Check for MCP config file
    const mcpConfigPath = path.join(process.cwd(), ".mcp.json");
    if (fs.existsSync(mcpConfigPath)) {
      const config = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"));
      if (config.servers) {
        for (const server of config.servers) {
          mcpServers.set(server.name, { connected: true, ...server });
        }
      }
    }
    
    mcpConnected = true;
  } catch (e) {
    mcpConnected = false;
  }
}

/**
 * Execute MCP command
 */
async function executeMCPCommand(server, command, params = {}) {
  if (!mcpServers.has(server)) {
    throw new Error(`MCP server "${server}" not connected`);
  }
  
  // Filesystem MCP — native implementation
  if (server === "filesystem") {
    switch (command) {
      case "read": return fs.readFileSync(params.path, "utf8");
      case "write": return fs.writeFileSync(params.path, params.content, "utf8");
      case "list": return fs.readdirSync(params.path);
      case "search": return searchInFilesMCP(params.query, params.path, params.ext);
    }
  }
  
  // GitHub MCP — API calls
  if (server === "github" && process.env.GITHUB_TOKEN) {
    const res = await axios.get(`https://api.github.com/${command}`, {
      headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` },
      params,
    });
    return res.data;
  }
  
  throw new Error(`MCP command "${command}" not implemented for "${server}"`);
}

function searchInFilesMCP(query, dir = process.cwd(), ext = ".ts,.tsx,.js,.jsx") {
  const results = [];
  const exts = new Set(ext.split(",").map(e => e.trim()));
  const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build"]);
  
  function walk(d, depth = 0) {
    if (depth > 6) return;
    try {
      for (const item of fs.readdirSync(d)) {
        if (SKIP.has(item)) continue;
        const full = path.join(d, item);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) { walk(full, depth + 1); continue; }
        if (!exts.has(path.extname(item))) continue;
        const src = fs.readFileSync(full, "utf8");
        const lines = src.split("\n");
        lines.forEach((line, i) => {
          if (line.toLowerCase().includes(query.toLowerCase())) {
            results.push({ file: path.relative(process.cwd(), full).replace(/\\/g, "/"), line: i + 1, text: line.trim().slice(0, 100) });
          }
        });
      }
    } catch {}
  }
  walk(dir);
  return results;
}

// ============================================================
//  WEB SEARCH & FETCH — QWEN EXCLUSIVE
// ============================================================

/**
 * Search the web for documentation, packages, APIs
 */
async function webSearch(query, options = {}) {
  const { provider = "duckduckgo", count = 5 } = options;
  
  console.log(chalk.gray(`  🔍 Searching web: "${query}"\n`));
  
  try {
    // DuckDuckGo HTML scraping (no API key needed)
    const res = await axios.get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 8000,
    });
    
    // Parse results from HTML
    const results = [];
    const resultRegex = /<a class="result__a" href="([^"]+)">([^<]+)<\/a>/g;
    let match;
    let i = 0;
    while ((match = resultRegex.exec(res.data)) && i < count) {
      results.push({ title: match[2], url: match[1], snippet: "" });
      i++;
    }
    
    return { success: true, results, provider };
  } catch (e) {
    // Fallback to simple suggestion
    return {
      success: true,
      results: [{ title: "Search on Google", url: `https://google.com/search?q=${encodeURIComponent(query)}`, snippet: "" }],
      provider: "google",
    };
  }
}

/**
 * Fetch content from a URL (documentation, APIs, etc.)
 */
async function webFetch(url) {
  console.log(chalk.gray(`  🌐 Fetching: ${url}\n`));
  
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0" },
      responseType: "text",
    });
    
    // Convert HTML to markdown (simplified)
    const html = res.data;
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 10000);
    
    return { success: true, content: text, title: url };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ============================================================
//  GIT INTEGRATION — QWEN EXCLUSIVE
// ============================================================

/**
 * Git operations wrapper
 */
const git = {
  isRepo() {
    try {
      execSync("git rev-parse --git-dir", { stdio: "pipe" });
      return true;
    } catch { return false; }
  },
  
  status() {
    try {
      const out = execSync("git status --porcelain", { encoding: "utf8" });
      return out.trim().split("\n").filter(Boolean).map(line => ({
        status: line.slice(0, 2).trim(),
        file: line.slice(3).trim(),
      }));
    } catch { return []; }
  },
  
  branch() {
    try {
      return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
    } catch { return "unknown"; }
  },
  
  log(limit = 5) {
    try {
      const out = execSync(`git log -n ${limit} --pretty=format:"%h|%an|%s|%ai"`, { encoding: "utf8" });
      return out.split("\n").map(line => {
        const [hash, author, message, date] = line.split("|");
        return { hash, author, message, date };
      });
    } catch { return []; }
  },
  
  diff(file) {
    try {
      return execSync(`git diff ${file}`, { encoding: "utf8" });
    } catch { return ""; }
  },
  
  add(files = ".") {
    try { execSync(`git add ${files}`, { stdio: "pipe" }); return true; } catch { return false; }
  },
  
  commit(message) {
    try { execSync(`git commit -m "${message}"`, { stdio: "pipe" }); return true; } catch { return false; }
  },
  
  push(branch = "main") {
    try { execSync(`git push origin ${branch}`, { stdio: "pipe" }); return true; } catch { return false; }
  },
  
  createBranch(name) {
    try { execSync(`git checkout -b ${name}`, { stdio: "pipe" }); return true; } catch { return false; }
  },
  
  merge(branch) {
    try { execSync(`git merge ${branch}`, { stdio: "pipe" }); return true; } catch { return false; }
  },
};

// ============================================================
//  DIFF/VISUALIZATION — QWEN EXCLUSIVE
// ============================================================

/**
 * Generate unified diff visualization
 */
function generateDiff(oldContent, newContent, filename = "file") {
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");
  
  const diff = [];
  diff.push(chalk.gray(`--- ${filename}`));
  diff.push(chalk.gray(`+++ ${filename}`));
  
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      diff.push(chalk.gray(`  ${oldLines[i]}`));
      i++; j++;
    } else {
      if (i < oldLines.length) {
        diff.push(chalk.red(`- ${oldLines[i]}`));
        i++;
      }
      if (j < newLines.length) {
        diff.push(chalk.green(`+ ${newLines[j]}`));
        j++;
      }
    }
  }
  
  return diff.join("\n");
}

/**
 * Show diff preview before applying changes
 */
async function showDiffPreview(filename, oldContent, newContent) {
  const bw = Math.min(process.stdout.columns || 88, 88);
  
  console.log(
    "\n" +
    chalk.hex(COLORS.borderDark)("╭") +
    chalk.hex(COLORS.infoStart).bold(" 📄 Preview Changes ") +
    chalk.hex(COLORS.infoEnd)("─".repeat(bw - 20)) +
    chalk.hex(COLORS.borderDark)("╮") +
    "\n"
  );
  
  const diff = generateDiff(oldContent, newContent, filename);
  const lines = diff.split("\n").slice(0, 30); // Show first 30 lines
  
  for (const line of lines) {
    console.log(chalk.hex(COLORS.borderDark)("│") + "  " + line);
  }
  
  if (diff.split("\n").length > 30) {
    console.log(chalk.hex(COLORS.borderDark)("│") + "  " + chalk.gray("  ... and more changes"));
  }
  
  console.log(
    chalk.hex(COLORS.borderDark)("╰") +
    chalk.hex(COLORS.infoEnd)("─".repeat(bw)) +
    chalk.hex(COLORS.borderDark)("╯") +
    "\n"
  );
}

// ============================================================
//  TEST RUNNER — QWEN EXCLUSIVE
// ============================================================

/**
 * Auto-detect and run tests
 */
async function runTests(options = {}) {
  const { cwd = process.cwd(), watch = false, file = null } = options;
  
  // Detect test framework
  let testCommand = null;
  const pkgPath = path.join(cwd, "package.json");
  
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const scripts = pkg.scripts || {};
    
    if (scripts.test) {
      testCommand = scripts.test;
    } else if (pkg.devDependencies?.jest) {
      testCommand = "npx jest";
    } else if (pkg.devDependencies?.vitest) {
      testCommand = "npx vitest";
    } else if (pkg.devDependencies?.mocha) {
      testCommand = "npx mocha";
    }
  }
  
  if (!testCommand) {
    console.log(chalk.yellow("  ⚠️  No test framework detected\n"));
    return { detected: false };
  }
  
  if (file) {
    testCommand += ` ${file}`;
  }
  
  if (watch) {
    testCommand += " --watch";
  }
  
  console.log(chalk.cyan(`\n🧪 Running tests: ${testCommand}\n`));
  
  try {
    execSync(testCommand, { cwd, stdio: "inherit", timeout: 120000 });
    return { success: true, command: testCommand };
  } catch (e) {
    console.log(chalk.red("\n❌ Tests failed\n"));
    return { success: false, error: e.message };
  }
}

/**
 * Generate test file for a component/function
 */
function generateTestFile(sourcePath, framework = "auto") {
  const ext = path.extname(sourcePath);
  const base = path.basename(sourcePath, ext);
  const dir = path.dirname(sourcePath);
  
  // Auto-detect framework
  if (framework === "auto") {
    const pkgPath = path.join(process.cwd(), "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.devDependencies?.vitest) framework = "vitest";
      else if (pkg.devDependencies?.jest) framework = "jest";
      else framework = "vitest"; // Default
    }
  }
  
  const testPath = path.join(dir, `${base}.test.${ext.replace("tsx", "ts").replace("jsx", "js")}`);
  
  const testContent = {
    vitest: `import { describe, it, expect } from "vitest";
import ${base} from "./${base}";

describe("${base}", () => {
  it("should render correctly", () => {
    // TODO: Add test implementation
    expect(${base}).toBeDefined();
  });
});
`,
    jest: `import { ${base} } from "./${base}";

describe("${base}", () => {
  it("should work correctly", () => {
    // TODO: Add test implementation
    expect(${base}).toBeDefined();
  });
});
`,
  }[framework] || testContent.vitest;
  
  return { path: testPath, content: testContent, framework };
}

// ============================================================
//  CODE REVIEW & LINTING — QWEN EXCLUSIVE
// ============================================================

/**
 * Run linter and return issues
 */
async function runLint(file = null) {
  const cwd = process.cwd();
  let lintCommand = "npm run lint";
  
  // Check if lint script exists
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (!pkg.scripts?.lint) {
      // Auto-detect linter
      if (pkg.devDependencies?.eslint) {
        lintCommand = "npx eslint";
      } else if (pkg.devDependencies?.biome) {
        lintCommand = "npx biome check";
      } else if (pkg.devDependencies?.oxlint) {
        lintCommand = "npx oxlint";
      }
    }
  }
  
  if (file) {
    lintCommand += ` ${file}`;
  }
  
  console.log(chalk.gray(`  🔍 Linting${file ? `: ${file}` : " project"}...\n`));
  
  try {
    const output = execSync(lintCommand, { cwd, encoding: "utf8", stdio: "pipe" });
    return { success: true, output, issues: parseLintOutput(output) };
  } catch (e) {
    const output = e.stdout?.toString() || e.stderr?.toString() || e.message;
    return { success: false, output, issues: parseLintOutput(output) };
  }
}

function parseLintOutput(output) {
  const issues = [];
  const lines = output.split("\n");
  
  for (const line of lines) {
    // ESLint pattern: file:line:col error message
    const eslintMatch = line.match(/([^:]+):(\d+):(\d+)\s+(error|warning)\s+(.+)/i);
    if (eslintMatch) {
      issues.push({
        file: eslintMatch[1],
        line: parseInt(eslintMatch[2]),
        column: parseInt(eslintMatch[3]),
        type: eslintMatch[4],
        message: eslintMatch[5],
      });
    }
  }
  
  return issues.slice(0, 20); // Limit to 20 issues
}

/**
 * Code review analysis
 */
async function codeReview(filePaths = []) {
  const bw = Math.min(process.stdout.columns || 88, 88);
  
  console.log(
    "\n" +
    chalk.hex(COLORS.borderDark)("╭") +
    chalk.hex(COLORS.primaryStart).bold(" 🔍 Code Review ") +
    chalk.hex(COLORS.primaryEnd)("─".repeat(bw - 17)) +
    chalk.hex(COLORS.borderDark)("╮") +
    "\n"
  );
  
  const issues = [];
  const suggestions = [];
  
  for (const file of filePaths) {
    const fp = path.join(process.cwd(), file);
    if (!fs.existsSync(fp)) continue;
    
    const content = fs.readFileSync(fp, "utf8");
    const lines = content.split("\n");
    
    // Check for common issues
    lines.forEach((line, i) => {
      // console.log without await
      if (line.includes("console.log")) {
        issues.push({ file, line: i + 1, type: "warning", message: "Remove console.log in production" });
      }
      if (line.includes("any") && line.includes(":")) {
        issues.push({ file, line: i + 1, type: "warning", message: "Avoid using 'any' type" });
      }
      if (line.length > 120) {
        issues.push({ file, line: i + 1, type: "info", message: "Line exceeds 120 characters" });
      }
      if (/var\s+\w+/.test(line)) {
        issues.push({ file, line: i + 1, type: "warning", message: "Use let/const instead of var" });
      }
    });
    
    // File-level checks
    if (lines.length > 500) {
      suggestions.push({ file, message: `Consider splitting ${file} (${lines.length} lines) into smaller modules` });
    }
    
    if (!content.includes("export") && file.includes("component")) {
      suggestions.push({ file, message: `${file} appears to be a component but has no exports` });
    }
  }
  
  // Display results
  if (issues.length === 0 && suggestions.length === 0) {
    console.log(chalk.green("  ✓ No issues found!\n"));
  } else {
    for (const issue of issues.slice(0, 10)) {
      const icon = issue.type === "error" ? "✗" : issue.type === "warning" ? "⚠" : "ℹ";
      const color = issue.type === "error" ? "red" : issue.type === "warning" ? "yellow" : "blue";
      console.log(chalk[color](`  ${icon} ${issue.file}:${issue.line} - ${issue.message}`));
    }
    
    for (const sug of suggestions.slice(0, 5)) {
      console.log(chalk.gray(`  💡 ${sug.file} - ${sug.message}`));
    }
  }
  
  console.log(
    chalk.hex(COLORS.borderDark)("╰") +
    chalk.hex(COLORS.primaryEnd)("─".repeat(bw)) +
    chalk.hex(COLORS.borderDark)("╯") +
    "\n"
  );
  
  return { issues, suggestions };
}

// ============================================================
//  DEPENDENCY GRAPH — QWEN EXCLUSIVE
// ============================================================

/**
 * Build dependency graph for project files
 */
function buildDependencyGraph(dir = process.cwd(), maxDepth = 3) {
  const graph = new Map(); // file -> dependencies
  const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo"]);
  const SCAN_EXTS = new Set([".tsx", ".jsx", ".ts", ".js"]);
  
  function resolveImport(fromFile, importPath) {
    const fromDir = path.dirname(fromFile);
    let resolved = path.join(fromDir, importPath);
    
    // Try extensions
    for (const ext of ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"]) {
      const tryPath = resolved + ext;
      if (fs.existsSync(tryPath)) return path.relative(dir, tryPath).replace(/\\/g, "/");
    }
    
    return null;
  }
  
  function walk(d, depth = 0) {
    if (depth > maxDepth) return;
    
    try {
      for (const item of fs.readdirSync(d)) {
        if (SKIP.has(item)) continue;
        const full = path.join(d, item);
        const stat = fs.statSync(full);
        
        if (stat.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        
        if (!SCAN_EXTS.has(path.extname(item))) continue;
        
        const relPath = path.relative(dir, full).replace(/\\/g, "/");
        const content = fs.readFileSync(full, "utf8");
        const deps = [];
        
        // Find imports
        const importRegex = /(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
        let match;
        while ((match = importRegex.exec(content)) !== null) {
          const importPath = match[1];
          if (!importPath.startsWith(".") && !importPath.startsWith("/")) continue; // Skip node_modules
          
          const resolved = resolveImport(relPath, importPath);
          if (resolved) deps.push(resolved);
        }
        
        graph.set(relPath, deps);
      }
    } catch {}
  }
  
  walk(dir);
  return graph;
}

/**
 * Visualize dependency graph
 */
function visualizeDependencyGraph(graph, entryFile = null) {
  const bw = Math.min(process.stdout.columns || 88, 88);
  
  console.log(
    "\n" +
    chalk.hex(COLORS.borderDark)("╭") +
    chalk.hex(COLORS.infoStart).bold(" 📊 Dependency Graph ") +
    chalk.hex(COLORS.infoEnd)("─".repeat(bw - 21)) +
    chalk.hex(COLORS.borderDark)("╮") +
    "\n"
  );
  
  // Find entry points (files with no dependents)
  const allFiles = Array.from(graph.keys());
  const allDeps = new Set(Array.from(graph.values()).flat());
  const entryPoints = entryFile 
    ? [entryFile]
    : allFiles.filter(f => !allDeps.has(f) || f.includes("page") || f.includes("index"));
  
  function printTree(file, indent = 0, visited = new Set()) {
    if (indent > 5) return; // Limit depth
    if (visited.has(file)) {
      console.log("  ".repeat(indent) + chalk.gray("○") + " " + chalk.gray(file + " (circular)"));
      return;
    }
    visited.add(file);
    
    const icon = indent === 0 ? "📄" : "├─";
    console.log("  ".repeat(indent) + chalk.hex("#7C9EFF")(icon) + " " + chalk.white(file));
    
    const deps = graph.get(file) || [];
    for (const dep of deps.slice(0, 8)) {
      printTree(dep, indent + 1, new Set(visited));
    }
    
    if (deps.length > 8) {
      console.log("  ".repeat(indent + 1) + chalk.gray(`... and ${deps.length - 8} more`));
    }
  }
  
  for (const entry of entryPoints.slice(0, 5)) {
    printTree(entry);
    console.log("");
  }
  
  console.log(
    chalk.hex(COLORS.borderDark)("╰") +
    chalk.hex(COLORS.infoEnd)("─".repeat(bw)) +
    chalk.hex(COLORS.borderDark)("╯") +
    "\n"
  );
}

// ============================================================
//  PROJECT TEMPLATES — QWEN EXCLUSIVE
// ============================================================

const PROJECT_TEMPLATES = {
  "nextjs-app": {
    name: "Next.js App Router",
    framework: "nextjs",
    files: {
      "package.json": `{
  "name": "nextjs-app",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "next": "latest",
    "react": "latest",
    "react-dom": "latest"
  },
  "devDependencies": {
    "@types/node": "latest",
    "@types/react": "latest",
    "typescript": "latest",
    "tailwindcss": "latest",
    "eslint": "latest",
    "eslint-config-next": "latest"
  }
}`,
      "app/layout.tsx": `export const metadata = {
  title: "Next.js App",
  description: "Generated by Spark CLI",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
      "app/page.tsx": `export default function Home() {
  return (
    <main className="min-h-screen p-8">
      <h1 className="text-4xl font-bold">Welcome to Next.js</h1>
      <p className="mt-4 text-gray-600">Start building your amazing app!</p>
    </main>
  );
}
`,
      "app/globals.css": `@tailwind base;
@tailwind components;
@tailwind utilities;
`,
      "tailwind.config.js": `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
`,
    },
  },
  
  "react-vite": {
    name: "React + Vite",
    framework: "react",
    files: {
      "package.json": `{
  "name": "react-vite-app",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "eslint src --ext ts,tsx"
  },
  "dependencies": {
    "react": "latest",
    "react-dom": "latest"
  },
  "devDependencies": {
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "@vitejs/plugin-react": "latest",
    "typescript": "latest",
    "vite": "latest",
    "eslint": "latest",
    "eslint-plugin-react": "latest"
  }
}`,
      "src/App.tsx": `function App() {
  return (
    <div className="min-h-screen">
      <h1 className="text-4xl font-bold">React + Vite</h1>
    </div>
  );
}

export default App;
`,
      "src/main.tsx": `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`,
    },
  },
  
  "express-api": {
    name: "Express API",
    framework: "express",
    files: {
      "package.json": `{
  "name": "express-api",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest"
  },
  "dependencies": {
    "express": "latest",
    "cors": "latest",
    "dotenv": "latest"
  },
  "devDependencies": {
    "@types/express": "latest",
    "@types/node": "latest",
    "typescript": "latest",
    "tsx": "latest",
    "vitest": "latest"
  }
}`,
      "src/index.ts": `import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Express API is running!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`Server running on http://localhost:\${PORT}\`);
});
`,
    },
  },
};

/**
 * Scaffold project from template
 */
async function scaffoldFromTemplate(templateName, projectName) {
  const template = PROJECT_TEMPLATES[templateName];
  if (!template) {
    throw new Error(`Template "${templateName}" not found. Available: ${Object.keys(PROJECT_TEMPLATES).join(", ")}`);
  }
  
  const projectPath = path.join(process.cwd(), projectName);
  
  console.log(chalk.cyan(`\n📦 Scaffolding ${template.name}...\n`));
  
  let created = 0;
  for (const [filePath, content] of Object.entries(template.files)) {
    const full = path.join(projectPath, filePath);
    const dir = path.dirname(full);
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(full, content, "utf8");
    console.log(chalk.green(`  ✓ ${filePath}`));
    created++;
  }
  
  console.log(chalk.cyan(`\n✨ ${created} files created!\n`));
  console.log(chalk.gray(`  Next steps:\n`));
  console.log(chalk.white(`    cd ${projectName}`));
  console.log(chalk.white(`    npm install`));
  console.log(chalk.white(`    npm run dev\n`));
  
  return { success: true, path: projectPath, files: created };
}

// ============================================================
//  PERFORMANCE PROFILER — QWEN EXCLUSIVE
// ============================================================

/**
 * Analyze bundle size and performance
 */
async function analyzePerformance(options = {}) {
  const { cwd = process.cwd() } = options;
  
  console.log(chalk.cyan("\n⚡ Performance Analysis\n"));
  
  const issues = [];
  const suggestions = [];
  
  // 1. Check for large dependencies
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    
    const LARGE_DEPS = {
      "lodash": "Consider using lodash-es or native methods",
      "moment": "Use date-fns or dayjs (smaller)",
      "axios": "Consider native fetch API",
      "ramda": "Use native array methods",
    };
    
    for (const [dep, suggestion] of Object.entries(LARGE_DEPS)) {
      if (allDeps[dep]) {
        suggestions.push({ type: "dependency", package: dep, message: suggestion });
      }
    }
  }
  
  // 2. Check for unoptimized images
  const imageExts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
  const images = [];
  
  function findImages(dir, depth = 0) {
    if (depth > 5) return;
    try {
      for (const item of fs.readdirSync(dir)) {
        if (["node_modules", ".git", ".next"].includes(item)) continue;
        const full = path.join(dir, item);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          findImages(full, depth + 1);
          continue;
        }
        if (imageExts.some(ext => item.endsWith(ext))) {
          images.push({ path: path.relative(cwd, full), size: stat.size });
        }
      }
    } catch {}
  }
  
  findImages(cwd);
  
  for (const img of images) {
    if (img.size > 500 * 1024) { // > 500KB
      issues.push({ type: "image", file: img.path, size: img.size, message: "Large image - consider compression" });
    }
  }
  
  // 3. Check for missing optimizations
  const nextConfigPath = path.join(cwd, "next.config.js");
  if (fs.existsSync(nextConfigPath)) {
    const config = fs.readFileSync(nextConfigPath, "utf8");
    if (!config.includes("images")) {
      suggestions.push({ type: "config", message: "Add next.config.js image optimization" });
    }
  }
  
  // 4. Check for console.logs in production code
  const sourceFiles = [];
  function findSourceFiles(dir, depth = 0) {
    if (depth > 5) return;
    try {
      for (const item of fs.readdirSync(dir)) {
        if (["node_modules", ".git", ".next"].includes(item)) continue;
        const full = path.join(dir, item);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          findSourceFiles(full, depth + 1);
          continue;
        }
        if ([".tsx", ".jsx", ".ts", ".js"].includes(path.extname(item))) {
          sourceFiles.push(full);
        }
      }
    } catch {}
  }
  findSourceFiles(cwd);
  
  let consoleCount = 0;
  for (const file of sourceFiles.slice(0, 50)) {
    try {
      const content = fs.readFileSync(file, "utf8");
      const matches = content.match(/console\.(log|warn|error|debug)/g);
      if (matches) consoleCount += matches.length;
    } catch {}
  }
  
  if (consoleCount > 10) {
    suggestions.push({ type: "cleanup", message: `Found ${consoleCount} console statements - remove for production` });
  }
  
  // Display results
  const bw = Math.min(process.stdout.columns || 88, 88);
  console.log(
    "\n" +
    chalk.hex(COLORS.borderDark)("╭") +
    chalk.hex(COLORS.warningStart).bold(" ⚡ Performance Report ") +
    chalk.hex(COLORS.warningEnd)("─".repeat(bw - 23)) +
    chalk.hex(COLORS.borderDark)("╮") +
    "\n"
  );
  
  if (issues.length === 0 && suggestions.length === 0) {
    console.log(chalk.green("  ✓ No performance issues detected!\n"));
  } else {
    for (const issue of issues) {
      console.log(chalk.yellow(`  ⚠ ${issue.file} - ${issue.message}`));
    }
    
    for (const sug of suggestions) {
      console.log(chalk.gray(`  💡 ${sug.type}: ${sug.message}`));
    }
  }
  
  console.log(
    chalk.hex(COLORS.borderDark)("╰") +
    chalk.hex(COLORS.warningEnd)("─".repeat(bw)) +
    chalk.hex(COLORS.borderDark)("╯") +
    "\n"
  );
  
  return { issues, suggestions };
}

// ============================================================
//  INTERACTIVE CHAT MODE — QWEN EXCLUSIVE
// ============================================================

/**
 * Interactive chat mode with conversation threading
 */
async function startChatMode() {
  console.log(
    "\n" +
    chalk.hex(COLORS.borderDark)("╭") +
    chalk.hex(COLORS.primaryStart).bold(" ✦ Spark Interactive Chat ") +
    chalk.hex(COLORS.primaryEnd)("─".repeat(50)) +
    chalk.hex(COLORS.borderDark)("╮") +
    "\n" +
    chalk.hex(COLORS.borderDark)("│") +
    "  " +
    chalk.hex(COLORS.successStart)("Type your message and press Enter") +
    chalk.hex(COLORS.borderDark)(" ".repeat(40)) +
    chalk.hex(COLORS.borderDark)("│") +
    "\n" +
    chalk.hex(COLORS.borderDark)("│") +
    "  " +
    chalk.hex(COLORS.textDim)("Commands: /help, /clear, /exit, /history") +
    chalk.hex(COLORS.borderDark)(" ".repeat(35)) +
    chalk.hex(COLORS.borderDark)("│") +
    "\n" +
    chalk.hex(COLORS.borderDark)("╰") +
    chalk.hex(COLORS.primaryEnd)("─".repeat(70)) +
    chalk.hex(COLORS.borderDark)("╯") +
    "\n"
  );
  
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  
  const conversationHistory = [];
  
  const prompt = () => {
    return new Promise((resolve) => {
      rl.question(chalk.hex("#7C9EFF").bold("\nYou: "), (answer) => {
        resolve(answer.trim());
      });
    });
  };
  
  while (true) {
    const input = await prompt();
    
    if (!input) continue;
    if (input.toLowerCase() === "/exit" || input.toLowerCase() === "/quit") {
      console.log(chalk.green("\n  Goodbye!\n"));
      rl.close();
      return;
    }
    
    if (input.toLowerCase() === "/clear") {
      conversationHistory.length = 0;
      console.log(chalk.gray("\n  Conversation cleared\n"));
      continue;
    }
    
    if (input.toLowerCase() === "/history") {
      console.log(chalk.cyan("\n📜 Conversation History:\n"));
      conversationHistory.forEach((msg, i) => {
        const role = msg.role === "user" ? chalk.blue("You") : chalk.green("Spark");
        console.log(`${i + 1}. ${role}: ${msg.content.slice(0, 80)}${msg.content.length > 80 ? "..." : ""}`);
      });
      console.log("");
      continue;
    }
    
    // Add to history
    conversationHistory.push({ role: "user", content: input });
    
    // Generate response
    await generateCode(input, 0);
    
    // Keep history manageable
    if (conversationHistory.length > 20) {
      conversationHistory.splice(0, conversationHistory.length - 20);
    }
  }
}

// ============================================================
//  SMART PATH RESOLVER  (Absolute + Relative + Drive support)
// ============================================================

/**
 * Detect if a path string is absolute (Windows or Unix).
 * Examples:
 *   "C:/Users/Ali/myapp"   → true
 *   "C:\\folder\\sub"      → true
 *   "/home/user/project"   → true
 *   "~/Desktop/app"        → true
 *   "landing-page-app"     → false
 *   "./components/Foo.tsx" → false
 */
function isAbsolutePath(p) {
  if (!p) return false;
  // Windows drive: C:\ or C:/
  if (/^[a-zA-Z]:[\\\/]/.test(p)) return true;
  // Unix absolute
  if (p.startsWith("/")) return true;
  // Home dir shorthand
  if (p.startsWith("~")) return true;
  return false;
}

/**
 * Expand ~ to actual home directory (cross-platform).
 */
function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || process.env.HOMEPATH || "";
    return home + p.slice(1);
  }
  return p;
}

/**
 * Resolve a file/folder path from user input.
 * - If absolute (C:\, /home/, ~/) → use as-is (expand ~ first)
 * - If relative → join with process.cwd()
 * - Normalizes Windows/Unix separators
 *
 * Examples:
 *   resolvePath("C:/Users/Ali/myapp")          → "C:\\Users\\Ali\\myapp"
 *   resolvePath("landing-page-app/app/page.tsx")→ "<cwd>/landing-page-app/..."
 *   resolvePath("~/Desktop/project")           → "C:\\Users\\Ali\\Desktop\\project"
 */
function resolvePath(p) {
  if (!p) return process.cwd();
  const expanded = expandHome(p);
  if (isAbsolutePath(expanded)) return path.normalize(expanded);
  return path.join(process.cwd(), expanded);
}

/**
 * Parse user prompt for absolute path mentions.
 * Detects patterns like:
 *   "create folder in C drive"         → C:\
 *   "make folder in C:/Projects"       → C:/Projects
 *   "create in D:/work/myapp"          → D:/work/myapp
 *   "save to /home/user/projects"      → /home/user/projects
 *   "create folder at ~/Desktop"       → ~/Desktop
 *   "C folder mn banao"                → C:\  (Urdu)
 *   "D drive mn folder"                → D:\
 *
 * Returns extracted path string or null if not found.
 */
function extractAbsolutePath(prompt) {
  const p = prompt;

  // Pattern 1: explicit drive path  C:/... or C:\...
  const drivePathRe = /\b([a-zA-Z]):([\/\\][^\s"'`]*)?/g;
  let m = drivePathRe.exec(p);
  if (m) {
    const drive = m[1].toUpperCase();
    const rest  = m[2] || "\\";
    return `${drive}:${rest}`;
  }

  // Pattern 2: Unix absolute  /home/user/...
  const unixRe = /(\/[a-zA-Z0-9_.~-]+(?:\/[a-zA-Z0-9_.~-]+)*)/g;
  m = unixRe.exec(p);
  if (m) return m[1];

  // Pattern 3: ~ home
  const homeRe = /(~\/[^\s"'`]*)/g;
  m = homeRe.exec(p);
  if (m) return m[1];

  // Pattern 4: "in C drive" / "C folder mn" / "C drive mn" (Urdu/English)
  const driveWordRe = /\b([a-dA-D])\s*(?:drive|folder|disk|:\\|:\\\\|:\/|drive\s*mn|drive\s*mein|:\s*mn|:\s*mein)\b/i;
  m = driveWordRe.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\`;

  // Pattern 5: just single letter + ":" e.g. "C: mn banao"
  const colonRe = /\b([a-dA-D]):\s/;
  m = colonRe.exec(p);
  if (m) return `${m[1].toUpperCase()}:\\`;

  return null;
}

// ============================================================
//  QWEN-STYLE BOX SYSTEM — ENHANCED PROFESSIONAL EDITION
// ============================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════════
//  ULTRA PROFESSIONAL BOX CONFIGURATION
//  Gradient colors, glow effects, animated borders, premium feel
// ══════════════════════════════════════════════════════════════════════════════

// Premium color palette — Pure Gray Monochrome
const COLORS = {
  // Primary gradient — Pure gray scale
  primaryStart:   "#6B7280",  // gray-500
  primaryMid:     "#4B5563",  // gray-600
  primaryEnd:     "#374151",  // gray-700
  
  // Success gradient — Muted green gray
  successStart:   "#6EE7B7",  // emerald-300
  successMid:     "#34D399",  // emerald-400
  successEnd:     "#059669",  // emerald-600
  
  // Warning gradient — Muted amber gray
  warningStart:   "#FCD34D",  // amber-300
  warningEnd:     "#D97706",  // amber-600
  
  // Error gradient — Muted rose gray
  errorStart:     "#FDA4AF",  // rose-300
  errorEnd:       "#E11D48",  // rose-600
  
  // Info gradient — Muted blue gray
  infoStart:      "#93C5FD",  // blue-300
  infoEnd:        "#64748B",  // slate-500
  
  // Pure Gray Borders — Main box colors
  borderDark:     "#1F2937",  // gray-800 (dark border)
  borderLight:    "#374151",  // gray-700 (light border)
  borderSubtle:   "#4B5563",  // gray-600 (subtle border)
  
  // Text Colors
  textBright:     "#F9FAFB",  // gray-50 (bright text)
  textDim:        "#9CA3AF",  // gray-400 (dim text)
  textMuted:      "#6B7280",  // gray-500 (muted text)
  
  // Backgrounds
  bgDark:         "#111827",  // gray-900
  bgLight:        "#1F2937",  // gray-800
};

// Box configurations — ALL PURE GRAY
const BOX_CFG = {
  thinking: { 
    icon: "◈", 
    label: "Thinking", 
    gradient: ["#6B7280", "#4B5563", "#374151"],  // Pure gray
    glow: "#6B7280",
    animate: true 
  },
  reading: { 
    icon: "◎", 
    label: "Reading", 
    gradient: ["#6B7280", "#4B5563"],  // Pure gray
    glow: "#6B7280",
    animate: true 
  },
  writing: { 
    icon: "✎", 
    label: "Writing", 
    gradient: ["#6B7280", "#4B5563"],  // Pure gray
    glow: "#6B7280",
    animate: true 
  },
  running: { 
    icon: "▶", 
    label: "Running", 
    gradient: ["#6B7280", "#4B5563"],  // Pure gray
    glow: "#6B7280",
    animate: true 
  },
  done: { 
    icon: "✓", 
    label: "Done", 
    gradient: ["#6B7280", "#4B5563", "#374151"],  // Pure gray
    glow: "#6B7280",
    animate: false 
  },
  plan: { 
    icon: "☰", 
    label: "Plan", 
    gradient: ["#6B7280", "#4B5563"],  // Pure gray
    glow: "#6B7280",
    animate: false 
  },
  linking: { 
    icon: "⇢", 
    label: "Linking", 
    gradient: ["#6B7280", "#4B5563"],  // Pure gray
    glow: "#6B7280",
    animate: true 
  },
  analyzing: {
    icon: "⌬",
    label: "Analyzing",
    gradient: ["#6B7280", "#4B5563", "#374151"],  // Pure gray
    glow: "#6B7280",
    animate: true
  },
  creating: {
    icon: "✦",
    label: "Creating",
    gradient: ["#6B7280", "#4B5563"],  // Pure gray
    glow: "#6B7280",
    animate: true
  },
  error: { 
    icon: "✗", 
    label: "Error", 
    gradient: ["#6B7280", "#4B5563"],  // Pure gray
    glow: "#6B7280",
    animate: false 
  },
  success: {
    icon: "★",
    label: "Success",
    gradient: ["#6B7280", "#4B5563"],  // Pure gray
    glow: "#6B7280",
    animate: false
  },
  waiting: {
    icon: "◌",
    label: "Waiting",
    gradient: ["#6B7280", "#9CA3AF"],  // Pure gray
    glow: "#6B7280",
    animate: true
  },
};

// ══════════════════════════════════════════════════════════════════════════════
//  GRADIENT TEXT GENERATOR
//  Creates smooth color transitions across text
// ══════════════════════════════════════════════════════════════════════════════

function createGradient(text, colors) {
  if (colors.length === 1) return chalk.hex(colors[0])(text);
  
  const step = (colors.length - 1) / (text.length - 1 || 1);
  let result = "";
  
  for (let i = 0; i < text.length; i++) {
    const colorIndex = Math.min(Math.floor(i * step), colors.length - 1);
    const nextIndex = Math.min(colorIndex + 1, colors.length - 1);
    
    if (colorIndex === nextIndex) {
      result += chalk.hex(colors[colorIndex])(text[i]);
    } else {
      // Interpolate between colors
      const t = (i * step) % 1;
      const color = interpolateColor(colors[colorIndex], colors[nextIndex], t);
      result += chalk.hex(color)(text[i]);
    }
  }
  
  return result;
}

function interpolateColor(color1, color2, t) {
  const r1 = parseInt(color1.slice(1, 3), 16);
  const g1 = parseInt(color1.slice(3, 5), 16);
  const b1 = parseInt(color1.slice(5, 7), 16);
  
  const r2 = parseInt(color2.slice(1, 3), 16);
  const g2 = parseInt(color2.slice(3, 5), 16);
  const b2 = parseInt(color2.slice(5, 7), 16);
  
  const r = Math.round(r1 + (r2 - r1) * t);
  const g = Math.round(g1 + (g2 - g1) * t);
  const b = Math.round(b1 + (b2 - b1) * t);
  
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  GLOW EFFECT GENERATOR
//  Adds subtle glow/bloom around text
// ══════════════════════════════════════════════════════════════════════════════

function withGlow(text, glowColor, intensity = 0.3) {
  // Create subtle glow by layering slightly offset text
  const dimGlow = chalk.hex(glowColor).dim;
  return text; // Simplified for terminal compatibility
}

// ══════════════════════════════════════════════════════════════════════════════
//  ANIMATED SPINNER FRAMES (Premium)
// ══════════════════════════════════════════════════════════════════════════════

const SPINNERS = {
  dots: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"],
  stars: ["✦","✧","✦","✵","✦","✧","✦","✵"],
  arrows: ["◐","◓","◑","◒"],
  pulse: ["●","◐","○","◑"],
  bars: ["▏","▎","▍","▌","▋","▊","▉","█"],
  sparkle: ["✨","⚡","✨","◇","✨","⚡"],
  hex: ["⬡","⬢","⬡","⬢"],
};

// AI-generated rotating spinner messages — shown while model is thinking
const THINKING_MSGS = [
  "Analyzing your codebase...",
  "Reading the file structure...",
  "Consulting the neural weights...",
  "Thinking really hard...",
  "Parsing your intent...",
  "Traversing the thought space...",
  "Generating the optimal solution...",
  "Cross-referencing best practices...",
  "Calibrating response quality...",
  "Mapping your request to code...",
  "Evaluating all possibilities...",
  "Synthesizing the answer...",
  "Checking for edge cases...",
  "Almost there, hold on...",
  "Running internal simulations...",
  "Consulting the training data...",
  "Crafting a clean solution...",
  "Thinking outside the box...",
  "Optimizing for elegance...",
  "Deep in the decision tree...",
  "Assembling the code blocks...",
  "Scanning for the best approach...",
  "Weighing the trade-offs...",
  "Just a moment of brilliance...",
  "Connecting the dots...",
  "Navigating the solution space...",
  "Building something beautiful...",
  "Compiling thoughts into code...",
  "Loading neural pathways...",
  "Aligning quantum states...",
  "Tuning the parameters...",
  "Refining the output...",
];

function getThinkingMsg() {
  return THINKING_MSGS[Math.floor(Math.random() * THINKING_MSGS.length)];
}

// Animated thinking dots — loops like a real AI spinner
const THINK_FRAMES = SPINNERS.dots;

async function showThinkingBox(userPrompt) {
  const bw = Math.min(process.stdout.columns || 80, 88);
  const text = userPrompt.replace(/[\r\n|]/g, " ").trim();

  // Classify task
  const lp = text.toLowerCase();
  let taskLabel = "Thinking";
  if (lp.includes("image") || lp.includes("photo")) taskLabel = "Updating images";
  else if (lp.includes("create") || lp.includes("banao")) taskLabel = "Creating";
  else if (lp.includes("fix") || lp.includes("error")) taskLabel = "Fixing issue";
  else if (lp.includes("edit") || lp.includes("change")) taskLabel = "Editing";
  else if (lp.includes("start") || lp.includes("run")) taskLabel = "Starting";

  // Clean minimal header - QWEN BLUE with italic style
  process.stdout.write("\n");
  // Use ANSI italic code directly
  process.stdout.write("\x1b[3m" + chalk.hex("#7C9EFF").bold("  " + taskLabel) + "\x1b[0m\n");
  
  // User prompt - clean, truncated if needed
  const displayText = text.length > 60 ? text.slice(0, 57) + "..." : text;
  process.stdout.write(chalk.hex("#9CA3AF")("  " + displayText) + "\n\n");
  
  // Minimal spinner with smooth animation - QWEN BLUE
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const statusMessages = [
    "Analyzing",
    "Processing",
    "Generating",
    "Finalizing",
  ];
  
  let frame = 0, msgIdx = 0;
  const totalFrames = 24;
  
  for (let i = 0; i < totalFrames; i++) {
    if (i > 0 && i % 6 === 0) msgIdx = Math.min(msgIdx + 1, statusMessages.length - 1);
    
    const spinner = chalk.hex("#7C9EFF")(spinnerFrames[frame % spinnerFrames.length]);
    const status = chalk.hex("#7C9EFF")(statusMessages[msgIdx]);
    const dots = ".".repeat((i % 4));
    
    const line = `  ${spinner}  ${status}${dots}`;
    const pad = " ".repeat(Math.max(0, 40 - line.length));
    
    process.stdout.write("\r" + line + pad);
    frame++;
    await new Promise(r => setTimeout(r, 80));
  }
  
  // Clean done state
  process.stdout.write("\r" + " ".repeat(50) + "\r");
  process.stdout.write(chalk.hex("#34D399").bold("  ✓ Done") + "\n\n");
}

const BORDER = chalk.hex(COLORS.borderDark);   // │  └  ┘  ─  ┌  ┐
const BODY   = chalk.hex(COLORS.textBright);   // text inside box
const HINT   = chalk.hex(COLORS.textDim);      // secondary meta text

// ══════════════════════════════════════════════════════════════════════════════
//  CLEAN MINIMAL BOX — QWEN BLUE
// ══════════════════════════════════════════════════════════════════════════════

async function showBox(type, lines = []) {
  const cfg = BOX_CFG[type] || BOX_CFG.thinking;
  const { icon, label } = cfg;

  // QWEN BLUE for thinking/reading/writing, GRAY for others
  const isBlue = type === "thinking" || type === "reading" || type === "writing" || type === "running" || type === "linking" || type === "analyzing" || type === "plan";
  const headerColor = isBlue ? "#7C9EFF" : "#6B7280";

  // Clean header - QWEN BLUE
  process.stdout.write("\n");
  process.stdout.write(chalk.hex(headerColor).bold(`  ${icon} ${label}`) + "\n");
  
  // Content lines - clean, minimal
  for (const line of lines) {
    process.stdout.write(chalk.hex("#9CA3AF")("    " + line) + "\n");
    await sleep(30);
  }
  
  process.stdout.write("\n");
}

// ══════════════════════════════════════════════════════════════════════════════
//  CLEAN FILE READING — QWEN BLUE
// ══════════════════════════════════════════════════════════════════════════════

async function showReadingFile(filePath, lineCount, hint = "") {
  const rel = filePath.replace(process.cwd(), "").replace(/\\/g, "/").replace(/^\//, "");

  process.stdout.write("\n");
  process.stdout.write(chalk.hex("#7C9EFF").bold("  ◎ Reading") + "\n");  // QWEN BLUE
  process.stdout.write(chalk.hex("#9CA3AF")("    " + rel) + "\n");
  process.stdout.write(chalk.hex("#7C9EFF")("    " + lineCount + " lines") + "\n");  // QWEN BLUE
  
  if (hint) {
    process.stdout.write(chalk.hex("#9CA3AF")("    → " + hint.slice(0, 50)) + "\n");
  }
  
  process.stdout.write("\n");
  await sleep(50);
}

// ══════════════════════════════════════════════════════════════════════════════
//  PREMIUM SPINNER — Multi-style animated spinner
// ══════════════════════════════════════════════════════════════════════════════

function runSpinner(label = "Processing") {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  const colors = [
    COLORS.primaryStart,
    COLORS.primaryMid,
    COLORS.primaryEnd,
    COLORS.infoStart,
    COLORS.infoEnd,
  ];
  let i = 0;
  const iv = setInterval(() => {
    const color = colors[i % colors.length];
    process.stdout.write("\r  " + chalk.hex(color)(frames[i++ % frames.length]) + " " + chalk.hex(COLORS.textDim)(label + "…") + "   ");
  }, 70);
  return () => { clearInterval(iv); process.stdout.write("\r" + " ".repeat(60) + "\r"); };
}


// ============================================================
//  MEMORY SYSTEM
// ============================================================
const MEMORY_FILE = path.join(process.cwd(), ".memory.json");

function saveMemory(message, role = "user") {
  try {
    let history = [];
    if (fs.existsSync(MEMORY_FILE)) {
      const content = fs.readFileSync(MEMORY_FILE, "utf8");
      if (content.trim()) {
        const data = JSON.parse(content);
        history = data.history || [];
      }
    }
    history.push({ role, content: message, timestamp: new Date().toISOString() });
    if (history.length > 50) history = history.slice(history.length - 50);
    fs.writeFileSync(
      MEMORY_FILE,
      JSON.stringify({ last: history[history.length - 1]?.content || null, history }, null, 2)
    );
  } catch {}
}

function getConversationHistory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return [];
    const content = fs.readFileSync(MEMORY_FILE, "utf8");
    if (!content.trim()) return [];
    return JSON.parse(content).history || [];
  } catch {
    return [];
  }
}

function getLastUserMessage() {
  const h = getConversationHistory();
  for (let i = h.length - 1; i >= 0; i--) if (h[i].role === "user") return h[i].content;
  return null;
}

function getLastAssistantMessage() {
  const h = getConversationHistory();
  for (let i = h.length - 1; i >= 0; i--) if (h[i].role === "assistant") return h[i].content;
  return null;
}

function clearMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) fs.unlinkSync(MEMORY_FILE);
  } catch {}
}

// ============================================================
//  STARTUP DEEP ANALYZER  (Runs once on first CLI launch)
// ============================================================

const STARTUP_DONE_FILE = path.join(process.cwd(), ".spark_analyzed");

/**
 * Read ALL project files deeply — not just key files.
 * Returns array of { path, lines, content, summary }
 */




// ── Slash command definitions ────────────────────────────────────────────────
export const SLASH_COMMANDS_LIST = [
  // ── Core ──────────────────────────────────────────────────────────────────
  { cmd: "/help",             desc: "Show all available slash commands"              },
  { cmd: "/clear",            desc: "Clear screen and reset conversation history"    },
  { cmd: "/undo",             desc: "Restore last edited file from backup"           },
  { cmd: "/history",          desc: "Show last 10 conversation turns"                },
  { cmd: "/status",           desc: "Project info, file count, session stats"        },
  { cmd: "/chat",             desc: "Start interactive chat mode"                    },
  // ── Scaffolding ───────────────────────────────────────────────────────────
  { cmd: "/fast",             desc: "Scaffold a full FastAPI project in current dir" },
  { cmd: "/template",         desc: "Create project from template (nextjs, react, express)" },
  // ── SpecKit Plus ──────────────────────────────────────────────────────────
  { cmd: "/sp.constitution",  desc: "Generate CONSTITUTION.md — AI rules & principles"     },
  { cmd: "/sp.specify",       desc: "Generate SPECIFICATION.md — full project spec"         },
  { cmd: "/sp.task",          desc: "Generate TASK.md — current task breakdown"             },
  { cmd: "/sp.plan",          desc: "Generate PLAN.md — step-by-step implementation plan"   },
  { cmd: "/sp.implement",     desc: "Generate IMPLEMENTATION.md — code structure & patterns"},
  // ── Qwen Exclusive Features ─────────────────────────────────────────────
  { cmd: "/search",           desc: "Search the web for documentation and packages"        },
  { cmd: "/fetch",            desc: "Fetch content from a URL"                             },
  { cmd: "/git",              desc: "Git operations (status, commit, push, branch)"        },
  { cmd: "/github",           desc: "Auto-create repo & push (or type 'push to github')"   },
  { cmd: "/test",             desc: "Run tests with auto-detection"                        },
  { cmd: "/lint",             desc: "Run linter and show issues"                           },
  { cmd: "/review",           desc: "Code review and best practices check"                 },
  { cmd: "/graph",            desc: "Visualize dependency graph"                           },
  { cmd: "/profile",          desc: "Performance analysis and optimization tips"           },
  { cmd: "/mcp",              desc: "MCP server status and commands"                       },
];

// ── Readline completer — export this to CLI entry for tab-autocomplete ────────
export function slashCompleter(line) {
  if (!line.startsWith("/")) return [[], line];
  const hits = SLASH_COMMANDS_LIST
    .filter(c => c.cmd.startsWith(line.toLowerCase()))
    .map(c => c.cmd);
  return [hits.length ? hits : [], line];
}

// ── Show slash dropdown inline — call when user types "/" ─────────────────────
export function showSlashMenu(typed = "/") {
  const bw = Math.min(process.stdout.columns || 92, 96);
  const matches = SLASH_COMMANDS_LIST.filter(c =>
    c.cmd.startsWith(typed.toLowerCase())
  );
  if (matches.length === 0) return;

  // Clean header - QWEN BLUE
  console.log("");
  console.log(chalk.hex("#7C9EFF").bold("  Commands") + "\n");
  
  // Command list - all /commands in BLUE
  for (const { cmd, desc } of matches) {
    const cmdLen = typed.length;
    const typed_ = chalk.hex("#7C9EFF").bold(cmd.slice(0, cmdLen));  // FULL BLUE
    const rest = chalk.hex("#7C9EFF")(cmd.slice(cmdLen));  // FULL BLUE
    const padding = " ".repeat(Math.max(1, 20 - cmd.length));
    
    console.log(
      "  " +
      typed_ + rest +
      chalk.hex("#9CA3AF")(padding) +
      chalk.hex("#9CA3AF")(desc)
    );
  }
  
  console.log("");
}

// ══════════════════════════════════════════════════════════════════════════════
//  askWithSlashMenu — Show commands on "/"
// ══════════════════════════════════════════════════════════════════════════════
export async function askWithSlashMenu(promptText = "") {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  return new Promise((resolve) => {
    // First show available commands
    console.log("\n" + chalk.hex("#7C9EFF").bold("  Available commands:") + "\n");
    for (const cmd of SLASH_COMMANDS_LIST) {
      console.log(
        chalk.hex("#7C9EFF").bold("  " + cmd.cmd) +
        chalk.hex("#9CA3AF")("  ".repeat(Math.max(1, 2 - cmd.cmd.length / 4)) + cmd.desc)
      );
    }
    console.log("");
    
    rl.question(promptText || "Type your message: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}



export async function runStartupAnalysis() {
  // ── ONCE per session — if terminal is alive, cache stays, no re-scan ─────
  if (global.__sparkAnalyzed) return;
  global.__sparkAnalyzed = true;

  const cwd = process.cwd();

  const hasProject = fs.existsSync(path.join(cwd, "package.json"))
    || fs.existsSync(path.join(cwd, "index.html"))
    || fs.existsSync(path.join(cwd, "app"))
    || fs.existsSync(path.join(cwd, "src"))
    || fs.existsSync(path.join(cwd, "pages"));

  if (!hasProject) {
    console.log(chalk.hex("#6B7280")("\n  No project found. Try: ") + chalk.hex("#34D399")("create a nextjs app") + "\n");
    return;
  }

  // ── Build & cache EVERYTHING at once ─────────────────────────────────────
  const ctx = buildProjectContext();

  const projectName = ctx.packageJson !== "none"
    ? (() => { try { return JSON.parse(ctx.packageJson).name || path.basename(cwd); } catch { return path.basename(cwd); } })()
    : path.basename(cwd);

  const totalFolders = (ctx.fileTree.match(/📁/g) || []).length;
  const totalFiles   = ctx.keyFiles.length;

  const bw = 70;
  const border = chalk.hex("#4B5563");
  const cornerTL = chalk.hex("#4B5563")("╭");
  const cornerTR = chalk.hex("#4B5563")("╮");
  const cornerBL = chalk.hex("#4B5563")("╰");
  const cornerBR = chalk.hex("#4B5563")("╯");
  const hLine = chalk.hex("#4B5563")("─");
  const vLine = chalk.hex("#4B5563")("│");

  // Show thinking box first - SLOWER
  console.log("");
  console.log(border("╭") + chalk.hex("#7C9EFF").bold(" ⌬ Scanning project files ") + border("─".repeat(bw - 28)) + border("╮"));
  console.log(border("│") + chalk.hex("#9CA3AF")("  Analyzing project structure...").padEnd(bw - 2) + border("│"));
  console.log(border("╰") + border("─".repeat(bw)) + border("╯"));
  console.log("");
  
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  for (let i = 0; i < 20; i++) {
    const spinner = chalk.hex("#7C9EFF")(spinnerFrames[i % spinnerFrames.length]);
    const dots = ".".repeat((i % 4));
    process.stdout.write("\r  " + spinner + "  Scanning files" + dots);
    await new Promise(r => setTimeout(r, 150));  // SLOWER: 150ms
  }
  process.stdout.write("\r" + " ".repeat(40) + "\r");
  console.log("");

  // Analysis complete box
  console.log(border("╭") + chalk.hex("#7C9EFF").bold(" ✓ Analysis complete ") + border("─".repeat(bw - 24)) + border("╮"));
  console.log(border("│") + chalk.hex("#9CA3AF")("  Project: " + projectName).padEnd(bw - 2) + border("│"));
  console.log(border("│") + chalk.hex("#9CA3AF")("  Files: " + totalFiles + "  ·  Folders: " + totalFolders).padEnd(bw - 2) + border("│"));
  console.log(border("╰") + border("─".repeat(bw)) + border("╯"));
  console.log("");
  
  await sleep(300);

  // Clean file list with GRAY BOXES - SLOWER
  for (const file of ctx.keyFiles) {
    const rel = file.path.replace(/\\/g, "/");
    const fileName = rel.split("/").pop();
    const lines = file.lines;
    
    // Gray box for each file
    const fileNameShort = fileName.length > 30 ? fileName.slice(0, 27) + "..." : fileName;
    const relShort = rel.length > bw - 10 ? rel.slice(0, bw - 13) + "..." : rel;
    
    console.log(border("╭") + chalk.hex("#34D399").bold(" ✓ ") + chalk.hex("#9CA3AF")(fileNameShort) + border("─".repeat(bw - fileNameShort.length - 8)) + border("╮"));
    console.log(border("│") + chalk.hex("#6B7280")("  " + relShort + "  ·  " + lines + " lines").padEnd(bw - 2) + border("│"));
    console.log(border("╰") + border("─".repeat(bw)) + border("╯"));
    console.log("");
    
    await sleep(500);  // SLOWER: 500ms per file
  }

  // Clean done state with commands - GRAY BOX
  console.log(border("╭") + chalk.hex("#34D399").bold(" ✓ Ready  ") + chalk.hex("#6B7280")("(" + totalFiles + " files scanned)") + border("─".repeat(bw - totalFiles.toString().length - 25)) + border("╮"));
  console.log(border("│") + chalk.hex("#7C9EFF").bold("  Quick commands:").padEnd(bw - 2) + border("│"));
  console.log(border("│") + chalk.hex("#9CA3AF")("    /help       - Show all commands").padEnd(bw - 2) + border("│"));
  console.log(border("│") + chalk.hex("#9CA3AF")("    /status     - Project info").padEnd(bw - 2) + border("│"));
  console.log(border("│") + chalk.hex("#9CA3AF")("    /undo       - Restore last file").padEnd(bw - 2) + border("│"));
  console.log(border("│") + chalk.hex("#9CA3AF")("    @path/file  - Inject file content").padEnd(bw - 2) + border("│"));
  console.log(border("╰") + border("─".repeat(bw)) + border("╯"));
  console.log("");
}

// ============================================================
//  PROJECT ANALYSIS SYSTEM  (Qwen-style deep scan)
// ============================================================

function scanDirectory(dir, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return [];
  const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", "coverage", ".cache", "commands", "bin", "scripts"]);
  let results = [];
  try {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      if (SKIP.has(item)) continue;
      const fullPath = path.join(dir, item);
      try {
        const stat = fs.statSync(fullPath);
        const rel = path.relative(process.cwd(), fullPath);
        if (stat.isDirectory()) {
          results.push({ type: "dir", path: rel });
          results = results.concat(scanDirectory(fullPath, depth + 1, maxDepth));
        } else {
          results.push({ type: "file", path: rel, size: stat.size });
        }
      } catch {}
    }
  } catch {}
  return results;
}

function buildProjectContext() {
  const cwd = process.cwd();
  if (global.__projectCache) return global.__projectCache;
  const tree = scanDirectory(cwd);

  let framework = "unknown";
  let frameworkVersion = "";
  const pkgPath = path.join(cwd, "package.json");
  let packageJson = null;
  if (fs.existsSync(pkgPath)) {
    try {
      packageJson = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
      if (deps.next) { framework = "nextjs"; frameworkVersion = deps.next; }
      else if (deps["@remix-run/react"]) framework = "remix";
      else if (deps.nuxt) framework = "nuxt";
      else if (deps.vue) framework = "vue";
      else if (deps["@angular/core"]) framework = "angular";
      else if (deps.svelte) framework = "svelte";
      else if (deps.react) framework = "react";
      else if (deps.express) framework = "express";
      else if (deps.vite) framework = "vite";
    } catch {}
  }

  const keyFiles = [];
  const KEY_PATHS = [
    "app/page.tsx", "app/page.jsx", "app/layout.tsx", "app/layout.jsx",
    "pages/index.tsx", "pages/index.jsx", "pages/index.js",
    "src/App.tsx", "src/App.jsx", "src/app/page.tsx",
    "index.html", "index.js", "index.ts",
    "next.config.js", "next.config.ts", "next.config.mjs",
    "vite.config.js", "vite.config.ts",
    "tailwind.config.js", "tailwind.config.ts",
  ];

  // Also scan ALL .tsx/.jsx/.ts files in project for AI context
  const SCAN_EXTS = new Set([".tsx", ".jsx", ".ts", ".js", ".css", ".scss",".md"]);
  const SKIP_SCAN = new Set(["generate.js", "generate.ts", "spark.js", "cli.js", "index.js"]);
  const SKIP_SCAN_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", "commands", "bin", "scripts"]);

  function walkForContext(dir, depth = 0) {
    if (depth > 4) return;
    try {
      for (const item of fs.readdirSync(dir)) {
        if (SKIP_SCAN_DIRS.has(item)) continue;
        const full = path.join(dir, item);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) { walkForContext(full, depth + 1); continue; }
          if (SKIP_SCAN.has(item)) continue;
          const ext = path.extname(item);
          if (!SCAN_EXTS.has(ext)) continue;
          if (stat.size > 60000) continue;
          const rel = path.relative(cwd, full).replace(/\\/g, "/");
          // Skip if already in KEY_PATHS
          if (KEY_PATHS.includes(rel)) continue;
          try {
            const content = fs.readFileSync(full, "utf8");
            const lines = content.split("\n").slice(0, 200).join("\n");
            keyFiles.push({ path: rel, content: lines, lines: content.split("\n").length });
          } catch {}
        } catch {}
      }
    } catch {}
  }

  // First add KEY_PATHS
  for (const kp of KEY_PATHS) {
    const fp = path.join(cwd, kp);
    if (fs.existsSync(fp)) {
      try {
        const content = fs.readFileSync(fp, "utf8");
        const lines = content.split("\n").slice(0, 300).join("\n");
        keyFiles.push({ path: kp, content: lines, lines: content.split("\n").length });
      } catch {}
    }
  }

  // Then add ALL other project files
  walkForContext(cwd);

  const imageUsages = [];
  const IMAGE_EXTS = new Set([".tsx", ".jsx", ".js", ".ts", ".html", ".css", ".scss"]);
  const CLI_SKIP = new Set(["generate.js", "generate.ts", "spark.js", "cli.js", "index.js", "commands", "bin", "scripts"]);

  for (const item of tree) {
    if (item.type !== "file") continue;
    const ext = path.extname(item.path);
    if (!IMAGE_EXTS.has(ext)) continue;
    const segments = item.path.replace(/\\/g, "/").split("/");
    const isCLIFile = segments.some(seg => CLI_SKIP.has(seg));
    if (isCLIFile) continue;
    try {
      const content = fs.readFileSync(path.join(cwd, item.path), "utf8");
      const imgMatches = content.match(/(src|url|background)[^"'\n]*["'][^"'\n]*(unsplash|http|\.jpg|\.png|\.webp|\.gif|\.jpeg)[^"'\n]*["']/g);
      if (imgMatches && imgMatches.length > 0) {
        imageUsages.push({ file: item.path, usages: imgMatches.slice(0, 10) });
      }
    } catch {}
  }

  const treeString = tree
    .map(i => `${i.type === "dir" ? "📁" : "📄"} ${i.path}${i.size ? ` (${i.size}b)` : ""}`)
    .join("\n");

  const ctx = { framework, frameworkVersion, packageJson: packageJson ? JSON.stringify(packageJson, null, 2).slice(0, 800) : "none", fileTree: treeString, keyFiles, imageUsages, cwd };
  global.__projectCache = ctx;
  return ctx;
}

// ============================================================
//  UNSPLASH IMAGE FETCHER
// ============================================================

// ── Image keyword map for applyMultipleImagesDirectly ───────────────────────
// Unsplash API is called at runtime — these are just search keywords per category
const UNSPLASH_CURATED = {
  nature:      ["nature landscape","forest nature","mountain landscape","ocean waves","beach sunset"],
  landscape:   ["landscape scenic","mountain view","valley landscape","countryside","panorama"],
  watch:       ["luxury watch","wristwatch","chronograph watch","timepiece","watch fashion"],
  watches:     ["luxury watch","wristwatch","chronograph watch","timepiece","watch collection"],
  jewelry:     ["luxury jewelry","gold jewelry","diamond ring","necklace jewelry","gemstone"],
  jewellery:   ["luxury jewellery","gold jewellery","diamond jewellery","fine jewellery"],
  luxury:      ["luxury lifestyle","luxury product","premium quality","elegant luxury","opulent"],
  fashion:     ["fashion style","clothing fashion","outfit style","wardrobe fashion","apparel"],
  shoes:       ["sneakers shoes","footwear fashion","running shoes","boots leather","casual shoes"],
  tech:        ["technology gadget","laptop computer","smartphone tech","electronic device","innovation"],
  technology:  ["technology gadget","laptop computer","smartphone tech","electronic device"],
  food:        ["delicious food","restaurant meal","cuisine dish","gourmet food","healthy food"],
  coffee:      ["coffee espresso","latte coffee","barista coffee","cafe coffee","cappuccino"],
  business:    ["business professional","corporate meeting","office business","entrepreneur","team work"],
  office:      ["office workspace","desk setup","coworking space","business office","work environment"],
  people:      ["person portrait","people lifestyle","face portrait","individual person","human"],
  portrait:    ["portrait photography","face close up","person portrait","professional headshot"],
  city:        ["city urban","skyline city","downtown urban","metropolitan city","street urban"],
  abstract:    ["abstract art","colorful abstract","geometric design","creative abstract","artistic"],
  dark:        ["dark moody","dark aesthetic","dark background","night dark","shadow dark"],
  minimal:     ["minimal clean","minimalist design","simple clean","white minimal","modern minimal"],
  car:         ["luxury car","sports car","automobile car","vehicle car","car photography"],
  sports:      ["sports fitness","athlete sports","workout fitness","sport action","exercise"],
  gym:         ["gym fitness","workout gym","weight training","muscle fitness","exercise gym"],
  travel:      ["travel adventure","destination travel","vacation travel","explore travel","wanderlust"],
  music:       ["music instrument","guitar music","concert music","musician music","sound music"],
  art:         ["art creative","painting art","artwork creative","artistic design","canvas art"],
  background:  ["background texture","wallpaper pattern","abstract background","gradient design"],
  product:     ["product photography","item product","merchandise product","goods product","shopping"],
  all:         ["lifestyle product","modern design","beautiful scenery","professional photo","quality"],
};

// Fetch real image URLs from Unsplash API for a keyword array
async function fetchBatchImages(keywords, count = 20) {
  const allUrls = [];
  try {
    const apiKey = "49e37f9294f625c9cc4c9d82060906a52b7f0948d90e43b29a4a685ad8f65794";
    // Fetch in parallel for each keyword
    const results = await Promise.all(
      keywords.slice(0, 3).map(kw =>
        axios.get(
          `https://api.unsplash.com/search/photos?query=${encodeURIComponent(kw)}&per_page=10&client_id=${apiKey}`,
          { timeout: 8000 }
        ).then(r => r.data?.results || []).catch(() => [])
      )
    );
    for (const photos of results) {
      for (const p of photos) {
        allUrls.push(p.urls.regular); // complete signed URL
      }
    }
  } catch {}
  
  // Deduplicate
  const unique = [...new Set(allUrls)];
  
  // Picsum fallback if API returned nothing
  if (unique.length === 0) {
    return keywords.slice(0, count).map((kw, i) => 
      `https://picsum.photos/seed/${encodeURIComponent(kw.split(" ")[0])}-${i}/800/600`
    );
  }
  
  // Pad to count
  while (unique.length < count) unique.push(...unique);
  return unique.slice(0, count);
}


// ── Auto-fix next.config.js to allow all image hostnames ────────────────────
function ensureNextConfigImages(projectRoot) {
  const configNames = ["next.config.js", "next.config.ts", "next.config.mjs"];
  let configPath = null;

  for (const name of configNames) {
    const p = path.join(projectRoot, name);
    if (fs.existsSync(p)) { configPath = p; break; }
  }

  if (!configPath) {
    // Create next.config.js
    configPath = path.join(projectRoot, "next.config.js");
  }

  let current = "";
  try { current = fs.readFileSync(configPath, "utf8"); } catch {}

  // Already has remotePatterns with hostname ** or picsum/unsplash? skip
  if (current.includes("hostname: "**"") || 
      (current.includes("picsum.photos") && current.includes("images.unsplash.com"))) {
    return;
  }

  const newConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "**.unsplash.com" },
      { protocol: "https", hostname: "source.unsplash.com" },
      { protocol: "https", hostname: "**.pexels.com" },
      { protocol: "https", hostname: "**.pixabay.com" },
    ],
  },
};

export default nextConfig;
`;
  fs.writeFileSync(configPath, newConfig, "utf8");
  console.log(chalk.green("  ✓ next.config.js updated with image remotePatterns\n"));
}

// ── Image cache — stores API-fetched results per keyword ─────────────────────
const _imgCache = new Map(); // keyword → [url1, url2, ...]

// Fetch real images from Unsplash API for a keyword — returns array of URLs
async function fetchImagesBatch(keyword) {
  if (_imgCache.has(keyword)) return _imgCache.get(keyword);

  try {
    const apiKey = "49e37f9294f625c9cc4c9d82060906a52b7f0948d90e43b29a4a685ad8f65794";
    const res = await axios.get(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(keyword)}&per_page=10&client_id=${apiKey}`,
      { timeout: 7000 }
    );
    const photos = res.data?.results || [];
    if (photos.length > 0) {
      // urls.regular = complete signed URL, works directly in browser
      const urls = photos.map(p => p.urls.regular);
      _imgCache.set(keyword, urls);
      return urls;
    }
  } catch {}

  return null; // API failed
}

// Get one real image URL — keyword+index = unique photo
async function fetchImageUrl(keyword, index = 0) {
  const clean = keyword.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, "").slice(0, 50);
  const urls = await fetchImagesBatch(clean);

  if (urls && urls.length > 0) {
    return urls[index % urls.length];
  }

  // API unavailable — picsum fallback (reliable)
  return `https://picsum.photos/seed/${encodeURIComponent(clean)}-${index}/800/600`;
}

// Fetch multiple unique images for products list
async function fetchProductImages(keyword, count) {
  const urls = await Promise.all(
    Array.from({ length: count }, (_, i) => fetchImageUrl(keyword, i))
  );
  return urls;
}

// Legacy sync wrapper — used by old code paths (returns picsum if called sync)
function getCuratedImage(keyword, width = 800, height = 600, index = 0) {
  // Sync fallback — real URL fetched async in replaceImagesWithReal
  return `https://picsum.photos/seed/${encodeURIComponent(keyword)}-${index}/${width}/${height}`;
}

function getProductImages(keyword, count, width = 800, height = 600) {
  return Array.from({ length: count }, (_, i) =>
    `https://picsum.photos/seed/${encodeURIComponent(keyword)}-${i}/${width}/${height}`
  );
}

async function fetchUnsplashImage(query, width = 1920, height = 1080) {
  const keywords = query.toLowerCase().split(",").map(k => k.trim()).filter(Boolean);
  const searchQuery = keywords.join(" ");
  console.log(chalk.gray(`\n   🔍 Searching photos for: "${searchQuery}"\n`));

  try {
    const apiKey = "49e37f9294f625c9cc4c9d82060906a52b7f0948d90e43b29a4a685ad8f65794";
    const res = await axios.get(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(searchQuery)}&per_page=8&orientation=landscape&client_id=${apiKey}`,
      { timeout: 8000 }
    );
    const results = res.data?.results || [];
    if (results.length > 0) {
      const photo = results[Math.floor(Math.random() * Math.min(results.length, 5))];
      const url = photo.urls.regular; // complete URL — works directly
      console.log(chalk.green(`   ✓ Photo found: ${photo.user.name} on Unsplash\n`));
      return { url, credit: `Photo by ${photo.user.name} on Unsplash`, alt: searchQuery, source: "unsplash.com" };
    }
  } catch (e) {
    console.log(chalk.gray(`   ↻ Unsplash API unavailable\n`));
  }

  // Picsum last resort
  const url = `https://picsum.photos/seed/${encodeURIComponent(searchQuery)}/${width}/${height}`;
  return { url, credit: "picsum.photos", alt: searchQuery, source: "picsum.photos" };
}

function getReliableImageUrl(keyword, width = 800, height = 600, index = 0) {
  return `https://picsum.photos/seed/${encodeURIComponent(keyword)}-${index}/${width}/${height}`;
}

function cleanSubject(raw) {
  const FILLERS = /\b(ko|sa|se|ka|ki|ke|mein|par|hai|ho|hon|tou|to|for|only|just|please|ab|aur|nhi|nahi|magr|but|karo|karde|or|wala|wali|jaise|jaisa|lagao|laga|dalo|dal|from|the|my|a|an|s|background|image|images|bg|photo|photos|pic|pics|picture|img|hero|banner|section|page|website|site|product|products|item|items|card|cards|shop|store|catalog|collection|gallery|portfolio|feature|features|sab|saari|har|different|alag|ture|tures)\b/gi;
  return raw
    .trim()
    .toLowerCase()
    .replace(FILLERS, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, ",")
    .replace(/,{2,}/g, ",")
    .replace(/^,|,$/g, "")
    || "beautiful,landscape,nature";
}

function parseImageIntent(prompt) {
  const lower = prompt.toLowerCase();
  const hasImageWord = /\b(image|images|img|photo|photos|pic|pics|picture|pictures|background|bg|banner|hero|tasveer|tasveerein|thumbnail)\b/i.test(lower);
  const hasChangeWord = /\b(change|update|replace|set|put|add|use|make|show|lagao|lagado|lagana|laga|dalo|dal|karo|karde|karna|kar\s*do|kar\s*dein|badlo|badal|rakho|hon|chahiye)\b/i.test(lower);
  const urduPattern = /\b\w+\s+(ki|wali|ke|wale)\s+(pic|pics|photo|image|images|tasveer)\b/i.test(lower)
    || /\b(pic|pics|photo|image|images)\s+(wali|hon|ho|lagao|chahiye)\b/i.test(lower);

  if (!hasImageWord && !urduPattern) return { isImageChange: false, subject: null };
  if (!hasChangeWord && !urduPattern) return { isImageChange: false, subject: null };

  const STOP = /\b(and|also|change|update|replace|image|images|pic|pics|photo|photos|background|section|page|ko|sa|se|ka|ki|ke|mein|wala|wali|karo|karde|hon|ho|lagao|different|magr|aur|but|sab|saari|har)\b/i;
  const connRe = /(?:\bto\b|\bfor\b|\bwith\b|\binto\b|\blike\b)\s+([a-zA-Z][a-zA-Z0-9 ]{1,40})/gi;
  let m;
  while ((m = connRe.exec(prompt)) !== null) {
    let raw = m[1]; const stop = raw.match(STOP); if (stop) raw = raw.slice(0, stop.index);
    const s = cleanSubject(raw); if (s && s.length > 1) return { isImageChange: true, subject: s };
  }

  const waliRe = /([a-zA-Z][a-zA-Z0-9 ]{1,25})\s+(?:wali|wale|ki|ke)\s+(?:sab\s+)?(?:pic|pics|photo|image|images|tasveer)/gi;
  while ((m = waliRe.exec(prompt)) !== null) {
    const s = cleanSubject(m[1]); if (s && s.length > 1) return { isImageChange: true, subject: s };
  }
  const waliKaRe = /([a-zA-Z][a-zA-Z0-9 ]{1,30})\s+(?:wali|wale)\s+(?:kar|lagao|kar\s*do|kar\s*dein)/gi;
  while ((m = waliKaRe.exec(prompt)) !== null) {
    const s = cleanSubject(m[1]); if (s && s.length > 1) return { isImageChange: true, subject: s };
  }

  const beforePic = prompt.match(/([a-zA-Z]{3,})\s+(?:ki\s+)?(?:sab\s+)?(?:pic|pics|photo|photos|image|images)/i);
  if (beforePic) { const s = cleanSubject(beforePic[1]); if (s && s.length > 1) return { isImageChange: true, subject: s }; }

  const afterKaro = prompt.match(/([a-zA-Z]{3,}(?:\s+[a-zA-Z]{3,})?)\s+(?:ki\s+)?(?:sab\s+)?(?:pic|pics|image|images)\s+(?:hon|lagao|chahiye|karo)/i);
  if (afterKaro) { const s = cleanSubject(afterKaro[1]); if (s && s.length > 1) return { isImageChange: true, subject: s }; }

  const STRIP = /\b(change|update|replace|set|put|add|use|make|lagao|lagado|dalo|karo|karde|karna|kar\s*do|badlo|also|and|ab|my|the|a|an|this|from|hero|section|banner|page|website|site|background|image|images|pic|pics|photo|photos|picture|bg|product|products|item|items|feature|features|ko|sa|se|ka|ki|ke|mein|wala|wali|hon|ho|sab|saari|har|magr|different|alag|but|aur|nhi|nahi)\b/gi;
  const stripped = lower.replace(STRIP, " ").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const words = stripped.split(" ").filter(w => w.length > 2);
  if (words.length > 0) return { isImageChange: true, subject: cleanSubject(words.join(" ")) };

  return { isImageChange: true, subject: "nature,landscape" };
}

// ============================================================
//  SYSTEM PROMPT — FIXED: properly closed, complete
// ============================================================

function buildSystemPrompt(projectCtx) {
  // Always re-read key files fresh from disk so AI gets exact current content
  const freshKeyFiles = projectCtx.keyFiles.map(f => {
    const absPath = path.isAbsolute(f.path)
      ? f.path
      : path.join(projectCtx.cwd || process.cwd(), f.path);
    try {
      if (fs.existsSync(absPath)) {
        const fresh = fs.readFileSync(absPath, "utf8");
        return { ...f, content: fresh.split("\n").slice(0, 250).join("\n"), lines: fresh.split("\n").length };
      }
    } catch {}
    return f;
  });

  const keyFilesSection = freshKeyFiles.length > 0
    ? `\n## PROJECT KEY FILES (FRESH from disk — copy oldContent EXACTLY from here):\n${freshKeyFiles.map(f =>
        `### ${f.path} (${f.lines} lines)\n\`\`\`\n${f.content}\n\`\`\``
      ).join("\n\n")}`
    : "";

  const imageSection = projectCtx.imageUsages.length > 0
    ? `\n## CURRENT IMAGE USAGES IN PROJECT:\n${projectCtx.imageUsages.map(i =>
        `${i.file}:\n  ${i.usages.join("\n  ")}`
      ).join("\n")}`
    : "";

  // ── SYSTEM PROMPT STRING — properly opened AND closed ──────────────────────
  return `You are an intelligent AI assistant, developer, and file system manager with advanced capabilities.

## PROJECT CONTEXT (already scanned — use this, do NOT re-scan):
- Framework: ${projectCtx.framework} ${projectCtx.frameworkVersion}
- CWD: ${projectCtx.cwd}
- Package.json: ${projectCtx.packageJson}
- ALL FILES ANALYZED: Every .tsx/.jsx/.ts/.js file has been read on startup

## FILE TREE:
${projectCtx.fileTree}
${keyFilesSection}
${imageSection}

## YOUR CAPABILITIES:
1. Answer general questions
2. Create, read, edit, and manage files and folders
3. Generate and analyze code
4. Create multi-file projects
5. Detect framework/library requirements
6. Execute shell commands (with preview)
7. Open URLs and files
8. Plan and execute multi-step tasks
9. DIRECT FILE EDITING - You can directly modify files with edit_file action

## CRITICAL: YOU MUST ACTUALLY DO THE WORK
- When user says "change X", you MUST return edit_file with EXACT oldContent and newContent
- DO NOT just say "done" - you MUST actually edit the file
- Your edit_file action WILL be executed - so make sure oldContent matches EXACTLY
- The KEY FILES section above already has the file content — use it CHARACTER-FOR-CHARACTER
- After your edit_file executes, the file WILL be changed
- You are like a real developer - you ACTUALLY write code and edit files

## CRITICAL JSON RULES:
- Return EXACTLY ONE JSON object - nothing before, nothing after
- NO multiple JSON objects like: {"a":1}{"a":2} - this BREAKS the system
- NO arrays of actions
- NO trailing commas
- NO markdown code blocks
- Format: {"action": "...", ...}
- If task has multiple steps: do FIRST step only, system will continue
- NEVER repeat the same action - check if already done

## WORKFLOW FOR ANY TASK - CRITICAL:
1. PROJECT IS ALREADY SCANNED — key files are shown above, DO NOT run list_directory
2. ANALYZE: What exists? What's missing? What needs to be changed? (use the file tree + key files above)
3. FIND: Correct file paths from the tree shown above
4. IDENTIFY: Framework already detected: ${projectCtx.framework}
5. THEN: Take action in CORRECT location
6. AFTER: Self-review - did I complete the task?
7. NEVER show directory listings to user - analyze internally
8. Example: "add background to hero" → find page.tsx in key files above → edit it → done
9. NEVER ask user "which file?" - YOU find it from the tree above

## QWEN-STYLE BEHAVIOR:
- Analyze first → Work silently → Show only final result
- DO NOT ask "should I do this?" - just DO it
- DO NOT show intermediate steps - user sees only completion
- Like Qwen: Smart analysis + Silent execution + Clean results

## FILE EDITING RULES - CRITICAL:
- KEY FILES are already shown above — copy oldContent EXACTLY from there
- Match oldContent EXACTLY - even one character difference will fail
- Use the EXACT indentation, spacing, and formatting from the file shown above
- NEVER guess oldContent - copy it CHARACTER FOR CHARACTER from the key files section
- oldContent should be the SMALLEST unique snippet that identifies the location
  • Bad:  oldContent = entire 50-line function (more chance of mismatch)
  • Good: oldContent = just the 3-5 lines you are replacing
- If a line has JSX like className="...", copy it exactly with all attributes
- NEVER truncate oldContent with "..." — it must be real file content
- After any successful edit, the cache is updated automatically
- If edit fails: system will auto-read the file and retry — do NOT worry

## SELF-REVIEW LOOP - CRITICAL:
- After EVERY action, ANALYZE: "Is the task COMPLETE?"
- Ask yourself:
  • Did I fulfill ALL parts of the user's request?
  • Is everything working correctly?
  • Did I miss anything?
  • Are there any errors or broken things?
  • Did I ACTUALLY edit the file or just say I did?
  • Did I use the key files content to get exact oldContent?
  • Will the browser show the changes immediately?
- If ANYTHING is incomplete or broken → CONTINUE working automatically
- DO NOT stop until EVERYTHING is 100% complete
- NEVER say "done" unless you ACTUALLY did the work
- For UI changes: Tell user to hard refresh (Ctrl+Shift+R) if needed
- Think: "What else needs to be done?" after each step
- Example: Created file? → Check if it needs imports, dependencies, or server start
- Example: Server starting? → Wait for ready, then confirm it's running
- Loop continues until task is FULLY complete

## RESPONSE BEHAVIOR:
- For file creation: Directly return create_file action
- For starting apps: Directly return preview_command with the dev command
- For modifications: Use the key files content above — DO NOT re-read files
- NEVER return read_file action unless the file is NOT in key files above
- Work SILENTLY - user only sees final results, not your process
- If any error occurs, analyze it and automatically handle fixes

## ERROR HANDLING:
- If you detect error like "npm error", "Command failed", "ENOENT" - analyze and auto-fix
- For "npm run dev" failures - check if you need to cd into a subdirectory first
- Always propose fixes to user before applying them

## AMBIGUITY HANDLING:
- If request has ONE clear interpretation → execute immediately, never ask
- If request is genuinely ambiguous with 2+ very different outcomes → ask ONE specific question only
- Never ask more than one question at a time
- Example: "Create a login page" → just build it, no questions
- Example: "Update the database" → ask: "SQL migration or seed data?"

## FILE CONFLICT HANDLING:
- If file already exists and task says "create" → EDIT the existing file, do not recreate
- If task says "replace" or "redo" → overwrite completely
- Never silently skip a file that already exists — always act on it

## DEPENDENCY VERIFICATION:
- After any npm/pip/yarn install → verify with: npm list [package] or pip show [package]
- If verification fails → retry install automatically once, then report to user
- Never assume installation succeeded without checking

## SECURITY RULES:
- For destructive shell commands (rm -rf, DROP TABLE, format, overwrite) → preview to user first
- Never delete user data without explicit confirmation in the command preview
- For all other commands → execute directly as normal

## PARTIAL TASK COMPLETION — NEVER STOP MIDWAY:
- If task needs 5 files, create ALL 5
- If creating a full app: create layout + page + components + config ALL in sequence
- Never say "here is the first file, let me know if you want more" — just continue
- One request = full complete deliverable, no matter how many steps

## SMART CONTEXT READING — INFER INTENT:
- "make it look better" = improve UI/UX/colors/spacing
- "fix it" = find the bug and fix it, don't ask what to fix
- "add dark mode" = implement full dark mode toggle with state, not just CSS
- "make it fast" = optimize images, lazy loading, remove unused code
- "clean it up" = refactor + remove dead code + improve naming
- Always infer the FULL intent, not just the literal words

## SMART ACTION SELECTION — USE BEST TOOL:
- "delete this file" → delete_file (not edit_file to empty it)
- "rename X to Y" → rename_file (not delete + create)
- "move X to Y folder" → move_file
- "where is X used?" → search_in_files
- "find all uses of X" → search_in_files with query=X
- "install framer-motion" (no dev server) → run_command
- "update import in 3 files" → bulk_edit all 3 at once (faster than 3 edit_files)
- "refactor this function across files" → search_in_files first, then bulk_edit
- "duplicate this component" → copy_file
- "add API key to env" → add_env_var (updates both .env.local and .env.example)
- "create a new component" (simple, reusable) → scaffold_component (gets barrel export)
- "install X package" (no dev server needed) → run_command: npm install X

## MULTI-FILE AWARENESS — ALWAYS CHECK IMPACT:
- When editing file A, check if file B imports from A → update B too
- When renaming a function → find ALL usages across files → update all
- When adding a new route → also update navigation/sidebar/links if they exist
- When changing a type/interface → update all files that use that type

## PROGRESSIVE ENHANCEMENT — BUILD COMPLETE, NOT MINIMAL:
- Never create a bare-bones version unless user says "simple" or "minimal"
- Default: full featured, styled, responsive, with proper states (loading, error, empty)
- Always add: loading states, error boundaries, empty states where applicable
- Always add: proper TypeScript types, not just string or any
- Always add: accessibility basics (aria-label, alt text, semantic HTML)

## CODE COMPLETION — NO PLACEHOLDERS:
- NEVER write // TODO: implement this
- NEVER write // add your logic here
- NEVER write placeholder functions that return nothing
- Every function must be FULLY implemented

## STYLING COMPLETENESS:
- Never create unstyled components — always add Tailwind classes
- Always include: hover states, focus states, active states
- Always include: responsive breakpoints (sm: md: lg:)
- Always include: transitions/animations for interactive elements
- Consistent color palette — don't mix random colors

## IMPORT MANAGEMENT — ALWAYS COMPLETE:
- After creating/editing any file → check ALL imports are correct
- If you add a new component → make sure it is imported where used
- If you remove a function → make sure its import is also removed
- Never leave unused imports — remove them
- Always use correct relative paths for imports

## STATE MANAGEMENT AWARENESS:
- If project uses Redux/Zustand/Context → use it, don't create local state that conflicts
- If adding a feature that needs global state → add to existing store, don't create new one

## TERMINAL OUTPUT READING — AUTO DIAGNOSE:
- If terminal shows TypeScript error → fix the type issue automatically
- If terminal shows "Module not found" → install the missing package automatically
- If terminal shows port conflict → suggest next available port (3001, 3002...)
- If terminal shows ESLint errors → fix them automatically

## PACKAGE.JSON AWARENESS:
- Before installing any package → check if it is already in package.json
- If already installed → don't reinstall, just use it
- After adding new dependency → remind user to restart dev server

## RESPONSE LENGTH CALIBRATION:
- Simple task (1 file edit) → just do it, 1-line confirmation max
- Medium task (new feature) → do it, brief summary of what was added
- Large task (new project/major refactor) → do it, list main files created
- NEVER write paragraphs explaining what you are about to do — just DO it

## ABSOLUTE PATH SUPPORT — CRITICAL:
- If user mentions a drive like "C drive", "D drive", "C:/", "C:\\", "/home/user" → use that EXACT path
- For Windows: "create folder in C drive" → foldername: "C:\\NewFolder"
- For Windows: "create in D:/Projects" → foldername: "D:\\Projects\\myapp"
- For Unix: "create in /home/user/apps" → foldername: "/home/user/apps/myapp"
- For home dir: "save to ~/Desktop" → foldername: "~/Desktop/myapp"
- NEVER convert absolute paths to relative — keep them exactly as user specified
- If user says "C folder mn banao" or "C drive mn" → use "C:\\" as base path
- Examples:
  Input: "create a folder called myapp in C drive"
  Output: {"action": "create_folder", "foldername": "C:\\myapp"}
  
  Input: "create index.html in D:/Projects"
  Output: {"action": "create_file", "filename": "D:\\Projects\\index.html", "content": "..."}

## DYNAMIC PAGES — NEXT.JS CRITICAL RULES:
- Dynamic route folder MUST be named with brackets: app/products/[id]/page.tsx
- NEVER create app/products/[id].tsx — it MUST be a folder with page.tsx inside
- Page component MUST accept params as a prop:
  export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
  }
- generateStaticParams MUST return ALL item ids:
  export async function generateStaticParams() {
    return products.map(p => ({ id: String(p.id) }));
  }
- Links MUST use template literal:
  <Link href={"/products/" + item.id}>  NEVER: href="/products/[id]"

## DYNAMIC PAGE DATA — MOST CRITICAL RULE:
The dynamic page MUST show the EXACT item the user clicked.
WRONG pattern (shows same data for all):
  const product = { name: "Product", price: 99 }  // HARDCODED — BROKEN

CORRECT pattern (finds clicked item by id):
  // COPY the SAME data array from the list page — identical
  const products = [
    { id: "1", name: "Watch Pro", price: 299, description: "...", image: "https://picsum.photos/seed/product/800/600" },
    { id: "2", name: "Smart Band", price: 199, description: "...", image: "https://picsum.photos/seed/product/800/600" },
    { id: "3", name: "Classic Watch", price: 399, description: "...", image: "https://picsum.photos/seed/product/800/600" },
  ];
  const product = products.find(p => p.id === id);
  if (!product) return notFound();

## DYNAMIC PAGE IMAGE RULES:
- EVERY item in the data array MUST have its OWN unique image URL
- NEVER use the same image for all products
- Use DIFFERENT picsum seeds per item (CLI replaces with real Unsplash photos):
  item 1: https://picsum.photos/seed/product-1/800/600
  item 2: https://picsum.photos/seed/product-2/800/600
  item 3: https://picsum.photos/seed/product-3/800/600
  item 4: https://picsum.photos/seed/product-4/800/600
  item 5: https://picsum.photos/seed/product-5/800/600
- The image shown on dynamic page MUST be product.image (from the found item)
  NEVER: <img src={genericImage} />
  ALWAYS: <img src={product.image} alt={product.name} />

## FULL DYNAMIC PAGE TEMPLATE (follow this EXACTLY):
\`\`\`tsx
import { notFound } from "next/navigation";
import Link from "next/link";
import Image from "next/image";

// SAME data as list page — copy exactly
const products = [
  { id: "1", name: "Product One", price: 99, description: "Full description here.", image: "https://picsum.photos/seed/product/800/600", category: "Electronics" },
  { id: "2", name: "Product Two", price: 149, description: "Full description here.", image: "https://picsum.photos/seed/product/800/600", category: "Electronics" },
  { id: "3", name: "Product Three", price: 199, description: "Full description here.", image: "https://picsum.photos/seed/product/800/600", category: "Electronics" },
];

export async function generateStaticParams() {
  return products.map(p => ({ id: p.id }));
}

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = products.find(p => p.id === id);
  if (!product) return notFound();

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <Link href="/" className="text-blue-600 hover:underline mb-6 inline-block">← Back</Link>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <img src={product.image} alt={product.name} className="w-full rounded-2xl object-cover" />
          <div>
            <h1 className="text-3xl font-bold mb-4">{product.name}</h1>
            <p className="text-2xl font-semibold text-blue-600 mb-4">{product.price}</p>
            <p className="text-gray-600 mb-6">{product.description}</p>
            <button className="bg-blue-600 text-white px-8 py-3 rounded-xl hover:bg-blue-700 transition">Add to Cart</button>
          </div>
        </div>
      </div>
    </div>
  );
}
\`\`\`

- When creating a dynamic page, ALWAYS:
  1. Create the folder app/[route]/[id]/page.tsx
  2. Copy EXACT same data array from list page
  3. Each item has its own unique image URL
  4. Find item: products.find(p => p.id === id)
  5. Show product.image, product.name, product.price, product.description
  6. Add generateStaticParams with all ids
  7. Update list page: wrap cards with <Link href={"/route/" + item.id}>

## WHEN TASK IS GENUINELY IMPOSSIBLE:
- Don't pretend to do it
- Immediately explain WHY it is not possible
- Suggest the closest alternative that IS possible

## IMPORTANT:
- Return ONLY ONE action at a time - a single JSON object
- For multi-step tasks: Return FIRST action only, system will continue automatically
- NEVER return multiple JSON objects - this is INVALID
- NEVER return arrays of actions
- ALWAYS return exactly one: { "action": "...", ... }
- No trailing commas, no markdown, no extra text after JSON
- DO NOT repeat actions - if you already created a file, don't create it again

## AUTO MODE EXECUTION:
- When user says "auto", plan the ENTIRE task and execute all steps
- First: Create all necessary files/folders
- Then: Run commands (npm install, npm run dev, etc.)
- Do NOT repeat the same action
- Execute steps in order: create → install → verify → run

## IMAGES RULE - CRITICAL:
- ALWAYS use real working image URLs - NEVER use local paths like /image.jpg
- When a fetched_image_url is provided in the prompt → use THAT EXACT URL, no changes
- NEVER use source.unsplash.com — IT IS DEAD AND BROKEN, images will not load
- NEVER invent Unsplash photo IDs — they will 404

### IMAGE RULES — CRITICAL:

RULE 1: NEVER use source.unsplash.com — DEAD SERVICE
RULE 2: NEVER hardcode photo IDs like photo-1523275335684 — they give 404
RULE 3: NEVER use local paths like /image.jpg or ./img.png
RULE 4: NEVER use images.unsplash.com/photo-ID directly — needs signed URL

ONLY USE THIS FORMAT for all images:
  https://picsum.photos/seed/KEYWORD/WIDTH/HEIGHT

CRITICAL — seed MUST be the item subject (CLI uses it to fetch real Unsplash photos):
  watch page:      https://picsum.photos/seed/watch/800/600
  laptop product:  https://picsum.photos/seed/laptop/800/600
  coffee shop:     https://picsum.photos/seed/coffee/800/600
  hero banner:     https://picsum.photos/seed/hero/1920/1080
  team member:     https://picsum.photos/seed/person/400/400
  food item:       https://picsum.photos/seed/food/800/600

For MULTIPLE products — each MUST have its own unique descriptive seed:
  product 1: https://picsum.photos/seed/watch-gold/800/600
  product 2: https://picsum.photos/seed/watch-silver/800/600
  product 3: https://picsum.photos/seed/watch-sport/800/600
  product 4: https://picsum.photos/seed/watch-classic/800/600

NEVER use generic seeds like "product-1" — use SUBJECT: "nike-shoe", "iphone", "espresso"
CLI replaces these with real Unsplash API photos automatically at save time.

## RESPONSE FORMAT - ALWAYS RETURN VALID JSON:

### General Questions:
{"action": "answer", "response": "detailed answer"}

### Preview Command (REQUIRED before execution):
{"action": "preview_command", "command": "npm run dev", "cwd": "landing-page-app", "devUrl": "http://localhost:3000", "description": "Starting the Next.js development server"}

### List Directory (only if file NOT in key files above):
{"action": "list_directory", "path": "."}

### Read File (only if file NOT in key files above):
{"action": "read_file", "filename": "path/to/file.js"}

### Create File:
{"action": "create_file", "filename": "exact-name.ext", "content": "complete file content"}

### Edit File:
{"action": "edit_file", "filename": "app.js", "oldContent": "code to find", "newContent": "code to replace"}

### Create Folder:
{"action": "create_folder", "foldername": "folder-name"}

### Generate Code:
{"action": "generate_code", "filename": "output.html", "content": "complete code"}

### Multi-File Project:
{"action": "create_project", "projectName": "name", "files": [{"path": "index.html", "content": "..."}]}

### Framework Project:
{"action": "framework_required", "framework": "nextjs", "displayName": "Next.js", "packageName": "next", "checkCommand": "next --version", "installCommand": "npx create-next-app@latest .", "devCommand": "npm run dev", "devUrl": "http://localhost:3000", "description": "Next.js project", "files": [{"path": "app/page.tsx", "content": "..."}]}

### Open Browser:
{"action": "open_browser", "url": "https://google.com"}

### Open File:
{"action": "open_file", "filepath": "path/to/file.js"}

### Delete File:
{"action": "delete_file", "filename": "path/to/file.tsx"}

### Rename File:
{"action": "rename_file", "oldName": "components/Old.tsx", "newName": "components/New.tsx"}

### Move File:
{"action": "move_file", "source": "components/Foo.tsx", "destination": "app/components/Foo.tsx"}

### Run Command (non-dev, one-shot):
{"action": "run_command", "command": "npm install framer-motion", "cwd": "landing-page-app"}

### Search In Files:
{"action": "search_in_files", "query": "useState", "ext": ".tsx,.ts"}

### Bulk Edit (multiple files at once):
{"action": "bulk_edit", "edits": [{"filename": "app/page.tsx", "oldContent": "...", "newContent": "..."}, {"filename": "components/Nav.tsx", "oldContent": "...", "newContent": "..."}]}

### Copy File:
{"action": "copy_file", "source": "components/Button.tsx", "destination": "components/IconButton.tsx"}

### Add Environment Variable:
{"action": "add_env_var", "vars": [{"key": "NEXT_PUBLIC_API_URL", "value": "https://api.example.com", "comment": "API base URL"}], "envFile": ".env.local"}

### Scaffold Component (with barrel export):
{"action": "scaffold_component", "name": "ProductCard", "dir": "components", "content": "complete component code"}

## FRAMEWORK DETECTION:
NextJS → framework: "nextjs", packageName: "next"
React App → framework: "react-app", packageName: "react"
Vue → framework: "vue", packageName: "vue"
Angular → framework: "angular", packageName: "@angular/core"
Vite → framework: "vite", packageName: "vite"
Svelte → framework: "svelte", packageName: "svelte"
Express → framework: "express", packageName: "express"

## DETECTION RULES:
GENERAL QUESTION → "answer"
FILE OPERATIONS → "create_file", "read_file", "edit_file", "delete_file", "rename_file", "move_file"
FOLDER → "create_folder"
SEARCH IN CODE → "search_in_files" (find where a function/class/variable is used)
MULTI-FILE EDIT → "bulk_edit" (when same change needed in 2+ files at once)
ONE-SHOT COMMAND → "run_command" (npm install, git commit, etc — NOT dev server)
COPY FILE → "copy_file" (duplicate a file to new location)
ENV VARIABLES → "add_env_var" (add keys to .env.local + .env.example)
NEW COMPONENT → "scaffold_component" (create + auto-add to barrel index.ts)
CODE GENERATION → "generate_code"
MULTI-FILE PROJECT → "create_project"
FRAMEWORK APP/INSTALLATION → Use "preview_command" with installer
FRAMEWORK COMPONENT/PAGE (if framework exists) → "create_file" in correct location
FRAMEWORK COMPONENT/PAGE (if NOT exists) → "preview_command" to install first
OPEN BROWSER/URL → "open_browser"
OPEN FILE → "open_file"

## WORKFLOW FOR FRAMEWORK COMPONENTS:

### If framework is already detected (shown in PROJECT CONTEXT above):
→ Directly create_file or edit_file in correct location
→ For App Router: app/page.tsx or app/[name]/page.tsx
→ For Pages Router: pages/index.tsx or pages/[name].tsx

### If framework NOT detected:
→ Return preview_command with scaffold command

### Explicit installation request ("install nextjs", "create nextjs app"):
→ ALWAYS use preview_command with create-next-app

### No framework mentioned ("create landing page"):
→ Create simple HTML/CSS file

## CRITICAL: Framework Installation Detection
When user requests a framework/app (nextjs, react, vue, express, etc):
1. Check PROJECT CONTEXT above — is framework already installed?
2. If YES → create_file or edit_file directly
3. If NO → ALWAYS use "preview_command" first with scaffold/installer

## CODE QUALITY — ENHANCED:
- Single quotes for JSX
- Proper TypeScript interfaces — never use any unless truly unavoidable
- Clean production-ready code
- Proper JSON escaping (\\n)
- ALWAYS use real Unsplash photo IDs (images.unsplash.com/photo-ID) — NEVER source.unsplash.com (dead), NEVER local paths
- Always handle async/await with try-catch
- Always validate user inputs in API routes
- Return correct HTTP status codes in backend routes
- Mobile-first responsive design with Tailwind
- Meaningful variable and function names — no a, b, x as names

## GIT AWARENESS:
- If user says "commit", "push", "git" → use run_command with git commands
- Always stage files before committing: git add . then git commit -m "message"
- Suggest meaningful commit messages based on what was changed
- Never push without confirming remote exists

## PACKAGE INSTALL INTELLIGENCE:
- For any new component/feature → check package.json first (already in PROJECT CONTEXT)
- If package missing → use run_command: npm install package-name
- After install → remind user to restart dev server only if it was running
- Common packages to know: framer-motion (animations), lucide-react (icons),
  react-hook-form (forms), zod (validation), @tanstack/react-query (data fetching),
  prisma (database), next-auth (auth), shadcn/ui (components)

## TYPESCRIPT ERROR RECOVERY:
- "Type error: Property X does not exist" → add X to the interface
- "Cannot find module" → check import path, fix with correct relative path
- "Type any" warnings → infer correct type from usage context
- "Missing return type" → add explicit return type annotation
- Always fix TypeScript errors before they compound

## RESPONSIVE DESIGN RULES:
- Mobile first: base styles → sm: → md: → lg: → xl:
- Common breakpoints: sm=640px md=768px lg=1024px xl=1280px
- Always test mentally: does this look good on mobile (375px)?
- Flex/Grid with responsive columns: grid-cols-1 md:grid-cols-2 lg:grid-cols-3
- Text sizes: text-sm md:text-base lg:text-lg
- Padding/margin: p-4 md:p-8 lg:p-12

## ANIMATION & UX:
- Add subtle transitions: transition-all duration-300 ease-in-out
- Hover effects on interactive elements: hover:scale-105 hover:shadow-lg
- Loading states: show spinner or skeleton, never blank screen
- Error states: show friendly message, not raw error text
- Empty states: show helpful message when list is empty

## NEXT.JS SPECIFIC:
- App Router: use server components by default, add "use client" only when needed
- Image optimization: always use next/image, never <img> for local images
- Fonts: use next/font for Google Fonts
- Metadata: add export const metadata for SEO on every page
- API routes: app/api/[route]/route.ts with GET/POST handlers
- Environment variables: NEXT_PUBLIC_ prefix for client-side vars
- Loading UI: create loading.tsx alongside page.tsx for Suspense
- Error UI: create error.tsx alongside page.tsx for error boundary
- Not found: create not-found.tsx for 404 pages

## DARK MODE — FULL IMPLEMENTATION:
- "add dark mode" = implement toggle with localStorage persistence
- Use Tailwind dark: prefix classes: dark:bg-gray-900 dark:text-white
- Add ThemeProvider or use next-themes package
- Toggle button: sun/moon icon, save to localStorage
- Apply class="dark" to <html> element
- Example: npm install next-themes → wrap layout with ThemeProvider

## FORM HANDLING — COMPLETE PATTERNS:
- Always use controlled components with useState or react-hook-form
- Every form field needs: label, input, error message, loading state
- Validation: required, minLength, maxLength, email pattern, custom rules
- On submit: disable button, show spinner, handle success + error
- Use zod for schema validation with react-hook-form
- Never leave form without error handling
- Example pattern:
  const { register, handleSubmit, formState: { errors } } = useForm()
  onSubmit = async (data) => { setLoading(true); try { await api(data) } catch(e) { setError(e) } finally { setLoading(false) } }

## API ROUTES — NEXT.JS APP ROUTER:
- Location: app/api/[route]/route.ts
- Always export named functions: GET, POST, PUT, DELETE, PATCH
- Always return NextResponse.json() with proper status codes
- Always wrap in try-catch, return 500 on error
- Validate request body before processing
- Example:
  export async function POST(request: Request) {
    try {
      const body = await request.json()
      // validate, process
      return NextResponse.json({ success: true }, { status: 201 })
    } catch (e) {
      return NextResponse.json({ error: 'Server error' }, { status: 500 })
    }
  }

## DATA FETCHING PATTERNS:
- Server Component: async function, fetch() directly, no useEffect
- Client Component: useEffect + useState OR React Query
- SWR/React Query: use for client-side data that refreshes
- Always show loading skeleton, not just "Loading..."
- Always handle error state with retry button
- Revalidate: fetch(url, { next: { revalidate: 60 } }) for ISR

## DESIGN TOKENS & THEMING:
- Define colors in tailwind.config.ts: extend.colors
- Use CSS variables for dynamic theming: --primary, --background
- Consistent spacing: use Tailwind scale (4=1rem, 8=2rem, 16=4rem)
- Font sizes: use Tailwind typography scale
- Never hardcode hex colors in JSX — use Tailwind classes
- Brand colors: define once in config, use everywhere

## COMPONENT PATTERNS — VARIANTS:
- Accept variant prop: variant="primary"|"secondary"|"ghost"
- Accept size prop: size="sm"|"md"|"lg"  
- Use cva() (class-variance-authority) for variant classes
- Always export types alongside component
- Example Button:
  interface ButtonProps { variant?: 'primary'|'secondary'; size?: 'sm'|'md'|'lg'; children: React.ReactNode }

## UI PATTERNS — QWEN LEVEL:
- Toast/Notification: use react-hot-toast or sonner
  import toast from 'react-hot-toast'; toast.success('Saved!'); toast.error('Failed!')
- Modal/Dialog: use headlessui Dialog or radix-ui Dialog
- Dropdown Menu: use radix-ui DropdownMenu
- Tooltip: use radix-ui Tooltip
- Tabs: use radix-ui Tabs
- Always add keyboard accessibility (Escape to close, Tab to navigate)

## PAGINATION — COMPLETE:
- URL-based: use searchParams for page number (?page=2)
- Client: useState for current page
- Always show: Previous, page numbers, Next
- Show total items count and current range (e.g. "Showing 1-10 of 45")
- Disable Previous on page 1, Next on last page

## SEARCH & FILTER:
- Debounce search input: 300ms delay before API call
- URL-based search: update searchParams, not just state
- Show "No results found" with clear filter button
- Filter chips: show active filters as dismissible badges
- Combine search + filter + sort + pagination together

## URL PARAMS & SEARCHPARAMS:
- Read: const searchParams = useSearchParams()
- Read: const { id } = await params (dynamic routes, Next.js 15)
- Write: router.push('/path?' + new URLSearchParams({key: value}))
- Server: searchParams prop on page component
- Never use window.location directly in Next.js

## ENVIRONMENT VARIABLES:
- Public (client): NEXT_PUBLIC_API_URL in .env.local
- Private (server only): DATABASE_URL, SECRET_KEY
- Access: process.env.NEXT_PUBLIC_API_URL
- Never expose private env vars to client
- Create .env.example with all required vars (no values)
- When creating API that needs keys → create .env.local with placeholder

## AUTH PATTERNS:
- next-auth: SessionProvider in layout, useSession in components
- Protected routes: middleware.ts with matcher config
- Redirect unauthenticated users to /login
- Show user avatar/name in navbar when logged in
- Always handle loading state for session

## LOCAL STORAGE & COOKIES:
- localStorage: only in useEffect (client-side only)
- Persist theme, user preferences, cart items
- Always handle JSON.parse errors
- Cookies: use cookies() from next/headers in server components
- Never store sensitive data (passwords, tokens) in localStorage

## CLIPBOARD:
- navigator.clipboard.writeText(text).then(() => toast.success('Copied!'))
- Always show visual feedback after copy
- Add copy button to code blocks, URLs, IDs

## FILE UPLOAD:
- Use input type="file" with accept attribute
- Show file name and size after selection
- Show upload progress if large file
- Validate file type and size before upload
- Use FormData for multipart upload

## PERFORMANCE PATTERNS:
- Dynamic imports: const Modal = dynamic(() => import('./Modal'), { ssr: false })
- Image lazy loading: loading="lazy" or use next/image (auto)
- Memoize expensive calculations: useMemo
- Prevent re-renders: useCallback for functions passed as props
- Code split: separate large libraries into their own chunks

## ACCESSIBILITY (A11Y) — ALWAYS:
- Every image: meaningful alt text (not "image" or "photo")
- Every button: descriptive text or aria-label
- Every form input: associated label (htmlFor + id)
- Color contrast: text must be readable (WCAG AA)
- Keyboard navigation: all interactive elements reachable by Tab
- Focus visible: never remove outline completely, just restyle it
- Screen reader: use sr-only class for visually hidden but readable text

## UNDO AWARENESS:
- User can type "undo" to restore last edited file from backup
- When you edit a file, a backup is auto-saved to .spark-backups/
- Never delete .spark-backups/ folder — it is the undo history

## @FILE MENTIONS:
- If user writes @path/to/file.tsx in their message, that file's content is injected above
- Use that EXACT content as the source of truth for edits
- Example: "@app/page.tsx add a button" → file content shown above, edit it

## PLAN BOX:
- For complex tasks, a plan is shown before execution
- Follow the plan steps in ORDER
- Never skip a step
- If step 1 is create → step 2 is install → step 3 is start: do ALL three

## URDU/MIXED LANGUAGE UNDERSTANDING:
- "banner change karo" = update hero/banner section
- "button add karo" = add a button
- "styling theek karo" = fix/improve styling
- "mobile pe sahi karo" = make it responsive/mobile-friendly
- "save karo" / "file mein dalo" = save to file
- "chala do" = run/start the app
- "band karo" = stop the server
- "naya component banao" = create new component
- "purana wala hatao" = remove/delete the old one
- "wahi rakho baaki" = keep everything else the same
- "sab theek karo" = fix all issues
- Always infer full intent from mixed Urdu+English

## EXAMPLES:

Input: "create a nextjs app"
Output: {"action": "preview_command", "command": "npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --use-npm", "description": "I will create a Next.js app for you."}

Input: "build a react app"
Output: {"action": "preview_command", "command": "npx create-react-app . --template typescript", "description": "I will create a React app for you."}

Input: "create a simple HTML page"
Output: {"action": "create_file", "filename": "index.html", "content": "<!DOCTYPE html>..."}

Input: "open google"
Output: {"action": "open_browser", "url": "https://google.com"}

Input: "what is React?"
Output: {"action": "answer", "response": "React is a JavaScript library for building user interfaces..."}

## CRITICAL: Return EXACTLY ONE JSON OBJECT - nothing more!
- NO multiple JSON objects
- NO text before or after JSON
- ONE {"action": "...", ...} and that is it!
- NEVER return empty response - ALWAYS return an action
- If you cannot do something, return {"action": "answer", "response": "explanation"}

## AFTER EACH ACTION: Self-review!
- Analyze: "Is everything complete?"
- If NOT → Continue working automatically
- Keep looping until 100% done!


-if users say "start my server" or "open my app" or "open application" you must open the browser one time reload not auto reload again and again.
-if users say "stop my server" or "close my app" or "close application" you must stop the server and close the browser if it's open.
-if users say "restart my server" or "restart application" you must stop the server if it's running and start it again and open the browser one time.
-Always you keep internally checking if npm run dev commands running or not if run you must open browser one time .
-if you open browser and you can see this " This site can’t be reached
localhost refused to connect.
Try:

Checking the connection
Checking the proxy and the firewall
ERR_CONNECTION_REFUSED " you must debug this error auto in the loop and again until you fix it and open the browser successfully without this error. if use see this error in browser you solve this error  and then start again dev server.

-After when browser open succesfully not compiling auto in browser

I am facing an issue in my Next.js app where the browser keeps auto reloading continuously and shows "compiling..." again and again even when I am not making changes.

Please help me debug this issue step by step.

Details:
- Next.js version: (mention your version)
- OS: Windows
- Package manager: npm
- Running with: npm run dev

Symptoms:
- Browser auto refreshes repeatedly
- Terminal shows continuous compiling
- No major code changes

Check for:
1. Infinite re-render in React components (useEffect, state updates)
2. File watcher issues on Windows
3. Problematic dependencies or config in next.config.js
4. Large folders like node_modules being watched
5. Any API route or middleware causing loop

Give me:
- Exact possible causes
- How to fix each one step by step
- Code examples if needed

`;
  // ↑ FIXED: template literal properly closed with backtick, function closed with }
}

// ============================================================
//  HELPERS
// ============================================================

function unescapeContent(str) {
  if (!str) return "";
  return str
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
}

async function printCharByChar(text) {
  const termWidth = process.stdout.columns || 80;
  const words = text.split(" ");
  let line = "";
  const pendingLines = [];

  for (const word of words) {
    if ((line + word).length > termWidth - 6) {
      pendingLines.push(line.trim());
      line = word + " ";
    } else {
      line += word + " ";
    }
  }
  if (line.trim()) pendingLines.push(line.trim());

  for (let i = 0; i < pendingLines.length; i++) {
    if (i === 0) process.stdout.write(chalk.hex("#82AAFF").bold("✴ "));
    else process.stdout.write("    ");

    for (const char of pendingLines[i]) {
      process.stdout.write(chalk.white(char));
      await new Promise(res => setTimeout(res, 12));
    }
    process.stdout.write("\n");
  }
  console.log();
}

function checkInstallation(packageName, checkCommand) {
  try { execSync(checkCommand, { stdio: "pipe" }); return true; } catch {}
  try {
    const localPath = path.join(process.cwd(), "node_modules", packageName);
    if (fs.existsSync(localPath)) return true;
  } catch {}
  try {
    const r = execSync(`npm list -g ${packageName} --depth=0 2>/dev/null`, { stdio: "pipe", encoding: "utf8" });
    if (r.includes(packageName)) return true;
  } catch {}
  return false;
}

// ============================================================
//  DEV SERVER
// ============================================================

async function startDevServer(command, cwd, url = "http://localhost:3000") {
  // Check if dev server is already running - prevent repeated messages
  if (devServerProcess && browserOpened) {
    console.log(chalk.hex(COLORS.successStart)("\n✓ Dev server already running at " + url + "\n"));
    return { success: true, url, alreadyRunning: true };
  }
  
  if (devServerProcess) {
    console.log(chalk.hex(COLORS.warningStart)("\n⚠️  Stopping existing dev server...\n"));
    devServerProcess.kill();
    // Wait a moment for process to fully stop
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.log(chalk.hex(COLORS.infoStart)("\n🚀 Starting development server...\n"));

  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(" ");
    devServerProcess = spawn(cmd, args, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    devServerUrl = url;

    const bw = Math.min(process.stdout.columns || 80, 100);
    const urlPad = url.padEnd(bw - 14);
    
    // Premium starting box
    console.log(
      "\n" +
      chalk.hex(COLORS.borderDark)("╭") +
      chalk.hex(COLORS.warningStart).bold(" ▶ Starting Development Server ") +
      chalk.hex(COLORS.warningEnd)("─".repeat(bw - 32)) +
      chalk.hex(COLORS.borderDark)("╮") +
      "\n" +
      chalk.hex(COLORS.borderDark)("│") +
      "   " +
      chalk.hex(COLORS.textDim)("URL     ") +
      chalk.hex(COLORS.infoStart)(url) +
      chalk.hex(COLORS.borderDark)(" ".repeat(bw - url.length - 18)) +
      chalk.hex(COLORS.borderDark)("│") +
      "\n" +
      chalk.hex(COLORS.borderDark)("│") +
      "   " +
      chalk.hex(COLORS.textDim)("Status  ") +
      chalk.hex(COLORS.warningStart)("Starting...") +
      chalk.hex(COLORS.borderDark)(" ".repeat(bw - 22)) +
      chalk.hex(COLORS.borderDark)("│") +
      "\n" +
      chalk.hex(COLORS.borderDark)("╰") +
      chalk.hex(COLORS.warningEnd)("─".repeat(bw)) +
      chalk.hex(COLORS.borderDark)("╯") +
      "\n"
    );

    let serverReady = false;

    devServerProcess.stdout.on("data", data => {
      const out = data.toString();
      if (!serverReady && (out.includes("ready") || out.includes("started") || out.includes("compiled") || out.includes("Local:"))) {
        serverReady = true;
        // Premium ready box
        console.log(
          "\n" +
          chalk.hex(COLORS.borderDark)("╭") +
          chalk.hex(COLORS.successStart).bold(" ● Development Server Ready ") +
          chalk.hex(COLORS.successEnd)("─".repeat(bw - 31)) +
          chalk.hex(COLORS.borderDark)("╮") +
          "\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "   " +
          chalk.hex(COLORS.textDim)("URL     ") +
          chalk.hex(COLORS.infoStart).underline(url) +
          chalk.hex(COLORS.borderDark)(" ".repeat(bw - url.length - 18)) +
          chalk.hex(COLORS.borderDark)("│") +
          "\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "   " +
          chalk.hex(COLORS.textDim)("Status  ") +
          chalk.hex(COLORS.successStart).bold("✓ Ready! ") +
          chalk.hex(COLORS.textDim)("(Ctrl+C to stop)") +
          chalk.hex(COLORS.borderDark)(" ".repeat(bw - 45)) +
          chalk.hex(COLORS.borderDark)("│") +
          "\n" +
          chalk.hex(COLORS.borderDark)("╰") +
          chalk.hex(COLORS.successEnd)("─".repeat(bw)) +
          chalk.hex(COLORS.borderDark)("╯") +
          "\n"
        );
        
        // Open browser ONLY ONCE - check flag to prevent infinite reload
        if (!browserOpened) {
          console.log(chalk.hex(COLORS.infoStart)("\n🌐 Opening browser...\n"));
          open(url).catch(() => console.log(chalk.hex(COLORS.warningStart)(`\n⚠️  Open manually: ${url}\n`)));
          browserOpened = true;  // Set flag - prevent opening again
        } else {
          console.log(chalk.hex(COLORS.infoStart)("\n✓ Server restarted (browser already open)\n"));
        }
        
        resolve({ success: true, url });
      }
    });

    let stderrBuffer = "";
    devServerProcess.stderr.on("data", data => {
      const out = data.toString();
      stderrBuffer += out;
      if (!serverReady && (out.includes("error") || out.includes("Error") || out.includes("failed"))) {
        serverReady = true;
        // Premium error box
        console.log(
          "\n" +
          chalk.hex(COLORS.borderDark)("╭") +
          chalk.hex(COLORS.errorStart).bold(" ✗ Dev Server Error ") +
          chalk.hex(COLORS.errorEnd)("─".repeat(bw - 23)) +
          chalk.hex(COLORS.borderDark)("╮") +
          "\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "   " +
          chalk.hex(COLORS.errorStart)("Failed to start development server") +
          chalk.hex(COLORS.borderDark)(" ".repeat(bw - 42)) +
          chalk.hex(COLORS.borderDark)("│") +
          "\n" +
          chalk.hex(COLORS.borderDark)("╰") +
          chalk.hex(COLORS.errorEnd)("─".repeat(bw)) +
          chalk.hex(COLORS.borderDark)("╯") +
          "\n"
        );
        // ── Auto-fix: send error to AI ───────────────────────────────────
        const errSnippet = stderrBuffer.slice(-800);
        console.log(chalk.hex(COLORS.textDim)(errSnippet.slice(0, 300)));
        setTimeout(async () => {
          console.log(chalk.hex(COLORS.infoStart)("\n  🔧 Auto-analyzing error...\n"));
          await generateCode(
            `Dev server failed with this error:\n${errSnippet}\nAnalyze and fix the issue automatically.`,
            1
          );
        }, 500);
        reject(new Error(out));
      }
    });

    devServerProcess.on("close", code => {
      if (code !== 0 && !serverReady) reject(new Error(`Exited with code ${code}`));
    });

    devServerProcess.on("error", err => reject(err));

    setTimeout(() => {
      if (!serverReady) {
        console.log(chalk.hex(COLORS.warningStart)("\n⚠️  Server starting (waited 30s)...\n"));
        resolve({ success: true, url, pending: true });
      }
    }, 30000);
  });
}

function stopDevServer() {
  if (devServerProcess) {
    devServerProcess.kill();
    devServerProcess = null;
    devServerUrl = null;
    browserOpened = false;  // Reset flag - allow browser to open again on next start
    console.log(chalk.yellow("\n⏹️  Dev server stopped\n"));
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  LOCALHOST CHECKER & PORT KILLER
// ══════════════════════════════════════════════════════════════════════════════

async function checkLocalhost(port = 3000) {
  return new Promise(async (resolve) => {
    try {
      const http = await import('http');
      const req = http.default.get(`http://localhost:${port}`, (res) => {
        resolve(res.statusCode === 200 || res.statusCode === 304);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function killPort(port = 3000) {
  try {
    const { exec } = await import('child_process');
    const util = await import('util');
    const execPromise = util.default.promisify(exec);
    
    if (process.platform === 'win32') {
      // Windows: netstat → find PID → taskkill
      const { stdout } = await execPromise(`netstat -ano | findstr :${port}`);
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && !isNaN(parseInt(pid))) {
          await execPromise(`taskkill /PID ${pid} /F`);
        }
      }
    } else {
      // Unix: lsof → kill
      await execPromise(`kill $(lsof -t -i:${port})`);
    }
  } catch (e) {
    console.log(chalk.hex("#F97316")(`  ⚠ Could not kill port ${port}: ${e.message}`));
  }
}

// ============================================================
//  FRAMEWORK HANDLER
// ============================================================

async function handleFramework(aiResponse) {
  const { displayName, packageName, checkCommand, installCommand, devCommand, devUrl, description, files } = aiResponse;
  const projectRoot = process.cwd();

  console.log(chalk.cyan(`\n🔍 Detected: ${description}\n`));
  console.log(chalk.gray(`   Framework : ${displayName}`));
  console.log(chalk.gray(`   Package   : ${packageName}\n`));

  const spinner = ora(`Checking ${displayName}...`).start();
  const isInstalled = checkInstallation(packageName, checkCommand);

  if (isInstalled) {
    spinner.succeed(chalk.green(`${displayName} already installed!`));
  } else {
    spinner.warn(chalk.yellow(`${displayName} NOT installed`));
    console.log(chalk.gray(`\n   Install: ${chalk.white(installCommand)}\n`));

    const { permission } = await inquirer.prompt([
      { type: "confirm", name: "permission", message: chalk.yellow(`Install ${displayName}?`), default: true },
    ]);

    if (!permission) {
      console.log(chalk.yellow("\n⏭️  Skipped.\n"));
      return;
    }

    try {
      const s2 = ora(`Installing ${displayName}...`).start();
      execSync(installCommand, { stdio: "inherit", cwd: projectRoot });
      s2.succeed(chalk.green(`${displayName} installed!`));
    } catch (error) {
      console.log(chalk.red(`\n❌ Install failed: ${error.message}\n`));
      return;
    }
  }

  if (files && files.length > 0) {
    console.log(chalk.cyan(`\n📁 Creating files...\n`));
    const createdDirs = new Set();
    for (const file of files) {
      const fp = path.join(projectRoot, file.path);
      const dir = path.dirname(fp);
      if (dir !== projectRoot && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        const rel = path.relative(projectRoot, dir);
        if (!createdDirs.has(rel)) { console.log(chalk.gray(`  📁 ${rel}/`)); createdDirs.add(rel); }
      }
      fs.writeFileSync(fp, unescapeContent(file.content), "utf8");
      console.log(chalk.green(`  ✓ ${file.path}`));
    }
    console.log(chalk.cyan(`\n✨ ${files.length} files created!\n`));
  }

  console.log(chalk.cyan("📋 Next:\n"));
  console.log(chalk.white(`   ${devCommand}`));
  if (devUrl) console.log(chalk.gray(`   Open: ${devUrl}`));
  console.log();
}

// ============================================================
//  SECTION PATTERNS
// ============================================================

const SECTION_PATTERNS = {
  hero:        /hero|banner|cover|jumbotron|splash|masthead/i,
  product:     /product|item|card|shop|store|catalog|grid|collection|listing/i,
  about:       /about|team|story|mission|founder/i,
  gallery:     /gallery|portfolio|showcase|work|project/i,
  testimonial: /testimonial|review|quote|feedback/i,
  feature:     /feature|benefit|service|offer/i,
  footer:      /footer|bottom/i,
  header:      /header|navbar|nav|top/i,
  background:  /background|bg-image|bgimage/i,
};

function detectTargetSections(prompt) {
  const lower = prompt.toLowerCase();
  const targets = [];
  if (/hero|banner|cover|main\s+image|top\s+image|header\s+image|background/i.test(lower)) targets.push("hero");
  if (/product|item|card|shop|store|catalog|collection/i.test(lower)) targets.push("product");
  if (/about|team|story/i.test(lower)) targets.push("about");
  if (/gallery|portfolio|showcase/i.test(lower)) targets.push("gallery");
  if (/testimonial|review/i.test(lower)) targets.push("testimonial");
  if (/feature|benefit|service/i.test(lower)) targets.push("feature");
  if (/footer/i.test(lower)) targets.push("footer");
  return targets;
}

function extractSectionSubjects(prompt, targetSections, cleanedSubject) {
  const lower = prompt.toLowerCase();
  const hasTwoSections = targetSections.length >= 2;
  const connectorRe = /(?:\bto\b|\bfor\b|\bwith\b)\s+([a-zA-Z][a-zA-Z0-9 ]{1,30})/gi;
  const STOP = /\b(and|also|section|page|ko|sa|se|ka|ki|ke|mein|wala|wali|karo|karde|hon|ho|lagao|magr|but|aur)\b/i;

  if (hasTwoSections) {
    const sectionMap = {
      hero:    /\b(hero|banner|cover|background)\b/i,
      product: /\b(product|products|item|items|card|shop|catalog)\b/i,
      feature: /\b(feature|features|benefit)\b/i,
      about:   /\b(about|team|story)\b/i,
      gallery: /\b(gallery|portfolio)\b/i,
    };
    const parts = prompt.split(/\band\b/i).filter(Boolean);
    const multiResult = [];
    for (const part of parts) {
      let matchedSection = null;
      for (const [sec, pattern] of Object.entries(sectionMap)) {
        if (pattern.test(part)) { matchedSection = sec; break; }
      }
      if (!matchedSection) continue;
      let partSubject = null;
      let m;
      connectorRe.lastIndex = 0;
      while ((m = connectorRe.exec(part)) !== null) {
        let raw = m[1]; const stop = raw.match(STOP); if (stop) raw = raw.slice(0, stop.index);
        const s = cleanSubject(raw); if (s && s.length > 1) { partSubject = s; break; }
      }
      if (!partSubject) {
        const wm = part.match(/([a-zA-Z][a-zA-Z0-9 ]{1,20})\s+(?:wali|wale|ki)\s+/i);
        if (wm) partSubject = cleanSubject(wm[1]);
      }
      if (!partSubject) partSubject = cleanedSubject;
      if (partSubject) multiResult.push({ section: matchedSection, subject: partSubject });
    }
    if (multiResult.length > 1) return multiResult;
  }

  const subject = cleanedSubject || "watches,luxury";
  if (targetSections.length === 0) return [{ section: null, subject }];
  return targetSections.map(sec => ({ section: sec, subject }));
}

function parseFileSections(content) {
  const lines = content.split("\n");
  const sections = {};
  const SECTION_DETECT = {
    hero:        /\b(hero|HeroSection|HeroBanner|HeroImage|heroBg|heroBgImage|heroBackground|splash|masthead|jumbotron|cover)\b/,
    product:     /\b(product|Product|ProductCard|ProductImage|productImg|shop|catalog|listing|item|Item)\b/,
    about:       /\b(about|About|AboutSection|team|Team|story|mission)\b/,
    gallery:     /\b(gallery|Gallery|portfolio|Portfolio|showcase)\b/,
    testimonial: /\b(testimonial|Testimonial|review|Review|quote)\b/,
    feature:     /\b(feature|Feature|benefit|Benefit|service|Service)\b/,
    footer:      /\b(footer|Footer)\b/,
    header:      /\b(header|Header|navbar|NavBar|navigation)\b/,
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [key, pattern] of Object.entries(SECTION_DETECT)) {
      if (pattern.test(line)) {
        if (!sections[key]) sections[key] = [];
        sections[key].push({ start: Math.max(0, i - 5), end: Math.min(i + 120, lines.length - 1) });
        break;
      }
    }
  }
  return sections;
}

async function applyMultipleImagesDirectly(subject, projectCtx, targetSections = []) {
  const cwd = global.__projectRoot || process.cwd();
  const SCAN_EXTS = new Set([".tsx", ".jsx", ".js", ".ts", ".css", ".scss", ".html", ".vue"]);
  const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", "commands"]);
  const SKIP_FILES = new Set(["generate.js", "generate.ts", "index.js", "cli.js", "spark.js"]);

  // Get search keywords from subject
  const inputKws = subject.toLowerCase().split(",").map(k => k.trim()).filter(Boolean);
  let searchKws = [];
  for (const kw of inputKws) {
    const match = UNSPLASH_CURATED[kw] || UNSPLASH_CURATED[kw + "s"];
    if (match) { searchKws.push(...match); break; }
    // Fuzzy match
    for (const [cat, kws] of Object.entries(UNSPLASH_CURATED)) {
      if (kw.includes(cat) || cat.includes(kw)) { searchKws.push(...kws); break; }
    }
  }
  if (searchKws.length === 0) searchKws = UNSPLASH_CURATED.all;

  // Fetch real images from Unsplash API
  console.log(chalk.gray(`\n  🔍 Fetching real photos for: "${subject}"...\n`));
  const realUrls = await fetchBatchImages(searchKws, 30);
  
  let photoIdx = 0;
  const getNextUrl = (w = 800, h = 600) => {
    const url = realUrls[photoIdx % realUrls.length];
    photoIdx++;
    // If it's a full URL (from API), return as-is; if picsum, size it
    if (url.includes("picsum.photos")) {
      return url.replace(/\/\d+\/\d+$/, `/${w}/${h}`);
    }
    return url; // Unsplash urls.regular — already sized correctly
  };

  function collectFiles(dir) {
    let files = [];
    try {
      for (const item of fs.readdirSync(dir)) {
        if (SKIP_DIRS.has(item)) continue;
        const full = path.join(dir, item);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) files = files.concat(collectFiles(full));
          else if (SCAN_EXTS.has(path.extname(full)) && !SKIP_FILES.has(item)) files.push(full);
        } catch {}
      }
    } catch {}
    return files;
  }

  const allFiles = collectFiles(cwd);
  const changed = [];

  for (const file of allFiles) {
    try {
      const original = fs.readFileSync(file, "utf8");
      const lines = original.split("\n");
      const fileSections = parseFileSections(original);
      const targetLines = new Set();
      let useWholeFile = true;

      if (targetSections.length > 0) {
        for (const sec of targetSections) {
          for (const range of (fileSections[sec] || [])) {
            for (let i = range.start; i <= range.end; i++) targetLines.add(i);
          }
        }
        if (targetLines.size > 0) useWholeFile = false;
      }

      let patchedLines = [...lines];
      let fileChanged = false;
      const IMG_URL_RE = /(["'`])(https?:\/\/(?:images\.unsplash\.com|source\.unsplash|pexels|pixabay|picsum|placeholder)[^"'`\s]{5,})(["'`])/g;
      const CSS_URL_RE = /url\(["']?(https?:\/\/(?:images\.unsplash\.com|source\.unsplash|pexels|pixabay|picsum|placeholder)[^)"'\s]{5,})["']?\)/g;

      for (let i = 0; i < patchedLines.length; i++) {
        if (!useWholeFile && !targetLines.has(i)) continue;
        let line = patchedLines[i];
        line = line.replace(IMG_URL_RE, (match, q1, url, q2) => {
          fileChanged = true;
          return `${q1}${getNextUrl(800, 600)}${q2}`;
        });
        line = line.replace(CSS_URL_RE, () => {
          fileChanged = true;
          return `url("${getNextUrl(1920, 1080)}")`;
        });
        patchedLines[i] = line;
      }

      if (fileChanged) {
        fs.writeFileSync(file, patchedLines.join("\n"), "utf8");
        changed.push(path.relative(cwd, file));
      }
    } catch {}
  }

  if (changed.length > 0) {
    console.log(chalk.green(`\n  ✅ ${photoIdx} different images applied in:`));
    for (const f of changed) console.log(chalk.green(`     ✓ ${f}`));
    console.log(chalk.gray(`\n  🖼️  Subject: ${subject} · Photos used: ${photoIdx}`));
    await triggerBrowserReload();
    saveMemory(`Applied ${photoIdx} different ${subject} images in: ${changed.join(", ")}`, "assistant");
    return true;
  } else {
    console.log(chalk.yellow("\n  ⚠️  No image URLs found to replace"));
    return false;
  }
}

async function applyImageDirectly(newUrl, projectCtx, targetSections = []) {
  const cwd = process.cwd();
  const SCAN_EXTS = new Set([".tsx", ".jsx", ".js", ".ts", ".css", ".scss", ".html", ".vue"]);
  const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", "commands"]);
  const SKIP_FILES = new Set(["generate.js", "generate.ts", "index.js", "cli.js", "spark.js"]);

  function collectFiles(dir) {
    let files = [];
    try {
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (!SKIP_DIRS.has(item)) files = files.concat(collectFiles(full));
          } else {
            if (SCAN_EXTS.has(path.extname(full)) && !SKIP_FILES.has(item)) files.push(full);
          }
        } catch {}
      }
    } catch {}
    return files;
  }

  const allFiles = collectFiles(cwd);
  const changed = [];

  for (const file of allFiles) {
    try {
      const original = fs.readFileSync(file, "utf8");
      const lines = original.split("\n");
      const fileSections = parseFileSections(original);
      const targetLines = new Set();

      if (targetSections.length > 0) {
        for (const sec of targetSections) {
          const ranges = fileSections[sec] || [];
          for (const range of ranges) {
            for (let i = range.start; i <= range.end; i++) targetLines.add(i);
          }
        }
      }

      let patchedLines = [...lines];
      let fileChanged = false;
      const restrictToSection = targetSections.length > 0 && targetLines.size > 0;

      for (let i = 0; i < patchedLines.length; i++) {
        const line = patchedLines[i];
        if (restrictToSection && !targetLines.has(i)) continue;
        const newLine = line.replace(
          /(["'`])(https?:\/\/(?:images\.unsplash\.com|unsplash\.com|source\.unsplash|pexels|pixabay|picsum|placeholder)[^"'`\s]{5,})(["'`])/g,
          (match, q1, url, q2) => { fileChanged = true; return `${q1}${newUrl}${q2}`; }
        ).replace(
          /url\(["']?(https?:\/\/(?:images\.unsplash\.com|unsplash\.com|source\.unsplash|pexels|pixabay|picsum|placeholder)[^)"'\s]{5,})["']?\)/g,
          () => { fileChanged = true; return `url("${newUrl}")`; }
        );
        patchedLines[i] = newLine;
      }

      if (fileChanged) {
        fs.writeFileSync(file, patchedLines.join("\n"), "utf8");
        changed.push(path.relative(cwd, file));
      }
    } catch {}
  }

  if (changed.length > 0) {
    console.log(chalk.green("\n  ✅ Image updated in:"));
    for (const f of changed) console.log(chalk.green(`     ✓ ${f}`));
    console.log(chalk.cyan(`\n  🖼️  New image: ${newUrl.slice(0, 65)}...`));
    await triggerBrowserReload();
    saveMemory(`Image changed to: ${newUrl} in: ${changed.join(", ")}`, "assistant");
    return true;
  } else {
    console.log(chalk.yellow("\n  ⚠️  No matching image URLs found"));
    console.log(chalk.gray("  💡 Ensure your file uses https:// image URLs (unsplash, pexels, etc)\n"));
    return false;
  }
}

async function triggerBrowserReload(specificFile = null) {
  // DISABLED: Next.js HMR handles browser refresh automatically
  // Manual file touching causes infinite reload loops on Windows
  // Just inform user - do NOT touch any files
  
  if (specificFile) {
    console.log(chalk.gray("  ℹ️  File saved: " + specificFile + "\n"));
  } else {
    console.log(chalk.gray("  ℹ️  Changes saved - browser will auto-update via HMR\n"));
  }
  
  // NOTE: Do NOT call fs.utimesSync or fs.writeFileSync here
  // This triggers Next.js file watcher and causes infinite reload loop
  // Next.js dev server has built-in HMR - it will refresh automatically
}

// ============================================================
//  QWEN-STYLE: edit_file with fuzzy retry on mismatch
// ============================================================

/**
 * Try to apply edit_file. If oldContent doesn't match exactly,
 * attempt a fuzzy match by trimming lines and retrying.
 * Returns true if edit was applied, false otherwise.
 */
function applyEditWithRetry(filePath, oldContent, newContent) {
  let fileContent = fs.readFileSync(filePath, "utf8");
  const old = unescapeContent(oldContent);
  const neu = unescapeContent(newContent);

  // ── Attempt 1: exact match ───────────────────────────────────────────────
  if (fileContent.includes(old)) {
    fs.writeFileSync(filePath, fileContent.replace(old, neu), "utf8");
    return true;
  }

  // ── Attempt 2: trimEnd each line (trailing spaces/CRLF) ─────────────────
  const te = str => str.split("\n").map(l => l.trimEnd()).join("\n");
  const f2 = te(fileContent);
  const o2 = te(old);
  if (f2.includes(o2)) {
    fs.writeFileSync(filePath, f2.replace(o2, te(neu)), "utf8");
    return true;
  }

  // ── Attempt 3: fully strip indentation on both sides ────────────────────
  const strip = str => str.split("\n").map(l => l.trim()).join("\n");
  const strippedFile  = strip(fileContent);
  const strippedOld   = strip(old);
  if (strippedFile.includes(strippedOld)) {
    // re-apply: find line-range in original file, replace those lines
    const oldLines  = old.split("\n");
    const fileLines = fileContent.split("\n");
    const firstKey  = oldLines.find(l => l.trim().length > 3)?.trim();
    if (firstKey) {
      const si = fileLines.findIndex(l => l.trim() === firstKey);
      if (si !== -1) {
        const updated = [
          ...fileLines.slice(0, si),
          neu,
          ...fileLines.slice(si + oldLines.length)
        ].join("\n");
        fs.writeFileSync(filePath, updated, "utf8");
        return true;
      }
    }
  }

  // ── Attempt 4: first-line anchor + count-based replacement ──────────────
  const oldLines  = old.split("\n").filter(l => l.trim());
  const fileLines = fileContent.split("\n");
  if (oldLines.length > 0) {
    const firstKey = oldLines[0].trim();
    const lastKey  = oldLines[oldLines.length - 1].trim();
    const si = fileLines.findIndex(l => l.trim() === firstKey);
    if (si !== -1) {
      // find end line — scan forward for lastKey
      let ei = si + oldLines.length - 1;
      for (let i = si; i < Math.min(si + oldLines.length + 5, fileLines.length); i++) {
        if (fileLines[i].trim() === lastKey) { ei = i; break; }
      }
      const updated = [
        ...fileLines.slice(0, si),
        neu,
        ...fileLines.slice(ei + 1)
      ].join("\n");
      fs.writeFileSync(filePath, updated, "utf8");
      return true;
    }
  }

  // ── Attempt 5: sliding-window similarity score ───────────────────────────
  // Score each possible window in file against oldContent lines
  const oldTrimmed  = old.split("\n").map(l => l.trim()).filter(Boolean);
  const fileTrimmed = fileContent.split("\n");
  const winSize     = oldTrimmed.length;
  if (winSize >= 2) {
    let bestScore = 0, bestIdx = -1;
    for (let i = 0; i <= fileTrimmed.length - winSize; i++) {
      const window = fileTrimmed.slice(i, i + winSize).map(l => l.trim());
      let matches  = 0;
      for (let j = 0; j < winSize; j++) {
        if (window[j] === oldTrimmed[j]) matches++;
      }
      const score = matches / winSize;
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }
    if (bestScore >= 0.75) {  // 75%+ match — safe to replace
      const updated = [
        ...fileTrimmed.slice(0, bestIdx),
        neu,
        ...fileTrimmed.slice(bestIdx + winSize)
      ].join("\n");
      fs.writeFileSync(filePath, updated, "utf8");
      return true;
    }
  }

  return false;
}

// ============================================================
//  AUTO DYNAMIC PAGE FIXER — runs when user says dynamic page issue
// ============================================================

async function autofixDynamicPages(userPrompt) {
  const cwd = process.cwd();
  const SKIP = new Set(["node_modules", ".next", "dist", "build", ".git", ".turbo"]);

  // ── Step 1: Find all product/feature arrays in project files ─────────────
  function walkFiles(dir, depth = 0) {
    if (depth > 5) return [];
    let files = [];
    try {
      for (const item of fs.readdirSync(dir)) {
        if (SKIP.has(item)) continue;
        const full = path.join(dir, item);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) files = files.concat(walkFiles(full, depth + 1));
          else if ([".tsx", ".jsx", ".ts", ".js"].includes(path.extname(item))) files.push(full);
        } catch {}
      }
    } catch {}
    return files;
  }

  const allFiles = walkFiles(path.join(cwd));
  
  // ── Step 2: Find page.tsx files and read them ─────────────────────────────
  const pageFiles = allFiles.filter(f => f.replace(/\\/g, "/").endsWith("/page.tsx") || f.replace(/\\/g, "/").endsWith("/page.jsx"));
  
  const fileContents = {};
  for (const f of allFiles) {
    try { fileContents[f] = fs.readFileSync(f, "utf8"); } catch {}
  }

  // ── Step 3: Detect product/feature data arrays in any file ───────────────
  // Look for arrays with id, name/title, image/img, description fields
  function findDataArrays(src, filePath) {
    const found = [];
    // Match: const products = [...] or const features = [...] or export const items = [...]
    const arrMatches = src.matchAll(/(?:const|let|var|export\s+(?:const|default))\s+(\w+)\s*=\s*\[[\s\S]*?\{[\s\S]*?(?:id|name|title)[\s\S]*?\}[\s\S]*?\]/g);
    for (const m of arrMatches) {
      const varName = m[1];
      const block = m[0];
      // Extract items — look for {id: ..., name/title: ...} patterns
      const items = [];
      const itemMatches = block.matchAll(/\{([^{}]+)\}/g);
      for (const im of itemMatches) {
        const inner = im[1];
        const idM    = inner.match(/id\s*:\s*["'`]?(\w+)["'`]?/);
        const nameM  = inner.match(/(?:name|title)\s*:\s*["'`]([^"'`]+)["'`]/);
        const imgM   = inner.match(/(?:image|img|photo|src|thumbnail)\s*:\s*["'`]([^"'`]+)["'`]/);
        const descM  = inner.match(/(?:description|desc|detail|subtitle)\s*:\s*["'`]([^"'`]+)["'`]/);
        const priceM = inner.match(/(?:price|cost|amount)\s*:\s*["'`]?([\d.]+)["'`]?/);
        if (idM || nameM) {
          items.push({
            id:    idM?.[1]    || String(items.length + 1),
            name:  nameM?.[1]  || varName + " " + (items.length + 1),
            image: imgM?.[1]   || null,
            desc:  descM?.[1]  || null,
            price: priceM?.[1] || null,
          });
        }
      }
      if (items.length > 0) found.push({ varName, items, filePath });
    }
    return found;
  }

  let allDataArrays = [];
  for (const [fp, src] of Object.entries(fileContents)) {
    const found = findDataArrays(src, fp);
    allDataArrays = allDataArrays.concat(found);
  }

  // ── Step 4: Find existing [id] dynamic route folders ─────────────────────
  function findDynamicFolders(dir, depth = 0) {
    if (depth > 6) return [];
    let result = [];
    try {
      for (const item of fs.readdirSync(dir)) {
        if (SKIP.has(item)) continue;
        const full = path.join(dir, item);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (item.startsWith("[") && item.endsWith("]")) result.push({ folder: full, param: item.slice(1, -1) });
            result = result.concat(findDynamicFolders(full, depth + 1));
          }
        } catch {}
      }
    } catch {}
    return result;
  }

  // ── Step 5: Find app directory ────────────────────────────────────────────
  function findAppDir() {
    // look for app/ or src/app/
    const candidates = [
      path.join(cwd, "app"),
      path.join(cwd, "src", "app"),
    ];
    // also check subdirs (e.g. landing-page-app/app)
    try {
      for (const item of fs.readdirSync(cwd)) {
        if (SKIP.has(item)) continue;
        const full = path.join(cwd, item);
        try {
          if (fs.statSync(full).isDirectory()) {
            candidates.push(path.join(full, "app"));
            candidates.push(path.join(full, "src", "app"));
          }
        } catch {}
      }
    } catch {}
    return candidates.find(c => fs.existsSync(c)) || null;
  }

  const appDir = findAppDir();
  if (!appDir) {
    console.log(chalk.yellow("  ⚠️  Could not find app/ directory\n"));
    return false;
  }

  const dynamicFolders = findDynamicFolders(appDir);
  const mainPagePath   = path.join(appDir, "page.tsx");

  // ── Step 6: Read main page.tsx and product/page.tsx ───────────────────────
  // Find ALL page.tsx files under appDir
  const appPages = pageFiles.filter(f => f.startsWith(appDir));

  // Find the page that has the product/feature list (has Link or cards/grid)
  let listPagePath = null;
  let listPageSrc  = null;
  let routeBase    = null; // e.g. "product" or "features"

  // Priority: existing [id] folder parent
  if (dynamicFolders.length > 0) {
    const dynFolder = dynamicFolders[0];
    const parentDir = path.dirname(dynFolder.folder);
    const parentPage = path.join(parentDir, "page.tsx");
    if (fs.existsSync(parentPage)) {
      listPagePath = parentPage;
      listPageSrc  = fs.readFileSync(parentPage, "utf8");
      routeBase    = "/" + path.relative(appDir, parentDir).replace(/\\/g, "/");
    }
  }

  // Fallback: find page with product/feature array or card grid
  if (!listPagePath) {
    for (const pg of appPages) {
      const src = fileContents[pg] || "";
      if (/products|features|items|cards|grid/i.test(src) && src.includes("map(")) {
        listPagePath = pg;
        listPageSrc  = src;
        const rel    = path.relative(appDir, path.dirname(pg)).replace(/\\/g, "/");
        routeBase    = rel ? "/" + rel : "";
        break;
      }
    }
  }

  // Last fallback: main page.tsx
  if (!listPagePath && fs.existsSync(mainPagePath)) {
    listPagePath = mainPagePath;
    listPageSrc  = fs.readFileSync(mainPagePath, "utf8");
    routeBase    = "";
  }

  if (!listPagePath || !listPageSrc) {
    console.log(chalk.yellow("  ⚠️  Could not find a page with product/feature list\n"));
    return false;
  }

  // ── Step 7: Extract existing data from the page ───────────────────────────
  const pageDataArrays = findDataArrays(listPageSrc, listPagePath);
  const mainData = pageDataArrays[0] || allDataArrays[0];

  // Determine route name from existing [id] folder or guess from data
  let dynamicRoute = "product"; // default
  if (dynamicFolders.length > 0) {
    dynamicRoute = path.basename(path.dirname(dynamicFolders[0].folder));
    if (dynamicRoute === "app" || dynamicRoute === "src") dynamicRoute = "product";
  } else if (mainData) {
    dynamicRoute = mainData.varName.replace(/s$/, "").toLowerCase(); // products → product
  }

  const dynamicDir   = path.join(appDir, dynamicRoute, "[id]");
  const dynamicPage  = path.join(dynamicDir, "page.tsx");
  const routeDir     = path.join(appDir, dynamicRoute);

  // ── Step 8: Show what we found ────────────────────────────────────────────
  const bw = Math.min(process.stdout.columns || 88, 88);
  process.stdout.write("\n" + BORDER("┌─ ") + chalk.blue("◆ Auto-fixing Dynamic Pages ") + BORDER("─".repeat(Math.max(0, bw - 29)) + "┐") + "\n");
  const info = [
    `  List page:   ${path.relative(cwd, listPagePath).replace(/\\/g, "/")}`,
    `  Route:       /${dynamicRoute}/[id]`,
    `  Dynamic dir: ${path.relative(cwd, dynamicDir).replace(/\\/g, "/")}`,
    mainData ? `  Data array:  ${mainData.varName} (${mainData.items.length} items)` : "  Data: will extract from page",
  ];
  for (const line of info) {
    process.stdout.write(BORDER("│ ") + BODY(line.slice(0, bw - 4)) + " ".repeat(Math.max(0, bw - Math.min(line.length, bw - 4) - 2)) + BORDER(" │") + "\n");
  }
  process.stdout.write(BORDER("└" + "─".repeat(bw) + "┘") + "\n");
  await sleep(400);

  // ── Step 9: Build context string with ALL relevant file contents ──────────
  let context = "## TASK: Fix dynamic product/feature pages so clicking any item opens its detail page.\n\n";
  context += `App directory: ${appDir}\n`;
  context += `Dynamic route to fix: /${dynamicRoute}/[id]\n`;
  context += `List page: ${path.relative(cwd, listPagePath).replace(/\\/g, "/")}\n\n`;

  context += `### LIST PAGE CONTENT (${path.relative(cwd, listPagePath).replace(/\\/g, "/")}):\n\`\`\`tsx\n${listPageSrc}\n\`\`\`\n\n`;

  if (dynamicFolders.length > 0) {
    const dynPage = path.join(dynamicFolders[0].folder, "page.tsx");
    if (fs.existsSync(dynPage)) {
      const dynSrc = fs.readFileSync(dynPage, "utf8");
      context += `### EXISTING DYNAMIC PAGE (${path.relative(cwd, dynPage).replace(/\\/g, "/")}):\n\`\`\`tsx\n${dynSrc}\n\`\`\`\n\n`;
    }
  }

  // Read product/page.tsx if exists
  const productListPage = path.join(routeDir, "page.tsx");
  if (fs.existsSync(productListPage) && productListPage !== listPagePath) {
    const src = fs.readFileSync(productListPage, "utf8");
    context += `### PRODUCT LIST PAGE (${path.relative(cwd, productListPage).replace(/\\/g, "/")}):\n\`\`\`tsx\n${src}\n\`\`\`\n\n`;
  }

  // Build unique image URLs for each product
  const productImageIds = [
    "1523275335684-37898b6baf30","1491553895911-0055eca6402d","1505740420928-5e560c06d30e",
    "1560343090-f0409e92791a","1526170375885-74d8502ef243","1547996663-b85580e932cd",
    "1523170335258-f5ed11844a49","1508685096489-7aacd43bd3b1","1434056886845-dac89ffe9b56",
    "1585386959984-a4155224a1ad","1496181133206-80ce9b88a853","1517336714731-489689fd1ca8",
  ];
  const imageMapLines = productImageIds.slice(0, 8).map((id, i) =>
    `  "${i+1}": "https://images.unsplash.com/photo-${id}?w=800&h=600&fit=crop&q=85"`
  ).join(",\n");

  context += `## WHAT TO DO:
1. Find the products/features data array in the list page — READ IT CAREFULLY
2. Make sure each item has a unique id field (string: "1", "2", "3"...)
3. Add a unique image to EVERY item in the data array using these verified URLs:
${imageMapLines}
4. Wrap each product card with: <Link href={"/product/" + item.id}> (use "use client" at top)
5. Import Link from "next/link"
6. Create/fix app/${dynamicRoute}/[id]/page.tsx:
   - COPY the EXACT SAME data array from the list page (with all ids + unique images)
   - export default async function Page({ params }: { params: Promise<{ id: string }> })
   - const { id } = await params
   - const product = products.find(p => p.id === id)
   - if (!product) return notFound()
   - Show: product.image, product.name, product.price, product.description
   - Add Back button: <Link href="/">← Back</Link>
   - generateStaticParams returns all ids
7. CRITICAL: dynamic page image MUST be product.image — NOT a hardcoded URL
8. CRITICAL: each product in data array MUST have its OWN different image URL`;

  // ── Step 10: Send to AI with full context ─────────────────────────────────
  await generateCode(context, 1);
  return true;
}

// ============================================================
//  REAL IMAGE REPLACER — called at write-time for every file
// ============================================================

async function fetchRealUnsplashUrl(keyword, width, height, index) {
  // Try Unsplash API first
  try {
    const apiKey = "49e37f9294f625c9cc4c9d82060906a52b7f0948d90e43b29a4a685ad8f65794";
    const q     = encodeURIComponent(keyword.replace(/[-_]/g, " "));
    const url   = `https://api.unsplash.com/search/photos?query=${q}&per_page=10&orientation=landscape&client_id=${apiKey}`;
    const res   = await axios.get(url, { timeout: 6000 });
    const list  = res.data?.results || [];
    if (list.length > 0) {
      const photo = list[index % list.length];
      return `${photo.urls.raw}&w=${width}&h=${height}&fit=crop&q=85&auto=format`;
    }
  } catch {}
  // Curated library fallback (real Unsplash IDs, no API needed)
  return getCuratedImage(keyword, width, height, index);
}

// Replace ALL image URLs in generated code with real Unsplash photos
async function replaceImagesWithReal(code) {
  if (!code) return code;

  // Match all picsum/unsplash/broken image URLs
  const URL_RE = /https?:\/\/(?:picsum\.photos\/seed\/[^\s"'`)\]]+|source\.unsplash\.com\/[^\s"'`)\]]+|images\.unsplash\.com\/photo-[^\s"'`)\]]+)/g;
  const allMatches = [...code.matchAll(URL_RE)];
  if (allMatches.length === 0) return code;

  // Group by keyword — extract from picsum seed or surrounding context
  const toReplace = [];
  const seen = new Map(); // keyword → count (for unique index per keyword)

  for (const match of allMatches) {
    const url = match[0];

    // Extract keyword from picsum seed: picsum.photos/seed/KEYWORD/w/h
    let keyword = "product";
    const picsumMatch = url.match(/picsum\.photos\/seed\/([^\/\s"'`]+)\//);
    if (picsumMatch) {
      // Use seed directly — "product-1", "watch", "luxury-watch" etc
      keyword = decodeURIComponent(picsumMatch[1]).replace(/-\d+$/, ""); // strip trailing number
    } else {
      // For unsplash URLs, look at surrounding code for context
      const pos = match.index;
      const around = code.slice(Math.max(0, pos - 200), pos + 100);
      const ctx = around.match(/(?:name|title|alt|label|product|item)\s*[:=]\s*["'`]([^"'`]{2,40})["'`]/i)
               || around.match(/seed\/([a-zA-Z][a-zA-Z0-9-]{2,30})\//);
      if (ctx) keyword = ctx[1].trim();
    }

    // Get unique index per keyword so each item gets different photo
    const idx = seen.get(keyword) ?? 0;
    seen.set(keyword, idx + 1);

    toReplace.push({ url, keyword, idx });
  }

  // Fetch all real URLs in parallel — each unique keyword+index = unique photo
  const fetched = await Promise.all(
    toReplace.map(({ keyword, idx }) => fetchImageUrl(keyword, idx))
  );

  // Replace from last to first (preserve indices)
  const sorted = toReplace.map((item, i) => ({ ...item, realUrl: fetched[i] }))
    .sort((a, b) => b.idx - a.idx);

  // Simple replacement — replace each URL
  for (let i = 0; i < toReplace.length; i++) {
    const { url, realUrl } = { ...toReplace[i], realUrl: fetched[i] };
    if (url !== realUrl) {
      // Replace only first occurrence each time
      code = code.replace(url, realUrl);
    }
  }

  return code;
}

// Auto-patch next.config.js in current working directory  
async function patchNextConfig() {
  const cwd = global.__projectRoot || process.cwd();
  try { ensureNextConfigImages(cwd); } catch {}
}



// ── Qwen-style thinking status text ──────────────────────────────────────────
function showThinkingStatus(userPrompt = "") {
  const lp = userPrompt.toLowerCase().trim();
  const bw = Math.min(process.stdout.columns || 88, 88);
  const original = userPrompt.trim();

  let lines = [];

  // ── Very short / single char input ────────────────────────────────────────
  if (lp.length <= 3) {
    lines = [
      `The user sent a brief message: "${original}".`,
      `This appears to be a short acknowledgment or greeting.`,
      `Spark will respond warmly and ask how it can help with the project.`,
    ];
  } else if (lp.includes("image") || lp.includes("photo") || lp.includes("pic") || lp.includes("tasveer") || lp.includes("banner")) {
    if (lp.includes("change") || lp.includes("update") || lp.includes("badlo") || lp.includes("lagao")) {
      lines = [
      `The user wants to update or replace images across the website.`,
      `This typically involves changing hero banners, product photos, or section backgrounds.`,
      `Spark will scan all relevant files and apply fresh images from Unsplash.`,
    ];
    } else {
      lines = [
      `The user has a question or request related to images on the website.`,
      `Spark will analyze the current image setup and provide guidance.`,
    ];
    }
  } else if (lp.includes("dark mode") || lp.includes("dark theme") || lp.includes("dark")) {
    lines = [
      `The user is requesting a dark mode theme for the website.`,
      `This involves updating colors, backgrounds, and text throughout all components.`,
      `Spark will implement a complete dark theme with proper contrast ratios.`,
    ];
  } else if (lp.includes("dynamic") || lp.includes("[id]") || lp.includes("detail page") || lp.includes("click") || lp.includes("khul")) {
    lines = [
      `The user is experiencing an issue with a dynamic route or detail page.`,
      `This often involves incorrect data fetching, broken params, or missing product data.`,
      `Spark will diagnose and fix the dynamic page routing and data flow.`,
    ];
  } else if (lp.includes("navbar") || lp.includes("header") || lp.includes("nav bar")) {
    lines = [
      `The user wants changes made to the navigation or header component.`,
      `Spark will update the navbar with the requested modifications.`,
    ];
  } else if (lp.includes("footer")) {
    lines = [
      `The user wants to modify the footer section of the website.`,
      `Spark will update the footer content, links, or styling as requested.`,
    ];
  } else if ((lp.includes("fix") || lp.includes("error") || lp.includes("bug")) && lp.length < 60) {
    lines = [
      `The user has encountered a bug or error in their project.`,
      `Spark will analyze the issue, identify the root cause, and apply a fix.`,
    ];
  } else if (lp.includes("nahi") || lp.includes("nhi") || lp.includes("problem") || lp.includes("issue")) {
    lines = [
      `The user is describing a problem or unexpected behavior on the website.`,
      `Spark will investigate the issue and implement the appropriate solution.`,
    ];
  } else if (lp.includes("create") || lp.includes("banao") || lp.includes("bana") || lp.includes("build") || lp.includes("make")) {
    lines = [
      `The user wants to create a new page, component, or feature.`,
      `Spark will build it with clean code, proper styling, and full functionality.`,
    ];
  } else if (lp.includes("add") || lp.includes("lagao") || lp.includes("laga")) {
    lines = [
      `The user wants to add a new element or feature to the existing project.`,
      `Spark will integrate it seamlessly with the current codebase and design.`,
    ];
  } else if (lp.includes("color") || lp.includes("colour") || lp.includes("rang")) {
    lines = [
      `The user wants to update the color palette or visual theme of the website.`,
      `Spark will apply the new colors consistently across all components.`,
    ];
  } else if (lp.includes("font") || lp.includes("text") || lp.includes("typography")) {
    lines = [
      `The user wants to change fonts, text sizes, or typographic styles.`,
      `Spark will update the typography throughout the project for a consistent look.`,
    ];
  } else if (lp.includes("responsive") || lp.includes("mobile") || lp.includes("phone")) {
    lines = [
      `The user wants the website to look and work better on mobile devices.`,
      `Spark will add responsive breakpoints and fix layout issues for smaller screens.`,
    ];
  } else if (lp.includes("animation") || lp.includes("animate") || lp.includes("transition")) {
    lines = [
      `The user wants to enhance the UI with animations or smooth transitions.`,
      `Spark will add polished motion effects that improve the user experience.`,
    ];
  } else if (lp.includes("product") || lp.includes("shop") || lp.includes("store") || lp.includes("cart")) {
    lines = [
      `The user has a request related to the product listing or shop section.`,
      `Spark will make the necessary updates to the product or e-commerce functionality.`,
    ];
  } else if (lp.includes("?") || lp.startsWith("kya") || lp.startsWith("kyun") || lp.startsWith("how") || lp.startsWith("what") || lp.startsWith("why")) {
    lines = [
      `The user has asked a question about their project or development in general.`,
      `Spark will provide a clear and helpful answer.`,
    ];
  } else if (lp.includes("design") || lp.includes("ui") || lp.includes("layout") || lp.includes("style")) {
    lines = [
      `The user wants to improve the visual design or page layout.`,
      `Spark will enhance the UI with better spacing, alignment, and aesthetics.`,
    ];
  } else if (lp.includes("undo") || lp.includes("wapas") || lp.includes("revert")) {
    lines = [
      `The user wants to revert the most recent change made to the project.`,
      `Spark will restore the previous version from the backup.`,
    ];
  } else if (lp.includes("hal") || lp.includes("kia") || lp.includes("kiya") || lp.includes("hello") || lp.includes("hi ") || lp === "hi" || lp.includes("hey") || lp.includes("salam") || lp.includes("assalam")) {
    lines = [
      `The user is starting a conversation or checking in on their project.`,
      `Spark will greet them and let them know it's ready to help with any task.`,
    ];
  } else if (lp.includes("sab") || lp.includes("theek") || lp.includes("acha") || lp.includes("okay") || lp.includes("ok")) {
    lines = [
      `The user acknowledged the previous work and seems satisfied with the result.`,
      `Spark is ready to take on the next task whenever they're ready.`,
    ];
  } else if (lp.includes("thanks") || lp.includes("shukriya") || lp.includes("thank") || lp.includes("shukria")) {
    lines = [
      `The user is expressing appreciation for the work completed so far.`,
      `Spark will acknowledge and remain ready for further instructions.`,
    ];
  } else if (lp.includes("help") || lp.includes("madad") || lp.includes("karo")) {
    lines = [
      `The user is looking for assistance with their development project.`,
      `Spark will assess the request and provide the most helpful response.`,
    ];
  } else if (lp.includes("start") || lp.includes("shuru") || lp.includes("begin")) {
    lines = [
      `The user wants to start or launch their application.`,
      `Spark will run the appropriate command to get the dev server up and running.`,
    ];
  } else if (lp.includes("check") || lp.includes("dekho") || lp.includes("show")) {
    lines = [
      `The user wants to inspect or review a part of their project.`,
      `Spark will read the relevant files and present the information clearly.`,
    ];
  } else {
    const clean = userPrompt.trim();
    const wordCount = clean.split(/\s+/).length;
    if (wordCount <= 2) {
      lines = [
        `The user sent a short message: "${clean}".`,
        `Spark will interpret the intent and ask for clarification if needed.`,
      ];
    } else if (wordCount <= 6) {
      lines = [
        `The user is requesting: "${clean}" for their project.`,
        `Spark will analyze this and determine the best course of action.`,
      ];
    } else {
      const first8 = clean.split(/\s+/).slice(0, 8).join(" ");
      lines = [
        `The user has sent a detailed request: "${first8}${wordCount > 8 ? "..." : ""}".`,
        `Spark is analyzing the full context of this request.`,
        `The appropriate files will be identified and updated accordingly.`,
      ];
    }
  }

  // Clean professional status — no box, just elegant indented lines
  const termW = Math.min(process.stdout.columns || 88, 110);
  console.log("");
  for (let i = 0; i < lines.length; i++) {
    if (i === 0) {
      console.log(chalk.hex("#7C9EFF")("  ◈  ") + chalk.white(lines[i]));
    } else {
      console.log(chalk.gray("     ") + chalk.gray(lines[i]));
    }
  }
  console.log("");
}

// ============================================================
//  MAIN EXPORT
// ============================================================


// ══════════════════════════════════════════════════════════════════════════════
//  /fast  — Scaffold a full FastAPI project in current directory
// ══════════════════════════════════════════════════════════════════════════════
async function runFastCommand(projectCtx) {
  const cwd  = global.__projectRoot || process.cwd();
  const bw   = Math.min(process.stdout.columns || 88, 88);
  const name = path.basename(cwd);

  await showBox("plan", [
    "Scaffolding FastAPI project: " + name,
    "  1. main.py          — FastAPI app entry point",
    "  2. requirements.txt — dependencies",
    "  3. .env             — environment variables",
    "  4. models/          — Pydantic models",
    "  5. routes/          — API route files",
    "  6. database.py      — DB connection (SQLite default)",
    "  7. README.md        — setup & usage guide",
  ]);

  const files = {
    "main.py": `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routes import items, users
from database import engine, Base

Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="${name} API",
    description="Auto-generated FastAPI project by Spark",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(items.router, prefix="/items", tags=["Items"])
app.include_router(users.router, prefix="/users", tags=["Users"])

@app.get("/")
def root():
    return {"message": "Welcome to ${name} API", "docs": "/docs"}
`,

    "database.py": `from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./app.db")

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
`,

    "models/__init__.py": "",

    "models/item.py": `from sqlalchemy import Column, Integer, String, Float, DateTime
from sqlalchemy.sql import func
from database import Base

class Item(Base):
    __tablename__ = "items"

    id          = Column(Integer, primary_key=True, index=True)
    title       = Column(String, index=True, nullable=False)
    description = Column(String, nullable=True)
    price       = Column(Float, default=0.0)
    created_at  = Column(DateTime(timezone=True), server_default=func.now())
`,

    "models/user.py": `from sqlalchemy import Column, Integer, String, Boolean, DateTime
from sqlalchemy.sql import func
from database import Base

class User(Base):
    __tablename__ = "users"

    id         = Column(Integer, primary_key=True, index=True)
    email      = Column(String, unique=True, index=True, nullable=False)
    username   = Column(String, unique=True, index=True, nullable=False)
    is_active  = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
`,

    "routes/__init__.py": "",

    "routes/items.py": `from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List, Optional
from database import get_db
from models.item import Item

router = APIRouter()

class ItemCreate(BaseModel):
    title: str
    description: Optional[str] = None
    price: float = 0.0

class ItemResponse(BaseModel):
    id: int
    title: str
    description: Optional[str]
    price: float
    class Config:
        from_attributes = True

@router.get("/", response_model=List[ItemResponse])
def get_items(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    return db.query(Item).offset(skip).limit(limit).all()

@router.get("/{item_id}", response_model=ItemResponse)
def get_item(item_id: int, db: Session = Depends(get_db)):
    item = db.query(Item).filter(Item.id == item_id).first()
    if not item:
        raise HTTPException(status_code=404, detail="Item not found")
    return item

@router.post("/", response_model=ItemResponse, status_code=201)
def create_item(item: ItemCreate, db: Session = Depends(get_db)):
    db_item = Item(**item.dict())
    db.add(db_item); db.commit(); db.refresh(db_item)
    return db_item

@router.put("/{item_id}", response_model=ItemResponse)
def update_item(item_id: int, item: ItemCreate, db: Session = Depends(get_db)):
    db_item = db.query(Item).filter(Item.id == item_id).first()
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    for k, v in item.dict().items():
        setattr(db_item, k, v)
    db.commit(); db.refresh(db_item)
    return db_item

@router.delete("/{item_id}")
def delete_item(item_id: int, db: Session = Depends(get_db)):
    db_item = db.query(Item).filter(Item.id == item_id).first()
    if not db_item:
        raise HTTPException(status_code=404, detail="Item not found")
    db.delete(db_item); db.commit()
    return {"message": "Item deleted"}
`,

    "routes/users.py": `from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr
from typing import List
from database import get_db
from models.user import User

router = APIRouter()

class UserCreate(BaseModel):
    email: str
    username: str

class UserResponse(BaseModel):
    id: int
    email: str
    username: str
    is_active: bool
    class Config:
        from_attributes = True

@router.get("/", response_model=List[UserResponse])
def get_users(skip: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    return db.query(User).offset(skip).limit(limit).all()

@router.post("/", response_model=UserResponse, status_code=201)
def create_user(user: UserCreate, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == user.email).first():
        raise HTTPException(status_code=400, detail="Email already registered")
    db_user = User(**user.dict())
    db.add(db_user); db.commit(); db.refresh(db_user)
    return db_user
`,

    "schemas/__init__.py": "",

    ".env": `DATABASE_URL=sqlite:///./app.db
SECRET_KEY=your-secret-key-here
DEBUG=True
HOST=0.0.0.0
PORT=8000
`,

    "requirements.txt": `fastapi==0.115.0
uvicorn[standard]==0.32.0
sqlalchemy==2.0.36
pydantic==2.9.2
python-dotenv==1.0.1
alembic==1.14.0
httpx==0.27.2
`,

    "README.md": `# ${name} — FastAPI Project

Auto-scaffolded by **Spark CLI**.

## Setup

\`\`\`bash
# Create virtual environment
python -m venv venv
source venv/bin/activate  # Windows: venv\\Scripts\\activate

# Install dependencies
pip install -r requirements.txt

# Run dev server
uvicorn main:app --reload --host 0.0.0.0 --port 8000
\`\`\`

## API Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET    | /         | Root / health check |
| GET    | /docs     | Swagger UI |
| GET    | /redoc    | ReDoc UI |
| GET    | /items    | List all items |
| POST   | /items    | Create item |
| GET    | /items/{id} | Get item |
| PUT    | /items/{id} | Update item |
| DELETE | /items/{id} | Delete item |
| GET    | /users    | List users |
| POST   | /users    | Create user |

## Project Structure

\`\`\`
${name}/
├── main.py          # FastAPI app entry
├── database.py      # DB connection & session
├── requirements.txt
├── .env
├── models/
│   ├── item.py
│   └── user.py
├── routes/
│   ├── items.py
│   └── users.py
└── schemas/
\`\`\`
`,
  };

  // Write all files
  let written = 0;
  for (const [relPath, fileContent] of Object.entries(files)) {
    const fp = path.join(cwd, relPath);
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, fileContent, "utf8");
    console.log(chalk.green("  ✓ ") + chalk.gray(relPath));
    written++;
  }

  await showBox("done", [
    "✓ FastAPI project scaffolded: " + name,
    "  " + written + " files created",
    "  Run: pip install -r requirements.txt",
    "  Run: uvicorn main:app --reload",
    "  Docs: http://localhost:8000/docs",
  ]);
  saveMemory("Scaffolded FastAPI project: " + name, "assistant");
}


// ══════════════════════════════════════════════════════════════════════════════
//  AUTO-ERROR-HANDLING EXECUTOR
// ══════════════════════════════════════════════════════════════════════════════

async function executeWithAutoFix(prompt, depth, targetProjectPath = null) {
  const MAX_ITERATIONS = 10;
  let iteration = 0;
  let success = false;
  let filesCreated = 0;
  const MIN_FILES_NEEDED = 5; // At least 5 files for a complete app

  // Track build start time for final summary
  const buildStartTime = Date.now();

  while (iteration < MAX_ITERATIONS && (!success || filesCreated < MIN_FILES_NEEDED)) {
    iteration++;

    try {
      console.log(chalk.hex("#7C9EFF").bold(`\n  ⚡ Building iteration ${iteration}/${MAX_ITERATIONS}\n`));

      // Call generateCode with target path context
      if (targetProjectPath) {
        // Inject target path into prompt
        const enhancedPrompt = `${prompt}\n\n## TARGET PROJECT PATH: ${targetProjectPath}
CRITICAL: All files must be created in this folder. Use create_file with paths like:
- ${targetProjectPath}/app/page.tsx
- ${targetProjectPath}/components/Header.tsx
- ${targetProjectPath}/package.json

When running commands, use cwd: "${targetProjectPath}"

FILES CREATED SO FAR: ${filesCreated}
KEEP CREATING FILES UNTIL YOU HAVE AT LEAST ${MIN_FILES_NEEDED} FILES.
DO NOT STOP - CONTINUE CREATING ALL REMAINING FILES.`;

        // Generate files - individual actions show their own progress
        await generateCode(enhancedPrompt, depth + 1);
      } else {
        await generateCode(prompt, depth + 1);
      }

      // Count files created in target directory
      if (targetProjectPath && fs.existsSync(targetProjectPath)) {
        const countFiles = (dir) => {
          let count = 0;
          try {
            const items = fs.readdirSync(dir);
            for (const item of items) {
              const full = path.join(dir, item);
              const stat = fs.statSync(full);
              if (stat.isDirectory()) count += countFiles(full);
              else count++;
            }
          } catch {}
          return count;
        };
        filesCreated = countFiles(targetProjectPath);
        if (filesCreated > 0) {
          console.log(chalk.hex("#34D399")(`  ✓ ${filesCreated} files created in project folder\n`));
        }
      }

      // Success if we have enough files
      if (filesCreated >= MIN_FILES_NEEDED) {
        success = true;
      }

    } catch (e) {
      console.log(chalk.hex("#F97316")(`\n  ⚠ Error in iteration ${iteration}: ${e.message.slice(0, 150)}\n`));

      if (iteration < MAX_ITERATIONS) {
        console.log(chalk.hex("#7C9EFF").bold("  🤖 Auto-fixing...\n"));

        // Send error context to AI for fix
        const fixPrompt = `Previous attempt failed with error: ${e.message}

Analyze the error and provide a fix. Try alternative approaches:
- If npm install fails, try: npm install --legacy-peer-deps
- If timeout, increase timeout or split into smaller commands
- If file exists, skip or update instead of create
- If port busy, kill port or use different port

Provide working solution now.`;

        await generateCode(fixPrompt, depth + 1);
      }
    }
  }

  // Show final summary
  const bw = Math.min(process.stdout.columns || 88, 88);
  const separator = chalk.gray("─".repeat(bw));
  const totalBuildTime = ((Date.now() - buildStartTime) / 1000).toFixed(1);

  console.log("\n" + separator);
  console.log(chalk.hex("#7C9EFF").bold("  ✦ Build Complete"));
  console.log(separator);

  if (success && filesCreated >= MIN_FILES_NEEDED) {
    console.log(chalk.hex("#34D399").bold("  ✓ Application built successfully!"));
    console.log(chalk.hex("#9CA3AF")(`  • ${filesCreated} files created`));
    console.log(chalk.hex("#9CA3AF")(`  • Total build time: ${totalBuildTime}s`));
    console.log(chalk.hex("#9CA3AF")("  • Dependencies installed"));
    console.log(chalk.hex("#9CA3AF")("  • Development server will start automatically"));
    console.log(chalk.hex("#9CA3AF")("  • Browser opens at http://localhost:3000"));

    // Server status check - only show if server isn't already showing ready message
    setTimeout(async () => {
      try {
        const isReady = await checkLocalhost(3000);
        if (isReady) {
          console.log(chalk.hex("#34D399").bold("  ✓ Server is ready - opening browser...\n"));
        }
      } catch {}
    }, 6000); // Wait 6 seconds after build completes
    
  } else {
    console.log(chalk.hex("#F97316").bold("  ⚠ Build completed with some issues"));
    console.log(chalk.hex("#9CA3AF")(`  • Only ${filesCreated} files created (needed ${MIN_FILES_NEEDED})`));
    console.log(chalk.hex("#9CA3AF")("  Review the output above for details"));
  }

  console.log(separator + "\n");
  saveMemory("Built complete application with auto-error-handling", "assistant");
}

// ══════════════════════════════════════════════════════════════════════════════
//  /sp.*  — SpecKit Plus commands — each generates a .md file
// ══════════════════════════════════════════════════════════════════════════════
async function runSpecKitCommand(cmd, projectCtx, userMessage = "", depth = 0) {
  const cwd  = global.__projectRoot || process.cwd();
  const bw   = Math.min(process.stdout.columns || 88, 88);
  const name = path.basename(cwd);
  const framework = projectCtx?.framework || "unknown";
  const now  = new Date().toISOString().split("T")[0];

  // Read existing .md files for context
  const existingMd = {};
  for (const f of ["CONSTITUTION.md","SPECIFICATION.md","TASK.md","PLAN.md","IMPLEMENTATION.md"]) {
    const fp = path.join(cwd, f);
    if (fs.existsSync(fp)) existingMd[f] = fs.readFileSync(fp, "utf8").slice(0, 800);
  }

  // Build AI prompt for each command
  let mdFile = "";
  let aiPrompt = "";
  let boxLabel = "";

  if (cmd === "/sp.constitution") {
    mdFile   = "CONSTITUTION.md";
    boxLabel = "Generating CONSTITUTION.md";
    aiPrompt = `You are generating a CONSTITUTION.md file for a software project.
Project: "${name}", Framework: ${framework}, Date: ${now}
${userMessage ? "User specific request: " + userMessage : ""}

Generate a professional CONSTITUTION.md with these sections:
# CONSTITUTION

## Project Identity
- Project name, purpose, core mission in 2-3 sentences

## AI Assistant Rules
- What the AI must always do
- What the AI must never do
- Code style rules
- Communication style

## Core Principles
- 5-7 guiding principles for development decisions

## Tech Stack Rules
- Framework-specific rules for ${framework}
- Naming conventions, file structure rules
- Testing requirements

## Quality Standards
- Performance benchmarks
- Accessibility requirements
- Security rules

Write complete, detailed content. No placeholders. Real, actionable rules.`;
  }

  else if (cmd === "/sp.specify") {
    mdFile   = "SPECIFICATION.md";
    boxLabel = "Generating SPECIFICATION.md";
    aiPrompt = `Generate a SPECIFICATION.md for project "${name}" (${framework}).
Date: ${now}
${userMessage ? "User specific request: " + userMessage + "\n" : ""}
${existingMd["CONSTITUTION.md"] ? "Constitution context:\n" + existingMd["CONSTITUTION.md"] : ""}

Create a complete SPECIFICATION.md with:
# SPECIFICATION

## Overview
Project description, goals, target users

## Features
### Core Features (MVP)
- List each feature with description

### Future Features
- Planned enhancements

## User Stories
- As a [user], I want to [action] so that [benefit]
- At least 6 user stories

## API / Data Model
- Key data entities and their fields
- API endpoints if applicable

## UI/UX Requirements
- Key screens/pages
- Navigation structure
- Design principles

## Non-Functional Requirements
- Performance targets
- Security requirements
- Scalability notes

Write complete, detailed, project-specific content.`;
  }

  else if (cmd === "/sp.task") {
    mdFile   = "TASK.md";
    boxLabel = "Generating TASK.md";
    aiPrompt = `Generate a TASK.md for project "${name}" (${framework}).
Date: ${now}
${userMessage ? "User specific request: " + userMessage + "\n" : ""}
${existingMd["SPECIFICATION.md"] ? "Spec context:\n" + existingMd["SPECIFICATION.md"] : ""}

Create TASK.md with:
# CURRENT TASK

## Task Title
Clear, specific task name

## Status
[ ] Not Started / [ ] In Progress / [x] Done

## Description
What exactly needs to be done (3-5 sentences)

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3
(at least 5 checkable criteria)

## Technical Notes
- Implementation hints
- Files to modify
- Dependencies needed

## Sub-tasks
- [ ] Sub-task 1
- [ ] Sub-task 2
(break into small steps)

## Definition of Done
What "complete" looks like

Make it specific to a realistic first task for this project.`;
  }

  else if (cmd === "/sp.plan") {
    mdFile   = "PLAN.md";
    boxLabel = "Generating PLAN.md";
    aiPrompt = `Generate a PLAN.md for project "${name}" (${framework}).
Date: ${now}
${userMessage ? "User specific request: " + userMessage + "\n" : ""}
${existingMd["SPECIFICATION.md"] ? "Spec:\n" + existingMd["SPECIFICATION.md"] : ""}
${existingMd["TASK.md"] ? "Task:\n" + existingMd["TASK.md"] : ""}

Create PLAN.md with:
# IMPLEMENTATION PLAN

## Phase 1: Foundation (Day 1-2)
- [ ] Step 1: ...
- [ ] Step 2: ...

## Phase 2: Core Features (Day 3-5)
- [ ] Step 1: ...

## Phase 3: Polish & Testing (Day 6-7)
- [ ] Step 1: ...

## File Structure
Show the planned directory tree

## Tech Decisions
Key technical choices and why

## Risks & Mitigations
What could go wrong and how to handle it

## Timeline
Estimated hours per phase

Make plan specific, actionable, realistic for ${framework}.`;
  }

  else if (cmd === "/sp.implement") {
    // ════════════════════════════════════════════════════════════════════════════
    //  FULLY AUTOMATED NEXT.JS APPLICATION BUILDER - WITH CONFIRMATION & NEW FOLDER
    // ════════════════════════════════════════════════════════════════════════════

    console.log(chalk.hex("#7C9EFF").bold("\n  🔨 Building Next.js Application from Specification\n"));

    // Read ALL spec files
    const specFiles = {
      constitution: "",
      specification: "",
      plan: "",
      task: ""
    };

    let specsFound = 0;
    try {
      if (fs.existsSync(path.join(cwd, "CONSTITUTION.md"))) {
        specFiles.constitution = fs.readFileSync(path.join(cwd, "CONSTITUTION.md"), "utf8").slice(0, 3000);
        specsFound++;
      }
      if (fs.existsSync(path.join(cwd, "SPECIFICATION.md"))) {
        specFiles.specification = fs.readFileSync(path.join(cwd, "SPECIFICATION.md"), "utf8").slice(0, 4000);
        specsFound++;
      }
      if (fs.existsSync(path.join(cwd, "PLAN.md"))) {
        specFiles.plan = fs.readFileSync(path.join(cwd, "PLAN.md"), "utf8").slice(0, 2000);
        specsFound++;
      }
      if (fs.existsSync(path.join(cwd, "TASK.md"))) {
        specFiles.task = fs.readFileSync(path.join(cwd, "TASK.md"), "utf8").slice(0, 1500);
        specsFound++;
      }
    } catch {}

    // Show what specs were found with preview
    const bw = Math.min(process.stdout.columns || 88, 88);
    console.log(
      "\n" +
      chalk.hex(COLORS.borderDark)("╭") +
      chalk.hex(COLORS.primaryStart).bold(" 📋 Specification Files Found ") +
      chalk.hex(COLORS.primaryEnd)("─".repeat(bw - 32)) +
      chalk.hex(COLORS.borderDark)("╮") +
      "\n"
    );
    
    const specStatus = [
      { file: "CONSTITUTION.md", found: specFiles.constitution },
      { file: "SPECIFICATION.md", found: specFiles.specification },
      { file: "PLAN.md", found: specFiles.plan },
      { file: "TASK.md", found: specFiles.task },
    ];
    
    for (const spec of specStatus) {
      const icon = spec.found ? chalk.hex(COLORS.successStart)("✓") : chalk.hex(COLORS.errorStart)("✗");
      const status = spec.found ? chalk.hex(COLORS.textDim)("(found)") : chalk.hex(COLORS.textDim)("(missing)");
      console.log(
        chalk.hex(COLORS.borderDark)("│") +
        "   " +
        icon +
        "  " +
        chalk.hex(COLORS.textBright)(spec.file.padEnd(20)) +
        "  " +
        status +
        chalk.hex(COLORS.borderDark)(" ".repeat(bw - 35)) +
        chalk.hex(COLORS.borderDark)("│") +
        "\n"
      );
    }
    
    console.log(
      chalk.hex(COLORS.borderDark)("╰") +
      chalk.hex(COLORS.primaryEnd)("─".repeat(bw)) +
      chalk.hex(COLORS.borderDark)("╯") +
      "\n"
    );

    // Show project type summary from specs
    if (specFiles.specification) {
      const projectNameMatch = specFiles.specification.match(/\*\*Project Name:\*\*\s*(.+)/i);
      const detectedProject = projectNameMatch ? projectNameMatch[1].trim() : "Unknown";
      
      console.log(
        chalk.hex(COLORS.borderDark)("╭") +
        chalk.hex(COLORS.infoStart).bold(" 📄 Project Summary ") +
        chalk.hex(COLORS.infoEnd)("─".repeat(bw - 20)) +
        chalk.hex(COLORS.borderDark)("╮") +
        "\n"
      );
      
      // Extract first few lines of description
      const lines = specFiles.specification.split("\n").slice(0, 8);
      for (const line of lines) {
        const cleanLine = line.replace(/^[#\-\*]\s*/, "").trim();
        if (cleanLine) {
          console.log(
            chalk.hex(COLORS.borderDark)("│") +
            "  " +
            chalk.hex(COLORS.textDim)(cleanLine.slice(0, bw - 6)) +
            chalk.hex(COLORS.borderDark)(" ".repeat(Math.max(0, bw - cleanLine.length - 8))) +
            chalk.hex(COLORS.borderDark)("│") +
            "\n"
          );
        }
      }
      
      console.log(
        chalk.hex(COLORS.borderDark)("╰") +
        chalk.hex(COLORS.infoEnd)("─".repeat(bw)) +
        chalk.hex(COLORS.borderDark)("╯") +
        "\n"
      );
    }

    // Check if minimum specs exist
    if (specsFound < 2) {
      console.log(chalk.yellow("  ⚠️  Warning: Less than 2 spec files found.\n"));
      console.log(chalk.gray("  Recommended: Run /sp.constitution, /sp.specify, /sp.task, /sp.plan first\n"));
    }

    // Ask for project name (new folder)
    const defaultProjectName = path.basename(cwd) + "-nextjs";
    const { projectName } = await inquirer.prompt([
      {
        type: "input",
        name: "projectName",
        message: chalk.hex(COLORS.infoStart)("Enter project name (new folder will be created):"),
        default: defaultProjectName,
      },
    ]);

    // Ask for confirmation
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: chalk.hex(COLORS.warningStart)("Build Next.js application in '" + projectName + "' folder?"),
        default: true,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow("\n  ⏭️  Build cancelled.\n"));
      return;
    }

    // Create new project folder
    const newProjectPath = path.join(cwd, projectName);
    if (!fs.existsSync(newProjectPath)) {
      fs.mkdirSync(newProjectPath, { recursive: true });
      console.log(chalk.hex(COLORS.successStart)(`\n  ✓ Created folder: ${newProjectPath}\n`));
    }

    // Show progress box
    await showBox("plan", [
      "📖 Reading specifications...",
      "🏗️  Creating Next.js application files...",
      "📦 Installing Next.js and dependencies...",
      "🚀 Starting development server...",
    ]);

    // Set build flag to skip image detection
    isBuildingProject = true;

    // Build Next.js specific prompt
    const nextjsPrompt = `BUILD A COMPLETE NEXT.JS APPLICATION IN THIS EXACT FOLDER: ${newProjectPath}

## SPECIFICATIONS:
${specFiles.constitution}
${specFiles.specification}
${specFiles.plan}
${specFiles.task}

═══════════════════════════════════════════════════════════════
CRITICAL: CREATE ALL FILES IN THE NEW FOLDER ONLY
═══════════════════════════════════════════════════════════════

DO NOT create files in:
- landing-page-app/
- current directory
- any existing folder

CREATE ALL FILES IN THIS NEW FOLDER ONLY:
${newProjectPath}

Create ALL these Next.js files with COMPLETE working code:

**Configuration Files:**
1. package.json - with next, react, react-dom, tailwindcss, postcss, autoprefixer
2. next.config.js - Next.js configuration
3. tailwind.config.js - Tailwind CSS config with content paths
4. postcss.config.js - PostCSS config
5. jsconfig.json or tsconfig.json - TypeScript/JavaScript config
6. .gitignore - Node.js gitignore
7. README.md - Setup and run instructions

**App Router Files:**
8. app/layout.js (or .tsx) - Root layout with html, body, metadata
9. app/page.js (or .tsx) - Main landing page based on specs
10. app/globals.css - Tailwind CSS imports and global styles

**Components (create all that are needed):**
11. components/Header.js - Navigation header with logo and links
12. components/Footer.js - Footer with copyright and links
13. components/Hero.js - Hero section for landing page
14. components/Features.js - Features section
15. components/About.js - About section
16. components/Contact.js - Contact form section
17. components/ProductCard.js - Product card component (if e-commerce)

**Additional Pages (based on specs):**
18. app/about/page.js - About page
19. app/contact/page.js - Contact page
20. app/products/page.js - Products listing page
21. app/products/[id]/page.js - Dynamic product detail page

REQUIREMENTS:
- Use Next.js 14+ App Router
- Use Tailwind CSS for all styling
- Responsive design (mobile-first)
- Dark mode support with dark: classes
- Professional UI/UX with proper spacing
- Working navigation between pages
- Real content based on specifications above
- NO placeholders - write complete code
- NO "lorem ipsum" - use real content from specs

RETURN ALL create_file ACTIONS NOW. Create every file listed above.
DO NOT stop after one file. Create ALL files in sequence.
BUILD THE COMPLETE NEXT.JS APPLICATION NOW!`;

    // Execute build with auto-error-handling and target project path
    await executeWithAutoFix(nextjsPrompt, depth, newProjectPath);

    // Reset build flag
    isBuildingProject = false;

    return;
  }

  else {
    console.log(chalk.yellow(`\n  Unknown SpecKit command: ${cmd}\n`));
    console.log(chalk.gray("  Available: /sp.constitution  /sp.specify  /sp.task  /sp.plan  /sp.implement\n"));
    return;
  }

  await showBox("plan", [boxLabel, "  Asking AI to generate content..."]);

  // Call AI to generate the .md content
  let mdContent = "";
  try {
    const response = await axios.post(
      "http://localhost:11434/api/generate",
      {
        model: "gpt-oss:120b-cloud",
        prompt: aiPrompt + "\n\nGenerate ONLY the markdown content. Start with # directly. No preamble.",
        stream: true,
        options: { temperature: 0.3, num_predict: 3000 },
      },
      { responseType: "stream" }
    );
    const spinner = ora(chalk.gray("  Generating " + mdFile + "...")).start();
    await new Promise((resolve, reject) => {
      response.data.on("data", chunk => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          try { const p = JSON.parse(line); if (p.response) mdContent += p.response; } catch {}
        }
      });
      response.data.on("end", resolve);
      response.data.on("error", reject);
    });
    spinner.stop();
  } catch (e) {
    console.log(chalk.yellow("  ⚠️  AI unavailable — generating template instead..."));
    // Fallback template
    mdContent = `# ${mdFile.replace(".md","")}\n\n> Generated by Spark CLI on ${now}\n> Project: ${name}\n\n*AI was unavailable. Edit this file with your project details.*\n`;
  }

  // Clean content
  mdContent = mdContent.replace(/^```(?:markdown|md)?\n?/i, "").replace(/\n?```$/,"").trim();
  if (!mdContent.startsWith("#")) mdContent = "# " + mdFile.replace(".md","") + "\n\n" + mdContent;

  // Add metadata header
  const header = `<!-- Generated by Spark CLI | ${now} | Project: ${name} -->\n`;
  const finalContent = header + mdContent + "\n";

  // Write file
  const fp = path.join(cwd, mdFile);
  fs.writeFileSync(fp, finalContent, "utf8");

  const lines = finalContent.split("\n").length;
  await showBox("done", [
    "✓ " + mdFile + " created",
    "  " + lines + " lines  ·  " + (finalContent.length / 1024).toFixed(1) + "kb",
    "  Location: " + fp,
  ]);

  // Print preview — first 8 lines
  console.log(chalk.gray("\n  Preview:"));
  const preview = finalContent.split("\n").slice(1, 8);
  for (const l of preview) {
    if (l.startsWith("#"))      console.log(chalk.hex("#7C9EFF").bold("  " + l));
    else if (l.startsWith("-")) console.log(chalk.gray("  " + l));
    else if (l.trim())          console.log(chalk.white("  " + l));
  }
  console.log(chalk.gray("  ...\n"));

  saveMemory("Generated " + mdFile + " for " + name, "assistant");
}

export default async function generateCode(userPrompt, depth = 0) {
  // ── AUTO STARTUP SCAN — runs once per session, no matter how CLI is launched
  if (depth === 0) await runStartupAnalysis();

  if (depth > 5) { console.log(chalk.yellow("\n⚠️  Max depth reached.\n")); return; }


  // ── Slash commands — /clear /help /cost /undo /history /status ─────────────
  if (userPrompt.trim().startsWith("/")) {
    const cmd = userPrompt.trim().toLowerCase();
    const bw  = Math.min(process.stdout.columns || 88, 88);
    const SEP = chalk.gray("  " + "─".repeat(bw - 4));

    // ── /undo ──────────────────────────────────────────────────────────────────
    if (cmd === "/undo" || cmd.startsWith("/undo ")) {
      const backupDir = path.join(process.cwd(), ".spark-backups");
      if (!fs.existsSync(backupDir)) {
        console.log(chalk.yellow("\n  ⚠️  No backups found.\n")); return;
      }
      const baks = fs.readdirSync(backupDir).filter(f => f.endsWith(".bak")).sort().reverse();
      if (baks.length === 0) {
        console.log(chalk.yellow("\n  ⚠️  No backups found.\n")); return;
      }
      const latest = baks[0];
      const withoutBak  = latest.replace(/\.\d+\.bak$/, "");
      const origRelative = withoutBak.replace(/_/g, "/").replace(/^([a-z]):/, "$1:");
      const origAbs = fs.existsSync(origRelative) ? origRelative : path.join(process.cwd(), origRelative);
      try {
        fs.copyFileSync(path.join(backupDir, latest), origAbs);
        fs.unlinkSync(path.join(backupDir, latest));
        await showBox("done", [`✓ Undone: ${withoutBak}`, `  Restored from backup`]);
        await triggerBrowserReload();
      } catch (e) { console.log(chalk.red(`  ❌ Undo failed: ${e.message}\n`)); }
      return;
    }

    // ── /clear ─────────────────────────────────────────────────────────────────
    if (cmd === "/clear") {
      // Save history ref before clearing
      const histPath = path.join(process.cwd(), ".spark-memory.json");
      if (fs.existsSync(histPath)) {
        fs.writeFileSync(histPath, JSON.stringify([], null, 2));
      }
      console.clear();
      console.log(
        "\n" +
        chalk.hex(COLORS.borderDark)("╭") +
        chalk.hex(COLORS.primaryStart).bold(" ✦ Spark ") +
        chalk.hex(COLORS.primaryEnd)("─".repeat(40)) +
        chalk.hex(COLORS.borderDark)("╮") +
        "\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  " +
        chalk.hex(COLORS.successStart)("Conversation cleared") +
        chalk.hex(COLORS.borderDark)(" ".repeat(35)) +
        "  " +
        chalk.hex(COLORS.borderDark)("│") +
        "\n" +
        chalk.hex(COLORS.borderDark)("╰") +
        chalk.hex(COLORS.primaryEnd)("─".repeat(60)) +
        chalk.hex(COLORS.borderDark)("╯") +
        "\n\n" +
        chalk.hex(COLORS.textDim)("  Context reset. Ready for new session.\n\n")
      );
      return;
    }

    // ── /history ───────────────────────────────────────────────────────────────
    if (cmd === "/history" || cmd === "/hist") {
      const hist = getConversationHistory();
      if (!hist || hist.length === 0) {
        console.log(chalk.hex(COLORS.textDim)("\n  No conversation history.\n")); return;
      }
      console.log(
        "\n" +
        chalk.hex(COLORS.borderDark)("╭") +
        chalk.hex(COLORS.infoStart).bold(" 📜 Conversation History ") +
        chalk.hex(COLORS.infoEnd)("─".repeat(50)) +
        chalk.hex(COLORS.borderDark)("╮") +
        "\n"
      );
      const recent = hist.slice(-10);
      for (const msg of recent) {
        const role = msg.role === "user"
          ? chalk.hex(COLORS.infoStart).bold("  you     ")
          : chalk.hex(COLORS.primaryStart).bold("  spark   ");
        const text = String(msg.content || "").slice(0, bw - 16).replace(/\n/g, " ");
        console.log(
          role +
          chalk.hex(COLORS.textDim)(" │ ") +
          chalk.hex(COLORS.textBright)(text)
        );
      }
      console.log(chalk.hex(COLORS.borderDark)("╰") + chalk.hex(COLORS.infoEnd)("─".repeat(70)) + chalk.hex(COLORS.borderDark)("╯") + "\n");
      return;
    }

    // ── /status ────────────────────────────────────────────────────────────────
    if (cmd === "/status") {
      const cwd = global.__projectRoot || process.cwd();
      const hist = getConversationHistory();
      const backupDir = path.join(cwd, ".spark-backups");
      const backups = fs.existsSync(backupDir)
        ? fs.readdirSync(backupDir).filter(f => f.endsWith(".bak")).length : 0;

      // Count project files
      let fileCount = 0;
      try {
        const walk = (dir, d = 0) => {
          if (d > 4) return;
          for (const item of fs.readdirSync(dir)) {
            if (["node_modules",".git",".next","dist"].includes(item)) continue;
            const full = path.join(dir, item);
            try {
              fs.statSync(full).isDirectory() ? walk(full, d + 1) : fileCount++;
            } catch {}
          }
        };
        walk(cwd);
      } catch {}

      console.log(
        "\n" +
        chalk.hex(COLORS.borderDark)("╭") +
        chalk.hex(COLORS.primaryStart).bold(" 📊 Session Status ") +
        chalk.hex(COLORS.primaryEnd)("─".repeat(50)) +
        chalk.hex(COLORS.borderDark)("╮") +
        "\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "   " +
        chalk.hex(COLORS.textDim)("Project  ") +
        chalk.hex(COLORS.successStart)(path.basename(cwd).padEnd(30)) +
        chalk.hex(COLORS.borderDark)(" │") +
        "\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "   " +
        chalk.hex(COLORS.textDim)("Files    ") +
        chalk.hex(COLORS.infoStart)((fileCount + " files").padEnd(30)) +
        chalk.hex(COLORS.borderDark)(" │") +
        "\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "   " +
        chalk.hex(COLORS.textDim)("Turns    ") +
        chalk.hex(COLORS.warningStart)((Math.floor((hist?.length || 0) / 2) + " exchanges").padEnd(30)) +
        chalk.hex(COLORS.borderDark)(" │") +
        "\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "   " +
        chalk.hex(COLORS.textDim)("Backups  ") +
        chalk.hex(COLORS.successStart)((backups + " saved").padEnd(30)) +
        chalk.hex(COLORS.borderDark)(" │") +
        "\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "   " +
        chalk.hex(COLORS.textDim)("Model    ") +
        chalk.hex(COLORS.primaryMid)("gpt-oss:120b-cloud".padEnd(30)) +
        chalk.hex(COLORS.borderDark)(" │") +
        "\n" +
        chalk.hex(COLORS.borderDark)("╰") +
        chalk.hex(COLORS.primaryEnd)("─".repeat(70)) +
        chalk.hex(COLORS.borderDark)("╯") +
        "\n"
      );
      return;
    }

    // ── /help ──────────────────────────────────────────────────────────────────
    if (cmd === "/help" || cmd === "/?") {
      console.log(
        "\n" +
        chalk.hex(COLORS.borderDark)("╭") +
        chalk.hex(COLORS.primaryStart).bold(" ✦ Spark — Slash Commands ") +
        chalk.hex(COLORS.primaryEnd)("─".repeat(45)) +
        chalk.hex(COLORS.borderDark)("╮") +
        "\n"
      );
      const cmds = [
        ["/help",     "❓", "Show this help menu"],
        ["/clear",    "🗑 ", "Clear conversation history and screen"],
        ["/undo",     "↩ ", "Restore last edited file from backup"],
        ["/history",  "📜", "Show recent conversation turns"],
        ["/status",   "📊", "Project info, file count, session stats"],
      ];
      for (const [c, icon, desc] of cmds) {
        console.log(
          "  " +
          chalk.hex(COLORS.infoStart)(icon) +
          "  " +
          chalk.hex(COLORS.primaryStart).bold(c.padEnd(14)) +
          chalk.hex(COLORS.textDim)(desc)
        );
      }
      console.log(
        "\n" +
        chalk.hex(COLORS.borderDark)("╰") +
        chalk.hex(COLORS.primaryEnd)("─".repeat(70)) +
        chalk.hex(COLORS.borderDark)("╯") +
        "\n\n" +
        chalk.hex(COLORS.textDim)("  Tip: type ") +
        chalk.hex(COLORS.infoStart)("@path/to/file") +
        chalk.hex(COLORS.textDim)(" to inject a file into your prompt\n\n")
      );
      return;
    }

    // ── Just "/" alone or unknown → show full menu ───────────────────────────
    if (cmd === "/") {
      showSlashMenu("/");
      return;
    }

    // ── /fast — scaffold FastAPI project in cwd ───────────────────────────────
    if (cmd === "/fast") {
      await runFastCommand(buildProjectContext());
      return;
    }

    // ── /template — scaffold from preset templates ───────────────────────────
    if (cmd === "/template" || cmd.startsWith("/template ")) {
      const args = cmd.slice("/template".length).trim();
      const [templateName, projectName] = args.split(" ").filter(Boolean);
      
      if (!templateName) {
        console.log(
          "\n" +
          chalk.hex(COLORS.borderDark)("╭") +
          chalk.hex(COLORS.infoStart).bold(" 📦 Available Templates ") +
          chalk.hex(COLORS.infoEnd)("─".repeat(50)) +
          chalk.hex(COLORS.borderDark)("╮") +
          "\n"
        );
        for (const [key, tpl] of Object.entries(PROJECT_TEMPLATES)) {
          console.log(
            chalk.hex(COLORS.borderDark)("│") +
            "  " +
            chalk.hex("#7C9EFF").bold(key.padEnd(20)) +
            chalk.hex(COLORS.textDim)(tpl.name) +
            chalk.hex(COLORS.borderDark)(" ".repeat(40)) +
            chalk.hex(COLORS.borderDark)("│") +
            "\n"
          );
        }
        console.log(
          chalk.hex(COLORS.borderDark)("╰") +
          chalk.hex(COLORS.infoEnd)("─".repeat(70)) +
          chalk.hex(COLORS.borderDark)("╯") +
          "\n\n" +
          chalk.gray("  Usage: /template <name> <project-folder>\n") +
          chalk.gray("  Example: /template nextjs-app my-app\n\n")
        );
        return;
      }
      
      const name = projectName || `${templateName}-app`;
      try {
        await scaffoldFromTemplate(templateName, name);
      } catch (e) {
        console.log(chalk.red(`\n  ❌ ${e.message}\n`));
      }
      return;
    }

    // ── /search — web search ─────────────────────────────────────────────────
    if (cmd === "/search" || cmd.startsWith("/search ")) {
      const query = cmd.slice("/search".length).trim();
      if (!query) {
        console.log(chalk.yellow("\n  ⚠️  Usage: /search <query>\n"));
        return;
      }
      
      const results = await webSearch(query, { count: 8 });
      if (results.success && results.results.length > 0) {
        console.log(
          "\n" +
          chalk.hex(COLORS.borderDark)("╭") +
          chalk.hex(COLORS.infoStart).bold(" 🔍 Search Results ") +
          chalk.hex(COLORS.infoEnd)("─".repeat(50)) +
          chalk.hex(COLORS.borderDark)("╮") +
          "\n"
        );
        results.results.forEach((r, i) => {
          console.log(
            chalk.hex(COLORS.borderDark)("│") +
            "  " +
            chalk.hex("#7C9EFF").bold(`${i + 1}.`) +
            " " +
            chalk.white(r.title.slice(0, 60)) +
            chalk.hex(COLORS.borderDark)(" ".repeat(50 - Math.min(r.title.length, 60))) +
            chalk.hex(COLORS.borderDark)("│") +
            "\n" +
            chalk.hex(COLORS.borderDark)("│") +
            "  " +
            chalk.gray(r.url.slice(0, 65)) +
            chalk.hex(COLORS.borderDark)(" ".repeat(55 - Math.min(r.url.length, 65))) +
            chalk.hex(COLORS.borderDark)("│") +
            "\n"
          );
        });
        console.log(
          chalk.hex(COLORS.borderDark)("╰") +
          chalk.hex(COLORS.infoEnd)("─".repeat(70)) +
          chalk.hex(COLORS.borderDark)("╯") +
          "\n"
        );
      }
      return;
    }

    // ── /fetch — fetch URL content ───────────────────────────────────────────
    if (cmd === "/fetch" || cmd.startsWith("/fetch ")) {
      const url = cmd.slice("/fetch".length).trim();
      if (!url) {
        console.log(chalk.yellow("\n  ⚠️  Usage: /fetch <url>\n"));
        return;
      }
      
      const result = await webFetch(url);
      if (result.success) {
        console.log(
          "\n" +
          chalk.hex(COLORS.borderDark)("╭") +
          chalk.hex(COLORS.successStart).bold(" ✓ Content Fetched ") +
          chalk.hex(COLORS.successEnd)("─".repeat(50)) +
          chalk.hex(COLORS.borderDark)("╮") +
          "\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  " +
          chalk.white(result.title.slice(0, 60)) +
          chalk.hex(COLORS.borderDark)(" ".repeat(55 - Math.min(result.title.length, 60))) +
          chalk.hex(COLORS.borderDark)("│") +
          "\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  " +
          chalk.gray(`${result.content.length} characters`) +
          chalk.hex(COLORS.borderDark)(" ".repeat(45)) +
          chalk.hex(COLORS.borderDark)("│") +
          "\n" +
          chalk.hex(COLORS.borderDark)("╰") +
          chalk.hex(COLORS.successEnd)("─".repeat(70)) +
          chalk.hex(COLORS.borderDark)("╯") +
          "\n\n" +
          chalk.gray(result.content.slice(0, 500) + "...\n\n")
        );
      } else {
        console.log(chalk.red(`\n  ❌ Fetch failed: ${result.error}\n`));
      }
      return;
    }

    // ── /git — Git operations ────────────────────────────────────────────────
    if (cmd === "/git" || cmd.startsWith("/git ")) {
      const args = cmd.slice("/git".length).trim().split(" ").filter(Boolean);
      const subCmd = args[0];
      
      if (!subCmd) {
        // Show git status
        if (!git.isRepo()) {
          console.log(chalk.yellow("\n  ⚠️  Not a git repository\n"));
          return;
        }
        
        const status = git.status();
        const branch = git.branch();
        const log = git.log(5);
        
        console.log(
          "\n" +
          chalk.hex(COLORS.borderDark)("╭") +
          chalk.hex(COLORS.infoStart).bold(" 📊 Git Status ") +
          chalk.hex(COLORS.infoEnd)("─".repeat(50)) +
          chalk.hex(COLORS.borderDark)("╮") +
          "\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  " +
          chalk.hex("#7C9EFF").bold("Branch:") +
          " " +
          chalk.white(branch) +
          chalk.hex(COLORS.borderDark)(" ".repeat(55 - branch.length)) +
          chalk.hex(COLORS.borderDark)("│") +
          "\n"
        );
        
        if (status.length > 0) {
          console.log(chalk.hex(COLORS.borderDark)("│") + "  " + chalk.yellow("Changes:") + chalk.hex(COLORS.borderDark)(" ".repeat(58)) + chalk.hex(COLORS.borderDark)("│"));
          for (const s of status.slice(0, 10)) {
            const line = `  ${s.status} ${s.file}`;
            console.log(chalk.hex(COLORS.borderDark)("│") + "  " + chalk.gray(line.slice(0, 60)) + chalk.hex(COLORS.borderDark)(" ".repeat(55 - Math.min(line.length, 60))) + chalk.hex(COLORS.borderDark)("│"));
          }
        } else {
          console.log(chalk.hex(COLORS.borderDark)("│") + "  " + chalk.green("No changes") + chalk.hex(COLORS.borderDark)(" ".repeat(56)) + chalk.hex(COLORS.borderDark)("│"));
        }
        
        console.log(chalk.hex(COLORS.borderDark)("│") + "  " + chalk.hex("#7C9EFF").bold("Recent Commits:") + chalk.hex(COLORS.borderDark)(" ".repeat(45)) + chalk.hex(COLORS.borderDark)("│"));
        for (const c of log) {
          const line = `  ${c.hash} ${c.message}`;
          console.log(chalk.hex(COLORS.borderDark)("│") + "  " + chalk.gray(line.slice(0, 60)) + chalk.hex(COLORS.borderDark)(" ".repeat(55 - Math.min(line.length, 60))) + chalk.hex(COLORS.borderDark)("│"));
        }
        
        console.log(
          chalk.hex(COLORS.borderDark)("╰") +
          chalk.hex(COLORS.infoEnd)("─".repeat(70)) +
          chalk.hex(COLORS.borderDark)("╯") +
          "\n"
        );
        return;
      }
      
      // Handle git subcommands
      if (subCmd === "commit" && args[1]) {
        const message = args.slice(1).join(" ");
        git.add();
        const success = git.commit(message);
        console.log(success ? chalk.green("\n  ✓ Committed\n") : chalk.red("\n  ❌ Commit failed\n"));
        return;
      }
      
      if (subCmd === "push") {
        const branch = args[1] || git.branch();
        const success = git.push(branch);
        console.log(success ? chalk.green("\n  ✓ Pushed\n") : chalk.red("\n  ❌ Push failed\n"));
        return;
      }
      
      if (subCmd === "branch") {
        const name = args[1];
        if (name) {
          const success = git.createBranch(name);
          console.log(success ? chalk.green(`\n  ✓ Branch '${name}' created\n`) : chalk.red("\n  ❌ Branch creation failed\n"));
        }
        return;
      }
      
      console.log(chalk.yellow("\n  Usage: /git [commit|push|branch] [args]\n"));
      return;
    }

    // ── /test — Run tests ────────────────────────────────────────────────────
    if (cmd === "/test" || cmd.startsWith("/test ")) {
      const args = cmd.slice("/test".length).trim();
      const watch = args.includes("--watch") || args.includes("-w");
      const file = args.replace(/--watch|-w/g, "").trim() || null;
      
      const result = await runTests({ watch, file });
      if (result.detected === false) {
        console.log(chalk.yellow("\n  ℹ️  No test framework detected. Install Jest or Vitest.\n"));
      }
      return;
    }

    // ── /lint — Run linter ───────────────────────────────────────────────────
    if (cmd === "/lint" || cmd.startsWith("/lint ")) {
      const file = cmd.slice("/lint".length).trim() || null;
      const result = await runLint(file);
      
      if (result.issues.length > 0) {
        console.log(chalk.yellow(`\n  ⚠️  ${result.issues.length} issues found\n`));
      } else {
        console.log(chalk.green("\n  ✓ No lint issues\n"));
      }
      return;
    }

    // ── /review — Code review ────────────────────────────────────────────────
    if (cmd === "/review" || cmd.startsWith("/review ")) {
      const files = cmd.slice("/review".length).trim().split(" ").filter(Boolean);
      
      if (files.length === 0) {
        // Review all project files
        const graph = buildDependencyGraph();
        const files = Array.from(graph.keys()).slice(0, 20);
        await codeReview(files);
      } else {
        await codeReview(files);
      }
      return;
    }

    // ── /graph — Dependency graph ────────────────────────────────────────────
    if (cmd === "/graph" || cmd.startsWith("/graph ")) {
      const entry = cmd.slice("/graph".length).trim() || null;
      const graph = buildDependencyGraph();
      visualizeDependencyGraph(graph, entry);
      return;
    }

    // ── /profile — Performance analysis ──────────────────────────────────────
    if (cmd === "/profile") {
      await analyzePerformance();
      return;
    }

    // ── /mcp — MCP status ────────────────────────────────────────────────────
    if (cmd === "/mcp") {
      await initializeMCP();
      
      console.log(
        "\n" +
        chalk.hex(COLORS.borderDark)("╭") +
        chalk.hex(COLORS.primaryStart).bold(" 🔌 MCP Servers ") +
        chalk.hex(COLORS.primaryEnd)("─".repeat(50)) +
        chalk.hex(COLORS.borderDark)("╮") +
        "\n"
      );
      
      for (const [name, server] of mcpServers) {
        const status = server.connected ? chalk.green("●") : chalk.red("○");
        console.log(
          chalk.hex(COLORS.borderDark)("│") +
          "  " +
          status +
          "  " +
          chalk.white(name.padEnd(20)) +
          chalk.hex(COLORS.textDim)(server.name) +
          chalk.hex(COLORS.borderDark)(" ".repeat(40)) +
          chalk.hex(COLORS.borderDark)("│") +
          "\n"
        );
      }
      
      console.log(
        chalk.hex(COLORS.borderDark)("╰") +
        chalk.hex(COLORS.primaryEnd)("─".repeat(70)) +
        chalk.hex(COLORS.borderDark)("╯") +
        "\n"
      );
      return;
    }

    // ── /chat — Interactive chat mode ────────────────────────────────────────
    if (cmd === "/chat") {
      await startChatMode();
      return;
    }

    // ── /sp.* — SpecKit Plus commands ─────────────────────────────────────────
    if (cmd.startsWith("/sp.")) {
      // Extract just the command (first word) and pass full prompt for context
      const spaceIdx = cmd.indexOf(" ");
      const actualCmd = spaceIdx > 0 ? cmd.slice(0, spaceIdx) : cmd;
      const userMessage = spaceIdx > 0 ? cmd.slice(spaceIdx + 1).trim() : "";
      await runSpecKitCommand(actualCmd, buildProjectContext(), userMessage, depth);
      return;
    }

    // partial match — show matching commands
    const partial = SLASH_COMMANDS_LIST.filter(c => c.cmd.startsWith(cmd));
    if (partial.length > 0) {
      showSlashMenu(cmd);
      return;
    }

    console.log(
      "\n" +
      chalk.yellow("  Unknown command: ") + chalk.white(cmd) + "\n" +
      chalk.gray("  Type ") + chalk.hex("#7C9EFF")("/help") + chalk.gray(" to see all commands.\n")
    );
    return;
  }

  const lowerPrompt = userPrompt.toLowerCase();
  const autoMode = lowerPrompt.includes(" auto") || lowerPrompt.endsWith("auto");

  // — Memory shortcuts —

  // ── UNDO: restore last backup ────────────────────────────────────────────
  if (/^undo$|^undo last|pichla.*wapas|wapas.*karo|revert.*last|last.*revert/i.test(lowerPrompt.trim())) {
    const backupDir = path.join(process.cwd(), ".spark-backups");
    if (!fs.existsSync(backupDir)) {
      console.log(chalk.yellow("\n  ⚠️  No backups found.\n")); return;
    }
    const baks = fs.readdirSync(backupDir).filter(f => f.endsWith(".bak")).sort().reverse();
    if (baks.length === 0) {
      console.log(chalk.yellow("\n  ⚠️  No backups found.\n")); return;
    }
    const latest = baks[0];
    // Parse original path from backup name: path_to_file.tsx.TIMESTAMP.bak
    const withoutBak = latest.replace(/\.\d+\.bak$/, "");
    // Re-construct path: replace _ with / but be careful about drive letters
    const origRelative = withoutBak.replace(/_/g, "/").replace(/^([a-z]):/, "$1:");
    const origAbs = fs.existsSync(origRelative) ? origRelative
      : path.join(process.cwd(), origRelative);
    try {
      fs.copyFileSync(path.join(backupDir, latest), origAbs);
      fs.unlinkSync(path.join(backupDir, latest));
      await showBox("done", [
        `✓ Undone: ${withoutBak}`,
        `  Restored from backup`,
      ]);
      await triggerBrowserReload();
    } catch (e) {
      console.log(chalk.red(`  ❌ Undo failed: ${e.message}\n`));
    }
    return;
  }

  if (/last question|last wala|pichla sawal|previous question/i.test(lowerPrompt)) {
    const q = getLastUserMessage();
    console.log(q ? chalk.cyan(`\n📝 Your last question:\n   "${q}"\n`) : chalk.yellow("\n⚠️  No previous question.\n"));
    return;
  }
  if (/last answer|last response|your last|pichla jawab/i.test(lowerPrompt)) {
    const a = getLastAssistantMessage();
    console.log(a ? chalk.cyan(`\n📝 My last answer:\n   "${a}"\n`) : chalk.yellow("\n⚠️  No previous answer.\n"));
    return;
  }

  saveMemory(userPrompt, "user");

  // ── @file mention — inject file content into prompt ─────────────────────────
  let atFileContext = "";
  const atMatches = [...userPrompt.matchAll(/@([\w./\\-]+\.[\w]+)/g)];
  if (atMatches.length > 0) {
    for (const m of atMatches) {
      const mentionedPath = m[1];
      const resolvedPath  = resolvePath(mentionedPath);
      if (fs.existsSync(resolvedPath)) {
        try {
          const src = fs.readFileSync(resolvedPath, "utf8");
          atFileContext += `\n\n## @FILE: ${mentionedPath}\n\`\`\`\n${src.slice(0, 1500)}\n\`\`\``;
        } catch {}
      }
    }
  }


if (!fs.existsSync("node_modules")) {
  console.log("Installing dependencies...");
  execSync("npm install", { stdio: "inherit" });
} else {
  console.log("Dependencies already installed ✅");
}

// ── /github — AUTO PUSH TO GITHUB (one command does everything) ─────────────
// Also detects natural language like "push to github", "upload my code", etc.
const githubPushPatterns = [
  /\/github/i,
  /push.*github|github.*push|push.*repo|repo.*push|upload.*github|github.*upload/i,
  /push.*code|code.*push|commit.*push|push.*commit/i,
  /deploy.*github|github.*deploy|publish.*github/i,
  /push.*my.*code|push.*my.*project|push.*everything/i,
  /make.*github.*repo|create.*github.*repo|build.*github.*repo/i,
];

if (githubPushPatterns.some(pattern => pattern.test(lowerPrompt))) {
  // Extract repo name from prompt if specified
  const repoNameMatch = lowerPrompt.match(/(?:repo|repository)\s+(?:name\s+)?["']?([a-zA-Z0-9_-]+)["']?/i);
  const args = repoNameMatch ? repoNameMatch[1] : 
               lowerPrompt.match(/github\s+([a-zA-Z0-9_-]+)/i)?.[1] || 
               path.basename(process.cwd());
  const repoName = args || "spark-project";
  const bw = Math.min(process.stdout.columns || 88, 88);

  console.log(
    "\n" +
    chalk.hex(COLORS.borderDark)("╭") +
    chalk.hex(COLORS.primaryStart).bold(" 🚀 Auto-Push to GitHub ") +
    chalk.hex(COLORS.primaryEnd)("─".repeat(bw - 26)) +
    chalk.hex(COLORS.borderDark)("╮") +
    "\n" +
    chalk.hex(COLORS.borderDark)("│") +
    "  This will:\n" +
    chalk.hex(COLORS.borderDark)("│") +
    "  1. Create GitHub repository (if needed)\n" +
    chalk.hex(COLORS.borderDark)("│") +
    "  2. Initialize git repo (if needed)\n" +
    chalk.hex(COLORS.borderDark)("│") +
    "  3. Configure git user (auto)\n" +
    chalk.hex(COLORS.borderDark)("│") +
    "  4. Add all files\n" +
    chalk.hex(COLORS.borderDark)("│") +
    "  5. Create initial commit\n" +
    chalk.hex(COLORS.borderDark)("│") +
    "  6. Push to GitHub\n" +
    chalk.hex(COLORS.borderDark)("│") +
    chalk.hex(COLORS.borderDark)("╰") +
    chalk.hex(COLORS.primaryEnd)("─".repeat(bw)) +
    chalk.hex(COLORS.borderDark)("╯") +
    "\n"
  );
  
  // Step 1: Check if git repo exists
  let isRepo = false;
  try {
    execSync("git rev-parse --git-dir", { stdio: "pipe" });
    isRepo = true;
    console.log(chalk.green("  ✓ Git repository already initialized\n"));
  } catch (e) {
    console.log(chalk.gray("  Initializing git repo...\n"));
    try {
      execSync("git init", { stdio: "pipe" });
      console.log(chalk.green("  ✓ Git repository initialized\n"));
    } catch (initErr) {
      console.log(chalk.red(`  ❌ Git init failed: ${initErr.message}\n`));
      return;
    }
  }
  
  // Step 2: Auto-configure git user
  const defaultName = process.env.USERNAME || process.env.USER || "Spark User";
  const defaultEmail = "spark@local.dev";
  
  try {
    execSync(`git config user.name "${defaultName}"`, { stdio: "pipe" });
    execSync(`git config user.email "${defaultEmail}"`, { stdio: "pipe" });
    console.log(chalk.green(`  ✓ Git user configured: ${defaultName} <${defaultEmail}>\n`));
  } catch (configErr) {
    console.log(chalk.yellow(`  ⚠ Could not configure git user\n`));
  }
  
  // Step 3: Add all files
  console.log(chalk.gray("  Adding all files...\n"));
  try {
    execSync("git add .", { stdio: "pipe" });
    console.log(chalk.green("  ✓ All files staged\n"));
  } catch (addErr) {
    console.log(chalk.yellow(`  ⚠ Some files could not be staged: ${addErr.message}\n`));
  }
  
  // Step 4: Create commit
  console.log(chalk.gray("  Creating initial commit...\n"));
  try {
    execSync('git commit -m "Initial commit: Full project"', { stdio: "pipe" });
    console.log(chalk.green("  ✓ Initial commit created\n"));
  } catch (commitErr) {
    if (commitErr.message.includes("nothing to commit")) {
      console.log(chalk.yellow("  ⚠ No changes to commit (already committed)\n"));
    } else {
      console.log(chalk.red(`  ❌ Commit failed: ${commitErr.message}\n`));
    }
  }
  
  // Step 5: Create GitHub repository and set remote
  console.log(chalk.gray("  Setting up GitHub repository...\n"));
  let remoteUrl = null;
  let githubToken = process.env.GITHUB_TOKEN;

  // Check if remote already exists
  try {
    remoteUrl = execSync("git remote get-url origin", { encoding: "utf8", stdio: "pipe" }).trim();
    console.log(chalk.green(`  ✓ Remote already configured: ${remoteUrl.slice(0, 60)}...\n`));
  } catch (e) {
    // No remote - create GitHub repo automatically
    if (!githubToken) {
      console.log(
        chalk.hex(COLORS.borderDark)("╭") +
        chalk.hex(COLORS.errorStart).bold(" 🔑 GitHub Token Required ") +
        chalk.hex(COLORS.errorEnd)("─".repeat(bw - 28)) +
        chalk.hex(COLORS.borderDark)("╮") +
        "\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  GITHUB_TOKEN not found in .env file\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  \n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  Get token: https://github.com/settings/tokens\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  Required scope: repo\n" +
        chalk.hex(COLORS.borderDark)("│") +
        chalk.hex(COLORS.borderDark)("╰") +
        chalk.hex(COLORS.errorEnd)("─".repeat(bw)) +
        chalk.hex(COLORS.borderDark)("╯") +
        "\n"
      );
      return;
    }

    // Get GitHub username first
    console.log(chalk.hex("#7C9EFF")(`  ⠋ Fetching GitHub user info...\n`));
    let githubUsername = null;
    
    try {
      const userResponse = await axios.get("https://api.github.com/user", {
        headers: {
          "Authorization": `token ${githubToken}`,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Spark-AI-CLI"
        },
        timeout: 10000
      });
      githubUsername = userResponse.data.login;
      console.log(chalk.green(`  ✓ GitHub user: ${githubUsername}\n`));
    } catch (userErr) {
      console.log(chalk.red(`  ❌ Failed to fetch GitHub user: ${userErr.message}\n`));
      return;
    }

    // Create GitHub repository via API
    console.log(chalk.hex("#7C9EFF")(`  ⠋ Creating repository "${repoName}" on GitHub...\n`));

    try {
      const createResponse = await axios.post(
        "https://api.github.com/user/repos",
        {
          name: repoName,
          private: false,
          auto_init: false,
          description: "Created by Spark AI CLI"
        },
        {
          headers: {
            "Authorization": `token ${githubToken}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Spark-AI-CLI"
          },
          timeout: 30000
        }
      );

      remoteUrl = createResponse.data.html_url + ".git";
      
      console.log(chalk.green(`  ✓ Repository created: ${createResponse.data.html_url}\n`));

      // Add remote (use HTTPS with token for seamless auth)
      const httpsUrlWithToken = `https://${githubToken}@github.com/${githubUsername}/${repoName}.git`;
      execSync(`git remote add origin ${httpsUrlWithToken}`, { stdio: "pipe" });
      console.log(chalk.green(`  ✓ Remote configured\n`));

    } catch (createErr) {
      const errorMsg = createErr.response?.data?.message || createErr.message;
      const errorDetails = createErr.response?.data || {};
      
      // Debug: Log full error for token issues
      console.log(chalk.gray(`  Debug: ${JSON.stringify(errorDetails, null, 2)}\n`));
      
      if (errorMsg.includes("already exists")) {
        console.log(chalk.yellow(`  ⚠ Repository "${repoName}" already exists\n`));
        console.log(chalk.hex("#7C9EFF")(`  ⠋ Using existing repository...\n`));

        const httpsUrlWithToken = `https://${githubToken}@github.com/${githubUsername}/${repoName}.git`;
        execSync(`git remote add origin ${httpsUrlWithToken}`, { stdio: "pipe" });
        remoteUrl = `https://github.com/${githubUsername}/${repoName}.git`;
        console.log(chalk.green(`  ✓ Remote configured: https://github.com/${githubUsername}/${repoName}\n`));
      } else {
        console.log(
          chalk.hex(COLORS.borderDark)("╭") +
          chalk.hex(COLORS.errorStart).bold(" 🔑 Token Permission Issue ") +
          chalk.hex(COLORS.errorEnd)("─".repeat(bw - 31)) +
          chalk.hex(COLORS.borderDark)("╮") +
          "\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  Your GitHub token needs the 'repo' permission.\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  \n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  Fix:\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  1. Go to: https://github.com/settings/tokens\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  2. Delete this token and create new one\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  3. Select: 'repo' (Full control of private repositories)\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  4. NOT just 'public_repo' - must be 'repo'\n" +
          chalk.hex(COLORS.borderDark)("│") +
          "  5. Update .env with new token\n" +
          chalk.hex(COLORS.borderDark)("│") +
          chalk.hex(COLORS.borderDark)("╰") +
          chalk.hex(COLORS.errorEnd)("─".repeat(bw)) +
          chalk.hex(COLORS.borderDark)("╯") +
          "\n"
        );
        return;
      }
    }
  }
  
  // Step 6: Push to GitHub
  console.log(chalk.gray("  Pushing to GitHub...\n"));
  
  // Detect current branch name
  let currentBranch = "main";
  try {
    currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8", stdio: "pipe" }).trim();
  } catch (e) {
    currentBranch = "main";
  }

  // Count files being pushed
  let fileCount = 0;
  let totalSize = 0;
  try {
    const gitStatus = execSync("git status --porcelain", { encoding: "utf8", stdio: "pipe" });
    const files = gitStatus.trim().split("\n").filter(f => f.trim());
    fileCount = files.length;
    
    // Calculate total size
    for (const fileLine of files) {
      const filePath = fileLine.slice(3).trim();
      try {
        const stats = fs.statSync(filePath);
        totalSize += stats.size;
      } catch {}
    }
  } catch {}

  // Show what's being pushed
  console.log(chalk.cyan(`  📦 Preparing ${fileCount} files (${(totalSize / 1024).toFixed(2)} KB)...\n`));
  
  // Create progress spinner
  const spinner = ora({
    text: chalk.hex("#7C9EFF")("Initializing push..."),
    spinner: "dots",
    color: "cyan"
  }).start();

  try {
    // Get commit count
    let commitCount = 0;
    try {
      const logOutput = execSync(`git log origin/${currentBranch}..HEAD --oneline 2>&1`, { encoding: "utf8", stdio: "pipe" });
      commitCount = logOutput.trim().split("\n").filter(l => l.trim()).length;
    } catch {
      commitCount = 1;
    }

    spinner.text = chalk.hex("#7C9EFF")(`Pushing ${commitCount} commit(s) to ${currentBranch}...`);
    
    // Execute push with progress output piped directly to console
    const pushStartTime = Date.now();
    
    try {
      // Use spawn to show real git progress
      spinner.stop();
      console.log(chalk.hex("#7C9EFF")("\n  ┌─ Git Push Progress " + "─".repeat(bw - 22) + "┐"));
      
      // Run git push and show real-time progress
      const pushChild = spawn("git", ["push", "-u", "origin", currentBranch, "--progress", "-v"], {
        stdio: ["inherit", "pipe", "pipe"],
        env: { ...process.env, GIT_PROGRESS: "1" }
      });

      let allOutput = "";
      let allError = "";

      pushChild.stdout.on("data", (data) => {
        const text = data.toString();
        allOutput += text;
        // Show git's real output line by line
        text.split("\n").filter(l => l.trim()).forEach(line => {
          console.log(chalk.hex("#7C9EFF")("  │") + " " + chalk.cyan(line));
        });
      });

      pushChild.stderr.on("data", (data) => {
        const text = data.toString();
        allError += text;
        // Show git's real progress from stderr
        text.split("\n").filter(l => l.trim()).forEach(line => {
          // Parse git progress: "Writing objects:  50% (45/91), 1.23 MiB | 123.00 KiB/s"
          if (line.includes("%") || line.includes("Counting") || line.includes("Compressing") || line.includes("Writing") || line.includes("Total")) {
            console.log(chalk.hex("#7C9EFF")("  │") + " " + chalk.green(line));
          } else {
            console.log(chalk.hex("#7C9EFF")("  │") + " " + chalk.yellow(line));
          }
        });
      });

      // Wait for push to complete
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pushChild.kill();
          reject(new Error("Push timed out after 180 seconds"));
        }, 180000);

        pushChild.on("close", (code) => {
          clearTimeout(timeout);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`git push exited with code ${code}`));
          }
        });

        pushChild.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      const pushDuration = ((Date.now() - pushStartTime) / 1000).toFixed(2);
      console.log(chalk.hex("#7C9EFF")("  └" + "─".repeat(bw - 1) + "┘\n"));
      
      console.log(chalk.green("  ✓ Successfully pushed to GitHub!\n"));
    
    // Show detailed statistics
    console.log(
      chalk.hex(COLORS.borderDark)("╭") +
      chalk.hex(COLORS.successStart).bold(" 📊 Push Statistics ") +
      chalk.hex(COLORS.successEnd)("─".repeat(bw - 21)) +
      chalk.hex(COLORS.borderDark)("╮") +
      "\n" +
      chalk.hex(COLORS.borderDark)("│") +
      `  Files: ${fileCount}\n` +
      chalk.hex(COLORS.borderDark)("│") +
      `  Size: ${(totalSize / 1024).toFixed(2)} KB (${totalSize} bytes)\n` +
      chalk.hex(COLORS.borderDark)("│") +
      `  Commits: ${commitCount}\n` +
      chalk.hex(COLORS.borderDark)("│") +
      `  Duration: ${pushDuration}s\n` +
      chalk.hex(COLORS.borderDark)("│") +
      `  Branch: ${currentBranch}\n` +
      chalk.hex(COLORS.borderDark)("│") +
      chalk.hex(COLORS.borderDark)("╰") +
      chalk.hex(COLORS.successEnd)("─".repeat(bw)) +
      chalk.hex(COLORS.borderDark)("╯") +
      "\n"
    );

    // Show success box
    console.log(
      chalk.hex(COLORS.borderDark)("╭") +
      chalk.hex(COLORS.successStart).bold(" ✓ Pushed to GitHub! ") +
      chalk.hex(COLORS.successEnd)("─".repeat(bw - 24)) +
      chalk.hex(COLORS.borderDark)("╮") +
      "\n" +
      chalk.hex(COLORS.borderDark)("│") +
      `  Repository: ${remoteUrl}\n` +
      chalk.hex(COLORS.borderDark)("│") +
      "  View on GitHub: " + remoteUrl.replace(".git", "") + "\n" +
      chalk.hex(COLORS.borderDark)("│") +
      chalk.hex(COLORS.borderDark)("╰") +
      chalk.hex(COLORS.successEnd)("─".repeat(bw)) +
      chalk.hex(COLORS.borderDark)("╯") +
      "\n"
    );

  } catch (innerErr) {
    // Push failed - show detailed error
    const fullError = innerErr.message || innerErr.stdout || innerErr.stderr || "";
    const errorLines = fullError.split("\n").filter(l => l.trim());
    
    console.log(chalk.hex("#7C9EFF")("  └" + "─".repeat(bw - 1) + "┘\n"));
    
    console.log(
      chalk.hex(COLORS.borderDark)("╭") +
      chalk.hex(COLORS.errorStart).bold(" ❌ Push Failed ") +
      chalk.hex(COLORS.errorEnd)("─".repeat(bw - 18)) +
      chalk.hex(COLORS.borderDark)("╮") +
      "\n"
    );
    
    // Show last 15 lines of actual git error
    const recentErrors = errorLines.slice(-15);
    for (const line of recentErrors) {
      console.log(chalk.hex(COLORS.borderDark)("│") + `  ${chalk.red(line)}`);
    }
    
    console.log(
      chalk.hex(COLORS.borderDark)("│") +
      "\n" +
      chalk.hex(COLORS.borderDark)("│") +
      `  Files attempted: ${fileCount}\n` +
      chalk.hex(COLORS.borderDark)("│") +
      `  Branch: ${currentBranch}\n` +
      chalk.hex(COLORS.borderDark)("│") +
      chalk.hex(COLORS.borderDark)("╰") +
      chalk.hex(COLORS.errorEnd)("─".repeat(bw)) +
      chalk.hex(COLORS.borderDark)("╯") +
      "\n"
    );
    
    // Common error solutions
    if (fullError.includes("rejected") || fullError.includes("remote error")) {
      console.log(chalk.yellow("  💡 Tip: Remote may have changes. Try: git pull --rebase origin " + currentBranch + "\n"));
    } else if (fullError.includes("Authentication") || fullError.includes("authentication")) {
      console.log(chalk.yellow("  💡 Tip: Authentication failed. Check your token/credentials.\n"));
    } else if (fullError.includes("Could not resolve") || fullError.includes("not found")) {
      console.log(chalk.yellow("  💡 Tip: Remote repository URL may be incorrect.\n"));
    } else if (fullError.includes("failed to push")) {
      console.log(chalk.yellow("  💡 Tip: Try pulling first: git pull origin " + currentBranch + " --rebase\n"));
    }
  }

  } catch (pushErr) {
    const pushMsg = pushErr.message || pushErr.stdout || "";
    
    if (pushMsg.includes("Authentication") || pushMsg.includes("authentication")) {
      console.log(
        chalk.hex(COLORS.borderDark)("╭") +
        chalk.hex(COLORS.errorStart).bold(" 🔑 Authentication Required ") +
        chalk.hex(COLORS.errorEnd)("─".repeat(bw - 29)) +
        chalk.hex(COLORS.borderDark)("╮") +
        "\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  GitHub requires authentication for push.\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  \n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  Option 1: Use GitHub Personal Access Token\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  1. Go to: https://github.com/settings/tokens\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  2. Generate new token (classic)\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  3. Select scopes: repo\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  4. Copy token\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  5. Update remote with token:\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "     git remote set-url origin https://<TOKEN>@github.com/user/repo.git\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  \n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  Option 2: Use GitHub CLI (easiest)\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "     gh auth login\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "     gh push\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  \n" +
        chalk.hex(COLORS.borderDark)("│") +
        "  Option 3: Use SSH\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "     git remote set-url origin git@github.com:user/repo.git\n" +
        chalk.hex(COLORS.borderDark)("│") +
        chalk.hex(COLORS.borderDark)("╰") +
        chalk.hex(COLORS.errorEnd)("─".repeat(bw)) +
        chalk.hex(COLORS.borderDark)("╯") +
        "\n"
      );
    } else {
      console.log(chalk.red(`  ❌ Push failed: ${pushMsg.slice(0, 200)}\n`));
    }
  }
  
  return;
}




  // ── AUTO FIX: dynamic page trigger — runs autofix automatically ─────────────
  const isDynamicFix = /dynamic.*page|page.*dynamic|product.*click|click.*product|product.*open|open.*product|feature.*click|click.*feature|link.*not.*work|not.*open|nhi.*open|open.*nhi|khul.*nhi|nhi.*khul|dynamic.*fix|fix.*dynamic/i.test(lowerPrompt);
  if (isDynamicFix && depth === 0) {
    await autofixDynamicPages(userPrompt);
    return;
  }

  // ── Dynamic page diagnosis — inject real file analysis into prompt ─────────
  let dynamicPageContext = "";
  if (/dynamic|not work|page.*work|route.*work|\[id\]|\[slug\]/i.test(lowerPrompt)) {
    const cwd = process.cwd();
    const findings = [];

    // Walk project looking for dynamic route folders
    function findDynamic(dir, depth = 0) {
      if (depth > 6) return;
      try {
        for (const item of fs.readdirSync(dir)) {
          const full = path.join(dir, item);
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              if (item.startsWith("[") && item.endsWith("]")) {
                const rel = path.relative(cwd, full).replace(/\\/g, "/");
                const pagePath = path.join(full, "page.tsx");
                const hasPage = fs.existsSync(pagePath);
                let issues = [];
                if (!hasPage) {
                  issues.push("MISSING page.tsx inside " + rel);
                } else {
                  const src = fs.readFileSync(pagePath, "utf8");
                  if (!src.includes("params")) issues.push("params prop missing");
                  if (!src.includes("await params") && src.includes("Promise")) issues.push("params not awaited (Next.js 15 requires await params)");
                  if (!src.includes("generateStaticParams") && !src.includes("dynamicParams")) issues.push("no generateStaticParams");
                  findings.push({ path: rel + "/page.tsx", lines: src.split("\n").length, issues, src: src.slice(0, 600) });
                }
                if (issues.length) findings.push({ path: rel, issues });
              }
              findDynamic(full, depth + 1);
            }
          } catch {}
        }
      } catch {}
    }
    findDynamic(cwd);

    // Also find Link hrefs pointing to dynamic routes
    const linkIssues = [];
    function checkLinks(dir, depth = 0) {
      if (depth > 5) return;
      try {
        for (const item of fs.readdirSync(dir)) {
          if (["node_modules",".next","dist"].includes(item)) continue;
          const full = path.join(dir, item);
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) { checkLinks(full, depth + 1); continue; }
            if (![".tsx",".jsx",".ts",".js"].includes(path.extname(item))) continue;
            const src = fs.readFileSync(full, "utf8");
            // Detect wrong Link hrefs like href="/products/[id]"
            const badLinks = [...src.matchAll(/href=["'`][^"'`]*\[[\w]+\][^"'`]*["'`]/g)];
            if (badLinks.length) {
              const rel = path.relative(cwd, full).replace(/\\/g, "/");
              linkIssues.push({ file: rel, badHrefs: badLinks.map(m => m[0]) });
            }
          } catch {}
        }
      } catch {}
    }
    checkLinks(cwd);

    if (findings.length || linkIssues.length) {
      dynamicPageContext = "\n\n## DYNAMIC PAGE DIAGNOSIS (auto-scanned):\n";
      for (const f of findings) {
        dynamicPageContext += "FILE: " + f.path + "\n";
        if (f.issues?.length) dynamicPageContext += "ISSUES: " + f.issues.join(", ") + "\n";
        if (f.src) dynamicPageContext += "CONTENT:\n" + f.src + "\n";
      }
      for (const l of linkIssues) {
        dynamicPageContext += "BAD LINK in " + l.file + ": " + l.badHrefs.join(", ") + " — should use template literal with real id\n";
      }
    }
  }

  // ============================================================
  //  STEP 1: DETECT IF TASK NEEDS PROJECT SCAN
  // ============================================================

  // Code/file/image action keywords — these ALWAYS need a scan
  const hasActionKeyword = /create|make|build|add|edit|update|change|fix|delete|remove|generate|install|start|run|open|write|refactor|rename|image|photo|pic|deploy|push|import|export|style|format|debug/i.test(lowerPrompt);

  // Very short input (1-3 words, no action keyword) = conversational / general
  const wordCount = lowerPrompt.trim().split(/\s+/).length;
  const isVeryShort = wordCount <= 3 && !hasActionKeyword;

  // Classic general question starters
  const isQuestionStarter = /^(what|why|how|who|where|when|explain|tell me|describe|define|is |are |can |could |should |do |does |did |will |would |have |has )/i.test(lowerPrompt.trim());

  // General = question starter OR very short input, AND no action keyword
  const isGeneralQuestion = (isQuestionStarter || isVeryShort) && !hasActionKeyword;

  // Use cached context — scanned once at startup
  const projectCtx = buildProjectContext();

  // ============================================================
  //  STEP 2: IMAGE CHANGE DETECTION (skip during project build)
  // ============================================================
  
  // Declare at top level so it's accessible later
  let fetchedImageUrl = null;
  const imgIntent = parseImageIntent(userPrompt);
  
  // Skip image detection if we're building a new project
  if (isBuildingProject) {
    // Skip image detection - we're creating new files, not updating existing ones
  } else if (imgIntent.isImageChange) {
    const targetSections = detectTargetSections(userPrompt);
    const sectionSubjects = extractSectionSubjects(userPrompt, targetSections, imgIntent.subject);
    const wantsDifferent = /different|alag|alag alag|each|every|sabki|sab alag|unique/i.test(userPrompt);
    const wantsAll = /all|sab|saari|har|every|each/i.test(userPrompt);

    console.log(chalk.cyan(`  ⚡ Image change detected:`));
    for (const ss of sectionSubjects) {
      console.log(chalk.gray(`     ${ss.section ? `[${ss.section}]` : "[all]"} → "${ss.subject}"${wantsDifferent ? " (different each)" : ""}`));
    }
    console.log();

    let anyApplied = false;

    for (const ss of sectionSubjects) {
      const sections = ss.section ? [ss.section] : targetSections;
      let applied = false;

      if (wantsDifferent || wantsAll) {
        applied = await applyMultipleImagesDirectly(ss.subject, projectCtx, sections);
      } else {
        const imgSpinner = ora(`  🖼️  Fetching "${ss.subject}"${ss.section ? ` → [${ss.section}]` : ""}...`).start();
        try {
          const imgResult = await fetchUnsplashImage(ss.subject, 1920, 1080);
          fetchedImageUrl = imgResult.url;
          imgSpinner.succeed(
            chalk.green(`  ✓ `) + chalk.gray(`[${imgResult.source}] `) + chalk.cyan(fetchedImageUrl.slice(0, 60) + "...")
          );
          applied = await applyImageDirectly(fetchedImageUrl, projectCtx, sections);
        } catch (error) {
          imgSpinner.fail(chalk.red("  Fetch failed"));
          console.log(chalk.yellow(`\n⚠️  Error: ${error.message}\n`));
          console.log(chalk.cyan("💡 Try again with different keywords or check internet connection\n"));
          applied = false;
        }
      }

      if (applied) anyApplied = true;
    }

    if (anyApplied) {
      saveMemory(`Image changed: ${userPrompt}`, "assistant");
      return;
    }
    console.log(chalk.gray("  → No existing image URLs found — AI will add images...\n"));
  }

  // ============================================================
  //  STEP 3: AI CALL
  // ============================================================

  const imageInstruction = fetchedImageUrl
    ? `\n\n## FETCHED IMAGE URL — USE THIS EXACTLY:\n${fetchedImageUrl}\nReplace existing image URLs in the relevant section using edit_file.`
    : imgIntent.isImageChange
      ? `\n\n## IMAGE TASK: User wants to change images. Subject: "${imgIntent.subject}". Use Unsplash URLs. Find image variables/src in key files above and replace them with a relevant Unsplash URL.`
      : "";

  const autoInstruction = autoMode
    ? "\n\n## AUTO MODE: Execute everything without asking. Show only final result."
    : "";

  // Short/vague input handling
  const shortInputInstruction = isVeryShort
    ? `\n\n## RESPONSE RULE: User sent very short message "${userPrompt.trim()}". Respond warmly, ask what they want to build or fix. Max 15 words. No lists or examples.`
    : (!hasActionKeyword && userPrompt.trim().split(/\s+/).length <= 3)
    ? `\n\n## RESPONSE RULE: Unclear short message. Ask ONE clarifying question, under 10 words.`
    : "";

  const taskInstruction = `\n\n## TASK: "${userPrompt}"\nComplete the FULL task. Do NOT stop midway.`;

  const MAX_RETRIES = 3;
  let aiResponse = null;

  // ── Qwen-style: show PLAN box for complex multi-step tasks ──────────────────
  const wantsCreate = /create|add|make|build|generate|write/i.test(lowerPrompt);
  const wantsStart  = /start|run|dev|launch|open/i.test(lowerPrompt);
  const wantsLink   = /after|then|and|also|link|import/i.test(lowerPrompt);

  // Show plan box for complex tasks (Qwen shows steps before doing)
  const isComplexTask = (wantsCreate && wantsStart) || (wantsCreate && wantsLink)
    || /full.*app|complete.*app|entire.*app|whole.*app|from.*scratch/i.test(lowerPrompt)
    || /create.*and.*start|build.*and.*run|make.*and.*launch/i.test(lowerPrompt);

  if (isComplexTask && depth === 0) {
    const steps = [];
    if (wantsCreate)  steps.push("Creating files and components");
    if (/install|package|npm/i.test(lowerPrompt)) steps.push("Installing dependencies");
    if (wantsStart)   steps.push("Starting dev server");
    if (wantsLink)    steps.push("Linking and auto-importing components");
    if (steps.length >= 2) {
      await showBox("plan", steps.map((s, i) => `  ${i + 1}. ${s}`));
      await sleep(300);
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt === 0) {
      await showThinkingBox(userPrompt);
      showThinkingStatus(userPrompt);
    }
    const startTime = Date.now();
    // Rotating AI-generated messages like Qwen
    const spinner = ora({
      text: attempt > 0 ? chalk.yellow(`  Retrying... (${attempt}/${MAX_RETRIES})`) : chalk.gray(getThinkingMsg()),
      spinner: { interval: 80, frames: ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"] },
      color: "blue",
    }).start();

    // Rotate message every 2.5s while waiting
    const msgRotator = setInterval(() => {
      if (!spinner.isSpinning) return clearInterval(msgRotator);
      spinner.text = chalk.gray(getThinkingMsg());
    }, 2500);

    try {
      const history = getConversationHistory();
      const recentHistory = history.slice(-8);
      let conversationContext = "";
      if (recentHistory.length > 1) {
        conversationContext = "\n\n## RECENT CONVERSATION:\n";
        for (const msg of recentHistory.slice(0, -1)) {
          conversationContext += `${msg.role.toUpperCase()}: ${msg.content}\n`;
        }
      }

      const systemPrompt = buildSystemPrompt(projectCtx);
      const response = await axios.post(
        "http://localhost:11434/api/generate",
        {
          model: "gpt-oss:120b-cloud",
          prompt: `${systemPrompt}${conversationContext}${imageInstruction}${autoInstruction}${shortInputInstruction}${dynamicPageContext}${atFileContext}${taskInstruction}\n\nUSER: "${userPrompt}"\n\nJSON:`,
          stream: true,
          options: { temperature: 0.1, num_predict: 4000 },
        },
        { responseType: "stream" }
      );

      let fullContent = "";
      let tokenCount = 0;
      await new Promise((resolve, reject) => {
        response.data.on("data", chunk => {
          for (const line of chunk.toString().split("\n").filter(Boolean)) {
            try {
              const p = JSON.parse(line);
              if (p.response) {
                fullContent += p.response;
                tokenCount++;
                // Live streaming dot pulse every 50 tokens
                if (tokenCount % 50 === 0) {
                  spinner.text = chalk.gray(`  ◌  generating${".".repeat((tokenCount / 50) % 4)}`);
                }
              }
            } catch {}
          }
        });
        response.data.on("end", resolve);
        response.data.on("error", reject);
      });

      clearInterval(msgRotator);
      spinner.stop();
      let content = fullContent.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
      const jStart = content.indexOf("{");
      const jEnd   = content.lastIndexOf("}");

      if (jStart === -1 || jEnd === -1) {
        // No JSON — if raw text looks like an answer, wrap it
        if (content.length > 5) {
          aiResponse = { action: "answer", response: content.slice(0, 500) };
          break;
        }
        if (attempt < MAX_RETRIES) { spinner.text = "  ↻ Retrying..."; continue; }
        break;
      }

      let parsed;
      try {
        parsed = JSON.parse(content.substring(jStart, jEnd + 1));
      } catch {
        // Bad JSON — try to fix common issues
        try {
          const fixed = content.substring(jStart, jEnd + 1)
            .replace(/,\s*}/g, "}").replace(/,\s*]/g, "]")
            .replace(/\n/g, "\\n").replace(/\t/g, "\\t");
          parsed = JSON.parse(fixed);
        } catch {
          if (attempt < MAX_RETRIES) { spinner.text = "  ↻ Retrying..."; continue; }
          break;
        }
      }

      if (!parsed?.action) {
        if (attempt < MAX_RETRIES) { spinner.text = "  ↻ Retrying..."; continue; }
        break;
      }

      aiResponse = parsed;
      break;

    } catch (error) {
      clearInterval(msgRotator);
      spinner.stop();
      if (error.code === "ECONNREFUSED") {
        console.log(chalk.yellow("\n  💡 Ollama not running — run: ollama serve\n"));
        return;
      }
      if (attempt < MAX_RETRIES) {
        // Silent retry — no noisy warning
        await new Promise(r => setTimeout(r, 800));
        continue;
      }
      console.log(chalk.red(`  ❌ Connection failed\n`));
    }
  }

  // AI completely failed — last resort image patcher
  if (!aiResponse) {
    if (imgIntent.isImageChange) {
      console.log(chalk.cyan("  ⚡ AI unavailable — applying image directly...\n"));
      const url = fetchedImageUrl || `https://picsum.photos/seed/product/800/600`;
      await applyImageDirectly(url, projectCtx, detectTargetSections(userPrompt));
    }
    return;
  }

  // ============================================================
  //  STEP 4: EXECUTE ACTION
  // ============================================================
  const action = aiResponse.action;

  if (action === "answer") {
    saveMemory(aiResponse.response, "assistant");
    await printCharByChar(aiResponse.response);

  } else if (action === "preview_command") {
    saveMemory(aiResponse.description || aiResponse.command, "assistant");
    const isDevCmd = /npm run dev|next dev|yarn dev|pnpm dev|bun dev/.test(aiResponse.command);

    if (isDevCmd) {
      const cwd = aiResponse.cwd ? resolvePath(aiResponse.cwd) : process.cwd();
      const url = aiResponse.devUrl || "http://localhost:3000";
      await showBox("running", [
        `Command: ${aiResponse.command}`,
        `URL: ${url}`,
        `Directory: ${cwd}`,
      ]);
      try {
        await startDevServer(aiResponse.command, cwd, url);
      } catch {
        console.log(chalk.red("\n❌ Failed to start dev server\n"));
      }
    } else {
      if (aiResponse.description) await printCharByChar(aiResponse.description);

      const bw = Math.min(process.stdout.columns || 80, 100);
      const cmd = aiResponse.command.length > bw - 15 ? aiResponse.command.slice(0, bw - 18) + "..." : aiResponse.command;
      console.log(chalk.gray("\n┌" + "─".repeat(bw) + "┐"));
      console.log(chalk.gray("│") + " " + chalk.cyan("? ") + chalk.white("Shell ") + chalk.blue(cmd.padEnd(bw - 10)) + chalk.gray("│"));
      console.log(chalk.gray("└" + "─".repeat(bw) + "┘\n"));
      console.log(chalk.blue(aiResponse.command) + "\n");

      const { proceed } = await inquirer.prompt([
        { type: "confirm", name: "proceed", message: "Execute?", default: true },
      ]);

      if (proceed) {
        console.log(chalk.cyan("\n⏳ Executing...\n"));
        try {
          execSync(aiResponse.command, { stdio: "inherit", cwd: process.cwd() });
          console.log(chalk.green("\n✅ Done!\n"));
        } catch (error) {
          const errOut = error.stderr?.toString() || error.message || "";
          console.log(chalk.red("\n❌ Failed:"), errOut.slice(0, 200));
        }
      } else {
        console.log(chalk.yellow("\n⏭️  Skipped.\n"));
      }
    }

  } else if (action === "open_browser") {
    saveMemory(`Opened: ${aiResponse.url}`, "assistant");
    console.log(chalk.cyan(`\n🌐 Opening: ${aiResponse.url}\n`));
    await open(aiResponse.url);
    console.log(chalk.green("  ✓ Opened\n"));

  } else if (action === "open_file") {
    saveMemory(`Opened file: ${aiResponse.filepath}`, "assistant");
    console.log(chalk.cyan(`\n📂 Opening: ${aiResponse.filepath}\n`));
    await open(aiResponse.filepath);
    console.log(chalk.green("  ✓ Opened\n"));

  } else if (action === "list_directory") {
    saveMemory(`Listed: ${aiResponse.path || "."}`, "assistant");
    const listPath = aiResponse.path ? resolvePath(aiResponse.path) : process.cwd();
    await showBox("reading", [`Listing: ${listPath}`]);
    try { fs.readdirSync(listPath); } catch {}

  } else if (action === "read_file") {
    const readPath = resolvePath(aiResponse.filename);
    if (fs.existsSync(readPath)) {
      const lineCount = fs.readFileSync(readPath, "utf8").split("\n").length;
      await showReadingFile(aiResponse.filename, lineCount);
    }
    try { fs.readFileSync(readPath, "utf8"); } catch {}

  } else if (action === "edit_file") {
    // Qwen-style: show reading then writing boxes
    const fp = resolvePath(aiResponse.filename);
    if (fs.existsSync(fp)) {
      const existingLines = fs.readFileSync(fp, "utf8").split("\n").length;
      // ── Auto-backup before every edit (undo support) ──────────────────
      try {
        const backupDir = path.join(process.cwd(), ".spark-backups");
        fs.mkdirSync(backupDir, { recursive: true });
        const ts = Date.now();
        const safeName = aiResponse.filename.replace(/[\/\\:]/g, "_");
        const backupPath = path.join(backupDir, `${safeName}.${ts}.bak`);
        fs.copyFileSync(fp, backupPath);
        // Keep only last 10 backups per file
        const allBaks = fs.readdirSync(backupDir)
          .filter(f => f.startsWith(safeName + ".") && f.endsWith(".bak"))
          .sort();
        if (allBaks.length > 10) {
          allBaks.slice(0, allBaks.length - 10).forEach(b => {
            try { fs.unlinkSync(path.join(backupDir, b)); } catch {}
          });
        }
      } catch {}
      await showReadingFile(aiResponse.filename, existingLines);
    }
    
    // ── QWEN EXCLUSIVE: Show diff preview before applying ──────────────────
    if (fs.existsSync(fp) && aiResponse.newContent) {
      const oldContent = fs.readFileSync(fp, "utf8");
      await showDiffPreview(aiResponse.filename, oldContent, aiResponse.newContent);
    }
    
    await showBox("writing", [`Editing: ${aiResponse.filename}`]);
    saveMemory(`Edited: ${aiResponse.filename}`, "assistant");
    // ── Fetch REAL Unsplash photos for all images in newContent ────────────
    if (aiResponse.newContent) {
      aiResponse.newContent = await replaceImagesWithReal(aiResponse.newContent);
    }
    // ── Auto-fix next.config.js remotePatterns ───────────────────────────
    try { ensureNextConfigImages(global.__projectRoot || process.cwd()); } catch {}
    try {
      const success = applyEditWithRetry(fp, aiResponse.oldContent, aiResponse.newContent);
      if (!success) {
        // ── AUTO RECOVERY: re-read file, send full content to AI, retry ────
        console.log(chalk.yellow("  ↻  Match failed — auto-recovering with fresh file read..."));
        if (fs.existsSync(fp)) {
          const freshContent = fs.readFileSync(fp, "utf8");
          const recoveryPrompt = `The edit failed because oldContent did not match.
Here is the EXACT current file content of ${aiResponse.filename}:
\`\`\`
${freshContent}
\`\`\`

Original task: ${userPrompt}

Now return a NEW edit_file action with oldContent copied CHARACTER-FOR-CHARACTER from the file above.
Return ONLY the JSON, nothing else.`;
          await generateCode(recoveryPrompt, depth + 1);
        } else {
          console.log(chalk.red("❌ File not found: " + aiResponse.filename));
        }
        if (fetchedImageUrl) {
          console.log(chalk.cyan("⚡ Trying direct image patcher...\n"));
          await applyImageDirectly(fetchedImageUrl, projectCtx);
        }
      } else {
        // Invalidate cache so next prompt sees updated content
        if (global.__projectCache) {
          const cached = global.__projectCache.keyFiles.find(
            f => f.path.replace(/\\/g, "/").endsWith(aiResponse.filename.replace(/\\/g, "/"))
          );
          if (cached && fs.existsSync(fp)) {
            cached.content = fs.readFileSync(fp, "utf8").split("\n").slice(0, 200).join("\n");
            cached.lines   = fs.readFileSync(fp, "utf8").split("\n").length;
          }
        }
        await showBox("done", [`✓ ${aiResponse.filename} updated`]);
        await triggerBrowserReload();
      }
    } catch (e) {
      console.log(chalk.red(`  ❌ Error: ${e.message}\n`));
    }

  } else if (action === "append_file") {
    console.log(chalk.red("\n❌ append_file deprecated — use edit_file\n"));

  } else if (action === "create_file") {
    saveMemory(`Created: ${aiResponse.filename}`, "assistant");

    // ── Fetch REAL Unsplash photos for all images in content ───────────────
    if (aiResponse.content) {
      aiResponse.content = await replaceImagesWithReal(aiResponse.content);
    }
    // ── Auto-fix next.config.js remotePatterns ───────────────────────────
    try { ensureNextConfigImages(global.__projectRoot || process.cwd()); } catch {}

    // Smart path resolution — supports absolute paths
    const detectedPath = extractAbsolutePath(userPrompt);
    let filename = aiResponse.filename || "";
    let fp;

    if (isAbsolutePath(filename)) {
      fp = path.normalize(expandHome(filename));
    } else if (detectedPath && !filename.includes(path.sep) && !filename.includes("/")) {
      // User said "create X in C:/folder" and AI gave just filename
      fp = path.join(path.normalize(detectedPath), filename);
    } else {
      fp = resolvePath(filename);
    }

    // Qwen-style: show writing box
    await showBox("writing", [
      `File: ${filename}`,
      `Location: ${fp}`,
    ]);

    if (fs.existsSync(fp)) {
      console.log(chalk.yellow(`  ⚠️  File already exists — updating content\n`));
    }

    const dir = path.dirname(fp);
    if (dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const clean = unescapeContent(aiResponse.content);
    fs.writeFileSync(fp, clean, "utf8");
    const lines = clean.split("\n").length;

    await showBox("done", [
      `✓ ${aiResponse.filename}`,
      `  ${lines} lines written`,
    ]);

    // ── SMART AUTO-CHAIN: link → import → start ──────────────────────────────
    const needsStart = /after start|then start|and start|and run|then run|start|run/i.test(userPrompt);
    const newFile    = aiResponse.filename;

    // Auto-link: any new .tsx component → always import into nearest page.tsx
    // Exception: if the file IS a page (contains /page.tsx or /layout.tsx), skip
    const isComponent = newFile.endsWith(".tsx")
      && !newFile.replace(/\\/g, "/").endsWith("/page.tsx")
      && !newFile.replace(/\\/g, "/").endsWith("/layout.tsx");

    if (isComponent) {
      const componentName = path.basename(newFile, ".tsx")
        .replace(/^./, c => c.toUpperCase())
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());

      // Find the main page file to patch
      // Check both cwd() directly AND inside subdirs (e.g. landing-page-app/)
      const PAGE_CANDIDATES = [
        "app/page.tsx", "src/app/page.tsx",
        "pages/index.tsx", "src/pages/index.tsx",
        "app/layout.tsx", "src/app/layout.tsx",
      ];

      // Also derive project root from the new file's path
      // e.g. newFile = "D:/CLI/.../landing-page-app/components/Foo.tsx"
      // → projectRoot = "D:/CLI/.../landing-page-app"
      const newFileAbs = path.isAbsolute(newFile)
        ? newFile
        : path.join(process.cwd(), newFile);
      const newFileRel = newFile.replace(/\\/g, "/");

      // Find deepest subdir that has package.json (= real project root)
      let projectRoot = process.cwd();
      let searchDir = path.dirname(newFileAbs);
      for (let i = 0; i < 6; i++) {
        if (fs.existsSync(path.join(searchDir, "package.json"))) {
          projectRoot = searchDir;
          break;
        }
        const parent = path.dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
      }

      let pageFile = null;
      let pageRoot = null;
      for (const candidate of PAGE_CANDIDATES) {
        if (fs.existsSync(path.join(projectRoot, candidate))) {
          pageFile = candidate;
          pageRoot = projectRoot;
          break;
        }
        // fallback: cwd
        if (fs.existsSync(path.join(process.cwd(), candidate))) {
          pageFile = candidate;
          pageRoot = process.cwd();
          break;
        }
      }

      if (pageFile && pageRoot) {
        const pageFp = path.join(pageRoot, pageFile);
        const pageLines = fs.readFileSync(pageFp, "utf8").split("\n").length;

        await showBox("linking", [
          `Importing <${componentName} /> into ${pageFile}`,
          `From: ${newFile}`,
        ]);
        await showReadingFile(pageFp, pageLines);

        // Build relative import path from page → new component
        const relImport = "./" + path.relative(
          path.dirname(pageFp),
          newFileAbs
        ).replace(/\\/g, "/").replace(/\.tsx$/, "");

        let pageContent = fs.readFileSync(pageFp, "utf8");
        const importLine = `import ${componentName} from "${relImport}";\n`;

        if (!pageContent.includes(`from "${relImport}"`)) {
          // Insert after last import
          const lastImportIdx = pageContent.lastIndexOf("\nimport ");
          const insertAt = lastImportIdx !== -1
            ? pageContent.indexOf("\n", lastImportIdx + 1) + 1
            : 0;
          pageContent = pageContent.slice(0, insertAt) + importLine + pageContent.slice(insertAt);

          // Insert component tag before </main> or last </div>
          const tagLine = `        <${componentName} />\n`;
          if (pageContent.includes("</main>")) {
            pageContent = pageContent.replace("</main>", tagLine + "      </main>");
          } else if (pageContent.includes("</div>")) {
            const lastDiv = pageContent.lastIndexOf("</div>");
            pageContent = pageContent.slice(0, lastDiv) + tagLine + "    " + pageContent.slice(lastDiv);
          }

          fs.writeFileSync(pageFp, pageContent, "utf8");
          // Invalidate cache so AI sees updated page
          if (global.__projectCache) {
            const cached = global.__projectCache.keyFiles.find(f => f.path.replace(/\\/g,"/").endsWith(pageFile));
            if (cached) cached.content = pageContent;
          }
          await showBox("done", [`✓ Linked <${componentName} /> in ${pageFile}`]);
          await triggerBrowserReload();
        } else {
          console.log(chalk.gray(`  ℹ️  Already imported in ${pageFile}\n`));
        }
      }
    }

    // Step: start dev server if requested
    if (needsStart) {
      // Dev server will start automatically via AI response - no extra message needed
      await generateCode("start the application", depth + 1);
    }


  } else if (action === "create_folder") {
    saveMemory(`Created folder: ${aiResponse.foldername}`, "assistant");

    // Detect if user wants absolute path from prompt
    const detectedPath = extractAbsolutePath(userPrompt);
    let folderName = aiResponse.foldername || "";

    // If AI gave relative name but user said absolute path → combine them
    let targetPath;
    if (isAbsolutePath(folderName)) {
      // AI already gave absolute path
      targetPath = path.normalize(expandHome(folderName));
    } else if (detectedPath) {
      // User mentioned C drive / absolute path in prompt
      targetPath = path.join(path.normalize(detectedPath), folderName);
    } else {
      // Normal relative — use cwd
      targetPath = resolvePath(folderName);
    }

    await showBox("writing", [
      `Creating folder: ${targetPath}`,
    ]);

    try {
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true });
        await showBox("done", [`✓ Folder created: ${targetPath}`]);
      } else {
        console.log(chalk.yellow(`\n  ⚠️  Already exists: ${targetPath}\n`));
      }
    } catch (err) {
      console.log(chalk.red(`\n  ❌ Failed: ${err.message}`));
      console.log(chalk.yellow(`  💡 Try running as Administrator if writing to C:\\ or system drives\n`));
    }

  } else if (action === "create_project") {
    saveMemory(`Created project: ${aiResponse.projectName}`, "assistant");
    console.log(chalk.cyan(`\n📦 Creating: ${aiResponse.projectName}\n`));
    const root = process.cwd();
    const dirs = new Set();
    for (const file of aiResponse.files) {
      const fp = path.join(root, file.path);
      const dir = path.dirname(fp);
      if (dir !== root && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        const rel = path.relative(root, dir);
        if (!dirs.has(rel)) { console.log(chalk.gray(`  📁 ${rel}/`)); dirs.add(rel); }
      }
      fs.writeFileSync(fp, unescapeContent(file.content), "utf8");
      console.log(chalk.green(`  ✓ ${file.path}`));
    }
    console.log(chalk.cyan(`\n✨ ${aiResponse.files.length} files created!\n`));

  } else if (action === "generate_code") {
    saveMemory(`Generated: ${aiResponse.filename}`, "assistant");
    const fp = path.join(process.cwd(), aiResponse.filename);
    const clean = unescapeContent(aiResponse.content);
    fs.writeFileSync(fp, clean, "utf8");
    const lines = clean.split("\n").length;
    console.log(chalk.green(`\n  ✓ ${aiResponse.filename} (${lines} lines)\n`));
    if (lowerPrompt.includes("open")) await open(fp);

  } else if (action === "framework_required") {
    saveMemory(`Framework: ${aiResponse.displayName}`, "assistant");
    await handleFramework(aiResponse);

  // ── delete_file ──────────────────────────────────────────────────────────
  } else if (action === "delete_file") {
    saveMemory(`Deleted: ${aiResponse.filename}`, "assistant");
    const delPath = resolvePath(aiResponse.filename);
    if (!fs.existsSync(delPath)) {
      console.log(chalk.yellow(`\n  ⚠️  File not found: ${delPath}\n`));
    } else {
      fs.unlinkSync(delPath);
      // Invalidate cache
      if (global.__projectCache) {
        global.__projectCache.keyFiles = global.__projectCache.keyFiles.filter(
          f => !f.path.replace(/\\/g,"/").endsWith(aiResponse.filename.replace(/\\/g,"/"))
        );
      }
      await showBox("done", [`✓ Deleted: ${aiResponse.filename}`]);
    }

  // ── rename_file ──────────────────────────────────────────────────────────
  } else if (action === "rename_file") {
    saveMemory(`Renamed: ${aiResponse.oldName} → ${aiResponse.newName}`, "assistant");
    const oldP = resolvePath(aiResponse.oldName);
    const newP = resolvePath(aiResponse.newName);
    if (!fs.existsSync(oldP)) {
      console.log(chalk.yellow(`\n  ⚠️  File not found: ${oldP}\n`));
    } else {
      fs.mkdirSync(path.dirname(newP), { recursive: true });
      fs.renameSync(oldP, newP);
      await showBox("done", [
        `✓ Renamed: ${aiResponse.oldName}`,
        `       → ${aiResponse.newName}`,
      ]);
    }

  // ── move_file ────────────────────────────────────────────────────────────
  } else if (action === "move_file") {
    saveMemory(`Moved: ${aiResponse.source} → ${aiResponse.destination}`, "assistant");
    const srcP  = resolvePath(aiResponse.source);
    const destP = resolvePath(aiResponse.destination);
    if (!fs.existsSync(srcP)) {
      console.log(chalk.yellow(`\n  ⚠️  Source not found: ${srcP}\n`));
    } else {
      fs.mkdirSync(path.dirname(destP), { recursive: true });
      fs.renameSync(srcP, destP);
      await showBox("done", [
        `✓ Moved: ${aiResponse.source}`,
        `     → ${aiResponse.destination}`,
      ]);
    }

  // ── run_command — with AUTO-RETRY and ERROR FIX ─────────────────────────
  } else if (action === "run_command") {
    saveMemory(`Ran: ${aiResponse.command}`, "assistant");
    const runCwd = aiResponse.cwd ? resolvePath(aiResponse.cwd) : process.cwd();

    // ── AUTO-FIX: Git commands need special handling ──────────────────────
    if (/git init|git add|git commit|git push/.test(aiResponse.command)) {
      const bw = Math.min(process.stdout.columns || 88, 88);
      console.log(
        "\n" +
        chalk.hex(COLORS.borderDark)("╭") +
        chalk.hex(COLORS.primaryStart).bold(" ▶ Git Operations ") +
        chalk.hex(COLORS.primaryEnd)("─".repeat(bw - 20)) +
        chalk.hex(COLORS.borderDark)("╮") +
        "\n" +
        chalk.hex(COLORS.borderDark)("│") +
        "   " +
        chalk.hex(COLORS.textDim)("Auto-configuring Git...") +
        chalk.hex(COLORS.borderDark)(" ".repeat(bw - 30)) +
        chalk.hex(COLORS.borderDark)("│") +
        "\n" +
        chalk.hex(COLORS.borderDark)("╰") +
        chalk.hex(COLORS.primaryEnd)("─".repeat(bw)) +
        chalk.hex(COLORS.borderDark)("╯") +
        "\n"
      );

      // Step 1: Auto-configure git user if not set
      try {
        const currentName = execSync("git config user.name", { cwd: runCwd, encoding: "utf8", stdio: "pipe" }).trim();
        const currentEmail = execSync("git config user.email", { cwd: runCwd, encoding: "utf8", stdio: "pipe" }).trim();

        if (!currentName || !currentEmail) {
          throw new Error("Git user not configured");
        }

        console.log(chalk.green(`  ✓ Git user configured: ${currentName} <${currentEmail}>\n`));
      } catch (e) {
        // Auto-configure with defaults
        const defaultName = process.env.USERNAME || process.env.USER || "Spark User";
        const defaultEmail = "spark@local.dev";

        try {
          execSync(`git config user.name "${defaultName}"`, { cwd: runCwd, stdio: "pipe" });
          execSync(`git config user.email "${defaultEmail}"`, { cwd: runCwd, stdio: "pipe" });
          console.log(chalk.green(`  ✓ Auto-configured Git user: ${defaultName} <${defaultEmail}>\n`));
        } catch (configErr) {
          console.log(chalk.yellow(`  ⚠ Could not auto-configure Git user\n`));
        }
      }

      // Step 2: Check if remote exists
      const wantsPush = aiResponse.command.includes("git push");
      if (wantsPush) {
        try {
          const remoteUrl = execSync("git remote get-url origin", { cwd: runCwd, encoding: "utf8", stdio: "pipe" }).trim();
          console.log(chalk.green(`  ✓ Remote configured: ${remoteUrl.slice(0, 60)}...\n`));
        } catch (e) {
          console.log(chalk.yellow("  ⚠ No remote repository configured\n"));
          console.log(chalk.gray("  💡 Create a repo on github.com, then:\n"));
          console.log(chalk.gray("     git remote add origin <repo-url>\n"));
          return; // Skip push if no remote
        }
      }
    }

    // Show professional running box with animated timer
    const bw = Math.min(process.stdout.columns || 88, 88);
    console.log(
      "\n" +
      chalk.hex(COLORS.borderDark)("╭") +
      chalk.hex(COLORS.primaryStart).bold(" ▶ Running Command ") +
      chalk.hex(COLORS.primaryEnd)("─".repeat(bw - 22)) +
      chalk.hex(COLORS.borderDark)("╮") +
      "\n" +
      chalk.hex(COLORS.borderDark)("│") +
      "   " +
      chalk.hex(COLORS.textDim)("Command: ") +
      chalk.hex(COLORS.textBright)(aiResponse.command.slice(0, bw - 20)) +
      chalk.hex(COLORS.borderDark)(" ".repeat(Math.max(0, bw - aiResponse.command.length - 18))) +
      chalk.hex(COLORS.borderDark)("│") +
      "\n" +
      chalk.hex(COLORS.borderDark)("│") +
      "   " +
      chalk.hex(COLORS.textDim)("Directory: ") +
      chalk.hex(COLORS.textBright)(runCwd.slice(-40)) +
      chalk.hex(COLORS.borderDark)(" ".repeat(Math.max(0, bw - runCwd.length - 20))) +
      chalk.hex(COLORS.borderDark)("│") +
      "\n" +
      chalk.hex(COLORS.borderDark)("╰") +
      chalk.hex(COLORS.primaryEnd)("─".repeat(bw)) +
      chalk.hex(COLORS.borderDark)("╯") +
      "\n"
    );
    
    // Show animated timer while command runs
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const startTime = Date.now();
    let frameIndex = 0;
    
    const timerInterval = setInterval(() => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const spinner = chalk.hex("#7C9EFF")(spinnerFrames[frameIndex % spinnerFrames.length]);
      const dots = ".".repeat((frameIndex % 4));
      process.stdout.write("\r  " + spinner + chalk.hex("#9CA3AF")(`  Running command${dots} ${elapsed}s`));
      frameIndex++;
    }, 200);
    
    // Auto-retry logic for failed commands with better timeout handling
    const MAX_RETRIES = 3;
    let lastError = null;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const out = execSync(aiResponse.command, { 
          cwd: runCwd,
          encoding: "utf8",
          timeout: 120000,  // 2 minute timeout (increased)
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 10 * 1024 * 1024,  // 10MB buffer
          windowsHide: true,  // Hide Windows console window
          env: { ...process.env, CI: 'true' }  // CI mode for cleaner output
        });

        clearInterval(timerInterval);
        process.stdout.write("\r" + " ".repeat(60) + "\r");
        
        if (out.trim()) {
          console.log(chalk.hex("#9CA3AF")(out.trim().slice(0, 300)));
        }
        
        await showBox("done", [`✓ Command completed`]);
        break;  // Success
        
      } catch (e) {
        clearInterval(timerInterval);
        process.stdout.write("\r" + " ".repeat(60) + "\r");
        
        lastError = e;
        const errorMsg = e.message || e.stderr || "";
        
        console.log(chalk.hex("#F97316")(`\n  ⚠ Attempt ${attempt}/${MAX_RETRIES} timed out\n`));
        
        if (attempt < MAX_RETRIES) {
          console.log(chalk.hex("#7C9EFF").bold(`  ↻ Retrying with increased timeout... (${attempt}/${MAX_RETRIES})\n`));
          await sleep(3000 * attempt);  // Longer wait between retries
          
          // Auto-fix strategies
          if (attempt === 2 && (errorMsg.includes("npm") || errorMsg.includes("install"))) {
            console.log(chalk.hex("#7C9EFF")("  ⚡ Clearing npm cache and retrying...\n"));
            try {
              execSync("npm cache clean --force", { 
                cwd: runCwd, 
                timeout: 30000, 
                stdio: 'pipe',
                windowsHide: true
              });
            } catch {}
          }
        }
      }
    }
    
    // If all retries failed, ask AI to auto-fix
    if (lastError) {
      console.log(chalk.hex("#F97316").bold("\n  ❌ Command failed after all retries\n"));
      console.log(chalk.hex("#7C9EFF")("  🤖 Auto-analyzing and fixing...\n"));
      
      await generateCode(
        `Command failed: ${aiResponse.command}
Error: ${lastError.message}

This is a Windows timeout issue. Try these solutions:
1. Use "npm install --no-optional --no-audit --progress=false"
2. Split into smaller commands
3. Use yarn instead: "yarn install"
4. Install packages one by one

Provide a working solution that avoids timeout.`,
        depth + 1
      );
    }

  // ── search_in_files ──────────────────────────────────────────────────────
  } else if (action === "search_in_files") {
    const query   = aiResponse.query || "";
    const fileExt = aiResponse.ext || ".tsx,.jsx,.ts,.js,.css";
    const exts    = new Set(fileExt.split(",").map(e => e.trim()));
    const results = [];
    const SKIP    = new Set(["node_modules",".git",".next","dist","build"]);

    function searchWalk(dir, depth = 0) {
      if (depth > 6) return;
      try {
        for (const item of fs.readdirSync(dir)) {
          if (SKIP.has(item)) continue;
          const full = path.join(dir, item);
          const stat = fs.statSync(full);
          if (stat.isDirectory()) { searchWalk(full, depth+1); continue; }
          if (!exts.has(path.extname(item))) continue;
          const src = fs.readFileSync(full, "utf8");
          const lines = src.split("\n");
          lines.forEach((line, i) => {
            if (line.toLowerCase().includes(query.toLowerCase())) {
              results.push({ file: path.relative(process.cwd(), full).replace(/\\/g,"/"), line: i+1, text: line.trim().slice(0, 100) });
            }
          });
        }
      } catch {}
    }
    searchWalk(process.cwd());
    saveMemory(`Search "${query}": ${results.length} results`, "assistant");

    if (results.length === 0) {
      await showBox("done", [`No results for: "${query}"`]);
    } else {
      const bw = Math.min(process.stdout.columns || 88, 88);
      process.stdout.write("\n" + BORDER("┌─ ") + chalk.blue("⌕ Search Results ") + BORDER("─".repeat(Math.max(0, bw - 17)) + "┐") + "\n");
      for (const r of results.slice(0, 20)) {
        const l1 = `  ${r.file}:${r.line}`;
        process.stdout.write(BORDER("│ ") + chalk.white(l1.slice(0, bw-4)) + " ".repeat(Math.max(0, bw - Math.min(l1.length, bw-4) - 2)) + BORDER(" │") + "\n");
        const l2 = `    ${r.text}`;
        process.stdout.write(BORDER("│ ") + chalk.gray(l2.slice(0, bw-4)) + " ".repeat(Math.max(0, bw - Math.min(l2.length, bw-4) - 2)) + BORDER(" │") + "\n");
      }
      if (results.length > 20) {
        const more = `  ... and ${results.length - 20} more`;
        process.stdout.write(BORDER("│ ") + chalk.gray(more) + " ".repeat(Math.max(0, bw - more.length - 2)) + BORDER(" │") + "\n");
      }
      process.stdout.write(BORDER("└" + "─".repeat(bw) + "┘") + "\n\n");
    }

  // ── bulk_edit ────────────────────────────────────────────────────────────
  } else if (action === "bulk_edit") {
    // Edit multiple files in one shot: { action: "bulk_edit", edits: [{filename, oldContent, newContent}] }
    const edits = aiResponse.edits || [];
    saveMemory(`Bulk edit: ${edits.length} files`, "assistant");
    let successCount = 0;
    for (const edit of edits) {
      const fp = resolvePath(edit.filename);
      if (!fs.existsSync(fp)) { console.log(chalk.yellow(`  ⚠️  Not found: ${edit.filename}`)); continue; }
      const result = applyEditWithRetry(fp, edit.oldContent, edit.newContent);
      if (result) {
        successCount++;
        if (global.__projectCache) {
          const cached = global.__projectCache.keyFiles.find(f => f.path.replace(/\\/g,"/") === edit.filename.replace(/\\/g,"/"));
          if (cached) cached.content = fs.readFileSync(fp, "utf8").split("\n").slice(0, 200).join("\n");
        }
      } else {
        console.log(chalk.yellow(`  ⚠️  Edit failed (no match): ${edit.filename}`));
      }
    }
    await showBox("done", [`✓ ${successCount}/${edits.length} files updated`]);
    if (successCount > 0) await triggerBrowserReload();

  // ── copy_file ────────────────────────────────────────────────────────────
  } else if (action === "copy_file") {
    saveMemory(`Copied: ${aiResponse.source} → ${aiResponse.destination}`, "assistant");
    const srcP  = resolvePath(aiResponse.source);
    const destP = resolvePath(aiResponse.destination);
    if (!fs.existsSync(srcP)) {
      console.log(chalk.yellow(`\n  ⚠️  Source not found: ${srcP}\n`));
    } else {
      fs.mkdirSync(path.dirname(destP), { recursive: true });
      fs.copyFileSync(srcP, destP);
      await showBox("done", [
        `✓ Copied: ${aiResponse.source}`,
        `      → ${aiResponse.destination}`,
      ]);
    }

  // ── add_env_var ──────────────────────────────────────────────────────────
  } else if (action === "add_env_var") {
    // { action: "add_env_var", vars: [{key: "NEXT_PUBLIC_API_URL", value: "https://...", comment: "API base URL"}] }
    const envFile  = path.join(process.cwd(), aiResponse.envFile || ".env.local");
    const exFile   = path.join(process.cwd(), ".env.example");
    const vars     = aiResponse.vars || [];
    let   envText  = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    let   exText   = fs.existsSync(exFile)  ? fs.readFileSync(exFile,  "utf8") : "";
    const added    = [];

    for (const v of vars) {
      const line = `${v.key}=${v.value || ""}`;
      const exLine = `${v.key}=`;
      if (!envText.includes(v.key + "=")) {
        if (v.comment) envText += `\n# ${v.comment}`;
        envText += `\n${line}`;
        added.push(v.key);
      }
      if (!exText.includes(v.key + "=")) {
        if (v.comment) exText += `\n# ${v.comment}`;
        exText += `\n${exLine}`;
      }
    }
    fs.writeFileSync(envFile, envText.trimStart(), "utf8");
    fs.writeFileSync(exFile,  exText.trimStart(),  "utf8");
    await showBox("done", [
      `✓ Added ${added.length} env var(s) to .env.local`,
      added.length ? `  Keys: ${added.join(", ")}` : `  (all already existed)`,
    ]);

  // ── scaffold_component ───────────────────────────────────────────────────
  } else if (action === "scaffold_component") {
    // Creates component file + optional test file + adds to index barrel
    const compName = aiResponse.name;
    const compDir  = path.join(process.cwd(), aiResponse.dir || "components");
    const compFile = path.join(compDir, `${compName}.tsx`);
    const indexFile = path.join(compDir, "index.ts");

    fs.mkdirSync(compDir, { recursive: true });

    // Write component
    const compContent = aiResponse.content || `"use client";

import React from "react";

interface ${compName}Props {
  className?: string;
}

export default function ${compName}({ className }: ${compName}Props) {
  return (
    <div className={className}>
      <p>${compName} component</p>
    </div>
  );
}
`;
    fs.writeFileSync(compFile, compContent, "utf8");

    // Add to barrel index
    const exportLine = `export { default as ${compName} } from "./${compName}";\n`;
    if (fs.existsSync(indexFile)) {
      const idx = fs.readFileSync(indexFile, "utf8");
      if (!idx.includes(compName)) fs.appendFileSync(indexFile, exportLine);
    } else {
      fs.writeFileSync(indexFile, exportLine);
    }

    await showBox("done", [
      `✓ Scaffolded: ${aiResponse.dir || "components"}/${compName}.tsx`,
      `✓ Exported in: ${aiResponse.dir || "components"}/index.ts`,
    ]);

  } else {
    console.log(chalk.red("❌ Unknown action:"), action, "\n");
  }
}