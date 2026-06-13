use crate::config::provider::ConfigScope;
use crate::discovery::{sort_enriched_plugins, EnrichedPlugin};
use colored::*;
use std::fmt::Write;

#[cfg(test)]
mod tests {
    use super::sort_enriched_plugins;
    use super::*;
    use crate::catalog::PluginMetadata;
    use crate::config::manifest::{Engines, PackageManifest};
    use crate::discovery::PluginStatus;
    use std::path::PathBuf;

    fn plugin(scope: ConfigScope, display_name: &str, curated: bool) -> EnrichedPlugin {
        EnrichedPlugin {
            configured_spec: format!("{display_name}@latest"),
            package_name: display_name.to_lowercase(),
            scope,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: display_name.to_string(),
                version: "1.0.0".to_string(),
                description: Some(format!("{display_name} description")),
                engines: Some(Engines {
                    opencode: Some(">=1.15.3".to_string()),
                }),
            }),
            catalog_metadata: curated.then(|| PluginMetadata {
                package_name: "pkg",
                alias: "alias",
                display_name: "Curated",
                description: "description",
                category: "category",
                docs_url: None,
                homepage_url: None,
            }),
            display_name: display_name.to_string(),
            description: format!("{display_name} description"),
            status: PluginStatus::Installed,
        }
    }

    #[test]
    fn sort_plugins_groups_scope_and_prioritizes_curated_plugins() {
        let plugins = vec![
            plugin(ConfigScope::Global, "Zulu", false),
            plugin(ConfigScope::Project, "Bravo", false),
            plugin(ConfigScope::Project, "Alpha", true),
            plugin(ConfigScope::Global, "Alpha", true),
        ];

        let sorted = sort_enriched_plugins(&plugins);

        let ordered_names: Vec<_> = sorted
            .iter()
            .map(|plugin| plugin.display_name.as_str())
            .collect();
        assert_eq!(ordered_names, vec!["Alpha", "Bravo", "Alpha", "Zulu"]);
        assert_eq!(sorted[0].scope, ConfigScope::Project);
        assert_eq!(sorted[1].scope, ConfigScope::Project);
        assert_eq!(sorted[2].scope, ConfigScope::Global);
        assert_eq!(sorted[3].scope, ConfigScope::Global);
        assert!(sorted[0].catalog_metadata.is_some());
        assert!(sorted[1].catalog_metadata.is_none());
        assert!(sorted[2].catalog_metadata.is_some());
        assert!(sorted[3].catalog_metadata.is_none());
    }
}

pub fn render_plugins(plugins: &[EnrichedPlugin]) -> String {
    if plugins.is_empty() {
        return "No configured plugins found.\n".to_string();
    }

    let mut output = String::new();
    writeln!(output, "{}", "Configured OpenCode plugins".bold()).unwrap();
    writeln!(output).unwrap();

    let mut current_scope: Option<ConfigScope> = None;
    for plugin in sort_enriched_plugins(plugins) {
        if current_scope.as_ref() != Some(&plugin.scope) {
            if current_scope.is_some() {
                writeln!(output).unwrap();
            }

            writeln!(output, "{}", scope_label(&plugin.scope).bold()).unwrap();
            current_scope = Some(plugin.scope.clone());
        }

        writeln!(output, "  {}", plugin.display_name.bold()).unwrap();
        if !plugin.description.is_empty() {
            writeln!(output, "  {}", plugin.description.dimmed()).unwrap();
        }
        writeln!(output, "  {}", plugin.package_name.dimmed()).unwrap();

        let installed_version = plugin
            .manifest
            .as_ref()
            .map(|manifest| manifest.version.as_str())
            .unwrap_or("—");
        writeln!(
            output,
            "  installed {}   {}",
            installed_version,
            plugin.status.as_human_label().dimmed()
        )
        .unwrap();
        writeln!(output).unwrap();
    }

    output
}

pub fn print_plugins(plugins: &[EnrichedPlugin]) {
    print!("{}", render_plugins(plugins));
}

fn scope_label(scope: &ConfigScope) -> &'static str {
    match scope {
        ConfigScope::Project => "Project",
        ConfigScope::Global => "Global",
    }
}
