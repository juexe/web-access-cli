import type { ProviderOrderUpdate } from "./types.ts";

export function reorderProviders(
	current: readonly string[],
	update: Pick<ProviderOrderUpdate, "winner" | "failed">,
): string[] {
	const currentIds = new Set(current);
	const winner =
		update.winner && currentIds.has(update.winner) ? update.winner : undefined;
	const failedIds = new Set(
		update.failed.filter((id) => id !== winner && currentIds.has(id)),
	);
	const untouched = current.filter((id) => id !== winner && !failedIds.has(id));
	const failed = current.filter((id) => failedIds.has(id));
	return [...(winner ? [winner] : []), ...untouched, ...failed];
}
