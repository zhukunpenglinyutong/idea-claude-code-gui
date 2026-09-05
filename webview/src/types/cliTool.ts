/**
 * Headless CLI tools shown under Settings → Provider Management → CLI.
 * Detection only — the plugin never auto-installs these binaries.
 */

export type CliToolId = 'grok' | 'kimi' | 'opencode' | 'pi' | 'dsh' | 'omp' | 'mimo';

export interface CliToolStatus {
  id: CliToolId;
  name: string;
  binaryName: string;
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export type CliStatusMap = Partial<Record<CliToolId, CliToolStatus>>;

export interface CliToolDefinition {
  id: CliToolId;
  /** i18n key for display name */
  nameKey: string;
  /** i18n key for short description */
  descriptionKey: string;
  /** Binary name users should find on PATH */
  binaryName: string;
  /** Docs / homepage URL */
  docsUrl: string;
  /** Primary install command (macOS / Linux) */
  installCommand: string;
  /** Optional Windows PowerShell install command */
  installCommandWindows?: string;
  /** Optional secondary install command (e.g. npm) */
  altInstallCommand?: string;
}

/**
 * Static catalog. Install commands match each CLI's official docs
 * and are shown in a dialog — never executed by the plugin.
 */
export const CLI_TOOL_DEFINITIONS: CliToolDefinition[] = [
  {
    id: 'grok',
    nameKey: 'settings.cli.tools.grok.name',
    descriptionKey: 'settings.cli.tools.grok.description',
    binaryName: 'grok',
    docsUrl: 'https://x.ai/cli',
    installCommand: 'curl -fsSL https://x.ai/cli/install.sh | bash',
  },
  {
    id: 'kimi',
    nameKey: 'settings.cli.tools.kimi.name',
    descriptionKey: 'settings.cli.tools.kimi.description',
    binaryName: 'kimi',
    docsUrl: 'https://github.com/MoonshotAI/kimi-code',
    installCommand: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    installCommandWindows: 'irm https://code.kimi.com/kimi-code/install.ps1 | iex',
    altInstallCommand: 'npm install -g @moonshot-ai/kimi-code',
  },
  {
    id: 'opencode',
    nameKey: 'settings.cli.tools.opencode.name',
    descriptionKey: 'settings.cli.tools.opencode.description',
    binaryName: 'opencode',
    docsUrl: 'https://opencode.ai/docs/',
    installCommand: 'curl -fsSL https://opencode.ai/install | bash',
    altInstallCommand: 'npm i -g opencode-ai',
  },
  {
    id: 'pi',
    nameKey: 'settings.cli.tools.pi.name',
    descriptionKey: 'settings.cli.tools.pi.description',
    binaryName: 'pi',
    docsUrl: 'https://pi.dev/',
    installCommand: 'curl -fsSL https://pi.dev/install.sh | sh',
    altInstallCommand: 'npm install -g @earendil-works/pi-coding-agent',
  },
  {
    id: 'dsh',
    nameKey: 'settings.cli.tools.dsh.name',
    descriptionKey: 'settings.cli.tools.dsh.description',
    binaryName: 'dsh',
    docsUrl: 'https://github.com/deepseek-ai/dsh',
    installCommand: 'npm i -g @deepseek-ai/dsh',
  },
  {
    id: 'omp',
    nameKey: 'settings.cli.tools.omp.name',
    descriptionKey: 'settings.cli.tools.omp.description',
    binaryName: 'omp',
    docsUrl: 'https://omp.sh/',
    installCommand: 'curl -fsSL https://omp.sh/install.sh | sh',
    altInstallCommand: 'npm install -g @oh-my-pi/pi-coding-agent',
  },
  {
    id: 'mimo',
    nameKey: 'settings.cli.tools.mimo.name',
    descriptionKey: 'settings.cli.tools.mimo.description',
    binaryName: 'mimo / mimocode',
    // npmjs.com is a Cloudflare-guarded SPA that renders blank inside the
    // IDE's JCEF browser; the npmmirror package page serves the same official
    // README server-side and is reachable in CN.
    docsUrl: 'https://www.npmmirror.com/package/@mimo-ai/cli',
    installCommand: 'npm install -g @mimo-ai/cli',
    installCommandWindows: 'npm install -g @mimo-ai/cli',
  },
];
