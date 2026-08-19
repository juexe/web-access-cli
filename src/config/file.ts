import type { Stats } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	open as openFile,
	stat,
	unlink,
} from "node:fs/promises";
import { dirname } from "node:path";
import { VERSION } from "../version.ts";
import { ConfigError, createDefaultAppConfig } from "./config.ts";

export const CONFIG_SCHEMA_URL = `https://unpkg.com/web-access-cli@${VERSION}/schemas/config.schema.json`;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

function configFileError(
	message: string,
	path: string,
	error?: unknown,
): ConfigError {
	return new ConfigError(message, {
		path,
		...(error === undefined ? {} : { cause: errorMessage(error) }),
	});
}

async function existingConfigFile(path: string): Promise<boolean> {
	let fileInfo: Stats;
	try {
		fileInfo = await lstat(path);
	} catch (error) {
		if (hasCode(error, "ENOENT")) return false;
		throw configFileError(`无法检查配置文件: ${path}`, path, error);
	}

	if (fileInfo.isSymbolicLink()) {
		try {
			fileInfo = await stat(path);
		} catch (error) {
			throw configFileError(`配置文件符号链接不可用: ${path}`, path, error);
		}
	}

	if (!fileInfo.isFile())
		throw configFileError(`配置路径不是普通文件: ${path}`, path);
	return true;
}

async function removeIncompleteFile(
	path: string,
	created: Stats,
): Promise<void> {
	try {
		const current = await lstat(path);
		if (current.dev === created.dev && current.ino === created.ino)
			await unlink(path);
	} catch {
		// 清理失败不覆盖原始写入错误，也绝不删除其他路径。
	}
}

export function serializeDefaultConfig(): string {
	return `${JSON.stringify(
		{
			$schema: CONFIG_SCHEMA_URL,
			...createDefaultAppConfig(),
		},
		null,
		2,
	)}\n`;
}

export async function ensureConfigFile(path: string): Promise<boolean> {
	if (await existingConfigFile(path)) return false;

	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	} catch (error) {
		throw configFileError(`无法创建配置目录: ${dirname(path)}`, path, error);
	}

	let handle: FileHandle;
	try {
		handle = await openFile(path, "wx", 0o600);
	} catch (error) {
		if (hasCode(error, "EEXIST")) {
			if (await existingConfigFile(path)) return false;
		}
		throw configFileError(`无法创建配置文件: ${path}`, path, error);
	}

	const created = await handle.stat();
	try {
		await handle.writeFile(serializeDefaultConfig(), "utf8");
		await handle.sync();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await removeIncompleteFile(path, created);
		throw configFileError(`无法写入配置文件: ${path}`, path, error);
	}

	try {
		await handle.close();
	} catch (error) {
		throw configFileError(`无法关闭配置文件: ${path}`, path, error);
	}
	return true;
}
