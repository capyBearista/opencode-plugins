mod catalog;
mod cli;
mod commands;
mod config;
mod discovery;
mod errors;
mod output;
mod registry;
mod safety;
mod telemetry;
mod version_util;

use clap::Parser;
use cli::{Cli, Commands};
use config::parser::{GlobalConfigProvider, ProjectConfigProvider};
use config::provider::{ConfigProvider, ConfigScope, PluginEntry};
use discovery::{
    EnrichedPlugin, PluginStatus, classify_plugins, deduplicate_plugins, enrich_plugin,
    enrich_with_latest_versions, resolve_plugins,
};
use errors::CliError;
use registry::cache::{UpdateNoticeCache, default_notice_cache_path, read_update_notice_cache};
use registry::client::{DEFAULT_MAX_CONCURRENT, RegistryClient};
use safety::{package_name_from_spec, resolve_write_scope};
use std::collections::HashMap;
use std::env;
use std::process::ExitCode;
use std::time::Instant;
use version_util::version_is_newer;

#[tokio::main]
async fn main() -> anyhow::Result<ExitCode> {
    let cli = Cli::parse();
    let start = Instant::now();

    // Cache-based notices: read once and reuse for startup banners and command
    // enrichment. The cache is populated reactively during `outdated` registry
    // refresh, so startup and `list` never perform network calls.
    let notice_cache = read_update_notice_cache();
    if let Some(cache) = notice_cache.as_ref() {
        let outdated = cache.outdated_count();
        if should_show_startup_notice(cli.json, cli.quiet, outdated) {
            println!(
                "Note: {} plugin update{} available. Run `oc-plugins outdated` for details.",
                outdated,
                if outdated == 1 { "" } else { "s" },
            );
        }

        // Self-update notice: read from cache; only shown when json/quiet are
        // false, a cached update is present, and the cached version is strictly
        // newer than the currently running version (avoids stale-cache banners).
        if !cli.json
            && !cli.quiet
            && let Some(ref cli_latest) = cache.cli_latest_version
            && version_is_newer(cli_latest, env!("CARGO_PKG_VERSION"))
        {
            println!(
                "A new version of oc-plugins (v{cli_latest}) is available. \
                 Run `npm install -g @capybearista/opencode-plugin-manager` to update."
            );
        }
    }

    let command_label = cli.command.label();
    let notice_count = notice_cache.as_ref().map(|c| c.outdated_count());

    // Resolve the command into a Result<ExitCode, anyhow::Error>
    let result: Result<ExitCode, anyhow::Error> = async {
        match &cli.command {
        Commands::List { project, global } => {
            let mut enriched = load_enriched_plugins(cli.json, *project, *global)?;

            if let Some(cache) = notice_cache.as_ref() {
                enriched = enrich_with_latest_versions(enriched, cache);
            }

            if cli.json {
                output::json::print_plugins_json(&enriched);
            } else if !cli.quiet {
                if cli.verbose {
                    if let Some(cache) = notice_cache.as_ref() {
                        let age_secs = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs()
                            .saturating_sub(cache.checked_at);
                        if age_secs < 3600 {
                            println!("(cache: fresh, {}m old)", age_secs / 60);
                        } else if age_secs < 86400 {
                            println!("(cache: {}h old)", age_secs / 3600);
                        } else {
                            println!(
                                "(cache: stale, {}d old — run `outdated --refresh` to populate)",
                                age_secs / 86400
                            );
                        }
                    } else {
                        println!("(no cache — run `outdated --refresh` to populate)");
                    }
                }
                output::human::print_plugins(&enriched, cli.verbose);
            }
            Ok(ExitCode::SUCCESS)
        }
        Commands::Outdated {
            project,
            global,
            refresh,
        } => {
            let enriched = load_enriched_plugins(cli.json, *project, *global)?;

            let cache_path = default_notice_cache_path();
            let cache: UpdateNoticeCache = if *refresh {
                let client = RegistryClient::new(DEFAULT_MAX_CONCURRENT);
                client.fetch_and_write_cache(&enriched, cache_path).await?
            } else if let Some(ref cached) = notice_cache {
                cached.clone()
            } else {
                let client = RegistryClient::new(DEFAULT_MAX_CONCURRENT);
                client.fetch_and_write_cache(&enriched, cache_path).await?
            };

            let enriched = enrich_with_latest_versions(enriched, &cache);
            let classified = classify_plugins(enriched);
            let has_outdated = classified
                .iter()
                .any(|cp| cp.status == PluginStatus::Outdated);

            if cli.json {
                output::json::print_outdated_json(&classified);
            } else if !cli.quiet {
                output::human::print_outdated_human(&classified, cli.verbose);
            }

            let code = if has_outdated {
                ExitCode::from(1)
            } else {
                ExitCode::SUCCESS
            };
            Ok(code)
        }
        Commands::Add {
            plugin,
            project,
            global,
            yes,
            dry_run,
        } => handle_mutation_result(
            commands::add::execute(plugin, *project, *global, *yes, *dry_run, cli.json),
            cli.json,
        ),
        Commands::Update {
            plugin,
            project,
            global,
            yes,
            dry_run,
            refresh,
        } => {
            match load_update_refresh_versions(plugin.as_deref(), *project, *global, *refresh)
                .await
            {
                Ok(refresh_versions) => handle_mutation_result(
                    commands::update::execute(
                        plugin.as_deref(),
                        *project,
                        *global,
                        *yes,
                        *dry_run,
                        cli.json,
                        refresh_versions.as_ref(),
                    ),
                    cli.json,
                ),
                Err(e) => handle_mutation_result(Err(e), cli.json),
            }
        }
        Commands::Remove {
            plugin,
            project,
            global,
            yes,
            dry_run,
        } => handle_mutation_result(
            commands::remove::execute(plugin, *project, *global, *yes, *dry_run, cli.json),
            cli.json,
        ),
        }
    }
    .await;

    telemetry::record_command(
        command_label,
        result.is_ok(),
        start.elapsed(),
        None,
        notice_count,
        None,
        cli.json,
        cli.quiet,
    )
    .await;

    result
}

async fn load_update_refresh_versions(
    plugin: Option<&str>,
    project: bool,
    global: bool,
    refresh: bool,
) -> Result<Option<HashMap<String, String>>, CliError> {
    if !refresh {
        return Ok(None);
    }

    let scope = resolve_write_scope(project, global)?;
    let provider: Box<dyn ConfigProvider> = match scope {
        ConfigScope::Project => {
            let cwd = env::current_dir().map_err(|e| CliError::Io {
                path: ".".to_string(),
                source: e,
            })?;
            Box::new(ProjectConfigProvider::new(cwd))
        }
        ConfigScope::Global => Box::new(GlobalConfigProvider::new()),
    };

    let filter_pkg = plugin.map(|p| package_name_from_spec(&crate::catalog::resolve_alias(p)));
    let mut package_names: Vec<String> = provider
        .read_plugins()?
        .iter()
        .map(|entry| package_name_from_spec(&crate::catalog::resolve_alias(&entry.spec)))
        .filter(|name| filter_pkg.as_ref().is_none_or(|filter| name == filter))
        .collect();
    package_names.sort();
    package_names.dedup();

    if package_names.is_empty() {
        return Ok(Some(HashMap::new()));
    }

    let client = RegistryClient::new(DEFAULT_MAX_CONCURRENT);
    let results = client.fetch_latest_versions(&package_names).await;
    let mut versions = HashMap::new();
    let mut failures = Vec::new();
    for (pkg, result) in results {
        match result {
            Ok(meta) => {
                versions.insert(pkg, meta.version);
            }
            Err(err) => failures.push(format!("{pkg}: {err}")),
        }
    }

    if !failures.is_empty() {
        return Err(CliError::Validation(format!(
            "could not fetch latest version{} for: {}",
            if failures.len() == 1 { "" } else { "s" },
            failures.join("; ")
        )));
    }

    Ok(Some(versions))
}

/// Execute a mutation command and handle errors according to JSON mode.
/// In JSON mode, the error is serialised as the one stdout JSON document
/// and the process exits with a failure exit code, instead of propagating
/// unstructured text via `anyhow`.
fn handle_mutation_result(
    result: Result<ExitCode, CliError>,
    json: bool,
) -> Result<ExitCode, anyhow::Error> {
    match result {
        Ok(code) => Ok(code),
        Err(e) => {
            if json {
                let error_json = serde_json::to_string_pretty(&e.to_json()).unwrap_or_else(|_| {
                    r#"{"error":"INTERNAL_ERROR","message":"serialization failed"}"#.to_string()
                });
                println!("{error_json}");
                Ok(ExitCode::FAILURE)
            } else {
                Err(anyhow::Error::from(e))
            }
        }
    }
}

fn should_show_startup_notice(json: bool, quiet: bool, outdated_count: usize) -> bool {
    !json && !quiet && outdated_count > 0
}

fn load_enriched_plugins(
    json: bool,
    project: bool,
    global: bool,
) -> anyhow::Result<Vec<EnrichedPlugin>> {
    let all_plugins = collect_configured_plugins(json, project, global)?;
    let deduplicated = deduplicate_plugins(all_plugins);
    Ok(resolve_plugins(deduplicated)?
        .into_iter()
        .map(enrich_plugin)
        .collect())
}

fn collect_configured_plugins(
    json: bool,
    project: bool,
    global: bool,
) -> anyhow::Result<Vec<PluginEntry>> {
    let mut all_plugins = Vec::new();

    let show_project = project || !global;
    let show_global = global || !project;

    if show_project {
        let cwd = env::current_dir()?;
        let project_provider = ProjectConfigProvider::new(cwd);
        match project_provider.read_plugins() {
            Ok(plugins) => all_plugins.extend(plugins),
            Err(e) => handle_config_error(json, "project", e),
        }
    }

    if show_global {
        let global_provider = GlobalConfigProvider::new();
        match global_provider.read_plugins() {
            Ok(plugins) => all_plugins.extend(plugins),
            Err(e) => handle_config_error(json, "global", e),
        }
    }

    Ok(all_plugins)
}

fn handle_config_error(json: bool, scope: &str, error: CliError) -> ! {
    // Config provider failures happen before command-specific recovery is
    // useful. Render the requested human/JSON error shape, then terminate.
    if json {
        let json_err = error.to_json();
        println!("{}", serde_json::to_string_pretty(&json_err).unwrap());
    } else {
        eprintln!("Error reading {} config: {}", scope, error);
    }

    std::process::exit(1)
}

#[cfg(test)]
mod tests {
    use super::should_show_startup_notice;

    #[test]
    fn suppresses_startup_notice_for_json_or_quiet() {
        assert!(!should_show_startup_notice(true, false, 1));
        assert!(!should_show_startup_notice(false, true, 1));
        assert!(!should_show_startup_notice(true, true, 1));
    }

    #[test]
    fn shows_startup_notice_only_when_updates_exist() {
        assert!(should_show_startup_notice(false, false, 1));
        assert!(!should_show_startup_notice(false, false, 0));
    }

    #[test]
    fn zero_outdated_suppresses_startup_notice_even_with_cache_notices() {
        // Even if the cache has notices, zero outdated should suppress the banner.
        assert!(!should_show_startup_notice(false, false, 0));
    }
}
