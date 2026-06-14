use crate::catalog::{PluginMetadata, get_curated_metadata};
use crate::config::manifest::{PackageManifest, get_installed_manifest};
use crate::config::provider::{ConfigScope, PluginEntry};
use crate::errors::CliError;
use crate::registry::cache::UpdateNoticeCache;
use crate::version_util::versions_equal;
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallStatus {
    Installed,
    MissingInstall,
}

impl InstallStatus {
    pub fn as_json_label(&self) -> &'static str {
        match self {
            InstallStatus::Installed => "installed",
            InstallStatus::MissingInstall => "missing_install",
        }
    }
}

/// Classification of a plugin's update status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginStatus {
    /// Has a newer version available on npm.
    Outdated,
    /// Up to date (latest version matches installed version).
    Current,
    /// No registry data available (unresolved).
    Unresolved,
}

impl PluginStatus {
    pub fn as_json_label(&self) -> &'static str {
        match self {
            PluginStatus::Outdated => "outdated",
            PluginStatus::Current => "current",
            PluginStatus::Unresolved => "unresolved",
        }
    }
}

/// A plugin with its update classification.
#[derive(Debug)]
pub struct ClassifiedPlugin {
    pub plugin: EnrichedPlugin,
    pub status: PluginStatus,
}

/// Classify plugins into outdated, current, and unresolved groups.
///
/// Classification rules:
/// - **Current**: manifest exists, `latest_version` exists, and installed version
///   equals latest version (via [`versions_equal`]).
/// - **Outdated**: manifest exists, `latest_version` exists, and versions differ.
/// - **Unresolved**: no `latest_version` available, **or** no installed manifest
///   (a plugin with only a latest_version but no local install cannot be
///   meaningfully compared, so it goes to Unresolved).
pub fn classify_plugins(plugins: Vec<EnrichedPlugin>) -> Vec<ClassifiedPlugin> {
    plugins
        .into_iter()
        .map(|p| {
            let status = match p.latest_version {
                Some(ref latest) => match p.manifest.as_ref() {
                    Some(manifest) => {
                        if versions_equal(&manifest.version, latest) {
                            PluginStatus::Current
                        } else {
                            PluginStatus::Outdated
                        }
                    }
                    // No installed manifest → cannot compare versions, even if
                    // latest_version is known.
                    None => PluginStatus::Unresolved,
                },
                None => PluginStatus::Unresolved,
            };
            ClassifiedPlugin { plugin: p, status }
        })
        .collect()
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
    pub status: InstallStatus,
    pub latest_version: Option<String>,
    pub declared_latest_range: Option<String>,
}

#[derive(Debug)]
pub struct ResolvedPlugin {
    pub entry: PluginEntry,
    pub manifest: Option<PackageManifest>,
}

/// Extract the package name from a spec (strips version suffix).
///
/// Delegates to the canonical implementation in `safety::package_name_from_spec`
/// to avoid duplicating spec-parsing logic.
pub fn extract_package_name(spec: &str) -> String {
    crate::safety::package_name_from_spec(spec)
}

pub fn deduplicate_plugins(entries: Vec<PluginEntry>) -> Vec<PluginEntry> {
    let mut seen = HashSet::new();
    let mut deduplicated = Vec::with_capacity(entries.len());

    for entry in entries.into_iter().rev() {
        let package_name = extract_package_name(&entry.spec);
        if seen.insert((package_name, entry.scope)) {
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
        InstallStatus::Installed
    } else {
        InstallStatus::MissingInstall
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
        latest_version: None,
        declared_latest_range: None,
    }
}

pub fn resolve_plugins(entries: Vec<PluginEntry>) -> Result<Vec<ResolvedPlugin>, CliError> {
    let mut resolved = Vec::new();

    for entry in entries {
        let package_name = extract_package_name(&entry.spec);
        let manifest = get_installed_manifest(&entry.spec, &package_name)?;

        resolved.push(ResolvedPlugin { entry, manifest });
    }

    Ok(resolved)
}

pub fn enrich_with_latest_versions(
    mut plugins: Vec<EnrichedPlugin>,
    cache: &UpdateNoticeCache,
) -> Vec<EnrichedPlugin> {
    for plugin in &mut plugins {
        if let Some(notice) = cache
            .notices
            .iter()
            .find(|n| n.package_name == plugin.package_name)
        {
            plugin.latest_version = Some(notice.latest_version.clone());
            plugin.declared_latest_range = notice.declared_open_code_range.clone();
        }
    }

    plugins
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::provider::ConfigScope;
    use std::path::PathBuf;

    fn plugin_entry(spec: &str) -> PluginEntry {
        plugin_entry_in_scope(spec, ConfigScope::Project)
    }

    fn plugin_entry_in_scope(spec: &str, scope: ConfigScope) -> PluginEntry {
        PluginEntry {
            spec: spec.to_string(),
            scope,
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
    fn deduplicate_plugins_preserves_project_and_global_entries() {
        let entries = vec![
            plugin_entry_in_scope("plugin@1.0.0", ConfigScope::Project),
            plugin_entry_in_scope("plugin@2.0.0", ConfigScope::Global),
        ];

        let deduplicated = deduplicate_plugins(entries);

        assert_eq!(deduplicated.len(), 2);
        assert_eq!(deduplicated[0].scope, ConfigScope::Project);
        assert_eq!(deduplicated[1].scope, ConfigScope::Global);
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
        assert_eq!(enriched.status, InstallStatus::MissingInstall);
    }

    #[test]
    fn enrich_plugin_falls_back_to_manifest_metadata() {
        let resolved = ResolvedPlugin {
            entry: plugin_entry("custom-plugin@latest"),
            manifest: Some(PackageManifest {
                name: "Custom Manifest Name".to_string(),
                version: "1.0.0".to_string(),
                description: Some("Manifest description".to_string()),
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
        assert_eq!(enriched.status, InstallStatus::Installed);
        assert!(enriched.latest_version.is_none());
        assert!(enriched.declared_latest_range.is_none());
    }

    #[test]
    fn enrich_with_latest_versions_populates_from_cache() {
        use crate::registry::cache::{UpdateNotice, UpdateNoticeCache};

        let mut plugins = vec![
            EnrichedPlugin {
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
            },
            EnrichedPlugin {
                configured_spec: "plugin-b@latest".to_string(),
                package_name: "plugin-b".to_string(),
                scope: ConfigScope::Project,
                config_path: PathBuf::from("/tmp/opencode.json"),
                manifest: None,
                catalog_metadata: None,
                display_name: "plugin-b".to_string(),
                description: String::new(),
                status: InstallStatus::MissingInstall,
                latest_version: None,
                declared_latest_range: None,
            },
        ];

        let cache = UpdateNoticeCache {
            checked_at: 0,
            notices: vec![UpdateNotice {
                package_name: "plugin-a".to_string(),
                latest_version: "2.0.0".to_string(),
                installed_version: Some("1.0.0".to_string()),
                declared_open_code_range: Some(">=1.15.0".to_string()),
            }],
            cli_latest_version: None,
        };

        plugins = enrich_with_latest_versions(plugins, &cache);

        assert_eq!(plugins[0].latest_version.as_deref(), Some("2.0.0"));
        assert_eq!(
            plugins[0].declared_latest_range.as_deref(),
            Some(">=1.15.0")
        );
        assert!(plugins[1].latest_version.is_none());
        assert!(plugins[1].declared_latest_range.is_none());
    }

    #[test]
    fn classify_plugins_marks_outdated_when_latest_is_newer() {
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

        let classified = classify_plugins(plugins);
        assert_eq!(classified.len(), 1);
        assert_eq!(classified[0].status, PluginStatus::Outdated);
    }

    #[test]
    fn classify_plugins_marks_current_when_versions_match() {
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

        let classified = classify_plugins(plugins);
        assert_eq!(classified.len(), 1);
        assert_eq!(classified[0].status, PluginStatus::Current);
    }

    #[test]
    fn classify_plugins_marks_unresolved_when_no_latest() {
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

        let classified = classify_plugins(plugins);
        assert_eq!(classified.len(), 1);
        assert_eq!(classified[0].status, PluginStatus::Unresolved);
    }

    #[test]
    fn classify_plugins_marks_unresolved_when_manifest_missing_even_with_latest() {
        // A plugin with no installed manifest cannot be compared — even if
        // latest_version is known, it should not be classified as Outdated.
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

        let classified = classify_plugins(plugins);
        assert_eq!(classified[0].status, PluginStatus::Unresolved);
    }
}
