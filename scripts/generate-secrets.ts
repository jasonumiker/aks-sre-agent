import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(process.env.SECRET_DIR ?? ".local/azure-secrets");
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const name of ["booth-token", "operator-token", "mcp-token", "session-secret"]) {
  await writeFile(`${directory}/${name}`, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
}
console.log(`Created four distinct secret files in ${directory}. Upload them to Key Vault; do not commit them.`);
