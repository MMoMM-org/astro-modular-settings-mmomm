import { App, TFile } from 'obsidian';
import { ConfigFileInfo, ObsidianVaultAdapter } from '../../types';

export class ConfigFileManager {
	private app: App;
	private configPath: string;

	constructor(app: App) {
		this.app = app;
		// The main Astro config.ts file is at src/config.ts (two levels up from vault)
		this.configPath = '../../src/config.ts';
	}

	getConfigFileInfo(): ConfigFileInfo {
		// The main Astro config.ts file is at src/config.ts (two levels up from vault)
		// NOTE: This plugin accesses files outside the Obsidian vault to manage Astro configuration.
		// This is necessary for the plugin's core functionality of managing Astro Modular theme settings.
		
		// Try to access the file outside the vault using Node.js fs
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
		const fs = require('fs') as typeof import('fs');
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
		const path = require('path') as typeof import('path');
		try {
			// Get the actual vault path string from the adapter
			const adapter = this.app.vault.adapter as ObsidianVaultAdapter;
			const vaultPath = adapter.basePath || adapter.path;
			
			// If vaultPath is an object, try to get the string value
			const vaultPathString = typeof vaultPath === 'string' ? vaultPath : (vaultPath ? String(vaultPath) : '');
			
			const configPath = path.join(vaultPathString, '..', '..', 'src', 'config.ts');
			
			if (fs.existsSync(configPath)) {
				const content = fs.readFileSync(configPath, 'utf8');
				const stats = fs.statSync(configPath);
				return {
					exists: true,
					path: configPath,
					content: content,
					lastModified: new Date(stats.mtime),
					valid: true,
					errors: []
				};
			} else {
				return {
					exists: false,
					path: configPath,
					content: '',
					lastModified: new Date(),
					valid: false,
					errors: ['Config file not found']
				};
			}
		} catch {
			return {
				exists: false,
				path: this.configPath,
				content: '',
				lastModified: new Date(),
				valid: false,
				errors: ['Cannot access file outside vault']
			};
		}
	}

	private validateConfigContent(content: string): boolean {
		// Basic validation - check for common Astro config patterns
		return content.includes('defineConfig') ||
			   content.includes('export default') ||
			   content.includes('astro/config');
	}

	/**
	 * Generic recursive-descent parser for TypeScript object/array/primitive literals
	 * embedded in config.ts. Used to read NavigationItem entries (with arbitrary
	 * unknown fields preserved) and LocalisedString values, without having to
	 * hand-write per-field regex extractors.
	 *
	 * Returns the parsed JS value and the position immediately after it.
	 * Whitespace at startPos is consumed.
	 */
	/**
	 * Advance past whitespace and TypeScript line/block comments. Used in the
	 * generic value parsers so embedded comments inside arrays/objects (e.g. a
	 * documentation block between two array items) are correctly skipped
	 * rather than being parsed as identifiers.
	 */
	private skipWsAndComments(content: string, startPos: number): number {
		let pos = startPos;
		while (pos < content.length) {
			if (/\s/.test(content[pos])) { pos++; continue; }
			if (content[pos] === '/' && content[pos + 1] === '/') {
				while (pos < content.length && content[pos] !== '\n') pos++;
				continue;
			}
			if (content[pos] === '/' && content[pos + 1] === '*') {
				pos += 2;
				while (pos < content.length && !(content[pos] === '*' && content[pos + 1] === '/')) pos++;
				pos += 2;
				continue;
			}
			break;
		}
		return pos;
	}

	private parseTsValue(content: string, startPos: number): { value: unknown; endPos: number } {
		let pos = this.skipWsAndComments(content, startPos);
		const ch = content[pos];

		// String "..."
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let end = pos + 1;
			while (end < content.length && content[end] !== quote) {
				if (content[end] === '\\' && end + 1 < content.length) end += 2;
				else end++;
			}
			return { value: content.slice(pos + 1, end), endPos: end + 1 };
		}

		// Template literal `...` (no interpolation handling — used for footer.content HTML)
		if (ch === '`') {
			let end = pos + 1;
			while (end < content.length && content[end] !== '`') {
				if (content[end] === '\\' && end + 1 < content.length) end += 2;
				else end++;
			}
			return { value: content.slice(pos + 1, end), endPos: end + 1 };
		}

		// Object literal
		if (ch === '{') {
			return this.parseTsObject(content, pos);
		}

		// Array literal
		if (ch === '[') {
			return this.parseTsArray(content, pos);
		}

		// Boolean / null / undefined
		const wordMatch = content.slice(pos).match(/^(true|false|null|undefined)\b/);
		if (wordMatch) {
			const w = wordMatch[1];
			const value = w === 'true' ? true : w === 'false' ? false : w === 'null' ? null : undefined;
			return { value, endPos: pos + w.length };
		}

		// Number
		const numMatch = content.slice(pos).match(/^-?\d+(?:\.\d+)?/);
		if (numMatch) {
			return { value: parseFloat(numMatch[0]), endPos: pos + numMatch[0].length };
		}

		// Identifier (variable reference, e.g. `siteConfig.foo`) — capture as a raw
		// passthrough string so the writer can reproduce it verbatim.
		const identMatch = content.slice(pos).match(/^[A-Za-z_$][\w$.]*/);
		if (identMatch) {
			return { value: { __raw: identMatch[0] }, endPos: pos + identMatch[0].length };
		}

		// Unknown — advance one char to avoid infinite loops.
		return { value: null, endPos: pos + 1 };
	}

	private parseTsObject(content: string, startPos: number): { value: Record<string, unknown>; endPos: number } {
		let pos = startPos;
		const obj: Record<string, unknown> = {};
		if (content[pos] !== '{') return { value: obj, endPos: pos };
		pos++;

		while (pos < content.length) {
			pos = this.skipWsAndComments(content, pos);
			if (content[pos] === '}') { pos++; break; }

			// Optional spread `...foo` — passthrough as raw key.
			const spreadMatch = content.slice(pos).match(/^\.\.\.[A-Za-z_$][\w$.]*/);
			if (spreadMatch) {
				obj['__spread__' + spreadMatch[0]] = { __raw: spreadMatch[0] };
				pos += spreadMatch[0].length;
				pos = this.skipWsAndComments(content, pos);
				if (content[pos] === ',') pos++;
				continue;
			}

			// Key: identifier or "quoted"
			const keyMatch = content.slice(pos).match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*/);
			if (!keyMatch) { pos++; continue; }
			const key = keyMatch[1] ?? keyMatch[2] ?? keyMatch[3];
			pos += keyMatch[0].length;

			const v = this.parseTsValue(content, pos);
			obj[key] = v.value;
			pos = v.endPos;

			pos = this.skipWsAndComments(content, pos);
			if (content[pos] === ',') pos++;
		}
		return { value: obj, endPos: pos };
	}

	private parseTsArray(content: string, startPos: number): { value: unknown[]; endPos: number } {
		let pos = startPos;
		const arr: unknown[] = [];
		if (content[pos] !== '[') return { value: arr, endPos: pos };
		pos++;

		while (pos < content.length) {
			pos = this.skipWsAndComments(content, pos);
			if (content[pos] === ']') { pos++; break; }

			const v = this.parseTsValue(content, pos);
			arr.push(v.value);
			pos = v.endPos;

			pos = this.skipWsAndComments(content, pos);
			if (content[pos] === ',') pos++;
		}
		return { value: arr, endPos: pos };
	}

	/**
	 * Parse a marker-anchored value that might be a string or a LocalisedString
	 * object literal. Returns the parsed value (string | Record<string,string>) or
	 * undefined when the marker is absent. Used for site-info fields that gained
	 * LocalisedString shape in ADR-005.
	 */
	private parseStringOrLocalised(content: string, marker: string, fieldName: string): string | Record<string, string> | undefined {
		const markerLine = `// [${marker}]`;
		const markerIdx = content.indexOf(markerLine);
		if (markerIdx === -1) return undefined;

		// Find the field after the marker
		const fieldRegex = new RegExp(`${fieldName}\\s*:\\s*`);
		const after = content.slice(markerIdx + markerLine.length);
		const fieldMatch = after.match(fieldRegex);
		if (!fieldMatch || fieldMatch.index === undefined) return undefined;

		const valueStart = markerIdx + markerLine.length + fieldMatch.index + fieldMatch[0].length;
		const { value } = this.parseTsValue(content, valueStart);

		if (typeof value === 'string') return value;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			// Filter to entries with string values only — that's the LocalisedString shape.
			const obj = value as Record<string, unknown>;
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(obj)) {
				if (typeof v === 'string') out[k] = v;
			}
			if (Object.keys(out).length > 0) return out;
		}
		return undefined;
	}

	readConfig(): string {
		const fileInfo = this.getConfigFileInfo();
		return fileInfo.content;
	}

	writeConfig(content: string): boolean {
		// Try to write the file outside the vault using Node.js fs
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
		const fs = require('fs') as typeof import('fs');
		// eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
		const path = require('path') as typeof import('path');
		try {
			// Get the actual vault path string from the adapter
			const adapter = this.app.vault.adapter as ObsidianVaultAdapter;
			const vaultPath = adapter.basePath || adapter.path;
			
			// If vaultPath is an object, try to get the string value
			const vaultPathString = typeof vaultPath === 'string' ? vaultPath : (vaultPath ? String(vaultPath) : '');
			
			const configPath = path.join(vaultPathString, '..', '..', 'src', 'config.ts');
			
			fs.writeFileSync(configPath, content, 'utf8');
			return true;
		} catch {
			return false;
		}
	}

	async detectAstroDevServer(): Promise<boolean> {
		// Check if Astro dev server is running by looking for common indicators
		// This is a simplified check - in reality you'd need more sophisticated detection
		const packageJson = this.app.vault.getAbstractFileByPath('package.json');
		if (packageJson && packageJson instanceof TFile) {
			try {
				const content = await this.app.vault.read(packageJson);
				return content.includes('astro') && content.includes('dev');
			} catch {
				return false;
			}
		}
		return false;
	}

	parseConfigFile(content?: string): Record<string, unknown> | null {
		// Parse the config.ts file to extract current settings
		// This extracts all key settings from the config using the marker system
		
		const configContent = content || this.readConfig();
		if (!configContent) {
			return null;
		}

		const config: Record<string, unknown> = {};

		// Extract site information
		const siteInfo: Record<string, unknown> = {};
		const siteUrlMatch = configContent.match(/\/\/ \[CONFIG:SITE_URL\]\s*\n\s*site:\s*"([^"]*)"/);
		if (siteUrlMatch) {
			siteInfo.site = siteUrlMatch[1];
		}
		
		// Title / description / homepageTitle / defaultOgImageAlt accept either
		// `"string"` or `{ de: "...", en: "..." }` shapes (ADR-005 Decision 3).
		const siteTitle = this.parseStringOrLocalised(configContent, 'CONFIG:SITE_TITLE', 'title');
		if (siteTitle !== undefined) siteInfo.title = siteTitle;

		const homepageTitle = this.parseStringOrLocalised(configContent, 'CONFIG:HOMEPAGE_TITLE', 'homepageTitle');
		if (homepageTitle !== undefined) siteInfo.homepageTitle = homepageTitle;

		const siteDesc = this.parseStringOrLocalised(configContent, 'CONFIG:SITE_DESCRIPTION', 'description');
		if (siteDesc !== undefined) siteInfo.description = siteDesc;

		const siteAuthorMatch = configContent.match(/\/\/ \[CONFIG:SITE_AUTHOR\]\s*\n\s*author:\s*"([^"]*)"/);
		if (siteAuthorMatch) {
			siteInfo.author = siteAuthorMatch[1];
		}

		// Locale source-of-truth: prefer [CONFIG:LOCALES] + [CONFIG:DEFAULT_LOCALE]
		// pair; fall back to legacy [CONFIG:SITE_LANGUAGE] for single-locale configs.
		const localesMarkerIdx = configContent.indexOf('// [CONFIG:LOCALES]');
		if (localesMarkerIdx !== -1) {
			const after = configContent.slice(localesMarkerIdx + '// [CONFIG:LOCALES]'.length);
			const fieldMatch = after.match(/locales\s*:\s*/);
			if (fieldMatch && fieldMatch.index !== undefined) {
				const valueStart = localesMarkerIdx + '// [CONFIG:LOCALES]'.length + fieldMatch.index + fieldMatch[0].length;
				const { value } = this.parseTsValue(configContent, valueStart);
				if (Array.isArray(value)) {
					siteInfo.locales = value.filter((v): v is string => typeof v === 'string');
				}
			}
		}
		const defaultLocaleMatch = configContent.match(/\/\/ \[CONFIG:DEFAULT_LOCALE\]\s*\n\s*defaultLocale:\s*['"]([^'"]+)['"]/);
		if (defaultLocaleMatch) {
			siteInfo.defaultLocale = defaultLocaleMatch[1];
		}
		const siteLangMatch = configContent.match(/\/\/ \[CONFIG:SITE_LANGUAGE\]\s*\n\s*language:\s*"([^"]*)"/);
		if (siteLangMatch) {
			siteInfo.language = siteLangMatch[1];
			// Backfill locales/defaultLocale from legacy single-locale field when
			// the new markers are absent — keeps existing single-locale sites working.
			if (!siteInfo.locales) siteInfo.locales = [siteLangMatch[1]];
			if (!siteInfo.defaultLocale) siteInfo.defaultLocale = siteLangMatch[1];
		}
		config.siteInfo = siteInfo;

		const faviconThemeAdaptiveMatch = configContent.match(/\/\/ \[CONFIG:FAVICON_THEME_ADAPTIVE\]\s*\n\s*faviconThemeAdaptive:\s*(true|false)/);
		if (faviconThemeAdaptiveMatch) {
			config.faviconThemeAdaptive = faviconThemeAdaptiveMatch[1] === 'true';
		}

		const defaultOgImageAlt = this.parseStringOrLocalised(configContent, 'CONFIG:DEFAULT_OG_IMAGE_ALT', 'defaultOgImageAlt');
		if (defaultOgImageAlt !== undefined) config.defaultOgImageAlt = defaultOgImageAlt;

		// Extract theme
		const themeMatch = configContent.match(/\/\/ \[CONFIG:THEME\]\s*\n\s*theme:\s*"([^"]*)"/);
		if (themeMatch) {
			config.currentTheme = themeMatch[1];
		}

		// Extract available themes
		const availableThemesMatch = configContent.match(/\/\/ \[CONFIG:AVAILABLE_THEMES\]\s*\n\s*availableThemes:\s*(?:"default"|\[[^\]]*\])/);
		if (availableThemesMatch) {
			const value = availableThemesMatch[0].match(/availableThemes:\s*(.+)$/)?.[1];
			if (value === '"default"') {
				config.availableThemes = 'default';
			} else if (value?.startsWith('[') && value?.endsWith(']')) {
				// Parse array format: ["oxygen", "minimal", "nord"]
				const themesArray = value.slice(1, -1).split(',').map(theme => theme.trim().replace(/"/g, ''));
				config.availableThemes = themesArray;
			}
		}

		// Extract custom themes
		const customThemesMatch = configContent.match(/\/\/ \[CONFIG:CUSTOM_THEMES\]\s*\n\s*customThemes:\s*"[^"]*"/);
		if (customThemesMatch) {
			const value = customThemesMatch[0].match(/customThemes:\s*"([^"]*)"/)?.[1];
			config.customThemes = value || '';
		}

		// Extract typography settings
		const typography: Record<string, unknown> = {};
		const fontSourceMatch = configContent.match(/\/\/ \[CONFIG:FONT_SOURCE\]\s*\n\s*source:\s*"([^"]*)"/);
		if (fontSourceMatch) {
			typography.fontSource = fontSourceMatch[1];
		}
		
		const fontBodyMatch = configContent.match(/\/\/ \[CONFIG:FONT_BODY\]\s*\n\s*body:\s*"([^"]*)"/);
		if (fontBodyMatch) {
			typography.proseFont = fontBodyMatch[1];
		}
		
		const fontHeadingMatch = configContent.match(/\/\/ \[CONFIG:FONT_HEADING\]\s*\n\s*heading:\s*"([^"]*)"/);
		if (fontHeadingMatch) {
			typography.headingFont = fontHeadingMatch[1];
		}
		
		const fontMonoMatch = configContent.match(/\/\/ \[CONFIG:FONT_MONO\]\s*\n\s*mono:\s*"([^"]*)"/);
		if (fontMonoMatch) {
			typography.monoFont = fontMonoMatch[1];
		}
		config.typography = typography;

		// Extract navigation settings
		const navigation: Record<string, unknown> = { pages: [], social: [] };

		// Navigation pages: scan forward from the marker for `pages: [` (so the
		// parser tolerates documentation comments between the marker and the
		// field — a property the regex-based extractor lacked). Then parseTsArray
		// preserves arbitrary unknown fields on each item (i18nKey, urlByLocale,
		// external, future extensions).
		const pagesMarkerIdx = configContent.indexOf('// [CONFIG:NAVIGATION_PAGES]');
		const socialMarkerIdx = configContent.indexOf('// [CONFIG:NAVIGATION_SOCIAL]');
		let pagesArrayEnd = -1;
		if (pagesMarkerIdx !== -1) {
			const searchEnd = socialMarkerIdx !== -1 ? socialMarkerIdx : configContent.length;
			const pagesFieldMatch = configContent.slice(pagesMarkerIdx, searchEnd).match(/\bpages\s*:\s*\[/);
			if (pagesFieldMatch && pagesFieldMatch.index !== undefined) {
				const bracketIdx = pagesMarkerIdx + pagesFieldMatch.index + pagesFieldMatch[0].length - 1;
				const { value, endPos } = this.parseTsArray(configContent, bracketIdx);
				navigation.pages = (value as unknown[]).filter(
					(v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
				);
				pagesArrayEnd = endPos;
			}
		}

		// Navigation footer: either anchored to its own [CONFIG:NAVIGATION_FOOTER]
		// marker (preferred), or detected structurally as a `footer: [...]` block
		// between the pages array end and the SOCIAL marker. Same passthrough
		// semantics as nav.pages.
		const footerMarkerIdx = configContent.indexOf('// [CONFIG:NAVIGATION_FOOTER]');
		if (footerMarkerIdx !== -1 && socialMarkerIdx !== -1 && footerMarkerIdx < socialMarkerIdx) {
			const footerFieldMatch = configContent.slice(footerMarkerIdx, socialMarkerIdx).match(/\bfooter\s*:\s*\[/);
			if (footerFieldMatch && footerFieldMatch.index !== undefined) {
				const bracketIdx = footerMarkerIdx + footerFieldMatch.index + footerFieldMatch[0].length - 1;
				const { value } = this.parseTsArray(configContent, bracketIdx);
				navigation.footer = (value as unknown[]).filter(
					(v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
				);
			}
		} else if (pagesArrayEnd !== -1 && socialMarkerIdx !== -1) {
			// No marker — try structural detection between pages end and SOCIAL marker.
			const between = configContent.slice(pagesArrayEnd, socialMarkerIdx);
			const footerFieldMatch = between.match(/\bfooter\s*:\s*\[/);
			if (footerFieldMatch && footerFieldMatch.index !== undefined) {
				const bracketIdx = pagesArrayEnd + footerFieldMatch.index + footerFieldMatch[0].length - 1;
				const { value } = this.parseTsArray(configContent, bracketIdx);
				navigation.footer = (value as unknown[]).filter(
					(v): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
				);
			}
		}
		
		// Extract navigation social
		const socialMatch = configContent.match(/\/\/ \[CONFIG:NAVIGATION_SOCIAL\]\s*\n\s*social:\s*\[([\s\S]*?)\]/);
		if (socialMatch) {
			const socialContent = socialMatch[1];
			// Match the multi-line format: { title: "...", url: "...", icon: "..." }
			const socialMatches = socialContent.matchAll(/\{\s*\n\s*title:\s*"([^"]*)",\s*\n\s*url:\s*"([^"]*)",\s*\n\s*icon:\s*"([^"]*)",?\s*\n\s*\}/g);
			for (const socialMatch of socialMatches) {
				(navigation.social as Array<Record<string, unknown>>).push({
					title: socialMatch[1],
					url: socialMatch[2],
					icon: socialMatch[3]
				});
			}
		}
		config.navigation = navigation;

		// Extract post options
		const postOptions: Record<string, unknown> = {};
		
		// Extract table of contents
		const tocMatch = configContent.match(/\/\/ \[CONFIG:POST_OPTIONS_TABLE_OF_CONTENTS\]\s*tableOfContents:\s*(true|false)/);
		if (tocMatch) {
			postOptions.tableOfContents = tocMatch[1] === 'true';
		}

		// Extract reading time
		const readingTimeMatch = configContent.match(/\/\/ \[CONFIG:POST_OPTIONS_READING_TIME\]\s*readingTime:\s*(true|false)/);
		if (readingTimeMatch) {
			postOptions.readingTime = readingTimeMatch[1] === 'true';
		}

		// Extract linked mentions
		const linkedMentionsEnabledMatch = configContent.match(/\/\/ \[CONFIG:POST_OPTIONS_LINKED_MENTIONS_ENABLED\]\s*enabled:\s*(true|false)/);
		const linkedMentionsCompactMatch = configContent.match(/\/\/ \[CONFIG:POST_OPTIONS_LINKED_MENTIONS_COMPACT\]\s*linkedMentionsCompact:\s*(true|false)/);
		
		if (linkedMentionsEnabledMatch || linkedMentionsCompactMatch) {
			postOptions.linkedMentions = {
				enabled: linkedMentionsEnabledMatch ? linkedMentionsEnabledMatch[1] === 'true' : false,
				linkedMentionsCompact: linkedMentionsCompactMatch ? linkedMentionsCompactMatch[1] === 'true' : false
			};
		}

		// Extract graph view
		const graphViewMatch = configContent.match(/\/\/ \[CONFIG:POST_OPTIONS_GRAPH_VIEW_ENABLED\]\s*enabled:\s*(true|false)/);
		if (graphViewMatch) {
			postOptions.graphView = {
				enabled: graphViewMatch[1] === 'true'
			};
		}

		// Extract post navigation
		const postNavigationMatch = configContent.match(/\/\/ \[CONFIG:POST_OPTIONS_POST_NAVIGATION\]\s*postNavigation:\s*(true|false)/);
		if (postNavigationMatch) {
			postOptions.postNavigation = postNavigationMatch[1] === 'true';
		}

		// Extract comments
		const commentsMatch = configContent.match(/\/\/ \[CONFIG:POST_OPTIONS_COMMENTS_ENABLED\]\s*enabled:\s*(true|false)/);
		if (commentsMatch) {
			postOptions.comments = {
				enabled: commentsMatch[1] === 'true'
			};
		}
		config.postOptions = postOptions;

		// Extract optional content types
		const optionalContentTypes: Record<string, unknown> = {};
		
		const projectsMatch = configContent.match(/\/\/ \[CONFIG:OPTIONAL_CONTENT_TYPES_PROJECTS\]\s*projects:\s*(true|false)/);
		if (projectsMatch) {
			optionalContentTypes.projects = projectsMatch[1] === 'true';
		}

		const docsMatch = configContent.match(/\/\/ \[CONFIG:OPTIONAL_CONTENT_TYPES_DOCS\]\s*docs:\s*(true|false)/);
		if (docsMatch) {
			optionalContentTypes.docs = docsMatch[1] === 'true';
		}
		config.optionalContentTypes = optionalContentTypes;

		// Extract footer settings
		const footer: Record<string, unknown> = {};

		const footerEnabledMatch = configContent.match(/\/\/ \[CONFIG:FOOTER_ENABLED\]\s*\n?\s*enabled:\s*(true|false)/);
		if (footerEnabledMatch) {
			footer.enabled = footerEnabledMatch[1] === 'true';
		}

		// footer.content: legacy template literal `...` or new LocalisedString { de: "...", en: "..." }.
		const footerContent = this.parseStringOrLocalised(configContent, 'CONFIG:FOOTER_CONTENT', 'content');
		if (footerContent !== undefined) footer.content = footerContent;

		const footerSocialMatch = configContent.match(/\/\/ \[CONFIG:FOOTER_SHOW_SOCIAL_ICONS\]\s*\n?\s*showSocialIconsInFooter:\s*(true|false)/);
		if (footerSocialMatch) {
			footer.showSocialIconsInFooter = footerSocialMatch[1] === 'true';
		}
		config.footer = footer;

		// Extract command palette
		const commandPalette: Record<string, unknown> = {};
		
		const commandPaletteMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_ENABLED\]\s*enabled:\s*(true|false)/);
		if (commandPaletteMatch) {
			commandPalette.enabled = commandPaletteMatch[1] === 'true';
		}
		
		const commandPalettePlaceholderMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_PLACEHOLDER\]\s*placeholder:\s*['"`]([^'"`]+)['"`]/);
		if (commandPalettePlaceholderMatch) {
			commandPalette.placeholder = commandPalettePlaceholderMatch[1];
		}
		
		const commandPaletteShortcutMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_SHORTCUT\]\s*shortcut:\s*['"`]([^'"`]+)['"`]/);
		if (commandPaletteShortcutMatch) {
			commandPalette.shortcut = commandPaletteShortcutMatch[1];
		}
		
		// Command palette search options
		const search: Record<string, unknown> = {};
		const searchPostsMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_SEARCH_POSTS\]\s*posts:\s*(true|false)/);
		if (searchPostsMatch) {
			search.posts = searchPostsMatch[1] === 'true';
		}
		
		const searchPagesMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_SEARCH_PAGES\]\s*pages:\s*(true|false)/);
		if (searchPagesMatch) {
			search.pages = searchPagesMatch[1] === 'true';
		}
		
		const searchProjectsMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_SEARCH_PROJECTS\]\s*projects:\s*(true|false)/);
		if (searchProjectsMatch) {
			search.projects = searchProjectsMatch[1] === 'true';
		}
		
		const searchDocsMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_SEARCH_DOCS\]\s*docs:\s*(true|false)/);
		if (searchDocsMatch) {
			search.docs = searchDocsMatch[1] === 'true';
		}
		commandPalette.search = search;
		
		// Command palette sections
		const sections: Record<string, unknown> = {};
		const sectionsQuickActionsMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_SECTIONS_QUICK_ACTIONS\]\s*quickActions:\s*(true|false)/);
		if (sectionsQuickActionsMatch) {
			sections.quickActions = sectionsQuickActionsMatch[1] === 'true';
		}
		
		const sectionsPagesMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_SECTIONS_PAGES\]\s*pages:\s*(true|false)/);
		if (sectionsPagesMatch) {
			sections.pages = sectionsPagesMatch[1] === 'true';
		}
		
		const sectionsSocialMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_SECTIONS_SOCIAL\]\s*social:\s*(true|false)/);
		if (sectionsSocialMatch) {
			sections.social = sectionsSocialMatch[1] === 'true';
		}
		commandPalette.sections = sections;
		
		// Command palette quick actions
		const quickActions: Record<string, unknown> = {};
		const qaEnabledMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_QUICK_ACTIONS_ENABLED\]\s*enabled:\s*(true|false)/);
		if (qaEnabledMatch) {
			quickActions.enabled = qaEnabledMatch[1] === 'true';
		}
		
		const qaToggleModeMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_QUICK_ACTIONS_TOGGLE_MODE\]\s*toggleMode:\s*(true|false)/);
		if (qaToggleModeMatch) {
			quickActions.toggleMode = qaToggleModeMatch[1] === 'true';
		}
		
		const qaGraphViewMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_QUICK_ACTIONS_GRAPH_VIEW\]\s*graphView:\s*(true|false)/);
		if (qaGraphViewMatch) {
			quickActions.graphView = qaGraphViewMatch[1] === 'true';
		}
		
		const qaChangeThemeMatch = configContent.match(/\/\/ \[CONFIG:COMMAND_PALETTE_QUICK_ACTIONS_CHANGE_THEME\]\s*changeTheme:\s*(true|false)/);
		if (qaChangeThemeMatch) {
			quickActions.changeTheme = qaChangeThemeMatch[1] === 'true';
		}
		commandPalette.quickActions = quickActions;
		config.commandPalette = commandPalette;

		// Extract site information
		const siteMatch = configContent.match(/\/\/ \[CONFIG:SITE_URL\]\s*site:\s*['"`]([^'"`]+)['"`]/);
		if (siteMatch) {
			config.site = siteMatch[1];
		}

		const titleMatch = configContent.match(/\/\/ \[CONFIG:SITE_TITLE\]\s*title:\s*['"`]([^'"`]+)['"`]/);
		if (titleMatch) {
			config.title = titleMatch[1];
		}

		const descriptionMatch = configContent.match(/\/\/ \[CONFIG:SITE_DESCRIPTION\]\s*description:\s*['"`]([^'"`]+)['"`]/);
		if (descriptionMatch) {
			config.description = descriptionMatch[1];
		}

		const authorMatch = configContent.match(/\/\/ \[CONFIG:SITE_AUTHOR\]\s*author:\s*['"`]([^'"`]+)['"`]/);
		if (authorMatch) {
			config.author = authorMatch[1];
		}

		const languageMatch = configContent.match(/\/\/ \[CONFIG:SITE_LANGUAGE\]\s*language:\s*['"`]([^'"`]+)['"`]/);
		if (languageMatch) {
			config.language = languageMatch[1];
		}

		return config;
	}
}
