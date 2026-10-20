export const PANEL_PATH = "/panel";
export const RECORDS_PATH = "/admin/api/records";

export interface PanelOptions {
	nonce: string;
	retention: number;
	minKeyLength: number;
	version: string;
}

/**
 * The panel is a self-contained document served from memory. It has no build
 * assets, no third-party scripts and no secrets; the records API is protected by
 * the same Bearer key as the tool endpoints.
 */
const PANEL_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Web Access 网关 · 请求记录</title>
<style nonce="__NONCE__">
:root {
	color-scheme: light dark;
	--bg: #f4f2ec;
	--surface: #fbfaf6;
	--surface-strong: #eeece4;
	--border: #d8d4c8;
	--text: #201f1b;
	--muted: #6d675a;
	--accent: #0f766e;
	--accent-soft: #d9ece7;
	--ok: #166534;
	--ok-soft: #dcfce7;
	--warn: #92400e;
	--warn-soft: #fef3c7;
	--err: #991b1b;
	--err-soft: #fee2e2;
	--sans: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
	--mono: ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #131311;
		--surface: #1b1b18;
		--surface-strong: #252521;
		--border: #3a3a33;
		--text: #ece9df;
		--muted: #a7a093;
		--accent: #5eead4;
		--accent-soft: rgba(94, 234, 212, 0.13);
		--ok: #86efac;
		--ok-soft: rgba(134, 239, 172, 0.12);
		--warn: #fcd34d;
		--warn-soft: rgba(252, 211, 77, 0.12);
		--err: #fca5a5;
		--err-soft: rgba(252, 165, 165, 0.12);
	}
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body {
	margin: 0;
	background: var(--bg);
	color: var(--text);
	font: 14px/1.55 var(--sans);
	-webkit-font-smoothing: antialiased;
}
button, input { font: inherit; color: inherit; }
a { color: var(--accent); text-underline-offset: 2px; }
h1, h2, p { margin-top: 0; }
[hidden] { display: none !important; }
.topbar {
	display: flex;
	flex-wrap: wrap;
	gap: 14px 24px;
	align-items: center;
	justify-content: space-between;
	padding: 16px clamp(16px, 4vw, 40px);
	border-bottom: 1px solid var(--border);
	background: var(--surface);
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand-mark {
	display: grid;
	place-items: center;
	width: 38px;
	height: 38px;
	border: 1px solid var(--border);
	border-radius: 7px;
	background: var(--surface-strong);
	color: var(--accent);
	font: 600 12px var(--mono);
	letter-spacing: 0.05em;
}
h1 { margin: 0; font-size: 16px; letter-spacing: 0.01em; }
.brand p { margin: 1px 0 0; color: var(--muted); font-size: 12px; }
.topbar-actions { display: flex; align-items: center; gap: 10px; }
.status-pill {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	min-height: 30px;
	padding: 0 10px;
	border: 1px solid var(--border);
	border-radius: 999px;
	background: var(--surface-strong);
	color: var(--muted);
	font-size: 12px;
	white-space: nowrap;
}
.status-pill .dot {
	width: 7px;
	height: 7px;
	border-radius: 50%;
	background: var(--muted);
}
.status-pill[data-state="ready"] .dot { background: var(--ok); }
.status-pill[data-state="not-ready"] .dot { background: var(--warn); }
.status-pill[data-state="offline"] .dot { background: var(--err); }
main {
	max-width: 1180px;
	margin: 0 auto;
	padding: 24px clamp(16px, 4vw, 40px) 64px;
}
.btn {
	min-height: 40px;
	padding: 0 14px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--surface);
	cursor: pointer;
	white-space: nowrap;
}
.btn:hover { background: var(--surface-strong); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.btn.primary { border-color: var(--accent); background: var(--accent); color: var(--bg); font-weight: 600; }
.btn.ghost { background: transparent; }
.login { max-width: 540px; margin: 7vh auto 0; padding: clamp(20px, 4vw, 32px); border: 1px solid var(--border); border-radius: 9px; background: var(--surface); }
.login h2 { margin-bottom: 8px; font-size: 19px; }
.login > p { color: var(--muted); margin-bottom: 20px; }
.login label { display: block; margin-bottom: 6px; font-size: 12px; font-weight: 600; }
.key-row { display: flex; gap: 8px; }
.key-row input {
	flex: 1;
	min-width: 0;
	min-height: 40px;
	padding: 0 12px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--bg);
}
.key-row input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.hint { margin: 10px 0 0; color: var(--muted); font-size: 12px; }
.form-error { margin: 12px 0 0; color: var(--err); font-size: 13px; }
.stats {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	overflow: hidden;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--surface);
}
.stat { padding: 13px 16px; border-left: 1px solid var(--border); min-width: 0; }
.stat:first-child { border-left: 0; }
.stat-label { display: block; color: var(--muted); font-size: 11px; letter-spacing: 0.05em; }
.stat strong { display: block; margin-top: 3px; font: 600 20px/1.25 var(--mono); }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin: 18px 0 12px; }
.segmented { display: inline-flex; overflow: hidden; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.segmented button {
	min-height: 38px;
	padding: 0 12px;
	border: 0;
	border-left: 1px solid var(--border);
	background: transparent;
	color: var(--muted);
	font-size: 12px;
	cursor: pointer;
}
.segmented button:first-child { border-left: 0; }
.segmented button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.segmented button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
#filter-text {
	flex: 1 1 220px;
	min-width: 160px;
	min-height: 40px;
	padding: 0 12px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--surface);
}
#filter-text:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.switch { display: inline-flex; align-items: center; gap: 7px; min-height: 40px; padding: 0 4px; color: var(--muted); font-size: 12px; cursor: pointer; white-space: nowrap; }
.switch input { accent-color: var(--accent); width: 15px; height: 15px; }
.list-head { display: flex; justify-content: space-between; gap: 12px; margin: 4px 0 8px; color: var(--muted); font-size: 12px; }
.banner { margin: 0 0 12px; padding: 9px 12px; border: 1px solid var(--err); border-left-width: 3px; border-radius: 6px; background: var(--err-soft); color: var(--err); font-size: 13px; }
.records { margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); list-style: none; }
.record + .record { border-top: 1px solid var(--border); }
.record-head {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 5px 10px;
	width: 100%;
	min-height: 48px;
	padding: 9px 14px;
	border: 0;
	background: transparent;
	text-align: left;
	cursor: pointer;
}
.record-head:hover { background: var(--surface-strong); }
.record-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.record-time { flex: 0 0 auto; color: var(--muted); font: 12px var(--mono); white-space: nowrap; }
.badge {
	display: inline-flex;
	flex: 0 0 auto;
	justify-content: center;
	padding: 1px 6px;
	border: 1px solid transparent;
	border-radius: 4px;
	font: 600 11px/1.7 var(--mono);
	white-space: nowrap;
}
.route-search { background: var(--accent-soft); color: var(--accent); }
.route-fetch { border-color: var(--border); background: var(--surface-strong); color: var(--muted); }
.status-ok { background: var(--ok-soft); color: var(--ok); }
.status-warn { background: var(--warn-soft); color: var(--warn); }
.status-error { background: var(--err-soft); color: var(--err); }
.record-summary { flex: 1 1 260px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.record-provider { flex: 0 1 auto; max-width: 110px; overflow: hidden; color: var(--muted); font: 12px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.record-duration, .record-results { flex: 0 0 auto; color: var(--muted); font: 12px var(--mono); text-align: right; white-space: nowrap; }
.record-duration { min-width: 62px; }
.record-results { min-width: 48px; }
.chevron { flex: 0 0 auto; margin-left: auto; color: var(--muted); transition: transform 0.15s ease; }
.record.expanded .chevron { transform: rotate(90deg); }
.record-detail { padding: 13px 16px 16px; border-top: 1px dashed var(--border); background: var(--bg); }
.record-meta { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 5px 16px; margin: 0; }
.record-meta dt { color: var(--muted); font-size: 12px; }
.record-meta dd { margin: 0; overflow-wrap: anywhere; font: 12px/1.5 var(--mono); }
.detail-label { margin: 16px 0 6px; color: var(--muted); font-size: 11px; letter-spacing: 0.05em; }
.result-list { display: grid; gap: 7px; margin: 0; padding-left: 20px; }
.result-title { display: block; overflow-wrap: anywhere; }
.result-url { display: block; color: var(--muted); font: 11px/1.45 var(--mono); overflow-wrap: anywhere; }
.empty { margin-top: 0; padding: 42px 20px; border: 1px dashed var(--border); border-radius: 8px; background: var(--surface); color: var(--muted); text-align: center; }
.empty strong { display: block; margin-bottom: 4px; color: var(--text); font-size: 14px; }
.footnote { margin: 14px 0 0; color: var(--muted); font-size: 12px; }
@media (max-width: 680px) {
	.stats { grid-template-columns: 1fr 1fr; }
	.stat { border-top: 1px solid var(--border); }
	.stat:nth-child(-n+2) { border-top: 0; }
	.stat:nth-child(odd) { border-left: 0; }
	.stat:nth-child(even) { border-left: 1px solid var(--border); }
	.record-head { row-gap: 3px; }
	.record-summary { order: 1; flex-basis: 100%; white-space: normal; }
	.record-provider { order: 2; max-width: none; }
	.record-duration { order: 3; min-width: 0; text-align: left; }
	.record-results { order: 4; min-width: 0; text-align: left; }
	.btn, .segmented button, #filter-text, .key-row input { min-height: 44px; }
	.segmented button { padding: 0 13px; }
	.key-row { flex-wrap: wrap; }
	.key-row .btn { width: 100%; }
	.login { margin-top: 3vh; }
}
@media (prefers-reduced-motion: reduce) {
	* { transition: none !important; animation: none !important; }
}
</style>
</head>
<body>
<header class="topbar">
	<div class="brand">
		<span class="brand-mark" aria-hidden="true">WA</span>
		<div>
			<h1>Web Access 网关</h1>
			<p>请求记录 · 最近 __RETENTION__ 条 · 重启后清空</p>
		</div>
	</div>
	<div class="topbar-actions">
		<span class="status-pill" id="ready-pill" data-state="checking" role="status">
			<span class="dot" aria-hidden="true"></span>
			<span id="ready-text">检查中</span>
		</span>
		<button type="button" class="btn ghost" id="logout" hidden>退出</button>
	</div>
</header>
<main>
	<section class="login" id="login-view" hidden aria-labelledby="login-title">
		<h2 id="login-title">查看请求记录</h2>
		<p>这个面板只读取本机内存中的最近请求。请输入网关 API Key 继续。</p>
		<form id="login-form">
			<label for="key-input">网关 API Key</label>
			<div class="key-row">
				<input id="key-input" name="key" type="password" autocomplete="off" spellcheck="false" required minlength="__MIN_KEY_LENGTH__" placeholder="至少 __MIN_KEY_LENGTH__ 个字符">
				<button type="submit" class="btn primary" id="login-submit">进入面板</button>
			</div>
			<p class="hint">Key 只保存在当前标签页的 sessionStorage，不写入 URL；关闭标签页后清除。也可用 <code>#apikey=…</code> 链接打开，脚本会立即从地址栏移除它。</p>
			<p class="form-error" id="login-error" role="alert" hidden></p>
		</form>
	</section>
	<section id="panel-view" hidden aria-labelledby="panel-title">
		<h2 id="panel-title" hidden>请求记录</h2>
		<div class="stats" aria-label="概览">
			<div class="stat"><span class="stat-label">已加载请求</span><strong id="stat-total">0</strong></div>
			<div class="stat"><span class="stat-label">成功</span><strong id="stat-ok">0</strong></div>
			<div class="stat"><span class="stat-label">失败</span><strong id="stat-bad">0</strong></div>
			<div class="stat"><span class="stat-label">平均耗时</span><strong id="stat-avg">—</strong></div>
		</div>
		<div class="toolbar">
			<div class="segmented" role="group" aria-label="按请求类型筛选">
				<button type="button" data-route="all" aria-pressed="true">全部</button>
				<button type="button" data-route="search" aria-pressed="false">搜索</button>
				<button type="button" data-route="fetch" aria-pressed="false">抓取</button>
			</div>
			<div class="segmented" role="group" aria-label="按结果状态筛选">
				<button type="button" data-status="all" aria-pressed="true">全部状态</button>
				<button type="button" data-status="ok" aria-pressed="false">成功</button>
				<button type="button" data-status="error" aria-pressed="false">失败</button>
			</div>
			<input id="filter-text" type="search" placeholder="筛选 query、URL、provider、错误码" aria-label="文本筛选">
			<label class="switch"><input type="checkbox" id="auto-refresh" checked>自动刷新</label>
			<button type="button" class="btn" id="refresh">刷新</button>
		</div>
		<div class="list-head">
			<span id="record-count">已加载 0 条</span>
			<span>/v1/tools/search · /v1/tools/fetch</span>
		</div>
		<p class="banner" id="banner" role="alert" hidden></p>
		<div class="empty" id="empty" hidden>
			<strong id="empty-title">还没有请求记录</strong>
			<span id="empty-text">调用一次 /v1/tools/search 或 /v1/tools/fetch 后，这里会显示时间和结果。</span>
		</div>
		<ul class="records" id="records" aria-label="请求记录"></ul>
		<p class="footnote">记录只保存在容器内存中，不写入磁盘，也不记录响应正文；重启网关后清空。面板版本 __VERSION__。</p>
	</section>
	<noscript><p class="banner">面板需要 JavaScript 才能读取请求记录。</p></noscript>
</main>
<script nonce="__NONCE__">
(() => {
	"use strict";
	const STORAGE_KEY = "web-access-gateway-key";
	const RETENTION = __RETENTION__;
	const MIN_KEY_LENGTH = __MIN_KEY_LENGTH__;
	const REFRESH_MS = 3000;
	const byId = (id) => document.getElementById(id);
	const state = {
		key: "",
		records: [],
		route: "all",
		status: "all",
		text: "",
		loading: false,
		timer: 0,
	};

	function readStoredKey() {
		try {
			return sessionStorage.getItem(STORAGE_KEY) || "";
		} catch {
			return "";
		}
	}

	function storeKey(key) {
		try {
			sessionStorage.setItem(STORAGE_KEY, key);
		} catch {
			// Storage can be unavailable in hardened browser contexts.
		}
	}

	function clearStoredKey() {
		try {
			sessionStorage.removeItem(STORAGE_KEY);
		} catch {
			// Ignore storage failures.
		}
	}

	// Optional "#apikey=..." bootstrap for bookmarks. The fragment never reaches
	// the server or Referer, and it is stripped from the address bar and history
	// before any request is made, so a copied URL cannot leak the key later.
	function takeKeyFromHash() {
		const raw = location.hash.startsWith("#") ? location.hash.slice(1) : "";
		if (!raw) return "";
		let key = "";
		let remaining = location.hash;
		try {
			const params = new URLSearchParams(raw);
			if (params.has("apikey")) {
				key = (params.get("apikey") || "").trim();
				params.delete("apikey");
				const rest = params.toString();
				remaining = rest ? "#" + rest : "";
			}
		} catch {
			return "";
		}
		if (remaining === location.hash) return key;
		history.replaceState(null, "", location.pathname + location.search + remaining);
		return key;
	}

	function element(tag, className, content) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (content !== undefined && content !== null) node.textContent = String(content);
		return node;
	}

	function setReady(kind, label) {
		const pill = byId("ready-pill");
		if (!pill) return;
		pill.dataset.state = kind;
		const text = byId("ready-text");
		if (text.textContent !== label) text.textContent = label;
	}

	async function refreshReady() {
		try {
			const response = await fetch("/readyz", { cache: "no-store" });
			if (response.ok) setReady("ready", "网关就绪");
			else setReady("not-ready", "网关未就绪");
		} catch {
			setReady("offline", "连接失败");
		}
	}

	function formatTime(value) {
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return "—";
		return date.toLocaleString("zh-CN", {
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
	}

	function formatDuration(value) {
		if (!Number.isFinite(value)) return "—";
		if (value < 1000) return Math.round(value) + " ms";
		return (value / 1000).toFixed(1) + " s";
	}

	function statusKind(status) {
		if (status >= 200 && status < 300) return "ok";
		if (status >= 500) return "error";
		return "warn";
	}

	function routeLabel(route) {
		if (route === "search") return "搜索";
		if (route === "fetch") return "抓取";
		return route;
	}

	function safeHref(value) {
		try {
			const url = new URL(value);
			if (url.protocol === "http:" || url.protocol === "https:") return url.href;
		} catch {
			// Not an absolute URL; render it as text.
		}
		return null;
	}

	function appendMeta(list, label, value) {
		list.append(element("dt", null, label), element("dd", null, value));
	}

	function renderRecord(record) {
		const kind = statusKind(record.status);
		const item = element("li", "record");
		item.dataset.status = kind;

		const summaryText =
			record.query ||
			record.url ||
			record.title ||
			(record.code === "invalid_request_error"
				? "（请求体未通过校验）"
				: "（请求体未解析）");
		const summary = element("span", "record-summary", summaryText);
		summary.title = summaryText;

		const head = element("button", "record-head");
		head.type = "button";
		head.setAttribute("aria-expanded", "false");
		head.append(
			element("span", "record-time", formatTime(record.at)),
			element("span", "badge route-" + record.route, routeLabel(record.route)),
			element("span", "badge status-" + kind, String(record.status)),
			summary,
			element("span", "record-provider", record.provider || "—"),
			element("span", "record-duration", formatDuration(record.durationMs)),
		);
		if (record.resultCount !== undefined) {
			head.append(
				element("span", "record-results", record.resultCount + " 条"),
			);
		}
		const chevron = element("span", "chevron", "›");
		chevron.setAttribute("aria-hidden", "true");
		head.append(chevron);

		const detail = element("div", "record-detail");
		detail.hidden = true;
		const meta = element("dl", "record-meta");
		appendMeta(meta, "请求 ID", record.id || "—");
		appendMeta(meta, "时间", formatTime(record.at));
		appendMeta(meta, "耗时", formatDuration(record.durationMs));
		appendMeta(meta, "Provider", record.provider || "—");
		if (record.code) appendMeta(meta, "错误码", record.code);
		if (record.route === "search" && record.needContent !== undefined) {
			appendMeta(meta, "count", record.count === undefined ? "10（默认）" : String(record.count));
			appendMeta(meta, "need_content", record.needContent ? "true" : "false");
		}
		if (record.title) appendMeta(meta, "页面标题", record.title);
		detail.append(meta);

		const results = Array.isArray(record.results) ? record.results : [];
		if (results.length > 0) {
			detail.append(element("p", "detail-label", "结果标题（前 " + results.length + " 条）"));
			const list = element("ol", "result-list");
			for (const result of results) {
				const row = element("li", "result-item");
				const href = safeHref(result.url);
				if (href) {
					const link = element("a", "result-title", result.title || result.url);
					link.href = href;
					link.target = "_blank";
					link.rel = "noreferrer noopener";
					row.append(link);
				} else {
					row.append(element("span", "result-title", result.title || "（无标题）"));
				}
				row.append(element("span", "result-url", result.url || ""));
				list.append(row);
			}
			detail.append(list);
		}

		head.addEventListener("click", () => {
			const expanded = head.getAttribute("aria-expanded") === "true";
			head.setAttribute("aria-expanded", String(!expanded));
			detail.hidden = expanded;
			item.classList.toggle("expanded", !expanded);
		});
		item.append(head, detail);
		return item;
	}

	function matches(record) {
		if (state.route !== "all" && record.route !== state.route) return false;
		const ok = record.status >= 200 && record.status < 300;
		if (state.status === "ok" && !ok) return false;
		if (state.status === "error" && ok) return false;
		const needle = state.text.trim().toLowerCase();
		if (!needle) return true;
		const parts = [record.query, record.url, record.provider, record.code, record.title];
		for (const result of record.results || []) parts.push(result.title, result.url);
		return parts.filter(Boolean).join(" ").toLowerCase().includes(needle);
	}

	function renderStats() {
		let ok = 0;
		let bad = 0;
		let totalDuration = 0;
		let counted = 0;
		for (const record of state.records) {
			if (record.status >= 200 && record.status < 300) ok += 1;
			else bad += 1;
			if (Number.isFinite(record.durationMs)) {
				totalDuration += record.durationMs;
				counted += 1;
			}
		}
		byId("stat-total").textContent = String(state.records.length);
		byId("stat-ok").textContent = String(ok);
		byId("stat-bad").textContent = String(bad);
		byId("stat-avg").textContent = counted > 0 ? formatDuration(totalDuration / counted) : "—";
	}

	function render() {
		renderStats();
		const list = byId("records");
		list.replaceChildren();
		const visible = state.records.filter(matches);
		for (const record of visible) list.append(renderRecord(record));
		byId("empty").hidden = visible.length > 0;
		if (visible.length === 0) {
			byId("empty-title").textContent = state.records.length > 0 ? "没有匹配的记录" : "还没有请求记录";
			byId("empty-text").textContent = state.records.length > 0
				? "调整类型、状态或文本筛选后再试。"
				: "调用一次 /v1/tools/search 或 /v1/tools/fetch 后，这里会显示时间和结果。";
		}
		byId("record-count").textContent = visible.length === state.records.length
			? "已加载 " + state.records.length + " 条"
			: "已加载 " + state.records.length + " 条，筛选后 " + visible.length + " 条";
	}

	function showBanner(message) {
		const banner = byId("banner");
		if (banner.textContent !== message) banner.textContent = message;
		banner.hidden = false;
	}

	function hideBanner() {
		byId("banner").hidden = true;
	}

	function schedule() {
		if (state.timer) {
			clearInterval(state.timer);
			state.timer = 0;
		}
		if (byId("auto-refresh").checked) {
			state.timer = setInterval(() => {
				if (!document.hidden && state.key) void load();
			}, REFRESH_MS);
		}
	}

	async function load() {
		if (!state.key || state.loading) return;
		state.loading = true;
		const button = byId("refresh");
		button.disabled = true;
		try {
			const response = await fetch("/admin/api/records?limit=" + RETENTION, {
				headers: { Authorization: "Bearer " + state.key },
				cache: "no-store",
			});
			if (response.status === 401) {
				handleUnauthorized();
				return;
			}
			if (!response.ok) throw new Error("HTTP " + response.status);
			const payload = await response.json();
			state.records = Array.isArray(payload.records) ? payload.records : [];
			hideBanner();
			render();
			void refreshReady();
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			showBanner("读取请求记录失败：" + detail + "。面板会继续自动重试。");
		} finally {
			state.loading = false;
			button.disabled = false;
		}
	}

	function showLogin(message) {
		byId("panel-view").hidden = true;
		byId("login-view").hidden = false;
		byId("logout").hidden = true;
		byId("key-input").value = "";
		byId("login-error").hidden = !message;
		if (message) byId("login-error").textContent = message;
		byId("key-input").focus();
	}

	function showPanel() {
		byId("login-view").hidden = true;
		byId("panel-view").hidden = false;
		byId("logout").hidden = false;
		byId("login-error").hidden = true;
		schedule();
	}

	function handleUnauthorized() {
		clearStoredKey();
		state.key = "";
		state.records = [];
		render();
		showLogin("Key 已失效，请重新输入。");
	}

	async function onLogin(event) {
		event.preventDefault();
		const input = byId("key-input");
		const key = input.value.trim();
		if (key.length < MIN_KEY_LENGTH) {
			byId("login-error").textContent = "Key 至少需要 " + MIN_KEY_LENGTH + " 个字符。";
			byId("login-error").hidden = false;
			input.focus();
			return;
		}
		const button = byId("login-submit");
		button.disabled = true;
		button.textContent = "验证中…";
		try {
			const response = await fetch("/admin/api/records?limit=1", {
				headers: { Authorization: "Bearer " + key },
				cache: "no-store",
			});
			if (response.status === 401) {
				byId("login-error").textContent = "Key 无效，或与当前网关不匹配。";
				byId("login-error").hidden = false;
				input.select();
				return;
			}
			if (!response.ok) {
				byId("login-error").textContent = "网关返回 HTTP " + response.status + "，暂时无法读取记录。";
				byId("login-error").hidden = false;
				return;
			}
			state.key = key;
			storeKey(key);
			showPanel();
			await load();
		} catch {
			byId("login-error").textContent = "无法连接网关，请检查网络后重试。";
			byId("login-error").hidden = false;
		} finally {
			button.disabled = false;
			button.textContent = "进入面板";
		}
	}

	function logout() {
		clearStoredKey();
		state.key = "";
		state.records = [];
		state.text = "";
		byId("filter-text").value = "";
		render();
		showLogin("");
	}

	function bind() {
		byId("login-form").addEventListener("submit", (event) => void onLogin(event));
		byId("logout").addEventListener("click", logout);
		byId("refresh").addEventListener("click", () => void load());
		byId("auto-refresh").addEventListener("change", schedule);
		byId("filter-text").addEventListener("input", () => {
			state.text = byId("filter-text").value;
			render();
		});
		document.querySelectorAll("[data-route]").forEach((button) => {
			button.addEventListener("click", () => {
				state.route = button.dataset.route;
				document.querySelectorAll("[data-route]").forEach((peer) => {
					peer.setAttribute("aria-pressed", String(peer === button));
				});
				render();
			});
		});
		document.querySelectorAll("[data-status]").forEach((button) => {
			button.addEventListener("click", () => {
				state.status = button.dataset.status;
				document.querySelectorAll("[data-status]").forEach((peer) => {
					peer.setAttribute("aria-pressed", String(peer === button));
				});
				render();
			});
		});
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden && state.key) void load();
		});
	}

	function boot() {
		bind();
		const hashKey = takeKeyFromHash();
		state.key = hashKey || readStoredKey();
		void refreshReady();
		if (!state.key) {
			showLogin("");
			return;
		}
		if (state.key.length < MIN_KEY_LENGTH) {
			state.key = "";
			showLogin("Key 至少需要 " + MIN_KEY_LENGTH + " 个字符。");
			return;
		}
		if (hashKey) storeKey(state.key);
		showPanel();
		void load();
	}

	boot();
})();
</script>
</body>
</html>`;

export function renderPanelHtml(options: PanelOptions): string {
	return PANEL_TEMPLATE.replaceAll("__NONCE__", options.nonce)
		.replaceAll("__RETENTION__", String(options.retention))
		.replaceAll("__MIN_KEY_LENGTH__", String(options.minKeyLength))
		.replaceAll("__VERSION__", options.version);
}
