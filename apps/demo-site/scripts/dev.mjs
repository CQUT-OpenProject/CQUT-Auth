import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

const children = [];
let shuttingDown = false;

function spawnProcess(name, command, args) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env
  });

  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      shuttingDown = true;
      for (const current of children) {
        if (current !== child && !current.killed) {
          current.kill("SIGTERM");
        }
      }
    }

    if (signal) {
      console.log(`[${name}] exited via ${signal}`);
      return;
    }

    if (typeof code === "number" && code !== 0) {
      process.exitCode = code;
    }
  });

  children.push(child);
  return child;
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

spawnProcess("client", process.execPath, [resolve(projectRoot, "scripts/watch-client.mjs")]);
spawnProcess("server", "pnpm", ["exec", "tsx", "watch", "src/main.ts"]);
