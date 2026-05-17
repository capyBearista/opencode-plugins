use crate::errors::CliError;
use directories::ProjectDirs;
use serde::Deserialize;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

#[derive(Deserialize, Debug, Clone)]
pub struct PackageManifest {
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    #[serde(rename = "oc-plugin")]
    pub oc_plugin: Option<Vec<String>>,
    pub engines: Option<Engines>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Engines {
    pub opencode: Option<String>,
}

fn installed_manifest_path(cache_dir: &Path, spec: &str, package_name: &str) -> PathBuf {
    cache_dir
        .join("packages")
        .join(spec)
        .join("node_modules")
        .join(package_name)
        .join("package.json")
}

pub fn get_installed_manifest(
    spec: &str,
    package_name: &str,
) -> Result<Option<PackageManifest>, CliError> {
    if let Some(proj_dirs) = ProjectDirs::from("", "", "opencode") {
        let manifest_path = installed_manifest_path(proj_dirs.cache_dir(), spec, package_name);

        if manifest_path.exists() {
            let content = fs::read_to_string(&manifest_path)?;
            let manifest: PackageManifest = serde_json::from_str(&content)
                .map_err(|e| CliError::Parse(format!("Failed to parse package.json: {}", e)))?;
            return Ok(Some(manifest));
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::installed_manifest_path;
    use std::path::PathBuf;

    #[test]
    fn installed_manifest_path_uses_exact_spec_and_package_name() {
        let cache_dir = PathBuf::from("/home/test/.cache/opencode");
        let path = installed_manifest_path(&cache_dir, "@foo/bar@latest", "@foo/bar");

        assert_eq!(
            path,
            PathBuf::from(
                "/home/test/.cache/opencode/packages/@foo/bar@latest/node_modules/@foo/bar/package.json"
            )
        );
    }
}
