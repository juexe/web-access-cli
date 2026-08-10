import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const schemaModule = await import(
	pathToFileURL(`${process.cwd()}/dist/core/schema.js`).href
);
await mkdir("schemas", { recursive: true });
for (const [name, schema] of Object.entries(schemaModule.SchemaDocuments)) {
	await writeFile(
		`schemas/${name}.schema.json`,
		`${JSON.stringify(schema, null, 2)}\n`,
		"utf8",
	);
}
