export const PANEL_PATH = "/panel";
export const RECORDS_PATH = "/admin/api/records";
export const OVERVIEW_PATH = "/admin/api/overview";
export const STATS_RESET_PATH = "/admin/api/stats/reset";
export const CONFIG_PATH = "/admin/api/config";
export const CONFIG_RELOAD_PATH = "/admin/api/config/reload";

export interface PanelOptions {
	nonce: string;
	retention: number;
	minKeyLength: number;
	version: string;
}

/**
 * Self-contained gateway administration console served from memory.
 * Zero external assets, protected by per-response CSP nonce and Bearer auth.
 */
const PANEL_TEMPLATE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>Web Access 网关 · 管理后台</title>
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
button, input, select, textarea { font: inherit; color: inherit; }
a { color: var(--accent); text-underline-offset: 2px; }
h1, h2, h3, p { margin-top: 0; }
[hidden] { display: none !important; }
.topbar {
	display: flex;
	flex-wrap: wrap;
	gap: 12px 20px;
	align-items: center;
	justify-content: space-between;
	padding: 14px clamp(16px, 3.5vw, 36px);
	border-bottom: 1px solid var(--border);
	background: var(--surface);
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand-mark {
	display: grid;
	place-items: center;
	width: 36px;
	height: 36px;
	border: 1px solid var(--border);
	border-radius: 7px;
	background: var(--surface-strong);
	color: var(--accent);
	font: 600 12px var(--mono);
	letter-spacing: 0.05em;
}
h1 { margin: 0; font-size: 16px; letter-spacing: 0.01em; }
.brand p { margin: 1px 0 0; color: var(--muted); font-size: 12px; }
.nav-tabs {
	display: flex;
	gap: 4px;
	padding: 3px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--bg);
}
.nav-tab {
	min-height: 34px;
	padding: 0 14px;
	border: 0;
	border-radius: 6px;
	background: transparent;
	color: var(--muted);
	font-size: 13px;
	font-weight: 500;
	cursor: pointer;
	white-space: nowrap;
}
.nav-tab:hover { color: var(--text); }
.nav-tab[aria-selected="true"] {
	background: var(--surface);
	color: var(--accent);
	font-weight: 600;
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.nav-tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.topbar-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
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
	max-width: 1240px;
	margin: 0 auto;
	padding: 22px clamp(16px, 3.5vw, 36px) 64px;
}
.btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	min-height: 38px;
	padding: 0 13px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--surface);
	font-size: 13px;
	cursor: pointer;
	white-space: nowrap;
}
.btn.sm { min-height: 30px; padding: 0 9px; font-size: 12px; }
.btn:hover:not(:disabled) { background: var(--surface-strong); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { border-color: var(--accent); background: var(--accent); color: var(--bg); font-weight: 600; }
.btn.primary:hover:not(:disabled) { opacity: 0.92; background: var(--accent); }
.btn.danger { border-color: var(--err); color: var(--err); }
.btn.danger:hover:not(:disabled) { background: var(--err-soft); }
.btn.ghost { background: transparent; }
.login {
	max-width: 540px;
	margin: 7vh auto 0;
	padding: clamp(20px, 4vw, 32px);
	border: 1px solid var(--border);
	border-radius: 9px;
	background: var(--surface);
}
.login h2 { margin-bottom: 8px; font-size: 19px; }
.login > p { color: var(--muted); margin-bottom: 20px; }
.login label { display: block; margin-bottom: 6px; font-size: 12px; font-weight: 600; }
.key-row { display: flex; gap: 8px; }
.key-row input, .input, .select {
	min-width: 0;
	min-height: 38px;
	padding: 0 11px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--surface);
}
.key-row input { flex: 1; background: var(--bg); }
.key-row input:focus-visible, .input:focus-visible, .select:focus-visible {
	outline: 2px solid var(--accent);
	outline-offset: 1px;
}
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
.stat-label { display: block; color: var(--muted); font-size: 11px; letter-spacing: 0.04em; }
.stat strong { display: block; margin-top: 3px; font: 600 20px/1.25 var(--mono); }
.stat-sub { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; font-family: var(--mono); }
.toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 10px;
	margin: 16px 0 12px;
}
.segmented {
	display: inline-flex;
	overflow: hidden;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--surface);
}
.segmented button {
	min-height: 36px;
	padding: 0 12px;
	border: 0;
	border-left: 1px solid var(--border);
	background: transparent;
	color: var(--muted);
	font-size: 12px;
	cursor: pointer;
}
.segmented button:first-child { border-left: 0; }
.segmented button[aria-pressed="true"] {
	background: var(--accent-soft);
	color: var(--accent);
	font-weight: 600;
}
.segmented button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
#filter-text {
	flex: 1 1 200px;
	min-width: 150px;
}
.switch {
	display: inline-flex;
	align-items: center;
	gap: 7px;
	min-height: 38px;
	padding: 0 4px;
	color: var(--muted);
	font-size: 12px;
	cursor: pointer;
	white-space: nowrap;
}
.switch input { accent-color: var(--accent); width: 15px; height: 15px; }
.list-head {
	display: flex;
	justify-content: space-between;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px 12px;
	margin: 4px 0 8px;
	color: var(--muted);
	font-size: 12px;
}
.banner {
	margin: 0 0 12px;
	padding: 9px 12px;
	border: 1px solid var(--err);
	border-left-width: 3px;
	border-radius: 6px;
	background: var(--err-soft);
	color: var(--err);
	font-size: 13px;
}
.banner.ok { border-color: var(--ok); background: var(--ok-soft); color: var(--ok); }
.banner.warn { border-color: var(--warn); background: var(--warn-soft); color: var(--warn); }
.records {
	margin: 0;
	padding: 0;
	overflow: hidden;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--surface);
	list-style: none;
}
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
	align-items: center;
	justify-content: center;
	padding: 1px 6px;
	border: 1px solid transparent;
	border-radius: 4px;
	font: 600 11px/1.65 var(--mono);
	white-space: nowrap;
}
.route-search { background: var(--accent-soft); color: var(--accent); }
.route-fetch { border-color: var(--border); background: var(--surface-strong); color: var(--muted); }
.status-ok { background: var(--ok-soft); color: var(--ok); }
.status-warn { background: var(--warn-soft); color: var(--warn); }
.status-error { background: var(--err-soft); color: var(--err); }
.badge-muted { border-color: var(--border); background: var(--bg); color: var(--muted); font-weight: 500; }
.record-summary {
	flex: 1 1 240px;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.record-provider {
	flex: 0 1 auto;
	max-width: 130px;
	overflow: hidden;
	color: var(--muted);
	font: 12px var(--mono);
	text-overflow: ellipsis;
	white-space: nowrap;
}
.record-duration, .record-results {
	flex: 0 0 auto;
	color: var(--muted);
	font: 12px var(--mono);
	text-align: right;
	white-space: nowrap;
}
.record-duration { min-width: 62px; }
.record-results { min-width: 48px; }
.chevron { flex: 0 0 auto; margin-left: auto; color: var(--muted); transition: transform 0.15s ease; }
.record.expanded .chevron { transform: rotate(90deg); }
.record-detail {
	padding: 14px 16px 18px;
	border-top: 1px dashed var(--border);
	background: var(--bg);
}
.record-meta {
	display: grid;
	grid-template-columns: max-content minmax(0, 1fr);
	gap: 5px 16px;
	margin: 0;
}
.record-meta dt { color: var(--muted); font-size: 12px; }
.record-meta dd { margin: 0; overflow-wrap: anywhere; font: 12px/1.5 var(--mono); }
.detail-label {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	margin: 16px 0 8px;
	color: var(--muted);
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.04em;
}
.attempts-list {
	display: grid;
	gap: 6px;
	margin: 0;
	padding: 0;
	list-style: none;
}
.attempt-row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 10px;
	padding: 6px 10px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--surface);
	font-size: 12px;
}
.attempt-provider { font-family: var(--mono); font-weight: 600; }
.attempt-duration { color: var(--muted); font-family: var(--mono); }
.attempt-err { color: var(--err); font-family: var(--mono); overflow-wrap: anywhere; }
.content-preview-box {
	margin-top: 6px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--surface);
	overflow: hidden;
}
.content-preview-pre {
	margin: 0;
	padding: 10px 12px;
	max-height: 280px;
	overflow: auto;
	font: 12px/1.55 var(--mono);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}
.result-list { display: grid; gap: 10px; margin: 0; padding-left: 20px; }
.result-item { padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); }
.result-title { display: block; font-weight: 600; overflow-wrap: anywhere; }
.result-url { display: block; margin-top: 2px; color: var(--muted); font: 11px/1.45 var(--mono); overflow-wrap: anywhere; }
.result-snippet { margin: 5px 0 0; color: var(--text); font-size: 12.5px; overflow-wrap: anywhere; }
.result-preview-details { margin-top: 6px; font-size: 12px; }
.result-preview-details summary { cursor: pointer; color: var(--accent); font-family: var(--mono); }
.empty {
	margin-top: 0;
	padding: 42px 20px;
	border: 1px dashed var(--border);
	border-radius: 8px;
	background: var(--surface);
	color: var(--muted);
	text-align: center;
}
.empty strong { display: block; margin-bottom: 4px; color: var(--text); font-size: 14px; }
.footnote { margin: 14px 0 0; color: var(--muted); font-size: 12px; }
.grid-2 {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 16px;
	margin-top: 16px;
}
.card {
	padding: 16px;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--surface);
	min-width: 0;
}
.card-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	margin-bottom: 12px;
}
.card-head h3 { margin: 0; font-size: 15px; }
.route-chain {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	align-items: center;
	margin: 8px 0;
}
.route-node {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 4px 9px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--bg);
	font: 12px var(--mono);
}
.route-node.ready { border-color: var(--ok); background: var(--ok-soft); color: var(--ok); }
.route-node.unready { border-color: var(--warn); background: var(--warn-soft); color: var(--warn); }
.table-wrap {
	margin-top: 16px;
	overflow-x: auto;
	border: 1px solid var(--border);
	border-radius: 8px;
	background: var(--surface);
}
.data-table {
	width: 100%;
	border-collapse: collapse;
	font-size: 13px;
	text-align: left;
}
.data-table th, .data-table td {
	padding: 10px 12px;
	border-bottom: 1px solid var(--border);
	vertical-align: middle;
}
.data-table th {
	background: var(--surface-strong);
	color: var(--muted);
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.04em;
	white-space: nowrap;
}
.data-table tr:last-child td { border-bottom: 0; }
.mono { font-family: var(--mono); }
.field-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 10px 12px;
	margin-bottom: 14px;
}
.field label {
	display: block;
	margin-bottom: 4px;
	color: var(--muted);
	font-size: 11.5px;
	font-weight: 600;
}
.field input, .field select { width: 100%; }
.bucket-title {
	margin: 12px 0 6px;
	color: var(--muted);
	font-size: 11.5px;
	font-weight: 600;
}
.route-editor-list {
	display: grid;
	gap: 6px;
	margin: 0;
	padding: 0;
	list-style: none;
}
.route-editor-item {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 6px 10px;
	border: 1px solid var(--border);
	border-radius: 6px;
	background: var(--bg);
	font-size: 12.5px;
}
.route-editor-actions { display: flex; gap: 4px; flex-wrap: wrap; }
.editor-drawer {
	margin: 14px 0;
	padding: 16px;
	border: 2px solid var(--accent);
	border-radius: 8px;
	background: var(--surface);
}
@media (max-width: 860px) {
	.grid-2 { grid-template-columns: 1fr; }
}
@media (max-width: 680px) {
	.stats { grid-template-columns: 1fr 1fr; }
	.stat { border-top: 1px solid var(--border); }
	.stat:nth-child(-n+2) { border-top: 0; }
	.stat:nth-child(odd) { border-left: 0; }
	.stat:nth-child(even) { border-left: 1px solid var(--border); }
	.field-grid { grid-template-columns: 1fr; }
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
			<p>管理后台 · 最近 __RETENTION__ 条记录 · 版本 __VERSION__</p>
		</div>
	</div>
	<div class="nav-tabs" id="nav-tabs" role="tablist" aria-label="后台功能模块" hidden>
		<button type="button" class="nav-tab" role="tab" data-tab="records" aria-selected="true">请求记录</button>
		<button type="button" class="nav-tab" role="tab" data-tab="overview" aria-selected="false">路由与统计</button>
		<button type="button" class="nav-tab" role="tab" data-tab="config" aria-selected="false">配置管理</button>
	</div>
	<div class="topbar-actions">
		<span class="status-pill" id="persist-pill" data-state="not-ready" hidden>
			<span class="dot" aria-hidden="true"></span>
			<span id="persist-text">仅内存生效</span>
		</span>
		<span class="status-pill" id="ready-pill" data-state="checking" role="status">
			<span class="dot" aria-hidden="true"></span>
			<span id="ready-text">检查中</span>
		</span>
		<button type="button" class="btn ghost" id="logout" hidden>退出</button>
	</div>
</header>
<main>
	<section class="login" id="login-view" hidden aria-labelledby="login-title">
		<h2 id="login-title">登录网关管理后台</h2>
		<p>查看请求追踪链路、Provider 诊断统计与在线编排配置。请输入网关 API Key 继续。</p>
		<form id="login-form">
			<label for="key-input">网关 API Key</label>
			<div class="key-row">
				<input id="key-input" name="key" type="password" autocomplete="off" spellcheck="false" required minlength="__MIN_KEY_LENGTH__" placeholder="至少 __MIN_KEY_LENGTH__ 个字符">
				<button type="submit" class="btn primary" id="login-submit">进入后台</button>
			</div>
			<p class="hint">Key 仅保存在当前标签页的 sessionStorage；也支持用 <code>#apikey=…</code> 书签打开，脚本会立即从地址栏剥离。</p>
			<p class="form-error" id="login-error" role="alert" hidden></p>
		</form>
	</section>

	<div id="panel-view" hidden>
		<p class="banner" id="banner" role="alert" hidden></p>

		<!-- Tab 1: 请求记录 -->
		<section id="tab-records" role="tabpanel" aria-labelledby="panel-title">
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
				<select id="filter-provider" class="select" aria-label="按 Provider 筛选">
					<option value="">全部 Provider</option>
				</select>
				<input id="filter-text" class="input" type="search" placeholder="筛选 query、URL、provider、错误码、摘要" aria-label="文本筛选">
				<label class="switch"><input type="checkbox" id="auto-refresh" checked>自动刷新</label>
				<button type="button" class="btn" id="refresh">刷新</button>
				<button type="button" class="btn" id="export-records">导出 JSON</button>
				<button type="button" class="btn danger" id="clear-records">清空记录</button>
			</div>
			<div class="list-head">
				<span id="record-count">已加载 0 条</span>
				<span>/v1/tools/search · /v1/tools/fetch</span>
			</div>
			<div class="empty" id="empty" hidden>
				<strong id="empty-title">还没有请求记录</strong>
				<span id="empty-text">调用一次 /v1/tools/search 或 /v1/tools/fetch 后，这里会显示完整链路、耗时与结果预览。</span>
			</div>
			<ul class="records" id="records" aria-label="请求记录"></ul>
			<p class="footnote">记录保存在网关进程内存中（上限 __RETENTION__ 条），含尝试链路、搜索摘要与截断正文预览；重启网关或点击清空后释放。</p>
		</section>

		<!-- Tab 2: 路由与统计看板 -->
		<section id="tab-overview" role="tabpanel" hidden>
			<div class="stats" aria-label="运行时累计指标">
				<div class="stat">
					<span class="stat-label">网关累计请求</span>
					<strong id="ov-total-req">0</strong>
					<span class="stat-sub" id="ov-uptime">运行时间 —</span>
				</div>
				<div class="stat">
					<span class="stat-label">Search 成功 / 总数</span>
					<strong id="ov-search-stat">0 / 0</strong>
					<span class="stat-sub" id="ov-doctor-search">路由检查 —</span>
				</div>
				<div class="stat">
					<span class="stat-label">Fetch 成功 / 总数</span>
					<strong id="ov-fetch-stat">0 / 0</strong>
					<span class="stat-sub" id="ov-doctor-extract">路由检查 —</span>
				</div>
				<div class="stat">
					<span class="stat-label">正文补抓成功 / 尝试</span>
					<strong id="ov-backfill-stat">0 / 0</strong>
					<span class="stat-sub" id="ov-config-mode">配置文件 —</span>
				</div>
			</div>

			<div class="toolbar">
				<div class="segmented" role="group" aria-label="筛选 Provider 列表">
					<button type="button" data-pfilter="all" aria-pressed="true">全部实例</button>
					<button type="button" data-pfilter="routed" aria-pressed="false">仅路由启用</button>
					<button type="button" data-pfilter="ready" aria-pressed="false">仅已就绪</button>
				</div>
				<div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
					<button type="button" class="btn" id="refresh-overview">刷新状态</button>
					<button type="button" class="btn" id="reset-stats">重置累计统计</button>
					<button type="button" class="btn primary" id="jump-config">编排路由与配置</button>
				</div>
			</div>

			<div class="grid-2">
				<div class="card">
					<div class="card-head">
						<h3>Search 路由链</h3>
						<span class="badge badge-muted" id="ov-search-params">—</span>
					</div>
					<div class="bucket-title">主路由 (Primary)</div>
					<div class="route-chain" id="ov-search-primary"></div>
					<div class="bucket-title">兜底路由 (Fallback)</div>
					<div class="route-chain" id="ov-search-fallback"></div>
				</div>
				<div class="card">
					<div class="card-head">
						<h3>Extract 路由链</h3>
						<span class="badge badge-muted" id="ov-extract-params">—</span>
					</div>
					<div class="bucket-title">主路由 (Primary)</div>
					<div class="route-chain" id="ov-extract-primary"></div>
					<div class="bucket-title">兜底路由 (Fallback)</div>
					<div class="route-chain" id="ov-extract-fallback"></div>
				</div>
			</div>

			<div class="table-wrap">
				<table class="data-table" aria-label="Provider 诊断与调用统计">
					<thead>
						<tr>
							<th>实例 ID / 类型</th>
							<th>路由角色</th>
							<th>就绪状态</th>
							<th>凭据与端点来源</th>
							<th>Search (成功/尝试 · 均耗时)</th>
							<th>Extract (成功/尝试 · 均耗时)</th>
							<th>最近状态 / 错误码</th>
							<th>操作</th>
						</tr>
					</thead>
					<tbody id="provider-stats-tbody"></tbody>
				</table>
			</div>
		</section>

		<!-- Tab 3: 配置管理 -->
		<section id="tab-config" role="tabpanel" hidden>
			<div class="card">
				<div class="card-head" style="margin-bottom:6px">
					<div>
						<h3>配置与路由在线管理</h3>
						<p class="hint" id="cfg-file-label" style="margin-top:2px">配置文件：—</p>
					</div>
					<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
						<span class="badge status-warn" id="cfg-dirty-badge" hidden>有未保存修改</span>
						<button type="button" class="btn" id="reload-config">从磁盘重载</button>
						<button type="button" class="btn" id="reset-config-draft">重置草稿</button>
						<button type="button" class="btn primary" id="save-config">保存并应用配置</button>
					</div>
				</div>
				<p class="banner" id="cfg-feedback" role="status" hidden style="margin-top:10px;margin-bottom:0"></p>
			</div>

			<div class="grid-2">
				<div class="card">
					<div class="card-head">
						<h3>Search 路由与预算参数</h3>
					</div>
					<div class="field-grid">
						<div class="field">
							<label for="cfg-s-limit">默认返回条数 (limit, 1-20)</label>
							<input id="cfg-s-limit" class="input" type="number" min="1" max="20">
						</div>
						<div class="field">
							<label for="cfg-s-timeout">总超时 (timeoutMs)</label>
							<input id="cfg-s-timeout" class="input" type="number" min="100" step="500">
						</div>
						<div class="field">
							<label for="cfg-s-attempt">单 Provider 超时 (attemptTimeoutMs)</label>
							<input id="cfg-s-attempt" class="input" type="number" min="100" step="500">
						</div>
						<div class="field">
							<label for="cfg-s-bytes">最大响应字节 (maxResponseBytes)</label>
							<input id="cfg-s-bytes" class="input" type="number" min="1024" step="1024">
						</div>
					</div>
					<div class="bucket-title">主路由 (按顺序回退尝试)</div>
					<ul class="route-editor-list" id="cfg-s-primary"></ul>
					<div class="bucket-title">兜底路由 (主路由全部失败后尝试)</div>
					<ul class="route-editor-list" id="cfg-s-fallback"></ul>
					<div class="bucket-title">未启用 Search 实例</div>
					<ul class="route-editor-list" id="cfg-s-available"></ul>
				</div>

				<div class="card">
					<div class="card-head">
						<h3>Extract 路由与预算参数</h3>
					</div>
					<div class="field-grid">
						<div class="field">
							<label for="cfg-e-minchars">最小正文字符 (minContentCharacters)</label>
							<input id="cfg-e-minchars" class="input" type="number" min="1" step="10">
						</div>
						<div class="field">
							<label for="cfg-e-timeout">总超时 (timeoutMs)</label>
							<input id="cfg-e-timeout" class="input" type="number" min="100" step="500">
						</div>
						<div class="field">
							<label for="cfg-e-attempt">单 Provider 超时 (attemptTimeoutMs)</label>
							<input id="cfg-e-attempt" class="input" type="number" min="100" step="500">
						</div>
						<div class="field">
							<label for="cfg-e-bytes">最大响应字节 (maxResponseBytes)</label>
							<input id="cfg-e-bytes" class="input" type="number" min="1024" step="1024">
						</div>
					</div>
					<div class="bucket-title">主路由 (按顺序回退尝试)</div>
					<ul class="route-editor-list" id="cfg-e-primary"></ul>
					<div class="bucket-title">兜底路由 (主路由全部失败后尝试)</div>
					<ul class="route-editor-list" id="cfg-e-fallback"></ul>
					<div class="bucket-title">未启用 Extract 实例</div>
					<ul class="route-editor-list" id="cfg-e-available"></ul>
				</div>
			</div>

			<div class="card" style="margin-top:16px">
				<div class="card-head">
					<div>
						<h3>Provider 实例与凭据配置</h3>
						<p class="hint" style="margin-top:2px">明文 API Key 永不在接口响应中回显；修改后请点击顶部「保存并应用配置」写回。</p>
					</div>
					<button type="button" class="btn" id="add-provider-btn">+ 新增自定义实例</button>
				</div>

				<div class="editor-drawer" id="provider-editor" hidden>
					<div class="card-head">
						<h3 id="pe-title">编辑 Provider 实例</h3>
						<button type="button" class="btn sm ghost" id="pe-cancel">关闭</button>
					</div>
					<div class="field-grid">
						<div class="field">
							<label for="pe-id">实例 ID (小写唯一标识)</label>
							<input id="pe-id" class="input mono" type="text" placeholder="例如 tavily-backup">
						</div>
						<div class="field">
							<label for="pe-type">Provider 协议类型</label>
							<select id="pe-type" class="select mono"></select>
						</div>
						<div class="field">
							<label for="pe-key-action">配置文件 API Key 操作</label>
							<select id="pe-key-action" class="select">
								<option value="keep">保持现有配置不变</option>
								<option value="set">写入新 API Key</option>
								<option value="clear">清除配置文件中的 API Key</option>
							</select>
						</div>
						<div class="field" id="pe-key-field" hidden>
							<label for="pe-key">新 API Key (仅单向写入，不回显)</label>
							<input id="pe-key" class="input mono" type="password" autocomplete="off" spellcheck="false" placeholder="输入新的 API Key">
						</div>
						<div class="field">
							<label for="pe-key-env">API Key 环境变量名 (apiKeyEnv)</label>
							<input id="pe-key-env" class="input mono" type="text" placeholder="可选，如 CUSTOM_TAVILY_KEY">
						</div>
						<div class="field">
							<label for="pe-base-url">自定义 Base URL (baseUrl)</label>
							<input id="pe-base-url" class="input mono" type="url" placeholder="留空使用协议默认端点">
						</div>
						<div class="field">
							<label for="pe-base-url-env">Base URL 环境变量名 (baseUrlEnv)</label>
							<input id="pe-base-url-env" class="input mono" type="text" placeholder="可选，如 CUSTOM_BASE_URL">
						</div>
						<div class="field" id="pe-filter-wrap" hidden>
							<label for="pe-filter-mode">域名过滤模式 (searchFilterMode)</label>
							<select id="pe-filter-mode" class="select">
								<option value="strict">strict (严格拒绝不支持过滤参数)</option>
								<option value="best_effort">best_effort (本地后置过滤)</option>
							</select>
						</div>
						<div class="field" id="pe-authjson-wrap" hidden>
							<label for="pe-auth-json">xAI 认证文件路径 (authJson)</label>
							<input id="pe-auth-json" class="input mono" type="text" placeholder="可选外部 OAuth JSON 路径">
						</div>
						<div class="field" id="pe-authjson-env-wrap" hidden>
							<label for="pe-auth-json-env">xAI 认证文件环境变量 (authJsonEnv)</label>
							<input id="pe-auth-json-env" class="input mono" type="text" placeholder="如 XAI_AUTH_JSON">
						</div>
						<div class="field" id="pe-model-wrap" hidden>
							<label for="pe-model">模型覆盖 (model)</label>
							<input id="pe-model" class="input mono" type="text" placeholder="如 grok-4.6">
						</div>
						<div class="field" id="pe-model-env-wrap" hidden>
							<label for="pe-model-env">模型环境变量 (modelEnv)</label>
							<input id="pe-model-env" class="input mono" type="text" placeholder="可选模型环境变量">
						</div>
					</div>
					<p class="form-error" id="pe-error" hidden></p>
					<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
						<button type="button" class="btn danger sm" id="pe-delete" hidden>移除自定义实例</button>
						<button type="button" class="btn sm" id="pe-apply">暂存到配置草稿</button>
					</div>
				</div>

				<div class="table-wrap" style="margin-top:8px">
					<table class="data-table" aria-label="Provider 配置清单">
						<thead>
							<tr>
								<th>实例 ID</th>
								<th>协议类型</th>
								<th>支持能力</th>
								<th>当前凭据来源</th>
								<th>生效端点 / 附加项</th>
								<th>草稿状态</th>
								<th>操作</th>
							</tr>
						</thead>
						<tbody id="cfg-providers-tbody"></tbody>
					</table>
				</div>
			</div>
		</section>
	</div>
	<noscript><p class="banner">面板需要 JavaScript 才能管理网关。</p></noscript>
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
		tab: "records",
		records: [],
		overview: null,
		route: "all",
		status: "all",
		providerFilter: "",
		text: "",
		pfilter: "all",
		loading: false,
		timer: 0,
		draft: null,
		dirty: false,
		editingProviderId: null,
		editingIsNew: false,
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
			// Ignore storage errors in restricted contexts.
		}
	}

	function clearStoredKey() {
		try {
			sessionStorage.removeItem(STORAGE_KEY);
		} catch {
			// Ignore storage errors.
		}
	}

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
		if (!value) return "—";
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

	function formatUptime(ms) {
		if (!Number.isFinite(ms) || ms < 0) return "—";
		const sec = Math.floor(ms / 1000);
		if (sec < 60) return sec + " 秒";
		const min = Math.floor(sec / 60);
		if (min < 60) return min + " 分钟";
		const hr = Math.floor(min / 60);
		const remMin = min % 60;
		return hr + " 小时 " + remMin + " 分";
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

	function credSourceLabel(source) {
		if (source === "env") return "环境变量";
		if (source === "config") return "配置文件";
		if (source === "none") return "免凭据";
		return "未配置";
	}

	function safeHref(value) {
		try {
			const url = new URL(value);
			if (url.protocol === "http:" || url.protocol === "https:") return url.href;
		} catch {
			// Render non-HTTP URLs as plain text.
		}
		return null;
	}

	function appendMeta(list, label, value) {
		list.append(element("dt", null, label), element("dd", null, value));
	}

	function renderAttemptRow(attempt, idx) {
		const row = element("li", "attempt-row");
		const badgeKind = attempt.status === "ok" ? "status-ok" : attempt.status === "skipped" ? "status-warn" : "status-error";
		const badgeLabel = attempt.status === "ok" ? "成功" : attempt.status === "skipped" ? "跳过" : "失败";
		row.append(
			element("span", "badge " + badgeKind, "#" + (idx + 1) + " " + badgeLabel),
			element("span", "attempt-provider", attempt.provider + (attempt.providerType && attempt.providerType !== attempt.provider ? " (" + attempt.providerType + ")" : "")),
			element("span", "attempt-duration", formatDuration(attempt.durationMs)),
		);
		if (attempt.errorCode || attempt.httpStatus) {
			const codeStr = [attempt.errorCode, attempt.httpStatus ? "HTTP " + attempt.httpStatus : ""].filter(Boolean).join(" · ");
			row.append(element("span", "badge badge-muted", codeStr));
		}
		if (attempt.errorMessage) {
			row.append(element("span", "attempt-err", attempt.errorMessage));
		}
		return row;
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
		);
		if (record.needContent) {
			head.append(element("span", "badge badge-muted", "含补抓"));
		}
		if (Array.isArray(record.attempts) && record.attempts.length > 1) {
			head.append(element("span", "badge status-warn", record.attempts.length + " 次尝试"));
		}
		head.append(
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
		appendMeta(meta, "最终 Provider", record.provider || "—");
		if (record.code) appendMeta(meta, "错误码", record.code);
		if (record.route === "search" && record.needContent !== undefined) {
			appendMeta(meta, "count", record.count === undefined ? "10（默认）" : String(record.count));
			appendMeta(meta, "need_content", record.needContent ? "true" : "false");
		}
		if (record.title) appendMeta(meta, "页面标题", record.title);
		detail.append(meta);

		const attempts = Array.isArray(record.attempts) ? record.attempts : [];
		if (attempts.length > 0) {
			detail.append(element("div", "detail-label", "Provider 尝试链路（共 " + attempts.length + " 步）"));
			const attList = element("ol", "attempts-list");
			attempts.forEach((att, idx) => attList.append(renderAttemptRow(att, idx)));
			detail.append(attList);
		}

		if (record.contentBackfill) {
			const bf = record.contentBackfill;
			detail.append(
				element(
					"div",
					"detail-label",
					"正文补抓统计（请求 " + bf.requestedCount + " · 尝试 " + bf.attemptedCount + " · 成功 " + bf.succeededCount + " · 耗时 " + formatDuration(bf.durationMs) + "）",
				),
			);
			if (Array.isArray(bf.items) && bf.items.length > 0) {
				const bfList = element("ol", "attempts-list");
				bf.items.forEach((bfItem, idx) => {
					const row = element("li", "attempt-row");
					const bKind = bfItem.status === "ok" ? "status-ok" : bfItem.status === "skipped" ? "status-warn" : "status-error";
					const bLabel = bfItem.status === "ok" ? "补抓成功" : bfItem.status === "skipped" ? "跳过" : bfItem.status === "aborted" ? "中断" : "补抓失败";
					row.append(
						element("span", "badge " + bKind, "#" + (idx + 1) + " " + bLabel),
						element("span", "attempt-provider", bfItem.provider || "—"),
						element("span", "attempt-duration", formatDuration(bfItem.durationMs)),
					);
					if (bfItem.contentChars !== undefined) {
						row.append(element("span", "badge badge-muted", bfItem.contentChars + " 字符"));
					}
					row.append(element("span", "result-url", bfItem.url));
					bfList.append(row);
				});
				detail.append(bfList);
			}
		}

		if (record.contentPreview) {
			const labelRow = element("div", "detail-label");
			const charText = record.contentChars
				? "抓取正文预览（" + record.contentChars + " 字符" + (record.contentTruncated ? "，已截断预览" : "") + "）"
				: "抓取正文预览";
			labelRow.append(element("span", null, charText));
			const copyBtn = element("button", "btn sm", "复制预览");
			copyBtn.type = "button";
			copyBtn.addEventListener("click", () => {
				if (navigator.clipboard) {
					void navigator.clipboard.writeText(record.contentPreview).then(() => {
						copyBtn.textContent = "已复制";
						setTimeout(() => { copyBtn.textContent = "复制预览"; }, 1200);
					});
				}
			});
			labelRow.append(copyBtn);
			detail.append(labelRow);
			const box = element("div", "content-preview-box");
			box.append(element("pre", "content-preview-pre", record.contentPreview));
			detail.append(box);
		}

		const results = Array.isArray(record.results) ? record.results : [];
		if (results.length > 0) {
			detail.append(element("div", "detail-label", "搜索结果列表（共 " + results.length + " 条）"));
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
				if (result.snippet) {
					row.append(element("p", "result-snippet", result.snippet));
				}
				if (result.contentPreview) {
					const detailsNode = element("details", "result-preview-details");
					const sumText = "查看补抓正文预览" + (result.contentChars ? " (" + result.contentChars + " 字符" + (result.contentTruncated ? "，已截断" : "") + ")" : "");
					detailsNode.append(element("summary", null, sumText));
					const box = element("div", "content-preview-box");
					box.append(element("pre", "content-preview-pre", result.contentPreview));
					detailsNode.append(box);
					row.append(detailsNode);
				}
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
		if (state.providerFilter) {
			const matchedMain = record.provider === state.providerFilter;
			const matchedAttempt = Array.isArray(record.attempts) && record.attempts.some((a) => a.provider === state.providerFilter);
			if (!matchedMain && !matchedAttempt) return false;
		}
		const needle = state.text.trim().toLowerCase();
		if (!needle) return true;
		const parts = [record.query, record.url, record.provider, record.code, record.title];
		for (const result of record.results || []) parts.push(result.title, result.url, result.snippet);
		for (const att of record.attempts || []) parts.push(att.provider, att.errorCode, att.errorMessage);
		return parts.filter(Boolean).join(" ").toLowerCase().includes(needle);
	}

	function updateProviderFilterDropdown() {
		const select = byId("filter-provider");
		const prev = state.providerFilter;
		const names = new Set();
		for (const rec of state.records) {
			if (rec.provider) names.add(rec.provider);
			for (const att of rec.attempts || []) {
				if (att.provider) names.add(att.provider);
			}
		}
		if (state.overview && Array.isArray(state.overview.providers)) {
			for (const p of state.overview.providers) {
				if (p.routeRole.search !== "disabled" || p.routeRole.extract !== "disabled") {
					names.add(p.id);
				}
			}
		}
		const sorted = Array.from(names).sort();
		select.replaceChildren(element("option", null, "全部 Provider"));
		select.firstChild.value = "";
		for (const id of sorted) {
			const opt = element("option", null, id);
			opt.value = id;
			if (id === prev) opt.selected = true;
			select.append(opt);
		}
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

	function renderRecordsTab() {
		renderStats();
		updateProviderFilterDropdown();
		const list = byId("records");
		list.replaceChildren();
		const visible = state.records.filter(matches);
		for (const record of visible) list.append(renderRecord(record));
		byId("empty").hidden = visible.length > 0;
		if (visible.length === 0) {
			byId("empty-title").textContent = state.records.length > 0 ? "没有匹配的记录" : "还没有请求记录";
			byId("empty-text").textContent = state.records.length > 0
				? "调整类型、状态、Provider 或文本筛选后再试。"
				: "调用一次 /v1/tools/search 或 /v1/tools/fetch 后，这里会显示完整链路、耗时与结果预览。";
		}
		byId("record-count").textContent = visible.length === state.records.length
			? "已加载 " + state.records.length + " 条"
			: "已加载 " + state.records.length + " 条，筛选后 " + visible.length + " 条";
	}

	function renderRouteChainNodes(container, ids, providerMap, capability) {
		container.replaceChildren();
		if (!ids || ids.length === 0) {
			container.append(element("span", "hint", "（未配置）"));
			return;
		}
		ids.forEach((id, idx) => {
			if (idx > 0) container.append(element("span", "hint", "→"));
			const p = providerMap.get(id);
			const ready = p ? (capability === "search" ? p.configured.searchReady : p.configured.extractReady) : false;
			const node = element("span", "route-node " + (ready ? "ready" : "unready"));
			node.append(
				element("strong", null, "#" + (idx + 1) + " " + id),
				element("span", null, ready ? "就绪" : "未就绪"),
			);
			container.append(node);
		});
	}

	function renderOverviewTab() {
		const ov = state.overview;
		if (!ov) return;

		const persistPill = byId("persist-pill");
		if (!ov.gateway.configPersisted) {
			persistPill.hidden = false;
			byId("persist-text").textContent = "只读配置·仅内存生效";
		} else {
			persistPill.hidden = true;
		}

		const st = ov.stats;
		byId("ov-total-req").textContent = String(st.totalRequests);
		byId("ov-uptime").textContent = "运行时间 " + formatUptime(ov.gateway.uptimeMs);
		byId("ov-search-stat").textContent = st.searchSuccesses + " / " + st.searchRequests;
		byId("ov-doctor-search").textContent = ov.doctor.routes.search ? "Search 路由就绪" : "Search 路由缺可用实例";
		byId("ov-fetch-stat").textContent = st.fetchSuccesses + " / " + st.fetchRequests;
		byId("ov-doctor-extract").textContent = ov.doctor.routes.extract ? "Extract 路由就绪" : "Extract 路由缺可用实例";
		byId("ov-backfill-stat").textContent = st.backfillItemsSucceeded + " / " + (st.backfillItemsSucceeded + st.backfillItemsFailed);
		byId("ov-config-mode").textContent = ov.gateway.configPersisted ? "已同步配置文件" : "仅内存生效 (只读挂载)";

		byId("ov-search-params").textContent =
			"limit=" + ov.routes.search.limit + " · timeout=" + formatDuration(ov.routes.search.timeoutMs) + " · attempt=" + formatDuration(ov.routes.search.attemptTimeoutMs);
		byId("ov-extract-params").textContent =
			"minChars=" + ov.routes.extract.minContentCharacters + " · timeout=" + formatDuration(ov.routes.extract.timeoutMs) + " · attempt=" + formatDuration(ov.routes.extract.attemptTimeoutMs);

		const providerMap = new Map(ov.providers.map((p) => [p.id, p]));
		renderRouteChainNodes(byId("ov-search-primary"), ov.routes.search.providers, providerMap, "search");
		renderRouteChainNodes(byId("ov-search-fallback"), ov.routes.search.providers_fallback, providerMap, "search");
		renderRouteChainNodes(byId("ov-extract-primary"), ov.routes.extract.providers, providerMap, "extract");
		renderRouteChainNodes(byId("ov-extract-fallback"), ov.routes.extract.providers_fallback, providerMap, "extract");

		const tbody = byId("provider-stats-tbody");
		tbody.replaceChildren();
		const filtered = ov.providers.filter((p) => {
			if (state.pfilter === "routed") {
				return p.routeRole.search !== "disabled" || p.routeRole.extract !== "disabled";
			}
			if (state.pfilter === "ready") {
				return p.configured.searchReady || p.configured.extractReady;
			}
			return true;
		});

		for (const p of filtered) {
			const tr = element("tr");
			const tdId = element("td");
			tdId.append(
				element("strong", "mono", p.id),
				element("span", "badge badge-muted", p.type),
			);
			if (!p.isBuiltin) {
				tdId.append(element("span", "badge route-search", "自定义"));
			}

			const tdRole = element("td");
			const roles = [];
			if (p.routeRole.search !== "disabled") {
				roles.push("S:" + (p.routeRole.search === "primary" ? "主#" : "备#") + (p.routeRole.searchIndex + 1));
			}
			if (p.routeRole.extract !== "disabled") {
				roles.push("E:" + (p.routeRole.extract === "primary" ? "主#" : "备#") + (p.routeRole.extractIndex + 1));
			}
			tdRole.textContent = roles.length > 0 ? roles.join(" · ") : "未启用";
			tdRole.className = "mono";

			const tdReady = element("td");
			if (p.capabilities.includes("search")) {
				tdReady.append(
					element("span", "badge " + (p.configured.searchReady ? "status-ok" : "status-warn"), p.configured.searchReady ? "Search就绪" : "Search未配"),
				);
			}
			if (p.capabilities.includes("extract")) {
				tdReady.append(
					element("span", "badge " + (p.configured.extractReady ? "status-ok" : "status-warn"), p.configured.extractReady ? "Extract就绪" : "Extract未配"),
				);
			}

			const tdCred = element("td");
			tdCred.append(
				element("span", "badge badge-muted", credSourceLabel(p.credentialSource)),
			);
			if (p.config.effectiveBaseUrl) {
				const urlSpan = element("div", "result-url", p.config.effectiveBaseUrl);
				tdCred.append(urlSpan);
			}

			const sStat = p.stats.search;
			const tdSearch = element("td", "mono");
			tdSearch.textContent = p.capabilities.includes("search")
				? sStat.successes + "/" + sStat.attempts + " · " + (sStat.attempts > 0 ? formatDuration(sStat.avgDurationMs) : "—")
				: "—";

			const eStat = p.stats.extract;
			const tdExtract = element("td", "mono");
			tdExtract.textContent = p.capabilities.includes("extract")
				? eStat.successes + "/" + eStat.attempts + " · " + (eStat.attempts > 0 ? formatDuration(eStat.avgDurationMs) : "—")
				: "—";

			const tdLast = element("td", "mono");
			const errEntries = Object.entries({ ...sStat.errorCodes, ...eStat.errorCodes });
			if (errEntries.length > 0) {
				tdLast.textContent = errEntries.map(([k, v]) => k + ":" + v).join(", ");
			} else if (sStat.lastUsedAt || eStat.lastUsedAt) {
				tdLast.textContent = "正常 · " + formatTime(Math.max(sStat.lastUsedAt || 0, eStat.lastUsedAt || 0));
			} else {
				tdLast.textContent = "暂无调用";
			}

			const tdAct = element("td");
			const editBtn = element("button", "btn sm", "配置");
			editBtn.type = "button";
			editBtn.addEventListener("click", () => {
				switchTab("config");
				openProviderEditor(p.id, false);
			});
			tdAct.append(editBtn);

			tr.append(tdId, tdRole, tdReady, tdCred, tdSearch, tdExtract, tdLast, tdAct);
			tbody.append(tr);
		}
	}

	function cloneOverviewToDraft(ov) {
		return {
			search: {
				providers: [...ov.routes.search.providers],
				providers_fallback: [...ov.routes.search.providers_fallback],
				limit: ov.routes.search.limit,
				timeoutMs: ov.routes.search.timeoutMs,
				attemptTimeoutMs: ov.routes.search.attemptTimeoutMs,
				maxResponseBytes: ov.routes.search.maxResponseBytes,
			},
			extract: {
				providers: [...ov.routes.extract.providers],
				providers_fallback: [...ov.routes.extract.providers_fallback],
				timeoutMs: ov.routes.extract.timeoutMs,
				attemptTimeoutMs: ov.routes.extract.attemptTimeoutMs,
				minContentCharacters: ov.routes.extract.minContentCharacters,
				maxResponseBytes: ov.routes.extract.maxResponseBytes,
			},
			providerPatches: {},
			removedProviders: [],
		};
	}

	function setDirty(dirty) {
		state.dirty = dirty;
		byId("cfg-dirty-badge").hidden = !dirty;
	}

	function getEffectiveProvidersList() {
		const ov = state.overview;
		if (!ov || !state.draft) return [];
		const removed = new Set(state.draft.removedProviders);
		const map = new Map();
		for (const p of ov.providers) {
			if (!removed.has(p.id)) {
				map.set(p.id, { ...p, draftPatch: state.draft.providerPatches[p.id] || null });
			}
		}
		for (const [id, patch] of Object.entries(state.draft.providerPatches)) {
			if (!map.has(id) && !removed.has(id)) {
				const typeInfo = ov.providerTypes.find((t) => t.type === patch.type);
				map.set(id, {
					id,
					type: patch.type,
					isBuiltin: false,
					capabilities: typeInfo ? typeInfo.capabilities : ["search"],
					configured: {
						credential: patch.apiKeyAction === "set" || Boolean(patch.apiKeyEnv),
						baseUrl: true,
						adapter: true,
						searchReady: patch.apiKeyAction === "set" || Boolean(patch.apiKeyEnv),
						extractReady: patch.apiKeyAction === "set" || Boolean(patch.apiKeyEnv),
					},
					credentialSource: patch.apiKeyAction === "set" ? "config" : patch.apiKeyEnv ? "env" : "missing",
					config: {
						hasConfigApiKey: patch.apiKeyAction === "set",
						apiKeyEnv: patch.apiKeyEnv || undefined,
						configBaseUrl: patch.baseUrl || undefined,
						effectiveBaseUrl: patch.baseUrl || null,
						baseUrlEnv: patch.baseUrlEnv || undefined,
						authJson: patch.authJson || undefined,
						authJsonEnv: patch.authJsonEnv || undefined,
						model: patch.model || undefined,
						modelEnv: patch.modelEnv || undefined,
						searchFilterMode: patch.searchFilterMode || null,
						headerNames: [],
					},
					draftPatch: patch,
				});
			}
		}
		return Array.from(map.values());
	}

	function moveItem(arr, fromIdx, toIdx) {
		if (toIdx < 0 || toIdx >= arr.length) return;
		const [moved] = arr.splice(fromIdx, 1);
		arr.splice(toIdx, 0, moved);
		setDirty(true);
		renderConfigTab();
	}

	function renderRouteBucket(container, list, otherList, capability, kind, providerMap) {
		container.replaceChildren();
		if (list.length === 0) {
			const emptyLi = element("li", "route-editor-item");
			emptyLi.append(element("span", "hint", "（空）"));
			container.append(emptyLi);
			return;
		}
		list.forEach((id, idx) => {
			const p = providerMap.get(id);
			const ready = p ? (capability === "search" ? p.configured.searchReady : p.configured.extractReady) : false;
			const li = element("li", "route-editor-item");
			const left = element("div", null);
			left.style.display = "flex";
			left.style.alignItems = "center";
			left.style.gap = "8px";
			left.append(
				element("strong", "mono", "#" + (idx + 1) + " " + id),
				element("span", "badge " + (ready ? "status-ok" : "status-warn"), ready ? "就绪" : "缺凭据"),
			);
			const actions = element("div", "route-editor-actions");
			const upBtn = element("button", "btn sm", "↑");
			upBtn.type = "button";
			upBtn.disabled = idx === 0;
			upBtn.addEventListener("click", () => moveItem(list, idx, idx - 1));

			const downBtn = element("button", "btn sm", "↓");
			downBtn.type = "button";
			downBtn.disabled = idx === list.length - 1;
			downBtn.addEventListener("click", () => moveItem(list, idx, idx + 1));

			const swapBtn = element("button", "btn sm", kind === "primary" ? "转兜底" : "转主路由");
			swapBtn.type = "button";
			swapBtn.addEventListener("click", () => {
				list.splice(idx, 1);
				if (!otherList.includes(id)) otherList.push(id);
				setDirty(true);
				renderConfigTab();
			});

			const delBtn = element("button", "btn sm danger", "移除");
			delBtn.type = "button";
			delBtn.addEventListener("click", () => {
				list.splice(idx, 1);
				setDirty(true);
				renderConfigTab();
			});

			actions.append(upBtn, downBtn, swapBtn, delBtn);
			li.append(left, actions);
			container.append(li);
		});
	}

	function renderAvailableBucket(container, primaryList, fallbackList, capability, allProviders) {
		container.replaceChildren();
		const used = new Set([...primaryList, ...fallbackList]);
		const candidates = allProviders.filter((p) => p.capabilities.includes(capability) && !used.has(p.id));
		if (candidates.length === 0) {
			const emptyLi = element("li", "route-editor-item");
			emptyLi.append(element("span", "hint", "所有支持该能力的实例均已编入路由"));
			container.append(emptyLi);
			return;
		}
		for (const p of candidates) {
			const ready = capability === "search" ? p.configured.searchReady : p.configured.extractReady;
			const li = element("li", "route-editor-item");
			const left = element("div", null);
			left.style.display = "flex";
			left.style.alignItems = "center";
			left.style.gap = "8px";
			left.append(
				element("span", "mono", p.id),
				element("span", "badge " + (ready ? "status-ok" : "status-warn"), ready ? "就绪" : "缺凭据"),
			);
			const actions = element("div", "route-editor-actions");
			const addPrimary = element("button", "btn sm", "+ 主路由");
			addPrimary.type = "button";
			addPrimary.addEventListener("click", () => {
				primaryList.push(p.id);
				setDirty(true);
				renderConfigTab();
			});
			const addFallback = element("button", "btn sm", "+ 兜底");
			addFallback.type = "button";
			addFallback.addEventListener("click", () => {
				fallbackList.push(p.id);
				setDirty(true);
				renderConfigTab();
			});
			actions.append(addPrimary, addFallback);
			li.append(left, actions);
			container.append(li);
		}
	}

	function renderConfigTab() {
		const ov = state.overview;
		if (!ov) return;
		if (!state.draft) {
			state.draft = cloneOverviewToDraft(ov);
			setDirty(false);
		}

		const modeDesc = ov.gateway.configPersisted
			? "可写并同步磁盘"
			: "只读挂载（修改在内存立即生效）";
		byId("cfg-file-label").textContent = "配置文件：" + ov.gateway.configPath + " · " + modeDesc;

		const d = state.draft;
		byId("cfg-s-limit").value = String(d.search.limit);
		byId("cfg-s-timeout").value = String(d.search.timeoutMs);
		byId("cfg-s-attempt").value = String(d.search.attemptTimeoutMs);
		byId("cfg-s-bytes").value = String(d.search.maxResponseBytes);

		byId("cfg-e-minchars").value = String(d.extract.minContentCharacters);
		byId("cfg-e-timeout").value = String(d.extract.timeoutMs);
		byId("cfg-e-attempt").value = String(d.extract.attemptTimeoutMs);
		byId("cfg-e-bytes").value = String(d.extract.maxResponseBytes);

		const allProviders = getEffectiveProvidersList();
		const providerMap = new Map(allProviders.map((p) => [p.id, p]));

		renderRouteBucket(byId("cfg-s-primary"), d.search.providers, d.search.providers_fallback, "search", "primary", providerMap);
		renderRouteBucket(byId("cfg-s-fallback"), d.search.providers_fallback, d.search.providers, "search", "fallback", providerMap);
		renderAvailableBucket(byId("cfg-s-available"), d.search.providers, d.search.providers_fallback, "search", allProviders);

		renderRouteBucket(byId("cfg-e-primary"), d.extract.providers, d.extract.providers_fallback, "extract", "primary", providerMap);
		renderRouteBucket(byId("cfg-e-fallback"), d.extract.providers_fallback, d.extract.providers, "extract", "fallback", providerMap);
		renderAvailableBucket(byId("cfg-e-available"), d.extract.providers, d.extract.providers_fallback, "extract", allProviders);

		const tbody = byId("cfg-providers-tbody");
		tbody.replaceChildren();
		for (const p of allProviders) {
			const tr = element("tr");
			const tdId = element("td", "mono", p.id);
			const tdType = element("td", "mono", p.type);
			const tdCaps = element("td", "mono", p.capabilities.join(", "));
			const tdCred = element("td");
			tdCred.append(
				element("span", "badge " + (p.credentialSource !== "missing" ? "status-ok" : "status-warn"), credSourceLabel(p.credentialSource)),
			);
			if (p.config.apiKeyEnv) {
				tdCred.append(element("span", "badge badge-muted", "env:" + p.config.apiKeyEnv));
			}

			const tdEnd = element("td", "mono");
			tdEnd.textContent = p.config.effectiveBaseUrl || "—";
			if (p.config.searchFilterMode) {
				tdEnd.append(element("span", "badge badge-muted", "filter:" + p.config.searchFilterMode));
			}

			const tdDraft = element("td");
			if (p.draftPatch) {
				tdDraft.append(element("span", "badge status-warn", "待保存修改"));
			} else {
				tdDraft.append(element("span", "hint", "已同步"));
			}

			const tdAct = element("td");
			const editBtn = element("button", "btn sm", "编辑实例");
			editBtn.type = "button";
			editBtn.addEventListener("click", () => openProviderEditor(p.id, false));
			tdAct.append(editBtn);

			tr.append(tdId, tdType, tdCaps, tdCred, tdEnd, tdDraft, tdAct);
			tbody.append(tr);
		}
	}

	function updateProviderEditorTypeFields(type) {
		const ov = state.overview;
		const typeInfo = ov && ov.providerTypes ? ov.providerTypes.find((t) => t.type === type) : null;
		const supportsFilter = typeInfo ? typeInfo.supportsFilterMode : (type === "anysearch" || type === "xcrawl");
		const isXai = typeInfo ? typeInfo.isXai : (type === "xai_x_search" || type === "xai_web_search");
		byId("pe-filter-wrap").hidden = !supportsFilter;
		byId("pe-authjson-wrap").hidden = !isXai;
		byId("pe-authjson-env-wrap").hidden = !isXai;
		byId("pe-model-wrap").hidden = !isXai;
		byId("pe-model-env-wrap").hidden = !isXai;
	}

	function openProviderEditor(id, isNew) {
		const ov = state.overview;
		if (!ov || !state.draft) return;
		state.editingProviderId = id;
		state.editingIsNew = isNew;
		byId("pe-error").hidden = true;

		const typeSelect = byId("pe-type");
		typeSelect.replaceChildren();
		for (const pt of ov.providerTypes) {
			const opt = element("option", null, pt.type + " (" + pt.capabilities.join("/") + ")");
			opt.value = pt.type;
			typeSelect.append(opt);
		}

		const allProviders = getEffectiveProvidersList();
		const existing = !isNew ? allProviders.find((p) => p.id === id) : null;
		const patch = (!isNew && state.draft.providerPatches[id]) || null;

		byId("pe-title").textContent = isNew ? "新增自定义 Provider 实例" : "编辑实例：" + id;
		const idInput = byId("pe-id");
		idInput.value = isNew ? "" : id;
		idInput.readOnly = !isNew;

		const selectedType = patch ? patch.type : existing ? existing.type : ov.providerTypes[0].type;
		typeSelect.value = selectedType;
		typeSelect.disabled = Boolean(existing && existing.isBuiltin);

		const keyAction = patch ? (patch.apiKeyAction || "keep") : "keep";
		byId("pe-key-action").value = keyAction;
		byId("pe-key-field").hidden = keyAction !== "set";
		byId("pe-key").value = patch && patch.apiKey ? patch.apiKey : "";

		byId("pe-key-env").value = patch && patch.apiKeyEnv !== undefined
			? (patch.apiKeyEnv || "")
			: (existing && existing.config.apiKeyEnv) || "";
		byId("pe-base-url").value = patch && patch.baseUrl !== undefined
			? (patch.baseUrl || "")
			: (existing && existing.config.configBaseUrl) || "";
		byId("pe-base-url-env").value = patch && patch.baseUrlEnv !== undefined
			? (patch.baseUrlEnv || "")
			: (existing && existing.config.baseUrlEnv) || "";
		byId("pe-filter-mode").value = patch && patch.searchFilterMode
			? patch.searchFilterMode
			: (existing && existing.config.searchFilterMode) || "strict";
		byId("pe-auth-json").value = patch && patch.authJson !== undefined
			? (patch.authJson || "")
			: (existing && existing.config.authJson) || "";
		byId("pe-auth-json-env").value = patch && patch.authJsonEnv !== undefined
			? (patch.authJsonEnv || "")
			: (existing && existing.config.authJsonEnv) || "";
		byId("pe-model").value = patch && patch.model !== undefined
			? (patch.model || "")
			: (existing && existing.config.model) || "";
		byId("pe-model-env").value = patch && patch.modelEnv !== undefined
			? (patch.modelEnv || "")
			: (existing && existing.config.modelEnv) || "";

		updateProviderEditorTypeFields(selectedType);
		byId("pe-delete").hidden = isNew || Boolean(existing && existing.isBuiltin);
		byId("provider-editor").hidden = false;
		idInput.focus();
	}

	function applyProviderEditorToDraft() {
		const rawId = byId("pe-id").value.trim().toLowerCase();
		const errNode = byId("pe-error");
		if (!rawId || rawId === "auto" || /\\s/.test(rawId)) {
			errNode.textContent = "实例 ID 不能为空、不能包含空白且不能为 auto。";
			errNode.hidden = false;
			return;
		}
		const type = byId("pe-type").value;
		const keyAction = byId("pe-key-action").value;
		const keyVal = byId("pe-key").value.trim();
		if (keyAction === "set" && !keyVal) {
			errNode.textContent = "选择写入新 API Key 时，必须填写非空 Key。";
			errNode.hidden = false;
			return;
		}
		const patch = {
			id: rawId,
			type,
			apiKeyAction: keyAction,
			...(keyAction === "set" ? { apiKey: keyVal } : {}),
			apiKeyEnv: byId("pe-key-env").value.trim() || null,
			baseUrl: byId("pe-base-url").value.trim() || null,
			baseUrlEnv: byId("pe-base-url-env").value.trim() || null,
		};
		if (!byId("pe-filter-wrap").hidden) {
			patch.searchFilterMode = byId("pe-filter-mode").value;
		}
		if (!byId("pe-authjson-wrap").hidden) {
			patch.authJson = byId("pe-auth-json").value.trim() || null;
			patch.authJsonEnv = byId("pe-auth-json-env").value.trim() || null;
			patch.model = byId("pe-model").value.trim() || null;
			patch.modelEnv = byId("pe-model-env").value.trim() || null;
		}
		state.draft.providerPatches[rawId] = patch;
		state.draft.removedProviders = state.draft.removedProviders.filter((item) => item !== rawId);
		byId("provider-editor").hidden = true;
		setDirty(true);
		renderConfigTab();
		showConfigFeedback("ok", "实例 " + rawId + " 已暂存到配置草稿，点击顶部「保存并应用配置」正式生效。");
	}

	function deleteCustomProviderFromDraft() {
		const id = state.editingProviderId;
		if (!id || !state.draft) return;
		delete state.draft.providerPatches[id];
		if (!state.draft.removedProviders.includes(id)) {
			state.draft.removedProviders.push(id);
		}
		state.draft.search.providers = state.draft.search.providers.filter((x) => x !== id);
		state.draft.search.providers_fallback = state.draft.search.providers_fallback.filter((x) => x !== id);
		state.draft.extract.providers = state.draft.extract.providers.filter((x) => x !== id);
		state.draft.extract.providers_fallback = state.draft.extract.providers_fallback.filter((x) => x !== id);
		byId("provider-editor").hidden = true;
		setDirty(true);
		renderConfigTab();
		showConfigFeedback("warn", "已从草稿移除自定义实例 " + id + "，请点击「保存并应用配置」完成提交。");
	}

	function showConfigFeedback(kind, message) {
		const node = byId("cfg-feedback");
		node.className = "banner" + (kind === "ok" ? " ok" : kind === "warn" ? " warn" : "");
		node.textContent = message;
		node.hidden = false;
	}

	function readNumberInputsToDraft() {
		if (!state.draft) return;
		const sLimit = Number(byId("cfg-s-limit").value);
		const sTimeout = Number(byId("cfg-s-timeout").value);
		const sAttempt = Number(byId("cfg-s-attempt").value);
		const sBytes = Number(byId("cfg-s-bytes").value);
		if (Number.isInteger(sLimit) && sLimit >= 1) state.draft.search.limit = sLimit;
		if (Number.isInteger(sTimeout) && sTimeout >= 1) state.draft.search.timeoutMs = sTimeout;
		if (Number.isInteger(sAttempt) && sAttempt >= 1) state.draft.search.attemptTimeoutMs = sAttempt;
		if (Number.isInteger(sBytes) && sBytes >= 1024) state.draft.search.maxResponseBytes = sBytes;

		const eMinChars = Number(byId("cfg-e-minchars").value);
		const eTimeout = Number(byId("cfg-e-timeout").value);
		const eAttempt = Number(byId("cfg-e-attempt").value);
		const eBytes = Number(byId("cfg-e-bytes").value);
		if (Number.isInteger(eMinChars) && eMinChars >= 1) state.draft.extract.minContentCharacters = eMinChars;
		if (Number.isInteger(eTimeout) && eTimeout >= 1) state.draft.extract.timeoutMs = eTimeout;
		if (Number.isInteger(eAttempt) && eAttempt >= 1) state.draft.extract.attemptTimeoutMs = eAttempt;
		if (Number.isInteger(eBytes) && eBytes >= 1024) state.draft.extract.maxResponseBytes = eBytes;
	}

	async function saveConfig() {
		if (!state.key || !state.draft) return;
		readNumberInputsToDraft();
		const btn = byId("save-config");
		btn.disabled = true;
		btn.textContent = "保存中…";
		try {
			const payload = {
				search: state.draft.search,
				extract: state.draft.extract,
				providers: Object.values(state.draft.providerPatches),
				removeProviders: state.draft.removedProviders,
			};
			const response = await fetch("/admin/api/config", {
				method: "PUT",
				headers: {
					Authorization: "Bearer " + state.key,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			});
			if (response.status === 401) {
				handleUnauthorized();
				return;
			}
			const data = await response.json();
			if (!response.ok) {
				const msg = data && data.error && data.error.message ? data.error.message : "保存失败 (HTTP " + response.status + ")";
				showConfigFeedback("error", msg);
				return;
			}
			state.overview = data.overview;
			state.draft = cloneOverviewToDraft(state.overview);
			setDirty(false);
			renderOverviewTab();
			renderConfigTab();
			void refreshReady();
			if (data.persisted) {
				showConfigFeedback("ok", "配置已更新并持久化写回配置文件。");
			} else {
				showConfigFeedback("warn", data.persistWarning || "配置已在内存生效（只读挂载未写入磁盘）。");
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			showConfigFeedback("error", "保存请求异常：" + detail);
		} finally {
			btn.disabled = false;
			btn.textContent = "保存并应用配置";
		}
	}

	async function reloadConfigFromDisk() {
		if (!state.key) return;
		const btn = byId("reload-config");
		btn.disabled = true;
		try {
			const response = await fetch("/admin/api/config/reload", {
				method: "POST",
				headers: { Authorization: "Bearer " + state.key },
			});
			if (response.status === 401) {
				handleUnauthorized();
				return;
			}
			const data = await response.json();
			if (!response.ok) {
				const msg = data && data.error && data.error.message ? data.error.message : "重载失败";
				showConfigFeedback("error", msg);
				return;
			}
			state.overview = data.overview;
			state.draft = cloneOverviewToDraft(state.overview);
			setDirty(false);
			renderOverviewTab();
			renderConfigTab();
			void refreshReady();
			showConfigFeedback("ok", "已从磁盘重新加载最新配置。");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			showConfigFeedback("error", "重载失败：" + detail);
		} finally {
			btn.disabled = false;
		}
	}

	async function clearRecords() {
		if (!state.key) return;
		const btn = byId("clear-records");
		btn.disabled = true;
		try {
			const response = await fetch("/admin/api/records", {
				method: "DELETE",
				headers: { Authorization: "Bearer " + state.key },
			});
			if (response.status === 401) {
				handleUnauthorized();
				return;
			}
			if (response.ok) {
				state.records = [];
				renderRecordsTab();
			}
		} finally {
			btn.disabled = false;
		}
	}

	async function resetStats() {
		if (!state.key) return;
		const btn = byId("reset-stats");
		btn.disabled = true;
		try {
			const response = await fetch("/admin/api/stats/reset", {
				method: "POST",
				headers: { Authorization: "Bearer " + state.key },
			});
			if (response.status === 401) {
				handleUnauthorized();
				return;
			}
			if (response.ok) {
				await loadOverview();
			}
		} finally {
			btn.disabled = false;
		}
	}

	function exportRecordsJson() {
		const visible = state.records.filter(matches);
		const blob = new Blob([JSON.stringify(visible, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "gateway-records-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".json";
		document.body.append(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	}

	function showBanner(message) {
		const banner = byId("banner");
		if (banner.textContent !== message) banner.textContent = message;
		banner.hidden = false;
	}

	function hideBanner() {
		byId("banner").hidden = true;
	}

	function switchTab(tab) {
		state.tab = tab;
		document.querySelectorAll(".nav-tab").forEach((btn) => {
			btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
		});
		byId("tab-records").hidden = tab !== "records";
		byId("tab-overview").hidden = tab !== "overview";
		byId("tab-config").hidden = tab !== "config";
		if (tab === "overview" || tab === "config") {
			void loadOverview();
		}
	}

	function schedule() {
		if (state.timer) {
			clearInterval(state.timer);
			state.timer = 0;
		}
		if (byId("auto-refresh").checked) {
			state.timer = setInterval(() => {
				if (!document.hidden && state.key) {
					if (state.tab === "records") void load();
					else if (state.tab === "overview") void loadOverview();
				}
			}, REFRESH_MS);
		}
	}

	async function loadOverview() {
		if (!state.key) return;
		try {
			const response = await fetch("/admin/api/overview", {
				headers: { Authorization: "Bearer " + state.key },
				cache: "no-store",
			});
			if (response.status === 401) {
				handleUnauthorized();
				return;
			}
			if (!response.ok) return;
			state.overview = await response.json();
			renderOverviewTab();
			if (!state.dirty) {
				state.draft = cloneOverviewToDraft(state.overview);
				renderConfigTab();
			}
		} catch {
			// Ignore transient overview errors during background refresh.
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
			renderRecordsTab();
			void refreshReady();
			if (!state.overview) void loadOverview();
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
		byId("nav-tabs").hidden = true;
		byId("login-view").hidden = false;
		byId("logout").hidden = true;
		byId("persist-pill").hidden = true;
		byId("key-input").value = "";
		byId("login-error").hidden = !message;
		if (message) byId("login-error").textContent = message;
		byId("key-input").focus();
	}

	function showPanel() {
		byId("login-view").hidden = true;
		byId("panel-view").hidden = false;
		byId("nav-tabs").hidden = false;
		byId("logout").hidden = false;
		byId("login-error").hidden = true;
		schedule();
	}

	function handleUnauthorized() {
		clearStoredKey();
		state.key = "";
		state.records = [];
		state.overview = null;
		state.draft = null;
		renderRecordsTab();
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
			await Promise.all([load(), loadOverview()]);
		} catch {
			byId("login-error").textContent = "无法连接网关，请检查网络后重试。";
			byId("login-error").hidden = false;
		} finally {
			button.disabled = false;
			button.textContent = "进入后台";
		}
	}

	function logout() {
		clearStoredKey();
		state.key = "";
		state.records = [];
		state.overview = null;
		state.draft = null;
		state.text = "";
		byId("filter-text").value = "";
		renderRecordsTab();
		showLogin("");
	}

	function bind() {
		byId("login-form").addEventListener("submit", (event) => void onLogin(event));
		byId("logout").addEventListener("click", logout);
		byId("refresh").addEventListener("click", () => void load());
		byId("export-records").addEventListener("click", exportRecordsJson);
		byId("clear-records").addEventListener("click", () => void clearRecords());
		byId("auto-refresh").addEventListener("change", schedule);
		byId("filter-text").addEventListener("input", () => {
			state.text = byId("filter-text").value;
			renderRecordsTab();
		});
		byId("filter-provider").addEventListener("change", () => {
			state.providerFilter = byId("filter-provider").value;
			renderRecordsTab();
		});
		document.querySelectorAll(".nav-tab").forEach((btn) => {
			btn.addEventListener("click", () => switchTab(btn.dataset.tab));
		});
		document.querySelectorAll("[data-route]").forEach((button) => {
			button.addEventListener("click", () => {
				state.route = button.dataset.route;
				document.querySelectorAll("[data-route]").forEach((peer) => {
					peer.setAttribute("aria-pressed", String(peer === button));
				});
				renderRecordsTab();
			});
		});
		document.querySelectorAll("[data-status]").forEach((button) => {
			button.addEventListener("click", () => {
				state.status = button.dataset.status;
				document.querySelectorAll("[data-status]").forEach((peer) => {
					peer.setAttribute("aria-pressed", String(peer === button));
				});
				renderRecordsTab();
			});
		});
		document.querySelectorAll("[data-pfilter]").forEach((button) => {
			button.addEventListener("click", () => {
				state.pfilter = button.dataset.pfilter;
				document.querySelectorAll("[data-pfilter]").forEach((peer) => {
					peer.setAttribute("aria-pressed", String(peer === button));
				});
				renderOverviewTab();
			});
		});
		byId("refresh-overview").addEventListener("click", () => void loadOverview());
		byId("reset-stats").addEventListener("click", () => void resetStats());
		byId("jump-config").addEventListener("click", () => switchTab("config"));

		["cfg-s-limit", "cfg-s-timeout", "cfg-s-attempt", "cfg-s-bytes", "cfg-e-minchars", "cfg-e-timeout", "cfg-e-attempt", "cfg-e-bytes"].forEach((id) => {
			byId(id).addEventListener("input", () => {
				readNumberInputsToDraft();
				setDirty(true);
			});
		});

		byId("save-config").addEventListener("click", () => void saveConfig());
		byId("reload-config").addEventListener("click", () => void reloadConfigFromDisk());
		byId("reset-config-draft").addEventListener("click", () => {
			if (state.overview) {
				state.draft = cloneOverviewToDraft(state.overview);
				setDirty(false);
				byId("provider-editor").hidden = true;
				byId("cfg-feedback").hidden = true;
				renderConfigTab();
			}
		});
		byId("add-provider-btn").addEventListener("click", () => openProviderEditor("", true));
		byId("pe-cancel").addEventListener("click", () => { byId("provider-editor").hidden = true; });
		byId("pe-type").addEventListener("change", () => updateProviderEditorTypeFields(byId("pe-type").value));
		byId("pe-key-action").addEventListener("change", () => {
			byId("pe-key-field").hidden = byId("pe-key-action").value !== "set";
		});
		byId("pe-apply").addEventListener("click", applyProviderEditorToDraft);
		byId("pe-delete").addEventListener("click", deleteCustomProviderFromDraft);

		document.addEventListener("visibilitychange", () => {
			if (!document.hidden && state.key) {
				if (state.tab === "records") void load();
				else if (state.tab === "overview") void loadOverview();
			}
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
		void loadOverview();
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
