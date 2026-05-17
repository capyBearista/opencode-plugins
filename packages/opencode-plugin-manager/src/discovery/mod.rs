use crate::config::manifest::{get_installed_manifest, PackageManifest};
use crate::config::provider::PluginEntry;

pub struct ResolvedPlugin {
    pub entry: PluginEntry,
    pub manifest: Option<PackageManifest>,
}

pub fn resolve_plugins(entries: Vec<PluginEntry>) -> Vec<ResolvedPlugin> {
    let mut resolved = Vec::new();

    for entry in entries {
        // Extract package name from spec (e.g., @scope/pkg@1.0.0 -> @scope/pkg)
        let package_name = if entry.spec.starts_with('@') {
            let parts: Vec<&str> = entry.spec.split('@').collect();
            if parts.len() >= 3 {
                format!("@{}", parts[1])
            } else {
                entry.spec.clone()
            }
        } else {
            let parts: Vec<&str> = entry.spec.split('@').collect();
            parts[0].to_string()
        };

        let manifest = get_installed_manifest(&package_name).unwrap_or(None);

        resolved.push(ResolvedPlugin { entry, manifest });
    }

    resolved
}
