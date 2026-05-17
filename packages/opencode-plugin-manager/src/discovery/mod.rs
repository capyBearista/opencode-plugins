use crate::catalog::{get_curated_metadata, PluginMetadata};
use crate::config::manifest::{get_installed_manifest, PackageManifest};
use crate::config::provider::{ConfigScope, PluginEntry};
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)]
pub enum PluginStatus {
    Installed,
    MissingInstall,
    Unresolved,
}

impl PluginStatus {
    pub fn as_human_label(&self) -> &'static str {
        match self {
            PluginStatus::Installed => "installed",
            PluginStatus::MissingInstall => "missing install",
            PluginStatus::Unresolved => "unresolved",
        }
    }

    pub fn as_json_label(&self) -> &'static str {
        match self {
            PluginStatus::Installed => "installed",
            PluginStatus::MissingInstall => "missing_install",
            PluginStatus::Unresolved => "unresolved",
        }
    }
}

#[derive(Debug)]
pub struct EnrichedPlugin {
    pub configured_spec: String,
    pub package_name: String,
    pub scope: ConfigScope,
    pub config_path: PathBuf,
    pub manifest: Option<PackageManifest>,
    pub catalog_metadata: Option<PluginMetadata>,
    pub display_name: String,
    pub description: String,
    pub status: PluginStatus,
}

#[derive(Debug)]
pub struct ResolvedPlugin {
    pub entry: PluginEntry,
    pub manifest: Option<PackageManifest>,
}

pub fn extract_package_name(spec: &str) -> String {
    if spec.starts_with('@') {
        if let Some((scope, remainder)) = spec.split_once('/') {
            if let Some((package_name, _version)) = remainder.rsplit_once('@') {
                return format!("{scope}/{package_name}");
            }

            return spec.to_string();
        }
    }

    spec.rsplit_once('@')
        .map(|(package_name, _version)| package_name.to_string())
        .unwrap_or_else(|| spec.to_string())
}

pub fn deduplicate_plugins(entries: Vec<PluginEntry>) -> Vec<PluginEntry> {
    let mut seen = HashSet::new();
    let mut deduplicated = Vec::with_capacity(entries.len());

    for entry in entries.into_iter().rev() {
        let package_name = extract_package_name(&entry.spec);
        if seen.insert(package_name) {
            deduplicated.push(entry);
        }
    }

    deduplicated.reverse();
    deduplicated
}

pub fn sort_enriched_plugins(plugins: &[EnrichedPlugin]) -> Vec<&EnrichedPlugin> {
    let mut sorted: Vec<_> = plugins.iter().collect();
    sorted.sort_by(|left, right| {
        let left_key = (
            scope_rank(&left.scope),
            left.catalog_metadata.is_none(),
            left.display_name.to_lowercase(),
        );
        let right_key = (
            scope_rank(&right.scope),
            right.catalog_metadata.is_none(),
            right.display_name.to_lowercase(),
        );
        left_key.cmp(&right_key)
    });
    sorted
}

fn scope_rank(scope: &ConfigScope) -> u8 {
    match scope {
        ConfigScope::Project => 0,
        ConfigScope::Global => 1,
    }
}

pub fn enrich_plugin(resolved: ResolvedPlugin) -> EnrichedPlugin {
    let package_name = extract_package_name(&resolved.entry.spec);
    let catalog_metadata = get_curated_metadata().get(package_name.as_str()).cloned();
    let manifest = resolved.manifest;

    let display_name = catalog_metadata
        .as_ref()
        .map(|metadata| metadata.display_name.to_string())
        .or_else(|| manifest.as_ref().map(|manifest| manifest.name.clone()))
        .unwrap_or_else(|| package_name.clone());

    let description = catalog_metadata
        .as_ref()
        .map(|metadata| metadata.description.to_string())
        .or_else(|| {
            manifest
                .as_ref()
                .and_then(|manifest| manifest.description.clone())
        })
        .unwrap_or_default();

    let status = if manifest.is_some() {
        PluginStatus::Installed
    } else {
        PluginStatus::MissingInstall
    };

    EnrichedPlugin {
        configured_spec: resolved.entry.spec,
        package_name,
        scope: resolved.entry.scope,
        config_path: resolved.entry.config_path,
        manifest,
        catalog_metadata,
        display_name,
        description,
        status,
    }
}

pub fn resolve_plugins(entries: Vec<PluginEntry>) -> Vec<ResolvedPlugin> {
    let mut resolved = Vec::new();

    for entry in entries {
        let package_name = extract_package_name(&entry.spec);
        let manifest = get_installed_manifest(&entry.spec, &package_name).unwrap_or(None);

        resolved.push(ResolvedPlugin { entry, manifest });
    }

    resolved
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::provider::ConfigScope;
    use std::path::PathBuf;

    fn plugin_entry(spec: &str) -> PluginEntry {
        PluginEntry {
            spec: spec.to_string(),
            scope: ConfigScope::Project,
            config_path: PathBuf::from("/tmp/opencode.json"),
        }
    }

    #[test]
    fn extract_package_name_handles_scoped_and_unscoped_specs() {
        assert_eq!(extract_package_name("plugin@latest"), "plugin");
        assert_eq!(extract_package_name("plugin"), "plugin");
        assert_eq!(
            extract_package_name("@scope/plugin@latest"),
            "@scope/plugin"
        );
        assert_eq!(extract_package_name("@scope/plugin"), "@scope/plugin");
    }

    #[test]
    fn deduplicate_plugins_keeps_last_occurrence() {
        let entries = vec![
            plugin_entry("plugin@1.0.0"),
            plugin_entry("@scope/plugin@latest"),
            plugin_entry("plugin@2.0.0"),
        ];

        let deduplicated = deduplicate_plugins(entries);

        assert_eq!(deduplicated.len(), 2);
        assert_eq!(deduplicated[0].spec, "@scope/plugin@latest");
        assert_eq!(deduplicated[1].spec, "plugin@2.0.0");
    }

    #[test]
    fn enrich_plugin_uses_catalog_metadata_when_available() {
        let resolved = ResolvedPlugin {
            entry: plugin_entry("@capybearista/opencode-ram-monitor@latest"),
            manifest: None,
        };

        let enriched = enrich_plugin(resolved);

        assert_eq!(
            enriched.configured_spec,
            "@capybearista/opencode-ram-monitor@latest"
        );
        assert_eq!(enriched.package_name, "@capybearista/opencode-ram-monitor");
        assert_eq!(enriched.scope, ConfigScope::Project);
        assert_eq!(enriched.config_path, PathBuf::from("/tmp/opencode.json"));
        assert!(enriched.manifest.is_none());
        assert!(enriched.catalog_metadata.is_some());
        assert_eq!(enriched.display_name, "RAM Monitor");
        assert_eq!(
            enriched.description,
            "Monitor OpenCode's RAM usage per session in real time."
        );
        assert_eq!(enriched.status, PluginStatus::MissingInstall);
    }

    #[test]
    fn enrich_plugin_falls_back_to_manifest_metadata() {
        let resolved = ResolvedPlugin {
            entry: plugin_entry("custom-plugin@latest"),
            manifest: Some(PackageManifest {
                name: "Custom Manifest Name".to_string(),
                version: "1.0.0".to_string(),
                description: Some("Manifest description".to_string()),
                oc_plugin: None,
                engines: None,
            }),
        };

        let enriched = enrich_plugin(resolved);

        assert_eq!(enriched.package_name, "custom-plugin");
        assert_eq!(enriched.scope, ConfigScope::Project);
        assert_eq!(enriched.config_path, PathBuf::from("/tmp/opencode.json"));
        assert!(enriched.catalog_metadata.is_none());
        assert_eq!(enriched.display_name, "Custom Manifest Name");
        assert_eq!(enriched.description, "Manifest description");
        assert_eq!(enriched.status, PluginStatus::Installed);
    }
}
