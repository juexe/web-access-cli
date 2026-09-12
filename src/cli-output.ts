import type {
	ConfigEditSuccessEnvelope,
	DiagnosticSuccessEnvelope,
	ExtractSuccessEnvelope,
	OutputEnvelope,
	SearchSuccessEnvelope,
} from "./core/types.ts";

export type CliOutputMode = "json" | "markdown" | "path";

function yamlScalar(value: string): string {
	return JSON.stringify(value);
}

export function formatExtractMarkdown(
	envelope: ExtractSuccessEnvelope,
): string {
	const { document } = envelope.data;
	const lines = [
		"---",
		`provider: ${yamlScalar(envelope.provider)}`,
		`url: ${yamlScalar(document.sourceUrl)}`,
	];
	const title = document.title.trim();
	if (title) lines.push(`title: ${yamlScalar(title)}`);
	lines.push("---", "", "");
	const content = document.content;
	return `${lines.join("\n")}${content.endsWith("\n") ? content : `${content}\n`}`;
}

export function formatMarkdown(envelope: OutputEnvelope): string {
	if ("provider" in envelope && "document" in envelope.data)
		return formatExtractMarkdown(envelope as ExtractSuccessEnvelope);
	if ("provider" in envelope && "results" in envelope.data) {
		const e = envelope as SearchSuccessEnvelope;
		const body = e.data.results
			.map(
				(result, index) =>
					`${index + 1}. [${result.title}](${result.url})${result.snippet ? `\n   ${result.snippet}` : ""}`,
			)
			.join("\n");
		return `---\nprovider: ${JSON.stringify(e.provider)}\n---\n\n${body || "无搜索结果"}\n`;
	}
	if ("command" in envelope && envelope.ok) {
		const e = envelope as DiagnosticSuccessEnvelope | ConfigEditSuccessEnvelope;
		return `# ${e.command}\n\n${JSON.stringify(e.data, null, 2)}\n`;
	}
	return "";
}
