use crate::errors::CliError;
use directories::ProjectDirs;
use serde::Deserialize;
use std::fs;
use std::path::PathBuf;

#[derive(Deserialize, Debug)]
pub struct PackageManifest {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    #[serde(rename = "oc-plugin")]
    pub oc_plugin: Option<Vec<String>>,
    pub engines: Option<Engines>,
}

#[derive(Deserialize, Debug)]
pub struct Engines {
    pub opencode: Option<String>,
}

pub fn get_installed_manifest(package_name: &str) -> Result<Option<PackageManifest>, CliError> {
    let mut cache_dir = None;
    if let Some(proj_dirs) = ProjectDirs::from("", "", "opencode") {
        cache_dir = Some(proj_dirs.cache_dir().to_path_buf());
    }

    if let Some(cache) = cache_dir {
        // OpenCode sanitizes package names for the cache directory
        let sanitized_name = package_name.replace('/', "_").replace('@', "");
        let package_dir = cache
            .join("packages")
            .join(&sanitized_name)
            .join("node_modules")
            .join(package_name);
        let manifest_path = package_dir.join("package.json");

        if manifest_path.exists() {
            let content = fs::read_to_string(&manifest_path)?;
            let manifest: PackageManifest = serde_json::from_str(&content)
                .map_err(|e| CliError::Parse(format!("Failed to parse package.json: {}", e)))?;
            return Ok(Some(manifest));
        }
    }

    Ok(None)
}
