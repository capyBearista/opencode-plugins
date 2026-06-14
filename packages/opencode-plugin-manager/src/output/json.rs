use crate::config::provider::ConfigScope;
use crate::discovery::{sort_enriched_plugins, ClassifiedPlugin, EnrichedPlugin, PluginStatus};
use serde::Serialize;

#[cfg(test)]
mod tests {
    use super::build_outdated_json;
    use super::build_plugins_json;
    use crate::catalog::PluginMetadata;
    use crate::config::manifest::{Engines, PackageManifest};
    use crate::config::provider::ConfigScope;
    use crate::discovery::classify_plugins;
    use crate::discovery::{EnrichedPlugin, InstallStatus};
    use serde_json::Value;
    use std::path::PathBuf;

    fn plugin(
        scope: ConfigScope,
        config_path: &str,
        requested_spec: &str,
        package_name: &str,
        installed: bool,
    ) -> EnrichedPlugin {
        EnrichedPlugin {
            configured_spec: requested_spec.to_string(),
            package_name: package_name.to_string(),
            scope,
            config_path: PathBuf::from(config_path),
            manifest: installed.then(|| PackageManifest {
                name: package_name.to_string(),
                version: "1.2.3".to_string(),
                description: Some("description".to_string()),
                engines: Some(Engines {
                    opencode: Some(">=1.15.3".to_string()),
                }),
            }),
            catalog_metadata: Some(PluginMetadata {
                package_name: "pkg",
                alias: "alias",
                display_name: "Display Name",
                description: "description",
                category: "category",
                docs_url: None,
                homepage_url: None,
            }),
            display_name: "Display Name".to_string(),
            description: "description".to_string(),
            status: if installed {
                InstallStatus::Installed
            } else {
                InstallStatus::MissingInstall
            },
            latest_version: None,
            declared_latest_range: None,
        }
    }

    #[test]
    fn build_plugins_json_includes_stable_plugin_fields() {
        let plugins = vec![
            plugin(
                ConfigScope::Project,
                "/tmp/opencode.json",
                "@capybearista/opencode-ram-monitor@latest",
                "@capybearista/opencode-ram-monitor",
                true,
            ),
            plugin(
                ConfigScope::Global,
                "/tmp/global/opencode.json",
                "third-party@latest",
                "third-party",
                false,
            ),
        ];

        let output = build_plugins_json(&plugins);
        let value = serde_json::to_value(output).unwrap();
        let plugins = value.get("plugins").and_then(Value::as_array).unwrap();

        assert_eq!(
            plugins[0]["requestedSpec"],
            "@capybearista/opencode-ram-monitor@latest"
        );
        assert_eq!(
            plugins[0]["packageName"],
            "@capybearista/opencode-ram-monitor"
        );
        assert_eq!(plugins[0]["scope"], "project");
        assert_eq!(plugins[0]["configPath"], "/tmp/opencode.json");
        assert_eq!(plugins[0]["installed"], true);
        assert_eq!(plugins[0]["installedVersion"], "1.2.3");
        assert_eq!(plugins[0]["status"], "installed");
        assert_eq!(plugins[0]["displayName"], "Display Name");
        assert_eq!(plugins[0]["description"], "description");
        assert_eq!(plugins[0]["declaredOpenCodeRange"], ">=1.15.3");
        assert!(plugins[0]["latestVersion"].is_null());
        assert!(plugins[0]["latestDeclaredOpenCodeRange"].is_null());
    }

    #[test]
    fn build_plugins_json_includes_latest_version_when_present() {
        let mut plugins = vec![plugin(
            ConfigScope::Project,
            "/tmp/opencode.json",
            "my-plugin@latest",
            "my-plugin",
            true,
        )];
        plugins[0].latest_version = Some("3.0.0".to_string());
        plugins[0].declared_latest_range = Some(">=1.16.0".to_string());

        let output = build_plugins_json(&plugins);
        let value = serde_json::to_value(output).unwrap();
        let plugins = value.get("plugins").and_then(Value::as_array).unwrap();

        assert_eq!(plugins[0]["latestVersion"], "3.0.0");
        assert_eq!(plugins[0]["latestDeclaredOpenCodeRange"], ">=1.16.0");
    }

    #[test]
    fn build_outdated_json_separates_by_update_status() {
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
                display_name: "Alpha".to_string(),
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
                display_name: "Beta".to_string(),
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
                display_name: "Gamma".to_string(),
                description: String::new(),
                status: InstallStatus::MissingInstall,
                latest_version: None,
                declared_latest_range: None,
            },
        ];

        let classified = classify_plugins(plugins);
        let output = build_outdated_json(&classified);
        let value = serde_json::to_value(output).unwrap();

        let outdated = value.get("outdated").and_then(Value::as_array).unwrap();
        let current = value.get("current").and_then(Value::as_array).unwrap();
        let unresolved = value.get("unresolved").and_then(Value::as_array).unwrap();

        assert_eq!(outdated.len(), 1);
        assert_eq!(outdated[0]["packageName"], "alpha");
        assert_eq!(outdated[0]["status"], "outdated");

        assert_eq!(current.len(), 1);
        assert_eq!(current[0]["packageName"], "beta");
        assert_eq!(current[0]["status"], "current");

        assert_eq!(unresolved.len(), 1);
        assert_eq!(unresolved[0]["packageName"], "gamma");
        assert_eq!(unresolved[0]["status"], "unresolved");
    }

    #[test]
    fn snapshot_empty_plugin_list_json_shape() {
        let output = build_plugins_json(&[]);
        let value = serde_json::to_value(&output).unwrap();
        let pretty = serde_json::to_string_pretty(&value).unwrap();
        insta::assert_snapshot!(&pretty);
    }

    #[test]
    fn snapshot_single_installed_plugin_json_shape() {
        let plugins = vec![plugin(
            ConfigScope::Project,
            "/tmp/opencode.json",
            "my-plugin@latest",
            "my-plugin",
            true,
        )];
        let output = build_plugins_json(&plugins);
        let value = serde_json::to_value(&output).unwrap();
        let pretty = serde_json::to_string_pretty(&value).unwrap();
        insta::assert_snapshot!(&pretty);
    }

    #[test]
    fn snapshot_uninstalled_plugin_null_installed_version() {
        let plugins = vec![plugin(
            ConfigScope::Global,
            "/tmp/global/opencode.json",
            "third-party@latest",
            "third-party",
            false,
        )];
        let output = build_plugins_json(&plugins);
        let value = serde_json::to_value(&output).unwrap();
        let pretty = serde_json::to_string_pretty(&value).unwrap();
        insta::assert_snapshot!(&pretty);
    }

    #[test]
    fn snapshot_outdated_json_all_sections() {
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
                display_name: "Alpha".to_string(),
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
                    version: "2.0.0".to_string(),
                    description: None,
                    engines: None,
                }),
                catalog_metadata: None,
                display_name: "Beta".to_string(),
                description: String::new(),
                status: InstallStatus::Installed,
                latest_version: Some("2.0.0".to_string()),
                declared_latest_range: None,
            },
            EnrichedPlugin {
                configured_spec: "gamma@latest".to_string(),
                package_name: "gamma".to_string(),
                scope: ConfigScope::Project,
                config_path: PathBuf::from("/tmp/opencode.json"),
                manifest: None,
                catalog_metadata: None,
                display_name: "Gamma".to_string(),
                description: String::new(),
                status: InstallStatus::MissingInstall,
                latest_version: None,
                declared_latest_range: None,
            },
        ];
        let classified = classify_plugins(plugins);
        let output = build_outdated_json(&classified);
        let value = serde_json::to_value(&output).unwrap();
        let pretty = serde_json::to_string_pretty(&value).unwrap();
        insta::assert_snapshot!(&pretty);
    }

    #[test]
    fn snapshot_empty_outdated_json_all_empty() {
        let classified = classify_plugins(vec![]);
        let output = build_outdated_json(&classified);
        let value = serde_json::to_value(&output).unwrap();
        let pretty = serde_json::to_string_pretty(&value).unwrap();
        insta::assert_snapshot!(&pretty);
    }

    #[test]
    fn snapshot_plugin_list_order_is_stable() {
        let plugins = vec![
            plugin(
                ConfigScope::Global,
                "/tmp/global/opencode.json",
                "zebra@latest",
                "zebra",
                true,
            ),
            plugin(
                ConfigScope::Project,
                "/tmp/opencode.json",
                "alpha@latest",
                "alpha",
                true,
            ),
        ];
        let output = build_plugins_json(&plugins);
        let value = serde_json::to_value(&output).unwrap();
        let pretty = serde_json::to_string_pretty(&value).unwrap();
        insta::assert_snapshot!(&pretty);
    }
}

#[derive(Serialize)]
pub struct JsonOutput {
    pub plugins: Vec<JsonPlugin>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonPlugin {
    pub requested_spec: String,
    pub package_name: String,
    pub scope: String,
    pub config_path: String,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub status: String,
    pub display_name: String,
    pub description: String,
    pub declared_open_code_range: Option<String>,
    pub latest_version: Option<String>,
    pub latest_declared_open_code_range: Option<String>,
}

pub fn build_plugins_json(plugins: &[EnrichedPlugin]) -> JsonOutput {
    JsonOutput {
        plugins: sort_enriched_plugins(plugins)
            .into_iter()
            .map(|plugin| JsonPlugin {
                requested_spec: plugin.configured_spec.clone(),
                package_name: plugin.package_name.clone(),
                scope: match plugin.scope {
                    ConfigScope::Project => "project".to_string(),
                    ConfigScope::Global => "global".to_string(),
                },
                config_path: plugin.config_path.display().to_string(),
                installed: plugin.manifest.is_some(),
                installed_version: plugin
                    .manifest
                    .as_ref()
                    .map(|manifest| manifest.version.clone()),
                status: plugin.status.as_json_label().to_string(),
                display_name: plugin.display_name.clone(),
                description: plugin.description.clone(),
                declared_open_code_range: plugin
                    .manifest
                    .as_ref()
                    .and_then(|manifest| manifest.engines.as_ref())
                    .and_then(|engines| engines.opencode.clone()),
                latest_version: plugin.latest_version.clone(),
                latest_declared_open_code_range: plugin.declared_latest_range.clone(),
            })
            .collect(),
    }
}

pub fn print_plugins_json(plugins: &[EnrichedPlugin]) {
    let json = serde_json::to_string_pretty(&build_plugins_json(plugins))
        .expect("JSON serialization of plugin list should never fail");
    println!("{}", json);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutdatedJsonPlugin {
    pub requested_spec: String,
    pub package_name: String,
    pub scope: String,
    pub config_path: String,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub install_status: String,
    pub status: String,
    pub display_name: String,
    pub description: String,
    pub declared_open_code_range: Option<String>,
    pub latest_version: Option<String>,
    pub latest_declared_open_code_range: Option<String>,
}

#[derive(Serialize)]
pub struct OutdatedJsonOutput {
    pub outdated: Vec<OutdatedJsonPlugin>,
    pub current: Vec<OutdatedJsonPlugin>,
    pub unresolved: Vec<OutdatedJsonPlugin>,
}

fn build_outdated_plugin(cp: &ClassifiedPlugin) -> OutdatedJsonPlugin {
    let plugin = &cp.plugin;
    OutdatedJsonPlugin {
        requested_spec: plugin.configured_spec.clone(),
        package_name: plugin.package_name.clone(),
        scope: match plugin.scope {
            ConfigScope::Project => "project".to_string(),
            ConfigScope::Global => "global".to_string(),
        },
        config_path: plugin.config_path.display().to_string(),
        installed: plugin.manifest.is_some(),
        installed_version: plugin
            .manifest
            .as_ref()
            .map(|manifest| manifest.version.clone()),
        install_status: plugin.status.as_json_label().to_string(),
        status: cp.status.as_json_label().to_string(),
        display_name: plugin.display_name.clone(),
        description: plugin.description.clone(),
        declared_open_code_range: plugin
            .manifest
            .as_ref()
            .and_then(|manifest| manifest.engines.as_ref())
            .and_then(|engines| engines.opencode.clone()),
        latest_version: plugin.latest_version.clone(),
        latest_declared_open_code_range: plugin.declared_latest_range.clone(),
    }
}

pub fn build_outdated_json(classified: &[ClassifiedPlugin]) -> OutdatedJsonOutput {
    let mut outdated = Vec::new();
    let mut current = Vec::new();
    let mut unresolved = Vec::new();

    for cp in classified {
        match cp.status {
            PluginStatus::Outdated => outdated.push(build_outdated_plugin(cp)),
            PluginStatus::Current => current.push(build_outdated_plugin(cp)),
            PluginStatus::Unresolved => unresolved.push(build_outdated_plugin(cp)),
        }
    }

    OutdatedJsonOutput {
        outdated,
        current,
        unresolved,
    }
}

pub fn print_outdated_json(classified: &[ClassifiedPlugin]) {
    let json = serde_json::to_string_pretty(&build_outdated_json(classified))
        .expect("JSON serialization of outdated plugin list should never fail");
    println!("{}", json);
}
