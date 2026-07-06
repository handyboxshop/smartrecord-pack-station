import { execFileSync, spawn } from "node:child_process";

const port = Number(process.env.PORT || 4173);
const pids = findListeningPids(port);

if (pids.length) {
  console.log(`[dev:reset] found listener(s) on port ${port}: ${pids.join(", ")}`);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    stopProcess(pid);
  }
} else {
  console.log(`[dev:reset] no listener found on port ${port}`);
}

console.log(`[dev:reset] starting SmartRecord server on port ${port}`);
const child = spawn(process.execPath, ["server/index.mjs"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(port)
  },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});

function findListeningPids(targetPort) {
  if (process.platform === "win32") {
    try {
      const output = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
      return [...new Set(
        output
          .split(/\r?\n/)
          .filter((line) => line.includes(`:${targetPort}`) && line.includes("LISTENING"))
          .map((line) => line.trim().split(/\s+/).pop())
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0)
      )];
    } catch {
      return [];
    }
  }

  try {
    const output = execFileSync("lsof", ["-ti", `tcp:${targetPort}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    if (!output) return [];
    return [...new Set(output.split(/\r?\n/).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))];
  } catch {
    return [];
  }
}

function stopProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < 1500) {
    if (!isAlive(pid)) {
      console.log(`[dev:reset] stopped pid ${pid}`);
      return;
    }
  }

  try {
    process.kill(pid, "SIGKILL");
    console.log(`[dev:reset] force-stopped pid ${pid}`);
  } catch {
    console.log(`[dev:reset] pid ${pid} already stopped`);
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
