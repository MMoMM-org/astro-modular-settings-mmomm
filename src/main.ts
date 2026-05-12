import { Plugin } from 'obsidian';
import { AstroModularSettings, DEFAULT_SETTINGS } from './settings';
import { registerCommands } from './commands';
import { AstroModularSettingsTab } from './ui/SettingsTab';
import { ConfigManager } from './utils/ConfigManager';
import { ConfigFileManager } from './utils/config/ConfigFileManager';
import { PluginManager } from './utils/PluginManager';
import { RibbonIconManager } from './utils/RibbonIconManager';
import { ObsidianApp, NavigationItem, LocalisedString } from './types';

export default class AstroModularSettingsPlugin extends Plugin {
	settings!: AstroModularSettings;
	private settingsTab!: AstroModularSettingsTab;
	private startupTimeoutId?: number;
	configManager!: ConfigManager;
	pluginManager!: PluginManager;
	private ribbonManager!: RibbonIconManager;

	async onload() {
		await this.loadSettings();

		// Initialize managers
		this.configManager = new ConfigManager(this.app);
		this.pluginManager = new PluginManager(this.app, () => this.settings.contentOrganization);

		// Register commands
		registerCommands(this);

		// Add settings tab
		this.settingsTab = new AstroModularSettingsTab(this.app, this);
		this.addSettingTab(this.settingsTab);

		// Initialize ribbon icon manager
		this.ribbonManager = new RibbonIconManager(this, async () => {
			await this.loadSettings();
			await this.openWizard();
		});
		this.ribbonManager.update(this.settings.removeRibbonIcon);

		// Check if we should run the wizard on startup
		if (this.settings.runWizardOnStartup) {
			// Delay the wizard to let Obsidian fully load
			this.startupTimeoutId = window.setTimeout(() => {
				void (async () => {
					await this.loadSettings();
					if (this.settings.runWizardOnStartup) {
						await this.openWizard();
					}
				})();
			}, 2000);
		}

		// No welcome notice needed - modal is the intro
	}

	onunload() {
		// Clear startup timeout if it exists
		if (this.startupTimeoutId) {
			window.clearTimeout(this.startupTimeoutId);
			this.startupTimeoutId = undefined;
		}

		// Cleanup ribbon icon manager
		this.ribbonManager?.destroy();

		// Other cleanup is handled automatically by Obsidian
	}

	async loadSettings() {
		const data = await this.loadData() as Partial<AstroModularSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

		// Source-of-truth overlay (ADR-005 Phase 3): config.ts is authoritative
		// for nav.pages / nav.footer (which may carry i18nKey / urlByLocale /
		// external / unknown future fields the plugin UI doesn't model), for
		// locales / defaultLocale, and for LocalisedString site-info / footer
		// values. data.json caches the rest of the settings.
		//
		// Without this overlay, a stale data.json (e.g. synced before the user
		// added i18nKey/urlByLocale in config.ts) would propagate stripped
		// nav arrays back to config.ts on the next save — silently nuking the
		// user-authored fields.
		try {
			const fileManager = new ConfigFileManager(this.app);
			const parsed = fileManager.parseConfigFile();
			if (parsed) {
				this.overlayConfigSourceFields(parsed);
			}
		} catch (e) {
			console.error('[astro-modular-settings] config.ts source-of-truth overlay failed:', e);
		}
	}

	/**
	 * Merge config.ts-authoritative fields into `this.settings`. Called after
	 * data.json is loaded so config.ts values win for round-trip-sensitive
	 * fields. Quietly skips when config.ts can't be parsed.
	 */
	private overlayConfigSourceFields(parsed: Record<string, unknown>): void {
		const parsedNav = parsed.navigation as Record<string, unknown> | undefined;
		if (parsedNav) {
			if (Array.isArray(parsedNav.pages) && parsedNav.pages.length > 0) {
				this.settings.navigation.pages = parsedNav.pages as NavigationItem[];
			}
			if (Array.isArray(parsedNav.footer)) {
				this.settings.navigation.footer = parsedNav.footer as NavigationItem[];
			}
		}

		const parsedSite = parsed.siteInfo as Record<string, unknown> | undefined;
		if (parsedSite) {
			// LocalisedString fields: config.ts wins when shape is object (the
			// shape data.json cannot represent without UI support — which is
			// exactly the state we want to protect).
			const localisableFields: Array<'title' | 'description' | 'homepageTitle' | 'defaultOgImageAlt'> =
				['title', 'description', 'homepageTitle', 'defaultOgImageAlt'];
			for (const field of localisableFields) {
				const v = parsedSite[field];
				if (v && typeof v === 'object' && !Array.isArray(v)) {
					(this.settings.siteInfo as unknown as Record<string, unknown>)[field] = v as LocalisedString;
				}
			}
			if (Array.isArray(parsedSite.locales)) {
				this.settings.siteInfo.locales = parsedSite.locales as string[];
			}
			if (typeof parsedSite.defaultLocale === 'string') {
				this.settings.siteInfo.defaultLocale = parsedSite.defaultLocale;
			}
		}

		const parsedFooter = parsed.footer as Record<string, unknown> | undefined;
		if (parsedFooter && 'content' in parsedFooter) {
			const c = parsedFooter.content;
			if (c && typeof c === 'object' && !Array.isArray(c)) {
				this.settings.footer.content = c as LocalisedString;
			}
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}


	// Public method to open settings (called by commands)
	openSettings() {
		// This will be handled by the settings tab
		// The settings tab is already registered, so we just need to focus it
		(this.app as unknown as ObsidianApp).setting.open();
		(this.app as unknown as ObsidianApp).setting.openTabById(this.manifest.id);
	}

	// Method to trigger settings refresh
	async triggerSettingsRefresh() {
		// Force the settings tab to re-render with updated settings
		// First reload settings from disk to ensure we have the latest values
		await this.loadSettings();

		if (this.settingsTab) {
			// Re-render the settings tab with updated settings
			this.settingsTab.display();
		}
	}

	// Method to update ribbon icon based on settings
	public async updateRibbonIcon() {
		await this.loadSettings();
		this.ribbonManager.update(this.settings.removeRibbonIcon);
	}

	// Lazy-load and open the setup wizard
	async openWizard() {
		const { SetupWizardModal } = await import('./ui/SetupWizardModal');
		const wizard = new SetupWizardModal(this.app, this);
		wizard.open();
	}
}