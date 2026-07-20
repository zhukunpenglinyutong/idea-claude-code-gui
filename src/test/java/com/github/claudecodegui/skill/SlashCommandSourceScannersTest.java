package com.github.claudecodegui.skill;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class SlashCommandSourceScannersTest {

    @Test
    public void managedSkillScannerReadsConditionalSkillsFromManagedDirectory() throws IOException {
        Path root = Files.createTempDirectory("slash-command-managed-scanner");
        Path managedDir = Files.createDirectories(root.resolve("managed"));
        Path skillDir = Files.createDirectories(managedDir.resolve(".claude").resolve("skills").resolve("review-java"));
        Files.writeString(
                skillDir.resolve("SKILL.md"),
                """
                ---
                name: review-java
                description: Review Java files
                paths:
                  - src/**/*.java
                ---

                Review Java files carefully.
                """
        );

        List<SlashCommandRegistry.SlashCommand> matchingCommands = ManagedSkillScanner.scanManagedSkills(
                managedDir.toString(),
                root.resolve("src").resolve("main").resolve("Main.java").toString()
        );
        List<SlashCommandRegistry.SlashCommand> nonMatchingCommands = ManagedSkillScanner.scanManagedSkills(
                managedDir.toString(),
                root.resolve("README.md").toString()
        );

        assertEquals(1, matchingCommands.size());
        assertEquals("/review-java", matchingCommands.get(0).name());
        assertEquals(0, nonMatchingCommands.size());
    }

    @Test
    public void promptCommandScannerNamespacesPromptMarkdownFiles() throws IOException {
        Path promptsDir = Files.createTempDirectory("slash-command-prompts");
        Files.writeString(
                promptsDir.resolve("fix.md"),
                """
                ---
                description: Repair the selected code
                ---

                Prompt body.
                """
        );

        List<SlashCommandRegistry.SlashCommand> commands = PromptCommandScanner.scanPromptsAsCommands(
                promptsDir.toString()
        );

        assertEquals(1, commands.size());
        assertEquals("/prompts:fix", commands.get(0).name());
        assertEquals("Repair the selected code", commands.get(0).description());
        assertEquals("codex-prompt", commands.get(0).source());
    }

    @Test
    public void pluginCommandScannerDiscoversSafePluginPathsAndPrefixesCommands() throws IOException {
        Path root = Files.createTempDirectory("slash-command-plugin-scanner");
        Path home = Files.createDirectories(root.resolve("home"));
        Path userClaudeDir = Files.createDirectories(home.resolve(".claude"));
        Path pluginsBase = Files.createDirectories(userClaudeDir.resolve("plugins"));
        Path installDir = Files.createDirectories(root.resolve("plugin-install"));
        Path skillsDir = Files.createDirectories(installDir.resolve("skills").resolve("reviewer"));
        Path commandsDir = Files.createDirectories(installDir.resolve("commands"));
        Files.createDirectories(installDir.resolve(".claude-plugin"));

        Files.writeString(
                skillsDir.resolve("SKILL.md"),
                """
                ---
                name: reviewer
                description: Review plugin content
                ---

                Plugin skill.
                """
        );
        Files.writeString(
                commandsDir.resolve("audit.md"),
                """
                ---
                description: Audit the current workspace
                ---

                Command body.
                """
        );
        Files.writeString(
                userClaudeDir.resolve("settings.json"),
                """
                {
                  "enabledPlugins": {
                    "demo@market": true
                  }
                }
                """
        );
        Files.writeString(
                pluginsBase.resolve("installed_plugins.json"),
                """
                {
                  "plugins": {
                    "demo@market": [
                      {
                        "version": "1.0.0",
                        "installPath": "%s"
                      }
                    ]
                  }
                }
                """.formatted(installDir.toString().replace("\\", "\\\\"))
        );
        Files.writeString(
                installDir.resolve(".claude-plugin").resolve("plugin.json"),
                """
                {
                  "skillsPath": "skills",
                  "commandsPath": "commands"
                }
                """
        );

        List<SlashCommandRegistry.PluginPath> pluginPaths = PluginCommandScanner.getPluginPaths(
                root.resolve("workspace").toString(),
                home.toString()
        );
        List<SlashCommandRegistry.SlashCommand> pluginSkillCommands = PluginCommandScanner.scanPluginSkills(
                pluginPaths,
                null
        );
        List<SlashCommandRegistry.SlashCommand> pluginCommands = PluginCommandScanner.scanPluginCommands(
                pluginPaths
        );

        assertEquals(2, pluginPaths.size());
        assertEquals(1, pluginSkillCommands.size());
        assertEquals("/demo:reviewer", pluginSkillCommands.get(0).name());
        assertEquals("plugin:demo", pluginSkillCommands.get(0).source());
        assertEquals(1, pluginCommands.size());
        assertEquals("/demo:audit", pluginCommands.get(0).name());
        assertEquals("plugin:demo", pluginCommands.get(0).source());
    }

    @Test
    public void codexSkillScannerDiscoversNestedSkillDefinitionFiles() throws IOException {
        Path root = Files.createTempDirectory("codex-skill-nested-scanner");
        Path skillDir = Files.createDirectories(
                root.resolve("review").resolve("utility").resolve("agent-packaging-skill")
        );
        Path hiddenSkillDir = Files.createDirectories(
                root.resolve(".internal").resolve("hidden-skill")
        );
        Files.writeString(
                skillDir.resolve("SKILL.md"),
                """
                ---
                name: agent-packaging-skill
                description: Package a Codex agent skill
                userInvocable: true
                ---

                Package skills.
                """
        );
        Files.writeString(
                hiddenSkillDir.resolve("SKILL.md"),
                """
                ---
                name: hidden-skill
                description: Hidden skill
                ---
                """
        );

        JsonObject skills = CodexSkillService.scanSkillsDirectory(root.toString(), "user");

        assertEquals(1, skills.size());
        JsonObject skill = skills.entrySet().iterator().next().getValue().getAsJsonObject();
        assertEquals("agent-packaging-skill", skill.get("name").getAsString());
        assertEquals("Package a Codex agent skill", skill.get("description").getAsString());
        assertTrue(skill.get("userInvocable").getAsBoolean());
        assertEquals(skillDir.toString(), Path.of(skill.get("path").getAsString()).toString());
    }
}
