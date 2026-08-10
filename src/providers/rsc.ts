/** 从 Next.js 内嵌的 React Server Components flight payload 中提取 Markdown。 */
export function extractRscMarkdown(html: string): string {
	if (!html.includes("self.__next_f.push")) return "";
	const chunks = new Map<string, unknown>();
	const scriptPattern = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)/g;
	for (const match of html.matchAll(scriptPattern)) {
		try {
			const decoded = JSON.parse(`"${match[1]}"`) as string;
			for (const line of decoded.split("\n")) {
				const separator = line.indexOf(":");
				if (separator < 1 || separator > 6) continue;
				const id = line.slice(0, separator);
				if (!/^[0-9a-f]+$/i.test(id)) continue;
				const payload = line.slice(separator + 1);
				if (!payload.startsWith("[") && !payload.startsWith("{")) continue;
				try {
					chunks.set(id, JSON.parse(payload));
				} catch {
					// 单个 chunk 损坏时继续处理其他 chunk。
				}
			}
		} catch {
			// 非法脚本不是整个页面的致命错误。
		}
	}

	const active = new Set<string>();
	const render = (node: unknown, inCode = false): string => {
		if (node === null || node === undefined || typeof node === "boolean")
			return "";
		if (typeof node === "number") return String(node);
		if (typeof node === "string") {
			const reference = /^\$L([0-9a-f]+)$/i.exec(node);
			if (reference) {
				const id = reference[1];
				if (active.has(id)) return "";
				active.add(id);
				const result = render(chunks.get(id), inCode);
				active.delete(id);
				return result;
			}
			if (
				!inCode &&
				(node === "$" || node === "$undefined" || /^\$[A-Z]/.test(node))
			)
				return "";
			return node;
		}
		if (!Array.isArray(node)) {
			if (typeof node === "object") {
				const object = node as Record<string, unknown>;
				return render(object.children ?? object.content ?? object.text, inCode);
			}
			return "";
		}
		if (node[0] !== "$" || typeof node[1] !== "string")
			return node.map((child) => render(child, inCode)).join("");
		const tag = node[1];
		const props =
			node[3] && typeof node[3] === "object"
				? (node[3] as Record<string, unknown>)
				: {};
		if (
			[
				"script",
				"style",
				"svg",
				"path",
				"nav",
				"footer",
				"aside",
				"button",
				"input",
			].includes(tag)
		)
			return "";
		const content = render(props.children, inCode).trim();
		if (/^h[1-6]$/.test(tag))
			return `${"#".repeat(Number(tag[1]))} ${content}\n\n`;
		if (tag === "p") return `${content}\n\n`;
		if (tag === "li") return `- ${content}\n`;
		if (tag === "blockquote") return `> ${content}\n\n`;
		if (tag === "strong" || tag === "b") return `**${content}**`;
		if (tag === "em" || tag === "i") return `*${content}*`;
		if (tag === "code") return inCode ? content : `\`${content}\``;
		if (tag === "pre")
			return `\`\`\`\n${render(props.children, true)}\n\`\`\`\n\n`;
		if (
			tag === "a" &&
			typeof props.href === "string" &&
			!props.href.startsWith("#")
		)
			return `[${content}](${props.href})`;
		return content;
	};

	const candidates = [...chunks.values()]
		.map((chunk) =>
			render(chunk)
				.replace(/\n{3,}/g, "\n\n")
				.trim(),
		)
		.filter((content) => content.length > 100);
	return candidates.sort((left, right) => right.length - left.length)[0] ?? "";
}
