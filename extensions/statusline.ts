/**
 * Combined TUI statusline: official pi block logo + Claude-style two-line footer.
 *
 * Header (logo left, compact key hints right):
 *   ██████     esc interrupt · ctrl+c/ctrl+d clear/exit
 *   ██  ██     / commands · ! bash · ctrl+o more
 *   ████  ██   Press ctrl+o for full help & resources
 *   ██    ██   vX.Y.Z
 *
 * Footer:
 *   grok-4.5 (xAI) | xhigh                     ⟳  ░░░░░░░░░░  0.0% | 500k
 *   .../Code/demo/gin-demo ⎇ feat *? · PR #42  ↑80k ↓15k R1.2M CH99.2%
 *
 * Auto-applies on session_start. After editing: /reload.
 * Disable this extension to fully restore built-in header/footer.
 */
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	VERSION,
	keyHint,
	keyText,
	rawKeyHint,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─── Header: official pi block logo + key hints ──────────────────────────────

const BLOCK = "█";
const HEADER_INDENT = "  ";

/**
 * Official geometry (first-time-setup / pi.dev logo-mark), as a #/space grid.
 *
 *   ██████
 *   ██  ██
 *   ████  ██
 *   ██    ██
 */
const GRID = [
	"######",
	"##  ##",
	"####  ##",
	"##    ##",
] as const;

const THINKING_COLOR: Record<string, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

/** Solid logo lines — color follows thinking level. */
function getPiLogoLines(theme: Theme, level?: string): string[] {
	const color: ThemeColor = level ? (THINKING_COLOR[level] ?? "accent") : "accent";
	const ink = theme.fg(color, BLOCK);
	const lines: string[] = [];
	for (const row of GRID) {
		let line = HEADER_INDENT;
		for (const ch of row) line += ch === "#" ? ink : " ";
		lines.push(line.replace(/\s+$/, ""));
	}
	return lines;
}

/**
 * Place right-side text beside left art, padding each left line to a common width.
 */
function joinSideBySide(
	leftLines: string[],
	rightLines: string[],
	gap: number,
	width: number,
): string[] {
	const leftW = Math.max(0, ...leftLines.map((l) => visibleWidth(l)));
	const count = Math.max(leftLines.length, rightLines.length);
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const left = leftLines[i] ?? "";
		const right = rightLines[i] ?? "";
		if (!right) {
			out.push(truncateToWidth(left, width));
			continue;
		}
		const pad = Math.max(gap, leftW - visibleWidth(left) + gap);
		out.push(truncateToWidth(left + " ".repeat(pad) + right, width));
	}
	return out;
}

/** Compact key hints that used to live in the built-in header. */
function getHeaderHints(theme: Theme): string[] {
	const sep = theme.fg("muted", " · ");
	return [
		[
			keyHint("app.interrupt", "interrupt"),
			rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
		].join(sep),
		[
			rawKeyHint("/", "commands"),
			rawKeyHint("!", "bash"),
			keyHint("app.tools.expand", "more"),
		].join(sep),
		theme.fg(
			"dim",
			`Press ${keyText("app.tools.expand")} for full help & resources`,
		),
		theme.fg("dim", `v${VERSION}`),
	];
}

function applyMascotHeader(ctx: ExtensionContext) {
	if (ctx.mode !== "tui") return;
	ctx.ui.setHeader((_tui, theme) => ({
		render(width: number): string[] {
			const level = ctx.model?.reasoning ? ctx.thinkingLevel : undefined;
			const logo = getPiLogoLines(theme, level);
			const hints = getHeaderHints(theme);
			const logoW = Math.max(0, ...logo.map((l) => visibleWidth(l)));
			const gap = 3;
			// Narrow terminal: stack logo then hints instead of clipping hard.
			const sideBySide = width >= logoW + gap + 24;
			const body = sideBySide
				? joinSideBySide(logo, hints, gap, width)
				: [
						...logo,
						...hints.map((h) =>
							truncateToWidth(`${HEADER_INDENT}${h}`, width),
						),
				  ];
			return ["", ...body, ""];
		},
		invalidate() {},
	}));
}

// ─── Shared git / path helpers (footer) ──────────────────────────────────────

const DIRTY_POLL_MS = 4000;
/** PR lookup is networked; poll less often than dirty flags. */
const PR_POLL_MS = 30_000;

/** Cached git dirty flags so render stays sync. */
let dirtyCache = { cwd: "", at: 0, flags: "" };
let dirtyInFlight = false;

/** Cached GitHub PR for current branch (via `gh`). */
let prCache: {
	cwd: string;
	branch: string;
	at: number;
	label: string;
	color: ThemeColor;
} = { cwd: "", branch: "", at: 0, label: "", color: "muted" };
let prInFlight = false;

/** Home → ~ ; otherwise keep absolute. */
function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const inside =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/**
 * Shorten long paths Claude-style:
 *   ~/Code/demo/gin-demo          → as-is if short
 *   /Users/gy/Code/demo/gin-demo  → .../Code/demo/gin-demo when needed
 */
function shortenPath(path: string, maxWidth: number): string {
	if (visibleWidth(path) <= maxWidth) return path;
	const parts = path.split(sep).filter(Boolean);
	if (parts.length <= 2) return truncateToWidth(path, maxWidth, "…");

	for (let keep = Math.min(3, parts.length); keep >= 1; keep--) {
		const tail = parts.slice(-keep).join(sep);
		const candidate = `...${sep}${tail}`;
		if (visibleWidth(candidate) <= maxWidth) return candidate;
	}
	return truncateToWidth(path, maxWidth, "…");
}

function refreshDirtyFlags(cwd: string, onDone: () => void) {
	if (dirtyInFlight) return;
	const now = Date.now();
	if (dirtyCache.cwd === cwd && now - dirtyCache.at < DIRTY_POLL_MS) return;

	dirtyInFlight = true;
	execFile(
		"git",
		["status", "--porcelain", "-b"],
		{ cwd, timeout: 1500, maxBuffer: 256 * 1024 },
		(err, stdout) => {
			dirtyInFlight = false;
			if (err) {
				dirtyCache = { cwd, at: Date.now(), flags: "" };
				onDone();
				return;
			}
			const lines = stdout.split("\n").filter((l) => l.length > 0 && !l.startsWith("##"));
			let unstaged = false;
			let untracked = false;
			let staged = false;
			for (const line of lines) {
				const x = line[0] ?? " ";
				const y = line[1] ?? " ";
				if (line.startsWith("??") || line.startsWith("!!")) {
					untracked = true;
					continue;
				}
				if (x !== " " && x !== "?") staged = true;
				if (y !== " " && y !== "?") unstaged = true;
			}
			let flags = "";
			if (unstaged || staged) flags += "*";
			if (untracked) flags += "?";
			dirtyCache = { cwd, at: Date.now(), flags };
			onDone();
		},
	);
}

function prColorForState(state: string): ThemeColor {
	switch (state.toUpperCase()) {
		case "OPEN":
			return "success";
		case "MERGED":
			return "accent";
		case "CLOSED":
			return "muted";
		default:
			return "muted";
	}
}

/**
 * Resolve open/closed PR for the current branch via GitHub CLI.
 * Empty label when: no `gh`, not a gh repo, no PR for branch, or lookup failed.
 */
function refreshPrLabel(cwd: string, branch: string | null, onDone: () => void) {
	if (!branch || branch === "HEAD") {
		if (prCache.label) {
			prCache = {
				cwd,
				branch: branch ?? "",
				at: Date.now(),
				label: "",
				color: "muted",
			};
			onDone();
		}
		return;
	}
	if (prInFlight) return;
	const now = Date.now();
	if (
		prCache.cwd === cwd &&
		prCache.branch === branch &&
		now - prCache.at < PR_POLL_MS
	) {
		return;
	}

	prInFlight = true;
	execFile(
		"gh",
		["pr", "view", "--json", "number,state"],
		{ cwd, timeout: 4000, maxBuffer: 64 * 1024 },
		(err, stdout) => {
			prInFlight = false;
			let label = "";
			let color: ThemeColor = "muted";
			if (!err) {
				try {
					const data = JSON.parse(stdout) as { number?: number; state?: string };
					if (typeof data.number === "number" && Number.isFinite(data.number)) {
						label = `PR #${data.number}`;
						color = prColorForState(data.state ?? "");
					}
				} catch {
					// ignore parse errors
				}
			}
			prCache = { cwd, branch, at: Date.now(), label, color };
			onDone();
		},
	);
}

// ─── Footer: Claude-style status ────────────────────────────────────────────

const BAR_WIDTH = 10;
const FILLED = "█";
const EMPTY = "░";
/** Auto-compact indicator (left of context bar). */
const AUTO_COMPACT_ICON = "⟳";

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function thinkingColor(level: string): ThemeColor {
	return THINKING_COLOR[level] ?? "muted";
}

function contextBar(percent: number | null, theme: Theme): string {
	if (percent === null || Number.isNaN(percent)) {
		return theme.fg("dim", EMPTY.repeat(BAR_WIDTH));
	}
	const p = Math.max(0, Math.min(100, percent));
	const filled = Math.round((p / 100) * BAR_WIDTH);
	const empty = BAR_WIDTH - filled;

	return theme.fg("dim", FILLED.repeat(filled) + EMPTY.repeat(empty));
}

function percentColor(_percent: number | null, text: string, theme: Theme): string {
	return theme.fg("dim", text);
}

function joinPadded(left: string, right: string, width: number): string {
	const lw = visibleWidth(left);
	const rw = visibleWidth(right);
	if (lw + rw + 2 > width) {
		const maxLeft = Math.max(0, width - rw - 2);
		const truncatedLeft = maxLeft > 0 ? truncateToWidth(left, maxLeft, "…") : "";
		const pad = Math.max(1, width - visibleWidth(truncatedLeft) - rw);
		return truncatedLeft + " ".repeat(pad) + right;
	}
	const pad = Math.max(2, width - lw - rw);
	return left + " ".repeat(pad) + right;
}

function sessionUsage(ctx: ExtensionContext): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
} {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let latestCacheHitRate: number | undefined;

	for (const e of ctx.sessionManager.getEntries()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			const u = m.usage;
			if (!u) continue;
			input += u.input ?? 0;
			output += u.output ?? 0;
			cacheRead += u.cacheRead ?? 0;
			cacheWrite += u.cacheWrite ?? 0;
			cost += u.cost?.total ?? 0;
			const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
			latestCacheHitRate = prompt > 0 ? ((u.cacheRead ?? 0) / prompt) * 100 : undefined;
		} else if (e.type === "message" && e.message.role === "toolResult" && e.message.usage) {
			const u = e.message.usage;
			input += u.input ?? 0;
			output += u.output ?? 0;
			cacheRead += u.cacheRead ?? 0;
			cacheWrite += u.cacheWrite ?? 0;
			cost += u.cost?.total ?? 0;
		} else if ((e.type === "branch_summary" || e.type === "compaction") && e.usage) {
			const u = e.usage;
			input += u.input ?? 0;
			output += u.output ?? 0;
			cacheRead += u.cacheRead ?? 0;
			cacheWrite += u.cacheWrite ?? 0;
			cost += u.cost?.total ?? 0;
		}
	}
	return { input, output, cacheRead, cacheWrite, cost, latestCacheHitRate };
}

/** Session usage for bottom-right: ↑ ↓ R W CH $ (context % lives on line 1). */
function formatStatsRight(stats: ReturnType<typeof sessionUsage>, theme: Theme): string {
	const parts: string[] = [];
	if (stats.input) parts.push(`↑${formatTokens(stats.input)}`);
	if (stats.output) parts.push(`↓${formatTokens(stats.output)}`);
	if (stats.cacheRead) parts.push(`R${formatTokens(stats.cacheRead)}`);
	if (stats.cacheWrite) parts.push(`W${formatTokens(stats.cacheWrite)}`);
	if ((stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.latestCacheHitRate !== undefined) {
		parts.push(`CH${stats.latestCacheHitRate.toFixed(1)}%`);
	}
	if (stats.cost) parts.push(`$${stats.cost.toFixed(3)}`);
	return parts.map((s) => theme.fg("dim", s)).join(" ");
}

function applyClaudeFooter(ctx: ExtensionContext) {
	if (ctx.mode !== "tui") return;

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsub = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsub,
			invalidate() {},
			render(width: number): string[] {
				const model = ctx.model;
				const modelId = model?.id ?? "no-model";
				const usage = ctx.getContextUsage();
				const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
				const percent = usage?.percent ?? null;
				const percentValue = percent ?? 0;

				// ── Line 1: model (provider) thinking ····· ↻ bar  pct% | window
				let topLeft = theme.bold(theme.fg("accent", modelId));
				const provider = model?.provider;
				if (provider) {
					topLeft += theme.fg("muted", ` (${provider})`);
				}
				const thinking = ctx.thinkingLevel;
				const supportsReasoning = Boolean(model?.reasoning);
				if (supportsReasoning && thinking) {
					const level = thinking === "off" ? "thinking off" : thinking;
					topLeft += " " + theme.fg(thinkingColor(thinking), level);
				}

				const bar = contextBar(percent, theme);
				const pctCore = percent === null ? "?%" : `${percentValue.toFixed(1)}%`;
				const windowLabel = contextWindow > 0 ? formatTokens(contextWindow) : "?";
				const pctText = `${pctCore} | ${windowLabel}`;
				const autoIcon = theme.fg("dim", AUTO_COMPACT_ICON);
				// Extra space between ↻ and the bar for visual separation
				const topRight = `${autoIcon}  ${bar}  ${percentColor(percent, pctText, theme)}`;

				const line1 = joinPadded(topLeft, topRight, width);

				// ── Line 2: path ⎇ branch flags · #pr ····· full stats / statuses
				const cwd = ctx.sessionManager.getCwd();
				const branch = footerData.getGitBranch();
				refreshDirtyFlags(cwd, () => tui.requestRender());
				refreshPrLabel(cwd, branch, () => tui.requestRender());

				const home = process.env.HOME || process.env.USERPROFILE;
				let pathStr = formatCwd(cwd, home);
				const dirty = dirtyCache.cwd === cwd ? dirtyCache.flags : "";
				const prHit = prCache.cwd === cwd && prCache.branch === (branch ?? "");
				const prLabel = prHit ? prCache.label : "";
				const prColor: ThemeColor = prHit ? prCache.color : "muted";

				const stats = sessionUsage(ctx);
				const usageRight = formatStatsRight(stats, theme);

				const statuses = footerData.getExtensionStatuses();
				let statusExtra = "";
				if (statuses.size > 0) {
					statusExtra = Array.from(statuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, t]) => sanitizeStatusText(t))
						.filter(Boolean)
						.join("  ");
				}
				const rightParts = [statusExtra, usageRight].filter(Boolean);
				const bottomRight = rightParts.join("  ");
				const rightW = visibleWidth(bottomRight);

				const branchPart = branch
					? theme.fg("accent", ` ⎇ ${branch}`) +
						(dirty ? theme.fg("warning", ` ${dirty}`) : "") +
						(prLabel ? theme.fg(prColor, ` · ${prLabel}`) : "")
					: "";

				const maxPath = Math.max(12, width - rightW - visibleWidth(branchPart) - 4);
				pathStr = shortenPath(pathStr, maxPath);
				const bottomLeft = theme.fg("dim", pathStr) + branchPart;

				const sessionName = ctx.sessionManager.getSessionName();
				const bottomLeftWithName = sessionName
					? bottomLeft + theme.fg("dim", ` · ${sessionName}`)
					: bottomLeft;

				const line2 = joinPadded(bottomLeftWithName, bottomRight, width);

				return [
					truncateToWidth(line1, width),
					truncateToWidth(line2, width, theme.fg("dim", "…")),
				];
			},
		};
	});
}

function applyStatusline(ctx: ExtensionContext) {
	applyMascotHeader(ctx);
	applyClaudeFooter(ctx);
}

// ─── Extension entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		applyStatusline(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		applyClaudeFooter(ctx);
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		applyClaudeFooter(ctx);
		applyMascotHeader(ctx);
	});
}
