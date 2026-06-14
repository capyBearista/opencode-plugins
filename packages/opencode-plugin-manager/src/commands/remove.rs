use crate::catalog::resolve_alias;
use crate::commands::confirm;
use crate::config::parser::{GlobalConfigProvider, ProjectConfigProvider};
use crate::config::provider::{ConfigProvider, ConfigScope};
use crate::errors::CliError;
use crate::safety::transaction::{
    PluginArrayModification, patch_plugin_array, read_config, write_config,
};
use crate::safety::{package_name_from_spec, resolve_write_scope};
use colored::*;
use std::process::ExitCode;

/// Execute the `remove` command.
///
/// Uses the config provider to discover the **exact config path** where the
/// plugin is configured, then mutates only that file.  This ensures that
/// removing a plugin from a root-level `opencode.json` does not create a
/// split `.opencode/` configuration.
///
/// JSON mode contract:
/// - Dry-run: one preview JSON object, no write.
/// - Real successful write: one result JSON object only (no preview).
/// - Abort: one abort JSON object on stdout.
pub fn execute(
    plugin: &str,
    project: bool,
    global: bool,
    yes: bool,
    dry_run: bool,
    json: bool,
) -> Result<ExitCode, CliError> {
    let scope = resolve_write_scope(project, global)?;
    let resolved_spec = resolve_alias(plugin);
    let pkg_name = package_name_from_spec(&resolved_spec);

    // Find the plugin via the provider to get its exact config_path.
    let target_path = resolve_plugin_config_path(scope, &pkg_name)?;

    // Read the config
    if !target_path.exists() {
        return Err(CliError::NotFound(format!(
            "config file not found: {}",
            target_path.display()
        )));
    }

    // --- Display (one JSON doc per invocation) ---
    if json && dry_run {
        // Dry-run JSON: one preview, no write.
        let preview = serde_json::json!({
            "action": "remove",
            "scope": match scope { ConfigScope::Project => "project", ConfigScope::Global => "global" },
            "configPath": target_path.display().to_string(),
            "spec": resolved_spec,
            "packageName": pkg_name,
            "dryRun": true,
        });
        println!("{}", serde_json::to_string_pretty(&preview).unwrap());
        return Ok(ExitCode::SUCCESS);
    }

    if !json {
        println!("{}", "Config change preview".bold());
        println!();
        println!("  {} {}", "Target:".dimmed(), target_path.display());
        println!("  {} Remove plugin", "Action:".dimmed());
        println!("  {} {}", "Plugin:".dimmed(), resolved_spec.bold());
        println!("  {} {}", "Name:".dimmed(), pkg_name);
        println!();
        println!(
            "{}",
            "Note: cached plugin files may remain on disk.".dimmed()
        );
        println!();
    }

    if dry_run {
        if !json {
            println!("{}", "[dry-run] no changes applied".dimmed());
        }
        return Ok(ExitCode::SUCCESS);
    }

    // Confirm (prompt always on stderr)
    let prompt = format!("Remove {} from {}?", resolved_spec, target_path.display());

    if !confirm(&prompt, yes)? {
        if json {
            let abort = serde_json::json!({
                "success": false,
                "action": "remove",
                "reason": "aborted",
                "spec": resolved_spec,
            });
            println!("{}", serde_json::to_string_pretty(&abort).unwrap());
        } else {
            println!("{}", "Aborted.".dimmed());
        }
        return Ok(ExitCode::SUCCESS);
    }

    // Apply the change — re-read config to avoid TOCTOU race (another
    // process may have modified the file between preview and write).
    let fresh_content = read_config(&target_path)?;
    let new_content = patch_plugin_array(
        &fresh_content,
        PluginArrayModification::Remove(resolved_spec.clone()),
    )?;
    write_config(&target_path, &new_content)?;

    if json {
        let result = serde_json::json!({
            "success": true,
            "action": "remove",
            "spec": resolved_spec,
            "packageName": pkg_name,
            "configPath": target_path.display().to_string(),
        });
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    } else {
        println!(
            "{} Removed {} from {}",
            "Done!".green().bold(),
            resolved_spec,
            target_path.display()
        );
    }

    Ok(ExitCode::SUCCESS)
}

/// Find the config file where a plugin is configured, using the scope's
/// provider.  Returns an error if the plugin is not found.
fn resolve_plugin_config_path(
    scope: ConfigScope,
    pkg_name: &str,
) -> Result<std::path::PathBuf, CliError> {
    let provider: Box<dyn ConfigProvider> = match scope {
        ConfigScope::Project => {
            let cwd = std::env::current_dir().map_err(|e| CliError::Io {
                path: ".".to_string(),
                source: e,
            })?;
            Box::new(ProjectConfigProvider::new(cwd))
        }
        ConfigScope::Global => Box::new(GlobalConfigProvider::new()),
    };

    let plugins = provider.read_plugins()?;
    plugins
        .iter()
        .find(|p| package_name_from_spec(&p.spec) == pkg_name)
        .map(|p| p.config_path.clone())
        .ok_or_else(|| CliError::NotFound(format!("plugin '{pkg_name}' not found in config")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn remove_from_config() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        fs::write(
            &config_path,
            r#"{"plugin": ["keep", "remove-me", "also-keep"]}"#,
        )
        .unwrap();

        let content = read_config(&config_path).unwrap();
        let new_content = patch_plugin_array(
            &content,
            PluginArrayModification::Remove("remove-me".into()),
        )
        .unwrap();

        let parsed: serde_json::Value = serde_json::from_str(&new_content).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].as_str().unwrap(), "keep");
        assert_eq!(plugins[1].as_str().unwrap(), "also-keep");
    }

    #[test]
    fn remove_not_found_is_error() {
        let content = r#"{"plugin": ["existing"]}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Remove("nonexistent".into()),
        );
        assert!(result.is_err());
    }

    #[test]
    fn remove_by_package_name() {
        let content = r#"{"plugin": ["@scope/pkg@1.0.0", "other"]}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Remove("@scope/pkg".into()),
        )
        .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].as_str().unwrap(), "other");
    }

    #[test]
    fn remove_preserves_other_config() {
        let content = r#"{
  // my config
  "plugin": ["a", "b"],
  "other": true
}"#;
        let result =
            patch_plugin_array(content, PluginArrayModification::Remove("a".into())).unwrap();
        assert!(result.contains("other"));
        assert!(result.contains("my config"));
    }

    // --- JSON output contract tests ---

    #[test]
    fn json_preview_shape_for_remove() {
        let preview = serde_json::json!({
            "action": "remove",
            "scope": "project",
            "configPath": "/tmp/opencode.json",
            "spec": "my-plugin",
            "packageName": "my-plugin",
            "dryRun": true,
        });
        assert_eq!(preview["action"], "remove");
        assert_eq!(preview["dryRun"], true);
    }

    #[test]
    fn json_result_shape_for_remove() {
        let result = serde_json::json!({
            "success": true,
            "action": "remove",
            "spec": "my-plugin",
            "packageName": "my-plugin",
            "configPath": "/tmp/opencode.json",
        });
        assert_eq!(result["success"], true);
        assert_eq!(result["action"], "remove");
        assert_eq!(result["packageName"], "my-plugin");
        assert!(result.get("dryRun").is_none());
    }

    #[test]
    fn json_abort_shape_for_remove() {
        let abort = serde_json::json!({
            "success": false,
            "action": "remove",
            "reason": "aborted",
            "spec": "my-plugin",
        });
        assert_eq!(abort["success"], false);
        assert_eq!(abort["reason"], "aborted");
    }

    // --- Provider-based config_path resolution ---

    #[test]
    fn resolve_plugin_config_path_found() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        fs::write(&config_path, r#"{"plugin": ["@scope/pkg@1.0.0"]}"#).unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let result = resolve_plugin_config_path(ConfigScope::Project, "@scope/pkg");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), config_path);

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn resolve_plugin_config_path_not_found() {
        let dir = tempdir().unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let result = resolve_plugin_config_path(ConfigScope::Project, "nonexistent");
        assert!(result.is_err());

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }
}
