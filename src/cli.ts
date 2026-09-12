#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	Command,
	CommanderError,
	InvalidArgumentError,
	Option,
} from "commander";
import { type CliOutputMode, formatMarkdown } from "./cli-output.ts";
import { loadConfig } from "./config/config.ts";
import { executeConfigEdit } from "./config/edit.ts";
import { executeConfigInit } from "./config/init.ts";
import { createProviderOrderWriter } from "./config/provider-order.ts";
import { executeDoctor, executeProviders } from "./core/diagnostics.ts";
import { asWebAccessError, WebAccessError } from "./core/errors.ts";
import { errorEnvelope, executeExtract, executeSearch } from "./core/router.ts";
import type {
	Command as EnvelopeCommand,
	ExtractRequest,
	OutputEnvelope,
	SearchFreshness,
	SearchRequest,
} from "./core/types.ts";
import { COMMANDS } from "./core/types.ts";
import { normalizeDomains } from "./providers/common.ts";
import { VERSION } from "./version.ts";

interface GlobalOptions {
	config?: string;
	json?: boolean;
}

interface CliDependencies {
	executeConfigEdit?: typeof executeConfigEdit;
	executeConfigInit?: typeof executeConfigInit;
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

function integer(value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1)
		throw new InvalidArgumentError("必须是大于 0 的整数");
	return parsed;
}

function httpUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new WebAccessError("invalid_input", "url 必须是合法的绝对 URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new WebAccessError("invalid_input", "url 必须使用 http 或 https");
	return url.toString();
}

function exitCode(envelope: OutputEnvelope): number {
	if (envelope.ok) return 0;
	if (envelope.error.code === "aborted") return 130;
	if (
		[
			"invalid_input",
			"config_error",
			"provider_unknown",
			"provider_disabled",
		].includes(envelope.error.code)
	)
		return 2;
	return 1;
}

function writeEnvelope(envelope: OutputEnvelope): void {
	process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function writeOutput(envelope: OutputEnvelope, mode: CliOutputMode): void {
	if (
		mode === "path" &&
		envelope.ok &&
		"command" in envelope &&
		envelope.command === "config.init"
	) {
		process.stdout.write(`${envelope.data.path}\n`);
		return;
	}
	if (mode === "markdown" && envelope.ok) {
		process.stdout.write(formatMarkdown(envelope));
		return;
	}
	writeEnvelope(envelope);
}

export function createProgram(
	run: (
		task: () => Promise<OutputEnvelope> | OutputEnvelope,
		mode?: CliOutputMode,
	) => void,
	dependencies: CliDependencies = {},
): Command {
	const program = new Command();
	const runConfigEdit = dependencies.executeConfigEdit ?? executeConfigEdit;
	const runConfigInit = dependencies.executeConfigInit ?? executeConfigInit;
	program
		.name("web-access")
		.description("Agent-neutral 的网页搜索与内容提取 CLI")
		.version(VERSION)
		.option("--config <path>", "指定 JSON 配置文件")
		.option("--json", "输出 JSON envelope", false)
		.showSuggestionAfterError();
	program.configureOutput({ writeErr: () => {}, outputError: () => {} });
	program.exitOverride();

	program
		.command("search")
		.description("搜索网页")
		.argument("<query>", "搜索关键词")
		.option("-p, --provider <id>", "provider instance id，或 auto", "auto")
		.option("-l, --limit <number>", "结果数量（1-20）", integer)
		.addOption(
			new Option("--freshness <window>", "时间范围").choices([
				"day",
				"month",
				"year",
			]),
		)
		.option("--include-domain <domain>", "仅包含域名，可重复", collect, [])
		.option("--exclude-domain <domain>", "排除域名，可重复", collect, [])
		.option("--timeout <milliseconds>", "总超时毫秒数", integer)
		.option("--json", "输出 JSON envelope", false)
		.action(
			(
				query: string,
				options: {
					provider: string;
					limit?: number;
					freshness?: SearchFreshness;
					includeDomain: string[];
					excludeDomain: string[];
					timeout?: number;
					json: boolean;
				},
			) => {
				run(
					async () => {
						const globals = program.opts<GlobalOptions>();
						const loaded = loadConfig(globals.config);
						const request: SearchRequest = {
							query: query.trim(),
							provider: options.provider.toLowerCase(),
							limit: options.limit ?? loaded.app.search.limit,
							freshness: options.freshness,
							includeDomains: normalizeDomains(options.includeDomain),
							excludeDomains: normalizeDomains(options.excludeDomain),
							timeoutMs: options.timeout,
						};
						if (!request.query)
							throw new WebAccessError("invalid_input", "query 不能为空");
						if (request.limit > 20)
							throw new WebAccessError("invalid_input", "limit 不能超过 20");
						return executeSearch(request, {
							loaded,
							signal: processSignal.signal,
							persistProviderOrder: createProviderOrderWriter(loaded),
						});
					},
					options.json || program.opts<GlobalOptions>().json
						? "json"
						: "markdown",
				);
			},
		);

	program
		.command("extract")
		.description("提取网页正文并转换为 Markdown（使用 --json 输出 JSON）")
		.argument("<url>", "HTTP(S) URL")
		.option("-p, --provider <id>", "provider instance id，或 auto", "auto")
		.option("--timeout <milliseconds>", "总超时毫秒数", integer)
		.option("--json", "输出 JSON envelope", false)
		.action(
			(
				url: string,
				options: {
					provider: string;
					timeout?: number;
					json: boolean;
				},
			) => {
				const globals = program.opts<GlobalOptions>();
				const outputMode: CliOutputMode =
					options.json || globals.json ? "json" : "markdown";
				run(async () => {
					const loaded = loadConfig(globals.config);
					const request: ExtractRequest = {
						url: httpUrl(url),
						provider: options.provider.toLowerCase(),
						timeoutMs: options.timeout,
					};
					return executeExtract(request, {
						loaded,
						signal: processSignal.signal,
						persistProviderOrder: createProviderOrderWriter(loaded),
					});
				}, outputMode);
			},
		);

	program
		.command("providers")
		.description("列出 provider instance、route 与配置状态")
		.option("--json", "输出 JSON envelope", false)
		.action((options: { json: boolean }) =>
			run(
				() =>
					executeProviders(loadConfig(program.opts<GlobalOptions>().config)),
				options.json || program.opts<GlobalOptions>().json
					? "json"
					: "markdown",
			),
		);

	program
		.command("doctor")
		.description("检查本地配置与已启用 provider 的可用性")
		.option("--json", "输出 JSON envelope", false)
		.action((options: { json: boolean }) =>
			run(
				() => executeDoctor(loadConfig(program.opts<GlobalOptions>().config)),
				options.json || program.opts<GlobalOptions>().json
					? "json"
					: "markdown",
			),
		);

	const config = program.command("config").description("管理配置文件");
	config
		.command("init")
		.description("按当前标准凭据环境变量创建配置")
		.option("--json", "输出 JSON envelope", false)
		.action((options: { json: boolean }) => {
			const globals = program.optsWithGlobals<GlobalOptions>();
			run(
				() => runConfigInit({ explicitPath: globals.config }),
				options.json || globals.json ? "json" : "path",
			);
		});
	config
		.command("edit")
		.description("创建默认配置文件并用 VISUAL 或 EDITOR 打开")
		.option("--json", "输出 JSON envelope", false)
		.action((options: { json: boolean }) =>
			run(
				() =>
					runConfigEdit({
						explicitPath: program.opts<GlobalOptions>().config,
					}),
				options.json || program.opts<GlobalOptions>().json
					? "json"
					: "markdown",
			),
		);

	return program;
}

function envelopeCommand(args: string[]): EnvelopeCommand | null {
	const nested = args.slice(0, 2).join(".");
	if (COMMANDS.includes(nested as EnvelopeCommand))
		return nested as EnvelopeCommand;
	const command = args[0];
	return COMMANDS.includes(command as EnvelopeCommand)
		? (command as EnvelopeCommand)
		: null;
}

const processSignal = new AbortController();
process.once("SIGINT", () => processSignal.abort());

async function main(): Promise<void> {
	let pending: Promise<OutputEnvelope> | undefined;
	let pendingOutputMode: CliOutputMode = "json";
	const program = createProgram((task, mode = "json") => {
		pendingOutputMode = mode;
		pending = Promise.resolve().then(task);
	});
	if (process.argv.length <= 2) {
		const envelope = errorEnvelope(
			new WebAccessError("invalid_input", "必须指定命令"),
		);
		writeEnvelope(envelope);
		process.exitCode = 2;
		return;
	}
	try {
		await program.parseAsync(process.argv);
		if (!pending) throw new WebAccessError("invalid_input", "必须指定命令");
		const envelope = await pending;
		writeOutput(envelope, pendingOutputMode);
		process.exitCode = exitCode(envelope);
	} catch (caught) {
		if (
			caught instanceof CommanderError &&
			caught.code === "commander.helpDisplayed"
		)
			return;
		if (caught instanceof CommanderError && caught.code === "commander.version")
			return;
		const normalized =
			caught instanceof CommanderError
				? new WebAccessError(
						"invalid_input",
						caught.code === "commander.help" && program.args[0] === "config"
							? "必须指定 config 子命令"
							: caught.message,
					)
				: asWebAccessError(caught);
		const envelope = errorEnvelope(normalized, envelopeCommand(program.args));
		writeEnvelope(envelope);
		process.exitCode = exitCode(envelope);
	}
}

export function isMainModule(
	moduleUrl: string,
	entryPath: string | undefined,
): boolean {
	if (!entryPath) return false;
	try {
		return moduleUrl === pathToFileURL(realpathSync(entryPath)).href;
	} catch {
		return false;
	}
}

if (isMainModule(import.meta.url, process.argv[1])) {
	await main();
}
