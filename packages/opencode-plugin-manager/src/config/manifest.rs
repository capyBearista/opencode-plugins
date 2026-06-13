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

pub fn get_installed_manifest_from_path(
    manifest_path: &Path,
) -> Result<Option<PackageManifest>, CliError> {
    if !manifest_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(manifest_path)?;
    let manifest: PackageManifest = serde_json::from_str(&content)
        .map_err(|e| CliError::Parse(format!("Failed to parse package.json: {}", e)))?;

    Ok(Some(manifest))
}

pub fn get_installed_manifest(
    spec: &str,
    package_name: &str,
) -> Result<Option<PackageManifest>, CliError> {
    if let Some(proj_dirs) = ProjectDirs::from("", "", "opencode") {
        let manifest_path = installed_manifest_path(proj_dirs.cache_dir(), spec, package_name);

        return get_installed_manifest_from_path(&manifest_path);
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::{get_installed_manifest_from_path, installed_manifest_path};
    use crate::errors::CliError;
    use std::fs;
    use std::path::PathBuf;
    use tempfile::tempdir;

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

    #[test]
    fn get_installed_manifest_from_path_parses_manifest_contents() {
        let dir = tempdir().unwrap();
        let manifest_path = dir.path().join("package.json");

        fs::write(
            &manifest_path,
            r#"{"name":"plugin","version":"1.2.3","description":"desc"}"#,
        )
        .unwrap();

        let manifest = get_installed_manifest_from_path(&manifest_path)
            .unwrap()
            .unwrap();

        assert_eq!(manifest.name, "plugin");
        assert_eq!(manifest.version, "1.2.3");
        assert_eq!(manifest.description.as_deref(), Some("desc"));
    }

    #[test]
    fn get_installed_manifest_from_path_surfaces_parse_errors() {
        let dir = tempdir().unwrap();
        let manifest_path = dir.path().join("package.json");

        fs::write(&manifest_path, "not json").unwrap();

        let error = get_installed_manifest_from_path(&manifest_path).unwrap_err();

        assert!(matches!(error, CliError::Parse(_)));
    }
}
