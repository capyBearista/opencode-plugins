pub mod transaction;

use crate::config::provider::ConfigScope;
use crate::errors::CliError;
use std::path::PathBuf;

/// Check if a plugin spec is pinned to an exact version.
///
/// Pinned examples: `@scope/pkg@1.2.3`, `pkg@1.0.0-beta.1`
/// Not pinned: `@scope/pkg`, `pkg`, `@scope/pkg@latest`, `pkg@^1.0.0`
pub fn is_pinned_version(spec: &str) -> bool {
    if let Some(version_part) = spec.rsplit_once('@').map(|(_, v)| v) {
        if version_part == "latest" {
            return false;
        }
        semver::Version::parse(version_part).is_ok()
    } else {
        false
    }
}

/// Extract the package name from a spec (strips version suffix).
pub fn package_name_from_spec(spec: &str) -> String {
    if spec.starts_with('@') {
        if let Some((scope, remainder)) = spec.split_once('/') {
            if let Some((name, _)) = remainder.rsplit_once('@') {
                return format!("{scope}/{name}");
            }
            return spec.to_string();
        }
        spec.to_string()
    } else {
        spec.rsplit_once('@')
            .map(|(name, _)| name.to_string())
            .unwrap_or_else(|| spec.to_string())
    }
}

/// Resolve the explicit scope from CLI flags, returning an error if
/// the combination is invalid for write commands.
pub fn resolve_write_scope(project: bool, global: bool) -> Result<ConfigScope, CliError> {
    match (project, global) {
        (true, false) => Ok(ConfigScope::Project),
        (false, true) => Ok(ConfigScope::Global),
        (true, true) => Err(CliError::Validation(
            "cannot specify both --project and --global".into(),
        )),
        (false, false) => Err(CliError::Validation(
            "must specify --project or --global for write commands".into(),
        )),
    }
}

/// Determine the canonical config file path to write to for a given scope.
///
/// For **project** scope, this checks existing project configs in OpenCode's
/// discovery order (`.opencode/opencode.jsonc`, `.opencode/opencode.json`,
/// root `opencode.jsonc`, root `opencode.json`) and returns the **first**
/// existing one.  This means `add` will prefer writing to an already-present
/// root-level `opencode.json` instead of creating a new `.opencode/` split.
/// If no project config exists, the default is `.opencode/opencode.json`.
///
/// For **global** scope, the behaviour mirrors the read side and is
/// unchanged.
pub fn get_write_target(scope: ConfigScope) -> PathBuf {
    match scope {
        ConfigScope::Project => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let project_root = if cwd.ends_with(".opencode") {
                cwd.parent().unwrap_or(&cwd).to_path_buf()
            } else {
                cwd
            };
            // Check existing project configs in OpenCode's discovery order.
            let candidates = [
                project_root.join(".opencode/opencode.jsonc"),
                project_root.join(".opencode/opencode.json"),
                project_root.join("opencode.jsonc"),
                project_root.join("opencode.json"),
            ];
            for path in &candidates {
                if path.exists() {
                    return path.clone();
                }
            }
            // No existing config found — default to .opencode/opencode.json
            project_root.join(".opencode").join("opencode.json")
        }
        ConfigScope::Global => {
            let dir = directories::ProjectDirs::from("", "", "opencode")
                .map(|dirs| dirs.config_dir().to_path_buf())
                .unwrap_or_else(|| PathBuf::from("."));
            prefer_jsonc_if_exists(&dir)
        }
    }
}

/// If `dir/opencode.jsonc` exists, return that path; otherwise `dir/opencode.json`.
fn prefer_jsonc_if_exists(dir: &std::path::Path) -> PathBuf {
    let jsonc = dir.join("opencode.jsonc");
    if jsonc.exists() {
        jsonc
    } else {
        dir.join("opencode.json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn pinned_version_detection() {
        // Exact versions are pinned
        assert!(is_pinned_version("@scope/pkg@1.2.3"));
        assert!(is_pinned_version("pkg@1.2.3"));
        assert!(is_pinned_version("@scope/pkg@1.0.0-beta.1"));
        assert!(is_pinned_version("@scope/pkg@1.0.0+build.123"));

        // Not pinned
        assert!(!is_pinned_version("@scope/pkg"));
        assert!(!is_pinned_version("pkg"));
        assert!(!is_pinned_version("@scope/pkg@latest"));
        assert!(!is_pinned_version("pkg@latest"));
        assert!(!is_pinned_version("@scope/pkg@^1.0.0"));
        assert!(!is_pinned_version("pkg@~1.0.0"));
        assert!(!is_pinned_version("pkg@>=1.0.0"));
    }

    #[test]
    fn package_name_extraction() {
        assert_eq!(package_name_from_spec("@scope/pkg@1.2.3"), "@scope/pkg");
        assert_eq!(package_name_from_spec("@scope/pkg"), "@scope/pkg");
        assert_eq!(package_name_from_spec("pkg@1.2.3"), "pkg");
        assert_eq!(package_name_from_spec("pkg"), "pkg");
        assert_eq!(package_name_from_spec("@scope/pkg@latest"), "@scope/pkg");
    }

    #[test]
    fn resolve_scope_requires_exactly_one_flag() {
        assert!(matches!(
            resolve_write_scope(true, false),
            Ok(ConfigScope::Project)
        ));
        assert!(matches!(
            resolve_write_scope(false, true),
            Ok(ConfigScope::Global)
        ));
        assert!(resolve_write_scope(true, true).is_err());
        assert!(resolve_write_scope(false, false).is_err());
    }

    #[test]
    fn prefer_jsonc_when_exists() {
        let dir = tempfile::tempdir().unwrap();
        let jsonc = dir.path().join("opencode.jsonc");
        std::fs::write(&jsonc, "{}").unwrap();

        let result = prefer_jsonc_if_exists(dir.path());
        assert_eq!(result, jsonc);
    }

    #[test]
    fn prefer_json_when_jsonc_missing() {
        let dir = tempfile::tempdir().unwrap();
        let expected = dir.path().join("opencode.json");

        let result = prefer_jsonc_if_exists(dir.path());
        assert_eq!(result, expected);
    }

    #[test]
    fn get_write_target_for_project_prefers_opencode_dir_over_root() {
        let dir = tempfile::tempdir().unwrap();
        // Create both .opencode/opencode.json AND root opencode.json
        let opencode_dir = dir.path().join(".opencode");
        fs::create_dir_all(&opencode_dir).unwrap();
        fs::write(opencode_dir.join("opencode.json"), r#"{"plugin":["a"]}"#).unwrap();
        fs::write(dir.path().join("opencode.json"), r#"{"plugin":["b"]}"#).unwrap();

        // Temporarily override cwd
        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let target = get_write_target(ConfigScope::Project);
        assert_eq!(target, opencode_dir.join("opencode.json"));

        // Restore cwd
        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn get_write_target_for_project_uses_root_json_when_no_opencode_dir() {
        let dir = tempfile::tempdir().unwrap();
        // Only root-level opencode.json
        fs::write(dir.path().join("opencode.json"), r#"{"plugin":["a"]}"#).unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let target = get_write_target(ConfigScope::Project);
        assert_eq!(target, dir.path().join("opencode.json"));

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn get_write_target_for_project_defaults_to_opencode_json_when_none_exist() {
        let dir = tempfile::tempdir().unwrap();
        // No config files at all

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let target = get_write_target(ConfigScope::Project);
        assert_eq!(target, dir.path().join(".opencode/opencode.json"));

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn get_write_target_for_project_prefers_root_jsonc_over_root_json() {
        let dir = tempfile::tempdir().unwrap();
        // Only root-level opencode.jsonc (no .opencode/)
        fs::write(dir.path().join("opencode.jsonc"), r#"{"plugin":["a"]}"#).unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let target = get_write_target(ConfigScope::Project);
        assert_eq!(target, dir.path().join("opencode.jsonc"));

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn get_write_target_for_project_no_stray_config_created_when_root_exists() {
        let dir = tempfile::tempdir().unwrap();
        // Only root-level opencode.json
        fs::write(dir.path().join("opencode.json"), r#"{"plugin":["a"]}"#).unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let target = get_write_target(ConfigScope::Project);
        // Should NOT point to .opencode/opencode.json
        assert_eq!(target, dir.path().join("opencode.json"));
        // Should NOT have created a .opencode directory
        assert!(!dir.path().join(".opencode").exists());

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }
}
