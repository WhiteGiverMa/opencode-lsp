import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [entry, log] = process.argv.slice(2);
const child = spawn(process.execPath, [entry, "mcp"], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
function record(stream, direction) {
  let buffer = "";
  stream.on("data", chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) appendFileSync(log, JSON.stringify({ direction, wire: JSON.parse(line) }) + "\n");
    }
  });
}
record(process.stdin, "host-to-mcp");
record(child.stdout, "mcp-to-host");
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", code => process.exit(code ?? 1));
