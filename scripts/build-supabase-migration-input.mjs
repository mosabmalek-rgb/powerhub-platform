import { readFile, writeFile } from "node:fs/promises";

const sqlPath = process.argv[2];
const outputPath = process.argv[3];
const projectId = process.argv[4];
const name = process.argv[5];

if (!sqlPath || !outputPath || !projectId || !name) throw new Error("Missing migration input arguments");
const query = await readFile(sqlPath, "utf8");
await writeFile(outputPath, JSON.stringify({ project_id: projectId, name, query }));
