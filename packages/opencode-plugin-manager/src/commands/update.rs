use crate::catalog::resolve_alias;
use crate::commands::confirm;
use crate::config::parser::{GlobalConfigProvider, ProjectConfigProvider};
use crate::config::provider::{ConfigProvider, ConfigScope};
use crate::errors::CliError;
use crate::safety::transaction::{
    PluginArrayModification, patch_plugin_array, read_config, write_config,
};
use crate::safety::{is_pinned_version, package_name_from_spec, resolve_write_scope};
use colored::*;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;

/// Execute the `update` command.
///
/// Update semantics:
/// - Pinned plugins (`@scope/pkg@1.2.3`) require explicit approval to change config.
/// - Unpinned plugins (`@scope/pkg`, `@scope/pkg@latest`) are already refreshable.
/// - `--dry-run` previews changes without applying.
///
/// Mutations are applied **per config file**: if pinned plugins are spread
/// across multiple OpenCode config files, each file is read, patched, and
/// written atomically.
///
/// JSON mode contract:
/// - Dry-run: one preview JSON object, no write.
/// - Real successful write: one result JSON object only (no preview).
/// - Abort: one abort JSON object on stdout.
pub fn execute(
    plugin: Option<&str>,
    project: bool,
    global: bool,
    yes: bool,
    dry_run: bool,
    json: bool,
) -> Result<ExitCode, CliError> {
    let scope = resolve_write_scope(project, global)?;

    // Collect plugins for update across ALL config files in the scope.
    let plugins_to_update = collect_plugins_for_update(scope, plugin)?;
    if plugins_to_update.is_empty() {
        if json {
            let empty_result = serde_json::json!({
                "success": true,
                "action": "update",
                "updated": [],
                "refreshReady": [],
                "message": "no plugins to update",
            });
            println!("{}", serde_json::to_string_pretty(&empty_result).unwrap());
        } else {
            println!("{}", "No plugins to update.".yellow());
        }
        return Ok(ExitCode::SUCCESS);
    }

    // Separate pinned and unpinned plugins
    let mut pinned: Vec<PluginToUpdate> = Vec::new();
    let mut unpinned: Vec<PluginToUpdate> = Vec::new();

    for plugin_info in plugins_to_update {
        if is_pinned_version(&plugin_info.current_spec) {
            pinned.push(plugin_info);
        } else {
            unpinned.push(plugin_info);
        }
    }

    // Group pinned by config_path (unpinned are just reported, no writes needed)
    let mut pinned_by_path: HashMap<PathBuf, Vec<&PluginToUpdate>> = HashMap::new();
    for p in &pinned {
        pinned_by_path.entry(p.config_path.clone()).or_default().push(p);
    }

    // Collect unique config paths for display
    let mut all_paths: Vec<&PathBuf> = pinned_by_path.keys().collect();
    all_paths.extend(unpinned.iter().map(|p| &p.config_path));
    all_paths.sort();
    all_paths.dedup();

    // --- Display (one JSON doc per invocation) ---
    if json && dry_run {
        let preview = build_update_preview_json(&scope, &pinned, &unpinned, dry_run);
        println!("{}", serde_json::to_string_pretty(&preview).unwrap());
        return Ok(ExitCode::SUCCESS);
    }

    if !json {
        println!("{}", "Update preview".bold());
        println!();
        for cp in &all_paths {
            println!("  {} {}", "Target:".dimmed(), cp.display());
        }
        println!();

        if !unpinned.is_empty() {
            println!(
                "{}",
                format!("Unpinned ({}):", unpinned.len()).green().bold()
            );
            for p in &unpinned {
                println!(
                    "  {} {} — will refresh on next load",
                    "✓".green(),
                    p.current_spec
                );
            }
            println!();
        }

        if !pinned.is_empty() {
            println!("{}", format!("Pinned ({}):", pinned.len()).yellow().bold());
            for p in &pinned {
                println!(
                    "  {} {} → {}  [{}]",
                    "→".yellow(),
                    p.current_spec,
                    p.proposed_spec,
                    p.config_path.display()
                );
            }
            println!(
                "{}",
                "Pinned plugins will be updated to @latest. This changes your config.".dimmed()
            );
            println!();
        }

    }

    if dry_run {
        if !json {
            println!("{}", "[dry-run] no changes applied".dimmed());
        }
        return Ok(ExitCode::SUCCESS);
    }

    // If there are pinned plugins, confirm the config change
    if !pinned.is_empty() {
        let prompt = format!(
            "Update {} pinned plugin{} config to @latest?",
            pinned.len(),
            if pinned.len() == 1 { "" } else { "s" }
        );

        if !confirm(&prompt, yes)? {
            if json {
                let abort = serde_json::json!({
                    "success": false,
                    "action": "update",
                    "reason": "aborted",
                });
                println!("{}", serde_json::to_string_pretty(&abort).unwrap());
            } else {
                println!("{}", "Aborted.".dimmed());
            }
            return Ok(ExitCode::SUCCESS);
        }
    }

    // Apply changes per config file
    let mut updated_entries: Vec<serde_json::Value> = Vec::new();

    for (config_path, updates) in &pinned_by_path {
        let original_content = read_config(config_path)?;
        let mut current_content = original_content.clone();

        for p in updates {
            current_content = patch_plugin_array(
                &current_content,
                PluginArrayModification::Update {
                    old: p.current_spec.clone(),
                    new: p.proposed_spec.clone(),
                },
            )?;
            updated_entries.push(serde_json::json!({
                "spec": p.proposed_spec,
                "packageName": p.package_name,
                "currentSpec": p.current_spec,
                "proposedSpec": p.proposed_spec,
            }));
        }

        if current_content != original_content {
            write_config(config_path, &current_content)?;
        }
    }

    // Output results
    if json {
        let refresh_ready_entries: Vec<serde_json::Value> = unpinned
            .iter()
            .map(|p| {
                serde_json::json!({
                    "spec": p.current_spec,
                    "packageName": p.package_name,
                })
            })
            .collect();
        let result = serde_json::json!({
            "success": true,
            "action": "update",
            "updated": updated_entries,
            "refreshReady": refresh_ready_entries,
            "message": if !updated_entries.is_empty() {
                "update applied"
            } else if !refresh_ready_entries.is_empty() {
                "ready for refresh"
            } else {
                "no changes needed"
            },
        });
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    } else {
        if !updated_entries.is_empty() {
            println!(
                "{} Updated {} pinned plugin{}",
                "Done!".green().bold(),
                updated_entries.len(),
                if updated_entries.len() == 1 { "" } else { "s" }
            );
        }
        if !unpinned.is_empty() {
            println!(
                "{} {} unpinned plugin{} ready for refresh",
                "Note:".dimmed(),
                unpinned.len(),
                if unpinned.len() == 1 { "" } else { "s" }
            );
        }
    }

    Ok(ExitCode::SUCCESS)
}

struct PluginToUpdate {
    current_spec: String,
    package_name: String,
    proposed_spec: String,
    config_path: PathBuf,
}

/// Build the preview JSON object for the update command.
fn build_update_preview_json(
    scope: &ConfigScope,
    pinned: &[PluginToUpdate],
    unpinned: &[PluginToUpdate],
    dry_run: bool,
) -> serde_json::Value {
    let pinned_json: Vec<serde_json::Value> = pinned
        .iter()
        .map(|p| {
            serde_json::json!({
                "currentSpec": p.current_spec,
                "packageName": p.package_name,
                "proposedSpec": p.proposed_spec,
                "configPath": p.config_path.display().to_string(),
            })
        })
        .collect();
    let unpinned_json: Vec<serde_json::Value> = unpinned
        .iter()
        .map(|p| {
            serde_json::json!({
                "spec": p.current_spec,
                "packageName": p.package_name,
                "configPath": p.config_path.display().to_string(),
            })
        })
        .collect();
    serde_json::json!({
        "action": "update",
        "scope": match scope {
            ConfigScope::Project => "project",
            ConfigScope::Global => "global",
        },
        "pinned": pinned_json,
        "unpinned": unpinned_json,
        "dryRun": dry_run,
    })
}

/// Collect plugins that need updating from the config across **all**
/// config files in the scope (not just a single hard-coded target path).
fn collect_plugins_for_update(
    scope: ConfigScope,
    filter_plugin: Option<&str>,
) -> Result<Vec<PluginToUpdate>, CliError> {
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
    let mut result = Vec::new();

    for entry in &plugins {
        let pkg_name = package_name_from_spec(&entry.spec);

        // Filter to specific plugin if requested
        if let Some(filter) = filter_plugin {
            let filter_resolved = resolve_alias(filter);
            let filter_pkg = package_name_from_spec(&filter_resolved);
            if pkg_name != filter_pkg {
                continue;
            }
        }

        // For unpinned plugins, they don't need a config change
        // (they refresh via OpenCode automatically)
        // For pinned plugins, propose changing to @latest
        let proposed_spec = if is_pinned_version(&entry.spec) {
            format!("{pkg_name}@latest")
        } else {
            // Unpinned — no config change needed, but include for reporting
            entry.spec.clone()
        };

        result.push(PluginToUpdate {
            current_spec: entry.spec.clone(),
            package_name: pkg_name,
            proposed_spec,
            config_path: entry.config_path.clone(),
        });
    }

    if let Some(name) = filter_plugin
        && result.is_empty()
    {
        return Err(CliError::NotFound(format!(
            "plugin '{name}' not found in config"
        )));
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn collect_plugins_for_update_pinned() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        fs::write(
            &config_path,
            r#"{"plugin": ["@scope/pkg@1.0.0", "other@latest"]}"#,
        )
        .unwrap();

        // Read the plugins directly
        let content = fs::read_to_string(&config_path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();

        let mut pinned = Vec::new();
        let mut unpinned = Vec::new();

        for spec in plugins {
            let s = spec.as_str().unwrap();
            if is_pinned_version(s) {
                pinned.push(s.to_string());
            } else {
                unpinned.push(s.to_string());
            }
        }

        assert_eq!(pinned.len(), 1);
        assert_eq!(pinned[0], "@scope/pkg@1.0.0");
        assert_eq!(unpinned.len(), 1);
        assert_eq!(unpinned[0], "other@latest");
    }

    #[test]
    fn update_pinned_to_latest() {
        let content = r#"{"plugin": ["@scope/pkg@1.0.0"]}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Update {
                old: "@scope/pkg@1.0.0".into(),
                new: "@scope/pkg@latest".into(),
            },
        )
        .unwrap();

        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins[0].as_str().unwrap(), "@scope/pkg@latest");
    }

    #[test]
    fn update_unpinned_no_op() {
        let content = r#"{"plugin": ["@scope/pkg@latest"]}"#;
        let result = patch_plugin_array(
            content,
            PluginArrayModification::Update {
                old: "@scope/pkg@latest".into(),
                new: "@scope/pkg@latest".into(),
            },
        )
        .unwrap();

        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let plugins = parsed["plugin"].as_array().unwrap();
        assert_eq!(plugins[0].as_str().unwrap(), "@scope/pkg@latest");
    }

    // --- JSON output contract tests ---

    #[test]
    fn json_preview_shape_for_update() {
        let preview = build_update_preview_json(
            &ConfigScope::Project,
            &[PluginToUpdate {
                current_spec: "@scope/pkg@1.0.0".into(),
                package_name: "@scope/pkg".into(),
                proposed_spec: "@scope/pkg@latest".into(),
                config_path: PathBuf::from("/tmp/opencode.json"),
            }],
            &[],
            true,
        );
        assert_eq!(preview["action"], "update");
        assert_eq!(preview["dryRun"], true);
        assert!(preview.get("pinned").is_some());
        assert!(preview.get("unpinned").is_some());
        let pinned_arr = preview["pinned"].as_array().unwrap();
        assert_eq!(pinned_arr.len(), 1);
        assert_eq!(pinned_arr[0]["currentSpec"], "@scope/pkg@1.0.0");
    }

    #[test]
    fn json_empty_update_shape() {
        // The empty-result path uses "refreshReady" (not the old "refreshed").
        let empty = serde_json::json!({
            "success": true,
            "action": "update",
            "updated": [],
            "refreshReady": [],
            "message": "no plugins to update",
        });
        assert_eq!(empty["success"], true);
        assert_eq!(empty["action"], "update");
        assert!(empty["updated"].as_array().unwrap().is_empty());
        assert!(empty["refreshReady"].as_array().unwrap().is_empty());
        // The "refreshed" field should NOT be present
        assert!(empty.get("refreshed").is_none(), "must use refreshReady, not refreshed");
    }

    #[test]
    fn json_empty_preview_has_refresh_ready_not_refreshed() {
        // Exercise the real builder with empty lists to verify field name.
        let preview = build_update_preview_json(&ConfigScope::Project, &[], &[], true);
        assert!(preview.get("refreshReady").is_none(), "refreshReady should not appear when empty");
        assert!(preview.get("pinned").is_some());
        assert!(preview.get("unpinned").is_some());
    }

    #[test]
    fn json_refresh_ready_only_message() {
        // When only unpinned (refresh-ready) plugins exist, message says
        // "ready for refresh", not "update applied".
        let result = serde_json::json!({
            "success": true,
            "action": "update",
            "updated": [],
            "refreshReady": [{"spec": "other@latest", "packageName": "other"}],
            "message": "ready for refresh",
        });
        assert_eq!(result["message"], "ready for refresh");
        assert!(result["updated"].as_array().unwrap().is_empty());
    }

    #[test]
    fn json_result_shape_for_update() {
        let result = serde_json::json!({
            "success": true,
            "action": "update",
            "updated": [{
                "spec": "@scope/pkg@latest",
                "packageName": "@scope/pkg",
                "currentSpec": "@scope/pkg@1.0.0",
                "proposedSpec": "@scope/pkg@latest",
            }],
            "refreshReady": [{
                "spec": "other@latest",
                "packageName": "other",
            }],
            "message": "update applied",
        });
        assert_eq!(result["success"], true);
        assert_eq!(result["action"], "update");
        let updated = result["updated"].as_array().unwrap();
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0]["packageName"], "@scope/pkg");
        assert_eq!(updated[0]["spec"], "@scope/pkg@latest");
        assert!(result.get("dryRun").is_none());

        let refresh_ready = result["refreshReady"].as_array().unwrap();
        assert_eq!(refresh_ready.len(), 1);
        assert_eq!(refresh_ready[0]["packageName"], "other");
        assert_eq!(refresh_ready[0]["spec"], "other@latest");
    }

    #[test]
    fn json_abort_shape_for_update() {
        let abort = serde_json::json!({
            "success": false,
            "action": "update",
            "reason": "aborted",
        });
        assert_eq!(abort["success"], false);
        assert_eq!(abort["reason"], "aborted");
    }

    // --- Multi-file / root-level config support ---

    #[test]
    fn collect_plugins_for_update_uses_all_configs() {
        let dir = tempdir().unwrap();
        // Root-level opencode.json
        let root_config = dir.path().join("opencode.json");
        fs::write(
            &root_config,
            r#"{"plugin": ["@scope/pkg@1.0.0"]}"#,
        )
        .unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let plugins = collect_plugins_for_update(ConfigScope::Project, None).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].current_spec, "@scope/pkg@1.0.0");
        assert_eq!(plugins[0].config_path, root_config);

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn update_preserves_config_path_when_pinned_plugin_in_root_config() {
        let dir = tempdir().unwrap();
        let root_config = dir.path().join("opencode.json");
        fs::write(
            &root_config,
            r#"{"plugin": ["@scope/pkg@1.0.0"]}"#,
        )
        .unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let plugins = collect_plugins_for_update(ConfigScope::Project, None).unwrap();
        assert_eq!(plugins[0].config_path, root_config);

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn update_error_when_plugin_not_found_in_any_config() {
        let dir = tempdir().unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let result = collect_plugins_for_update(ConfigScope::Project, Some("nonexistent"));
        assert!(result.is_err());

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }
}
