import type {
	Capability,
	ProviderAdapter,
	ProviderType,
} from "../core/types.ts";
import { ANYSEARCH_ADAPTER } from "./anysearch.ts";
import { DEEPSEEK_ADAPTER } from "./deepseek.ts";
import { EXTRACT_ADAPTERS } from "./extract.ts";
import { EXA_ADAPTER, SEARCH_ADAPTERS } from "./search.ts";
import { XCRAWL_ADAPTER } from "./xcrawl.ts";

const adapters = [...SEARCH_ADAPTERS, ...EXTRACT_ADAPTERS].reduce<
	Map<ProviderType, ProviderAdapter>
>(
	(map, adapter) => {
		const existing = map.get(adapter.type);
		if (!existing) map.set(adapter.type, adapter);
		else
			map.set(adapter.type, {
				...existing,
				capabilities: [
					...new Set([...existing.capabilities, ...adapter.capabilities]),
				],
				search: existing.search ?? adapter.search,
				extract: existing.extract ?? adapter.extract,
			});
		return map;
	},
	new Map([
		[EXA_ADAPTER.type, EXA_ADAPTER],
		[ANYSEARCH_ADAPTER.type, ANYSEARCH_ADAPTER],
		[XCRAWL_ADAPTER.type, XCRAWL_ADAPTER],
		[DEEPSEEK_ADAPTER.type, DEEPSEEK_ADAPTER],
	]),
);

export function getAdapter(
	type: ProviderType,
	capability: Capability,
): ProviderAdapter | undefined {
	const adapter = adapters.get(type);
	return adapter?.capabilities.includes(capability) ? adapter : undefined;
}

export function getAdapters(): ProviderAdapter[] {
	return [...adapters.values()];
}
