use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct PluginMetadata {
    pub package_name: &'static str,
    pub alias: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    #[allow(dead_code)]
    pub category: &'static str,
    #[allow(dead_code)]
    pub docs_url: Option<String>,
    #[allow(dead_code)]
    pub homepage_url: Option<String>,
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
            docs_url: None,
            homepage_url: None,
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
            docs_url: None,
            homepage_url: None,
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
            docs_url: None,
            homepage_url: None,
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
            docs_url: None,
            homepage_url: None,
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
            docs_url: None,
            homepage_url: None,
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
            docs_url: None,
            homepage_url: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_alias_returns_canonical_name_for_known_alias() {
        assert_eq!(
            resolve_alias("ram-monitor"),
            "@capybearista/opencode-ram-monitor"
        );
        assert_eq!(
            resolve_alias("output-styles"),
            "@capybearista/opencode-output-styles"
        );
        assert_eq!(
            resolve_alias("agents-loader"),
            "@capybearista/opencode-agents-loader"
        );
        assert_eq!(
            resolve_alias("adversarial-review"),
            "@capybearista/opencode-adversarial-review"
        );
        assert_eq!(
            resolve_alias("agent-prompt-inheritance"),
            "@capybearista/opencode-agent-prompt-inheritance"
        );
        assert_eq!(
            resolve_alias("double-tap-timeline"),
            "@capybearista/opencode-double-tap-timeline"
        );
    }

    #[test]
    fn resolve_alias_returns_input_for_unknown_alias() {
        assert_eq!(resolve_alias("unknown-plugin"), "unknown-plugin");
        assert_eq!(
            resolve_alias("@capybearista/opencode-ram-monitor"),
            "@capybearista/opencode-ram-monitor"
        );
        assert_eq!(resolve_alias(""), "");
    }

    #[test]
    fn get_curated_metadata_has_expected_entries() {
        let metadata = get_curated_metadata();
        assert_eq!(metadata.len(), 6);
        assert!(metadata.contains_key("@capybearista/opencode-ram-monitor"));
        assert!(metadata.contains_key("@capybearista/opencode-output-styles"));
        assert!(metadata.contains_key("@capybearista/opencode-agents-loader"));
        assert!(metadata.contains_key("@capybearista/opencode-adversarial-review"));
        assert!(metadata.contains_key("@capybearista/opencode-agent-prompt-inheritance"));
        assert!(metadata.contains_key("@capybearista/opencode-double-tap-timeline"));
    }
}
