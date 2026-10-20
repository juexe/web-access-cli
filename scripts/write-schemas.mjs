import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const coreSchemaModule = await import(
	pathToFileURL(`${process.cwd()}/dist/core/schema.js`).href
);
const gatewaySchemaModule = await import(
	pathToFileURL(`${process.cwd()}/dist/gateway/schema.js`).href
);
const documents = {
	...coreSchemaModule.SchemaDocuments,
	...gatewaySchemaModule.GatewaySchemaDocuments,
};
await mkdir("schemas", { recursive: true });
for (const [name, schema] of Object.entries(documents)) {
	await writeFile(
		`schemas/${name}.schema.json`,
		`${JSON.stringify(schema, null, 2)}\n`,
		"utf8",
	);
}
