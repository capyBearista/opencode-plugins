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
/// - `--refresh` pins every managed plugin to the exact latest version from npm.
///
/// Mutations are applied **per config file**: if plugins are spread across
/// multiple OpenCode config files, each file is read, patched, and written
/// atomically.
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
    refresh_versions: Option<&HashMap<String, String>>,
) -> Result<ExitCode, CliError> {
    let scope = resolve_write_scope(project, global)?;
    let refresh_active = refresh_versions.is_some();

    // Collect plugins for update across ALL config files in the scope.
    let plugins_to_update = collect_plugins_for_update(scope, plugin, refresh_versions)?;
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

    // Separate plugins that need a config write from those that don't
    let mut needs_write: Vec<PluginToUpdate> = Vec::new();
    let mut refresh_ready: Vec<PluginToUpdate> = Vec::new();
    let mut up_to_date: Vec<PluginToUpdate> = Vec::new();
    let mut skipped: Vec<PluginToUpdate> = Vec::new();

    for p in plugins_to_update {
        if p.needs_write {
            needs_write.push(p);
        } else {
            match p.no_write_reason {
                Some(NoWriteReason::RefreshReady) => refresh_ready.push(p),
                Some(NoWriteReason::AlreadyCurrent) | None => up_to_date.push(p),
                Some(NoWriteReason::SkippedMissingVersion) => skipped.push(p),
            }
        }
    }

    // Group needs_write by config_path
    let mut write_by_path: HashMap<PathBuf, Vec<&PluginToUpdate>> = HashMap::new();
    for p in &needs_write {
        write_by_path
            .entry(p.config_path.clone())
            .or_default()
            .push(p);
    }

    // Collect unique config paths for display
    let mut all_paths: Vec<&PathBuf> = write_by_path.keys().collect();
    all_paths.extend(refresh_ready.iter().map(|p| &p.config_path));
    all_paths.extend(up_to_date.iter().map(|p| &p.config_path));
    all_paths.extend(skipped.iter().map(|p| &p.config_path));
    all_paths.sort();
    all_paths.dedup();

    // --- Display (one JSON doc per invocation) ---
    if json && dry_run {
        let preview = build_update_preview_json(
            &scope,
            &needs_write,
            &refresh_ready,
            &up_to_date,
            &skipped,
            dry_run,
        );
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

        if !refresh_ready.is_empty() {
            println!(
                "{}",
                format!("Unpinned ({}):", refresh_ready.len())
                    .green()
                    .bold()
            );
            for p in &refresh_ready {
                println!(
                    "  {} {} — will refresh on next load",
                    "✓".green(),
                    p.current_spec
                );
            }
            println!();
        }

        if !up_to_date.is_empty() {
            println!(
                "{}",
                format!("Already current ({}):", up_to_date.len())
                    .green()
                    .bold()
            );
            for p in &up_to_date {
                println!(
                    "  {} {} — already pinned to latest",
                    "✓".green(),
                    p.current_spec
                );
            }
            println!();
        }

        if !skipped.is_empty() {
            println!(
                "{}",
                format!("Skipped ({}):", skipped.len()).yellow().bold()
            );
            for p in &skipped {
                println!(
                    "  {} {} — latest version unavailable",
                    "!".yellow(),
                    p.current_spec
                );
            }
            println!();
        }

        if !needs_write.is_empty() {
            let heading = if refresh_active {
                format!("Pinning to exact version ({}):", needs_write.len())
            } else {
                format!("Pinned ({}):", needs_write.len())
            };
            println!("{}", heading.yellow().bold());
            for p in &needs_write {
                println!(
                    "  {} {} → {}  [{}]",
                    "→".yellow(),
                    p.current_spec,
                    p.proposed_spec,
                    p.config_path.display()
                );
            }
            let msg = if refresh_active {
                "Plugins will be pinned to exact versions. This changes your config."
            } else {
                "Pinned plugins will be updated to @latest. This changes your config."
            };
            println!("{}", msg.dimmed());
            println!();
        }
    }

    if dry_run {
        if !json {
            println!("{}", "[dry-run] no changes applied".dimmed());
        }
        return Ok(ExitCode::SUCCESS);
    }

    // If there are config changes, confirm
    if !needs_write.is_empty() {
        let prompt = if refresh_active {
            format!(
                "Pin {} plugin{} to exact latest version?",
                needs_write.len(),
                if needs_write.len() == 1 { "" } else { "s" }
            )
        } else {
            format!(
                "Update {} pinned plugin{} config to @latest?",
                needs_write.len(),
                if needs_write.len() == 1 { "" } else { "s" }
            )
        };

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

    for (config_path, updates) in &write_by_path {
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
        let refresh_ready_entries: Vec<serde_json::Value> = refresh_ready
            .iter()
            .map(|p| {
                serde_json::json!({
                    "spec": p.current_spec,
                    "packageName": p.package_name,
                })
            })
            .collect();
        let up_to_date_entries: Vec<serde_json::Value> = up_to_date
            .iter()
            .map(|p| {
                serde_json::json!({
                    "spec": p.current_spec,
                    "packageName": p.package_name,
                })
            })
            .collect();
        let skipped_entries: Vec<serde_json::Value> = skipped
            .iter()
            .map(|p| {
                serde_json::json!({
                    "spec": p.current_spec,
                    "packageName": p.package_name,
                    "reason": "latest version unavailable",
                })
            })
            .collect();
        let result = serde_json::json!({
            "success": true,
            "action": "update",
            "updated": updated_entries,
            "refreshReady": refresh_ready_entries,
            "upToDate": up_to_date_entries,
            "skipped": skipped_entries,
            "message": if !updated_entries.is_empty() {
                "update applied"
            } else if !refresh_ready_entries.is_empty() {
                "ready for refresh"
            } else if !up_to_date_entries.is_empty() {
                "already up to date"
            } else {
                "no changes needed"
            },
        });
        println!("{}", serde_json::to_string_pretty(&result).unwrap());
    } else {
        if !updated_entries.is_empty() {
            if refresh_active {
                println!(
                    "{} Pinned {} plugin{} to exact version{}",
                    "Done!".green().bold(),
                    updated_entries.len(),
                    if updated_entries.len() == 1 { "" } else { "s" },
                    if updated_entries.len() == 1 { "" } else { "s" },
                );
            } else {
                println!(
                    "{} Updated {} pinned plugin{}",
                    "Done!".green().bold(),
                    updated_entries.len(),
                    if updated_entries.len() == 1 { "" } else { "s" }
                );
            }
        }
        if !refresh_ready.is_empty() {
            println!(
                "{} {} unpinned plugin{} ready for refresh",
                "Note:".dimmed(),
                refresh_ready.len(),
                if refresh_ready.len() == 1 { "" } else { "s" }
            );
        }
        if !up_to_date.is_empty() {
            println!(
                "{} {} plugin{} already pinned to latest",
                "Note:".dimmed(),
                up_to_date.len(),
                if up_to_date.len() == 1 { "" } else { "s" }
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
    needs_write: bool,
    no_write_reason: Option<NoWriteReason>,
}

#[derive(Clone, Copy)]
enum NoWriteReason {
    RefreshReady,
    AlreadyCurrent,
    SkippedMissingVersion,
}

/// Build the preview JSON object for the update command.
fn build_update_preview_json(
    scope: &ConfigScope,
    pinned: &[PluginToUpdate],
    unpinned: &[PluginToUpdate],
    up_to_date: &[PluginToUpdate],
    skipped: &[PluginToUpdate],
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
    let up_to_date_json: Vec<serde_json::Value> = up_to_date
        .iter()
        .map(|p| {
            serde_json::json!({
                "spec": p.current_spec,
                "packageName": p.package_name,
                "configPath": p.config_path.display().to_string(),
            })
        })
        .collect();
    let skipped_json: Vec<serde_json::Value> = skipped
        .iter()
        .map(|p| {
            serde_json::json!({
                "spec": p.current_spec,
                "packageName": p.package_name,
                "configPath": p.config_path.display().to_string(),
                "reason": "latest version unavailable",
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
        "upToDate": up_to_date_json,
        "skipped": skipped_json,
        "dryRun": dry_run,
    })
}

/// Collect plugins that need updating from the config across **all**
/// config files in the scope (not just a single hard-coded target path).
///
/// When `refresh_versions` is provided, every matching plugin is proposed
/// to be pinned to the exact latest version from npm.
fn collect_plugins_for_update(
    scope: ConfigScope,
    filter_plugin: Option<&str>,
    refresh_versions: Option<&HashMap<String, String>>,
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
        let resolved_spec = resolve_alias(&entry.spec);
        let pkg_name = package_name_from_spec(&resolved_spec);

        // Filter to specific plugin if requested
        if let Some(filter) = filter_plugin {
            let filter_resolved = resolve_alias(filter);
            let filter_pkg = package_name_from_spec(&filter_resolved);
            if pkg_name != filter_pkg {
                continue;
            }
        }

        let pinned = is_pinned_version(&entry.spec);

        // Determine proposed spec and whether a config write is needed
        let (proposed_spec, needs_write, no_write_reason) = if let Some(versions) = refresh_versions
        {
            if let Some(version) = versions.get(&pkg_name) {
                // --refresh: pin to exact version
                let exact = format!("{pkg_name}@{version}");
                let needs_write = exact != entry.spec;
                let reason = (!needs_write).then_some(NoWriteReason::AlreadyCurrent);
                (exact, needs_write, reason)
            } else {
                // Missing registry data should never loosen a pin to @latest.
                (
                    entry.spec.clone(),
                    false,
                    Some(NoWriteReason::SkippedMissingVersion),
                )
            }
        } else if pinned {
            // Existing pinned: propose @latest, needs write
            (format!("{pkg_name}@latest"), true, None)
        } else {
            // Unpinned, no refresh: keep as-is, no write needed
            (entry.spec.clone(), false, Some(NoWriteReason::RefreshReady))
        };

        result.push(PluginToUpdate {
            current_spec: entry.spec.clone(),
            package_name: pkg_name,
            proposed_spec,
            config_path: entry.config_path.clone(),
            needs_write,
            no_write_reason,
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
                needs_write: true,
                no_write_reason: None,
            }],
            &[],
            &[],
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
        assert!(
            empty.get("refreshed").is_none(),
            "must use refreshReady, not refreshed"
        );
    }

    #[test]
    fn json_empty_preview_has_refresh_ready_not_refreshed() {
        // Exercise the real builder with empty lists to verify field name.
        let preview = build_update_preview_json(&ConfigScope::Project, &[], &[], &[], &[], true);
        assert!(
            preview.get("refreshReady").is_none(),
            "refreshReady should not appear when empty"
        );
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
        fs::write(&root_config, r#"{"plugin": ["@scope/pkg@1.0.0"]}"#).unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let plugins = collect_plugins_for_update(ConfigScope::Project, None, None).unwrap();
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
        fs::write(&root_config, r#"{"plugin": ["@scope/pkg@1.0.0"]}"#).unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let plugins = collect_plugins_for_update(ConfigScope::Project, None, None).unwrap();
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

        let result = collect_plugins_for_update(ConfigScope::Project, Some("nonexistent"), None);
        assert!(result.is_err());

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    // --- Refresh tests (no network) ---

    #[test]
    fn refresh_pins_unpinned_plugins_to_exact_version() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        fs::write(
            &config_path,
            r#"{"plugin": ["unpinned-plugin", "@scope/unpinned@latest"]}"#,
        )
        .unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let mut versions = HashMap::new();
        versions.insert("unpinned-plugin".to_string(), "2.0.0".to_string());
        versions.insert("@scope/unpinned".to_string(), "3.1.4".to_string());

        let plugins =
            collect_plugins_for_update(ConfigScope::Project, None, Some(&versions)).unwrap();

        assert_eq!(plugins.len(), 2);
        // Unpinned plugins get exact pinned version
        assert_eq!(plugins[0].proposed_spec, "unpinned-plugin@2.0.0");
        assert!(
            plugins[0].needs_write,
            "unpinned should become pinned with --refresh"
        );
        assert_ne!(
            plugins[0].current_spec, plugins[0].proposed_spec,
            "proposed should differ from current for unpinned"
        );
        // @scope/unpinned@latest → @scope/unpinned@3.1.4
        assert_eq!(plugins[1].proposed_spec, "@scope/unpinned@3.1.4");
        assert!(plugins[1].needs_write);

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn refresh_bumps_pinned_plugins_to_exact_latest() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        fs::write(
            &config_path,
            r#"{"plugin": ["@scope/pkg@1.0.0", "other@0.5.0"]}"#,
        )
        .unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let mut versions = HashMap::new();
        versions.insert("@scope/pkg".to_string(), "2.0.0".to_string());
        versions.insert("other".to_string(), "1.0.0".to_string());

        let plugins =
            collect_plugins_for_update(ConfigScope::Project, None, Some(&versions)).unwrap();

        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0].proposed_spec, "@scope/pkg@2.0.0");
        assert_eq!(plugins[1].proposed_spec, "other@1.0.0");
        assert!(plugins[0].needs_write);

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn refresh_skips_plugins_already_at_exact_version() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        // Already pinned to the version that would be fetched
        fs::write(&config_path, r#"{"plugin": ["@scope/pkg@1.0.0"]}"#).unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let mut versions = HashMap::new();
        versions.insert("@scope/pkg".to_string(), "1.0.0".to_string());

        let plugins =
            collect_plugins_for_update(ConfigScope::Project, None, Some(&versions)).unwrap();

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].proposed_spec, "@scope/pkg@1.0.0");
        // Needs no write since it's already at the target version
        assert!(!plugins[0].needs_write);
        assert!(matches!(
            plugins[0].no_write_reason,
            Some(NoWriteReason::AlreadyCurrent)
        ));

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn refresh_missing_version_does_not_loosen_existing_pin() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        fs::write(&config_path, r#"{"plugin": ["@scope/pkg@1.0.0"]}"#).unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let versions = HashMap::new();
        let plugins =
            collect_plugins_for_update(ConfigScope::Project, None, Some(&versions)).unwrap();

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].current_spec, "@scope/pkg@1.0.0");
        assert_eq!(plugins[0].proposed_spec, "@scope/pkg@1.0.0");
        assert!(!plugins[0].needs_write);
        assert!(matches!(
            plugins[0].no_write_reason,
            Some(NoWriteReason::SkippedMissingVersion)
        ));

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn refresh_filters_to_specific_plugin_when_requested() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        fs::write(
            &config_path,
            r#"{"plugin": ["plugin-a@1.0.0", "plugin-b@0.5.0"]}"#,
        )
        .unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let mut versions = HashMap::new();
        versions.insert("plugin-a".to_string(), "2.0.0".to_string());
        versions.insert("plugin-b".to_string(), "1.0.0".to_string());

        let plugins =
            collect_plugins_for_update(ConfigScope::Project, Some("plugin-a"), Some(&versions))
                .unwrap();

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].package_name, "plugin-a");
        assert_eq!(plugins[0].proposed_spec, "plugin-a@2.0.0");

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }

    #[test]
    fn refresh_resolves_alias_config_entries_before_pin() {
        let dir = tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        fs::write(&config_path, r#"{"plugin": ["ram-monitor"]}"#).unwrap();

        let original_cwd = std::env::current_dir().ok();
        std::env::set_current_dir(dir.path()).unwrap();

        let mut versions = HashMap::new();
        versions.insert(
            "@capybearista/opencode-ram-monitor".to_string(),
            "1.2.3".to_string(),
        );

        let plugins =
            collect_plugins_for_update(ConfigScope::Project, Some("ram-monitor"), Some(&versions))
                .unwrap();

        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].current_spec, "ram-monitor");
        assert_eq!(
            plugins[0].package_name,
            "@capybearista/opencode-ram-monitor"
        );
        assert_eq!(
            plugins[0].proposed_spec,
            "@capybearista/opencode-ram-monitor@1.2.3"
        );
        assert!(plugins[0].needs_write);

        if let Some(cwd) = original_cwd {
            std::env::set_current_dir(cwd).unwrap();
        }
    }
}
