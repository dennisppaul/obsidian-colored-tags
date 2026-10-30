import { describe, it, expect, vi } from "vitest";
import { StreamLanguage } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
	applyPrefixedTagsInElement,
	buildPrefixedTagClasses,
	createPrefixedTagsEditorExtension,
	findPrefixedTags,
	PREFIXED_TAG_CLASS,
	sanitizeTagPrefix,
} from "../src/PrefixedTags";

// Minimal language that marks `inline code` like Obsidian's markdown parser
const inlineCodeLanguage = StreamLanguage.define({
	token(stream) {
		if (stream.match(/^`[^`]*`/)) {
			return "inline-code";
		}
		stream.next();
		return null;
	},
	tokenTable: { "inline-code": tags.monospace },
});

const createView = (
	doc: string,
	options: { getPrefix: () => string; onTagsFound: (names: string[]) => void },
) => {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	return new EditorView({
		state: EditorState.create({
			doc,
			extensions: [
				inlineCodeLanguage,
				createPrefixedTagsEditorExtension(options),
			],
		}),
		parent,
	});
};

const decoratedTexts = (view: EditorView) =>
	Array.from(view.dom.querySelectorAll(`.${PREFIXED_TAG_CLASS}`)).map(
		(el) => `${el.textContent}|${el.className}`,
	);

describe("sanitizeTagPrefix", () => {
	it("accepts symbol prefixes", () => {
		expect(sanitizeTagPrefix("@")).toBe("@");
		expect(sanitizeTagPrefix(" + ")).toBe("+");
		expect(sanitizeTagPrefix("@@")).toBe("@@");
	});

	it("rejects empty, whitespace, hash and tag characters", () => {
		expect(sanitizeTagPrefix("")).toBe("");
		expect(sanitizeTagPrefix(undefined)).toBe("");
		expect(sanitizeTagPrefix(null)).toBe("");
		expect(sanitizeTagPrefix("#")).toBe("");
		expect(sanitizeTagPrefix("@ @")).toBe("");
		expect(sanitizeTagPrefix("a")).toBe("");
		expect(sanitizeTagPrefix("@_")).toBe("");
		expect(sanitizeTagPrefix("-")).toBe("");
	});
});

describe("findPrefixedTags", () => {
	it("finds prefixed tags with positions and normalized names", () => {
		expect(findPrefixedTags("hi @Alice and @team/dev.", "@")).toEqual([
			{ from: 3, to: 9, tagName: "alice" },
			{ from: 14, to: 23, tagName: "team/dev" },
		]);
	});

	it("supports unicode and trims trailing slashes", () => {
		expect(findPrefixedTags("@Jürgen/ @日本", "@")).toEqual([
			{ from: 0, to: 7, tagName: "jürgen" },
			{ from: 9, to: 12, tagName: "日本" },
		]);
	});

	it("ignores emails, hashtags, numbers and leading slashes", () => {
		expect(
			findPrefixedTags("a@b.com #x@y @123 @1/2 @/x @ @", "@"),
		).toEqual([]);
		expect(findPrefixedTags("@1a", "@")).toEqual([
			{ from: 0, to: 3, tagName: "1a" },
		]);
	});

	it("escapes regex characters in the prefix", () => {
		expect(findPrefixedTags("+foo $bar", "+")).toEqual([
			{ from: 0, to: 4, tagName: "foo" },
		]);
		expect(findPrefixedTags("+foo $bar", "$")).toEqual([
			{ from: 5, to: 9, tagName: "bar" },
		]);
	});

	it("returns nothing for invalid prefixes", () => {
		expect(findPrefixedTags("@foo #foo", "")).toEqual([]);
		expect(findPrefixedTags("@foo #foo", "#")).toEqual([]);
	});
});

describe("buildPrefixedTagClasses", () => {
	it("combines the marker class with the colored tag class", () => {
		expect(buildPrefixedTagClasses("foo")).toBe(
			`${PREFIXED_TAG_CLASS} colored-tag-foo`,
		);
	});
});

describe("prefixed tags editor extension", () => {
	it("decorates prefixed tags outside of code and reports them", () => {
		const onTagsFound = vi.fn();
		const view = createView("hi @Alice `@code` @Bob", {
			getPrefix: () => "@",
			onTagsFound,
		});

		expect(decoratedTexts(view)).toEqual([
			`@Alice|${PREFIXED_TAG_CLASS} colored-tag-alice`,
			`@Bob|${PREFIXED_TAG_CLASS} colored-tag-bob`,
		]);
		expect(onTagsFound).toHaveBeenCalledWith(["alice", "bob"]);
		view.destroy();
	});

	it("updates on document and prefix changes", () => {
		let prefix = "";
		const onTagsFound = vi.fn();
		const view = createView("@foo +bar", {
			getPrefix: () => prefix,
			onTagsFound,
		});
		expect(decoratedTexts(view)).toEqual([]);
		expect(onTagsFound).not.toHaveBeenCalled();

		prefix = "+";
		view.dispatch({});
		expect(decoratedTexts(view)).toEqual([
			`+bar|${PREFIXED_TAG_CLASS} colored-tag-bar`,
		]);

		view.dispatch({ changes: { from: 0, insert: "+baz " } });
		expect(onTagsFound).toHaveBeenLastCalledWith(["baz", "bar"]);

		// Unrelated updates keep the decorations
		view.dispatch({ selection: { anchor: 1 } });
		expect(decoratedTexts(view)).toHaveLength(2);
		view.destroy();
	});
});

describe("applyPrefixedTagsInElement", () => {
	it("wraps prefixed tags in spans, skipping code and links", () => {
		const root = document.createElement("div");
		root.innerHTML =
			"<p>Hi @Alice, ask @bob.</p><p>plain</p><code>@code</code><a>@link</a>";

		expect(applyPrefixedTagsInElement(root, "@")).toEqual(["alice", "bob"]);
		expect(root.innerHTML).toBe(
			`<p>Hi <span class="${PREFIXED_TAG_CLASS} colored-tag-alice">@Alice</span>, ` +
				`ask <span class="${PREFIXED_TAG_CLASS} colored-tag-bob">@bob</span>.</p>` +
				"<p>plain</p><code>@code</code><a>@link</a>",
		);

		// Already wrapped tags are not wrapped again
		expect(applyPrefixedTagsInElement(root, "@")).toEqual([]);
	});

	it("does nothing without a valid prefix", () => {
		const root = document.createElement("div");
		root.textContent = "@foo";

		expect(applyPrefixedTagsInElement(root, "")).toEqual([]);
		expect(root.innerHTML).toBe("@foo");
	});
});
