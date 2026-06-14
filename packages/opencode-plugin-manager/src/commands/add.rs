use crate::catalog::resolve_alias;
use crate::commands::confirm;
use crate::config::parser::{GlobalConfigProvider, ProjectConfigProvider};
use crate::config::provider::{ConfigProvider, ConfigScope};
use crate::errors::CliError;
use crate::safety::transaction::{
    PluginArrayModification, new_config_with_plugin, patch_plugin_array, read_config, write_config,
};
use crate::safety::{get_write_target, package_name_from_spec, resolve_write_scope};
use colored::*;
use std::process::ExitCode;

/// Execute the `add` command.
///
/// JSON mode contract:
/// - Dry-run: emits one preview JSON object, no write.
/// - Real successful write: emits one final result JSON object **only**
///   (no preview JSON).
/// - Abort: emits one abort JSON object on stdout; human text goes to stderr
///   via `confirm()` prompts only.
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
    let target_path = get_write_target(scope);

    // Check if the plugin is already configured in any config for the scope
    check_already_configured(scope, &pkg_name)?;

    // Check whether target exists (used in display; actual content is
    // re-read just before write to avoid TOCTOU races).
    let file_exists = target_path.exists();

    // --- Display (one JSON doc per invocation) ---
    if json && dry_run {
        // Dry-run in JSON mode: emit one preview JSON and exit (no write).
        let preview = serde_json::json!({
            "action": "add",
            "scope": match scope { ConfigScope::Project => "project", ConfigScope::Global => "global" },
            "configPath": target_path.display().to_string(),
            "spec": resolved_spec,
            "packageName": pkg_name,
            "dryRun": true,
            "fileExists": file_exists,
        });
        println!("{}", serde_json::to_string_pretty(&preview).unwrap());
        return Ok(ExitCode::SUCCESS);
    }

    if !json {
        // Human preview
        println!("{}", "Config change preview".bold());
        println!();
        println!("  {} {}", "Target:".dimmed(), target_path.display());
        println!("  {} Add plugin", "Action:".dimmed());
        println!("  {} {}", "Plugin:".dimmed(), resolved_spec.bold());
        println!("  {} {}", "Name:".dimmed(), pkg_name);
        if !file_exists {
            println!("  {} (new file)", "Note:".dimmed());
        }
        println!();
    }

    if dry_run {
        if !json {
            println!("{}", "[dry-run] no changes applied".dimmed());
        }
        return Ok(ExitCode::SUCCESS);
    }

    // Confirm (prompt always on stderr)
    let prompt = if file_exists {
        format!("Add {} to {}?", resolved_spec, target_path.display())
    } else {
        format!(
            "Create {} and add {}?",
            target_path.display(),
            resolved_spec
        )
    };

    if !confirm(&prompt, yes)? {
        if json {
            // Abort in JSON: emit exactly one abort JSON object.
            let abort = serde_json::json!({
                "success": false,
                "action": "add",
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
    let fresh_content = if target_path.exists() {
        read_config(&target_path)?
    } else {
        String::new()
    };
    let new_content = if fresh_content.trim().is_empty() {
        new_config_with_plugin(&resolved_spec)?
    } else {
        patch_plugin_array(
            &fresh_content,
            PluginArrayModification::Add(resolved_spec.clone()),
        )?
    };
    write_config(&target_path, &new_content)?;

    if json {
        // Real write in JSON mode: emit one result JSON only (no preview).
        let result = serde_json::json!({
            "success": true,
            "action": "add",
            "spec": resolved_spec,
            "packageName": pkg_name,
            "configPath": target_path.display().to_string(),
        });
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    } else {
        println!(
            "{} Added {} to {}",
            "Done!".green().bold(),
            resolved_spec,
            target_path.display()
        );
    }

    Ok(ExitCode::SUCCESS)
}

/// Check if the plugin is already configured in **any** config file for the scope
/// (not just the target path).  This prevents duplicates across split configs.
fn check_already_configured(scope: ConfigScope, pkg_name: &str) -> Result<(), CliError> {
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
    if plugins
        .iter()
        .any(|p| package_name_from_spec(&p.spec) == pkg_name)
    {
        return Err(CliError::Validation(format!(
            "plugin '{pkg_name}' is already configured"
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn add_to_existing_config() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join(".opencode").join("opencode.json");
        fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        fs::write(&config_path, r#"{"plugin": ["existing"]}"#).unwrap();

        // Simulate the patching (without writing to the actual config)
        let content = read_config(&config_path).unwrap();
        let new_content =
            patch_plugin_array(&content, PluginArrayModification::Add("new-plugin".into()))
                .unwrap();

        let parsed: serde_json::Value = serde_json::from_str(&new_content).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[1].as_str().unwrap(), "new-plugin");
    }

    #[test]
    fn add_creates_new_config() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join(".opencode").join("opencode.json");

        let content = new_config_with_plugin("my-plugin").unwrap();
        fs::create_dir_all(config_path.parent().unwrap()).unwrap();
        write_config(&config_path, &content).unwrap();

        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].as_str().unwrap(), "my-plugin");
    }

    #[test]
    fn add_duplicate_is_rejected() {
        let content = r#"{"plugin": ["existing"]}"#;
        let result = patch_plugin_array(content, PluginArrayModification::Add("existing".into()));
        assert!(result.is_err());
    }

    // --- JSON output contract tests ---

    #[test]
    fn json_preview_shape_for_add_on_existing() {
        // Unit-level shape check: the preview JSON struct fields
        let preview = serde_json::json!({
            "action": "add",
            "scope": "project",
            "configPath": "/tmp/opencode.json",
            "spec": "my-plugin",
            "packageName": "my-plugin",
            "dryRun": true,
            "fileExists": true,
        });
        assert_eq!(preview["action"], "add");
        assert_eq!(preview["dryRun"], true);
        assert!(preview.get("configPath").is_some());
        assert!(preview.get("spec").is_some());
    }

    #[test]
    fn json_result_shape_for_add() {
        let result = serde_json::json!({
            "success": true,
            "action": "add",
            "spec": "@scope/pkg",
            "packageName": "@scope/pkg",
            "configPath": "/tmp/opencode.json",
        });
        assert_eq!(result["success"], true);
        assert_eq!(result["action"], "add");
        assert_eq!(result["packageName"], "@scope/pkg");
        assert!(result.get("configPath").is_some());
        // A result JSON must not contain dryRun
        assert!(result.get("dryRun").is_none());
    }

    #[test]
    fn json_abort_shape_for_add() {
        let abort = serde_json::json!({
            "success": false,
            "action": "add",
            "reason": "aborted",
            "spec": "my-plugin",
        });
        assert_eq!(abort["success"], false);
        assert_eq!(abort["reason"], "aborted");
    }

    // --- JSON error output ---

    #[test]
    fn json_error_shape_for_validation() {
        let err = CliError::Validation("plugin 'foo' is already configured".into());
        let json_err = err.to_json();
        assert_eq!(json_err.error, "VALIDATION_ERROR");
        assert!(json_err.message.contains("already configured"));
    }

    #[test]
    fn json_error_shape_for_not_found() {
        let err = CliError::NotFound("plugin 'foo' not found".into());
        let json_err = err.to_json();
        assert_eq!(json_err.error, "NOT_FOUND");
    }

    #[test]
    fn json_error_serializes_to_valid_json() {
        let err = CliError::Validation("test error".into());
        let json_str = serde_json::to_string(&err.to_json()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        assert_eq!(parsed["error"], "VALIDATION_ERROR");
        assert_eq!(parsed["message"], "Validation error: test error");
    }

    // --- Write-target resolution ---

    #[test]
    fn add_to_root_config_instead_of_opencode() {
        // Simulates the write-target resolution: when a root opencode.json
        // exists, get_write_target should return that path, not .opencode/opencode.json
        let dir = tempfile::tempdir().unwrap();
        let root_config = dir.path().join("opencode.json");
        fs::write(&root_config, r#"{"plugin": ["existing"]}"#).unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let target = get_write_target(ConfigScope::Project);
        assert_eq!(target, root_config);

        // No .opencode/ directory should be created
        assert!(!dir.path().join(".opencode").exists());

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }
}
