import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { applyEdits, modify } from "jsonc-parser";
import writeFileAtomic from "write-file-atomic";
import { reorderProviders } from "../core/provider-order.ts";
import type {
	Capability,
	PersistProviderOrder,
	ProviderOrderUpdate,
} from "../core/types.ts";
import {
	getEffectiveRoute,
	getRoute,
	type LoadedConfig,
	loadConfigContents,
} from "./config.ts";
import { ensureConfigFile } from "./file.ts";

function sameMembers(
	left: readonly string[],
	right: readonly string[],
): boolean {
	if (left.length !== right.length) return false;
	const rightIds = new Set(right);
	return left.every((id) => rightIds.has(id));
}

async function writableTarget(path: string): Promise<string> {
	const fileInfo = await lstat(path);
	if (!fileInfo.isSymbolicLink()) {
		if (!fileInfo.isFile()) throw new Error(`配置路径不是普通文件: ${path}`);
		return path;
	}
	const target = await realpath(path);
	if (!(await stat(target)).isFile())
		throw new Error(`配置文件符号链接目标不是普通文件: ${path}`);
	return target;
}

function desiredOrder(
	latest: LoadedConfig,
	update: ProviderOrderUpdate,
): string[] {
	const configured = getRoute(latest.app, update.capability);
	if (!sameMembers(configured, update.configuredProviders)) return configured;
	return reorderProviders(
		getEffectiveRoute(latest.app, update.capability),
		update,
	);
}

function updateText(
	contents: string,
	capability: Capability,
	providers: string[],
): string {
	const edits = modify(contents, [capability, "_providers"], providers, {
		formattingOptions: {
			insertSpaces: true,
			tabSize: 2,
			eol: contents.includes("\r\n") ? "\r\n" : "\n",
		},
	});
	return applyEdits(contents, edits);
}

export async function persistProviderOrder(
	loaded: LoadedConfig,
	update: ProviderOrderUpdate,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	if (!loaded.exists) await ensureConfigFile(loaded.path);
	const target = await writableTarget(loaded.path);
	const contents = await readFile(target, "utf8");
	const latest = loadConfigContents(target, contents, env);
	const updated = updateText(
		contents,
		update.capability,
		desiredOrder(latest, update),
	);
	if (updated === contents) return;
	await writeFileAtomic(target, updated, { encoding: "utf8", fsync: true });
}

export function createProviderOrderWriter(
	loaded: LoadedConfig,
	env: NodeJS.ProcessEnv = process.env,
): PersistProviderOrder {
	return (update) => persistProviderOrder(loaded, update, env);
}
