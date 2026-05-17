use std::collections::HashMap;

pub struct PluginMetadata {
    pub package_name: &'static str,
    pub alias: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub category: &'static str,
}

pub fn get_curated_metadata() -> HashMap<&'static str, PluginMetadata> {
    let mut map = HashMap::new();

    map.insert(
        "@capybearista/opencode-ram-monitor",
        PluginMetadata {
            package_name: "@capybearista/opencode-ram-monitor",
            alias: "ram-monitor",
            display_name: "RAM Monitor",
            description: "Monitor OpenCode's RAM usage per session in real time.",
            category: "TUI",
        },
    );

    map.insert(
        "@capybearista/opencode-output-styles",
        PluginMetadata {
            package_name: "@capybearista/opencode-output-styles",
            alias: "output-styles",
            display_name: "Output Styles",
            description: "Persist reusable response styles for OpenCode sessions.",
            category: "Prompting",
        },
    );

    map.insert(
        "@capybearista/opencode-agents-loader",
        PluginMetadata {
            package_name: "@capybearista/opencode-agents-loader",
            alias: "agents-loader",
            display_name: "Agents Loader",
            description: "Load custom agents and commands from local directories.",
            category: "Agents",
        },
    );

    map.insert(
        "@capybearista/opencode-adversarial-review",
        PluginMetadata {
            package_name: "@capybearista/opencode-adversarial-review",
            alias: "adversarial-review",
            display_name: "Adversarial Review",
            description: "Adversarial code review subagent to break confidence.",
            category: "Review",
        },
    );

    map.insert(
        "@capybearista/opencode-agent-prompt-inheritance",
        PluginMetadata {
            package_name: "@capybearista/opencode-agent-prompt-inheritance",
            alias: "agent-prompt-inheritance",
            display_name: "Prompt Inheritance",
            description:
                "Preserves provider system prompts when custom agents inject instructions.",
            category: "Prompting",
        },
    );

    map.insert(
        "@capybearista/opencode-double-tap-timeline",
        PluginMetadata {
            package_name: "@capybearista/opencode-double-tap-timeline",
            alias: "double-tap-timeline",
            display_name: "Double Tap Timeline",
            description: "Double-tap Escape to open session timeline modal.",
            category: "TUI",
        },
    );

    map
}

pub fn resolve_alias(input: &str) -> String {
    let metadata = get_curated_metadata();
    for (_, meta) in metadata.iter() {
        if meta.alias == input {
            return meta.package_name.to_string();
        }
    }
    input.to_string()
}
