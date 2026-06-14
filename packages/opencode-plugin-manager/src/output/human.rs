use crate::config::provider::ConfigScope;
use crate::discovery::{ClassifiedPlugin, EnrichedPlugin, PluginStatus, sort_enriched_plugins};
use crate::version_util::versions_equal;
use colored::*;
use std::fmt::Write;

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
            current_scope = Some(plugin.scope);
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

        if let Some(ref latest) = plugin.latest_version {
            let status_label = plugin
                .manifest
                .as_ref()
                .map(|m| {
                    if versions_equal(&m.version, latest) {
                        "up to date"
                    } else {
                        "update available"
                    }
                })
                .unwrap_or("not installed");
            writeln!(output, "  latest {}   {}", latest, status_label.dimmed()).unwrap();
        }
        writeln!(output).unwrap();
    }

    output
}

pub fn print_plugins(plugins: &[EnrichedPlugin]) {
    print!("{}", render_plugins(plugins));
}

pub fn render_outdated_human(classified: &[ClassifiedPlugin]) -> String {
    if classified.is_empty() {
        return "No plugins found.\n".to_string();
    }

    let mut outdated: Vec<&ClassifiedPlugin> = Vec::new();
    let mut current: Vec<&ClassifiedPlugin> = Vec::new();
    let mut unresolved: Vec<&ClassifiedPlugin> = Vec::new();

    for cp in classified {
        match cp.status {
            PluginStatus::Outdated => outdated.push(cp),
            PluginStatus::Current => current.push(cp),
            PluginStatus::Unresolved => unresolved.push(cp),
        }
    }

    let mut output = String::new();

    if !outdated.is_empty() {
        writeln!(
            output,
            "{}",
            format!("Outdated ({}):", outdated.len()).bold()
        )
        .unwrap();
        for cp in &outdated {
            let installed = cp
                .plugin
                .manifest
                .as_ref()
                .map(|m| m.version.as_str())
                .unwrap_or("—");
            let latest = cp.plugin.latest_version.as_deref().unwrap_or("—");
            writeln!(
                output,
                "  {}  v{} → v{}",
                cp.plugin.display_name.bold(),
                installed,
                latest
            )
            .unwrap();
        }
        writeln!(output).unwrap();
    }

    if !current.is_empty() {
        writeln!(output, "{}", format!("Current ({}):", current.len()).bold()).unwrap();
        for cp in &current {
            let installed = cp
                .plugin
                .manifest
                .as_ref()
                .map(|m| m.version.as_str())
                .unwrap_or("—");
            writeln!(
                output,
                "  {}  v{}",
                cp.plugin.display_name.bold(),
                installed
            )
            .unwrap();
        }
        writeln!(output).unwrap();
    }

    if !unresolved.is_empty() {
        writeln!(
            output,
            "{}",
            format!("Unresolved ({}):", unresolved.len()).bold()
        )
        .unwrap();
        for cp in &unresolved {
            if let Some(ref latest) = cp.plugin.latest_version {
                let installed = cp
                    .plugin
                    .manifest
                    .as_ref()
                    .map(|m| m.version.as_str())
                    .unwrap_or("—");
                writeln!(
                    output,
                    "  {}  v{} (not installed, latest: v{})",
                    cp.plugin.display_name.bold(),
                    installed,
                    latest
                )
                .unwrap();
            } else {
                let installed = cp
                    .plugin
                    .manifest
                    .as_ref()
                    .map(|m| m.version.as_str())
                    .unwrap_or("—");
                writeln!(
                    output,
                    "  {}  v{} (no registry data)",
                    cp.plugin.display_name.bold(),
                    installed
                )
                .unwrap();
            }
        }
        writeln!(output).unwrap();
    }

    output
}

pub fn print_outdated_human(classified: &[ClassifiedPlugin]) {
    print!("{}", render_outdated_human(classified));
}

fn scope_label(scope: &ConfigScope) -> &'static str {
    match scope {
        ConfigScope::Project => "Project",
        ConfigScope::Global => "Global",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::PluginMetadata;
    use crate::config::manifest::{Engines, PackageManifest};
    use crate::discovery::InstallStatus;
    use crate::discovery::classify_plugins;
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
            catalog_metadata: curated.then_some(PluginMetadata {
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
            status: InstallStatus::Installed,
            latest_version: None,
            declared_latest_range: None,
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

    #[test]
    fn render_plugins_shows_latest_version_when_outdated() {
        let plugins = vec![EnrichedPlugin {
            configured_spec: "plugin-a@latest".to_string(),
            package_name: "plugin-a".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "plugin-a".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: None,
            display_name: "plugin-a".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins);
        assert!(output.contains("latest 2.0.0"));
        assert!(output.contains("update available"));
    }

    #[test]
    fn render_plugins_shows_up_to_date_when_current() {
        let plugins = vec![EnrichedPlugin {
            configured_spec: "plugin-a@latest".to_string(),
            package_name: "plugin-a".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "plugin-a".to_string(),
                version: "2.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: None,
            display_name: "plugin-a".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins);
        assert!(output.contains("latest 2.0.0"));
        assert!(output.contains("up to date"));
    }

    #[test]
    fn render_plugins_shows_not_installed_when_manifest_missing() {
        let plugins = vec![EnrichedPlugin {
            configured_spec: "plugin-a@latest".to_string(),
            package_name: "plugin-a".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: None,
            catalog_metadata: None,
            display_name: "plugin-a".to_string(),
            description: String::new(),
            status: InstallStatus::MissingInstall,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins);
        assert!(output.contains("latest 2.0.0"));
        assert!(output.contains("not installed"));
    }

    #[test]
    fn render_plugins_hides_latest_when_not_available() {
        let plugins = vec![EnrichedPlugin {
            configured_spec: "plugin-a@latest".to_string(),
            package_name: "plugin-a".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "plugin-a".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: None,
            display_name: "plugin-a".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: None,
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins);
        assert!(!output.contains("latest"));
        assert!(!output.contains("up to date"));
    }

    #[test]
    fn render_outdated_human_shows_grouped_sections() {
        let plugins = vec![
            EnrichedPlugin {
                configured_spec: "alpha@latest".to_string(),
                package_name: "alpha".to_string(),
                scope: ConfigScope::Project,
                config_path: PathBuf::from("/tmp/opencode.json"),
                manifest: Some(PackageManifest {
                    name: "alpha".to_string(),
                    version: "1.0.0".to_string(),
                    description: None,
                    engines: None,
                }),
                catalog_metadata: None,
                display_name: "alpha".to_string(),
                description: String::new(),
                status: InstallStatus::Installed,
                latest_version: Some("2.0.0".to_string()),
                declared_latest_range: None,
            },
            EnrichedPlugin {
                configured_spec: "beta@latest".to_string(),
                package_name: "beta".to_string(),
                scope: ConfigScope::Project,
                config_path: PathBuf::from("/tmp/opencode.json"),
                manifest: Some(PackageManifest {
                    name: "beta".to_string(),
                    version: "1.0.0".to_string(),
                    description: None,
                    engines: None,
                }),
                catalog_metadata: None,
                display_name: "beta".to_string(),
                description: String::new(),
                status: InstallStatus::Installed,
                latest_version: Some("1.0.0".to_string()),
                declared_latest_range: None,
            },
            EnrichedPlugin {
                configured_spec: "gamma@latest".to_string(),
                package_name: "gamma".to_string(),
                scope: ConfigScope::Project,
                config_path: PathBuf::from("/tmp/opencode.json"),
                manifest: None,
                catalog_metadata: None,
                display_name: "gamma".to_string(),
                description: String::new(),
                status: InstallStatus::MissingInstall,
                latest_version: None,
                declared_latest_range: None,
            },
            EnrichedPlugin {
                configured_spec: "delta@latest".to_string(),
                package_name: "delta".to_string(),
                scope: ConfigScope::Global,
                config_path: PathBuf::from("/tmp/global/opencode.json"),
                manifest: None,
                catalog_metadata: None,
                display_name: "delta".to_string(),
                description: String::new(),
                status: InstallStatus::MissingInstall,
                latest_version: Some("3.0.0".to_string()),
                declared_latest_range: None,
            },
        ];

        let classified = classify_plugins(plugins);
        let output = render_outdated_human(&classified);

        assert!(output.contains("Outdated (1):"));
        assert!(output.contains("alpha"));
        assert!(output.contains("v1.0.0 → v2.0.0"));
        assert!(output.contains("Current (1):"));
        assert!(output.contains("beta"));
        assert!(output.contains("Unresolved (2):"));
        assert!(output.contains("gamma"));
        assert!(output.contains("(no registry data)"));
        assert!(output.contains("delta"));
        assert!(output.contains("(not installed, latest: v3.0.0)"));
    }

    #[test]
    fn render_outdated_human_skips_empty_sections() {
        let plugins = vec![EnrichedPlugin {
            configured_spec: "alpha@latest".to_string(),
            package_name: "alpha".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "alpha".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: None,
            display_name: "alpha".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];

        let classified = classify_plugins(plugins);
        let output = render_outdated_human(&classified);

        // Only Outdated section should appear
        assert!(output.contains("Outdated (1):"));
        assert!(!output.contains("Current"));
        assert!(!output.contains("Unresolved"));
    }

    #[test]
    fn render_outdated_human_shows_none_when_empty() {
        let output = render_outdated_human(&[]);
        assert!(output.contains("No plugins found"));
    }

    // --- Snapshot-style tests ---

    #[test]
    fn snapshot_render_plugins_single_outdated() {
        let plugins = vec![EnrichedPlugin {
            configured_spec: "my-plugin@latest".to_string(),
            package_name: "my-plugin".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "my-plugin".to_string(),
                version: "1.0.0".to_string(),
                description: Some("A useful plugin".to_string()),
                engines: Some(Engines {
                    opencode: Some(">=1.15.3".to_string()),
                }),
            }),
            catalog_metadata: None,
            display_name: "my-plugin".to_string(),
            description: "A useful plugin".to_string(),
            status: InstallStatus::Installed,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins);
        // Verify key structural elements
        assert!(output.contains("my-plugin"));
        assert!(output.contains("1.0.0"));
        assert!(output.contains("2.0.0"));
        assert!(output.contains("update available"));
    }

    #[test]
    fn snapshot_render_plugins_empty_list() {
        let output = render_plugins(&[]);
        assert!(output.contains("No configured plugins"));
    }

    #[test]
    fn snapshot_render_outdated_human_all_sections() {
        let plugins = vec![
            EnrichedPlugin {
                configured_spec: "outdated-pkg@latest".to_string(),
                package_name: "outdated-pkg".to_string(),
                scope: ConfigScope::Project,
                config_path: PathBuf::from("/tmp/opencode.json"),
                manifest: Some(PackageManifest {
                    name: "outdated-pkg".to_string(),
                    version: "1.0.0".to_string(),
                    description: None,
                    engines: None,
                }),
                catalog_metadata: None,
                display_name: "outdated-pkg".to_string(),
                description: String::new(),
                status: InstallStatus::Installed,
                latest_version: Some("2.0.0".to_string()),
                declared_latest_range: None,
            },
            EnrichedPlugin {
                configured_spec: "current-pkg@latest".to_string(),
                package_name: "current-pkg".to_string(),
                scope: ConfigScope::Project,
                config_path: PathBuf::from("/tmp/opencode.json"),
                manifest: Some(PackageManifest {
                    name: "current-pkg".to_string(),
                    version: "2.0.0".to_string(),
                    description: None,
                    engines: None,
                }),
                catalog_metadata: None,
                display_name: "current-pkg".to_string(),
                description: String::new(),
                status: InstallStatus::Installed,
                latest_version: Some("2.0.0".to_string()),
                declared_latest_range: None,
            },
            EnrichedPlugin {
                configured_spec: "missing-pkg@latest".to_string(),
                package_name: "missing-pkg".to_string(),
                scope: ConfigScope::Global,
                config_path: PathBuf::from("/tmp/global/opencode.json"),
                manifest: None,
                catalog_metadata: None,
                display_name: "missing-pkg".to_string(),
                description: String::new(),
                status: InstallStatus::MissingInstall,
                latest_version: Some("3.0.0".to_string()),
                declared_latest_range: None,
            },
        ];
        let classified = classify_plugins(plugins);
        let output = render_outdated_human(&classified);

        // Verify section headers exist with counts
        assert!(output.contains("Outdated (1):"));
        assert!(output.contains("Current (1):"));
        assert!(output.contains("Unresolved (1):"));

        // Verify version arrows for outdated
        assert!(output.contains("v1.0.0"));
        assert!(output.contains("v2.0.0"));

        // Verify unresolved shows "not installed" and latest version
        assert!(output.contains("missing-pkg"));
        assert!(output.contains("not installed"));
        assert!(output.contains("v3.0.0"));

        // Verify current shows version info
        assert!(output.contains("current-pkg"));
    }

    #[test]
    fn snapshot_render_outdated_human_empty() {
        let output = render_outdated_human(&[]);
        assert!(output.contains("No plugins found"));
        // Should not contain any section headers
        assert!(!output.contains("Outdated"));
        assert!(!output.contains("Current"));
        assert!(!output.contains("Unresolved"));
    }

    #[test]
    fn snapshot_render_plugins_curated_plugin() {
        let plugins = vec![EnrichedPlugin {
            configured_spec: "curated-plugin@latest".to_string(),
            package_name: "curated-plugin".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "curated-plugin".to_string(),
                version: "1.5.0".to_string(),
                description: Some("A curated plugin".to_string()),
                engines: None,
            }),
            catalog_metadata: Some(PluginMetadata {
                package_name: "curated-plugin",
                alias: "cp",
                display_name: "Curated Plugin",
                description: "A curated plugin description",
                category: "utility",
                docs_url: None,
                homepage_url: None,
            }),
            display_name: "Curated Plugin".to_string(),
            description: "A curated plugin description".to_string(),
            status: InstallStatus::Installed,
            latest_version: None,
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins);
        assert!(output.contains("Curated Plugin"));
        assert!(output.contains("1.5.0"));
    }

    #[test]
    fn snapshot_render_plugins_missing_manifest() {
        let plugins = vec![EnrichedPlugin {
            configured_spec: "broken-plugin@latest".to_string(),
            package_name: "broken-plugin".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: None,
            catalog_metadata: None,
            display_name: "broken-plugin".to_string(),
            description: String::new(),
            status: InstallStatus::MissingInstall,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins);
        assert!(output.contains("broken-plugin"));
        assert!(output.contains("not installed"));
    }
}
