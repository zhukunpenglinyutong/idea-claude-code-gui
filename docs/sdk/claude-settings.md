# Claude Code settings

> Configure Claude Code with global and project-level settings, and environment variables.

Claude Code offers a variety of settings to configure its behavior to meet your needs. You can configure Claude Code by running the `/config` command when using the interactive REPL, which opens a tabbed Settings interface where you can view status information and modify configuration options.

## Configuration scopes

Claude Code uses a **scope system** to determine where configurations apply and who they're shared with. Understanding scopes helps you decide how to configure Claude Code for personal use, team collaboration, or enterprise deployment.

### Available scopes

| Scope          | Location                             | Who it affects                       | Shared with team?      |
| :------------- | :----------------------------------- | :----------------------------------- | :--------------------- |
| **Enterprise** | System-level `managed-settings.json` | All users on the machine             | Yes (deployed by IT)   |
| **User**       | `~/.claude/` directory               | You, across all projects             | No                     |
| **Project**    | `.claude/` in repository             | All collaborators on this repository | Yes (committed to git) |
| **Local**      | `.claude/*.local.*` files            | You, in this repository only         | No (gitignored)        |

### When to use each scope

**Enterprise scope** is for:

* Security policies that must be enforced organization-wide
* Compliance requirements that can't be overridden
* Standardized configurations deployed by IT/DevOps

**User scope** is best for:

* Personal preferences you want everywhere (themes, editor settings)
* Tools and plugins you use across all projects
* API keys and authentication (stored securely)

**Project scope** is best for:

* Team-shared settings (permissions, hooks, MCP servers)
* Plugins the whole team should have
* Standardizing tooling across collaborators

**Local scope** is best for:

* Personal overrides for a specific project
* Testing configurations before sharing with the team
* Machine-specific settings that won't work for others

### How scopes interact

When the same setting is configured in multiple scopes, more specific scopes take precedence:

1. **Enterprise** (highest) - can't be overridden by anything
2. **Command line arguments** - temporary session overrides
3. **Local** - overrides project and user settings
4. **Project** - overrides user settings
5. **User** (lowest) - applies when nothing else specifies the setting

For example, if a permission is allowed in user settings but denied in project settings, the project setting takes precedence and the permission is blocked.

### What uses scopes

Scopes apply to many Claude Code features:

| Feature         | User location             | Project location                   | Local location                 |
| :-------------- | :------------------------ | :--------------------------------- | :----------------------------- |
| **Settings**    | `~/.claude/settings.json` | `.claude/settings.json`            | `.claude/settings.local.json`  |
| **Subagents**   | `~/.claude/agents/`       | `.claude/agents/`                  | —                              |
| **MCP servers** | `~/.claude.json`          | `.mcp.json`                        | `~/.claude.json` (per-project) |
| **Plugins**     | `~/.claude/settings.json` | `.claude/settings.json`            | `.claude/settings.local.json`  |
| **CLAUDE.md**   | `~/.claude/CLAUDE.md`     | `CLAUDE.md` or `.claude/CLAUDE.md` | `CLAUDE.local.md`              |

***

## Settings files

The `settings.json` file is our official mechanism for configuring Claude
Code through hierarchical settings:

* **User settings** are defined in `~/.claude/settings.json` and apply to all
  projects.
* **Project settings** are saved in your project directory:
  * `.claude/settings.json` for settings that are checked into source control and shared with your team
  * `.claude/settings.local.json` for settings that are not checked in, useful for personal preferences and experimentation. Claude Code will configure git to ignore `.claude/settings.local.json` when it is created.
* **Managed settings** (Enterprise): Enterprise administrators can configure and distribute Claude Code settings to their organization through the [Claude.ai admin console](https://claude.ai/admin-settings/claude-code). These settings are fetched automatically when users authenticate, take precedence over user and project settings, and cannot be overridden locally. This feature is available to Claude for Enterprise customers. If you don't see this option in your admin console, contact your Anthropic account team to have the feature enabled.

  For organizations that prefer file-based policy distribution, Claude Code also supports `managed-settings.json` and `managed-mcp.json` files that can be deployed to system directories:

  * macOS: `/Library/Application Support/ClaudeCode/`
  * Linux and WSL: `/etc/claude-code/`
  * Windows: `C:\Program Files\ClaudeCode\`

  <Note>
    These are system-wide paths (not user home directories like `~/Library/...`) that require administrator privileges. They are designed to be deployed by IT administrators.
  </Note>

  See [Enterprise managed settings](/en/iam#enterprise-managed-settings) and [Enterprise MCP configuration](/en/mcp#enterprise-mcp-configuration) for details.

  <Note>
    Enterprise deployments can also restrict **plugin marketplace additions** using
    `strictKnownMarketplaces`. For more information, see [Enterprise marketplace restrictions](/en/plugin-marketplaces#enterprise-marketplace-restrictions).
  </Note>
* **Other configuration** is stored in `~/.claude.json`. This file contains your preferences (theme, notification settings, editor mode), OAuth session, [MCP server](/en/mcp) configurations for user and local scopes, per-project state (allowed tools, trust settings), and various caches. Project-scoped MCP servers are stored separately in `.mcp.json`.

```JSON Example settings.json theme={null}
{
  "permissions": {
    "allow": [
      "Bash(npm run lint)",
      "Bash(npm run test:*)",
      "Read(~/.zshrc)"
    ],
    "deny": [
      "Bash(curl:*)",
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)"
    ]
  },
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp"
  },
  "companyAnnouncements": [
    "Welcome to Acme Corp! Review our code guidelines at docs.acme.com",
    "Reminder: Code reviews required for all PRs",
    "New security policy in effect"
  ]
}
```

### Available settings

`settings.json` supports a number of options:

| Key                          | Description                                                                                                                                                                                                                                                                           | Example                                                                 |
| :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------- |
| `apiKeyHelper`               | Custom script, to be executed in `/bin/sh`, to generate an auth value. This value will be sent as `X-Api-Key` and `Authorization: Bearer` headers for model requests                                                                                                                  | `/bin/generate_temp_api_key.sh`                                         |
| `cleanupPeriodDays`          | Sessions inactive for longer than this period are deleted at startup. Setting to `0` immediately deletes all sessions. (default: 30 days)                                                                                                                                             | `20`                                                                    |
| `companyAnnouncements`       | Announcement to display to users at startup. If multiple announcements are provided, they will be cycled through at random.                                                                                                                                                           | `["Welcome to Acme Corp! Review our code guidelines at docs.acme.com"]` |
| `env`                        | Environment variables that will be applied to every session                                                                                                                                                                                                                           | `{"FOO": "bar"}`                                                        |
| `attribution`                | Customize attribution for git commits and pull requests. See [Attribution settings](#attribution-settings)                                                                                                                                                                            | `{"commit": "🤖 Generated with Claude Code", "pr": ""}`                 |
| `includeCoAuthoredBy`        | **Deprecated**: Use `attribution` instead. Whether to include the `co-authored-by Claude` byline in git commits and pull requests (default: `true`)                                                                                                                                   | `false`                                                                 |
| `permissions`                | See table below for structure of permissions.                                                                                                                                                                                                                                         |                                                                         |
| `hooks`                      | Configure custom commands to run before or after tool executions. See [hooks documentation](/en/hooks)                                                                                                                                                                                | `{"PreToolUse": {"Bash": "echo 'Running command...'"}}`                 |
| `disableAllHooks`            | Disable all [hooks](/en/hooks)                                                                                                                                                                                                                                                        | `true`                                                                  |
| `allowManagedHooksOnly`      | (Enterprise) Prevent loading of user, project, and plugin hooks. Only allows managed hooks and SDK hooks. See [Hook configuration](#hook-configuration)                                                                                                                               | `true`                                                                  |
| `model`                      | Override the default model to use for Claude Code                                                                                                                                                                                                                                     | `"claude-sonnet-4-5-20250929"`                                          |
| `otelHeadersHelper`          | Script to generate dynamic OpenTelemetry headers. Runs at startup and periodically (see [Dynamic headers](/en/monitoring-usage#dynamic-headers))                                                                                                                                      | `/bin/generate_otel_headers.sh`                                         |
| `statusLine`                 | Configure a custom status line to display context. See [`statusLine` documentation](/en/statusline)                                                                                                                                                                                   | `{"type": "command", "command": "~/.claude/statusline.sh"}`             |
| `fileSuggestion`             | Configure a custom script for `@` file autocomplete. See [File suggestion settings](#file-suggestion-settings)                                                                                                                                                                        | `{"type": "command", "command": "~/.claude/file-suggestion.sh"}`        |
| `outputStyle`                | Configure an output style to adjust the system prompt. See [output styles documentation](/en/output-styles)                                                                                                                                                                           | `"Explanatory"`                                                         |
| `forceLoginMethod`           | Use `claudeai` to restrict login to Claude.ai accounts, `console` to restrict login to Claude Console (API usage billing) accounts                                                                                                                                                    | `claudeai`                                                              |
| `forceLoginOrgUUID`          | Specify the UUID of an organization to automatically select it during login, bypassing the organization selection step. Requires `forceLoginMethod` to be set                                                                                                                         | `"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`                                |
| `enableAllProjectMcpServers` | Automatically approve all MCP servers defined in project `.mcp.json` files                                                                                                                                                                                                            | `true`                                                                  |
| `enabledMcpjsonServers`      | List of specific MCP servers from `.mcp.json` files to approve                                                                                                                                                                                                                        | `["memory", "github"]`                                                  |
| `disabledMcpjsonServers`     | List of specific MCP servers from `.mcp.json` files to reject                                                                                                                                                                                                                         | `["filesystem"]`                                                        |
| `allowedMcpServers`          | When set in managed-settings.json, allowlist of MCP servers users can configure. Undefined = no restrictions, empty array = lockdown. Applies to all scopes. Denylist takes precedence. See [Enterprise MCP configuration](/en/mcp#enterprise-mcp-configuration)                      | `[{ "serverName": "github" }]`                                          |
| `deniedMcpServers`           | When set in managed-settings.json, denylist of MCP servers that are explicitly blocked. Applies to all scopes including enterprise servers. Denylist takes precedence over allowlist. See [Enterprise MCP configuration](/en/mcp#enterprise-mcp-configuration)                        | `[{ "serverName": "filesystem" }]`                                      |
| `strictKnownMarketplaces`    | When set in managed-settings.json, allowlist of plugin marketplaces users can add. Undefined = no restrictions, empty array = lockdown. Applies to marketplace additions only. See [Enterprise marketplace restrictions](/en/plugin-marketplaces#enterprise-marketplace-restrictions) | `[{ "source": "github", "repo": "acme-corp/plugins" }]`                 |
| `awsAuthRefresh`             | Custom script that modifies the `.aws` directory (see [advanced credential configuration](/en/amazon-bedrock#advanced-credential-configuration))                                                                                                                                      | `aws sso login --profile myprofile`                                     |
| `awsCredentialExport`        | Custom script that outputs JSON with AWS credentials (see [advanced credential configuration](/en/amazon-bedrock#advanced-credential-configuration))                                                                                                                                  | `/bin/generate_aws_grant.sh`                                            |
| `alwaysThinkingEnabled`      | Enable [extended thinking](/en/common-workflows#use-extended-thinking) by default for all sessions. Typically configured via the `/config` command rather than editing directly                                                                                                       | `true`                                                                  |

### Permission settings

| Keys                           | Description                                                                                                                                                                                                                                                                                 | Example                                                                |
| :----------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------- |
| `allow`                        | Array of [permission rules](/en/iam#configuring-permissions) to allow tool use. **Note:** Bash rules use prefix matching, not regex                                                                                                                                                         | `[ "Bash(git diff:*)" ]`                                               |
| `ask`                          | Array of [permission rules](/en/iam#configuring-permissions) to ask for confirmation upon tool use.                                                                                                                                                                                         | `[ "Bash(git push:*)" ]`                                               |
| `deny`                         | Array of [permission rules](/en/iam#configuring-permissions) to deny tool use. Use this to also exclude sensitive files from Claude Code access. **Note:** Bash patterns are prefix matches and can be bypassed (see [Bash permission limitations](/en/iam#tool-specific-permission-rules)) | `[ "WebFetch", "Bash(curl:*)", "Read(./.env)", "Read(./secrets/**)" ]` |
| `additionalDirectories`        | Additional [working directories](/en/iam#working-directories) that Claude has access to                                                                                                                                                                                                     | `[ "../docs/" ]`                                                       |
| `defaultMode`                  | Default [permission mode](/en/iam#permission-modes) when opening Claude Code. Use `"auto"` for classifier-based approval; `"bypassPermissions"` remains the separate Full Auto mode.                                                                                                      | `"acceptEdits"`                                                        |
| `disableBypassPermissionsMode` | Set to `"disable"` to prevent `bypassPermissions` mode from being activated. This disables the `--dangerously-skip-permissions` command-line flag. See [managed settings](/en/iam#enterprise-managed-settings)                                                                              | `"disable"`                                                            |

### Sandbox settings

Configure advanced sandboxing behavior. Sandboxing isolates bash commands from your filesystem and network. See [Sandboxing](/en/sandboxing) for details.

**Filesystem and network restrictions** are configured via Read, Edit, and WebFetch permission rules, not via these sandbox settings.

| Keys                        | Description                                                                                                                                                                                                                                                                                                                       | Example                   |
| :-------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------ |
| `enabled`                   | Enable bash sandboxing (macOS/Linux only). Default: false                                                                                                                                                                                                                                                                         | `true`                    |
| `autoAllowBashIfSandboxed`  | Auto-approve bash commands when sandboxed. Default: true                                                                                                                                                                                                                                                                          | `true`                    |
| `excludedCommands`          | Commands that should run outside of the sandbox                                                                                                                                                                                                                                                                                   | `["git", "docker"]`       |
| `allowUnsandboxedCommands`  | Allow commands to run outside the sandbox via the `dangerouslyDisableSandbox` parameter. When set to `false`, the `dangerouslyDisableSandbox` escape hatch is completely disabled and all commands must run sandboxed (or be in `excludedCommands`). Useful for enterprise policies that require strict sandboxing. Default: true | `false`                   |
| `network.allowUnixSockets`  | Unix socket paths accessible in sandbox (for SSH agents, etc.)                                                                                                                                                                                                                                                                    | `["~/.ssh/agent-socket"]` |
| `network.allowLocalBinding` | Allow binding to localhost ports (macOS only). Default: false                                                                                                                                                                                                                                                                     | `true`                    |
| `network.httpProxyPort`     | HTTP proxy port used if you wish to bring your own proxy. If not specified, Claude will run its own proxy.                                                                                                                                                                                                                        | `8080`                    |
| `network.socksProxyPort`    | SOCKS5 proxy port used if you wish to bring your own proxy. If not specified, Claude will run its own proxy.                                                                                                                                                                                                                      | `8081`                    |
| `enableWeakerNestedSandbox` | Enable weaker sandbox for unprivileged Docker environments (Linux only). **Reduces security.** Default: false                                                                                                                                                                                                                     | `true`                    |

**Configuration example:**

```json  theme={null}
{
  "sandbox": {
    "enabled": true,
    "autoAllowBashIfSandboxed": true,
    "excludedCommands": ["docker"],
    "network": {
      "allowUnixSockets": [
        "/var/run/docker.sock"
      ],
      "allowLocalBinding": true
    }
  },
  "permissions": {
    "deny": [
      "Read(.envrc)",
      "Read(~/.aws/**)"
    ]
  }
}
```

**Filesystem and network restrictions** use standard permission rules:

* Use `Read` deny rules to block Claude from reading specific files or directories
* Use `Edit` allow rules to let Claude write to directories beyond the current working directory
* Use `Edit` deny rules to block writes to specific paths
* Use `WebFetch` allow/deny rules to control which network domains Claude can access

### Attribution settings

Claude Code adds attribution to git commits and pull requests. These are configured separately:

* Commits use [git trailers](https://git-scm.com/docs/git-interpret-trailers) (like `Co-Authored-By`) by default,  which can be customized or disabled
* Pull request descriptions are plain text

| Keys     | Description                                                                                |
| :------- | :----------------------------------------------------------------------------------------- |
| `commit` | Attribution for git commits, including any trailers. Empty string hides commit attribution |
| `pr`     | Attribution for pull request descriptions. Empty string hides pull request attribution     |

**Default commit attribution:**

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)

   Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
```

**Default pull request attribution:**

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Example:**

```json  theme={null}
{
  "attribution": {
    "commit": "Generated with AI\n\nCo-Authored-By: AI <ai@example.com>",
    "pr": ""
  }
}
```

<Note>
  The `attribution` setting takes precedence over the deprecated `includeCoAuthoredBy` setting. To hide all attribution, set `commit` and `pr` to empty strings.
</Note>

### File suggestion settings

Configure a custom command for `@` file path autocomplete. The built-in file suggestion uses fast filesystem traversal, but large monorepos may benefit from project-specific indexing such as a pre-built file index or custom tooling.

```json  theme={null}
{
  "fileSuggestion": {
    "type": "command",
    "command": "~/.claude/file-suggestion.sh"
  }
}
```

The command runs with the same environment variables as [hooks](/en/hooks), including `CLAUDE_PROJECT_DIR`. It receives JSON via stdin with a `query` field:

```json  theme={null}
{"query": "src/comp"}
```

Output newline-separated file paths to stdout (currently limited to 15):

```
src/components/Button.tsx
src/components/Modal.tsx
src/components/Form.tsx
```

**Example:**

```bash  theme={null}
#!/bin/bash
query=$(cat | jq -r '.query')
your-repo-file-index --query "$query" | head -20
```

### Hook configuration

**Enterprise-only setting**: Controls which hooks are allowed to run. This setting can only be configured in [managed settings](#settings-files) and provides enterprise administrators with strict control over hook execution.

**Behavior when `allowManagedHooksOnly` is `true`:**

* Managed hooks and SDK hooks are loaded
* User hooks, project hooks, and plugin hooks are blocked

**Configuration:**

```json  theme={null}
{
  "allowManagedHooksOnly": true
}
```

### Settings precedence

Settings apply in order of precedence. From highest to lowest:

1. **Managed settings** (Enterprise)
   * Remote settings configured via the [Claude.ai admin console](https://claude.ai/admin-settings/claude-code)
   * Fetched automatically when users authenticate
   * Cannot be overridden

2. **File-based managed settings** (`managed-settings.json`)
   * Policies deployed by IT/DevOps to system directories
   * Cannot be overridden by user or project settings
   * Ignored when remote managed settings are configured

3. **Command line arguments**
   * Temporary overrides for a specific session

4. **Local project settings** (`.claude/settings.local.json`)
   * Personal project-specific settings

5. **Shared project settings** (`.claude/settings.json`)
   * Team-shared project settings in source control

6. **User settings** (`~/.claude/settings.json`)
   * Personal global settings

This hierarchy ensures that enterprise security policies are always enforced while still allowing teams and individuals to customize their experience.

For example, if your user settings allow `Bash(npm run:*)` but a project's shared settings deny it, the project setting takes precedence and the command is blocked.

### Key points about the configuration system

* **Memory files (`CLAUDE.md`)**: Contain instructions and context that Claude loads at startup
* **Settings files (JSON)**: Configure permissions, environment variables, and tool behavior
* **Slash commands**: Custom commands that can be invoked during a session with `/command-name`
* **MCP servers**: Extend Claude Code with additional tools and integrations
* **Precedence**: Higher-level configurations (Enterprise) override lower-level ones (User/Project)
* **Inheritance**: Settings are merged, with more specific settings adding to or overriding broader ones

### System prompt

Claude Code's internal system prompt is not published. To add custom instructions, use `CLAUDE.md` files or the `--append-system-prompt` flag.

### Excluding sensitive files

To prevent Claude Code from accessing files containing sensitive information like API keys, secrets, and environment files, use the `permissions.deny` setting in your `.claude/settings.json` file:

```json  theme={null}
{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Read(./secrets/**)",
      "Read(./config/credentials.json)",
      "Read(./build)"
    ]
  }
}
```

This replaces the deprecated `ignorePatterns` configuration. Files matching these patterns will be completely invisible to Claude Code, preventing any accidental exposure of sensitive data.

## Subagent configuration

Claude Code supports custom AI subagents that can be configured at both user and project levels. These subagents are stored as Markdown files with YAML frontmatter:

* **User subagents**: `~/.claude/agents/` - Available across all your projects
* **Project subagents**: `.claude/agents/` - Specific to your project and can be shared with your team

Subagent files define specialized AI assistants with custom prompts and tool permissions. Learn more about creating and using subagents in the [subagents documentation](/en/sub-agents).

## Plugin configuration

Claude Code supports a plugin system that lets you extend functionality with custom commands, agents, hooks, and MCP servers. Plugins are distributed through marketplaces and can be configured at both user and repository levels.

### Plugin settings

Plugin-related settings in `settings.json`:

```json  theme={null}
{
  "enabledPlugins": {
    "formatter@acme-tools": true,
    "deployer@acme-tools": true,
    "analyzer@security-plugins": false
  },
  "extraKnownMarketplaces": {
    "acme-tools": {
      "source": "github",
      "repo": "acme-corp/claude-plugins"
    }
  }
}
```

#### `enabledPlugins`

Controls which plugins are enabled. Format: `"plugin-name@marketplace-name": true/false`

**Scopes**:

* **User settings** (`~/.claude/settings.json`): Personal plugin preferences
* **Project settings** (`.claude/settings.json`): Project-specific plugins shared with team
* **Local settings** (`.claude/settings.local.json`): Per-machine overrides (not committed)

**Example**:

```json  theme={null}
{
  "enabledPlugins": {
    "code-formatter@team-tools": true,
    "deployment-tools@team-tools": true,
    "experimental-features@personal": false
  }
}
```

#### `extraKnownMarketplaces`

Defines additional marketplaces that should be made available for the repository. Typically used in repository-level settings to ensure team members have access to required plugin sources.

**When a repository includes `extraKnownMarketplaces`**:

1. Team members are prompted to install the marketplace when they trust the folder
2. Team members are then prompted to install plugins from that marketplace
3. Users can skip unwanted marketplaces or plugins (stored in user settings)
4. Installation respects trust boundaries and requires explicit consent

**Example**:

```json  theme={null}
{
  "extraKnownMarketplaces": {
    "acme-tools": {
      "source": {
        "source": "github",
        "repo": "acme-corp/claude-plugins"
      }
    },
    "security-plugins": {
      "source": {
        "source": "git",
        "url": "https://git.example.com/security/plugins.git"
      }
    }
  }
}
```

**Marketplace source types**:

* `github`: GitHub repository (uses `repo`)
* `git`: Any git URL (uses `url`)
* `directory`: Local filesystem path (uses `path`, for development only)

#### `strictKnownMarketplaces`

**Enterprise-only setting**: Controls which plugin marketplaces users are allowed to add. This setting can only be configured in [`managed-settings.json`](/en/iam#enterprise-managed-settings) and provides enterprise administrators with strict control over marketplace sources.

**Managed settings file locations**:

* **macOS**: `/Library/Application Support/ClaudeCode/managed-settings.json`
* **Linux and WSL**: `/etc/claude-code/managed-settings.json`
* **Windows**: `C:\ProgramData\ClaudeCode\managed-settings.json`

**Key characteristics**:

* Only available in enterprise managed settings (`managed-settings.json`)
* Cannot be overridden by user or project settings (highest precedence)
* Enforced BEFORE network/filesystem operations (blocked sources never execute)
* Uses exact matching for source specifications (including `ref`, `path` for git sources)

**Allowlist behavior**:

* `undefined` (default): No restrictions - users can add any marketplace
* Empty array `[]`: Complete lockdown - users cannot add any new marketplaces
* List of sources: Users can only add marketplaces that match exactly

**All supported source types**:

The allowlist supports six marketplace source types. Each source must match exactly for a user's marketplace addition to be allowed.

1. **GitHub repositories**:

```json  theme={null}
{ "source": "github", "repo": "acme-corp/approved-plugins" }
{ "source": "github", "repo": "acme-corp/security-tools", "ref": "v2.0" }
{ "source": "github", "repo": "acme-corp/plugins", "ref": "main", "path": "marketplace" }
```

Fields: `repo` (required), `ref` (optional: branch/tag/SHA), `path` (optional: subdirectory)

2. **Git repositories**:

```json  theme={null}
{ "source": "git", "url": "https://gitlab.example.com/tools/plugins.git" }
{ "source": "git", "url": "https://bitbucket.org/acme-corp/plugins.git", "ref": "production" }
{ "source": "git", "url": "ssh://git@git.example.com/plugins.git", "ref": "v3.1", "path": "approved" }
```

Fields: `url` (required), `ref` (optional: branch/tag/SHA), `path` (optional: subdirectory)

3. **URL-based marketplaces**:

```json  theme={null}
{ "source": "url", "url": "https://plugins.example.com/marketplace.json" }
{ "source": "url", "url": "https://cdn.example.com/marketplace.json", "headers": { "Authorization": "Bearer ${TOKEN}" } }
```

Fields: `url` (required), `headers` (optional: HTTP headers for authenticated access)

4. **NPM packages**:

```json  theme={null}
{ "source": "npm", "package": "@acme-corp/claude-plugins" }
{ "source": "npm", "package": "@acme-corp/approved-marketplace" }
```

Fields: `package` (required, supports scoped packages)

5. **File paths**:

```json  theme={null}
{ "source": "file", "path": "/usr/local/share/claude/acme-marketplace.json" }
{ "source": "file", "path": "/opt/acme-corp/plugins/marketplace.json" }
```

Fields: `path` (required: absolute path to marketplace.json file)

6. **Directory paths**:

```json  theme={null}
{ "source": "directory", "path": "/usr/local/share/claude/acme-plugins" }
{ "source": "directory", "path": "/opt/acme-corp/approved-marketplaces" }
```

Fields: `path` (required: absolute path to directory containing `.claude-plugin/marketplace.json`)

**Configuration examples**:

Example - Allow specific marketplaces only:

```json  theme={null}
{
  "strictKnownMarketplaces": [
    {
      "source": "github",
      "repo": "acme-corp/approved-plugins"
    },
    {
      "source": "github",
      "repo": "acme-corp/security-tools",
      "ref": "v2.0"
    },
    {
      "source": "url",
      "url": "https://plugins.example.com/marketplace.json"
    },
    {
      "source": "npm",
      "package": "@acme-corp/compliance-plugins"
    }
  ]
}
```

Example - Disable all marketplace additions:

```json  theme={null}
{
  "strictKnownMarketplaces": []
}
```

**Exact matching requirements**:

Marketplace sources must match **exactly** for a user's addition to be allowed. For git-based sources (`github` and `git`), this includes all optional fields:

* The `repo` or `url` must match exactly
* The `ref` field must match exactly (or both be undefined)
* The `path` field must match exactly (or both be undefined)

Examples of sources that **do NOT match**:

```json  theme={null}
// These are DIFFERENT sources:
{ "source": "github", "repo": "acme-corp/plugins" }
{ "source": "github", "repo": "acme-corp/plugins", "ref": "main" }

// These are also DIFFERENT:
{ "source": "github", "repo": "acme-corp/plugins", "path": "marketplace" }
{ "source": "github", "repo": "acme-corp/plugins" }
```

**Comparison with `extraKnownMarketplaces`**:

| Aspect                | `strictKnownMarketplaces`            | `extraKnownMarketplaces`             |
| --------------------- | ------------------------------------ | ------------------------------------ |
| **Purpose**           | Enterprise policy enforcement        | Team convenience                     |
| **Settings file**     | `managed-settings.json` only         | Any settings file                    |
| **Behavior**          | Blocks non-allowlisted additions     | Auto-installs missing marketplaces   |
| **When enforced**     | Before network/filesystem operations | After user trust prompt              |
| **Can be overridden** | No (highest precedence)              | Yes (by higher precedence settings)  |
| **Source format**     | Direct source object                 | Named marketplace with nested source |
| **Use case**          | Compliance, security restrictions    | Onboarding, standardization          |

**Format difference**:

`strictKnownMarketplaces` uses direct source objects:

```json  theme={null}
{
  "strictKnownMarketplaces": [
    { "source": "github", "repo": "acme-corp/plugins" }
  ]
}
```

`extraKnownMarketplaces` requires named marketplaces:

```json  theme={null}
{
  "extraKnownMarketplaces": {
    "acme-tools": {
      "source": { "source": "github", "repo": "acme-corp/plugins" }
    }
  }
}
```

**Important notes**:

* Restrictions are checked BEFORE any network requests or filesystem operations
* When blocked, users see clear error messages indicating the source is blocked by enterprise policy
* The restriction applies only to adding NEW marketplaces; previously installed marketplaces remain accessible
* Enterprise managed settings have the highest precedence and cannot be overridden

See [Enterprise marketplace restrictions](/en/plugin-marketplaces#enterprise-marketplace-restrictions) for user-facing documentation.

### Managing plugins

Use the `/plugin` command to manage plugins interactively:

* Browse available plugins from marketplaces
* Install/uninstall plugins
* Enable/disable plugins
* View plugin details (commands, agents, hooks provided)
* Add/remove marketplaces

Learn more about the plugin system in the [plugins documentation](/en/plugins).

## Environment variables

Claude Code supports the following environment variables to control its behavior:

<Note>
  All environment variables can also be configured in [`settings.json`](#available-settings). This is useful as a way to automatically set environment variables for each session, or to roll out a set of environment variables for your whole team or organization.
</Note>

| Variable                                      | Purpose                                                                                                                                                                                                                                                                                                                                                                                      |
| :-------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                           | API key sent as `X-Api-Key` header, typically for the Claude SDK (for interactive usage, run `/login`)                                                                                                                                                                                                                                                                                       |
| `ANTHROPIC_AUTH_TOKEN`                        | Custom value for the `Authorization` header (the value you set here will be prefixed with `Bearer `)                                                                                                                                                                                                                                                                                         |
| `ANTHROPIC_CUSTOM_HEADERS`                    | Custom headers you want to add to the request (in `Name: Value` format)                                                                                                                                                                                                                                                                                                                      |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL`               | See [Model configuration](/en/model-config#environment-variables)                                                                                                                                                                                                                                                                                                                            |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`                | See [Model configuration](/en/model-config#environment-variables)                                                                                                                                                                                                                                                                                                                            |
| `ANTHROPIC_DEFAULT_SONNET_MODEL`              | See [Model configuration](/en/model-config#environment-variables)                                                                                                                                                                                                                                                                                                                            |
| `ANTHROPIC_FOUNDRY_API_KEY`                   | API key for Microsoft Foundry authentication (see [Microsoft Foundry](/en/microsoft-foundry))                                                                                                                                                                                                                                                                                                |
| `ANTHROPIC_MODEL`                             | Name of the model setting to use (see [Model Configuration](/en/model-config#environment-variables))                                                                                                                                                                                                                                                                                         |
| `ANTHROPIC_SMALL_FAST_MODEL`                  | \[DEPRECATED] Name of [Haiku-class model for background tasks](/en/costs)                                                                                                                                                                                                                                                                                                                    |
| `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION`       | Override AWS region for the Haiku-class model when using Bedrock                                                                                                                                                                                                                                                                                                                             |
| `AWS_BEARER_TOKEN_BEDROCK`                    | Bedrock API key for authentication (see [Bedrock API keys](https://aws.amazon.com/blogs/machine-learning/accelerate-ai-development-with-amazon-bedrock-api-keys/))                                                                                                                                                                                                                           |
| `BASH_DEFAULT_TIMEOUT_MS`                     | Default timeout for long-running bash commands                                                                                                                                                                                                                                                                                                                                               |
| `BASH_MAX_OUTPUT_LENGTH`                      | Maximum number of characters in bash outputs before they are middle-truncated                                                                                                                                                                                                                                                                                                                |
| `BASH_MAX_TIMEOUT_MS`                         | Maximum timeout the model can set for long-running bash commands                                                                                                                                                                                                                                                                                                                             |
| `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR`    | Return to the original working directory after each Bash command                                                                                                                                                                                                                                                                                                                             |
| `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`           | Interval in milliseconds at which credentials should be refreshed (when using `apiKeyHelper`)                                                                                                                                                                                                                                                                                                |
| `CLAUDE_CODE_CLIENT_CERT`                     | Path to client certificate file for mTLS authentication                                                                                                                                                                                                                                                                                                                                      |
| `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`           | Passphrase for encrypted CLAUDE\_CODE\_CLIENT\_KEY (optional)                                                                                                                                                                                                                                                                                                                                |
| `CLAUDE_CODE_CLIENT_KEY`                      | Path to client private key file for mTLS authentication                                                                                                                                                                                                                                                                                                                                      |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`      | Set to `1` to disable Anthropic API-specific `anthropic-beta` headers. Use this if experiencing issues like "Unexpected value(s) for the `anthropic-beta` header" when using an LLM gateway with third-party providers                                                                                                                                                                       |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`    | Equivalent of setting `DISABLE_AUTOUPDATER`, `DISABLE_BUG_COMMAND`, `DISABLE_ERROR_REPORTING`, and `DISABLE_TELEMETRY`                                                                                                                                                                                                                                                                       |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`          | Set to `1` to disable automatic terminal title updates based on conversation context                                                                                                                                                                                                                                                                                                         |
| `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL`           | Skip auto-installation of IDE extensions                                                                                                                                                                                                                                                                                                                                                     |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS`               | Set the maximum number of output tokens for most requests                                                                                                                                                                                                                                                                                                                                    |
| `CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS` | Interval for refreshing dynamic OpenTelemetry headers in milliseconds (default: 1740000 / 29 minutes). See [Dynamic headers](/en/monitoring-usage#dynamic-headers)                                                                                                                                                                                                                           |
| `CLAUDE_CODE_SHELL_PREFIX`                    | Command prefix to wrap all bash commands (for example, for logging or auditing). Example: `/path/to/logger.sh` will execute `/path/to/logger.sh <command>`                                                                                                                                                                                                                                   |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH`               | Skip AWS authentication for Bedrock (for example, when using an LLM gateway)                                                                                                                                                                                                                                                                                                                 |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH`               | Skip Azure authentication for Microsoft Foundry (for example, when using an LLM gateway)                                                                                                                                                                                                                                                                                                     |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH`                | Skip Google authentication for Vertex (for example, when using an LLM gateway)                                                                                                                                                                                                                                                                                                               |
| `CLAUDE_CODE_SUBAGENT_MODEL`                  | See [Model configuration](/en/model-config)                                                                                                                                                                                                                                                                                                                                                  |
| `CLAUDE_CODE_USE_BEDROCK`                     | Use [Bedrock](/en/amazon-bedrock)                                                                                                                                                                                                                                                                                                                                                            |
| `CLAUDE_CODE_USE_FOUNDRY`                     | Use [Microsoft Foundry](/en/microsoft-foundry)                                                                                                                                                                                                                                                                                                                                               |
| `CLAUDE_CODE_USE_VERTEX`                      | Use [Vertex](/en/google-vertex-ai)                                                                                                                                                                                                                                                                                                                                                           |
| `CLAUDE_CONFIG_DIR`                           | Customize where Claude Code stores its configuration and data files                                                                                                                                                                                                                                                                                                                          |
| `DISABLE_AUTOUPDATER`                         | Set to `1` to disable automatic updates.                                                                                                                                                                                                                                                                                                                                                     |
| `DISABLE_BUG_COMMAND`                         | Set to `1` to disable the `/bug` command                                                                                                                                                                                                                                                                                                                                                     |
| `DISABLE_COST_WARNINGS`                       | Set to `1` to disable cost warning messages                                                                                                                                                                                                                                                                                                                                                  |
| `DISABLE_ERROR_REPORTING`                     | Set to `1` to opt out of Sentry error reporting                                                                                                                                                                                                                                                                                                                                              |
| `DISABLE_NON_ESSENTIAL_MODEL_CALLS`           | Set to `1` to disable model calls for non-critical paths like flavor text                                                                                                                                                                                                                                                                                                                    |
| `DISABLE_PROMPT_CACHING`                      | Set to `1` to disable prompt caching for all models (takes precedence over per-model settings)                                                                                                                                                                                                                                                                                               |
| `DISABLE_PROMPT_CACHING_HAIKU`                | Set to `1` to disable prompt caching for Haiku models                                                                                                                                                                                                                                                                                                                                        |
| `DISABLE_PROMPT_CACHING_OPUS`                 | Set to `1` to disable prompt caching for Opus models                                                                                                                                                                                                                                                                                                                                         |
| `DISABLE_PROMPT_CACHING_SONNET`               | Set to `1` to disable prompt caching for Sonnet models                                                                                                                                                                                                                                                                                                                                       |
| `DISABLE_TELEMETRY`                           | Set to `1` to opt out of Statsig telemetry (note that Statsig events do not include user data like code, file paths, or bash commands)                                                                                                                                                                                                                                                       |
| `HTTP_PROXY`                                  | Specify HTTP proxy server for network connections                                                                                                                                                                                                                                                                                                                                            |
| `HTTPS_PROXY`                                 | Specify HTTPS proxy server for network connections                                                                                                                                                                                                                                                                                                                                           |
| `MAX_MCP_OUTPUT_TOKENS`                       | Maximum number of tokens allowed in MCP tool responses. Claude Code displays a warning when output exceeds 10,000 tokens (default: 25000)                                                                                                                                                                                                                                                    |
| `MAX_THINKING_TOKENS`                         | Enable [extended thinking](https://docs.claude.com/en/docs/build-with-claude/extended-thinking) and set the token budget for the thinking process. Extended thinking improves performance on complex reasoning and coding tasks but impacts [prompt caching efficiency](https://docs.claude.com/en/docs/build-with-claude/prompt-caching#caching-with-thinking-blocks). Disabled by default. |
| `MCP_TIMEOUT`                                 | Timeout in milliseconds for MCP server startup                                                                                                                                                                                                                                                                                                                                               |
| `MCP_TOOL_TIMEOUT`                            | Timeout in milliseconds for MCP tool execution                                                                                                                                                                                                                                                                                                                                               |
| `NO_PROXY`                                    | List of domains and IPs to which requests will be directly issued, bypassing proxy                                                                                                                                                                                                                                                                                                           |
| `SLASH_COMMAND_TOOL_CHAR_BUDGET`              | Maximum number of characters for slash command metadata shown to [SlashCommand tool](/en/slash-commands#slashcommand-tool) (default: 15000)                                                                                                                                                                                                                                                  |
| `USE_BUILTIN_RIPGREP`                         | Set to `0` to use system-installed `rg` instead of `rg` included with Claude Code                                                                                                                                                                                                                                                                                                            |
| `VERTEX_REGION_CLAUDE_3_5_HAIKU`              | Override region for Claude 3.5 Haiku when using Vertex AI                                                                                                                                                                                                                                                                                                                                    |
| `VERTEX_REGION_CLAUDE_3_7_SONNET`             | Override region for Claude 3.7 Sonnet when using Vertex AI                                                                                                                                                                                                                                                                                                                                   |
| `VERTEX_REGION_CLAUDE_4_0_OPUS`               | Override region for Claude 4.0 Opus when using Vertex AI                                                                                                                                                                                                                                                                                                                                     |
| `VERTEX_REGION_CLAUDE_4_0_SONNET`             | Override region for Claude 4.0 Sonnet when using Vertex AI                                                                                                                                                                                                                                                                                                                                   |
| `VERTEX_REGION_CLAUDE_4_1_OPUS`               | Override region for Claude 4.1 Opus when using Vertex AI                                                                                                                                                                                                                                                                                                                                     |

## Tools available to Claude

Claude Code has access to a set of powerful tools that help it understand and modify your codebase:

| Tool                | Description                                                                                       | Permission Required |
| :------------------ | :------------------------------------------------------------------------------------------------ | :------------------ |
| **AskUserQuestion** | Asks the user multiple choice questions to gather information or clarify ambiguity                | No                  |
| **Bash**            | Executes shell commands in your environment (see [Bash tool behavior](#bash-tool-behavior) below) | Yes                 |
| **BashOutput**      | Retrieves output from a background bash shell                                                     | No                  |
| **Edit**            | Makes targeted edits to specific files                                                            | Yes                 |
| **ExitPlanMode**    | Prompts the user to exit plan mode and start coding                                               | Yes                 |
| **Glob**            | Finds files based on pattern matching                                                             | No                  |
| **Grep**            | Searches for patterns in file contents                                                            | No                  |
| **KillShell**       | Kills a running background bash shell by its ID                                                   | No                  |
| **NotebookEdit**    | Modifies Jupyter notebook cells                                                                   | Yes                 |
| **Read**            | Reads the contents of files                                                                       | No                  |
| **Skill**           | Executes a skill within the main conversation                                                     | Yes                 |
| **SlashCommand**    | Runs a [custom slash command](/en/slash-commands#slashcommand-tool)                               | Yes                 |
| **Task**            | Runs a sub-agent to handle complex, multi-step tasks                                              | No                  |
| **TodoWrite**       | Creates and manages structured task lists                                                         | No                  |
| **WebFetch**        | Fetches content from a specified URL                                                              | Yes                 |
| **WebSearch**       | Performs web searches with domain filtering                                                       | Yes                 |
| **Write**           | Creates or overwrites files                                                                       | Yes                 |

Permission rules can be configured using `/allowed-tools` or in [permission settings](/en/settings#available-settings). Also see [Tool-specific permission rules](/en/iam#tool-specific-permission-rules).

### Bash tool behavior

The Bash tool executes shell commands with the following persistence behavior:

* **Working directory persists**: When Claude changes the working directory (for example, `cd /path/to/dir`), subsequent Bash commands will execute in that directory. You can use `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1` to reset to the project directory after each command.
* **Environment variables do NOT persist**: Environment variables set in one Bash command (for example, `export MY_VAR=value`) are **not** available in subsequent Bash commands. Each Bash command runs in a fresh shell environment.

To make environment variables available in Bash commands, you have **three options**:

**Option 1: Activate environment before starting Claude Code** (simplest approach)

Activate your virtual environment in your terminal before launching Claude Code:

```bash  theme={null}
conda activate myenv
# or: source /path/to/venv/bin/activate
claude
```

This works for shell environments but environment variables set within Claude's Bash commands will not persist between commands.

**Option 2: Set CLAUDE\_ENV\_FILE before starting Claude Code** (persistent environment setup)

Export the path to a shell script containing your environment setup:

```bash  theme={null}
export CLAUDE_ENV_FILE=/path/to/env-setup.sh
claude
```

Where `/path/to/env-setup.sh` contains:

```bash  theme={null}
conda activate myenv
# or: source /path/to/venv/bin/activate
# or: export MY_VAR=value
```

Claude Code will source this file before each Bash command, making the environment persistent across all commands.

**Option 3: Use a SessionStart hook** (project-specific configuration)

Configure in `.claude/settings.json`:

```json  theme={null}
{
  "hooks": {
    "SessionStart": [{
      "matcher": "startup",
      "hooks": [{
        "type": "command",
        "command": "echo 'conda activate myenv' >> \"$CLAUDE_ENV_FILE\""
      }]
    }]
  }
}
```

The hook writes to `$CLAUDE_ENV_FILE`, which is then sourced before each Bash command. This is ideal for team-shared project configurations.

See [SessionStart hooks](/en/hooks#persisting-environment-variables) for more details on Option 3.

### Extending tools with hooks

You can run custom commands before or after any tool executes using
[Claude Code hooks](/en/hooks-guide).

For example, you could automatically run a Python formatter after Claude
modifies Python files, or prevent modifications to production configuration
files by blocking Write operations to certain paths.

## See also

* [Identity and Access Management](/en/iam#configuring-permissions) - Learn about Claude Code's permission system
* [IAM and access control](/en/iam#enterprise-managed-settings) - Enterprise policy management
* [Troubleshooting](/en/troubleshooting#auto-updater-issues) - Solutions for common configuration issues


---

> To find navigation and other pages in this documentation, fetch the llms.txt file at: https://code.claude.com/docs/llms.txt