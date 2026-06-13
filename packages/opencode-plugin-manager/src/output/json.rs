use crate::config::provider::ConfigScope;
use crate::discovery::{sort_enriched_plugins, EnrichedPlugin};
use serde::Serialize;

#[cfg(test)]
mod tests {
    use super::build_plugins_json;
    use crate::catalog::PluginMetadata;
    use crate::config::manifest::{Engines, PackageManifest};
    use crate::config::provider::ConfigScope;
    use crate::discovery::{EnrichedPlugin, PluginStatus};
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
                PluginStatus::Installed
            } else {
                PluginStatus::MissingInstall
            },
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
            })
            .collect(),
    }
}

pub fn print_plugins_json(plugins: &[EnrichedPlugin]) {
    if let Ok(json) = serde_json::to_string_pretty(&build_plugins_json(plugins)) {
        println!("{}", json);
    }
}
