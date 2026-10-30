import { syntaxTree } from "@codemirror/language";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { buildColoredTagClass } from "./tag-appliers/TagApplier";
import { normalizeTagName } from "./tagUtils";

/**
 * Support for tags written with an additional prefix (e.g. `@person`).
 * Obsidian itself only parses `#tag`, so these are found and decorated by the
 * plugin and share colors with the `#tag` of the same name.
 */

export const PREFIXED_TAG_CLASS = "colored-prefixed-tag";

export interface PrefixedTagMatch {
	from: number;
	to: number;
	tagName: string;
}

const TAG_BODY = "[\\p{L}\\p{N}_-][\\p{L}\\p{N}_/-]*";
const TAG_CHAR = /[\p{L}\p{N}_/-]/u;
const NON_NUMERIC = /[^\d/]/u;

// Editor syntax nodes and reading view elements in which prefixes are ignored
const SKIPPED_NODE_TYPE = /code|math|url|link|frontmatter|comment|html/i;
const SKIPPED_ELEMENTS = `code, pre, a, .math, .frontmatter, .${PREFIXED_TAG_CLASS}`;

const regexCache = new Map<string, RegExp>();

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the prefix if it can be used to mark tags, otherwise an empty string.
 * The prefix must not be whitespace, `#` or contain characters valid in tag names.
 */
export function sanitizeTagPrefix(prefix: string | null | undefined): string {
	const trimmed = (prefix ?? "").trim();
	if (!trimmed || /[\s#]/.test(trimmed)) {
		return "";
	}
	return Array.from(trimmed).some((char) => TAG_CHAR.test(char))
		? ""
		: trimmed;
}

function getPrefixRegex(prefix: string): RegExp {
	let regex = regexCache.get(prefix);
	if (!regex) {
		regex = new RegExp(
			`(?<![\\p{L}\\p{N}_/#])${escapeRegExp(prefix)}(${TAG_BODY})`,
			"gu",
		);
		regexCache.set(prefix, regex);
	}
	return regex;
}

export function findPrefixedTags(
	text: string,
	prefix: string,
): PrefixedTagMatch[] {
	const validPrefix = sanitizeTagPrefix(prefix);
	if (!validPrefix) {
		return [];
	}

	const matches: PrefixedTagMatch[] = [];
	for (const match of text.matchAll(getPrefixRegex(validPrefix))) {
		const body = match[1].replace(/\/+$/, "");
		// Like Obsidian, purely numeric names are not tags
		if (!NON_NUMERIC.test(body)) {
			continue;
		}
		const from = match.index as number;
		matches.push({
			from,
			to: from + validPrefix.length + body.length,
			tagName: normalizeTagName(body),
		});
	}
	return matches;
}

export function buildPrefixedTagClasses(tagName: string): string {
	return `${PREFIXED_TAG_CLASS} ${buildColoredTagClass(tagName)}`;
}

function isInSkippedNode(state: EditorState, pos: number): boolean {
	let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
	for (; node; node = node.parent) {
		if (SKIPPED_NODE_TYPE.test(node.name)) {
			return true;
		}
	}
	return false;
}

export interface PrefixedTagsOptions {
	getPrefix: () => string;
	onTagsFound: (tagNames: string[]) => void;
}

export function buildPrefixedTagDecorations(
	view: EditorView,
	prefix: string,
	onTagsFound: (tagNames: string[]) => void,
): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const found = new Set<string>();

	for (const { from, to } of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		for (const match of findPrefixedTags(text, prefix)) {
			const start = from + match.from;
			if (isInSkippedNode(view.state, start)) {
				continue;
			}
			builder.add(
				start,
				from + match.to,
				Decoration.mark({
					class: buildPrefixedTagClasses(match.tagName),
				}),
			);
			found.add(match.tagName);
		}
	}

	if (found.size) {
		onTagsFound(Array.from(found));
	}
	return builder.finish();
}

export function createPrefixedTagsEditorExtension(
	options: PrefixedTagsOptions,
) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private prefix: string;

			constructor(view: EditorView) {
				this.prefix = options.getPrefix();
				this.decorations = buildPrefixedTagDecorations(
					view,
					this.prefix,
					options.onTagsFound,
				);
			}

			update(update: ViewUpdate) {
				const prefix = options.getPrefix();
				if (
					update.docChanged ||
					update.viewportChanged ||
					prefix !== this.prefix ||
					syntaxTree(update.startState) !== syntaxTree(update.state)
				) {
					this.prefix = prefix;
					this.decorations = buildPrefixedTagDecorations(
						update.view,
						prefix,
						options.onTagsFound,
					);
				}
			}
		},
		{ decorations: (plugin) => plugin.decorations },
	);
}

/**
 * Wraps prefixed tags inside rendered markdown (reading view) in spans.
 * Returns the names of the tags found.
 */
export function applyPrefixedTagsInElement(
	root: HTMLElement,
	prefix: string,
): string[] {
	if (!sanitizeTagPrefix(prefix)) {
		return [];
	}

	const doc = root.ownerDocument;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	while (walker.nextNode()) {
		textNodes.push(walker.currentNode as Text);
	}

	const found = new Set<string>();
	for (const node of textNodes) {
		if (node.parentElement?.closest(SKIPPED_ELEMENTS)) {
			continue;
		}
		const text = node.data;
		const matches = findPrefixedTags(text, prefix);
		if (!matches.length) {
			continue;
		}

		const fragment = doc.createDocumentFragment();
		let lastIndex = 0;
		for (const match of matches) {
			fragment.append(text.slice(lastIndex, match.from));
			const span = doc.createElement("span");
			span.className = buildPrefixedTagClasses(match.tagName);
			span.textContent = text.slice(match.from, match.to);
			fragment.append(span);
			lastIndex = match.to;
			found.add(match.tagName);
		}
		fragment.append(text.slice(lastIndex));
		node.replaceWith(fragment);
	}

	return Array.from(found);
}
