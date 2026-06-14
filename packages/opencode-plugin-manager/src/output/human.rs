use crate::config::provider::ConfigScope;
use crate::discovery::{sort_enriched_plugins, ClassifiedPlugin, EnrichedPlugin, PluginStatus};
use crate::version_util::versions_equal;
use colored::*;
use std::fmt::Write;

pub fn render_plugins(plugins: &[EnrichedPlugin], verbose: bool) -> String {
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

        // Display name with alias for curated plugins
        if let Some(ref meta) = plugin.catalog_metadata {
            writeln!(
                output,
                "  {}  ({})",
                plugin.display_name.bold(),
                meta.alias.dimmed()
            )
            .unwrap();
        } else {
            writeln!(output, "  {}", plugin.display_name.bold()).unwrap();
        }

        if !plugin.description.is_empty() {
            writeln!(output, "  {}", plugin.description.dimmed()).unwrap();
        }
        writeln!(output, "  {}", plugin.package_name.dimmed()).unwrap();

        // Single consolidated status line: installed version + latest + status.
        let installed_version = plugin
            .manifest
            .as_ref()
            .map(|manifest| manifest.version.as_str());

        if let Some(ref latest) = plugin.latest_version {
            // Use a dash for the installed-version column when not installed,
            // since the status column already conveys "not installed".
            let installed_label = installed_version.unwrap_or("—");
            let (status_label, status_color) = match installed_version {
                Some(v) => {
                    if versions_equal(v, latest) {
                        ("current", "green")
                    } else {
                        ("update available", "yellow")
                    }
                }
                None => ("not installed", "red"),
            };
            let colored_status = match status_color {
                "green" => status_label.green(),
                "yellow" => status_label.yellow(),
                _ => status_label.red(),
            };
            writeln!(
                output,
                "  {}   latest {}   {}",
                installed_label.dimmed(),
                latest.dimmed(),
                colored_status,
            )
            .unwrap();
        } else if let Some(v) = installed_version {
            writeln!(output, "  {}", v.dimmed()).unwrap();
        } else {
            writeln!(output, "  {}", "not installed".dimmed()).unwrap();
        }

        // Config path in verbose mode
        if verbose {
            writeln!(
                output,
                "  {}",
                plugin.config_path.display().to_string().dimmed()
            )
            .unwrap();
        }

        writeln!(output).unwrap();
    }

    output
}

pub fn print_plugins(plugins: &[EnrichedPlugin], verbose: bool) {
    print!("{}", render_plugins(plugins, verbose));
}

pub fn render_outdated_human(classified: &[ClassifiedPlugin], verbose: bool) -> String {
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
            format!("Outdated ({}):", outdated.len()).yellow().bold()
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
            // Display name with alias for curated plugins (same pattern as render_plugins)
            if let Some(ref meta) = cp.plugin.catalog_metadata {
                writeln!(
                    output,
                    "  {}  ({})  v{} → v{}",
                    cp.plugin.display_name.bold(),
                    meta.alias.dimmed(),
                    installed.dimmed(),
                    latest.green().bold()
                )
                .unwrap();
            } else {
                writeln!(
                    output,
                    "  {}  v{} → v{}",
                    cp.plugin.display_name.bold(),
                    installed.dimmed(),
                    latest.green().bold()
                )
                .unwrap();
            }
            if verbose {
                writeln!(
                    output,
                    "  {}",
                    cp.plugin.config_path.display().to_string().dimmed()
                )
                .unwrap();
            }
        }
        writeln!(output).unwrap();
    }

    if !current.is_empty() {
        writeln!(
            output,
            "{}",
            format!("Current ({}):", current.len()).green().bold()
        )
        .unwrap();
        for cp in &current {
            let installed = cp
                .plugin
                .manifest
                .as_ref()
                .map(|m| m.version.as_str())
                .unwrap_or("—");
            // Display name with alias for curated plugins (same pattern as render_plugins)
            if let Some(ref meta) = cp.plugin.catalog_metadata {
                writeln!(
                    output,
                    "  {}  ({})  v{}",
                    cp.plugin.display_name.bold(),
                    meta.alias.dimmed(),
                    installed
                )
                .unwrap();
            } else {
                writeln!(
                    output,
                    "  {}  v{}",
                    cp.plugin.display_name.bold(),
                    installed
                )
                .unwrap();
            }
            if verbose {
                writeln!(
                    output,
                    "  {}",
                    cp.plugin.config_path.display().to_string().dimmed()
                )
                .unwrap();
            }
        }
        writeln!(output).unwrap();
    }

    if !unresolved.is_empty() {
        writeln!(
            output,
            "{}",
            format!("Unresolved ({}):", unresolved.len()).red().bold()
        )
        .unwrap();
        for cp in &unresolved {
            let installed = cp.plugin.manifest.as_ref().map(|m| m.version.as_str());
            // Display name with alias for curated plugins (same pattern as render_plugins)
            let display_name = if let Some(ref meta) = cp.plugin.catalog_metadata {
                format!(
                    "{}  ({})",
                    cp.plugin.display_name.bold(),
                    meta.alias.dimmed()
                )
            } else {
                format!("{}", cp.plugin.display_name.bold())
            };
            match (installed, &cp.plugin.latest_version) {
                (Some(v), Some(latest)) => {
                    writeln!(
                        output,
                        "  {}  v{} (not installed, latest: v{})",
                        display_name, v, latest
                    )
                    .unwrap();
                }
                (None, Some(latest)) => {
                    writeln!(
                        output,
                        "  {}  not installed (latest: v{})",
                        display_name, latest
                    )
                    .unwrap();
                }
                (Some(v), None) => {
                    writeln!(output, "  {}  v{} (no registry data)", display_name, v).unwrap();
                }
                (None, None) => {
                    writeln!(output, "  {}  not installed", display_name).unwrap();
                }
            }
            if verbose {
                writeln!(
                    output,
                    "  {}",
                    cp.plugin.config_path.display().to_string().dimmed()
                )
                .unwrap();
            }
        }
        writeln!(output).unwrap();
    }

    output
}

pub fn print_outdated_human(classified: &[ClassifiedPlugin], verbose: bool) {
    print!("{}", render_outdated_human(classified, verbose));
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
    use crate::discovery::classify_plugins;
    use crate::discovery::InstallStatus;
    use std::path::PathBuf;

    /// Disable colored output so snapshot strings are deterministic regardless
    /// of terminal/TTY environment.
    static INIT: std::sync::Once = std::sync::Once::new();
    fn init() {
        INIT.call_once(|| {
            colored::control::set_override(false);
        });
    }

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
        init();
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
        init();
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

        let output = render_plugins(&plugins, false);
        assert!(output.contains("latest 2.0.0"));
        assert!(output.contains("update available"));
    }

    #[test]
    fn render_plugins_shows_current_when_up_to_date() {
        init();
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

        let output = render_plugins(&plugins, false);
        assert!(output.contains("latest 2.0.0"));
        assert!(output.contains("current"));
    }

    #[test]
    fn render_plugins_shows_not_installed_when_manifest_missing() {
        init();
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

        let output = render_plugins(&plugins, false);
        assert!(output.contains("latest 2.0.0"));
        assert!(output.contains("not installed"));
    }

    #[test]
    fn render_plugins_hides_latest_when_not_available() {
        init();
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

        let output = render_plugins(&plugins, false);
        assert!(!output.contains("latest"));
        assert!(!output.contains("up to date"));
    }

    #[test]
    fn render_outdated_human_shows_grouped_sections() {
        init();
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
        let output = render_outdated_human(&classified, false);

        assert!(output.contains("Outdated (1):"));
        assert!(output.contains("alpha"));
        assert!(output.contains("v1.0.0 → v2.0.0"));
        assert!(output.contains("Current (1):"));
        assert!(output.contains("beta"));
        assert!(output.contains("Unresolved (2):"));
        assert!(output.contains("gamma"));
        assert!(output.contains("not installed"));
        assert!(output.contains("delta"));
        assert!(output.contains("not installed (latest: v3.0.0)"));
    }

    #[test]
    fn render_outdated_human_skips_empty_sections() {
        init();
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
        let output = render_outdated_human(&classified, false);

        // Only Outdated section should appear
        assert!(output.contains("Outdated (1):"));
        assert!(!output.contains("Current"));
        assert!(!output.contains("Unresolved"));
    }

    #[test]
    fn render_outdated_human_shows_none_when_empty() {
        init();
        let output = render_outdated_human(&[], false);
        assert!(output.contains("No plugins found"));
    }

    #[test]
    fn snapshot_render_plugins_single_outdated() {
        init();
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

        let output = render_plugins(&plugins, false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_render_plugins_empty_list() {
        init();
        let output = render_plugins(&[], false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_render_outdated_human_all_sections() {
        init();
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
        let output = render_outdated_human(&classified, false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_render_outdated_human_empty() {
        init();
        let output = render_outdated_human(&[], false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_render_plugins_curated_plugin() {
        init();
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

        let output = render_plugins(&plugins, false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_render_plugins_missing_manifest() {
        init();
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

        let output = render_plugins(&plugins, false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_list_curated_plugin_update_available() {
        init();
        let plugins = vec![EnrichedPlugin {
            configured_spec: "@capybearista/opencode-ram-monitor@latest".to_string(),
            package_name: "@capybearista/opencode-ram-monitor".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "opencode-ram-monitor".to_string(),
                version: "0.2.1".to_string(),
                description: Some("Monitor RAM usage.".to_string()),
                engines: None,
            }),
            catalog_metadata: Some(PluginMetadata {
                package_name: "@capybearista/opencode-ram-monitor",
                alias: "ram-monitor",
                display_name: "RAM Monitor",
                description: "Monitor OpenCode's RAM usage per session in real time.",
                category: "TUI",
                docs_url: None,
                homepage_url: None,
            }),
            display_name: "RAM Monitor".to_string(),
            description: "Monitor OpenCode's RAM usage per session in real time.".to_string(),
            status: InstallStatus::Installed,
            latest_version: Some("0.3.0".to_string()),
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins, false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_list_curated_plugin_current() {
        init();
        let plugins = vec![EnrichedPlugin {
            configured_spec: "@capybearista/opencode-output-styles@latest".to_string(),
            package_name: "@capybearista/opencode-output-styles".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "opencode-output-styles".to_string(),
                version: "0.1.4".to_string(),
                description: Some("Persist reusable styles.".to_string()),
                engines: None,
            }),
            catalog_metadata: Some(PluginMetadata {
                package_name: "@capybearista/opencode-output-styles",
                alias: "output-styles",
                display_name: "Output Styles",
                description: "Persist reusable response styles for OpenCode sessions.",
                category: "Prompting",
                docs_url: None,
                homepage_url: None,
            }),
            display_name: "Output Styles".to_string(),
            description: "Persist reusable response styles for OpenCode sessions.".to_string(),
            status: InstallStatus::Installed,
            latest_version: Some("0.1.4".to_string()),
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins, false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_list_third_party_plugin_no_description() {
        init();
        let plugins = vec![EnrichedPlugin {
            configured_spec: "some-third-party@latest".to_string(),
            package_name: "some-third-party".to_string(),
            scope: ConfigScope::Global,
            config_path: PathBuf::from("/tmp/global/opencode.json"),
            manifest: Some(PackageManifest {
                name: "some-third-party".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: None,
            display_name: "some-third-party".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: None,
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins, false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_list_mixed_scopes() {
        init();
        let plugins = vec![
            EnrichedPlugin {
                configured_spec: "@capybearista/opencode-ram-monitor@latest".to_string(),
                package_name: "@capybearista/opencode-ram-monitor".to_string(),
                scope: ConfigScope::Project,
                config_path: PathBuf::from("/tmp/opencode.json"),
                manifest: Some(PackageManifest {
                    name: "opencode-ram-monitor".to_string(),
                    version: "0.2.1".to_string(),
                    description: None,
                    engines: None,
                }),
                catalog_metadata: Some(PluginMetadata {
                    package_name: "@capybearista/opencode-ram-monitor",
                    alias: "ram-monitor",
                    display_name: "RAM Monitor",
                    description: "Monitor OpenCode's RAM usage.",
                    category: "TUI",
                    docs_url: None,
                    homepage_url: None,
                }),
                display_name: "RAM Monitor".to_string(),
                description: "Monitor OpenCode's RAM usage.".to_string(),
                status: InstallStatus::Installed,
                latest_version: None,
                declared_latest_range: None,
            },
            EnrichedPlugin {
                configured_spec: "third-party@latest".to_string(),
                package_name: "third-party".to_string(),
                scope: ConfigScope::Global,
                config_path: PathBuf::from("/tmp/global/opencode.json"),
                manifest: Some(PackageManifest {
                    name: "third-party".to_string(),
                    version: "2.0.0".to_string(),
                    description: Some("A third-party plugin.".to_string()),
                    engines: None,
                }),
                catalog_metadata: None,
                display_name: "third-party".to_string(),
                description: "A third-party plugin.".to_string(),
                status: InstallStatus::Installed,
                latest_version: None,
                declared_latest_range: None,
            },
        ];

        let output = render_plugins(&plugins, false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn render_plugins_shows_alias_for_curated() {
        init();
        let plugins = vec![EnrichedPlugin {
            configured_spec: "curated@latest".to_string(),
            package_name: "curated".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "curated".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: Some(PluginMetadata {
                package_name: "curated",
                alias: "my-alias",
                display_name: "Curated Plugin",
                description: "A curated plugin",
                category: "utility",
                docs_url: None,
                homepage_url: None,
            }),
            display_name: "Curated Plugin".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: None,
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins, false);
        assert!(output.contains("(my-alias)"));
        assert!(!output.contains("/tmp/opencode.json"));
    }

    #[test]
    fn render_plugins_verbose_shows_config_path() {
        init();
        let plugins = vec![EnrichedPlugin {
            configured_spec: "test-plugin@latest".to_string(),
            package_name: "test-plugin".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "test-plugin".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: None,
            display_name: "test-plugin".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];

        let output_verbose = render_plugins(&plugins, true);
        assert!(output_verbose.contains("/tmp/opencode.json"));

        let output_normal = render_plugins(&plugins, false);
        assert!(!output_normal.contains("/tmp/opencode.json"));
    }

    #[test]
    fn render_plugins_nonverbose_hides_config_path() {
        init();
        let plugins = vec![EnrichedPlugin {
            configured_spec: "test-plugin@latest".to_string(),
            package_name: "test-plugin".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "test-plugin".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: None,
            display_name: "test-plugin".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: None,
            declared_latest_range: None,
        }];

        let output = render_plugins(&plugins, false);
        assert!(!output.contains("/tmp/opencode.json"));
    }

    #[test]
    fn render_outdated_human_verbose_shows_config_path() {
        init();
        let plugins = vec![EnrichedPlugin {
            configured_spec: "old@latest".to_string(),
            package_name: "old".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "old".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: None,
            display_name: "old".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];

        let classified = classify_plugins(plugins);
        let output = render_outdated_human(&classified, true);
        assert!(output.contains("/tmp/opencode.json"));

        let output_normal = render_outdated_human(&classified, false);
        assert!(!output_normal.contains("/tmp/opencode.json"));
    }

    #[test]
    fn snapshot_render_plugins_verbose() {
        init();
        let plugins = vec![EnrichedPlugin {
            configured_spec: "verbose-plugin@latest".to_string(),
            package_name: "verbose-plugin".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "verbose-plugin".to_string(),
                version: "1.0.0".to_string(),
                description: Some("A verbose plugin.".to_string()),
                engines: Some(Engines {
                    opencode: Some(">=1.15.3".to_string()),
                }),
            }),
            catalog_metadata: None,
            display_name: "verbose-plugin".to_string(),
            description: "A verbose plugin.".to_string(),
            status: InstallStatus::Installed,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];
        let output = render_plugins(&plugins, true);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_render_outdated_human_verbose() {
        init();
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
                scope: ConfigScope::Global,
                config_path: PathBuf::from("/tmp/global/opencode.json"),
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
        let output = render_outdated_human(&classified, true);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn snapshot_render_outdated_human_with_alias() {
        init();
        let plugins = vec![EnrichedPlugin {
            configured_spec: "curated-pkg@latest".to_string(),
            package_name: "curated-pkg".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "curated-pkg".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: Some(PluginMetadata {
                package_name: "curated-pkg",
                alias: "my-alias",
                display_name: "Curated Pkg",
                description: "A curated package",
                category: "utility",
                docs_url: None,
                homepage_url: None,
            }),
            display_name: "Curated Pkg".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];
        let classified = classify_plugins(plugins);
        let output = render_outdated_human(&classified, false);
        insta::assert_snapshot!(&output);
    }

    #[test]
    fn render_outdated_human_nonverbose_hides_config_path() {
        init();
        let plugins = vec![EnrichedPlugin {
            configured_spec: "old@latest".to_string(),
            package_name: "old".to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
            manifest: Some(PackageManifest {
                name: "old".to_string(),
                version: "1.0.0".to_string(),
                description: None,
                engines: None,
            }),
            catalog_metadata: None,
            display_name: "old".to_string(),
            description: String::new(),
            status: InstallStatus::Installed,
            latest_version: Some("2.0.0".to_string()),
            declared_latest_range: None,
        }];

        let classified = classify_plugins(plugins);
        let output = render_outdated_human(&classified, false);
        assert!(!output.contains("/tmp/opencode.json"));
    }
}
